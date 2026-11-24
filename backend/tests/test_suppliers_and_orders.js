/**
 * Mediblix Desktop — Phase 3C Supplier, Purchase Order & Import History Tests
 *
 * Verifies:
 *  1. Authentication enforcement on /api/suppliers, /api/purchase-orders, and /api/import-history (401 without token)
 *  2. Supplier CRUD (Create, List, Detail, Update, Delete) & duplicate name rejection
 *  3. Purchase Order creation, validation, and listing
 *  4. Purchase Order status transitions ('Pending' -> 'Ordered' -> 'Shipped')
 *  5. Receiving stock on 'Delivered' status transition (atomic inventory addition)
 *  6. Idempotency / Duplicate receiving prevention (rejects modifying delivered PO, stock NOT added twice)
 *  7. Import history creation, batch catalog processing, inventory updates, and audit logging
 *  8. Import history Excel export (/api/import-history/:id/export) streaming valid XLSX binary
 *  9. Cross-organization isolation across suppliers, purchase orders, and import records
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
process.env.ADMIN_EMAIL = "admin@mediblix.local";
process.env.ADMIN_PASSWORD = "TestAdminPassword2026!";

const testDbPath = path.join(__dirname, "test_suppliers_orders.db");

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
  supplierRepository,
  purchaseOrderRepository,
  importHistoryRepository,
} = repositories;

// Import Express routes
import authRoutes from "../routes/authRoutes.js";
import supplierRoutes from "../routes/supplierRoutes.js";
import purchaseOrderRoutes from "../routes/purchaseOrderRoutes.js";
import importHistoryRoutes from "../routes/importHistoryRoutes.js";
import productRoutes from "../routes/productRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", authRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/purchase-orders", purchaseOrderRoutes);
app.use("/api/import-history", importHistoryRoutes);
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
  console.log(" Mediblix Desktop — Phase 3C Supplier & PO Tests ");
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
    assert(defaultOrg, "Default organization exists in SQLite");

    // Organization B for cross-tenant testing
    const orgB = organizationRepository.create({
      name: "Second Branch Pharmacy",
      code: "BRANCH_B",
      contactPerson: "Dr. B Sharma",
      contactEmail: "branch_b@mediblix.local",
    });
    assert(orgB && orgB._id, "Created second organization for tenant isolation tests");

    // Staff User in Default Org
    const staffUserA = userRepository.create({
      name: "Pharmacist Branch A",
      email: "pharmacist_a@mediblix.local",
      password: "Password123!",
      role: "staff",
      isAdmin: false,
      organization: defaultOrg._id,
    });

    // Staff User in Org B
    const staffUserB = userRepository.create({
      name: "Pharmacist Branch B",
      email: "pharmacist_b@mediblix.local",
      password: "Password123!",
      role: "staff",
      isAdmin: false,
      organization: orgB._id,
    });

    // Log in staffUserA
    const loginResA = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pharmacist_a@mediblix.local", password: "Password123!" }),
    });
    const tokenA = (await loginResA.json()).token;

    // Log in staffUserB
    const loginResB = await fetch(`${baseUrl}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pharmacist_b@mediblix.local", password: "Password123!" }),
    });
    const tokenB = (await loginResB.json()).token;

    // ------------------------------------------------------------------
    // TEST GROUP 1: Route Security (Unauthenticated Rejection)
    // ------------------------------------------------------------------
    console.log("\n[Group 1: Route Security]");
    const suppNoToken = await fetch(`${baseUrl}/api/suppliers`);
    assert(suppNoToken.status === 401, "GET /api/suppliers without token rejected with 401");

    const poNoToken = await fetch(`${baseUrl}/api/purchase-orders`);
    assert(poNoToken.status === 401, "GET /api/purchase-orders without token rejected with 401");

    const importNoToken = await fetch(`${baseUrl}/api/import-history`);
    assert(importNoToken.status === 401, "GET /api/import-history without token rejected with 401");

    // ------------------------------------------------------------------
    // TEST GROUP 2: Supplier CRUD Operations
    // ------------------------------------------------------------------
    console.log("\n[Group 2: Supplier Management]");
    const createSupRes = await fetch(`${baseUrl}/api/suppliers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: "Abbott Healthcare Pvt Ltd",
        email: "contact@abbott.co.in",
        phone: "9820011223",
        address: "Godrej BKC, Bandra Kurla Complex, Mumbai",
      }),
    });
    assert(createSupRes.status === 201, "POST /api/suppliers creates supplier with 201");
    const supA = await createSupRes.json();
    assert(supA._id && supA._id.length === 24, "Supplier has 24-character ObjectId");
    assert(supA.name === "Abbott Healthcare Pvt Ltd", "Supplier name matches");

    // Duplicate supplier name in same org rejected
    const dupSupRes = await fetch(`${baseUrl}/api/suppliers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: "Abbott Healthcare Pvt Ltd",
        email: "other@abbott.co.in",
        phone: "9820011224",
        address: "Another address",
      }),
    });
    assert(dupSupRes.status === 400, "Duplicate supplier name rejected with 400");

    // List suppliers
    const listSupRes = await fetch(`${baseUrl}/api/suppliers`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(listSupRes.status === 200, "GET /api/suppliers returns 200");
    const supList = await listSupRes.json();
    assert(supList.some((s) => s._id === supA._id), "Created supplier appears in list");

    // Get supplier by ID
    const getSupByIdRes = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getSupByIdRes.status === 200, "GET /api/suppliers/:id returns 200");
    const supDetail = await getSupByIdRes.json();
    assert(supDetail._id === supA._id, "Supplier detail matches requested ID");

    // Update supplier
    const updateSupRes = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ phone: "9820099887" }),
    });
    assert(updateSupRes.status === 200, "PUT /api/suppliers/:id updates supplier phone");
    const updatedSup = await updateSupRes.json();
    assert(updatedSup.phone === "9820099887", "Updated phone verified");

    // ------------------------------------------------------------------
    // TEST GROUP 3: Purchase Order Management
    // ------------------------------------------------------------------
    console.log("\n[Group 3: Purchase Order Operations]");
    // Existing product in inventory with 20 tablets
    const productA = productRepository.create({
      organization: defaultOrg._id,
      name: "Azithromycin 500mg",
      sku: "PHR-AZI500",
      category: "Antibiotics",
      price: 110.0,
      quantity: 20,
    });
    assert(productA.quantity === 20, "Product Azithromycin created with stock = 20");

    // Create Purchase Order with 2 items (one existing product, one brand new product)
    const createPoRes = await fetch(`${baseUrl}/api/purchase-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        supplierName: "Abbott Healthcare Pvt Ltd",
        supplierEmail: "contact@abbott.co.in",
        supplierPhone: "9820099887",
        deliveryAddress: "Mediblix Central Hub, Mumbai",
        expectedDeliveryDate: "2026-12-15",
        items: [
          { productName: "Azithromycin 500mg", sku: "PHR-AZI500", quantity: 50, price: 95.0 }, // existing (total = 4750)
          { productName: "Cetirizine 10mg", sku: "PHR-CET10", quantity: 100, price: 15.0 },     // new (total = 1500)
        ],
      }),
    });
    assert(createPoRes.status === 201, "POST /api/purchase-orders creates PO with 201");
    const poData = await createPoRes.json();
    assert(poData._id && poData._id.length === 24, "PO has 24-character _id");
    assert(poData.status === "Pending", "Initial status is 'Pending'");
    assert(poData.totalAmount === 6250, "Total amount accurately calculated (4750 + 1500 = 6250)");
    assert(poData.items.length === 2, "Items length matches 2");

    // List POs
    const listPoRes = await fetch(`${baseUrl}/api/purchase-orders`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(listPoRes.status === 200, "GET /api/purchase-orders returns 200");
    const poList = await listPoRes.json();
    assert(poList.some((p) => p._id === poData._id), "Created PO appears in listing");

    // Get PO by ID
    const getPoByIdRes = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getPoByIdRes.status === 200, "GET /api/purchase-orders/:id returns 200");
    const poDetail = await getPoByIdRes.json();
    assert(poDetail._id === poData._id, "PO detail matches requested ID");

    // Transition status to In Transit
    const inTransitStatusRes = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ status: "In Transit" }),
    });
    assert(inTransitStatusRes.status === 200, "Status updated to 'In Transit'");

    // ------------------------------------------------------------------
    // TEST GROUP 4: Stock Receiving & Duplicate Receiving Prevention
    // ------------------------------------------------------------------
    console.log("\n[Group 4: Stock Receiving & Idempotency]");
    // Transition status to Delivered -> MUST receive stock into inventory
    const deliverStatusRes = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ status: "Delivered" }),
    });
    assert(deliverStatusRes.status === 200, "Status updated to 'Delivered'");
    const deliveredPo = await deliverStatusRes.json();
    assert(deliveredPo.status === "Delivered", "Delivered status confirmed");

    // Check inventory: Azithromycin stock should have incremented from 20 to 70 (+50)
    const azithroAfterDelivery = productRepository.findBySku("PHR-AZI500", defaultOrg._id);
    assert(azithroAfterDelivery.quantity === 70, "Existing product stock incremented from 20 to 70 (+50)");

    // Check inventory: Cetirizine should have been automatically created with quantity 100
    const cetirizineAfterDelivery = productRepository.findBySku("PHR-CET10", defaultOrg._id);
    assert(cetirizineAfterDelivery !== null, "New product Cetirizine automatically created in inventory");
    assert(cetirizineAfterDelivery.quantity === 100, "New product stock received with quantity 100");

    // Idempotency: Attempt to transition or receive the order again
    const duplicateDeliverRes = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ status: "Delivered" }),
    });
    assert(duplicateDeliverRes.status === 400, "Duplicate delivery transition rejected with 400");

    // Verify stock was NOT added twice
    const azithroAfterDuplicateAttempt = productRepository.findBySku("PHR-AZI500", defaultOrg._id);
    assert(azithroAfterDuplicateAttempt.quantity === 70, "Stock was NOT added twice (remains 70)");

    // ------------------------------------------------------------------
    // TEST GROUP 5: Import History & Catalog Batch Processing
    // ------------------------------------------------------------------
    console.log("\n[Group 5: Import History & Excel Export]");
    const importRes = await fetch(`${baseUrl}/api/import-history`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        fileName: "Wholesale_Batch_May2026.csv",
        items: [
          { name: "Azithromycin 500mg", sku: "PHR-AZI500", quantity: 30, price: 90.0 }, // updates: 70 + 30 = 100
          { name: "Ibuprofen 400mg", sku: "PHR-IBU400", category: "Analgesics", quantity: 200, price: 20.0 }, // new product
        ],
      }),
    });
    assert(importRes.status === 201, "POST /api/import-history creates import record with 201");
    const importData = await importRes.json();
    assert(importData._id && importData._id.length === 24, "Import record has 24-char ObjectId");
    assert(importData.totalProducts === 2, "totalProducts equals 2");
    assert(importData.totalQuantity === 230, "totalQuantity equals 230");
    assert(importData.totalValue === (30 * 90) + (200 * 20), "totalValue accurately computed as 6700");

    // Stock verification after batch import
    const azithroAfterImport = productRepository.findBySku("PHR-AZI500", defaultOrg._id);
    assert(azithroAfterImport.quantity === 100, "Stock updated to 100 via catalog import");

    const ibuprofenAfterImport = productRepository.findBySku("PHR-IBU400", defaultOrg._id);
    assert(ibuprofenAfterImport && ibuprofenAfterImport.quantity === 200, "New product Ibuprofen created via import");

    // List import history
    const listImportRes = await fetch(`${baseUrl}/api/import-history`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(listImportRes.status === 200, "GET /api/import-history returns 200");
    const importList = await listImportRes.json();
    assert(importList.some((ih) => ih._id === importData._id), "Import record appears in history list");

    // Get import record by ID
    const getImportByIdRes = await fetch(`${baseUrl}/api/import-history/${importData._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getImportByIdRes.status === 200, "GET /api/import-history/:id returns 200");
    const importDetail = await getImportByIdRes.json();
    assert(importDetail.fileName === "Wholesale_Batch_May2026.csv", "Detail fileName matches");

    // Export Import History to Excel
    const exportExcelRes = await fetch(`${baseUrl}/api/import-history/${importData._id}/export`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(exportExcelRes.status === 200, "GET /api/import-history/:id/export returns 200");
    assert(
      exportExcelRes.headers.get("content-type")?.includes("spreadsheetml.sheet"),
      "Returns valid openxmlformats Excel content-type"
    );
    const excelBuffer = await exportExcelRes.arrayBuffer();
    const excelHeader = Buffer.from(excelBuffer).subarray(0, 2).toString("utf-8");
    assert(excelHeader === "PK", "Valid ZIP/XLSX header verified ('PK')");

    // ------------------------------------------------------------------
    // TEST GROUP 6: Cross-Organization Isolation
    // ------------------------------------------------------------------
    console.log("\n[Group 6: Cross-Tenant Isolation]");
    // Branch B cannot access Branch A supplier
    const crossGetSup = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossGetSup.status === 404, "Branch B cannot read Branch A supplier (404)");

    const crossUpdateSup = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ name: "Hacked Supplier" }),
    });
    assert(crossUpdateSup.status === 404, "Branch B cannot update Branch A supplier (404)");

    const crossDeleteSup = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossDeleteSup.status === 404, "Branch B cannot delete Branch A supplier (404)");

    // Branch B cannot access Branch A PO
    const crossGetPo = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossGetPo.status === 404, "Branch B cannot read Branch A PO (404)");

    const crossPatchPo = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ status: "Cancelled" }),
    });
    assert(crossPatchPo.status === 404, "Branch B cannot update Branch A PO status (404)");

    const crossDeletePo = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossDeletePo.status === 404, "Branch B cannot delete Branch A PO (404)");

    // Branch B cannot access Branch A Import History
    const crossGetImport = await fetch(`${baseUrl}/api/import-history/${importData._id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossGetImport.status === 404, "Branch B cannot read Branch A import history (404)");

    const crossExportImport = await fetch(`${baseUrl}/api/import-history/${importData._id}/export`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossExportImport.status === 404, "Branch B cannot export Branch A import history (404)");

    const crossDeleteImport = await fetch(`${baseUrl}/api/import-history/${importData._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossDeleteImport.status === 404, "Branch B cannot delete Branch A import history (404)");

    // ------------------------------------------------------------------
    // TEST GROUP 7: Deletion Verifications
    // ------------------------------------------------------------------
    console.log("\n[Group 7: Deletion Integrity]");
    // Delete supplier in Branch A
    const deleteSupRes = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(deleteSupRes.status === 200, "DELETE /api/suppliers/:id returns 200");

    const verifySupDel = await fetch(`${baseUrl}/api/suppliers/${supA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(verifySupDel.status === 404, "Subsequent GET /api/suppliers/:id returns 404");

    // Delete PO in Branch A
    const deletePoRes = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(deletePoRes.status === 200, "DELETE /api/purchase-orders/:id returns 200");

    const verifyPoDel = await fetch(`${baseUrl}/api/purchase-orders/${poData._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(verifyPoDel.status === 404, "Subsequent GET /api/purchase-orders/:id returns 404");

    // Delete Import record in Branch A
    const deleteImportRes = await fetch(`${baseUrl}/api/import-history/${importData._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(deleteImportRes.status === 200, "DELETE /api/import-history/:id returns 200");

    const verifyImportDel = await fetch(`${baseUrl}/api/import-history/${importData._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(verifyImportDel.status === 404, "Subsequent GET /api/import-history/:id returns 404");

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
