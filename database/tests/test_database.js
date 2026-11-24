/**
 * Automated Verification Test Suite for Mediblix SQLite Runtime
 *
 * Verifies:
 *  1. Initialization & PRAGMA configuration (foreign_keys, WAL, busy_timeout)
 *  2. Schema migrations tracking
 *  3. Baseline seeding (Organization, Superadmin, Suppliers, Purchase Orders)
 *  4. Foreign key constraint enforcement
 *  5. Data persistence across database close and re-open (survives restart)
 *  6. ACID transaction atomicity & rollback on failure (Stock & Billing)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e) {
  bcrypt = require(path.join(__dirname, '../../backend/node_modules/bcryptjs'));
}

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@Mediblix2026';

const {
  initDatabase,
  closeDatabase,
  runInTransaction,
  generateId,
  CURRENT_SCHEMA_VERSION
} = require('../db');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runTests() {
  console.log('=== [MEDIBLIX SQLITE TEST SUITE] ===');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediblix-sqlite-test-'));
  const testDbFile = path.join(tempDir, 'test_mediblix.db');

  try {
    // ------------------------------------------------------------------------
    // TEST 1: Database Initialization & PRAGMAs
    // ------------------------------------------------------------------------
    console.log('\n[TEST 1] Initializing database at:', testDbFile);
    let db = initDatabase(testDbFile);

    const fk = db.pragma('foreign_keys', { simple: true });
    assert(fk === 1, `Expected foreign_keys = 1, got ${fk}`);
    console.log('  ✓ PRAGMA foreign_keys = ON (verified)');

    const jm = db.pragma('journal_mode', { simple: true });
    assert(jm.toLowerCase() === 'wal', `Expected journal_mode = wal, got ${jm}`);
    console.log('  ✓ PRAGMA journal_mode = WAL (verified)');

    const bt = db.pragma('busy_timeout', { simple: true });
    assert(bt === 5000, `Expected busy_timeout = 5000, got ${bt}`);
    console.log('  ✓ PRAGMA busy_timeout = 5000 (verified)');

    // ------------------------------------------------------------------------
    // TEST 2: Schema Migrations
    // ------------------------------------------------------------------------
    console.log('\n[TEST 2] Verifying schema migrations...');
    const applied = db.prepare('SELECT * FROM schema_migrations WHERE version = ?').get(CURRENT_SCHEMA_VERSION);
    assert(applied && applied.name === '001_initial_schema', 'Migration 001_initial_schema not recorded in schema_migrations');
    console.log(`  ✓ Migration v${CURRENT_SCHEMA_VERSION} recorded: ${applied.name}`);

    // ------------------------------------------------------------------------
    // TEST 3: Baseline Seeding
    // ------------------------------------------------------------------------
    console.log('\n[TEST 3] Verifying seeded records...');
    const defaultOrg = db.prepare('SELECT * FROM organizations WHERE code = ?').get('DEFAULT');
    assert(defaultOrg, 'Default organization was not seeded');
    assert(defaultOrg._id && defaultOrg._id.length === 24, 'Organization _id must be 24-character hexadecimal ObjectId');
    console.log(`  ✓ Default Organization verified: "${defaultOrg.name}" (_id: ${defaultOrg._id})`);

    const admin = db.prepare('SELECT * FROM users WHERE role = ?').get('superadmin');
    assert(admin, 'Superadmin was not seeded');
    assert(admin.is_admin === 1, 'Superadmin is_admin must be 1');
    const pwdMatch = bcrypt.compareSync('Admin@Mediblix2026', admin.password);
    assert(pwdMatch, 'Superadmin password hash failed bcrypt verification');
    console.log(`  ✓ Superadmin user verified: ${admin.email} (bcrypt verified)`);

    const suppliers = db.prepare('SELECT * FROM suppliers WHERE organization_id = ?').all(defaultOrg.id);
    assert(suppliers.length === 3, `Expected 3 suppliers, got ${suppliers.length}`);
    console.log(`  ✓ Seeded suppliers count: ${suppliers.length}`);

    const pos = db.prepare('SELECT * FROM purchase_orders WHERE organization_id = ?').all(defaultOrg.id);
    assert(pos.length >= 1, 'Expected at least 1 purchase order');
    const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(pos[0].id);
    assert(poItems.length === 2, `Expected 2 PO items, got ${poItems.length}`);
    console.log(`  ✓ Purchase orders verified with ${poItems.length} items`);

    // ------------------------------------------------------------------------
    // TEST 4: Foreign Key Constraint Enforcement
    // ------------------------------------------------------------------------
    console.log('\n[TEST 4] Testing foreign key enforcement...');
    let fkBlocked = false;
    try {
      db.prepare(`
        INSERT INTO products (_id, organization_id, name, sku, category, quantity, price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(generateId(), 999999, 'Ghost Medicine', 'GH-001', 'Tablet', 10, 50);
    } catch (err) {
      if (err.message.includes('FOREIGN KEY constraint failed')) {
        fkBlocked = true;
      }
    }
    assert(fkBlocked, 'Foreign key violation was not blocked by SQLite!');
    console.log('  ✓ Foreign key constraint successfully rejected invalid organization_id');

    // ------------------------------------------------------------------------
    // TEST 5: Data Persistence Across Restart
    // ------------------------------------------------------------------------
    console.log('\n[TEST 5] Testing persistence across restart...');
    const prodId = generateId();
    db.prepare(`
      INSERT INTO products (_id, organization_id, name, sku, category, quantity, price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(prodId, defaultOrg.id, 'Paracetamol 650mg', 'PCM-650', 'Analgesic', 100, 2.5);

    // Close database
    closeDatabase();
    console.log('  ✓ Database closed');

    // Reopen database
    db = initDatabase(testDbFile);
    console.log('  ✓ Database re-opened from disk');

    const persistedProduct = db.prepare('SELECT * FROM products WHERE _id = ?').get(prodId);
    assert(persistedProduct, 'Product was lost after closing and reopening database!');
    assert(persistedProduct.name === 'Paracetamol 650mg', `Product name mismatch: ${persistedProduct.name}`);
    assert(persistedProduct.quantity === 100, `Product quantity mismatch: ${persistedProduct.quantity}`);
    console.log(`  ✓ Persisted product verified: "${persistedProduct.name}", Qty: ${persistedProduct.quantity}`);

    // ------------------------------------------------------------------------
    // TEST 6: ACID Transactions & Rollback on Error
    // ------------------------------------------------------------------------
    console.log('\n[TEST 6] Testing ACID transaction atomicity & rollback...');
    
    // Test 6A: Successful atomic checkout transaction
    const initialQty = persistedProduct.quantity;
    const saleId = generateId();

    runInTransaction(() => {
      // Insert customer
      const custId = generateId();
      const custRes = db.prepare(`
        INSERT INTO customers (_id, organization_id, name, mobile)
        VALUES (?, ?, ?, ?)
      `).run(custId, defaultOrg.id, 'John Doe', '9876543210');

      // Insert sale
      const saleRes = db.prepare(`
        INSERT INTO sales (_id, organization_id, customer_id, total_amount, payment_method, invoice_number)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(saleId, defaultOrg.id, custRes.lastInsertRowid, 50, 'Cash', 'INV-TEST-001');

      // Insert sale item
      db.prepare(`
        INSERT INTO sale_items (_id, sale_id, product_id, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `).run(generateId(), saleRes.lastInsertRowid, persistedProduct.id, 20, 2.5);

      // Decrement product inventory
      const upd = db.prepare(`
        UPDATE products SET quantity = quantity - ? WHERE id = ?
      `).run(20, persistedProduct.id);
      assert(upd.changes === 1, 'Stock decrement update failed');
    });

    const afterSaleProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(persistedProduct.id);
    assert(afterSaleProduct.quantity === initialQty - 20, `Expected quantity ${initialQty - 20}, got ${afterSaleProduct.quantity}`);
    const recordedSale = db.prepare('SELECT * FROM sales WHERE _id = ?').get(saleId);
    assert(recordedSale, 'Sale record missing after commit');
    console.log('  ✓ Successful atomic transaction committed: Stock decremented from 100 to 80, sale recorded');

    // Test 6B: Failing transaction with guaranteed rollback
    let rollbackCaught = false;
    try {
      runInTransaction(() => {
        // Step 1: Decrement stock
        db.prepare('UPDATE products SET quantity = quantity - 50 WHERE id = ?').run(persistedProduct.id);
        
        // Step 2: Simulate failure (e.g. invalid foreign key or explicit runtime error)
        throw new Error('Simulated payment gateway / validation crash');
      });
    } catch (e) {
      rollbackCaught = true;
      console.log('  ✓ Caught intentional error in transaction:', e.message);
    }

    assert(rollbackCaught, 'Transaction did not catch error');
    const rolledBackProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(persistedProduct.id);
    assert(
      rolledBackProduct.quantity === 80,
      `Expected rolled-back quantity 80, got ${rolledBackProduct.quantity} (Stock was mutated despite failure!)`
    );
    console.log('  ✓ Rollback verified: Product quantity remained 80 (no partial mutation)');

    console.log('\n========================================');
    console.log('🎉 ALL 6 TEST SUITES PASSED FLAWLESSLY!');
    console.log('========================================\n');
    closeDatabase();
  } finally {
    // Cleanup temporary test directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
