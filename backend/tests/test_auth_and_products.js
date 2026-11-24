/**
 * Mediblix Desktop — Phase 3A SQLite Integration Test Suite
 *
 * Verifies:
 *  1. Staff authentication against SQLite (valid/invalid credentials, password hash protection)
 *  2. Super Admin authentication (/api/admin/login) against SQLite
 *  3. Non-admin access rejection on admin login
 *  4. JWT generation and authMiddleware verification (/api/users/me)
 *  5. Protection on /api/products against unauthenticated requests
 *  6. Product CRUD operations in SQLite (Create, Read, Search, Update, Delete)
 *  7. SKU uniqueness enforcement per organization
 *  8. Automatic stock status recomputation on update (In Stock -> Low Stock -> Out of Stock)
 *  9. Automatic import history record creation on manual product entry
 * 10. User logout and session clearing in SQLite
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

// Test environment setup
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mediblix_desktop_test_jwt_secret_2026";
process.env.ADMIN_EMAIL = "admin@mediblix.local";
process.env.ADMIN_PASSWORD = "TestAdminPassword2026!";

const testDbPath = path.join(__dirname, "test_auth_products.db");

// Cleanup leftover test DB if exists
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

// Initialize isolated SQLite DB
const { initDatabase, closeDatabase } = require("../../database/db.js");
initDatabase(testDbPath);

const repositories = require("../../database/repositories/index.js");
const { userRepository, organizationRepository, productRepository, importHistoryRepository } = repositories;

// Import Express routes
import authRoutes from "../routes/authRoutes.js";
import adminRoutes from "../routes/adminRoutes.js";
import productRoutes from "../routes/productRoutes.js";

// Build lightweight Express test application
const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/products", productRoutes);

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
  console.log(" Mediblix Desktop — Phase 3A API Integration Tests");
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

    // 2. Setup Baseline Data
    const defaultOrg = organizationRepository.findByCode("DEFAULT");
    assert(defaultOrg && defaultOrg.name, "Default organization exists in SQLite");

    const staffUser = userRepository.create({
      name: "Adarsh Pharmacist",
      email: "pharmacist@mediblix.local",
      password: "PharmacistPassword123!",
      role: "staff",
      isAdmin: false,
      organization: defaultOrg._id,
    });
    assert(staffUser && staffUser._id, "Created staff user in SQLite");

    // ------------------------------------------------------------------
    // TEST 1: Staff login with invalid password returns 401
    // ------------------------------------------------------------------
    console.log("\n[Group 1: Authentication]");
    const loginFailRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "pharmacist@mediblix.local",
        password: "WrongPassword!",
      }),
    });
    assert(loginFailRes.status === 401, "Staff login with wrong password returns 401");

    // ------------------------------------------------------------------
    // TEST 2: Staff login with valid password returns 200 + JWT + safe user
    // ------------------------------------------------------------------
    const loginSuccessRes = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      },
      body: JSON.stringify({
        email: "pharmacist@mediblix.local",
        password: "PharmacistPassword123!",
      }),
    });
    assert(loginSuccessRes.status === 200, "Staff login with correct password returns 200");
    const loginData = await loginSuccessRes.json();
    assert(typeof loginData.token === "string" && loginData.token.length > 20, "Returns valid JWT token");
    assert(typeof loginData.sessionKey === "string", "Returns session key");
    assert(loginData.password === undefined, "Password hash is strictly omitted from login response");
    assert(loginData.role === "staff", "Role is correctly reported as 'staff'");
    assert(loginData.organization && loginData.organization.code === "DEFAULT", "Organization attached to response");

    const staffToken = loginData.token;

    // ------------------------------------------------------------------
    // TEST 3: Super Admin login via /api/admin/login
    // ------------------------------------------------------------------
    const adminLoginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@mediblix.local",
        password: "TestAdminPassword2026!",
      }),
    });
    assert(adminLoginRes.status === 200, "Super Admin login returns 200");
    const adminData = await adminLoginRes.json();
    assert(adminData.role === "superadmin" && adminData.isAdmin === true, "Admin credentials grant superadmin role");
    assert(adminData.password === undefined, "Password hash is strictly omitted from admin login response");
    const adminToken = adminData.token;

    // ------------------------------------------------------------------
    // TEST 4: Non-admin user blocked from /api/admin/login
    // ------------------------------------------------------------------
    const staffAsAdminRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "pharmacist@mediblix.local",
        password: "PharmacistPassword123!",
      }),
    });
    assert(staffAsAdminRes.status === 403, "Staff user blocked from admin login with 403");

    // ------------------------------------------------------------------
    // TEST 5: GET /api/users/me with Bearer token
    // ------------------------------------------------------------------
    console.log("\n[Group 2: Session & Profile Management]");
    const meRes = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(meRes.status === 200, "GET /api/users/me with Bearer token returns 200");
    const meData = await meRes.json();
    assert(meData.email === "pharmacist@mediblix.local", "Profile returns matching email");
    assert(meData.password === undefined, "Profile strictly strips password hash");

    // ------------------------------------------------------------------
    // TEST 6: Protected routes reject requests without token
    // ------------------------------------------------------------------
    const meNoTokenRes = await fetch(`${baseUrl}/api/users/me`);
    assert(meNoTokenRes.status === 401, "GET /api/users/me without token rejected with 401");

    const productsNoTokenRes = await fetch(`${baseUrl}/api/products`);
    assert(productsNoTokenRes.status === 401, "GET /api/products without token rejected with 401 (Route Security)");

    // ------------------------------------------------------------------
    // TEST 7: Create Product via POST /api/products
    // ------------------------------------------------------------------
    console.log("\n[Group 3: Product Operations (CRUD)]");
    const createProductRes = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        name: "Amoxicillin 500mg Capsules",
        sku: "PHR-AMOX500",
        category: "Antibiotics",
        price: 85.5,
        quantity: 120,
        expiryDate: "2027-12-31",
        mfgDate: "2025-01-01",
        hsn: "3004",
        packaging: "10 Capsules / Strip",
        tabletsPerStrip: 10,
      }),
    });
    assert(createProductRes.status === 201, "POST /api/products creates product with 201");
    const createdProduct = await createProductRes.json();
    assert(createdProduct._id && createdProduct._id.length === 24, "Product has 24-character hexadecimal _id");
    assert(createdProduct.name === "Amoxicillin 500mg Capsules", "Product name matches");
    assert(createdProduct.sku === "PHR-AMOX500", "Product SKU matches");
    assert(createdProduct.status === "In Stock", "Stock status computed as 'In Stock' for qty 120");
    assert(createdProduct.quantity === 120, "Quantity stored correctly");
    assert(createdProduct.price === 85.5, "Price stored correctly");

    const productId = createdProduct._id;

    // ------------------------------------------------------------------
    // TEST 8: Verify automatic import_history creation on product add
    // ------------------------------------------------------------------
    const importHistories = importHistoryRepository.findAll(defaultOrg._id);
    assert(importHistories.length >= 1, "Import history record automatically created");
    assert(importHistories[0].fileName === "Manual Entry", "Import history recorded as 'Manual Entry'");

    // ------------------------------------------------------------------
    // TEST 9: Duplicate SKU within same organization is rejected
    // ------------------------------------------------------------------
    const duplicateSkuRes = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        name: "Amoxicillin Copy",
        sku: "PHR-AMOX500",
        price: 50,
        quantity: 10,
      }),
    });
    assert(duplicateSkuRes.status === 400, "Duplicate SKU within same organization rejected with 400");

    // ------------------------------------------------------------------
    // TEST 10: GET /api/products returns list including created product
    // ------------------------------------------------------------------
    const listProductsRes = await fetch(`${baseUrl}/api/products`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(listProductsRes.status === 200, "GET /api/products returns 200");
    const productList = await listProductsRes.json();
    assert(Array.isArray(productList) && productList.length >= 1, "Returns product array");
    const foundInList = productList.find((p) => p.sku === "PHR-AMOX500");
    assert(foundInList !== undefined, "Created product appears in organization listing");

    // ------------------------------------------------------------------
    // TEST 11: GET /api/products/search?q=Amox
    // ------------------------------------------------------------------
    const searchRes = await fetch(`${baseUrl}/api/products/search?q=Amox`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(searchRes.status === 200, "GET /api/products/search returns 200");
    const searchResults = await searchRes.json();
    assert(searchResults.some((p) => p.sku === "PHR-AMOX500"), "Product found via partial name search");

    // ------------------------------------------------------------------
    // TEST 12: GET /api/products/:id returns detail
    // ------------------------------------------------------------------
    const detailRes = await fetch(`${baseUrl}/api/products/${productId}`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(detailRes.status === 200, "GET /api/products/:id returns 200");
    const detailData = await detailRes.json();
    assert(detailData._id === productId, "Detail ID matches requested ID");

    // ------------------------------------------------------------------
    // TEST 13: PUT /api/products/:id updates price, quantity and recalculates status
    // ------------------------------------------------------------------
    const updateRes = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        price: 92.0,
        quantity: 5, // Triggers 'Low Stock' (<= 10)
      }),
    });
    assert(updateRes.status === 200, "PUT /api/products/:id returns 200");
    const updatedData = await updateRes.json();
    assert(updatedData.price === 92.0, "Updated price reflected");
    assert(updatedData.quantity === 5, "Updated quantity reflected");
    assert(updatedData.status === "Low Stock", "Status dynamically updated to 'Low Stock'");

    // Update to 0 quantity -> Out of Stock
    const updateZeroRes = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        quantity: 0,
      }),
    });
    const zeroStockData = await updateZeroRes.json();
    assert(zeroStockData.status === "Out of Stock", "Status dynamically updated to 'Out of Stock' for qty 0");

    // ------------------------------------------------------------------
    // TEST 14: DELETE /api/products/:id removes product
    // ------------------------------------------------------------------
    const deleteRes = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(deleteRes.status === 200, "DELETE /api/products/:id returns 200");

    const verifyDeleteRes = await fetch(`${baseUrl}/api/products/${productId}`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(verifyDeleteRes.status === 404, "Subsequent GET /api/products/:id returns 404 Not Found");

    // ------------------------------------------------------------------
    // TEST 15: User Logout terminates session cleanly
    // ------------------------------------------------------------------
    console.log("\n[Group 4: Logout & Session Cleanup]");
    const logoutRes = await fetch(`${baseUrl}/api/users/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert(logoutRes.status === 200, "POST /api/users/logout returns 200");
    const userAfterLogout = userRepository.findById(staffUser._id);
    assert(userAfterLogout.activeSessionKey === null, "Active session key cleared from SQLite");

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
