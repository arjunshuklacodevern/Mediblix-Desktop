/**
 * Mediblix Desktop — hardware detection and catalog tier tests
 *
 * Pure logic: no models, no processes. Verifies that a machine is given a tier
 * it can actually run and that the catalog only advertises what was vendored.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  getHardwareProfile,
  detectAcceleration,
  chooseTier,
  threadCountFor,
} = require("../hardware-profile");
const { resolveTier, getRuntimeProfile, totalBytes, isOcrModel } = require("../ai-catalog");

const CATALOG = require("../ai-model-catalog.json");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

const GIB = 1024 * 1024 * 1024;

(async () => {
  console.log("\n[Group 1: tier selection]");

  await test("an 8 GB machine gets the Lite tier", () => {
    const profile = getHardwareProfile({ totalMemBytes: 8 * GIB, cpuCount: 4 });
    assert.strictEqual(profile.tier, "lite");
    assert.strictEqual(profile.meetsMinimum, true);
  });

  await test("a 16 GB machine stays on Lite while Standard is not shipped", () => {
    const profile = getHardwareProfile({ totalMemBytes: 16 * GIB, cpuCount: 8 });
    assert.strictEqual(profile.tier, "lite");
  });

  await test("Standard is chosen only when the catalog defines it", () => {
    const choice = chooseTier({
      totalMemBytes: 32 * GIB,
      availableTiers: ["lite", "standard"],
    });
    assert.strictEqual(choice.tier, "standard");
  });

  await test("an explicit supported tier wins", () => {
    const choice = chooseTier({ totalMemBytes: 8 * GIB, requestedTier: "lite", availableTiers: ["lite"] });
    assert.strictEqual(choice.tier, "lite");
    assert.strictEqual(choice.reason, "explicit");
  });

  await test("a 4 GB machine is flagged below the minimum", () => {
    const profile = getHardwareProfile({ totalMemBytes: 4 * GIB, cpuCount: 2 });
    assert.strictEqual(profile.meetsMinimum, false);
    assert.strictEqual(profile.warnings.length, 2, "RAM and core warnings");
  });

  console.log("\n[Group 2: acceleration and threads]");

  await test("Apple Silicon uses Metal offload", () => {
    assert.deepStrictEqual(detectAcceleration({ platform: "darwin", arch: "arm64" }), {
      backend: "metal",
      gpuLayers: 99,
    });
  });

  await test("Windows CPU build never claims GPU offload", () => {
    assert.deepStrictEqual(detectAcceleration({ platform: "win32", arch: "x64" }), {
      backend: "cpu",
      gpuLayers: 0,
    });
  });

  await test("threads leave one core for the UI and are capped by the tier", () => {
    assert.strictEqual(threadCountFor(4, 4), 3);
    assert.strictEqual(threadCountFor(16, 4), 4);
    assert.strictEqual(threadCountFor(1, 4), 1);
  });

  console.log("\n[Group 3: catalog integrity]");

  await test("the Lite tier resolves and defines text and OCR models", () => {
    const lite = resolveTier(CATALOG, "lite");
    assert.strictEqual(lite.id, "lite");
    assert.ok(lite.models.text, "text model");
    assert.ok(lite.models.vision, "scan model");
    assert.strictEqual(isOcrModel(lite.models.vision), true);
    assert.strictEqual(isOcrModel(lite.models.text), false);
  });

  await test("the Lite tier fits the approved download budget", () => {
    const bytes = totalBytes(resolveTier(CATALOG, "lite"));
    const decimalGb = bytes / 1e9;
    assert.ok(decimalGb > 3.0 && decimalGb < 3.2, `Lite tier is ${decimalGb.toFixed(2)} GB`);
  });

  await test("ctx size and GPU defaults come from the tier, not a hardcoded 8192", () => {
    const profile = getRuntimeProfile(resolveTier(CATALOG, "lite"));
    assert.strictEqual(profile.ctxSize, 4096);
    assert.strictEqual(profile.gpuLayersByPlatform["win32-x64"], 0);
    assert.strictEqual(profile.gpuLayersByPlatform["darwin-arm64"], 99);
  });

  await test("only vendored platforms are advertised as available", () => {
    const assets = CATALOG.runtime.platformAssets;
    assert.ok(assets["darwin-arm64"].vendored);
    assert.ok(assets["win32-x64"].vendored);
    assert.ok(assets["darwin-arm64"].sha256, "macOS runtime hash is pinned");
    assert.ok(assets["win32-x64"].sha256, "Windows runtime hash is pinned");
    assert.strictEqual(assets["win32-arm64"].vendored, false);
  });

  await test("vendored runtime binaries exist on disk", () => {
    const root = path.join(__dirname, "..", "..", "build", "runtime");
    for (const key of ["darwin-arm64", "win32-x64"]) {
      const dir = path.join(root, key);
      assert.ok(fs.existsSync(dir), `${key} runtime directory`);
      const binary = path.join(dir, key === "win32-x64" ? "llama-server.exe" : "llama-server");
      assert.ok(fs.existsSync(binary), `${key} llama-server`);
    }
  });

  await test("no functional Ollama dependency exists in the runtime modules", () => {
    const files = [
      path.join(__dirname, "..", "ai-model-catalog.json"),
      path.join(__dirname, "..", "ai-catalog.js"),
      path.join(__dirname, "..", "hardware-profile.js"),
      path.join(__dirname, "..", "local-ai-supervisor.js"),
      path.join(__dirname, "..", "..", "backend", "services", "localAIService.js"),
    ];
    // A comment may explain that Ollama is not used; nothing may call it.
    const forbidden = /(?:localhost|127\.0\.0\.1):11434|OLLAMA_HOST|ollama\s+(?:serve|run|pull)|require\(['"]ollama['"]\)/i;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!forbidden.test(text), `${path.basename(file)} must not depend on Ollama`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
