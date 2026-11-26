/**
 * Mediblix Desktop — SQLite Database Manager & Connection Layer
 *
 * Handles:
 *  - Dynamic database location resolution (AppData/userData on Windows, or custom/memory for tests)
 *  - WAL mode (Write-Ahead Logging) for high concurrency
 *  - Foreign key constraints enforcement
 *  - Schema migrations tracking
 *  - Automatic seeding of default organization and initial users
 *  - ACID transaction helpers for financial/stock consistency
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e1) {
  try {
    bcrypt = require(path.join(__dirname, '../backend/node_modules/bcryptjs'));
  } catch (e2) {
    throw new Error('bcryptjs module not found: ' + e2.message);
  }
}

// Locate better-sqlite3 from backend or root node_modules
let Database;
try {
  Database = require('better-sqlite3');
} catch (e1) {
  try {
    Database = require(path.join(__dirname, '../backend/node_modules/better-sqlite3'));
  } catch (e2) {
    throw new Error('better-sqlite3 module not found. Please run npm install in backend or root: ' + e2.message);
  }
}

const { CURRENT_SCHEMA_VERSION, MIGRATIONS } = require('./schema');
const { getCanonicalDbPath, ensureDbDirExists, getCanonicalDbDir } = require('./paths');

let dbInstance = null;

/**
 * Resolves canonical database file path in %APPDATA%/Mediblix/mediblix.db
 */
function getDefaultDbPath() {
  const dbPath = getCanonicalDbPath();
  ensureDbDirExists(dbPath);
  return dbPath;
}

/**
 * Generate 24-character hexadecimal ObjectId string (100% compatible with Mongo ObjectIds)
 */
function generateId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Run migrations up to CURRENT_SCHEMA_VERSION
 */
function applyMigrations(db) {
  // Ensure schema_migrations exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  const appliedVersions = new Set(appliedRows.map(r => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      console.log(`[DB] Applying migration ${migration.version}: ${migration.name}`);
      const runMigration = db.transaction(() => {
        db.exec(migration.up);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      });
      runMigration();
    }
  }
}

/**
 * Seed master pharmacy organization and superadmin user if empty
 */
function seedDefaults(db) {
  // 1. Seed Default Organization
  let defaultOrg = db.prepare('SELECT * FROM organizations WHERE code = ?').get('DEFAULT');
  if (!defaultOrg) {
    const orgId = generateId();
    const info = db.prepare(`
      INSERT INTO organizations (
        _id, name, code, contact_person, contact_email, contact_phone, address, status, plan, subscription_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId,
      'Mediblix Master Pharmacy',
      'DEFAULT',
      'Adarsh Pandey',
      'adarshrpandey10@gmail.com',
      '9876543210',
      'Master Pharmacy Hub',
      'Active',
      'Trial',
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    );
    defaultOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(info.lastInsertRowid);
    console.log('[DB] Seeded master organization:', defaultOrg.name);
  }

  // 2. Seed Default Super Admin User (using environment variables, no hardcoded secrets)
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@mediblix.local').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex');

  let superadmin = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
  if (!superadmin) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(adminPassword, salt);
    const userId = generateId();

    db.prepare(`
      INSERT INTO users (
        _id, organization_id, name, email, password, role, is_admin
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      defaultOrg.id,
      'Super Admin',
      adminEmail,
      hash,
      'superadmin',
      1
    );
    console.log('[DB] Seeded initial superadmin:', adminEmail);
  }

  // 3. Seed Default Suppliers if none exist
  const supplierCount = db.prepare('SELECT COUNT(*) as count FROM suppliers').get().count;
  if (supplierCount === 0 && defaultOrg) {
    const sampleSuppliers = [
      {
        name: 'Cipla Pharmaceuticals',
        email: 'info@cipla.com',
        phone: '9876543210',
        address: 'Peninsula Chambers, Ganpatrao Kadam Marg, Lower Parel, Mumbai, Maharashtra 400013'
      },
      {
        name: 'Sun Pharma Industries',
        email: 'contact@sunpharma.com',
        phone: '8765432109',
        address: 'Sun House, CTS No. 201 B/1, Western Express Highway, Goregaon East, Mumbai, Maharashtra 400063'
      },
      {
        name: 'Dr. Reddy\'s Laboratories',
        email: 'support@drreddys.com',
        phone: '7654321098',
        address: '8-2-337, Road No. 3, Banjara Hills, Hyderabad, Telangana 500034'
      }
    ];

    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (_id, organization_id, name, email, phone, address)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const sup of sampleSuppliers) {
      insertSupplier.run(generateId(), defaultOrg.id, sup.name, sup.email, sup.phone, sup.address);
    }
    console.log('[DB] Seeded default suppliers.');
  }

  // 4. Seed sample purchase order if none exist
  const poCount = db.prepare('SELECT COUNT(*) as count FROM purchase_orders').get().count;
  if (poCount === 0 && defaultOrg) {
    const poId = generateId();
    const poResult = db.prepare(`
      INSERT INTO purchase_orders (
        _id, organization_id, supplier_name, supplier_email, supplier_phone, delivery_address, total_amount, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      poId,
      defaultOrg.id,
      'Cipla Pharmaceuticals',
      'info@cipla.com',
      '9876543210',
      'Peninsula Chambers, Ganpatrao Kadam Marg, Lower Parel, Mumbai, Maharashtra 400013',
      28600,
      'Delivered'
    );

    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items (purchase_order_id, product_name, sku, quantity, price)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertItem.run(poResult.lastInsertRowid, 'Calpol 650', 'PHR-CAL650', 500, 32);
    insertItem.run(poResult.lastInsertRowid, 'Limcee 500', 'PHR-LIMC500', 300, 42);
    console.log('[DB] Seeded sample purchase order.');
  }
}

/**
 * Initializes and returns the SQLite database instance
 * @param {string} [customPath] - Optional custom path (e.g. for testing)
 */
function initDatabase(customPath) {
  if (dbInstance && (!customPath || dbInstance.name === customPath)) {
    return dbInstance;
  }

  // Resolves custom path, or canonical path (which supports MEDIBLIX_DB_PATH / SQLITE_DB_PATH override)
  const targetPath = customPath || getDefaultDbPath();
  const isMemory = targetPath === ':memory:';

  if (!isMemory) {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  console.log(`[DB] Opening SQLite database: ${targetPath}`);
  const db = new Database(targetPath);

  // Performance and integrity PRAGMAs
  db.pragma('foreign_keys = ON');
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('busy_timeout = 5000');

  // Run migrations
  applyMigrations(db);

  // Seed baseline records if needed
  seedDefaults(db);

  dbInstance = db;
  return dbInstance;
}

/**
 * Get active database instance (throws if not initialized)
 */
function getDatabase() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      console.error('[DB] Error closing database:', e);
    }
    dbInstance = null;
  }
}

/**
 * Execute a callback inside an atomic SQLite transaction
 * Automatically rolls back if an exception is thrown
 * @param {Function} callback - Function receiving db parameter
 * @returns {*} Return value of the callback
 */
function runInTransaction(callback) {
  const db = getDatabase();
  return db.transaction(callback)();
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  runInTransaction,
  generateId,
  seedDefaults,
  getDefaultDbPath,
  getCanonicalDbPath,
  getCanonicalDbDir,
  CURRENT_SCHEMA_VERSION
};
