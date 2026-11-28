/**
 * Mediblix Desktop — bundled local AI runtime supervisor tests
 *
 * Proves the lifecycle rules of the llama.cpp runtime that Mediblix ships:
 *  - discovery looks only at the bundled runtime (never Ollama/Homebrew/PATH)
 *  - model readiness comes from real files with correct sizes
 *  - servers start on demand, are reused, and only owned processes are killed
 *  - a crash is detected, is not reported as success, and cannot loop forever
 *  - idle vision models are released to free memory
 */

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

const {
  SLOTS,
  getServerCandidates,
  resolveServerBinary,
  inspectModel,
  buildServerArgs,
  createLocalAISupervisor,
} = require('../local-ai-supervisor');

const CATALOG = require('../ai-model-catalog.json');
const { resolveTier } = require('../ai-catalog');
const LITE = resolveTier(CATALOG, 'lite');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ FAIL: ${name}\n      ${error.message}`);
    failed++;
  }
}

function makeChild() {
  const child = new EventEmitter();
  child.pid = 91000;
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.exitCode = 0;
    child.emit('exit', 0, signal);
    return true;
  };
  return child;
}

const quietLog = { log() {}, warn() {}, error() {} };
const MODEL_DIR = '/models';

const TEXT_FILE = LITE.models.text.files[0];
const VISION_FILES = LITE.models.vision.files;

/** A fileStat stub where every catalog file is present with its real size. */
function allFilesPresent(overrides = {}) {
  return (target) => {
    const name = path.basename(target);
    if (name in overrides) {
      if (overrides[name] === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: overrides[name] };
    }
    const known = [TEXT_FILE, ...VISION_FILES].find((f) => f.name === name);
    if (!known) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { size: known.bytes };
  };
}

function makeSupervisor(overrides = {}) {
  return createLocalAISupervisor({
    catalog: CATALOG,
    env: { MEDIBLIX_LLAMA_SERVER_BIN: '/runtime/llama-server', ...(overrides.env || {}) },
    platform: 'darwin',
    arch: 'arm64',
    modelDir: MODEL_DIR,
    fileExists: () => true,
    fileStat: allFilesPresent(),
    spawnImpl: () => makeChild(),
    probe: async () => ({ ready: true }),
    log: quietLog,
    ownsTimers: false,
    ...overrides,
  });
}

async function run() {
  console.log('=================================================');
  console.log(' Bundled Local AI Runtime Supervisor Tests       ');
  console.log('=================================================');

  console.log('\n[Group 1: runtime discovery]');

  await test('an explicit runtime override is first', () => {
    const candidates = getServerCandidates({ env: { MEDIBLIX_LLAMA_SERVER_BIN: '/custom/llama-server' }, platform: 'darwin', arch: 'arm64' });
    assert.strictEqual(candidates[0], '/custom/llama-server');
  });

  await test('the bundled resources runtime is considered', () => {
    const candidates = getServerCandidates({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/app/Resources',
    });
    assert(candidates.includes('/app/Resources/runtime/darwin-arm64/llama-server'));
  });

  await test('Windows bundles llama-server.exe', () => {
    const candidates = getServerCandidates({
      env: {},
      platform: 'win32',
      arch: 'x64',
      resourcesPath: 'C:\\Program Files\\Mediblix\\resources',
    });
    assert(candidates.some((c) => c.endsWith('llama-server.exe')));
  });

  await test('no Ollama or Homebrew path is ever proposed', () => {
    const candidates = getServerCandidates({ env: {}, platform: 'darwin', arch: 'arm64', resourcesPath: '/app' });
    assert(!candidates.some((c) => /ollama|homebrew|Cellar/i.test(c)), `unexpected candidates: ${candidates.join(', ')}`);
  });

  await test('resolution returns the bundled binary', () => {
    const binary = resolveServerBinary({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/app/Resources',
      fileExists: (p) => p === '/app/Resources/runtime/darwin-arm64/llama-server',
    });
    assert.strictEqual(binary, '/app/Resources/runtime/darwin-arm64/llama-server');
  });

  await test('a missing runtime resolves to null rather than guessing', () => {
    const binary = resolveServerBinary({ env: {}, platform: 'darwin', arch: 'arm64', fileExists: () => false });
    assert.strictEqual(binary, null);
  });

  console.log('\n[Group 2: model readiness]');

  await test('complete model files are reported installed with their byte total', () => {
    const inspected = inspectModel(MODEL_DIR, LITE.models.vision, { fileStat: allFilesPresent() });
    assert.strictEqual(inspected.installed, true);
    assert.strictEqual(inspected.bytes, VISION_FILES.reduce((sum, f) => sum + f.bytes, 0));
  });

  await test('a missing file is reported with its name', () => {
    const inspected = inspectModel(MODEL_DIR, LITE.models.vision, {
      fileStat: allFilesPresent({ [VISION_FILES[0].name]: null }),
    });
    assert.strictEqual(inspected.installed, false);
    assert.strictEqual(inspected.missing[0].name, VISION_FILES[0].name);
  });

  await test('a truncated/partial file is not treated as installed', () => {
    const inspected = inspectModel(MODEL_DIR, LITE.models.text, {
      fileStat: allFilesPresent({ [TEXT_FILE.name]: 1024 }),
    });
    assert.strictEqual(inspected.installed, false);
    assert(/does not match expected/.test(inspected.missing[0].reason));
  });

  console.log('\n[Group 3: server arguments]');

  await test('text slots start without an mmproj', () => {
    const args = buildServerArgs({ modelPath: '/m/text.gguf', port: 8791, ctxSize: 8192, gpuLayers: 99, alias: 't' });
    assert(!args.includes('--mmproj'));
    assert.strictEqual(args[args.indexOf('--port') + 1], '8791');
    assert.strictEqual(args[args.indexOf('--host') + 1], '127.0.0.1');
  });

  await test('vision slots pass the multimodal projector', () => {
    const args = buildServerArgs({ modelPath: '/m/v.gguf', mmprojPath: '/m/mmproj.gguf', port: 8792, ctxSize: 8192, gpuLayers: 99, alias: 'v' });
    assert.deepStrictEqual(args.slice(args.indexOf('--mmproj'), args.indexOf('--mmproj') + 2), ['--mmproj', '/m/mmproj.gguf']);
  });

  console.log('\n[Group 4: status reporting]');

  await test('a missing runtime marks setup as required', async () => {
    const supervisor = makeSupervisor({ fileExists: () => false });
    const status = await supervisor.status();
    assert.strictEqual(status.runtime.installed, false);
    assert.strictEqual(status.ready.chat, false);
    assert.strictEqual(status.setupRequired, true);
  });

  await test('installed models are ready even before a process starts', async () => {
    const supervisor = makeSupervisor();
    const status = await supervisor.status();
    assert.strictEqual(status.runtime.installed, true);
    assert.strictEqual(status.models.text.installed, true);
    assert.strictEqual(status.ready.chat, true);
    assert.strictEqual(status.ready.vision, true);
    assert.strictEqual(status.servers.text.running, false, 'servers are lazy');
    assert.strictEqual(status.setupRequired, false);
  });

  await test('a missing vision model does not disable text', async () => {
    const supervisor = makeSupervisor({
      fileStat: allFilesPresent({ [VISION_FILES[0].name]: null }),
    });
    const status = await supervisor.status();
    assert.strictEqual(status.ready.chat, true);
    assert.strictEqual(status.ready.vision, false);
    assert.strictEqual(status.setupRequired, true);
  });

  console.log('\n[Group 5: start decisions]');

  await test('disabled by configuration never spawns', async () => {
    let spawned = false;
    const supervisor = makeSupervisor({ env: { MEDIBLIX_LOCAL_AI: 'off' }, spawnImpl: () => { spawned = true; } });
    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'disabled');
    assert.strictEqual(spawned, false);
  });

  await test('no runtime means no spawn and an actionable message', async () => {
    let spawned = false;
    const supervisor = makeSupervisor({ fileExists: () => false, spawnImpl: () => { spawned = true; } });
    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.reason, 'runtime-not-installed');
    assert(/runtime is missing/i.test(result.message));
    assert.strictEqual(spawned, false);
  });

  await test('a missing model file never spawns a server', async () => {
    let spawned = false;
    const supervisor = makeSupervisor({
      fileStat: allFilesPresent({ [TEXT_FILE.name]: null }),
      spawnImpl: () => { spawned = true; },
    });
    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'model-not-installed');
    assert.strictEqual(spawned, false);
  });

  await test('starting a slot spawns once and becomes ready', async () => {
    let spawns = 0;
    let calls = 0;
    const child = makeChild();
    // First probe simulates the 503 "loading model" window, then ready.
    const supervisor = makeSupervisor({
      spawnImpl: () => { spawns++; return child; },
      probe: async () => {
        calls++;
        return calls === 1 ? { ready: false, loading: true } : { ready: true };
      },
    });

    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.started, true);
    assert.strictEqual(spawns, 1);
    assert.strictEqual(supervisor.getOwnership().text.startedByUs, true);
    assert.strictEqual(supervisor.getOwnership().text.pid, child.pid);
  });

  await test('a second ensure reuses the running server', async () => {
    let spawns = 0;
    let ready = false;
    const supervisor = makeSupervisor({
      spawnImpl: () => { spawns++; ready = true; return makeChild(); },
      probe: async () => ({ ready }),
    });
    await supervisor.ensureModel('text');
    const second = await supervisor.ensureModel('text');
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.reused, true);
    assert.strictEqual(spawns, 1);
  });

  await test('concurrent ensures share a single startup', async () => {
    let spawns = 0;
    let ready = false;
    const supervisor = makeSupervisor({
      spawnImpl: () => { spawns++; ready = true; return makeChild(); },
      probe: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ready };
      },
    });
    const [a, b] = await Promise.all([supervisor.ensureModel('vision'), supervisor.ensureModel('vision')]);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(spawns, 1);
  });

  await test('a server that never becomes ready is stopped and reported', async () => {
    const child = makeChild();
    const supervisor = makeSupervisor({
      spawnImpl: () => child,
      probe: async () => ({ ready: false, loading: true }),
      startTimeoutMs: 120,
    });
    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'start-timeout');
    assert.deepStrictEqual(child.signals, ['SIGTERM'], 'the failed child must not leak');
    assert.strictEqual(supervisor.getOwnership().text.startedByUs, false);
  });

  await test('a crashing runtime is not reported as ready', async () => {
    const child = makeChild();
    const supervisor = makeSupervisor({
      spawnImpl: () => {
        setImmediate(() => child.emit('exit', 1, null));
        child.exitCode = 1;
        return child;
      },
      probe: async () => ({ ready: false, reason: 'ECONNREFUSED' }),
      startTimeoutMs: 150,
    });
    const result = await supervisor.ensureModel('text');
    assert.strictEqual(result.ok, false);
    assert(/runtime|ready/i.test(result.message || ''), `got: ${result.message}`);
  });

  await test('repeated crashes trip the crash-loop breaker instead of spawning forever', async () => {
    let spawns = 0;
    const supervisor = makeSupervisor({
      spawnImpl: () => {
        spawns++;
        const child = makeChild();
        setImmediate(() => child.emit('exit', 1, null));
        child.exitCode = 1;
        return child;
      },
      probe: async () => ({ ready: false }),
      startTimeoutMs: 60,
    });
    for (let i = 0; i < 4; i++) await supervisor.ensureModel('text');
    const final = await supervisor.ensureModel('text');
    assert.strictEqual(final.ok, false);
    assert.strictEqual(final.reason, 'crash-loop');
    assert(spawns <= 3, `expected at most 3 spawns, saw ${spawns}`);
  });

  console.log('\n[Group 6: shutdown safety]');

  await test('unloading a slot that is not running is a no-op', async () => {
    const supervisor = makeSupervisor();
    const result = await supervisor.unloadModel('vision');
    assert.strictEqual(result.unloaded, false);
    assert.strictEqual(result.reason, 'not-running');
  });

  await test('unload terminates only the owned process', async () => {
    let ready = false;
    const child = makeChild();
    const supervisor = makeSupervisor({
      spawnImpl: () => { ready = true; return child; },
      probe: async () => ({ ready }),
    });
    await supervisor.ensureModel('vision');
    const result = await supervisor.unloadModel('vision');
    assert.strictEqual(result.unloaded, true);
    assert.deepStrictEqual(child.signals, ['SIGTERM']);
    assert.strictEqual(supervisor.getOwnership().vision.startedByUs, false);
  });

  await test('stopAll releases every owned slot', async () => {
    let ready = false;
    const textChild = makeChild();
    const visionChild = makeChild();
    const supervisor = makeSupervisor({
      spawnImpl: () => {
        ready = true;
        return supervisor.getOwnership().text.startedByUs ? visionChild : textChild;
      },
      probe: async () => ({ ready }),
    });
    await supervisor.ensureModel('text');
    await supervisor.ensureModel('vision');
    const results = await supervisor.stopAll();
    assert.strictEqual(results.text.stopped, true);
    assert.strictEqual(results.vision.stopped, true);
    assert(Object.values(supervisor.getOwnership()).every((s) => !s.startedByUs));
  });

  await test('idle reaping unloads vision but keeps text resident', async () => {
    let ready = false;
    const textChild = makeChild();
    const visionChild = makeChild();
    const supervisor = makeSupervisor({
      idleUnloadMs: 1,
      spawnImpl: () => {
        ready = true;
        return supervisor.getOwnership().text.startedByUs ? visionChild : textChild;
      },
      probe: async () => ({ ready }),
      now: () => 1000,
    });
    await supervisor.ensureModel('text');
    await supervisor.ensureModel('vision');
    const result = await supervisor.reapIdle();
    assert.deepStrictEqual(result.unloaded, []);

    const later = makeSupervisor({
      idleUnloadMs: 1,
      spawnImpl: () => { ready = true; return makeChild(); },
      probe: async () => ({ ready }),
      now: (() => { let t = 0; return () => (t += 1000); })(),
    });
    await later.ensureModel('vision');
    const reaped = await later.reapIdle();
    assert.deepStrictEqual(reaped.unloaded, ['vision']);
  });

  await test('repeated intentional unloads do not trip the crash-loop breaker', async () => {
    const supervisor = makeSupervisor({
      spawnImpl: () => makeChild(),
      probe: async () => ({ ready: true }),
    });

    // Scanning several invoices in a row unloads the OCR model each time to
    // make room for the text model. That is normal operation, not a crash.
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const started = await supervisor.ensureModel('vision');
      assert.strictEqual(started.ok, true, `cycle ${cycle} start: ${started.message || started.reason}`);
      const unloaded = await supervisor.unloadModel('vision');
      assert.strictEqual(unloaded.unloaded, true, `cycle ${cycle} unload`);
    }

    await supervisor.stopAll();
  });

  console.log('\n=================================================');
  console.log(` Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=================================================');

  process.exit(failed > 0 ? 1 : 0);
}

run();
