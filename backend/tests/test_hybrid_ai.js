/**
 * Mediblix Desktop — Hybrid AI Architecture Test Suite
 *
 * Verifies:
 *  1. Hybrid AI status endpoint (/api/medagent/status)
 *  2. Real-time offline inventory insights (/api/medagent/insights)
 *  3. Emergency symptom triage (instant warning, doctor consultation flag)
 *  4. Offline symptom analysis cross-referenced with local SQLite inventory
 *  5. Offline alternatives lookup from tenant-scoped SQLite database
 *  6. Offline application guidance & FAQ navigation steps
 *  7. Multi-tenant isolation for AI assistant queries
 *  8. Graceful offline fallback behavior when cloud AI is unreachable
 *  9. AI invoice/bill route protection and structured offline fallback guidance
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import http from "http";
import express from "express";
import cors from "cors";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mediblix_hybrid_ai_test_secret_2026";
process.env.ADMIN_EMAIL = "admin@mediblix.local";
process.env.ADMIN_PASSWORD = "TestAdminPassword2026!";

// Intentionally clear cloud keys to test offline mode
delete process.env.AWS_AI_GATEWAY_URL;
delete process.env.AWS_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const testDbPath = path.join(__dirname, "test_hybrid_ai.db");

function cleanDbFiles() {
  for (const ext of ["", "-wal", "-shm"]) {
    const f = testDbPath + ext;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (e) {
        // ignore
      }
    }
  }
}
cleanDbFiles();

// Initialize isolated SQLite database
const { initDatabase, closeDatabase } = require("../../database/db.js");
initDatabase(testDbPath);

const repositories = require("../../database/repositories/index.js");
const {
  userRepository,
  organizationRepository,
  productRepository,
} = repositories;

// Import Express routes
import authRoutes from "../routes/authRoutes.js";
import medAgentRoutes from "../routes/medAgentRoutes.js";
import aiRoutes from "../routes/aiRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", authRoutes);
app.use("/api/medagent", medAgentRoutes);
app.use("/api/ai", aiRoutes);

let server;
let baseUrl;

async function runTests() {
  console.log("=================================================");
  console.log(" Mediblix Desktop — Hybrid AI Architecture Tests ");
  console.log("=================================================");

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
    // 1. Setup Server
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 2. Setup Baseline Organizations & Users
    const defaultOrg = organizationRepository.findByCode("DEFAULT");
    assert(defaultOrg, "Default organization initialized");

    const staffUser = userRepository.create({
      name: "Pharmacy Staff",
      email: "pharmacy@mediblix.local",
      password: "PharmacyPassword123!",
      role: "staff",
      isAdmin: false,
      organization: defaultOrg._id,
    });

    // Log in Staff User
    const loginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pharmacy@mediblix.local", password: "PharmacyPassword123!" }),
    });
    const staffToken = (await loginRes.json()).token;
    assert(staffToken, "Pharmacy staff logged in successfully");

    // Seed test products in Default Org
    productRepository.create({
      organization: defaultOrg._id,
      name: "Dolo 650",
      sku: "BAT-DOLO650",
      category: "Analgesics & Antipyretics",
      price: 32.5,
      quantity: 100,
    });

    productRepository.create({
      organization: defaultOrg._id,
      name: "Pan 40",
      sku: "BAT-PAN40",
      category: "Gastrointestinal",
      price: 145.0,
      quantity: 5, // low stock (<= 10)
    });

    productRepository.create({
      organization: defaultOrg._id,
      name: "Digene Gel",
      sku: "BAT-DIGENE",
      category: "Gastrointestinal",
      price: 120.0,
      quantity: 0, // out of stock
    });

    // ------------------------------------------------------------------
    // TEST GROUP 1: Hybrid AI Status & Diagnostics
    // ------------------------------------------------------------------
    console.log("\n[Group 1: Hybrid AI Status Endpoint]");
    const statusRes = await fetch(`${baseUrl}/api/medagent/status`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(statusRes.status === 200, "GET /api/medagent/status returns 200");
    const statusData = await statusRes.json();
    assert(statusData.offlineReady === true, "Status reports offlineReady: true");
    assert(statusData.activeMode === "offline", "Status reports activeMode: 'offline' when cloud keys absent");
    assert(Array.isArray(statusData.localCapabilities), "Status provides list of local capabilities");

    // ------------------------------------------------------------------
    // TEST GROUP 2: Local SQLite Inventory Insights
    // ------------------------------------------------------------------
    console.log("\n[Group 2: Offline Inventory Insights]");
    const insightsRes = await fetch(`${baseUrl}/api/medagent/insights`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(insightsRes.status === 200, "GET /api/medagent/insights returns 200");
    const insightsData = await insightsRes.json();
    assert(insightsData.mode === "offline", "Insights mode is 'offline'");
    assert(insightsData.provider === "local-sqlite", "Insights provider is 'local-sqlite'");
    assert(insightsData.metrics.totalProducts === 3, "Computed 3 total products in SQLite");
    assert(insightsData.metrics.lowStockCount === 1, "Computed 1 low stock item in SQLite");
    assert(insightsData.metrics.outOfStockCount === 1, "Computed 1 out of stock item in SQLite");
    assert(insightsData.criticalReorders.length > 0, "Generated critical reorders list");

    // ------------------------------------------------------------------
    // TEST GROUP 3: Emergency Symptom Triage
    // ------------------------------------------------------------------
    console.log("\n[Group 3: Emergency Symptom Triage]");
    const emergencyRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ message: "Patient has severe chest pain and breathlessness" }),
    });
    assert(emergencyRes.status === 200, "POST /api/medagent/chat returns 200 for emergency query");
    const emergencyData = await emergencyRes.json();
    assert(emergencyData.doctorConsultRequired === true, "Emergency triage sets doctorConsultRequired: true");
    assert(emergencyData.severity === "severe", "Emergency triage sets severity: 'severe'");
    assert(emergencyData.medicines.length === 0, "Emergency triage dispenses no OTC medicines without consult");

    // ------------------------------------------------------------------
    // TEST GROUP 4: Offline Symptom Analysis & Inventory Cross-Referencing
    // ------------------------------------------------------------------
    console.log("\n[Group 4: Offline Symptom Matching & Stock Cross-Referencing]");
    const feverRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ message: "Customer has headache and fever" }),
    });
    assert(feverRes.status === 200, "POST /api/medagent/chat returns 200 for fever query");
    const feverData = await feverRes.json();
    assert(feverData.mode === "offline", "Response executed in offline mode");
    assert(feverData.type === "medicine_suggestion", "Returned medicine_suggestion type");
    assert(feverData.medicines.length > 0, "Recommended OTC medicines for fever");
    const doloMatched = feverData.medicines.find((m) => m.inventory?.matchedProduct === "Dolo 650");
    assert(doloMatched && doloMatched.inventory.available === true, "Cross-referenced Dolo 650 as available in local stock");

    // ------------------------------------------------------------------
    // TEST GROUP 5: Offline Alternatives Lookup
    // ------------------------------------------------------------------
    console.log("\n[Group 5: Offline Alternatives Engine]");
    const altRes = await fetch(`${baseUrl}/api/medagent/alternatives`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ medicineName: "Digene Gel", category: "Gastrointestinal" }),
    });
    assert(altRes.status === 200, "POST /api/medagent/alternatives returns 200");
    const altData = await altRes.json();
    assert(altData.alternatives.some((a) => a.name === "Pan 40"), "Found in-stock Pan 40 as alternative in Gastrointestinal category");

    // ------------------------------------------------------------------
    // TEST GROUP 6: Offline Application Guidance & FAQs
    // ------------------------------------------------------------------
    console.log("\n[Group 6: Offline App Navigation Guidance]");
    const guideRes = await fetch(`${baseUrl}/api/medagent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({ message: "How to add product to inventory?" }),
    });
    assert(guideRes.status === 200, "POST /api/medagent/chat returns 200 for app guide query");
    const guideData = await guideRes.json();
    assert(guideData.type === "app_guidance", "Returned app_guidance type");
    assert(guideData.navigateTo === "/inventory", "Suggested navigation to /inventory");
    assert(Array.isArray(guideData.steps) && guideData.steps.length > 0, "Provided step-by-step instructions");

    // ------------------------------------------------------------------
    // TEST GROUP 7: Tenant Isolation
    // ------------------------------------------------------------------
    console.log("\n[Group 7: Tenant Isolation for AI]");
    // Create Org B
    const orgB = organizationRepository.create({
      name: "Tenant B Pharmacy",
      code: "TENANT_B",
      contactEmail: "tenantb@mediblix.local",
    });
    const staffB = userRepository.create({
      name: "Tenant B Staff",
      email: "staffb@mediblix.local",
      password: "StaffBPassword123!",
      role: "staff",
      isAdmin: false,
      organization: orgB._id,
    });
    const loginBRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "staffb@mediblix.local", password: "StaffBPassword123!" }),
    });
    const tokenB = (await loginBRes.json()).token;

    const insightsBRes = await fetch(`${baseUrl}/api/medagent/insights`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const insightsB = await insightsBRes.json();
    assert(insightsB.metrics.totalProducts === 0, "Tenant B sees 0 products (complete tenant isolation)");

    // ------------------------------------------------------------------
    // TEST GROUP 8: Document Parsing Offline Guidance
    // ------------------------------------------------------------------
    console.log("\n[Group 8: Document Parsing Offline Handling]");
    const ocrOfflineRes = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        fileData: "dummyBase64Data",
        mimeType: "image/png",
      }),
    });
    assert(ocrOfflineRes.status === 503, "POST /api/ai/parse-invoice without cloud gateway returns HTTP 503");
    const ocrData = await ocrOfflineRes.json();
    assert(ocrData.mode === "offline", "Invoice error specifies mode: 'offline'");
    assert(ocrData.fallbackOption?.template, "Provided fallback guidance to CSV / Excel template");

  } catch (err) {
    console.error("Unexpected error during test execution:", err);
    failed++;
  } finally {
    if (server) {
      server.close();
    }
    closeDatabase();
    cleanDbFiles();
  }

  console.log("\n=================================================");
  console.log(` Summary: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
