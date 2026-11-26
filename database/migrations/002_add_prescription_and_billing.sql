-- Migration 002: Add prescription_required to products and billing related tables
-- Add prescription_required column to products
ALTER TABLE products ADD COLUMN prescription_required TEXT DEFAULT 'unknown' CHECK(prescription_required IN ('required','not_required','unknown'));

-- Table to record bill modifications (audit trail)
CREATE TABLE IF NOT EXISTS bill_modifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  _id TEXT UNIQUE NOT NULL,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  modified_by_user_id INTEGER NOT NULL REFERENCES users(id),
  modified_at TEXT DEFAULT (datetime('now')),
  diff_json TEXT NOT NULL
);

-- Returns main table
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

-- Return items table linking to returns and products
CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  price_at_sale REAL NOT NULL,
  refund_amount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bill_modifications_sale ON bill_modifications(sale_id);
CREATE INDEX IF NOT EXISTS idx_returns_original_sale ON returns(original_sale_id);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
