/**
 * Automated Verification Test Suite for SQLite Repositories
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { initDatabase, closeDatabase } = require('../db');
const {
  organizationRepository,
  userRepository,
  productRepository,
  customerRepository,
  saleRepository,
  supplierRepository,
  purchaseOrderRepository
} = require('../repositories');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runRepositoryTests() {
  console.log('=== [MEDIBLIX REPOSITORIES TEST SUITE] ===');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediblix-repos-test-'));
  const testDbFile = path.join(tempDir, 'test_repos.db');

  try {
    initDatabase(testDbFile);

    // 1. Organization Repository
    console.log('\n[TEST 1] Testing organizationRepository...');
    const defaultOrg = organizationRepository.findByCode('DEFAULT');
    assert(defaultOrg && defaultOrg.name === 'Mediblix Master Pharmacy', 'Default org retrieval failed');
    console.log('  ✓ findByCode retrieved:', defaultOrg.name);

    const newOrg = organizationRepository.create({
      name: 'City Care Pharmacy',
      code: 'CITY01',
      contactPerson: 'Rahul Sharma',
      contactEmail: 'rahul@citycare.com'
    });
    assert(newOrg && newOrg.code === 'CITY01', 'Organization creation failed');
    console.log('  ✓ create retrieved:', newOrg.name, '(_id:', newOrg._id, ')');

    const updatedOrg = organizationRepository.updateStatus(newOrg._id, 'Frozen');
    assert(updatedOrg && updatedOrg.status === 'Frozen', 'Status update failed');
    console.log('  ✓ updateStatus to Frozen verified');

    // 2. User Repository
    console.log('\n[TEST 2] Testing userRepository...');
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@mediblix.local').toLowerCase().trim();
    const adminUser = userRepository.findByEmail(adminEmail);
    assert(adminUser && adminUser.isAdmin, 'Superadmin retrieval failed');
    console.log('  ✓ findByEmail retrieved admin:', adminUser.email);

    const staffUser = userRepository.create({
      name: 'Pharmacist John',
      email: 'john@mediblix.com',
      password: 'StaffPassword123',
      role: 'staff',
      organizationId: defaultOrg.id
    });
    assert(staffUser && staffUser.role === 'staff', 'Staff user creation failed');
    console.log('  ✓ create staff user:', staffUser.email, '(_id:', staffUser._id, ')');

    userRepository.updateSession(staffUser._id, 'session_key_123', { deviceName: 'Counter POS 1' });
    const userWithSession = userRepository.findById(staffUser._id);
    assert(userWithSession.activeSessionKey === 'session_key_123', 'Session key update failed');
    assert(userWithSession.activeDeviceInfo.deviceName === 'Counter POS 1', 'Device info update failed');
    console.log('  ✓ updateSession verified');

    userRepository.clearSession(staffUser._id);
    const userCleared = userRepository.findById(staffUser._id);
    assert(userCleared.activeSessionKey === null, 'Clear session failed');
    console.log('  ✓ clearSession verified');

    // 3. Product Repository
    console.log('\n[TEST 3] Testing productRepository...');
    const prod = productRepository.create({
      organizationId: defaultOrg.id,
      name: 'Amoxicillin 500mg',
      sku: 'AMX-500',
      category: 'Antibiotic',
      quantity: 50,
      price: 15.00,
      expiryDate: '2028-12-31'
    });
    assert(prod && prod.status === 'In Stock', 'Product creation failed');
    console.log('  ✓ create product:', prod.name, 'Qty:', prod.quantity, 'Status:', prod.status);

    const foundBySku = productRepository.findBySku('AMX-500', defaultOrg.id);
    assert(foundBySku && foundBySku.name === 'Amoxicillin 500mg', 'findBySku failed');
    console.log('  ✓ findBySku verified');

    const searchResults = productRepository.search('Amox', defaultOrg.id);
    assert(searchResults.length === 1 && searchResults[0].sku === 'AMX-500', 'search failed');
    console.log('  ✓ search verified: found', searchResults.length, 'match');

    // 4. Customer Repository
    console.log('\n[TEST 4] Testing customerRepository...');
    const cust = customerRepository.create({
      organizationId: defaultOrg.id,
      name: 'Ananya Verma',
      mobile: '9123456780',
      email: 'ananya@example.com'
    });
    assert(cust && cust.mobile === '9123456780', 'Customer creation failed');
    console.log('  ✓ create customer:', cust.name, 'Mobile:', cust.mobile);

    const foundCust = customerRepository.findByMobile('9123456780', defaultOrg.id);
    assert(foundCust && foundCust.name === 'Ananya Verma', 'findByMobile failed');
    console.log('  ✓ findByMobile verified');

    // 5. Sale Repository (POS Billing & Return)
    console.log('\n[TEST 5] Testing saleRepository (POS & Returns)...');
    const sale = saleRepository.createSale({
      orgId: defaultOrg.id,
      customerId: cust._id,
      items: [
        { product: prod._id, quantity: 10, price: 15.00, discount: 0 }
      ],
      paymentMethod: 'UPI'
    });

    assert(sale && sale.totalAmount === 150, `Expected totalAmount 150, got ${sale.totalAmount}`);
    assert(sale.items.length === 1, 'Sale line item missing');
    console.log('  ✓ createSale committed: Total Rs.', sale.totalAmount, 'Invoice:', sale.invoiceNumber);

    const prodAfterSale = productRepository.findById(prod._id);
    assert(prodAfterSale.quantity === 40, `Expected stock 40 after sale of 10 from 50, got ${prodAfterSale.quantity}`);
    console.log('  ✓ Stock decrement verified: Stock reduced from 50 to', prodAfterSale.quantity);

    // Process Return of 2 tablets
    const itemToReturn = sale.items[0];
    const updatedSale = saleRepository.processReturn({
      saleId: sale._id,
      itemId: itemToReturn._id,
      returnQuantity: 2,
      orgId: defaultOrg.id
    });

    const returnedItem = updatedSale.items.find(i => String(i._id) === String(itemToReturn._id));
    assert(returnedItem.returnedQuantity === 2, `Expected returnedQuantity 2, got ${returnedItem.returnedQuantity}`);

    const prodAfterReturn = productRepository.findById(prod._id);
    assert(prodAfterReturn.quantity === 42, `Expected stock 42 after return of 2, got ${prodAfterReturn.quantity}`);
    console.log('  ✓ processReturn verified: Restocked 2 tablets, new stock is', prodAfterReturn.quantity);

    // 6. Supplier Repository
    console.log('\n[TEST 6] Testing supplierRepository...');
    const allSuppliers = supplierRepository.findAll(defaultOrg.id);
    assert(allSuppliers.length >= 3, `Expected at least 3 suppliers, got ${allSuppliers.length}`);
    console.log('  ✓ findAll suppliers count:', allSuppliers.length);

    // 7. Purchase Order Repository
    console.log('\n[TEST 7] Testing purchaseOrderRepository...');
    const newPO = purchaseOrderRepository.create({
      organizationId: defaultOrg.id,
      supplierName: 'Sun Pharma Industries',
      items: [
        { productName: 'Azithromycin 500mg', sku: 'AZI-500', quantity: 200, price: 45.00 }
      ]
    });

    assert(newPO && newPO.totalAmount === 9000, `Expected PO total 9000, got ${newPO.totalAmount}`);
    assert(newPO.items.length === 1, 'PO items missing');
    console.log('  ✓ create purchase order verified: Total Rs.', newPO.totalAmount, 'Status:', newPO.status);

    const updatedPO = purchaseOrderRepository.updateStatus(newPO._id, 'Delivered');
    assert(updatedPO.status === 'Delivered', 'PO status update failed');
    console.log('  ✓ updateStatus to Delivered verified');

    console.log('\n=============================================');
    console.log('🎉 ALL REPOSITORY INTEGRATION TESTS PASSED!');
    console.log('=============================================\n');
    closeDatabase();
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

runRepositoryTests().catch(err => {
  console.error('\n❌ REPOSITORY TEST FAILED:', err);
  process.exit(1);
});
