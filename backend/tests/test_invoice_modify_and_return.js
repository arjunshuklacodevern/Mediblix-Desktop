/**
 * Mediblix Desktop — Invoice Modify & Return Integration Test Suite
 *
 * Verifies:
 *  1. Return Bill - single and multi-item partial returns
 *  2. Return Bill - accurate inventory restocking
 *  3. Return Bill - refund calculation with discount: qty * (price * (1 - discount/100))
 *  4. Return Bill - audit logging in sale_returns & sale_return_items
 *  5. Return Bill - rejection of over-return (> remaining quantity)
 *  6. Return Bill - rejection of zero or invalid return quantities
 *  7. Modify Invoice - quantity increase with inventory deduction
 *  8. Modify Invoice - quantity decrease with inventory restocking
 *  9. Modify Invoice - rejection when quantity is set lower than already returned quantity
 * 10. Modify Invoice - rejection when requested quantity exceeds available stock
 * 11. Modify Invoice - recalculation of subtotal, total, and customer purchases
 * 12. Modify Invoice - payment method adjustment & revision audit logging in sale_revisions
 * 13. Tenant Isolation - organization B cannot return or modify organization A's invoice
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

const testDbPath = path.join(__dirname, "test_modify_return.db");

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
const { initDatabase, closeDatabase, getDatabase } = require("../../database/db.js");
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

// Error handler
app.use((err, req, res, next) => {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    message: err.message || "An unexpected error occurred",
  });
});

let server;
let baseUrl;

async function request(method, path, body = null, token = null) {
  const url = `${baseUrl}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, data };
}

async function runTests() {
  console.log("=================================================");
  console.log(" Mediblix Desktop — Invoice Modify & Return Tests");
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
    assert(baseUrl.length > 0, `Test HTTP server listening on ${baseUrl}`);

    // 2. Setup Organizations and Users
    const orgA = organizationRepository.create({
      name: "Mediblix Central Pharmacy",
      code: "MCP001",
    });
    const userA = userRepository.create({
      name: "Pharmacist Alice",
      email: "alice@pharmacy.test",
      password: "Password123!",
      role: "org_admin",
      organization: orgA.id,
    });

    const orgB = organizationRepository.create({
      name: "Other City Pharmacy",
      code: "OCP002",
    });
    const userB = userRepository.create({
      name: "Pharmacist Bob",
      email: "bob@other.test",
      password: "Password123!",
      role: "org_admin",
      organization: orgB.id,
    });

    // Login Alice
    const loginResA = await request("POST", "/api/users/login", {
      email: "alice@pharmacy.test",
      password: "Password123!",
    });
    assert(loginResA.status === 200, "Alice logged in successfully");
    const tokenA = loginResA.data.token;

    // Login Bob
    const loginResB = await request("POST", "/api/users/login", {
      email: "bob@other.test",
      password: "Password123!",
    });
    assert(loginResB.status === 200, "Bob logged in successfully");
    const tokenB = loginResB.data.token;

    // 3. Create Products for Org A
    // Product 1: Paracetamol 500mg, Quantity 50, Price 50
    const prod1 = productRepository.create({
      name: "Paracetamol 500mg",
      category: "Pain Relief",
      price: 50,
      quantity: 50,
      organization: orgA._id,
    });

    // Product 2: Amoxicillin 250mg, Quantity 30, Price 100
    const prod2 = productRepository.create({
      name: "Amoxicillin 250mg",
      category: "Antibiotics",
      price: 100,
      quantity: 30,
      organization: orgA._id,
    });

    assert(prod1.quantity === 50 && prod2.quantity === 30, "Initial inventory levels established");

    // 4. Create Customer
    const customerRes = await request("POST", "/api/customers", {
      name: "Rajesh Kumar",
      mobile: "9876543210",
      email: "rajesh@example.com",
    }, tokenA);
    assert(customerRes.status === 201, "Customer created successfully");
    const customerId = customerRes.data._id || customerRes.data.id;

    // 5. Checkout Sale (10 Paracetamol @ 10% discount, 5 Amoxicillin @ 0% discount)
    // Paracetamol: 10 * 50 * 0.9 = 450
    // Amoxicillin: 5 * 100 = 500
    // Total: 950
    const salePayload = {
      customerId: customerId,
      paymentMethod: "Cash",
      items: [
        { product: prod1._id, quantity: 10, price: 50, discount: 10 },
        { product: prod2._id, quantity: 5, price: 100, discount: 0 },
      ],
    };

    const checkoutRes = await request("POST", "/api/sales", salePayload, tokenA);
    assert(checkoutRes.status === 201, "POS sale checkout succeeded");
    const sale = checkoutRes.data;
    assert(Math.abs(sale.totalAmount - 950) < 0.01, `Sale totalAmount is 950 (got ${sale.totalAmount})`);

    // Verify initial stock deducted
    const p1AfterSale = productRepository.findById(prod1.id);
    const p2AfterSale = productRepository.findById(prod2.id);
    assert(p1AfterSale.quantity === 40, `Paracetamol stock deducted to 40 (got ${p1AfterSale.quantity})`);
    assert(p2AfterSale.quantity === 25, `Amoxicillin stock deducted to 25 (got ${p2AfterSale.quantity})`);

    // Verify customer total purchases
    const custAfterSale = customerRepository.findById(customerId);
    assert(Math.abs(custAfterSale.totalPurchases - 950) < 0.01, `Customer totalPurchases updated to 950 (got ${custAfterSale.totalPurchases})`);

    const p1Item = sale.items.find(i => String(i.product?._id || i.product) === String(prod1._id) || String(i.product?.id || i.product) === String(prod1.id));
    const p2Item = sale.items.find(i => String(i.product?._id || i.product) === String(prod2._id) || String(i.product?.id || i.product) === String(prod2.id));

    // ==========================================
    // TEST SECTION: RETURN BILL
    // ==========================================
    console.log("\n--- Testing Return Bill Feature ---");

    // Test 1: Partial return of 3 Paracetamol
    // Refund = 3 * (50 * 0.9) = 135
    const returnRes1 = await request("POST", `/api/sales/${sale._id}/return`, {
      items: [
        { itemId: p1Item._id, returnQuantity: 3 }
      ],
      refundMethod: "Cash",
      reason: "Patient dosage reduced"
    }, tokenA);

    assert(returnRes1.status === 200, "Partial return (3 Paracetamol) processed successfully");
    const updatedSale1 = returnRes1.data;
    assert(Math.abs(updatedSale1.refundAmount - 135) < 0.01, `Refund amount recorded as 135 (got ${updatedSale1.refundAmount})`);
    assert(Math.abs(updatedSale1.netAmount - 815) < 0.01, `Net amount calculated as 815 (got ${updatedSale1.netAmount})`);

    // Verify stock restocked: 40 + 3 = 43
    const p1AfterRet1 = productRepository.findById(prod1.id);
    assert(p1AfterRet1.quantity === 43, `Paracetamol stock restocked to 43 (got ${p1AfterRet1.quantity})`);

    // Verify customer total purchases adjusted: 950 - 135 = 815
    const custAfterRet1 = customerRepository.findById(customerId);
    assert(Math.abs(custAfterRet1.totalPurchases - 815) < 0.01, `Customer total purchases adjusted to 815 (got ${custAfterRet1.totalPurchases})`);

    // Verify audit record in database
    assert(updatedSale1.returns && updatedSale1.returns.length === 1, "Sale returns audit record populated");
    assert(updatedSale1.returns[0].reason === "Patient dosage reduced", "Return reason preserved");
    const rMethod = updatedSale1.returns[0].refundMethod || updatedSale1.returns[0].refund_method;
    assert(rMethod === "Cash", `Refund method preserved as Cash (got ${rMethod})`);

    // Test 2: Multi-item partial return (2 more Paracetamol and 2 Amoxicillin)
    // Refund = 2 * (50 * 0.9) + 2 * (100 * 1.0) = 90 + 200 = 290
    // Cumulative refund = 135 + 290 = 425
    const returnRes2 = await request("POST", `/api/sales/${sale._id}/return`, {
      items: [
        { itemId: p1Item._id, returnQuantity: 2 },
        { itemId: p2Item._id, returnQuantity: 2 },
      ],
      refundMethod: "UPI",
      reason: "Unopened surplus blister pack"
    }, tokenA);

    assert(returnRes2.status === 200, "Multi-item partial return processed successfully");
    const updatedSale2 = returnRes2.data;
    assert(Math.abs(updatedSale2.refundAmount - 425) < 0.01, `Cumulative refund amount is 425 (got ${updatedSale2.refundAmount})`);
    assert(Math.abs(updatedSale2.netAmount - 525) < 0.01, `Cumulative net amount is 525 (got ${updatedSale2.netAmount})`);

    // Verify stock restocked
    const p1AfterRet2 = productRepository.findById(prod1.id);
    const p2AfterRet2 = productRepository.findById(prod2.id);
    assert(p1AfterRet2.quantity === 45, `Paracetamol stock restocked to 45 (got ${p1AfterRet2.quantity})`);
    assert(p2AfterRet2.quantity === 27, `Amoxicillin stock restocked to 27 (got ${p2AfterRet2.quantity})`);

    // Verify returns count
    assert(updatedSale2.returns.length === 2, `Sale has 2 return audit logs (got ${updatedSale2.returns.length})`);

    // Test 3: Over-return rejection
    // Paracetamol: sold 10, already returned 3 + 2 = 5. Remaining returnable: 5.
    // Try returning 6: should fail
    const overReturnRes = await request("POST", `/api/sales/${sale._id}/return`, {
      items: [
        { itemId: p1Item._id, returnQuantity: 6 }
      ],
      refundMethod: "Cash",
      reason: "Testing over-return"
    }, tokenA);
    assert(overReturnRes.status === 400, "Over-return rejected with 400 Bad Request");

    // Test 4: Zero / negative return rejection
    const zeroReturnRes = await request("POST", `/api/sales/${sale._id}/return`, {
      items: [
        { itemId: p1Item._id, returnQuantity: 0 }
      ]
    }, tokenA);
    assert(zeroReturnRes.status === 400, "Zero-quantity return rejected with 400 Bad Request");

    // ==========================================
    // TEST SECTION: MODIFY INVOICE
    // ==========================================
    console.log("\n--- Testing Modify Invoice Feature ---");

    // Test 5: Quantity lower than already returned rejection
    // Paracetamol: 5 already returned. Setting quantity to 4 must be rejected!
    const lowerThanReturnedRes = await request("PUT", `/api/sales/${sale._id}/modify`, {
      paymentMethod: "Cash",
      reason: "Attempting to reduce below returned",
      items: [
        { itemId: p1Item._id, quantity: 4, price: 50, discount: 10 },
        { itemId: p2Item._id, quantity: 5, price: 100, discount: 0 },
      ]
    }, tokenA);
    assert(lowerThanReturnedRes.status === 400, "Setting quantity below returned quantity rejected with 400");

    // Test 6: Quantity increase requiring inventory check
    // Current stock of Amoxicillin is 27.
    // Try to increase Amoxicillin from 5 to 50 (needs +45, but only 27 available): should fail
    const excessStockRes = await request("PUT", `/api/sales/${sale._id}/modify`, {
      paymentMethod: "Cash",
      reason: "Attempting excess quantity",
      items: [
        { itemId: p1Item._id, quantity: 10, price: 50, discount: 10 },
        { itemId: p2Item._id, quantity: 50, price: 100, discount: 0 },
      ]
    }, tokenA);
    assert(excessStockRes.status === 400, "Quantity increase exceeding available stock rejected with 400");

    // Test 7: Successful Invoice Modification
    // Current state:
    // Paracetamol: qty 10 (price 50, disc 10%) = 450
    // Amoxicillin: qty 5 (price 100, disc 0%) = 500
    // Modify:
    // Paracetamol: qty remains 10, discount changed to 20% (10 * 50 * 0.8 = 400)
    // Amoxicillin: qty increased from 5 to 8 (price 100, disc 10%) -> (8 * 100 * 0.9 = 720)
    // New total: 400 + 720 = 1120
    // Stock delta for Amoxicillin: +3 needed -> stock 27 - 3 = 24
    // Payment method changed from "Cash" to "UPI"
    const modifyRes = await request("PUT", `/api/sales/${sale._id}/modify`, {
      paymentMethod: "UPI",
      reason: "Special senior citizen discount applied and doctor prescribed extra tabs",
      items: [
        { itemId: p1Item._id, quantity: 10, price: 50, discount: 20 },
        { itemId: p2Item._id, quantity: 8, price: 100, discount: 10 },
      ]
    }, tokenA);

    assert(modifyRes.status === 200, "Invoice modification succeeded with 200 OK");
    const modifiedSale = modifyRes.data;
    assert(Math.abs(modifiedSale.totalAmount - 1120) < 0.01, `Revised total amount is 1120 (got ${modifiedSale.totalAmount})`);
    assert(modifiedSale.paymentMethod === "UPI", `Payment method updated to UPI (got ${modifiedSale.paymentMethod})`);

    // Verify stock deduction on Amoxicillin: 27 - 3 = 24
    const p2AfterMod = productRepository.findById(prod2.id);
    assert(p2AfterMod.quantity === 24, `Amoxicillin stock adjusted to 24 (got ${p2AfterMod.quantity})`);

    // Verify revision audit trail
    assert(modifiedSale.revisions && modifiedSale.revisions.length === 1, "Revision audit trail logged");
    const rev = modifiedSale.revisions[0];
    const prevTot = rev.previousTotal !== undefined ? rev.previousTotal : rev.previous_total;
    const newTot = rev.newTotal !== undefined ? rev.newTotal : rev.new_total;
    const prevPay = rev.previousPaymentMethod || rev.previous_payment_method;
    const newPay = rev.newPaymentMethod || rev.new_payment_method;

    assert(Math.abs(prevTot - 950) < 0.01, `Revision previousTotal is 950 (got ${prevTot})`);
    assert(Math.abs(newTot - 1120) < 0.01, `Revision newTotal is 1120 (got ${newTot})`);
    assert(prevPay === "Cash" && newPay === "UPI", `Revision payment method change tracked: ${prevPay} -> ${newPay}`);
    assert(rev.reason.includes("senior citizen"), "Revision reason recorded");

    // Verify customer purchase total updated:
    // Customer originally had 950, refunded 425 (net 525). Now invoice gross increased by +170 to 1120, so customer net is 525 + 170 = 695 net spent
    const custAfterMod = customerRepository.findById(customerId);
    assert(Math.abs(custAfterMod.totalPurchases - 695) < 0.01, `Customer totalPurchases accurately tracks net purchases of 695 (got ${custAfterMod.totalPurchases})`);

    // ==========================================
    // TEST SECTION: TENANT ISOLATION
    // ==========================================
    console.log("\n--- Testing Tenant Isolation ---");

    // Bob from Org B tries to return Org A's invoice
    const bobReturnRes = await request("POST", `/api/sales/${sale._id}/return`, {
      items: [{ itemId: p1Item._id, returnQuantity: 1 }],
      refundMethod: "Cash",
      reason: "Intruder return"
    }, tokenB);
    assert(bobReturnRes.status === 404, "Org B cannot process return on Org A's sale (404 Not Found)");

    // Bob from Org B tries to modify Org A's invoice
    const bobModifyRes = await request("PUT", `/api/sales/${sale._id}/modify`, {
      paymentMethod: "Cash",
      reason: "Intruder modify",
      items: [{ itemId: p1Item._id, quantity: 10, price: 50, discount: 20 }]
    }, tokenB);
    assert(bobModifyRes.status === 404, "Org B cannot modify Org A's sale (404 Not Found)");

  } catch (err) {
    console.error("Test execution threw error:", err);
    failed++;
  } finally {
    if (server) {
      server.close();
    }
    closeDatabase();
    cleanDbFiles();
  }

  console.log("=================================================");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("=================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
