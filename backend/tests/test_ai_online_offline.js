/**
 * Mediblix Desktop — Online + Offline AI Test Suite
 *
 * Coverage:
 *  1. Output validation / normalisation (invoice, bill, loose JSON)
 *  2. Document processing: digital PDF text, scanned PDF rendering, images, audio
 *  3. Provider selection when NOTHING is available (no silent success)
 *  4. Online path (Gemini, simulated transport): success, 5xx, auth failure, missing key
 *  5. Local inference failure modes: timeout, malformed JSON, runtime "engine missing"
 *  6. LIVE offline inference through Ollama (skipped when unreachable)
 *  7. Business workflows: parse never writes; import-history transaction; sale transaction
 *  8. Auth is still required on every AI route
 *
 * Live tests use MEDIBLIX_TEST_OLLAMA_URL (default http://127.0.0.1:11435) so the
 * user's own Ollama on 11434 is never touched.
 */

import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import { createRequire } from "module";
import PDFDocument from "pdfkit";

const require = createRequire(import.meta.url);

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mediblix_ai_suite_secret_2026_0123456789abcdefgh";
process.env.ADMIN_PASSWORD = "AiSuiteAdminPass2026";

const tmpDb = path.join(os.tmpdir(), `mediblix_ai_${Date.now()}.db`);
process.env.MEDIBLIX_DB_PATH = tmpDb;

const LIVE_LOCAL = process.env.MEDIBLIX_TEST_LOCAL_AI_URL || "http://127.0.0.1:8791";
const DEAD_LOCAL = "http://127.0.0.1:59999";
// Keep Gemini timeouts short so failure paths are testable.
process.env.MEDIBLIX_GEMINI_TIMEOUT_MS = "900";
process.env.MEDIBLIX_LOCAL_AI_BASE_URL = LIVE_LOCAL;

const { initDatabase, closeDatabase } = require("../../database/db.js");
initDatabase(tmpDb);

const repositories = require("../../database/repositories/index.js");
const { userRepository, organizationRepository, productRepository } = repositories;

const { default: app } = await import("../index.js");
const aiProvider = (await import("../services/aiProvider.js")).default;
const localAIService = (await import("../services/localAIService.js")).default;
const documentProcessor = (await import("../services/documentProcessor.js")).default;
const {
  parseLooseJSON,
  validateInvoiceItems,
  validateBillPayload,
  normalizeDate,
  normalizeMobile,
} = await import("../services/extractionValidator.js");

const { AIError } = await import("../services/aiErrors.js");

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function skip(label, reason) {
  console.log(`  ⊘ SKIP: ${label} (${reason})`);
  skipped++;
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function expectThrows(fn, predicate, label) {
  try {
    await fn();
    assert(false, `${label} — expected an error but the call succeeded`);
  } catch (error) {
    assert(predicate(error), `${label} — ${error.code || error.name}: ${String(error.message).slice(0, 120)}`);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────
function buildPdf(textLines) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    textLines.forEach((line, index) => {
      doc.fontSize(index === 0 ? 16 : 12).text(line);
    });
    doc.end();
  });
}

async function buildInvoicePng() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    return null;
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360">
    <rect width="100%" height="100%" fill="white"/>
    <text x="24" y="60" font-size="24" font-family="Arial">MEDIBLIX PHARMACY INVOICE</text>
    <text x="24" y="120" font-size="18" font-family="Arial">Paracetamol 500mg  BAT-101  Qty 10  Price 25.50  Exp 2027-05-01</text>
    <text x="24" y="160" font-size="18" font-family="Arial">Amoxicillin 250mg  BAT-202  Qty 5  Price 120  Exp 2026-11-30</text>
    <text x="24" y="210" font-size="18" font-family="Arial">Customer: Ravi Kumar   Phone: 9876543210</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function buildSlowServer(delayMs = 5000) {
  const server = http.createServer((req, res) => {
    // llama-server answers /health immediately; only inference is slow.
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function buildBrokenJsonServer(payload, status = 200) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// ── HTTP helpers ───────────────────────────────────────────────────
let server;
let baseUrl;
let token;

function api(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: urlPath,
        method,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        timeout: 300000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("client timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Simulated Gemini transport ─────────────────────────────────────
async function withGeminiStub({ probeStatus = 200, response }) {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith("https://generativelanguage.googleapis.com/")) {
      if (!options || options.method !== "POST") {
        return new Response("{}", { status: probeStatus, headers: { "Content-Type": "application/json" } });
      }
      const result = typeof response === "function" ? response(options) : response;
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(url, options);
  };
  aiProvider.resetCaches();
  return () => {
    global.fetch = realFetch;
    aiProvider.resetCaches();
  };
}

const geminiOk = (objects) => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text: JSON.stringify(objects) }] } }] },
});

// ───────────────────────────────────────────────────────────────────
async function run() {
  console.log("=================================================");
  console.log(" Mediblix AI — Online + Offline Test Suite        ");
  console.log("=================================================");

  const defaultOrg = organizationRepository.findByCode("DEFAULT");
  userRepository.create({
    name: "AI Tester",
    email: "ai.tester@mediblix.local",
    password: "AiTesterPass2026!",
    role: "staff",
    organization: defaultOrg._id,
  });

  productRepository.create({
    organization: defaultOrg._id,
    name: "Paracetamol 500mg",
    sku: "PARA-500",
    category: "Analgesics",
    quantity: 40,
    price: 2.5,
  });
  productRepository.create({
    organization: defaultOrg._id,
    name: "Levocetirizine 5mg",
    sku: "LEVO-5",
    category: "Analgesics",
    quantity: 25,
    price: 6,
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  {
    const login = await api("POST", "/api/users/login", { email: "ai.tester@mediblix.local", password: "AiTesterPass2026!" });
    token = login.json?.token;
    assert(login.status === 200 && Boolean(token), "staff login works for authenticated AI routes");
  }

  // ── Group 1: validation ────────────────────────────────────────
  console.log("\n[Group 1: AI output validation]");

  {
    const items = validateInvoiceItems([
      { name: "Paracetamol 500mg", quantity: "10", price: "₹25.50", expiryDate: "05/2027", category: "Analgesics" },
      { name: "", quantity: 3 },
      { name: "Amoxicillin 250mg", sku: "bat-202", quantity: "5", price: "120", expiryDate: "30-11-2026" },
    ]);
    assert(items.length === 2, "invoice validation drops nameless rows");
    assert(items[0].quantity === 10 && items[0].price === 25.5, "numeric strings and ₹ are normalised");
    assert(items[0].expiryDate === "2027-05-31", "MM/YYYY expiry becomes end of month");
    assert(items[1].sku === "BAT-202", "sku is upper-cased");
    assert(items[1].expiryDate === "2026-11-30", "DD-MM-YYYY date normalised");
    assert(items[0].packaging === "10 Tablets / Strip" && items[0].tabletsPerStrip === 10, "invoice defaults preserved");
    assert(typeof items[0].sku === "string" && items[0].sku.length > 2, "missing sku is generated");
  }

  await expectThrows(
    async () => validateInvoiceItems({ hello: "world" }),
    (error) => error instanceof AIError && error.code === "AI_INVALID_OUTPUT",
    "invoice validation rejects a non-list payload"
  );

  {
    const bill = validateBillPayload({
      customerMobile: "+91 98765 43210",
      customerName: "Ravi Kumar",
      items: [{ name: "Paracetamol", quantity: "2" }, { name: "", quantity: 1 }],
    });
    assert(bill.customerMobile === "9876543210", "bill mobile normalised to 10 digits");
    assert(bill.customerName === "Ravi Kumar", "bill customer name preserved");
    assert(bill.items.length === 1, "bill drops nameless items");
    assert(bill.items[0].unit === "Tablet" && bill.items[0].discount === 0, "bill defaults applied");
  }

  assert(normalizeMobile("12345") === null, "invalid mobile rejected");
  assert(normalizeDate("not a date") === null, "invalid date rejected");

  {
    const parsed = parseLooseJSON('```json\n[{"name":"A",},]\n```');
    assert(Array.isArray(parsed) && parsed[0].name === "A", "loose parser handles fences and trailing commas");
  }
  await expectThrows(
    async () => parseLooseJSON("this is not json"),
    (error) => error.code === "AI_INVALID_OUTPUT",
    "loose parser rejects malformed text"
  );

  // ── Group 2: document processing ───────────────────────────────
  console.log("\n[Group 2: document processing]");

  const digitalPdf = await buildPdf([
    "MEDIBLIX PHARMACY — PURCHASE INVOICE",
    "Paracetamol 500mg  |  BAT-101  |  Analgesics  |  Qty 10  |  Price 25.50  |  Exp 2027-05-01",
    "Amoxicillin 250mg  |  BAT-202  |  Antibiotics  |  Qty 5   |  Price 120.00 |  Exp 2026-11-30",
    "Supplier: Cipla Pharmaceuticals   GSTIN: 27AAACC1234F1Z5",
  ]);

  const inputs = documentProcessor.normalizeInputs({
    fileData: digitalPdf.toString("base64"),
    mimeType: "application/pdf",
  });
  assert(inputs.length === 1 && inputs[0].kind === "pdf", "digital PDF recognised from magic bytes");

  const pdfText = await documentProcessor.extractPdfText(digitalPdf);
  assert(pdfText.hasUsableText === true, "digital PDF has usable embedded text");
  assert(pdfText.text.includes("Paracetamol"), "embedded text contains the product line");

  const preparedText = await documentProcessor.prepareForLocal(inputs);
  assert(preparedText.mode === "text", "digital PDF is routed to the TEXT model");
  assert(preparedText.text.includes("Amoxicillin"), "local text payload includes product lines");

  const blankPdf = await buildPdf([]);
  const blankPrepared = await documentProcessor.prepareForLocal(
    documentProcessor.normalizeInputs({ fileData: blankPdf.toString("base64"), mimeType: "application/pdf" })
  );
  assert(blankPrepared.mode === "vision", "text-less PDF is routed to the VISION model");
  assert(blankPrepared.images.length >= 1, "text-less PDF renders at least one page image");
  assert(Buffer.from(blankPrepared.images[0], "base64").subarray(0, 4).toString("hex") === "89504e47", "rendered page is a real PNG");

  await expectThrows(
    async () => documentProcessor.normalizeInputs({}),
    (error) => error.code === "AI_INPUT_REQUIRED",
    "missing file data rejected"
  );
  await expectThrows(
    async () => documentProcessor.normalizeInputs({ fileData: Buffer.from("hello").toString("base64"), mimeType: "text/plain" }),
    (error) => error.code === "AI_INPUT_UNSUPPORTED",
    "unsupported file type rejected"
  );
  await expectThrows(
    async () =>
      documentProcessor.prepareForLocal([
        { kind: "audio", mimeType: "audio/webm", base64: "AAAA", buffer: Buffer.from("a") },
      ]),
    (error) => error.code === "AI_OFFLINE_UNSUPPORTED",
    "audio is reported as online-only (no silent failure)"
  );

  const invoicePng = await buildInvoicePng();
  if (invoicePng) {
    const imagePrepared = await documentProcessor.prepareForLocal(
      documentProcessor.normalizeInputs({ fileData: invoicePng.toString("base64"), mimeType: "image/png" })
    );
    assert(imagePrepared.mode === "vision", "PNG invoice is routed to the VISION model");
  } else {
    skip("PNG routing", "sharp not installed");
  }

  // ── Group 3: no provider available ─────────────────────────────
  console.log("\n[Group 3: no provider available — must fail loudly]");

  delete process.env.GEMINI_API_KEY;
  process.env.MEDIBLIX_LOCAL_AI_BASE_URL = DEAD_LOCAL;
  aiProvider.resetCaches();

  {
    const status = await api("GET", "/api/ai/status");
    assert(status.status === 200, "status endpoint answers even when AI is down");
    assert(status.json.capabilities.chat === null, "chat capability is null with no providers");
    assert(status.json.gemini.configured === false, "status reports Gemini not configured");
    assert(status.json.local.available === false, "status reports local runtime down");
  }

  {
    const res = await api("POST", "/api/ai/parse-invoice", {
      fileData: digitalPdf.toString("base64"),
      mimeType: "application/pdf",
    });
    assert(res.status === 503, "parse-invoice returns 503 when no provider exists");
    assert(Array.isArray(res.json) === false, "no fabricated item array is returned");
    assert(/not available/i.test(res.json.message || ""), "error explains AI is unavailable");
    assert(/GEMINI_API_KEY/.test(res.json.message || ""), "error names the missing Gemini configuration");
    assert(/offline AI|local AI runtime/i.test(res.json.message || ""), "error names the unreachable local runtime");
  }

  {
    const res = await api("POST", "/api/ai/parse-bill", {
      fileData: invoicePng ? invoicePng.toString("base64") : digitalPdf.toString("base64"),
      mimeType: invoicePng ? "image/png" : "application/pdf",
    });
    assert(res.status === 503, "parse-bill returns 503 when no provider exists");
  }

  {
    const res = await api("POST", "/api/medagent/chat", { message: "headache and fever" });
    assert(res.status === 503, "MedAgent symptom query returns 503 with no provider");
    assert(res.json.type === "error", "MedAgent reports an error type, not a fake answer");
  }

  {
    const res = await api("POST", "/api/medagent/chat", { message: "chest pain and difficulty breathing" });
    assert(res.status === 200 && res.json.doctorConsultRequired === true, "emergency gate answers even with no AI");
    assert(res.json.medicines.length === 0, "emergency gate never returns medicines");
    assert(res.json.provider === "safety-gate", "emergency answer is attributed to the safety gate");
  }

  {
    const alts = await api("POST", "/api/medagent/alternatives", { medicineName: "Paracetamol", category: "Analgesics" });
    assert(alts.status === 200 && alts.json.alternatives.some((a) => a.name === "Levocetirizine 5mg"), "alternatives work with no AI at all (SQLite)");
    const cats = await api("GET", "/api/medagent/categories");
    assert(cats.status === 200 && cats.json.categories.includes("Analgesics"), "categories work with no AI at all (SQLite)");
    const guide = await api("POST", "/api/medagent/chat", { message: "how do I create a bill?" });
    assert(guide.status === 200 && guide.json.type === "app_guidance", "app guidance falls back to the built-in guide");
    assert(guide.json.navigateTo === "/billing", "built-in guide returns the correct route");
  }

  // ── Group 4: online path (simulated Gemini transport) ──────────
  console.log("\n[Group 4: online path via Gemini (simulated transport)]");

  process.env.GEMINI_API_KEY = "test-key-not-real";
  process.env.MEDIBLIX_LOCAL_AI_BASE_URL = DEAD_LOCAL;
  aiProvider.resetCaches();

  {
    const restore = await withGeminiStub({
      response: { status: 200, body: geminiOk([{ name: "Gemini Para 650", sku: "G-1", quantity: 4, price: 30, expiryDate: "2027-02-28" }]).body },
    });
    try {
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      assert(res.status === 200 && Array.isArray(res.json), "Gemini extraction returns the unchanged array contract");
      assert(res.json[0]?.name === "Gemini Para 650", "Gemini item name preserved");
      assert(res.headers["x-mediblix-ai-provider"] === "gemini", "response header identifies Gemini");
      assert(res.json[0]?.expiryDate === "2027-02-28", "Gemini dates pass through validation");
    } finally {
      restore();
    }
  }

  {
    const restore = await withGeminiStub({
      response: { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ customerName: "Ravi", customerMobile: "9876543210", items: [{ name: "Paracetamol", quantity: 2, price: 25 }] }) }] } }] } },
    });
    try {
      const res = await api("POST", "/api/ai/parse-bill", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      assert(
        res.status === 200 && res.json.customerMobile === "9876543210",
        `Gemini bill customer extracted (status ${res.status}: ${JSON.stringify(res.json).slice(0, 160)})`
      );
      assert(res.json.items.length === 1, "Gemini bill items extracted");
      assert(res.headers["x-mediblix-ai-provider"] === "gemini", "bill response identifies Gemini");
    } finally {
      restore();
    }
  }

  {
    const restore = await withGeminiStub({
      response: { status: 500, body: { error: { code: 500, message: "internal" } } },
    });
    try {
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      assert(res.status === 503, "Gemini 5xx with no local provider returns 503");
      assert(/Gemini/i.test(res.json.message || ""), "error explains that Gemini failed");
    } finally {
      restore();
    }
  }

  {
    const restore = await withGeminiStub({
      response: { status: 401, body: { error: { code: 401, message: "API key not valid" } } },
    });
    try {
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      assert(res.status === 503, "Gemini auth failure is surfaced (not hidden)");
      assert(/API key|rejected|Gemini/i.test(res.json.message || ""), "auth failure message is actionable");
    } finally {
      restore();
    }
  }

  {
    // Gemini hangs → provider timeout, no fabricated result.
    const restore = await withGeminiStub({
      response: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: geminiOk([]).body }), 5000)),
    });
    try {
      const started = Date.now();
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      const elapsed = Date.now() - started;
      assert(res.status === 503, "Gemini timeout is reported as unavailable");
      assert(elapsed < 4000, `timeout honoured (${elapsed}ms)`);
    } finally {
      restore();
    }
  }

  {
    delete process.env.GEMINI_API_KEY;
    aiProvider.resetCaches();
    const res = await api("POST", "/api/ai/parse-invoice", {
      fileData: digitalPdf.toString("base64"),
      mimeType: "application/pdf",
    });
    assert(res.status === 503 && /GEMINI_API_KEY/.test(res.json.message || ""), "missing Gemini key is named explicitly");
    process.env.GEMINI_API_KEY = "test-key-not-real";
  }

  // ── Group 5: local failure modes ───────────────────────────────
  console.log("\n[Group 5: local runtime failure modes]");

  {
    const slow = await buildSlowServer(4000);
    const previousUrl = process.env.MEDIBLIX_LOCAL_AI_BASE_URL;
    const previousTimeout = process.env.MEDIBLIX_LOCAL_TEXT_TIMEOUT_MS;
    process.env.MEDIBLIX_LOCAL_AI_BASE_URL = slow.url;
    process.env.MEDIBLIX_LOCAL_TEXT_TIMEOUT_MS = "400";
    localAIService.resetHealthCache();
    try {
      await expectThrows(
        async () => localAIService.chatJSON({ prompt: "hello" }),
        (error) => error.code === "AI_TIMEOUT",
        "local inference timeout is a typed AI_TIMEOUT"
      );
    } finally {
      restoreEnv("MEDIBLIX_LOCAL_AI_BASE_URL", previousUrl);
      restoreEnv("MEDIBLIX_LOCAL_TEXT_TIMEOUT_MS", previousTimeout);
      localAIService.resetHealthCache();
      slow.server.closeAllConnections?.();
      slow.server.close();
    }
  }

  {
    const broken = await buildBrokenJsonServer({ choices: [{ message: { content: "definitely not json" } }] });
    const previousUrl = process.env.MEDIBLIX_LOCAL_AI_BASE_URL;
    process.env.MEDIBLIX_LOCAL_AI_BASE_URL = broken.url;
    localAIService.resetHealthCache();
    try {
      await expectThrows(
        async () => localAIService.chatJSON({ prompt: "hello" }),
        (error) => error.code === "AI_INVALID_OUTPUT",
        "malformed local JSON is rejected, not passed downstream"
      );
    } finally {
      restoreEnv("MEDIBLIX_LOCAL_AI_BASE_URL", previousUrl);
      localAIService.resetHealthCache();
      broken.server.closeAllConnections?.();
      broken.server.close();
    }
  }

  {
    // A runtime that answers /health but whose inference backend fails must be
    // reported as a runtime problem, not as a missing model.
    const engineBroken = await buildBrokenJsonServer(
      { error: { message: "ggml_backend_metal_init: failed to allocate buffer" } },
      500
    );
    const previousUrl = process.env.MEDIBLIX_LOCAL_AI_BASE_URL;
    process.env.MEDIBLIX_LOCAL_AI_BASE_URL = engineBroken.url;
    localAIService.resetHealthCache();
    try {
      await expectThrows(
        async () => localAIService.chatJSON({ prompt: "hello" }),
        (error) => error.code === "AI_LOCAL_UNAVAILABLE" && /memory|runtime/i.test(error.message),
        "broken runtime engine is reported as a runtime problem"
      );
    } finally {
      restoreEnv("MEDIBLIX_LOCAL_AI_BASE_URL", previousUrl);
      localAIService.resetHealthCache();
      engineBroken.server.closeAllConnections?.();
      engineBroken.server.close();
    }
  }

  // ── Group 6: LIVE offline inference ────────────────────────────
  console.log("\n[Group 6: LIVE offline inference]");

  process.env.MEDIBLIX_LOCAL_AI_BASE_URL = LIVE_LOCAL;
  // The Lite tier reads scans with the OCR pipeline, which is opt-in until
  // accuracy is signed off, so this live suite enables it explicitly.
  process.env.MEDIBLIX_SCAN_OCR = "on";
  delete process.env.GEMINI_API_KEY;
  aiProvider.resetCaches();

  const health = await localAIService.checkHealth({ force: true });
  const live = health.available && health.textModelReady;

  if (!live) {
    skip("live offline inference", `no llama-server with models at ${LIVE_LOCAL}`);
    skip("offline invoice (digital PDF)", "requires a live bundled runtime");
    skip("offline invoice (image)", "requires a live bundled runtime");
    skip("offline bill", "requires a live bundled runtime");
    skip("offline MedAgent chat", "requires a live bundled runtime");
  } else {
    console.log(`  · runtime ${health.backend || "llama.cpp"} at ${LIVE_LOCAL}; models: ${health.models.join(", ")}`);

    const statusRes = await api("GET", "/api/ai/status");
    assert(statusRes.json.local.available === true, "status reports the local runtime available");
    assert(statusRes.json.local.textModelReady === true, "status reports the text model installed");
    assert(statusRes.json.capabilities.chat === "local", "chat capability resolves to local");

    const productsBefore = productRepository.findAll(defaultOrg._id).length;

    {
      const started = Date.now();
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: digitalPdf.toString("base64"),
        mimeType: "application/pdf",
      });
      const elapsed = Date.now() - started;
      assert(res.status === 200 && Array.isArray(res.json), `offline digital-PDF invoice parsed (${elapsed}ms)`);
      assert(res.headers["x-mediblix-ai-provider"] === "local", "invoice response identifies the local provider");
      assert(res.json.length >= 1, `offline invoice extracted ${res.json.length} item(s)`);
      const names = res.json.map((i) => String(i.name).toLowerCase()).join(" | ");
      assert(
        names.includes("paracetamol") || names.includes("amoxicillin"),
        `extracted name matches the document (got: ${names})`
      );
      const first = res.json[0];
      assert(typeof first.quantity === "number" && typeof first.price === "number", "offline numbers are real numbers");
      assert(/^\d{4}-\d{2}-\d{2}$/.test(first.expiryDate || ""), "offline expiry is normalised to YYYY-MM-DD");
    }

    if (invoicePng) {
      const res = await api("POST", "/api/ai/parse-invoice", {
        fileData: invoicePng.toString("base64"),
        mimeType: "image/png",
      });
      assert(res.status === 200 && Array.isArray(res.json), "offline PNG invoice read by the OCR pipeline");
      assert(res.headers["x-mediblix-ai-provider"] === "local", "image path reports the local provider");
      assert(res.json.length >= 1, `OCR extraction returned ${res.json.length} item(s)`);
    } else {
      skip("offline image invoice", "sharp unavailable");
    }

    {
      const billInput = invoicePng
        ? { fileData: invoicePng.toString("base64"), mimeType: "image/png" }
        : { fileData: digitalPdf.toString("base64"), mimeType: "application/pdf" };
      const res = await api("POST", "/api/ai/parse-bill", billInput);
      assert(res.status === 200 && typeof res.json === "object", "offline bill parse returns the object contract");
      assert(Array.isArray(res.json.items), "offline bill includes an items array");
      assert(res.headers["x-mediblix-ai-provider"] === "local", "bill response identifies the local provider");
    }

    {
      const res = await api("POST", "/api/medagent/chat", { message: "customer has mild headache and fever" });
      assert(res.status === 200, "offline MedAgent chat returns 200");
      assert(res.json.type === "medicine_suggestion", "offline chat returns a medicine suggestion payload");
      assert(res.json.provider === "local" && res.json.offline === true, "offline chat is labelled local");
      const fabricated = (res.json.medicines || []).filter(
        (m) => !m.inventory || !m.inventory.matchedProduct || m.inventory.available !== true
      );
      assert(fabricated.length === 0, "offline chat never surfaces a medicine outside inventory");
    }

    {
      const productsAfter = productRepository.findAll(defaultOrg._id).length;
      assert(productsAfter === productsBefore, "AI parsing wrote nothing to the catalogue");
    }
  }

  // ── Group 7: business workflows ────────────────────────────────
  console.log("\n[Group 7: business workflows preserve SQLite transactions]");

  {
    const before = productRepository.findBySku("PARA-500", defaultOrg._id);
    const res = await api("POST", "/api/import-history", {
      fileName: "offline-invoice.pdf",
      items: [
        { name: "Paracetamol 500mg", sku: "PARA-500", category: "Analgesics", quantity: 10, price: 2.5 },
        { name: "Offline New Med", sku: "OFF-NEW-1", category: "Antibiotics", quantity: 7, price: 12 },
      ],
    });
    assert(res.status === 201, "import-history commits the reviewed items");
    const after = productRepository.findBySku("PARA-500", defaultOrg._id);
    const created = productRepository.findBySku("OFF-NEW-1", defaultOrg._id);
    assert(after.quantity === before.quantity + 10, "existing SKU stock incremented by the import");
    assert(Boolean(created) && created.quantity === 7, "new SKU created by the import");
    assert(res.json.totalProducts === 2, "import history records the batch");
  }

  {
    const product = productRepository.findBySku("PARA-500", defaultOrg._id);
    const stockBefore = product.quantity;
    const sale = await api("POST", "/api/sales", {
      items: [{ product: product._id, name: product.name, quantity: 2, price: product.price }],
      paymentMethod: "Cash",
    });
    assert(sale.status === 201, `sale checkout succeeds after AI-assisted parsing (status ${sale.status}: ${JSON.stringify(sale.json).slice(0, 160)})`);
    const stockAfter = productRepository.findBySku("PARA-500", defaultOrg._id).quantity;
    assert(stockAfter === stockBefore - 2, "stock decremented by the sale transaction");
    assert(typeof sale.json?.invoiceNumber === "string", "invoice number generated");
  }

  {
    const unauth = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.address().port, path: "/api/ai/status", method: "GET", agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.end();
    });
    assert(unauth === 401, "AI status still requires authentication");
  }
}

run()
  .catch((error) => {
    console.error("Unexpected suite error:", error);
    failed++;
  })
  .finally(async () => {
    try {
      server?.closeAllConnections?.();
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    } catch {}
    closeDatabase();
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(tmpDb + ext);
      } catch {}
    }

    console.log("\n=================================================");
    console.log(` Summary: ${passed} Passed, ${failed} Failed, ${skipped} Skipped`);
    console.log("=================================================");
    process.exit(failed > 0 ? 1 : 0);
  });
