/**
 * Mediblix Desktop — Phase 3B Customer & Sales Integration Test Suite
 *
 * Verifies:
 *  1. Authentication enforcement on /api/customers and /api/sales (401 without token)
 *  2. Customer CRUD (Create, Read, Search, Detail, Update, Delete)
 *  3. Duplicate mobile handling (upsert behavior)
 *  4. Customer detail population with purchaseHistory
 *  5. POS Checkout with atomic stock deduction
 *  6. Insufficient stock rejection & atomic rollback
 *  7. Multi-item checkout rollback when second item fails
 *  8. Invoice number sequencing and duplicate invoice rejection
 *  9. Tax Invoice PDF generation (/api/sales/:id/invoice)
 * 10. Return processing with inventory restocking & max-return limit
 * 11. Cross-organization isolation:
 *     - Cannot view/edit/delete customer from another org
 *     - Cannot purchase products from another org
 *     - Cannot view or process returns on sales from another org
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

const testDbPath = path.join(__dirname, "test_customers_sales.db");

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
  customerRepository,
  saleRepository,
} = repositories;

// Import Express routes
import authRoutes from "../routes/authRoutes.js";
import customerRoutes from "../routes/customerRoutes.js";
import saleRoutes from "../routes/saleRoutes.js";
import productRoutes from "../routes/productRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/users", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/sales", saleRoutes);
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
  console.log(" Mediblix Desktop — Phase 3B Customer & Sales Tests");
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
    const custNoToken = await fetch(`${baseUrl}/api/customers`);
    assert(custNoToken.status === 401, "GET /api/customers without token rejected with 401");

    const salesNoToken = await fetch(`${baseUrl}/api/sales`);
    assert(salesNoToken.status === 401, "GET /api/sales without token rejected with 401");

    const saleCreateNoToken = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    assert(saleCreateNoToken.status === 401, "POST /api/sales without token rejected with 401");

    // ------------------------------------------------------------------
    // TEST GROUP 2: Customer CRUD & Search
    // ------------------------------------------------------------------
    console.log("\n[Group 2: Customer Management]");
    // Create customer in Branch A
    const createCustRes = await fetch(`${baseUrl}/api/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: "Rahul Verma",
        mobile: "9811122233",
        email: "rahul.verma@example.com",
        address: "Flat 402, Green Avenue, Delhi",
        notes: "Regular blood pressure medicine",
      }),
    });
    assert(createCustRes.status === 201, "POST /api/customers creates customer with 201");
    const custA = await createCustRes.json();
    assert(custA._id && custA._id.length === 24, "Customer has 24-char ObjectId");
    assert(custA.name === "Rahul Verma", "Customer name matches");
    assert(custA.mobile === "9811122233", "Customer mobile matches");
    assert(Array.isArray(custA.purchaseHistory), "purchaseHistory array initialized");

    // Duplicate mobile in Branch A should update existing customer (upsert behavior)
    const upsertCustRes = await fetch(`${baseUrl}/api/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: "Rahul V. Sharma",
        mobile: "9811122233",
        email: "rahul.updated@example.com",
      }),
    });
    assert(upsertCustRes.status === 200, "POST with duplicate mobile returns 200 (upsert)");
    const updatedCust = await upsertCustRes.json();
    assert(updatedCust._id === custA._id, "Updated same customer _id");
    assert(updatedCust.name === "Rahul V. Sharma", "Name successfully updated");
    assert(updatedCust.email === "rahul.updated@example.com", "Email successfully updated");

    // List customers
    const listCustRes = await fetch(`${baseUrl}/api/customers`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(listCustRes.status === 200, "GET /api/customers returns 200");
    const custList = await listCustRes.json();
    assert(custList.some((c) => c._id === custA._id), "Created customer appears in list");

    // Search customers
    const searchCustRes = await fetch(`${baseUrl}/api/customers/search?q=Sharma`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(searchCustRes.status === 200, "GET /api/customers/search returns 200");
    const searchResults = await searchCustRes.json();
    assert(searchResults.some((c) => c._id === custA._id), "Customer found via search");

    // Get customer by ID
    const getCustByIdRes = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getCustByIdRes.status === 200, "GET /api/customers/:id returns 200");
    const custDetail = await getCustByIdRes.json();
    assert(custDetail._id === custA._id, "Customer ID matches");
    assert(Array.isArray(custDetail.purchaseHistory), "purchaseHistory is an array on customer detail");

    // Update customer via PUT
    const putCustRes = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ notes: "Requires monthly reminder for BP drugs" }),
    });
    assert(putCustRes.status === 200, "PUT /api/customers/:id updates notes");
    const putData = await putCustRes.json();
    assert(putData.notes === "Requires monthly reminder for BP drugs", "Notes verified");

    // ------------------------------------------------------------------
    // TEST GROUP 3: Customer Cross-Organization Isolation
    // ------------------------------------------------------------------
    console.log("\n[Group 3: Customer Cross-Tenant Isolation]");
    // Branch B attempts to access Branch A's customer
    const crossGetCust = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossGetCust.status === 404, "Branch B cannot read Branch A customer (404)");

    const crossPutCust = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ name: "Hacked Customer" }),
    });
    assert(crossPutCust.status === 404, "Branch B cannot update Branch A customer (404)");

    const crossDeleteCust = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossDeleteCust.status === 404, "Branch B cannot delete Branch A customer (404)");

    // ------------------------------------------------------------------
    // TEST GROUP 4: POS Checkout & Atomic Stock Deduction
    // ------------------------------------------------------------------
    console.log("\n[Group 4: POS Checkout & Inventory Deduction]");
    // Create inventory products for Branch A
    const productA1 = productRepository.create({
      organization: defaultOrg._id,
      name: "Metformin 500mg",
      sku: "PHR-MET500",
      category: "Antidiabetic",
      price: 40.0,
      quantity: 50,
      packaging: "10 Tablets / Strip",
      tabletsPerStrip: 10,
    });
    assert(productA1.quantity === 50, "Created product with stock = 50");

    const productA2 = productRepository.create({
      organization: defaultOrg._id,
      name: "Telmisartan 40mg",
      sku: "PHR-TEL40",
      category: "Cardiovascular",
      price: 60.0,
      quantity: 30,
      packaging: "10 Tablets / Strip",
      tabletsPerStrip: 10,
    });
    assert(productA2.quantity === 30, "Created second product with stock = 30");

    // Successful POS Checkout
    const checkoutRes = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        customerId: custA._id,
        items: [
          { product: productA1._id, quantity: 10, price: 40.0, discount: 5 }, // 10 * 40 * 0.95 = 380
          { product: productA2._id, quantity: 5, price: 60.0, discount: 0 },   // 5 * 60 = 300 -> Total = 680
        ],
        paymentMethod: "Cash",
      }),
    });
    assert(checkoutRes.status === 201, "POST /api/sales creates sale with 201");
    const saleData = await checkoutRes.json();
    assert(saleData._id && saleData._id.length === 24, "Sale has 24-character _id");
    assert(saleData.invoiceNumber === "Inv-0001", "Auto-generated invoiceNumber is Inv-0001");
    assert(saleData.totalAmount === 680, "Total amount accurately calculated as 680 (including 5% discount)");
    assert(saleData.customer && saleData.customer.name === "Rahul V. Sharma", "Customer populated on sale");
    assert(saleData.items.length === 2, "2 items recorded on sale");

    // Verify atomic inventory reduction
    const updatedProdA1 = productRepository.findById(productA1._id);
    assert(updatedProdA1.quantity === 40, "Metformin stock decremented from 50 to 40");

    const updatedProdA2 = productRepository.findById(productA2._id);
    assert(updatedProdA2.quantity === 25, "Telmisartan stock decremented from 30 to 25");

    // Verify customer total_purchases increased
    const updatedCustomerAfterSale = customerRepository.findById(custA._id);
    assert(updatedCustomerAfterSale.totalPurchases === 680, "Customer totalPurchases updated to 680");

    // Verify sale appears in customer purchase history
    const custDetailAfterSaleRes = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const custDetailAfterSale = await custDetailAfterSaleRes.json();
    assert(custDetailAfterSale.purchaseHistory.length === 1, "Sale appears in customer purchaseHistory");
    assert(custDetailAfterSale.purchaseHistory[0].invoiceNumber === "Inv-0001", "Purchase history has matching invoice");

    // ------------------------------------------------------------------
    // TEST GROUP 5: Insufficient Stock & Atomic Transaction Rollback
    // ------------------------------------------------------------------
    console.log("\n[Group 5: Insufficient Stock & ACID Rollback]");
    // Attempt to buy 100 of productA1 (only 40 available)
    const overbuyRes = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        customerId: custA._id,
        items: [{ product: productA1._id, quantity: 100 }],
        paymentMethod: "Cash",
      }),
    });
    assert(overbuyRes.status === 400, "Checkout with insufficient stock rejected with 400");
    const stockAfterFailed = productRepository.findById(productA1._id);
    assert(stockAfterFailed.quantity === 40, "Stock unchanged at 40 after rejected purchase");

    // Multi-item rollback test: Item 1 has valid stock, Item 2 has insufficient stock
    const multiItemFailRes = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        items: [
          { product: productA1._id, quantity: 5 }, // valid: 40 >= 5
          { product: productA2._id, quantity: 999 }, // INVALID: exceeds stock
        ],
        paymentMethod: "UPI",
      }),
    });
    assert(multiItemFailRes.status === 400, "Multi-item checkout rejected when second item exceeds stock");
    const stockProdA1AfterRollback = productRepository.findById(productA1._id);
    assert(stockProdA1AfterRollback.quantity === 40, "ACID Rollback verified: Item 1 stock NOT deducted (remains 40)");

    // ------------------------------------------------------------------
    // TEST GROUP 6: Invoice Number Sequencing & Duplicate Rejection
    // ------------------------------------------------------------------
    console.log("\n[Group 6: Invoice Number Sequencing]");
    // Second sale: auto-sequence to Inv-0002
    const sale2Res = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        items: [{ product: productA1._id, quantity: 2 }],
        paymentMethod: "Card",
      }),
    });
    assert(sale2Res.status === 201, "Second checkout succeeds");
    const sale2Data = await sale2Res.json();
    assert(sale2Data.invoiceNumber === "Inv-0002", "Invoice number auto-incremented to Inv-0002");

    // Attempting duplicate invoice number
    const dupInvoiceRes = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        invoiceNumber: "Inv-0001", // Already exists!
        items: [{ product: productA1._id, quantity: 1 }],
        paymentMethod: "Cash",
      }),
    });
    assert(dupInvoiceRes.status === 400, "Duplicate invoice number rejected with 400");

    // ------------------------------------------------------------------
    // TEST GROUP 7: Tax Invoice PDF Generation
    // ------------------------------------------------------------------
    console.log("\n[Group 7: Tax Invoice PDF Generation]");
    const pdfRes = await fetch(`${baseUrl}/api/sales/${saleData._id}/invoice`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(pdfRes.status === 200, "GET /api/sales/:id/invoice returns 200");
    assert(pdfRes.headers.get("content-type") === "application/pdf", "Returns application/pdf content-type");
    const pdfBuffer = await pdfRes.arrayBuffer();
    const pdfHeader = Buffer.from(pdfBuffer).subarray(0, 5).toString("utf-8");
    assert(pdfHeader === "%PDF-", "Valid binary PDF header verified (%PDF-)");

    // ------------------------------------------------------------------
    // TEST GROUP 8: Item Return Processing & Stock Restoring
    // ------------------------------------------------------------------
    console.log("\n[Group 8: Return Processing & Restocking]");
    const itemToReturn = saleData.items[0]; // 10 tablets of productA1
    const returnQty = 3;

    const returnRes = await fetch(`${baseUrl}/api/sales/${saleData._id}/return`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        itemId: itemToReturn._id,
        returnQuantity: returnQty,
      }),
    });
    assert(returnRes.status === 200, "POST /api/sales/:id/return succeeds with 200");
    const returnedSale = await returnRes.json();
    const returnedItem = returnedSale.items.find((i) => i._id === itemToReturn._id);
    assert(returnedItem.returnedQuantity === 3, "Item returnedQuantity updated to 3");

    // Restocked inventory check: 40 - 2 (from sale 2) = 38. With return of 3 -> 41.
    const restockedProduct = productRepository.findById(productA1._id);
    assert(restockedProduct.quantity === 41, "Product stock atomically restored by 3 (from 38 to 41)");

    // Customer total purchases adjusted
    const custAfterReturn = customerRepository.findById(custA._id);
    // 680 - (3 * 40 * 0.95 = 114) = 566
    assert(Math.round(custAfterReturn.totalPurchases) === 566, "Customer totalPurchases adjusted for return refund");

    // Over-return attempt (remaining returnable: 10 - 3 = 7, attempting 8)
    const overReturnRes = await fetch(`${baseUrl}/api/sales/${saleData._id}/return`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        itemId: itemToReturn._id,
        returnQuantity: 8,
      }),
    });
    assert(overReturnRes.status === 400, "Return exceeding purchased quantity rejected with 400");

    // ------------------------------------------------------------------
    // TEST GROUP 9: Sales Cross-Organization Isolation
    // ------------------------------------------------------------------
    console.log("\n[Group 9: Sales Cross-Tenant Isolation]");
    // Branch B attempting to view Branch A's sale invoice
    const crossViewInvoice = await fetch(`${baseUrl}/api/sales/${saleData._id}/invoice`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(crossViewInvoice.status === 404, "Branch B cannot view Branch A sale invoice (404)");

    // Branch B attempting to process a return on Branch A's sale
    const crossReturn = await fetch(`${baseUrl}/api/sales/${saleData._id}/return`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        itemId: itemToReturn._id,
        returnQuantity: 1,
      }),
    });
    assert(crossReturn.status === 404, "Branch B cannot process return on Branch A sale (404)");

    // Branch B attempting to purchase Branch A's product
    const crossPurchase = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        items: [{ product: productA1._id, quantity: 1 }],
      }),
    });
    assert(crossPurchase.status === 404, "Branch B cannot buy Branch A product (404 Product Not Found)");

    // Branch B listing sales only sees their own sales
    const branchBSalesRes = await fetch(`${baseUrl}/api/sales`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const branchBSales = await branchBSalesRes.json();
    assert(branchBSales.length === 0, "Branch B sales list is isolated (sees 0 sales, Branch A has 2)");

    // ------------------------------------------------------------------
    // TEST GROUP 10: Customer Deletion Integrity
    // ------------------------------------------------------------------
    console.log("\n[Group 10: Customer Deletion & FK Integrity]");
    const deleteCustRes = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(deleteCustRes.status === 200, "DELETE /api/customers/:id returns 200");

    // Subsequent retrieval returns 404
    const getDeletedCust = await fetch(`${baseUrl}/api/customers/${custA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(getDeletedCust.status === 404, "Deleted customer returns 404");

    // Historical sale remains intact (ON DELETE SET NULL on customer_id)
    const saleAfterCustDelete = saleRepository.findById(saleData._id);
    assert(saleAfterCustDelete !== null, "Sale record preserved in history after customer deletion");
    assert(saleAfterCustDelete.customer.name === "Cash Customer", "Customer fallback to 'Cash Customer' after deletion");

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
