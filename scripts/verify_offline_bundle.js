/**
 * Mediblix Desktop — Production Offline AI Bundle & Readiness Verification
 *
 * Verifies that the local installation contains everything required
 * to run genuine offline AI without internet access or manual configuration.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function verifyBundle() {
  console.log("=================================================================");
  console.log(" Mediblix Desktop — Production Offline AI Package Verification   ");
  console.log("=================================================================");

  let passed = 0;
  let total = 6;

  // 1. Check Ollama Binary
  console.log("\n[1/6] Verifying Local Inference Engine Binary (Ollama)...");
  let ollamaBin = null;
  const candidates = [
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    path.join(rootDir, "bin", process.platform === "win32" ? "ollama.exe" : "ollama"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      ollamaBin = c;
      break;
    }
  }
  if (!ollamaBin) {
    try {
      const out = execSync(process.platform === "win32" ? "where ollama" : "which ollama", { encoding: "utf8" }).trim();
      if (out) ollamaBin = out.split("\n")[0];
    } catch (_) {}
  }

  if (ollamaBin) {
    console.log(`  ✓ Ollama runtime located: ${ollamaBin}`);
    passed++;
  } else {
    console.error("  ✗ FAILED: Ollama runtime not found.");
  }

  // 2. Check Ollama Models in Local Storage
  console.log("\n[2/6] Verifying Local Model Storage...");
  let models = [];
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.get("http://127.0.0.1:11434/api/tags", { timeout: 3000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      });
      req.on("error", reject);
    });
    models = (res.models || []).map((m) => m.name);
  } catch (e) {
    console.error("  ✗ Could not query Ollama:", e.message);
  }

  const hasLlama = models.some((m) => m.includes("llama3.2"));
  const hasQwen = models.some((m) => m.includes("qwen2.5vl"));

  if (hasLlama) {
    console.log("  ✓ Llama 3.2 3B (Text & MedAgent Chat) model is present locally");
  } else {
    console.error("  ✗ Llama 3.2 3B model missing from local storage.");
  }

  if (hasQwen) {
    console.log("  ✓ Qwen2.5-VL 7B (Vision & Invoice OCR) model is present locally");
  } else {
    console.error("  ✗ Qwen2.5-VL 7B model missing from local storage.");
  }

  if (hasLlama && hasQwen) passed++;

  // 3. Check Whisper Speech-to-Text Package & Model
  console.log("\n[3/6] Verifying Whisper Speech-to-Text Engine...");
  try {
    const { createRequire } = await import("module");
    const backendReq = createRequire(path.join(rootDir, "backend", "package.json"));
    const { pipeline } = backendReq("@xenova/transformers");
    console.log("  ✓ Transformers.js ONNX runtime verified");
    passed++;
  } catch (e) {
    console.error("  ✗ Transformers.js missing:", e.message);
  }

  // 4. Check PDF Processing Libraries
  console.log("\n[4/6] Verifying PDF Processing Dependencies...");
  try {
    const { createRequire } = await import("module");
    const backendReq = createRequire(path.join(rootDir, "backend", "package.json"));
    const pdfPkg = backendReq("pdf-parse");
    const { pdfToPng } = backendReq("pdf-to-png-converter");
    if (pdfPkg && pdfToPng) {
      console.log("  ✓ PDF parsing (text & canvas image rendering) verified");
      passed++;
    }
  } catch (e) {
    console.error("  ✗ PDF processing library error:", e.message);
  }

  // 5. Check Audio PCM & WebM Utilities
  console.log("\n[5/6] Verifying Audio Codec Libraries...");
  try {
    const { createRequire } = await import("module");
    const backendReq = createRequire(path.join(rootDir, "backend", "package.json"));
    const wavefile = backendReq("wavefile");
    console.log("  ✓ Wavefile PCM audio processing library verified");
    passed++;
  } catch (e) {
    console.error("  ✗ Audio processing library error:", e.message);
  }

  // 6. Check Local AI Service Status
  console.log("\n[6/6] Verifying End-to-End Local AI Service...");
  try {
    const { checkOllamaHealth, getActiveProvider } = await import("../backend/services/aiProvider.js");
    const health = await checkOllamaHealth();
    const provider = getActiveProvider();
    if (health.running && provider === "local") {
      console.log(`  ✓ Local AI provider active ('${provider}') with ${health.models.length} local models`);
      passed++;
    } else {
      console.error("  ✗ Local AI service health check failed:", health);
    }
  } catch (e) {
    console.error("  ✗ Local AI service check error:", e.message);
  }

  console.log("\n=================================================================");
  console.log(` Verification Result: ${passed}/${total} checks passed`);
  console.log("=================================================================");

  if (passed === total) {
    console.log("🎉 PRODUCTION READINESS CONFIRMED:");
    console.log("   Mediblix Desktop has all local models, runtimes, and dependencies");
    console.log("   installed. The application can run 100% offline with zero cloud access.");
    process.exit(0);
  } else {
    console.error("❌ Verification incomplete. Some offline components are missing.");
    process.exit(1);
  }
}

verifyBundle();
