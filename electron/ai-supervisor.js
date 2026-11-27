/**
 * Mediblix Desktop — Local AI Runtime Supervisor
 *
 * Manages the lifecycle of the local inference daemon (Ollama):
 * - Health verification & readiness polling on port 11434
 * - Automatic startup if not already running
 * - Cross-platform binary resolution (bundled or system-installed)
 * - Model directory detection (~/.ollama/models or bundled resources)
 * - Safe termination upon application exit (only if spawned by Electron)
 */

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const OLLAMA_PORT = 11434;
let ollamaChild = null;
let isOllamaSpawnedByElectron = false;

/**
 * Checks if port is occupied
 */
function isOllamaPortOccupied() {
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
    socket.connect(OLLAMA_PORT, '127.0.0.1');
  });
}

/**
 * Polls Ollama health API
 */
function checkOllamaHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ isHealthy: res.statusCode === 200, models: json.models || [] });
        } catch {
          resolve({ isHealthy: false, models: [] });
        }
      });
    });
    req.on('error', () => resolve({ isHealthy: false, models: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ isHealthy: false, models: [] });
    });
  });
}

/**
 * Resolve local Ollama binary across macOS and Windows
 */
function resolveOllamaBinary(resourcesPath = null) {
  const candidates = [];

  if (resourcesPath) {
    candidates.push(
      path.join(resourcesPath, 'bin', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
    );
  }

  candidates.push(
    path.join(__dirname, '..', 'build', 'bin', process.platform === 'win32' ? 'ollama.exe' : 'ollama')
  );

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/ollama');
    candidates.push('/usr/local/bin/ollama');
    candidates.push('/Applications/Ollama.app/Contents/Resources/ollama');
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
    }
    candidates.push('C:\\Program Files\\Ollama\\ollama.exe');
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to PATH resolution
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    const out = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    if (out && fs.existsSync(out)) {
      return out;
    }
  } catch (_) {}

  return null;
}

/**
 * Resolve model directory across bundled resources, app data, and standard Ollama path
 */
function resolveOllamaModelsDir(resourcesPath = null) {
  const candidates = [];

  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'models'));
  }

  candidates.push(path.join(__dirname, '..', 'build', 'models'));

  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'))
    : path.join(require('os').homedir(), 'Library', 'Application Support');

  candidates.push(path.join(appData, 'Mediblix', 'models'));
  candidates.push(path.join(require('os').homedir(), '.ollama', 'models'));

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

/**
 * Start Ollama daemon if not already running
 */
async function startOllama(options = {}) {
  const isOccupied = await isOllamaPortOccupied();

  if (isOccupied) {
    const health = await checkOllamaHealth();
    if (health.isHealthy) {
      console.log('[AI Supervisor] Ollama service is already active on port 11434. Reusing running daemon.');
      isOllamaSpawnedByElectron = false;
      return { running: true, models: health.models, reused: true };
    }
  }

  const binary = resolveOllamaBinary(options.resourcesPath);
  if (!binary) {
    console.warn('[AI Supervisor] Ollama binary not found in standard paths.');
    return { running: false, error: 'Ollama binary not found' };
  }

  const modelsDir = resolveOllamaModelsDir(options.resourcesPath);
  const spawnEnv = {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_FLASH_ATTENTION: '1',
  };
  if (modelsDir) {
    spawnEnv.OLLAMA_MODELS = modelsDir;
    console.log(`[AI Supervisor] Using models directory: ${modelsDir}`);
  }

  console.log(`[AI Supervisor] Launching local Ollama daemon from: ${binary}`);
  try {
    ollamaChild = spawn(binary, ['serve'], {
      env: spawnEnv,
      stdio: 'ignore',
      detached: false,
    });
    isOllamaSpawnedByElectron = true;
  } catch (err) {
    console.error('[AI Supervisor] Failed to launch Ollama process:', err.message);
    return { running: false, error: err.message };
  }

  // Poll readiness
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await new Promise((r) => setTimeout(r, 500));
    const health = await checkOllamaHealth();
    if (health.isHealthy) {
      console.log(`[AI Supervisor] Ollama daemon ready on port 11434. Models available: ${health.models.length}`);
      return { running: true, models: health.models, reused: false };
    }
  }

  console.warn('[AI Supervisor] Ollama readiness poll timed out after 15s');
  return { running: false, error: 'Readiness poll timed out' };
}

/**
 * Stop Ollama daemon if spawned by Electron
 */
async function stopOllama() {
  if (ollamaChild && isOllamaSpawnedByElectron) {
    console.log('[AI Supervisor] Stopping Electron-spawned Ollama daemon...');
    try {
      ollamaChild.kill('SIGTERM');
    } catch (_) {}
    ollamaChild = null;
    isOllamaSpawnedByElectron = false;
  }
}

module.exports = {
  isOllamaPortOccupied,
  checkOllamaHealth,
  resolveOllamaBinary,
  resolveOllamaModelsDir,
  startOllama,
  stopOllama,
};
