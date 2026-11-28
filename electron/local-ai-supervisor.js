/**
 * Mediblix Desktop — Bundled local AI runtime supervisor (Electron main process)
 *
 * Owns the llama.cpp `llama-server` processes that ship with Mediblix.
 *
 * Design:
 *  - The runtime is BUNDLED (resources/runtime/<platform>-<arch>/llama-server).
 *    There is no dependency on Ollama, Homebrew, a developer install or PATH.
 *  - One process per model slot ("text", "vision"). llama-server loads exactly
 *    one GGUF (plus an optional mmproj projector) per process.
 *  - Servers start lazily, on demand, so a machine that never uses vision never
 *    pays its RAM cost. The vision slot is unloaded after an idle period.
 *  - Ownership is explicit: only a child spawned here is ever signalled.
 *  - Model files live outside the app bundle (user data), so updates cannot
 *    delete a customer's models.
 *
 * The backend never spawns a runtime. It asks for one through the loopback
 * control channel in ai-control-server.js.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { resolveTier, getRuntimeProfile } = require('./ai-catalog');
const { getHardwareProfile, threadCountFor } = require('./hardware-profile');

const START_TIMEOUT_MS = 90000; // cold GGUF load on a slow disk
const STOP_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_IDLE_UNLOAD_MS = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const CRASH_WINDOW_MS = 60 * 1000;
const MAX_CRASHES_IN_WINDOW = 3;

/** Model slots, in the order the UI reasons about them. */
const SLOTS = ["text", "vision"];

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function serverBinaryName(platform = process.platform) {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

function defaultModelDir(appDataDir) {
  if (!appDataDir) return null;
  return path.join(appDataDir, "ai-models");
}

/**
 * Ordered candidate locations for the bundled llama-server binary.
 * An explicit MEDIBLIX_LLAMA_SERVER_BIN always wins (development/tests).
 */
function getServerCandidates({ env = process.env, platform = process.platform, arch = process.arch, resourcesPath = null, devRoot = null } = {}) {
  const candidates = [];
  const bin = serverBinaryName(platform);
  const key = platformKey(platform, arch);

  if (env.MEDIBLIX_LLAMA_SERVER_BIN) candidates.push(env.MEDIBLIX_LLAMA_SERVER_BIN);

  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "runtime", key, bin));
    candidates.push(path.join(resourcesPath, "runtime", "bin", bin));
    candidates.push(path.join(resourcesPath, bin));
  }

  // Development only: a runtime unpacked into the repo for local testing.
  if (devRoot) {
    candidates.push(path.join(devRoot, "build", "runtime", key, bin));
    candidates.push(path.join(devRoot, "build", "runtime", "bin", bin));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function resolveServerBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  resourcesPath = null,
  devRoot = null,
  fileExists = fs.existsSync,
} = {}) {
  for (const candidate of getServerCandidates({ env, platform, arch, resourcesPath, devRoot })) {
    try {
      if (fileExists(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Model files for a kind, with presence and size verification.
 * Size is checked (cheap); full SHA-256 verification is the installer's job.
 */
function inspectModel(modelDir, modelSpec, { fileStat = (p) => fs.statSync(p) } = {}) {
  if (!modelDir || !modelSpec) {
    return { installed: false, dir: modelDir, files: [], missing: [], bytes: 0, spec: modelSpec || null };
  }

  let bytes = 0;
  const files = [];
  const missing = [];

  for (const file of modelSpec.files || []) {
    const fullPath = path.join(modelDir, file.name);
    let ok = false;
    let size = null;
    let reason = null;
    try {
      const stat = fileStat(fullPath);
      size = stat.size;
      if (typeof file.bytes === "number" && file.bytes > 0 && size !== file.bytes) {
        reason = `size ${size} does not match expected ${file.bytes}`;
      } else {
        ok = true;
      }
    } catch {
      reason = "missing";
    }

    if (ok) bytes += size || 0;
    else missing.push({ name: file.name, reason });

    files.push({ name: file.name, role: file.role || "model", path: fullPath, bytes: size, ok, reason });
  }

  return {
    installed: missing.length === 0,
    dir: modelDir,
    id: modelSpec.id,
    displayName: modelSpec.displayName,
    files,
    missing,
    bytes,
    spec: modelSpec,
  };
}

function buildServerArgs({ modelPath, mmprojPath, port, ctxSize, gpuLayers, alias, threads }) {
  const args = [
    "-m",
    modelPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(ctxSize || 8192),
    "--alias",
    alias || "mediblix",
  ];

  if (Number.isFinite(gpuLayers)) args.push("-ngl", String(gpuLayers));
  if (Number.isFinite(threads) && threads > 0) args.push("-t", String(threads));
  if (mmprojPath) args.push("--mmproj", mmprojPath);

  return args;
}

/**
 * GET /health on llama-server: 200 {"status":"ok"} when loaded, 503 while loading.
 */
function probeServer(baseUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.get(`${baseUrl}/health`, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode === 200) {
          try {
            const json = JSON.parse(body);
            resolve({ ready: json.status === "ok", loading: false, status: response.statusCode });
          } catch {
            resolve({ ready: false, loading: false, status: response.statusCode, reason: "invalid-json" });
          }
          return;
        }
        // 503 means the model is still loading — expected during startup.
        resolve({
          ready: false,
          loading: response.statusCode === 503,
          status: response.statusCode,
        });
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve({ ready: false, loading: false, reason: "timeout" });
    });
    request.on("error", (error) => {
      resolve({ ready: false, loading: false, reason: error.code || error.message });
    });
  });
}

function createLocalAISupervisor({
  catalog = require("./ai-model-catalog.json"),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  tier = null,
  hardware = null,
  resourcesPath = env.MEDIBLIX_RESOURCES_PATH || null,
  devRoot = null,
  appDataDir = null,
  modelDir = null,
  fileExists = fs.existsSync,
  fileStat = (p) => fs.statSync(p),
  spawnImpl = spawn,
  probe = probeServer,
  log = console,
  now = Date.now,
  idleUnloadMs = Number(env.MEDIBLIX_VISION_IDLE_UNLOAD_MS || DEFAULT_IDLE_UNLOAD_MS),
  startTimeoutMs = START_TIMEOUT_MS,
  ownsTimers = true,
} = {}) {
  const resolvedModelDir = modelDir || defaultModelDir(appDataDir);
  const runtimeSpec = catalog.runtime || {};
  const ports = runtimeSpec.ports || { text: 8791, vision: 8792 };
  const disabled = String(env.MEDIBLIX_LOCAL_AI || "").toLowerCase() === "off";

  // Hardware decides the tier; the catalog decides whether that tier exists.
  const hardwareProfile =
    hardware ||
    getHardwareProfile({
      platform,
      arch,
      requestedTier: env.MEDIBLIX_AI_TIER || tier,
      availableTiers: Object.keys(catalog.tiers || {}),
    });
  const resolved = resolveTier(catalog, env.MEDIBLIX_AI_TIER || tier || hardwareProfile.tier);
  const runtimeProfile = getRuntimeProfile(resolved);
  const platformKeyValue = platformKey(platform, arch);
  const resolvedThreads = threadCountFor(
    hardwareProfile.cpuCount || 4,
    runtimeProfile.maxThreads || 4
  );
  const gpuLayers =
    Number(env.MEDIBLIX_AI_GPU_LAYERS) >= 0
      ? Number(env.MEDIBLIX_AI_GPU_LAYERS)
      : Number(runtimeProfile.gpuLayersByPlatform?.[platformKeyValue] ?? hardwareProfile.gpu.gpuLayers ?? 0);
  const ctxSize = Number(env.MEDIBLIX_AI_CTX_SIZE) || Number(runtimeProfile.ctxSize) || 4096;

  /** slot state: { child, startedByUs, pid, baseUrl, starting, lastUsedAt, exit } */
  const slots = Object.fromEntries(
    SLOTS.map((kind) => [
      kind,
      {
        child: null,
        startedByUs: false,
        pid: null,
        starting: null,
        lastUsedAt: 0,
        exit: null,
        // True between our own SIGTERM and the exit event. A deliberate unload
        // (freeing the OCR model before the text model loads) is not a crash.
        intentionalStop: false,
      },
    ])
  );

  const crashTimes = Object.fromEntries(SLOTS.map((kind) => [kind, []]));
  let lastError = null;
  let idleTimer = null;

  const modelSpec = (kind) => resolved.models?.[kind] || null;
  const baseUrlFor = (kind) => `http://127.0.0.1:${ports[kind]}`;

  function models() {
    return Object.fromEntries(
      SLOTS.map((kind) => [kind, inspectModel(resolvedModelDir, modelSpec(kind), { fileStat })])
    );
  }

  function binary() {
    return resolveServerBinary({ env, platform, arch, resourcesPath, devRoot, fileExists });
  }

  function isRunning(kind) {
    const slot = slots[kind];
    return Boolean(slot.child && slot.child.exitCode === null && slot.startedByUs);
  }

  function buildArgs(kind, inspected) {
    const spec = modelSpec(kind);
    const modelFile = (spec.files || []).find((f) => (f.role || "model") === "model");
    const mmprojFile = (spec.files || []).find((f) => f.role === "mmproj");
    return buildServerArgs({
      modelPath: path.join(resolvedModelDir, modelFile.name),
      mmprojPath: mmprojFile ? path.join(resolvedModelDir, mmprojFile.name) : null,
      port: ports[kind],
      ctxSize: ctxSize || spec.ctxSize,
      gpuLayers: Number.isFinite(gpuLayers) ? gpuLayers : spec.gpuLayers,
      alias: spec.id,
      threads: Number(env.MEDIBLIX_AI_THREADS) || resolvedThreads,
    });
  }

  function logStream() {
    if (!appDataDir) return "ignore";
    try {
      return fs.openSync(path.join(appDataDir, "local-ai-runtime.log"), "a");
    } catch {
      return "ignore";
    }
  }

  async function waitForReady(kind, timeoutMs) {
    const baseUrl = baseUrlFor(kind);
    const deadline = now() + timeoutMs;
    let lastReason = null;

    while (now() < deadline) {
      if (slots[kind].exit) return { ok: false, reason: "exited", exit: slots[kind].exit };
      const result = await probe(baseUrl, PROBE_TIMEOUT_MS);
      if (result.ready) return { ok: true };
      lastReason = result.reason || (result.loading ? "loading" : `HTTP ${result.status || "?"}`);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    return { ok: false, reason: lastReason || "timeout" };
  }

  async function startSlot(kind) {
    if (disabled) return { ok: false, reason: "disabled" };

    const spec = modelSpec(kind);
    if (!spec) return { ok: false, reason: "unknown-model-kind" };

    const bin = binary();
    if (!bin) {
      lastError = "The bundled local AI runtime is missing from this installation.";
      return { ok: false, reason: "runtime-not-installed", message: lastError };
    }

    const inspected = inspectModel(resolvedModelDir, spec, { fileStat });
    if (!inspected.installed) {
      lastError = `The ${kind} model files are not installed yet.`;
      return { ok: false, reason: "model-not-installed", missing: inspected.missing, message: lastError };
    }

    const recentCrashes = crashTimes[kind].filter((t) => now() - t < CRASH_WINDOW_MS);
    if (recentCrashes.length >= MAX_CRASHES_IN_WINDOW) {
      lastError = `The local ${kind} AI runtime keeps stopping (${recentCrashes.length} crashes in a minute). Restart Mediblix to try again.`;
      return { ok: false, reason: "crash-loop", message: lastError };
    }

    const slot = slots[kind];
    slot.exit = null;
    const stream = logStream();
    const args = buildArgs(kind, inspected);

    log.log(`[LocalAI] starting ${kind} runtime: ${bin} ${args.join(" ")}`);

    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd: path.dirname(bin),
        detached: false,
        stdio: ["ignore", stream, stream],
        env: { ...env },
      });
    } catch (error) {
      lastError = error.message;
      return { ok: false, reason: "spawn-failed", message: lastError };
    }

    slot.child = child;
    slot.startedByUs = true;
    slot.pid = child.pid ?? null;

    child.once("exit", (code, signal) => {
      const wasOwned = slot.startedByUs;
      const wasIntentional = slot.intentionalStop;
      slot.intentionalStop = false;
      log.log(`[LocalAI] ${kind} runtime exited (code=${code}, signal=${signal})`);
      slot.exit = { code, signal, at: now() };
      slot.child = null;
      slot.startedByUs = false;
      slot.pid = null;

      // Only unrequested exits count towards the crash-loop breaker. Otherwise
      // scanning several invoices in a row (each scan unloads the OCR model)
      // would look like three crashes and lock the user out.
      if (wasOwned && !wasIntentional) {
        crashTimes[kind].push(now());
        if (now() - slot.lastUsedAt < 120000) {
          lastError = `The local ${kind} AI runtime stopped unexpectedly (code ${code ?? signal ?? "unknown"}).`;
        }
      }
    });

    child.once("error", (error) => {
      lastError = `The local AI runtime could not start: ${error.message}`;
      log.error("[LocalAI]", lastError);
    });

    const readiness = await waitForReady(kind, startTimeoutMs);
    if (!readiness.ok) {
      lastError = `The local ${kind} AI runtime did not become ready (${readiness.reason}).`;
      log.warn("[LocalAI]", lastError);
      await stopSlot(kind);
      return { ok: false, reason: readiness.reason === "exited" ? "crashed" : "start-timeout", message: lastError };
    }

    slot.lastUsedAt = now();
    lastError = null;
    log.log(`[LocalAI] ${kind} ready on ${baseUrlFor(kind)} (${spec.displayName})`);
    return { ok: true };
  }

  /**
   * Starts the slot if needed and returns its base URL. Concurrency-safe:
   * simultaneous callers share one startup.
   */
  async function ensureModel(kind = "text") {
    if (!SLOTS.includes(kind)) {
      return { ok: false, reason: "unknown-model-kind", message: `Unknown model kind "${kind}".` };
    }

    const slot = slots[kind];

    if (isRunning(kind)) {
      const health = await probe(baseUrlFor(kind), PROBE_TIMEOUT_MS);
      if (health.ready || health.loading) {
        slot.lastUsedAt = now();
        return { ok: true, baseUrl: baseUrlFor(kind), model: modelSpec(kind).id, reused: true };
      }
      // Process alive but not answering — treat as dead.
      await stopSlot(kind);
    }

    if (slot.starting) {
      const result = await slot.starting;
      if (result.ok) {
        slot.lastUsedAt = now();
        return { ok: true, baseUrl: baseUrlFor(kind), model: modelSpec(kind).id, reused: true };
      }
      return result;
    }

    slot.starting = startSlot(kind).finally(() => {
      slot.starting = null;
    });

    const result = await slot.starting;
    if (!result.ok) return result;
    return { ok: true, baseUrl: baseUrlFor(kind), model: modelSpec(kind).id, started: true };
  }

  function stopSlot(kind) {
    return new Promise((resolve) => {
      const slot = slots[kind];

      if (!slot.child || !slot.startedByUs) {
        resolve({ stopped: false, reason: "not-owned" });
        return;
      }

      const target = slot.child;
      slot.intentionalStop = true;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ stopped: true });
      };

      if (target.exitCode !== null) {
        finish();
        return;
      }

      target.once("exit", finish);

      try {
        target.kill("SIGTERM");
      } catch {
        slot.intentionalStop = false;
        finish();
        return;
      }

      setTimeout(() => {
        if (settled || target.exitCode !== null) return;
        try {
          target.kill("SIGKILL");
        } catch {
          finish();
        }
        setTimeout(finish, 1000);
      }, STOP_TIMEOUT_MS);
    });
  }

  async function unloadModel(kind = "vision") {
    if (!SLOTS.includes(kind)) return { unloaded: false, reason: "unknown-model-kind" };
    if (!isRunning(kind)) return { unloaded: false, reason: "not-running" };
    log.log(`[LocalAI] unloading ${kind} model to free memory`);
    const result = await stopSlot(kind);
    return { unloaded: Boolean(result.stopped), reason: result.reason || null };
  }

  /**
   * Release idle model memory. Called on a timer in the app process.
   */
  async function reapIdle() {
    if (!idleUnloadMs || idleUnloadMs <= 0) return { unloaded: [] };
    const unloaded = [];

    // Text stays resident by default; vision is the expensive, occasional slot.
    for (const kind of ["vision"]) {
      const slot = slots[kind];
      if (!isRunning(kind)) continue;
      if (now() - slot.lastUsedAt < idleUnloadMs) continue;
      const result = await unloadModel(kind);
      if (result.unloaded) unloaded.push(kind);
    }

    return { unloaded };
  }

  function startIdleWatcher() {
    if (!ownsTimers || idleTimer) return;
    idleTimer = setInterval(() => {
      reapIdle().catch(() => {});
    }, IDLE_CHECK_INTERVAL_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }

  function stopIdleWatcher() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  async function status({ probeNow = false } = {}) {
    const bin = binary();
    const inspected = models();
    const servers = {};

    for (const kind of SLOTS) {
      const running = isRunning(kind);
      let ready = running;
      if (probeNow && running) {
        const health = await probe(baseUrlFor(kind), PROBE_TIMEOUT_MS);
        ready = Boolean(health.ready);
      }
      servers[kind] = {
        running,
        ready,
        baseUrl: running ? baseUrlFor(kind) : null,
        pid: slots[kind].pid,
        lastExit: slots[kind].exit,
      };
    }

    const runtimeInstalled = Boolean(bin);
    const textInstalled = inspected.text.installed;
    const visionInstalled = inspected.vision.installed;

    return {
      backend: "llama.cpp",
      runtime: {
        installed: runtimeInstalled,
        path: bin,
        build: runtimeSpec.pinnedBuild || null,
        version: null,
      },
      tier: {
        id: resolved.id,
        label: resolved.label,
        requested: resolved.requestedTier,
        downgraded: resolved.fallback,
        ctxSize,
        threads: resolvedThreads,
        gpuLayers,
        backend: hardwareProfile.gpu?.backend || "cpu",
      },
      hardware: {
        platform: hardwareProfile.platform,
        arch: hardwareProfile.arch,
        cpuCount: hardwareProfile.cpuCount,
        totalMemGb: hardwareProfile.totalMemGb,
        meetsMinimum: hardwareProfile.meetsMinimum,
        meetsRecommended: hardwareProfile.meetsRecommended,
        warnings: hardwareProfile.warnings || [],
        limits: hardwareProfile.limits || null,
      },
      modelDir: resolvedModelDir,
      disabled,
      models: {
        text: {
          id: inspected.text.id,
          name: modelSpec("text")?.displayName || null,
          installed: textInstalled,
          ready: textInstalled && runtimeInstalled,
          bytes: inspected.text.bytes,
          missing: inspected.text.missing,
          files: inspected.text.files,
        },
        vision: {
          id: inspected.vision.id,
          name: modelSpec("vision")?.displayName || null,
          installed: visionInstalled,
          ready: visionInstalled && runtimeInstalled,
          bytes: inspected.vision.bytes,
          missing: inspected.vision.missing,
          files: inspected.vision.files,
        },
      },
      servers,
      ready: {
        chat: textInstalled && runtimeInstalled,
        document: (textInstalled || visionInstalled) && runtimeInstalled,
        vision: visionInstalled && runtimeInstalled,
      },
      setupRequired: !runtimeInstalled || !textInstalled || !visionInstalled,
      lastError,
    };
  }

  async function stopAll() {
    stopIdleWatcher();
    const results = {};
    for (const kind of SLOTS) {
      results[kind] = await stopSlot(kind);
    }
    return results;
  }

  function getOwnership() {
    return Object.fromEntries(
      SLOTS.map((kind) => [
        kind,
        { startedByUs: slots[kind].startedByUs, pid: slots[kind].pid },
      ])
    );
  }

  startIdleWatcher();

  return {
    status,
    ensureModel,
    unloadModel,
    reapIdle,
    stopAll,
    stopIdleWatcher,
    resolveBinary: binary,
    getOwnership,
    modelDir: resolvedModelDir,
  };
}

// Default singleton bound to the running Electron process.
let singleton = null;
function getSingleton() {
  if (!singleton) singleton = createLocalAISupervisor();
  return singleton;
}

module.exports = {
  SLOTS,
  DEFAULT_IDLE_UNLOAD_MS,
  platformKey,
  serverBinaryName,
  defaultModelDir,
  getServerCandidates,
  resolveServerBinary,
  inspectModel,
  buildServerArgs,
  probeServer,
  createLocalAISupervisor,
  getSingleton,
};
