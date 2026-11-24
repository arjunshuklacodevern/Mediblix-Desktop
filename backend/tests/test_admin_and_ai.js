/**
 * Mediblix Desktop — Phase 3D Admin, MedAgent & AI Test Suite
 *
 * Verifies:
 *  1. Super Admin authentication & authorization (non-admins rejected with 403)
 *  2. Organization creation, validation, duplicate rejection, and initial admin provisioning
 *  3. Organization listing with calculated counts (products, sales, users, revenue, days remaining)
 *  4. Organization search and status filtering
 *  5. Organization details endpoint with populated users and recent sales
 *  6. Organization detail update via PUT
 *  7. Subscription management via PATCH (plan update, daysToAdd extension)
 *  8. Organization status toggling ('Active' <-> 'Frozen')
 *  9. Device session unlocking and reset across organization users
 * 10. Organization admin password reset with password history tracking
 * 11. Dashboard aggregate statistics (/api/admin/stats)
 * 12. MedAgent category discovery and alternatives search scoped to tenant
 * 13. AI parsing route protection and input validation
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
process.env.JWT_SECRET = "mediblix_desktop_test_jwt_secret_2026";
process.env.ADMIN_EMAIL = "superadmin@mediblix.local";
process.env.ADMIN_PASSWORD = "MasterAdminPassword2026!";

const testDbPath = path.join(__dirname, "test_admin_ai.db");

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
import adminRoutes from "../routes/adminRoutes.js";
import medAgentRoutes from "../routes/medAgentRoutes.js";
import aiRoutes from "../routes/aiRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/medagent", medAgentRoutes);
app.use("/api/ai", aiRoutes);

// Error handler matching backend/index.js
app.use((err, req, res, next) => {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    message: err.message || "An unexpected error occurred",
  });
});

let server;
let baseUrl;

async function runTests() {
  console.log("=================================================");
  console.log(" Mediblix Desktop — Phase 3D Admin & AI Tests    ");
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

    // 2. Setup Baseline
    const defaultOrg = organizationRepository.findByCode("DEFAULT");
    assert(defaultOrg, "Default organization initialized");

    // Staff User
    const staffUser = userRepository.create({
      name: "Normal Staff",
      email: "staff@mediblix.local",
      password: "StaffPassword123!",
      role: "staff",
      isAdmin: false,
      organization: defaultOrg._id,
    });

    // Log in Staff User
    const staffLoginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "staff@mediblix.local", password: "StaffPassword123!" }),
    });
    const staffToken = (await staffLoginRes.json()).token;

    // Log in Super Admin
    const adminLoginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "superadmin@mediblix.local",
        password: "MasterAdminPassword2026!",
      }),
    });
    assert(adminLoginRes.status === 200, "Super Admin login succeeds with 200");
    const adminToken = (await adminLoginRes.json()).token;

    // ------------------------------------------------------------------
    // TEST GROUP 1: Admin Authorization & Access Control
    // ------------------------------------------------------------------
    console.log("\n[Group 1: Admin Access Control]");
    const unauthStats = await fetch(`${baseUrl}/api/admin/stats`);
    assert(unauthStats.status === 401, "GET /api/admin/stats without token returns 401");

    const staffStats = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(staffStats.status === 403, "Staff user denied admin access with 403");

    const adminStatsRes = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(adminStatsRes.status === 200, "Super Admin granted access with 200");
    const initialStats = await adminStatsRes.json();
    assert(initialStats.totalOrgs >= 1, "Stats reports total organizations >= 1");
    assert(initialStats.activeOrgs >= 1, "Stats reports active organizations >= 1");
    assert(typeof initialStats.totalRevenue === "number", "Revenue is reported as a number");

    // ------------------------------------------------------------------
    // TEST GROUP 2: Organization Creation & Provisioning
    // ------------------------------------------------------------------
    console.log("\n[Group 2: Organization Management]");
    const createOrgRes = await fetch(`${baseUrl}/api/admin/organizations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: "Sunrise Wellness Pharmacy",
        code: "SUN01",
        contactPerson: "Dr. Alok Verma",
        contactEmail: "alok@sunrisepharmacy.com",
        contactPhone: "9871122334",
        address: "Sector 14, Gurgaon, Haryana",
        plan: "Monthly",
        durationDays: 45,
        billingAmount: 4999,
      }),
    });
    assert(createOrgRes.status === 201, "POST /api/admin/organizations creates organization with 201");
    const createdOrgData = await createOrgRes.json();
    assert(createdOrgData.organization._id && createdOrgData.organization._id.length === 24, "Organization has 24-char ObjectId");
    assert(createdOrgData.organization.code === "SUN01", "Organization code is SUN01");
    assert(createdOrgData.organization.status === "Active", "Organization is Active");
    assert(createdOrgData.credentials && createdOrgData.credentials.password, "Initial admin credentials provided");

    const orgId = createdOrgData.organization._id;

    // Duplicate organization email rejected
    const dupOrgRes = await fetch(`${baseUrl}/api/admin/organizations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: "Another Sunrise",
        code: "SUN02",
        contactPerson: "Dr. Alok Verma",
        contactEmail: "alok@sunrisepharmacy.com",
      }),
    });
    assert(dupOrgRes.status === 400, "Duplicate organization email rejected with 400");

    // ------------------------------------------------------------------
    // TEST GROUP 3: Organization Listing, Search & Filters
    // ------------------------------------------------------------------
    console.log("\n[Group 3: Organization Queries & Summaries]");
    const listOrgsRes = await fetch(`${baseUrl}/api/admin/organizations`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(listOrgsRes.status === 200, "GET /api/admin/organizations returns 200");
    const orgsList = await listOrgsRes.json();
    assert(orgsList.some((o) => o._id === orgId), "Created organization appears in listing");

    const foundOrg = orgsList.find((o) => o._id === orgId);
    assert(foundOrg.daysRemaining > 40, "Calculated daysRemaining correctly reflects 45-day trial");
    assert(typeof foundOrg.productCount === "number", "Includes productCount summary");
    assert(typeof foundOrg.revenue === "number", "Includes revenue summary");

    // Search organization
    const searchOrgRes = await fetch(`${baseUrl}/api/admin/organizations?search=Sunrise`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(searchOrgRes.status === 200, "GET /api/admin/organizations?search returns 200");
    const searchData = await searchOrgRes.json();
    assert(searchData.some((o) => o.code === "SUN01"), "Organization found via search");

    // Get organization by ID
    const getOrgByIdRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(getOrgByIdRes.status === 200, "GET /api/admin/organizations/:id returns 200");
    const orgDetail = await getOrgByIdRes.json();
    assert(orgDetail.organization._id === orgId, "Organization ID matches");
    assert(Array.isArray(orgDetail.users), "Users array included");
    assert(orgDetail.users[0].password === undefined, "User passwords strictly omitted from response");
    assert(orgDetail.stats && typeof orgDetail.stats.productCount === "number", "Detailed stats included");

    // Update organization via PUT
    const updateOrgRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        contactPhone: "9870000000",
        address: "Updated Hub Address, Gurgaon",
      }),
    });
    assert(updateOrgRes.status === 200, "PUT /api/admin/organizations/:id updates details");
    const updatedOrg = await updateOrgRes.json();
    assert(updatedOrg.contactPhone === "9870000000", "Updated phone verified");

    // ------------------------------------------------------------------
    // TEST GROUP 4: Subscription & Status Management
    // ------------------------------------------------------------------
    console.log("\n[Group 4: Subscription & Status Transitions]");
    // Extend subscription by 30 days
    const subRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}/subscription`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        plan: "Annual",
        daysToAdd: 30,
        billingAmount: 39999,
      }),
    });
    assert(subRes.status === 200, "PATCH /api/admin/organizations/:id/subscription returns 200");
    const subData = await subRes.json();
    assert(subData.organization.plan === "Annual", "Plan updated to Annual");
    assert(subData.organization.daysRemaining > 70, "Subscription extended by 30 days (total > 70)");

    // Toggle organization status to Frozen
    const freezeRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ status: "Frozen" }),
    });
    assert(freezeRes.status === 200, "PATCH /api/admin/organizations/:id/status freezes org");
    const freezeData = await freezeRes.json();
    assert(freezeData.organization.status === "Frozen", "Status confirmed as Frozen");

    // Verify staff login is now blocked because organization is Frozen
    const orgAdminUser = userRepository.findByEmail("alok@sunrisepharmacy.com");
    assert(orgAdminUser, "Org admin user exists");
    const frozenLoginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alok@sunrisepharmacy.com",
        password: createdOrgData.credentials.password,
      }),
    });
    assert(frozenLoginRes.status === 403, "Login blocked with 403 because organization is Frozen");

    // Unfreeze organization
    await fetch(`${baseUrl}/api/admin/organizations/${orgId}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ status: "Active" }),
    });

    // ------------------------------------------------------------------
    // TEST GROUP 5: Device Session & Password Resets
    // ------------------------------------------------------------------
    console.log("\n[Group 5: Session & Password Resets]");
    // Log in org admin to establish an active session
    const orgAdminLoginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alok@sunrisepharmacy.com",
        password: createdOrgData.credentials.password,
      }),
    });
    assert(orgAdminLoginRes.status === 200, "Org admin logs in successfully once Active");
    const orgAdminToken = (await orgAdminLoginRes.json()).token;

    // Reset device session via Super Admin
    const resetSessionRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}/reset-device-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(resetSessionRes.status === 200, "Device session reset succeeds with 200");

    // Previous token should now be rejected due to sessionVersion increment
    const checkRevokedRes = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${orgAdminToken}` },
    });
    assert(checkRevokedRes.status === 401, "Previous session token rejected with 401 after reset");

    // Reset password via Super Admin
    const resetPwdRes = await fetch(`${baseUrl}/api/admin/organizations/${orgId}/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ newPassword: "SuperSecureNewPin2026!" }),
    });
    assert(resetPwdRes.status === 200, "Admin password reset returns 200");
    const resetPwdData = await resetPwdRes.json();
    assert(resetPwdData.credentials.password === "SuperSecureNewPin2026!", "New password confirmed");
    assert(resetPwdData.passwordHistory.length >= 1, "Previous password recorded in password history");

    // Log in with new password
    const newPwdLoginRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alok@sunrisepharmacy.com",
        password: "SuperSecureNewPin2026!",
      }),
    });
    assert(newPwdLoginRes.status === 200, "Login with new password succeeds with 200");

    // ------------------------------------------------------------------
    // TEST GROUP 6: MedAgent AI Assistant SQLite Integration
    // ------------------------------------------------------------------
    console.log("\n[Group 6: MedAgent AI Inventory Scoping]");
    // Create inventory products in Sunrise Pharmacy
    productRepository.create({
      organization: orgId,
      name: "Montelukast 10mg",
      sku: "MED-MONT10",
      category: "Respiratory",
      price: 180.0,
      quantity: 50,
    });

    productRepository.create({
      organization: orgId,
      name: "Levocetirizine 5mg",
      sku: "MED-LEVO5",
      category: "Respiratory",
      price: 65.0,
      quantity: 80,
    });

    // Login token for Sunrise Pharmacy org admin
    const sunriseToken = (await newPwdLoginRes.json()).token;

    // Get categories for Sunrise Pharmacy
    const catRes = await fetch(`${baseUrl}/api/medagent/categories`, {
      headers: { Authorization: `Bearer ${sunriseToken}` },
    });
    assert(catRes.status === 200, "GET /api/medagent/categories returns 200");
    const catData = await catRes.json();
    assert(catData.categories.includes("Respiratory"), "Category 'Respiratory' returned");

    // Get alternatives from Sunrise Pharmacy
    const altRes = await fetch(`${baseUrl}/api/medagent/alternatives`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sunriseToken}`,
      },
      body: JSON.stringify({
        medicineName: "Montelukast",
        category: "Respiratory",
      }),
    });
    assert(altRes.status === 200, "POST /api/medagent/alternatives returns 200");
    const altData = await altRes.json();
    assert(altData.alternatives.some((a) => a.name === "Levocetirizine 5mg"), "Alternative Levocetirizine found in inventory");

    // Tenant isolation: Default Org staff does not see Sunrise Pharmacy's Montelukast in alternatives
    const altTenantRes = await fetch(`${baseUrl}/api/medagent/alternatives`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        medicineName: "NonExistentMed",
        category: "Respiratory",
      }),
    });
    const altTenantData = await altTenantRes.json();
    assert(!altTenantData.alternatives.some((a) => a.name === "Montelukast 10mg"), "Tenant isolation: Staff in Default Org cannot see Sunrise products");

    // ------------------------------------------------------------------
    // TEST GROUP 7: AI Parsing Route Protection & Input Validation
    // ------------------------------------------------------------------
    console.log("\n[Group 7: AI Parsing Validation & Security]");
    const aiNoToken = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(aiNoToken.status === 401, "POST /api/ai/parse-invoice without token rejected with 401");

    const aiInvalidInput = await fetch(`${baseUrl}/api/ai/parse-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({}),
    });
    assert(aiInvalidInput.status === 400, "POST /api/ai/parse-invoice with empty body returns 400");

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
