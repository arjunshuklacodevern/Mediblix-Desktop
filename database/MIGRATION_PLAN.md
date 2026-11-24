# Mediblix SQLite Migration & Local-First Architecture Plan

## Target Environment: One Pharmacy + One Windows Computer

The primary objective is for each individual pharmacy branch/store to run completely standalone on a single Windows desktop or POS machine, eliminating hard dependencies on cloud infrastructure for daily retail transactions, billing, customer management, and stock operations.

---

## 1. MongoDB Models to SQLite Schema Mapping

| MongoDB Model | Target SQLite Table | Key Columns & Types | Migration Notes & Changes |
| :--- | :--- | :--- | :--- |
| **Organization** (`models/Organization.js`) | `organizations` | `id INTEGER PRIMARY KEY`, `name TEXT`, `code TEXT UNIQUE`, `contact_person TEXT`, `contact_email TEXT`, `contact_phone TEXT`, `address TEXT`, `status TEXT`, `subscription_plan TEXT`, `subscription_expires_at TEXT`, `max_devices INTEGER` | Flattened timestamps (`created_at`, `updated_at`). For desktop single-node, one default active org row is seeded locally. |
| **User** (`models/User.js`) | `users` | `id INTEGER PRIMARY KEY`, `organization_id INTEGER`, `name TEXT`, `email TEXT UNIQUE`, `password_hash TEXT`, `role TEXT`, `is_admin INTEGER`, `active_session_key TEXT` | Bcrypt password hashes are preserved. Single-user or multi-shift staff access managed locally. |
| **Product** (`models/Product.js`) | `products` | `id INTEGER PRIMARY KEY`, `organization_id INTEGER`, `name TEXT`, `sku TEXT`, `batch_number TEXT`, `category TEXT`, `manufacturer TEXT`, `price REAL`, `mrp REAL`, `cost_price REAL`, `stock INTEGER`, `min_stock INTEGER`, `expiry_date TEXT`, `rack_location TEXT` | Supports index on `sku`, `name`, and `batch_number`. Essential for sub-second barcode scans and billing lookups. |
| **Customer** (`models/Customer.js`) | `customers` | `id INTEGER PRIMARY KEY`, `organization_id INTEGER`, `name TEXT`, `phone TEXT`, `email TEXT`, `address TEXT`, `notes TEXT`, `total_purchases REAL` | Index on `phone` for rapid customer identification during fast POS billing checkout. |
| **Sale** (`models/Sale.js`) | `sales` + `sale_items` | `sales`: `id`, `invoice_number`, `customer_id`, `subtotal`, `discount`, `tax`, `total`, `payment_method`, `status`, `created_at`. `sale_items`: `id`, `sale_id`, `product_id`, `product_name`, `quantity`, `price`, `total` | Normalized from single embedded document array in Mongo into `sales` (header) and `sale_items` (line items) for transactional integrity. |
| **Supplier** (`models/Supplier.js`) | `suppliers` | `id INTEGER PRIMARY KEY`, `organization_id INTEGER`, `name TEXT`, `email TEXT`, `phone TEXT`, `address TEXT` | Indexed on `name`. |
| **PurchaseOrder** (`models/PurchaseOrder.js`) | `purchase_orders` + `purchase_order_items` | `purchase_orders`: `id`, `supplier_name`, `total_amount`, `status`, `created_at`. `items`: `id`, `po_id`, `product_name`, `sku`, `quantity`, `price` | Normalized structure supporting automated inventory stock receipt upon PO delivery. |
| **ImportHistory** (`models/ImportHistory.js`) | `import_history` | `id INTEGER PRIMARY KEY`, `file_name TEXT`, `total_records INTEGER`, `successful INTEGER`, `failed INTEGER`, `status TEXT` | Tracks Excel/CSV catalog imports and AI invoice ingestion locally. |

---

## 2. Transaction Handling for Billing & Stock Updates

### Critical Invariant: Atomic Sale & Stock Decrement
When a sale is created in pharmacy operations:
1. Sale record is inserted.
2. Every item line is validated for sufficient on-hand quantity.
3. Corresponding `stock` in `products` is decremented.
4. If stock is insufficient or a power failure occurs mid-transaction, SQLite's ACID guarantees rollback the entire checkout operation.

```sql
BEGIN TRANSACTION;

-- 1. Insert invoice header
INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total, payment_method)
VALUES ('INV-2026-0001', 12, 'Adarsh Pandey', 150.00, 0, 18.00, 168.00, 'Cash');

-- 2. Insert item & decrement inventory
INSERT INTO sale_items (sale_id, product_id, product_name, quantity, price, total)
VALUES (last_insert_rowid(), 45, 'Paracetamol 650mg', 2, 25.00, 50.00);

UPDATE products 
SET stock = stock - 2, updated_at = datetime('now')
WHERE id = 45 AND stock >= 2;

-- If rows affected == 0, ROLLBACK
COMMIT;
```

---

## 3. Local Backup and Recovery Strategy

1. **Automatic Daily Snapshots**:
   - Location: `%APPDATA%/Mediblix/backups/mediblix-YYYY-MM-DD.bak`
   - Using SQLite's Online Backup API (`VACUUM INTO 'backup_path'`) so the database can be safely copied while the application is active without locking the UI.
2. **One-Click Manual Export**:
   - Exposed through Electron Main process (`db:export-backup`) prompting Windows Save Dialog to USB drive or local disk.
3. **Recovery Mechanism**:
   - Automatic integrity check on startup via `PRAGMA integrity_check`.
   - If corruption is detected, prompt user to restore from latest verified snapshot.

---

## 4. Current Status: Backend Dependencies

| Feature / Module | Current Implementation | Migration Path to Local-First |
| :--- | :--- | :--- |
| **Inventory & Products** | Remote REST API (`/api/products`) | Ready for local SQLite DAO via IPC |
| **POS Billing & Checkout** | Remote REST API (`/api/sales`) | Ready for local transactional SQLite DAO |
| **Customers Management** | Remote REST API (`/api/customers`) | Ready for local SQLite DAO |
| **Suppliers & Orders** | Remote REST API (`/api/suppliers`, `/api/purchase-orders`) | Ready for local SQLite DAO |
| **Audits & Movement Logs**| Remote REST API (`/api/sales/returns`, etc.) | Ready for local SQLite DAO |
| **AI Catalog / Invoice Import**| Remote Gemini / Vision API (`/api/ai`) | Requires internet connection for AI model calls; parsed data written to local SQLite |
| **Super Admin Multi-Org** | Remote Cloud Backend (`/api/admin`) | Remains cloud-based for multi-tenant oversight; local app runs as single licensed tenant |
