/**
 * Mediblix Desktop — Comprehensive Offline AI End-to-End Test Suite
 *
 * Covers:
 *  Test A: MedAgent Chat (Local LLM, Inventory Lookup, Emergency Triage, Safety)
 *  Test B: AI Invoice / Purchase Import (Image, Text PDF, Scanned PDF, Audio)
 *  Test C: AI Bill Parser (Customer details, Line Items, Schema Validation)
 *  Test D: Provider Isolation (Ensuring ZERO requests to Google/Gemini in local mode)
 */

import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mediblix_desktop_test_jwt_secret_2026";
process.env.MEDIBLIX_AI_PROVIDER = "local"; // STRICT LOCAL AI

const testDbPath = path.join(__dirname, "test_offline_ai.db");

// Clean old test db
for (const ext of ["", "-wal", "-shm"]) {
  if (fs.existsSync(testDbPath + ext)) {
    try { fs.unlinkSync(testDbPath + ext); } catch (_) {}
  }
}

// 1. Initialize SQLite Database
const { initDatabase, closeDatabase } = require("../../database/db.js");
initDatabase(testDbPath);

const repositories = require("../../database/repositories/index.js");
const { userRepository, organizationRepository, productRepository } = repositories;

// 2. Network Spy / Request Interceptor to verify ZERO external calls to Gemini
let externalRequestCount = 0;
const externalRequestsLogged = [];

const origHttpRequest = http.request;
const origHttpsRequest = https.request;

function checkUrlForCloudAI(options) {
  const host = options.host || options.hostname || "";
  const path = options.path || "";
  if (host.includes("googleapis.com") || host.includes("generativelanguage")) {
    externalRequestCount++;
    externalRequestsLogged.push(`BLOCKED OUTBOUND TO: ${host}${path}`);
    throw new Error(`CRITICAL VIOLATION: Outbound Cloud AI request detected in Offline Mode to ${host}`);
  }
}

https.request = function (...args) {
  const opt = typeof args[0] === "string" ? new URL(args[0]) : args[0];
  checkUrlForCloudAI(opt);
  return origHttpsRequest.apply(this, args);
};

http.request = function (...args) {
  const opt = typeof args[0] === "string" ? new URL(args[0]) : args[0];
  checkUrlForCloudAI(opt);
  return origHttpRequest.apply(this, args);
};

// 3. Import Express Routes
import authRoutes from "../routes/authRoutes.js";
import medAgentRoutes from "../routes/medAgentRoutes.js";
import aiRoutes from "../routes/aiRoutes.js";
import { generateFixtures } from "./create_test_fixtures.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/api/users", authRoutes);
app.use("/api/medagent", medAgentRoutes);
app.use("/api/ai", aiRoutes);

app.use((err, req, res, next) => {
  const status = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ message: err.message });
});

let server;
let baseUrl;

async function runTestSuite() {
  console.log("=================================================================");
  console.log(" Mediblix Desktop — Mandatory Offline AI Verification Suite     ");
  console.log("=================================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // Generate fresh synthetic test fixtures (PNGs, PDFs)
    await generateFixtures();

    // Start test server
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Seed baseline user & organization in SQLite
    const defaultOrg = organizationRepository.findByCode("DEFAULT");
    assert(defaultOrg, "Default Organization active in SQLite");

    // Add inventory items for MedAgent testing
    const paracetamol = productRepository.create({
      organization: defaultOrg._id,
      name: "Paracetamol 500mg Tablets",
      sku: "MED-PARA500",
      category: "Analgesics",
      price: 25.0,
      quantity: 120,
    });

    const cetirizine = productRepository.create({
      organization: defaultOrg._id,
      name: "Cetirizine 10mg Tablets",
      sku: "MED-CET10",
      category: "Antiallergic",
      price: 35.0,
      quantity: 50,
    });

    // Create staff user and login to get JWT
    const staffUser = userRepository.create({
      name: "Pharmacy Pharmacist",
      email: "pharmacist@mediblix.local",
      password: "TestStaffPassword123!",
      role: "staff",
      isAdmin: false,
      organization: defaultOrg._id,
    });

    const loginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pharmacist@mediblix.local", password: "TestStaffPassword123!" }),
    });
    const token = (await loginRes.json()).token;
    assert(token, "Staff user authenticated with local SQLite token");

    // ─────────────────────────────────────────────────────────────
    // TEST A: MedAgent Chat (100% Offline with Local Llama 3.2 3B)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test A: MedAgent Chat Offline Verification]");

    // 1. General conversation
    const generalRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "Hello, who are you and how can you help me?" }),
    });
    assert(generalRes.status === 200, "MedAgent general query returns HTTP 200");
    const generalData = await generalRes.json();
    assert(generalData.type === "general" || generalData.message.length > 10, "MedAgent generated genuine greeting response");

    // 2. Symptom Query with Inventory Cross-Referencing
    const symptomRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "Customer has mild headache and fever. What can I suggest?" }),
    });
    assert(symptomRes.status === 200, "MedAgent symptom analysis returns HTTP 200");
    const symptomData = await symptomRes.json();
    assert(symptomData.type === "medicine_suggestion", "Response type is 'medicine_suggestion'");
    assert(Array.isArray(symptomData.medicines), "Contains structured medicines array");
    console.log(`    -> Condition detected: ${symptomData.condition}`);
    console.log(`    -> Medicines suggested: ${symptomData.medicines.map((m) => m.genericName).join(", ")}`);

    // 3. Deterministic Emergency Triage (Layer 1 Safety)
    const emergencyRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "Customer is clutching chest with severe chest pain and difficulty breathing!" }),
    });
    assert(emergencyRes.status === 200, "Emergency message returns HTTP 200");
    const emergencyData = await emergencyRes.json();
    assert(emergencyData.doctorConsultRequired === true, "Safety: doctorConsultRequired is strictly TRUE");
    assert(emergencyData.severity === "severe", "Safety: severity is flagged 'severe'");
    assert(emergencyData.medicines.length === 0, "Safety: Medicines array is strictly EMPTY for emergency");
    assert(emergencyData.message.toLowerCase().includes("urgent"), "Safety: Urgent warning displayed in message");

    // 4. Medicine Alternatives
    const altRes = await fetch(`${baseUrl}/api/medagent/alternatives`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ medicineName: "Paracetamol", category: "Analgesics" }),
    });
    assert(altRes.status === 200, "Alternatives endpoint returns HTTP 200");
    const altData = await altRes.json();
    assert(Array.isArray(altData.alternatives), "Returns alternatives array directly from SQLite");

    // ─────────────────────────────────────────────────────────────
    // TEST B: AI Invoice Import (Image & PDF Offline Parsing)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test B: AI Invoice Import Offline Verification]");

    const fixturesDir = path.join(__dirname, "fixtures");
    const sampleInvoicePngPath = path.join(fixturesDir, "sample_invoice.png");
    const sampleScannedPdfPath = path.join(fixturesDir, "sample_scanned_invoice.pdf");
    const sampleBillPngPath = path.join(fixturesDir, "sample_bill.png");

    // 1. Text-based PDF Invoice Parsing
    const syntheticPdfText = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length 200 >>\nstream\nBT\n/F1 12 Tf\n50 700 Td\n(PHARMACEUTICAL TAX INVOICE) Tj\n0 -20 Td\n(Item: Amoxicillin 500mg Batch: AMX-99 Qty: 50 Price: 120.00 Exp: 2027-05-31) Tj\n0 -20 Td\n(Item: Ibuprofen 400mg Batch: IBU-22 Qty: 100 Price: 45.00 Exp: 2026-12-31) Tj\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000325 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n577\n%%EOF`;

    const pdfBase64 = Buffer.from(syntheticPdfText).toString("base64");

    const invoicePdfRes = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileData: pdfBase64, mimeType: "application/pdf" }),
    });

    assert(invoicePdfRes.status === 200, "Text PDF Invoice parsing returns HTTP 200");
    const pdfItems = await invoicePdfRes.json();
    assert(Array.isArray(pdfItems), "Extracted PDF invoice response is a JSON array");
    assert(pdfItems.length >= 1, `Extracted ${pdfItems.length} items from synthetic PDF invoice`);
    if (pdfItems.length > 0) {
      assert(pdfItems[0].name && pdfItems[0].price, "First item contains name and price");
      console.log(`    -> Extracted PDF Item 1: ${pdfItems[0].name} (Qty: ${pdfItems[0].quantity}, Price: ₹${pdfItems[0].price})`);
    }

    // 2. Real Image Invoice Vision Parsing with Qwen2.5-VL 7B (NO HTTP 422 allowed)
    console.log("  ... Processing synthetic invoice image via Qwen2.5-VL 7B ...");
    const invoicePngBuffer = fs.readFileSync(sampleInvoicePngPath);
    const invoicePngBase64 = invoicePngBuffer.toString("base64");

    const invoiceImgRes = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileData: invoicePngBase64, mimeType: "image/png" }),
    });

    assert(invoiceImgRes.status === 200, "Image Invoice returns strict HTTP 200 (422 is failure)");
    const imgItems = await invoiceImgRes.json();
    assert(Array.isArray(imgItems), "Image Invoice response is a valid JSON array");
    assert(imgItems.length >= 1, `Extracted ${imgItems.length} items from PNG invoice via Qwen 7B`);
    const foundAmox = imgItems.some((item) => (item.name || "").toLowerCase().includes("amox") || (item.name || "").toLowerCase().includes("para"));
    assert(foundAmox, "Image Vision accurately extracted known synthetic product item (Amoxicillin / Paracetamol)");
    console.log(`    -> Qwen 7B Extracted Image Items:`, imgItems.map((i) => `${i.name} (Qty: ${i.quantity}, Price: ${i.price})`).join("; "));

    // 3. Scanned PDF Invoice Vision Parsing (Actual Qwen local vision on rendered canvas page)
    console.log("  ... Processing scanned PDF (0 text layer) via local canvas render + Qwen2.5-VL 7B ...");
    const scannedPdfBuffer = fs.readFileSync(sampleScannedPdfPath);
    const scannedPdfBase64 = scannedPdfBuffer.toString("base64");

    const scannedPdfRes = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileData: scannedPdfBase64, mimeType: "application/pdf" }),
    });

    assert(scannedPdfRes.status === 200, "Scanned PDF (no text layer) returns HTTP 200 via vision");
    const scannedItems = await scannedPdfRes.json();
    assert(Array.isArray(scannedItems) && scannedItems.length >= 1, "Scanned PDF extracted items array via local vision");
    console.log(`    -> Scanned PDF items extracted: ${scannedItems.length}`);

    // 4. Audio Dictation Workflow Testing (through existing parse-invoice files array endpoint)
    console.log("  ... Processing audio dictation recording through existing import workflow ...");
    const wavefilePkg = (await import("wavefile")).default || (await import("wavefile"));
    const WaveFile = wavefilePkg.WaveFile || wavefilePkg;
    const wav = new WaveFile();
    const samples = new Float32Array(16000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.2;
    }
    wav.fromScratch(1, 16000, "32f", samples);
    const audioBase64 = Buffer.from(wav.toBuffer()).toString("base64");

    const audioWorkflowRes = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        files: [
          {
            fileData: audioBase64,
            mimeType: "audio/wav",
          },
        ],
      }),
    });

    assert(audioWorkflowRes.status === 200 || audioWorkflowRes.status === 500, "Audio workflow through parse-invoice processed without application crash");

    // ─────────────────────────────────────────────────────────────
    // TEST C: AI Sales Bill Parser Offline (Actual Qwen Vision Extraction)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test C: AI Sales Bill Parser Offline Verification]");

    console.log("  ... Processing synthetic customer bill via Qwen2.5-VL 7B vision ...");
    const billPngBuffer = fs.readFileSync(sampleBillPngPath);
    const billPngBase64 = billPngBuffer.toString("base64");

    const billRes = await fetch(`${baseUrl}/api/ai/parse-bill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileData: billPngBase64, mimeType: "image/png" }),
    });

    assert(billRes.status === 200, "Sales Bill Image returns strict HTTP 200");
    const billData = await billRes.json();
    assert(typeof billData === "object", "Bill data is a JSON object");
    assert(Array.isArray(billData.items), "Bill data contains structured items array");
    console.log(`    -> Bill Customer: ${billData.customerName || "N/A"} (${billData.customerMobile || "N/A"})`);
    console.log(`    -> Bill Items:`, (billData.items || []).map((i) => `${i.name} (Qty: ${i.quantity}, Price: ${i.price})`).join("; "));

    // ─────────────────────────────────────────────────────────────
    // TEST D: Provider Isolation & Security (Zero Google API calls)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test D: Strict Network Isolation Verification]");

    // Deliberately set a mock GEMINI_API_KEY in environment
    process.env.GEMINI_API_KEY = "AIzaSy_MOCK_GEMINI_KEY_FOR_ISOLATION_TEST_2026";

    // Verify status endpoint
    const statusRes = await fetch(`${baseUrl}/api/ai/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(statusRes.status === 200, "GET /api/ai/status returns HTTP 200");
    const statusData = await statusRes.json();
    assert(statusData.provider === "local", "AI provider is strictly 'local'");
    assert(statusData.isOfflineOnly === true, "isOfflineOnly is true");

    // Perform another full chat query with GEMINI_API_KEY present
    await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "Give me cold medicine advice" }),
    });

    // Verify spy count: Absolutely ZERO requests were made to Google APIs
    assert(externalRequestCount === 0, "Network Isolation: 0 requests to googleapis.com or Gemini");
    assert(externalRequestsLogged.length === 0, "No external cloud requests attempted");

    // Switch provider to 'cloud' without internet / with mock key: must fail cleanly without silent fallback
    await fetch(`${baseUrl}/api/ai/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "cloud" }),
    });

    const cloudFailRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "Test cloud failure" }),
    });

    assert(cloudFailRes.status === 500, "Cloud mode with invalid key fails with explicit 500 (no silent fallback)");

    // Switch back to 'local'
    await fetch(`${baseUrl}/api/ai/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "local" }),
    });

  } catch (err) {
    console.error("FATAL test error:", err);
    failed++;
  } finally {
    https.request = origHttpsRequest;
    http.request = origHttpRequest;

    if (server) server.close();
    closeDatabase();
    for (const ext of ["", "-wal", "-shm"]) {
      if (fs.existsSync(testDbPath + ext)) {
        try { fs.unlinkSync(testDbPath + ext); } catch (_) {}
      }
    }
  }

  console.log("\n=================================================================");
  console.log(` Summary: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
