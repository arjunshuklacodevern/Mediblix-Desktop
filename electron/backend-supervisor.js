/**
 * Mediblix Desktop — Backend Process Supervisor
 *
 * Responsibilities:
 *  - Pre-flight TCP port occupation probing
 *  - Safe backend identity verification (validating positive integer PID and Mediblix service signature)
 *  - Strict PID matching for Electron-owned child processes (preventing process hijacking)
 *  - Spawning backend child process with host or bundled Node runtime
 *  - Active readiness polling with early exit / crash fast-fail
 *  - Bounded graceful shutdown awaiting actual child process exit event
 *  - Bounded forced shutdown with explicit failure handling
 *  - Clean startup timeout cleanup preventing orphan processes
 *  - Safe handling of repeated shutdown calls
 *  - Unowned/unrelated process preservation (never terminates foreign processes)
 *
 * Platform-Specific Notes:
 *  - On Windows, process.kill(pid, 0) tests existence of a process without signalling it.
 *  - Windows can reuse PIDs over time; identity verification pairs OS process existence checks
 *    with Mediblix HTTP signature validation ({ app: 'mediblix', service: 'mediblix-backend', status: 'healthy', pid }).
 *  - Electron restricts all termination commands strictly to its own spawned ChildProcess reference.
 */

const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
// `database/` ships as an extra resource (outside app.asar), so a packaged app
// must load it from resourcesPath instead of through the asar bundle.
const { getOrCreateJwtSecret } =
  process.resourcesPath && !process.defaultApp
    ? require(path.join(process.resourcesPath, 'database', 'paths.js'))
    : require('../database/paths');

const DEFAULT_PORT = 5001;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

let backendChild = null;
let isBackendSpawnedByElectron = false;
let shutdownPromise = null;

/**
 * Probes whether a TCP port is in use on host
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
function isPortOccupied(port = DEFAULT_PORT, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Checks backend health endpoint and verifies process identity.
 *
 * @param {number} port
 * @param {number|null} expectedPid - When checking an Electron-owned child, enforces exact PID match.
 * @returns {Promise<{ isHealthy: boolean, isMediblix: boolean, pid?: number, status?: string, error?: string }>}
 */
function checkBackendHealth(port = DEFAULT_PORT, expectedPid = null) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          // 1. Signature check
          const hasSignature = json.app === 'mediblix' && json.service === 'mediblix-backend';
          const isHealthy = res.statusCode === 200 && json.status === 'healthy';

          if (!hasSignature || !isHealthy) {
            return resolve({
              isHealthy: false,
              isMediblix: false,
              error: 'Invalid service signature or unhealthy status'
            });
          }

          // 2. PID validation: Must be a positive integer
          const isValidPid = Number.isInteger(json.pid) && json.pid > 0;
          if (!isValidPid) {
            return resolve({
              isHealthy: false,
              isMediblix: false,
              error: 'Invalid or missing positive integer PID in health response'
            });
          }

          // 3. Child PID match check (when Electron owns the backend child)
          if (expectedPid !== null && json.pid !== expectedPid) {
            return resolve({
              isHealthy: false,
              isMediblix: false,
              error: `PID mismatch: expected owned child ${expectedPid}, but port responded with PID ${json.pid}`
            });
          }

          // 4. Process existence verification for existing external instances
          if (expectedPid === null) {
            try {
              process.kill(json.pid, 0);
            } catch {
              return resolve({
                isHealthy: false,
                isMediblix: false,
                error: `Reported PID ${json.pid} is not an active process on the system`
              });
            }
          }

          resolve({
            isHealthy: true,
            isMediblix: true,
            pid: json.pid,
            status: json.status,
            // True only when this backend process provisioned the superadmin.
            provisionedAdmin: json.provisionedAdmin === true,
          });
        } catch {
          resolve({
            isHealthy: false,
            isMediblix: false,
            error: 'Non-JSON response from port'
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        isHealthy: false,
        isMediblix: false,
        error: err.code || err.message
      });
    });

    req.setTimeout(1000, () => {
      req.destroy();
      resolve({
        isHealthy: false,
        isMediblix: false,
        error: 'ETIMEDOUT'
      });
    });
  });
}

/**
 * Resolves the Node.js executable path:
 * 1. Bundled node in resourcesPath/bin/node.exe (packaged production)
 * 2. Bundled node in build/bin/node.exe (development)
 * 3. System host node binary (fallback)
 */
function resolveNodeBinary(resourcesPath = null) {
  const runtime = resolveNodeRuntime(resourcesPath);
  if (runtime.bin) return runtime.bin;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Resolves the Node runtime for the backend child process.
 *
 * 1. A bundled node in resourcesPath/bin (Windows installer today)
 * 2. Electron's own binary with ELECTRON_RUN_AS_NODE=1 — Electron embeds Node,
 *    so a packaged app needs NO separate Node installation on the customer's
 *    machine. This is what makes the macOS build self-contained.
 * 3. Host node (development only)
 *
 * @returns {{bin: string|null, env: Object, source: string}}
 */
function resolveNodeRuntime(
  resourcesPath = null,
  { execPath = process.execPath, isElectron = Boolean(process.versions && process.versions.electron) } = {}
) {
  const isWin = process.platform === 'win32';
  const nodeName = isWin ? 'node.exe' : 'node';

  if (resourcesPath) {
    const packagedNode = path.join(resourcesPath, 'bin', nodeName);
    if (fs.existsSync(packagedNode)) {
      return { bin: packagedNode, env: {}, source: 'bundled' };
    }
    if (isElectron && execPath) {
      return { bin: execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'electron' };
    }
    return { bin: null, env: {}, source: 'missing' };
  }

  const devNode = path.join(__dirname, '..', 'build', 'bin', nodeName);
  if (fs.existsSync(devNode)) {
    return { bin: devNode, env: {}, source: 'bundled' };
  }

  return { bin: isWin ? 'node.exe' : 'node', env: {}, source: 'host' };
}

/**
 * Starts the local backend or attaches to an existing verified Mediblix backend.
 *
 * @param {Object} options
 * @param {number} options.port
 * @param {string} options.backendScript
 * @param {string} options.backendCwd
 * @param {string} [options.nodeBin]
 * @param {boolean} [options.isDev]
 * @param {number} [options.startupTimeoutMs]
 * @param {number} [options.healthPollIntervalMs]
 * @param {number} [options.shutdownTimeoutMs]
 * @returns {Promise<{ port: number, pid: number, reused: boolean }>}
 */
async function startBackend(options = {}) {
  const port = options.port || Number(process.env.PORT) || DEFAULT_PORT;
  const startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.healthPollIntervalMs || DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const nodeRuntime = options.nodeBin
    ? { bin: options.nodeBin, env: options.nodeEnv || {}, source: 'explicit' }
    : resolveNodeRuntime(options.resourcesPath || null);
  const nodeBin = nodeRuntime.bin;
  const backendScript = options.backendScript;
  const backendCwd = options.backendCwd || path.dirname(backendScript);
  const isDev = Boolean(options.isDev);
  // Extra environment for the backend child (local AI control channel, model
  // directory). Kept explicit so no caller can silently leak unrelated values.
  const extraEnv = options.env || {};

  console.log(`[Supervisor] Checking status of port ${port}...`);

  // Step 1: Pre-flight check on port
  const occupied = await isPortOccupied(port);

  if (occupied) {
    console.log(`[Supervisor] Port ${port} is currently in use. Verifying ownership...`);
    const health = await checkBackendHealth(port, null);

    if (health.isMediblix && health.isHealthy) {
      console.log(`[Supervisor] Verified existing active Mediblix backend on port ${port} (PID ${health.pid}). Reusing existing instance.`);
      isBackendSpawnedByElectron = false;
      return { port, pid: health.pid, reused: true };
    } else {
      console.error(`[Supervisor] Conflict detected: Port ${port} is occupied by an unrelated service.`);
      throw new Error(
        `Port ${port} is already in use by another application on your computer.\n\n` +
        `Mediblix requires port ${port} for its local SQLite database and backend services.\n\n` +
        `Please close the application using port ${port} and restart Mediblix.`
      );
    }
  }

  if (!nodeBin) {
    throw new Error(
      'No JavaScript runtime is available to start the Mediblix backend. Reinstall Mediblix.'
    );
  }

  // Step 2: Spawn backend using resolved Node runtime
  console.log(`[Supervisor] Launching local Express backend with ${nodeBin} (${nodeRuntime.source}) from: ${backendScript}`);

  let hasExitedPrematurely = false;
  let exitCode = null;
  let exitSignal = null;
  let stderrBuffer = '';

  try {
    backendChild = spawn(nodeBin, [backendScript], {
      cwd: backendCwd,
      env: {
        ...process.env,
        ...nodeRuntime.env,
        ...extraEnv,
        PORT: String(port),
        NODE_ENV: isDev ? 'development' : 'production',
        JWT_SECRET: getOrCreateJwtSecret()
      },
      stdio: 'pipe',
    });
    isBackendSpawnedByElectron = true;
  } catch (spawnErr) {
    console.error('[Supervisor] Failed to spawn backend process:', spawnErr);
    throw new Error(`Failed to launch backend process executable: ${spawnErr.message}`);
  }

  const spawnedPid = backendChild.pid;
  console.log(`[Supervisor] Backend process spawned (PID: ${spawnedPid})`);

  backendChild.stdout?.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.log(`[Backend] ${text}`);
  });

  backendChild.stderr?.on('data', (d) => {
    const text = d.toString().trim();
    if (text) {
      console.error(`[Backend ERR] ${text}`);
      stderrBuffer += text + '\n';
      if (stderrBuffer.length > 1500) {
        stderrBuffer = stderrBuffer.slice(-1500);
      }
    }
  });

  backendChild.on('error', (err) => {
    console.error('[Supervisor] Backend child process error:', err);
    hasExitedPrematurely = true;
    stderrBuffer += err.message + '\n';
  });

  backendChild.on('exit', (code, sig) => {
    hasExitedPrematurely = true;
    exitCode = code;
    exitSignal = sig;
    console.log(`[Supervisor] Backend process exited (code=${code}, signal=${sig})`);
  });

  // Step 3: Wait until backend is confirmed healthy and verified as our spawned PID
  console.log(`[Supervisor] Waiting for backend readiness on port ${port} (expecting PID ${spawnedPid})...`);
  const startTime = Date.now();

  while (Date.now() - startTime < startupTimeoutMs) {
    if (hasExitedPrematurely) {
      const detail = stderrBuffer.trim() || `Process exited with code ${exitCode || 0} (${exitSignal || 'none'})`;
      try {
        await stopBackend(shutdownTimeoutMs);
      } catch (cleanupErr) {
        console.error('[Supervisor] Cleanup error following early exit:', cleanupErr);
      }
      throw new Error(`The local Mediblix backend failed to start.\n\nDetails: ${detail}`);
    }

    const health = await checkBackendHealth(port, spawnedPid);
    if (health.isMediblix && health.isHealthy) {
      console.log(`[Supervisor] Backend verified ready in ${Date.now() - startTime}ms (PID: ${health.pid})`);
      return { port, pid: health.pid, reused: false };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Step 4: Handle startup timeout — stop owned child process and wait for its termination
  console.warn(`[Supervisor] Backend readiness timed out after ${startupTimeoutMs}ms. Stopping child process...`);
  try {
    await stopBackend(shutdownTimeoutMs);
  } catch (stopErr) {
    console.error('[Supervisor] Error during timeout child cleanup:', stopErr);
  }

  throw new Error(
    `The Mediblix local backend did not become ready within ${startupTimeoutMs / 1000} seconds.\n\n` +
    (stderrBuffer ? `Last error output:\n${stderrBuffer}` : 'Please verify that SQLite and Node.js are functioning properly.')
  );
}

/**
 * Gracefully terminates the backend child process if spawned by Electron.
 * Enforces a bounded timeout, executes fallback kill only on owned child,
 * and waits for actual child process exit event before clearing references.
 *
 * @param {number} [timeoutMs] - Maximum milliseconds to wait for graceful exit before fallback
 * @returns {Promise<void>}
 */
function stopBackend(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
  // If no child was spawned by us or already exited and cleaned up, resolve immediately
  if (!backendChild || !isBackendSpawnedByElectron) {
    backendChild = null;
    isBackendSpawnedByElectron = false;
    return Promise.resolve();
  }

  // If a shutdown is already in progress, reuse the existing promise
  if (shutdownPromise) {
    return shutdownPromise;
  }

  const childToStop = backendChild;
  const childPid = childToStop.pid;

  shutdownPromise = new Promise((resolve, reject) => {
    let resolved = false;
    let gracefulTimer = null;
    let forcedTimer = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (gracefulTimer) clearTimeout(gracefulTimer);
      if (forcedTimer) clearTimeout(forcedTimer);
      if (backendChild === childToStop) {
        backendChild = null;
        isBackendSpawnedByElectron = false;
      }
      shutdownPromise = null;
      resolve();
    };

    // If child process has already exited
    if (childToStop.exitCode !== null) {
      cleanup();
      return;
    }

    // Listen for actual exit event
    childToStop.once('exit', (code, signal) => {
      console.log(`[Supervisor] Owned backend (PID ${childPid}) cleanly exited (code=${code}, signal=${signal})`);
      cleanup();
    });

    console.log(`[Supervisor] Requesting graceful shutdown for owned backend (PID ${childPid})...`);

    // Send SIGTERM strictly to the owned child process
    try {
      childToStop.kill('SIGTERM');
    } catch (killErr) {
      console.error('[Supervisor] Error sending SIGTERM to owned backend:', killErr);
    }

    // Bounded timeout: wait for graceful shutdown
    gracefulTimer = setTimeout(() => {
      if (resolved || childToStop.exitCode !== null) return;
      console.warn(`[Supervisor] Owned backend (PID ${childPid}) did not exit within ${timeoutMs}ms. Executing fallback SIGKILL...`);

      try {
        childToStop.kill('SIGKILL');
      } catch {
        try { childToStop.kill(); } catch {}
      }

      // Forced termination must also wait for actual exit with bounded timeout and explicit failure handling
      forcedTimer = setTimeout(() => {
        if (!resolved && childToStop.exitCode === null) {
          console.error(`[Supervisor] CRITICAL: Child process (PID ${childPid}) did not exit after SIGKILL.`);
          shutdownPromise = null;
          reject(new Error(`Child process (PID ${childPid}) failed to terminate after forced SIGKILL.`));
        }
      }, 3000);
    }, timeoutMs);
  });

  return shutdownPromise;
}

function getBackendChild() {
  return backendChild;
}

function isSpawnedByElectron() {
  return isBackendSpawnedByElectron;
}

function setOwnedChildForTesting(child) {
  backendChild = child;
  isBackendSpawnedByElectron = true;
}

function resetSupervisorState() {
  backendChild = null;
  isBackendSpawnedByElectron = false;
  shutdownPromise = null;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_HEALTH_POLL_INTERVAL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  isPortOccupied,
  checkBackendHealth,
  resolveNodeBinary,
  resolveNodeRuntime,
  startBackend,
  stopBackend,
  getBackendChild,
  isSpawnedByElectron,
  setOwnedChildForTesting,
  resetSupervisorState
};
