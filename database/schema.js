/**
 * Mediblix Desktop — SQLite Schema Definition & Migrations
 *
 * This module defines the complete relational SQLite schema for local-first
 * desktop pharmacy operations, matching all MongoDB Mongoose models:
 *  - Organization    -> organizations
 *  - User            -> users
 *  - Product         -> products
 *  - Customer        -> customers
 *  - Sale            -> sales & sale_items (normalized)
 *  - Supplier        -> suppliers
 *  - PurchaseOrder   -> purchase_orders & purchase_order_items (normalized)
 *  - ImportHistory   -> import_history
 *
 * Key Design Features:
 *  - Each table includes `_id` (TEXT UNIQUE) for full compatibility with React
 *    components expecting standard 24-character hexadecimal MongoDB ObjectIds.
 *  - Foreign keys enabled for relational integrity.
 *  - High-performance indexes on frequent query paths (sku, mobile, invoiceNumber).
 *  - Dedicated schema_migrations table for safe incremental migrations.
 */

const CURRENT_SCHEMA_VERSION = 2;

const MIGRATIONS = [
  {
    version: 1,
    name: "001_initial_schema",
    up: `
      -- Schema migrations tracker
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      );

      -- Organizations (Pharmacies)
      CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        contact_person TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        contact_phone TEXT,
        address TEXT,
        status TEXT DEFAULT 'Active' CHECK(status IN ('Active', 'Frozen')),
        plan TEXT DEFAULT 'Trial' CHECK(plan IN ('Trial', 'Monthly', 'Annual', 'Enterprise', 'Lifetime')),
        subscription_start_date TEXT DEFAULT (datetime('now')),
        subscription_expires_at TEXT,
        billing_cycle TEXT DEFAULT 'Monthly' CHECK(billing_cycle IN ('Monthly', 'Annual', 'Custom')),
        billing_amount REAL DEFAULT 0,
        single_device_enforced INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_org_code ON organizations(code);
      CREATE INDEX IF NOT EXISTS idx_org_status ON organizations(status);

      -- Users (Staff and Admins)
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        last_password TEXT DEFAULT '',
        password_history TEXT DEFAULT '[]',
        role TEXT DEFAULT 'staff' CHECK(role IN ('superadmin', 'org_admin', 'staff')),
        is_admin INTEGER DEFAULT 0,
        session_version INTEGER DEFAULT 1,
        active_session_key TEXT,
        active_device_info TEXT DEFAULT '{}',
        device_access_logs TEXT DEFAULT '[]',
        conflict_attempts_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

      -- Products (Inventory)
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sku TEXT NOT NULL,
        category TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        price REAL NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'In Stock' CHECK(status IN ('In Stock', 'Low Stock', 'Out of Stock')),
        expiry_date TEXT,
        mfg_date TEXT,
        hsn TEXT,
        packaging TEXT DEFAULT '10 Tablets / Strip',
        tablets_per_strip INTEGER DEFAULT 10,
        batch_number TEXT,
        manufacturer TEXT,
        mrp REAL DEFAULT 0,
        cost_price REAL DEFAULT 0,
        min_stock INTEGER DEFAULT 10,
        rack_location TEXT,
        description TEXT,
        unit TEXT DEFAULT 'Tablet',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_products_org_sku ON products(organization_id, sku);
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

      -- Customers
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        email TEXT,
        address TEXT,
        notes TEXT,
        total_purchases REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_customers_org_mobile ON customers(organization_id, mobile);
      CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

      -- Sales (Invoice Headers)
      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        total_amount REAL NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'Cash' CHECK(payment_method IN ('Cash', 'Card', 'Online', 'UPI')),
        invoice_number TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sales_org_invoice ON sales(organization_id, invoice_number);
      CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
      CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

      -- Sale Items (Normalized Line Items for Transactional Integrity & Returns)
      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        unit TEXT DEFAULT 'Tablet',
        discount REAL DEFAULT 0,
        returned_quantity INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

      -- Suppliers
      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_suppliers_org_name ON suppliers(organization_id, name);

      -- Purchase Orders
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_name TEXT NOT NULL,
        supplier_email TEXT,
        supplier_phone TEXT,
        delivery_address TEXT,
        total_amount REAL NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'In Transit', 'Delivered')),
        expected_delivery_date TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_po_org_status ON purchase_orders(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_po_created ON purchase_orders(created_at);

      -- Purchase Order Items (Normalized Line Items)
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product_name TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(purchase_order_id);

      -- Import History
      CREATE TABLE IF NOT EXISTS import_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        total_products INTEGER NOT NULL DEFAULT 0,
        total_quantity INTEGER NOT NULL DEFAULT 0,
        total_value REAL NOT NULL DEFAULT 0,
        items_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_import_history_org ON import_history(organization_id);
    `
  },
  {
    version: 2,
    name: "002_add_prescription_and_billing",
    up: `
      ALTER TABLE products ADD COLUMN prescription_required TEXT DEFAULT 'unknown' CHECK(prescription_required IN ('required','not_required','unknown'));

      CREATE TABLE IF NOT EXISTS bill_modifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        modified_by_user_id INTEGER NOT NULL REFERENCES users(id),
        modified_at TEXT DEFAULT (datetime('now')),
        diff_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        _id TEXT UNIQUE NOT NULL,
        original_sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending','Completed','Cancelled')),
        total_refund REAL DEFAULT 0,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price_at_sale REAL NOT NULL,
        refund_amount REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_bill_modifications_sale ON bill_modifications(sale_id);
      CREATE INDEX IF NOT EXISTS idx_returns_original_sale ON returns(original_sale_id);
      CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
    `
  },
];

module.exports = {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS
};
