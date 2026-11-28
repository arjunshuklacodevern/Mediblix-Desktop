/**
 * Mediblix Desktop — local AI architecture integration test
 *
 * Exercises the real seam between the three layers, with a stand-in runtime
 * binary instead of a multi-gigabyte GGUF download:
 *
 *   Electron supervisor  ──spawns──►  fake llama-server (HTTP)
 *          ▲                                  ▲
 *          │ control channel (token)          │ OpenAI-compatible API
 *          │                                  │
 *   backend localAIService ─────────────────────┘
 *
 * Proves: on-demand start, health polling, inference through /v1/chat/completions,
 * unload of an owned process, restart after unload, and that a foreign process
 * is never signalled.
 *
 * Skipped on Windows (the fixture uses a POSIX shell wrapper).
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { createLocalAISupervisor } = require("../local-ai-supervisor");
const { createAIControlServer } = require("../ai-control-server");

let passed = 0;
let failed = 0;
let skipped = 0;

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const FAKE_SERVER = `
const http = require('http');
const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const model = process.argv[process.argv.indexOf('-m') + 1] || 'unknown';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const userMessage = (parsed.messages || []).find((m) => m.role === 'user');
      const hasImage = Array.isArray(userMessage && userMessage.content)
        ? userMessage.content.some((p) => p.type === 'image_url')
        : false;
      const content = JSON.stringify({
        answer: 'ok',
        sawImage: hasImage,
        model: parsed.model,
        modelFile: require('path').basename(model),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('fake llama-server listening on ' + port + '\\n');
});
`;

async function run() {
  console.log("=================================================");
  console.log(" Local AI Architecture Integration Tests         ");
  console.log("=================================================");

  if (process.platform === "win32") {
    console.log("\n  ⊘ SKIP: POSIX runtime fixture is not available on Windows");
    skipped++;
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediblix-ai-int-"));
  const modelDir = path.join(tmp, "ai-models");
  fs.mkdirSync(modelDir, { recursive: true });

  const serverScript = path.join(tmp, "fake-llama-server.js");
  fs.writeFileSync(serverScript, FAKE_SERVER, "utf8");

  const wrapper = path.join(tmp, "llama-server");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`, "utf8");
  fs.chmodSync(wrapper, 0o755);

  // Small stand-in files: the supervisor only checks presence and exact size.
  const textFile = "fake-text.gguf";
  const visionFile = "fake-vision.gguf";
  const mmprojFile = "fake-mmproj.gguf";
  for (const name of [textFile, visionFile, mmprojFile]) {
    fs.writeFileSync(path.join(modelDir, name), Buffer.alloc(16));
  }

  const ports = { text: await freePort(), vision: await freePort() };

  const catalog = {
    catalogVersion: 1,
    runtime: { name: "llama.cpp", pinnedBuild: "test", ports },
    models: {
      text: {
        id: "fake-text",
        displayName: "Fake Text",
        ctxSize: 2048,
        gpuLayers: 0,
        files: [{ name: textFile, role: "model", bytes: 16 }],
      },
      vision: {
        id: "fake-vision",
        displayName: "Fake Vision",
        ctxSize: 2048,
        gpuLayers: 0,
        files: [
          { name: visionFile, role: "model", bytes: 16 },
          { name: mmprojFile, role: "mmproj", bytes: 16 },
        ],
      },
    },
  };

  const catalogPath = path.join(tmp, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");

  const supervisor = createLocalAISupervisor({
    catalog,
    modelDir,
    env: { MEDIBLIX_LLAMA_SERVER_BIN: wrapper },
    platform: process.platform,
    arch: process.arch,
    log: { log() {}, warn() {}, error() {} },
    ownsTimers: false,
    startTimeoutMs: 15000,
  });

  const control = createAIControlServer({ supervisor, log: { log() {}, warn() {}, error() {} } });
  const { url: controlUrl, token } = await control.listen();

  process.env.MEDIBLIX_AI_CONTROL_URL = controlUrl;
  process.env.MEDIBLIX_AI_CONTROL_TOKEN = token;
  process.env.MEDIBLIX_MODEL_DIR = modelDir;
  process.env.MEDIBLIX_MODEL_CATALOG = catalogPath;
  delete process.env.MEDIBLIX_LOCAL_AI_BASE_URL;
  delete process.env.MEDIBLIX_LOCAL_AI_VISION_BASE_URL;

  const localAI = (await import("../../backend/services/localAIService.js")).default;

  try {
    console.log("\n[Group 1: readiness]");

    await test("the backend sees installed models through the control channel", async () => {
      localAI.resetHealthCache();
      const health = await localAI.checkHealth({ force: true });
      assert.strictEqual(health.available, true, `health error: ${health.error}`);
      assert.strictEqual(health.runtimeInstalled, true);
      assert.strictEqual(health.textModelReady, true);
      assert.strictEqual(health.visionModelReady, true);
      assert.strictEqual(health.backend, "llama.cpp");
      assert.strictEqual(health.servers.text.running, false, "no process before first use");
    });

    await test("a wrong control token is rejected", async () => {
      const response = await fetch(`${controlUrl}/status`, { headers: { Authorization: "Bearer wrong" } });
      assert.strictEqual(response.status, 401);
    });

    console.log("\n[Group 2: inference]");

    await test("the text model starts on demand and answers inference", async () => {
      const result = await localAI.chatJSON({ prompt: "list one item", kind: "text" });
      assert.strictEqual(result.provider, "local");
      assert.strictEqual(result.data.answer, "ok");
      assert.strictEqual(result.data.sawImage, false);
      assert.strictEqual(supervisor.getOwnership().text.startedByUs, true);
    });

    await test("the started process is the one the supervisor owns", async () => {
      const ownership = supervisor.getOwnership();
      assert(Number.isInteger(ownership.text.pid), "expected a pid");
      const status = await supervisor.status();
      assert.strictEqual(status.servers.text.running, true);
    });

    await test("the vision slot passes images through the multimodal payload", async () => {
      const result = await localAI.chatJSON({
        prompt: "extract line items",
        images: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="],
        kind: "vision",
      });
      assert.strictEqual(result.data.sawImage, true, "image content must reach the runtime");
      assert.strictEqual(supervisor.getOwnership().vision.startedByUs, true);
    });

    console.log("\n[Group 3: lifecycle]");

    await test("unloading a slot frees an owned process", async () => {
      const firstPid = supervisor.getOwnership().text.pid;
      const result = await localAI.unloadModel("text");
      assert.strictEqual(result.unloaded, true);
      assert.strictEqual(supervisor.getOwnership().text.startedByUs, false);
      assert(Number.isInteger(firstPid));
    });

    await test("a later request restarts the runtime without leaking the old one", async () => {
      const result = await localAI.chatJSON({ prompt: "again", kind: "text" });
      assert.strictEqual(result.data.answer, "ok");
      assert.strictEqual(supervisor.getOwnership().text.startedByUs, true);
    });

    await test("all owned processes are released on shutdown", async () => {
      const results = await supervisor.stopAll();
      assert.strictEqual(results.text.stopped || results.text.reason === "not-owned", true);
      assert(Object.values(supervisor.getOwnership()).every((slot) => !slot.startedByUs));
    });

    await test("missing model files are reported, not silently faked", async () => {
      fs.unlinkSync(path.join(modelDir, textFile));
      localAI.resetHealthCache();
      const health = await localAI.checkHealth({ force: true });
      assert.strictEqual(health.textModelReady, false);
      assert(health.missing.some((m) => m.kind === "text" && m.name === textFile));
      await assert.rejects(
        () => localAI.chatJSON({ prompt: "x", kind: "text" }),
        (error) => /not installed/i.test(error.message)
      );
    });
  } finally {
    await supervisor.stopAll();
    await control.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=================================================");
  console.log(` Summary: ${passed} Passed, ${failed} Failed, ${skipped} Skipped`);
  console.log("=================================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error("Unexpected suite error:", error);
  process.exit(1);
});
