# MEDIBLIX DESKTOP — IMPLEMENTATION & HANDOFF STATUS

## 1. Project Context & Environment
- **Workspace**: `C:\Users\iamar\Mediblix-Desktop`
- **Original Source (Strict Read-Only)**: `C:\Users\iamar\Mediblix` (Untouched, no modifications)
- **Target OS**: Windows Desktop (Single Pharmacy / Single Counter POS)
- **Architecture**: Electron Desktop Shell + Dual React Frontends (Pharmacy Staff + Super Admin) + Local Express Backend + SQLite Local Database
- **No Git repository**: Work resides strictly within the workspace folder. No commits or pushes.

---

## 2. Completed Work (Phase 1 — Electron Shell & Frontend Builds)
1. **Electron Shell & IPC**:
   - `electron/main.js`: Lifecycle management, security settings (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`), window creation, external navigation lock.
   - `electron/preload.js`: Context-isolated IPC bridge exposing safe `electronAPI`.
   - `electron/portal-selector.html`: Dedicated portal selection screen.
   - `electron/runner.js`: Strips `ELECTRON_RUN_AS_NODE` environment variable for clean Electron execution.
2. **Frontend Desktop Adaptation**:
   - `frontend/`: Configured with `HashRouter`, set Vite `base: './'`, verified production build (`vite v7.3.8`).
   - `admin-frontend/`: Configured with `HashRouter`, set Vite `base: './'`, verified production build (`vite v6.4.6`).
3. **Packaging**:
   - Generated 256x256 `build/icon.ico` via .NET `System.Drawing`.
   - Verified portable executable (`dist-electron/win-unpacked/Mediblix.exe`) running with active PID.
   - Built full Windows NSIS installer (`dist-electron/Mediblix Setup 1.0.0.exe`, 92.2 MB).
4. **Automated Verification**:
   - `electron/verify-runtime.js` validated that all 3 windows (Portal Selector, Pharmacy Staff, Super Admin) load `#root` and IPC without console errors.

---

## 3. Completed Work (Phase 2 — SQLite Database Foundation & Repositories)

### Compatibility & Architecture Verification
- **Host Node.js**: `v24.14.1` (ABI 131)
- **Electron**: `v33.4.11` (Node 20.18.3, ABI 130)
- **better-sqlite3**: Installed `better-sqlite3` v13.2.0 in `backend/` with prebuilt Windows x64 binary. Verified executing queries in Node.js runtime.
- **Contract Compatibility**: Every SQLite table stores a 24-character hexadecimal `_id` string (via `crypto.randomBytes(12).toString('hex')`) ensuring 100% compatibility with React components and API routes expecting MongoDB ObjectIds.

### SQLite Schema & Migrations (`database/schema.js`)
- **Version Tracking**: `schema_migrations` table records versioned DDL migrations.
- **Relational Models Implemented**:
  1. `organizations`: multi-plan subscriptions, contact details, frozen account status, single device enforcement.
  2. `users`: bcrypt password hashes, role-based access (`superadmin`, `org_admin`, `staff`), session versioning.
  3. `products`: full pharmacy attributes (`quantity`, `price`, `status`, `sku`, `hsn`, `packaging`, `tablets_per_strip`, `expiry_date`, `mfg_date`, `rack_location`).
  4. `customers`: customer tracking by mobile and name, purchase links.
  5. `sales`: invoice headers (`invoice_number`, `total_amount`, `payment_method`, customer reference with `ON DELETE SET NULL`).
  6. `sale_items`: normalized relational line items (`quantity`, `price`, `discount`, `returned_quantity`).
  7. `suppliers`: supplier directory with contact details.
  8. `purchase_orders`: purchase order headers (`supplier_name`, `total_amount`, `status`, delivery date).
  9. `purchase_order_items`: line items for POs with `ON DELETE CASCADE`.
  10. `import_history`: catalog import batches with JSON payload storage.
- **Performance & Integrity**:
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA journal_mode = WAL;` (Write-Ahead Logging)
  - `PRAGMA busy_timeout = 5000;`
  - Indexes created on: `(organization_id, sku)`, `(organization_id, mobile)`, `(organization_id, invoice_number)`, `(organization_id, name)`.

### Database Manager (`database/db.js`)
- `initDatabase(customPath)`: Dynamically resolves database path (defaults to `%APPDATA%/Mediblix/mediblix.db` for persistence across app restarts and updates, or custom path / `:memory:` for testing).
- `runInTransaction(callback)`: Executes operations inside atomic SQLite transactions; automatically rolls back on any error.
- `seedDefaults(db)`: Automatically seeds baseline Master Pharmacy organization, Super Admin user (`admin@mediblix.local`), suppliers, and sample purchase order.

### Repository / DAO Foundation (`database/repositories/`)
- `baseRepository.js`: Shared row-to-model mapper converting snake_case SQL rows to camelCase frontend objects with `_id`, `id`, `createdAt`, `updatedAt`.
- `organizationRepository.js`: `findAll`, `findById`, `findByCode`, `create`, `updateStatus`.
- `userRepository.js`: `findByEmail`, `findById`, `create`, `updateSession`, `clearSession`, `recordLoginSuccess`, `recordConflictAttempt`, `matchPassword`.
- `productRepository.js`: `findAll`, `findById`, `findBySku`, `search`, `create`, `update`, `decrementStock`, `incrementStock`, `delete`.
- `customerRepository.js`: `findAll`, `findById`, `findByMobile`, `search`, `create`, `update`, `delete`.
- `saleRepository.js`: `findAll`, `findById`, `createSale` (atomic transaction with stock verification and decrement), `processReturn` (atomic transaction with return tracking and stock increment).
- `supplierRepository.js`: `findAll`, `findById`, `findByName`, `create`, `update`, `delete`.
- `purchaseOrderRepository.js`: `findAll`, `findById`, `create`, `updateStatus` (atomic receiving & stock addition), `delete`.
- `importHistoryRepository.js`: `findAll`, `findById`, `create`, `delete`.
- `index.js`: Unified export module.

---

## 4. Completed Work (Phase 3A — Authentication & Products Migration)
1. **Authentication Migration**:
   - `backend/controllers/authController.js`: Migrated `/api/users/login`, `/api/users/logout`, and `/api/users/me` to `userRepository`. Password hashes strictly stripped from responses.
   - `backend/controllers/adminController.js`: Migrated `/api/admin/login` to `userRepository.findByEmail` and `userRepository.matchPassword`. Rejects non-admin attempts with 403.
   - `backend/utils/authMiddleware.js`: Validates JWT token and SQLite user record. Enforces session checks, frozen organization status, and subscription expiry.
   - `backend/utils/tenantHelper.js`: Restricted `x-organization-id` header overrides strictly to verified superadmins. Non-admin users are strictly pinned to `req.user.organization._id`.
2. **Product Controller Migration**:
   - `backend/controllers/productController.js`: Migrated `getProducts`, `getProductById`, `searchProducts`, `createProduct`, `updateProduct`, and `deleteProduct` to `productRepository`.
   - `backend/routes/productRoutes.js`: Added `router.use(protect)` to protect all product catalog routes.
   - Preserved SKU uniqueness, computed stock statuses, and automated import history logging.

---

## 5. Completed Work (Phase 3B — Customer & Sales / POS Migration)
1. **Customer Controller Migration**:
   - `backend/controllers/customerController.js`: Migrated `getCustomers`, `createCustomer` (mobile upsert), `searchCustomers`, `getCustomerById` (purchase history aggregation), `updateCustomer`, and `deleteCustomer` to `customerRepository` and `saleRepository`.
   - `backend/routes/customerRoutes.js`: Protected with `router.use(protect)`.
2. **Sales & POS Controller Migration**:
   - `backend/controllers/saleController.js`: Migrated `createSale` (atomic POS checkout with stock deduction), `getSales`, `generateInvoice` (PDF download via `pdfkit`), and `processReturn` (inventory restocking) to `saleRepository` and `organizationRepository`.
   - `backend/routes/saleRoutes.js`: Protected with `router.use(protect)`.
   - Verified strict cross-tenant isolation and foreign key integrity (`ON DELETE SET NULL`).

---

## 6. Completed Work (Phase 3C — Supplier, Purchase Order & Import History Migration)

### 1. Supplier Controller Migration (`backend/controllers/supplierController.js`)
- Migrated `getSuppliers`, `getSupplierById`, `createSupplier`, `updateSupplier`, and `deleteSupplier` to `supplierRepository`.
- Preserved name uniqueness checks per organization (rejects duplicates with HTTP 400).
- Protected `backend/routes/supplierRoutes.js` with `router.use(protect)`.
- Enforced cross-organization isolation (foreign organization suppliers cannot be viewed, updated, or deleted — returns HTTP 404).

### 2. Purchase Order Controller Migration (`backend/controllers/purchaseOrderController.js`)
- Migrated `getPurchaseOrders`, `getPurchaseOrderById`, `createPurchaseOrder`, `updatePurchaseOrderStatus`, and `deletePurchaseOrder` to `purchaseOrderRepository`.
- **Order Lifecycle & Status Transitions**:
  - Valid status transitions: `'Pending'` $\rightarrow$ `'In Transit'` $\rightarrow$ `'Delivered'`.
- **Automatic Stock Receiving**:
  - When status transitions to `'Delivered'`, the order's line items are received into product inventory inside an atomic transaction.
  - If a product already exists with that SKU, its stock is incremented by the PO quantity (`productRepository.incrementStock`).
  - If a product does not exist with that SKU, a new catalog item is automatically registered and stocked.
- **Duplicate Receiving Prevention (Idempotency)**:
  - If an order is already `'Delivered'`, any subsequent transition or receiving request is rejected with HTTP 400 (`"Cannot change status of an already delivered purchase order"`). Stock is guaranteed NEVER added twice.
- Protected `backend/routes/purchaseOrderRoutes.js` with `router.use(protect)`.

### 3. Import History Controller Migration (`backend/controllers/importHistoryController.js`)
- Migrated `getImportHistory`, `getImportHistoryById`, `createImportRecord`, `deleteImportRecord`, and `exportImportHistory` to `importHistoryRepository` and `productRepository`.
- **Atomic Catalog Batch Processing (`createImportRecord`)**:
  - Runs inside `runInTransaction`.
  - For each item: increments existing product stock or registers new product, updates metadata, and records audit entry.
- **Excel Export (`exportImportHistory`)**:
  - Generates downloadable Excel workbook via `exceljs` (`GET /api/import-history/:id/export`).
  - Streams formatted XLSX spreadsheet (`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) containing medicine names, SKUs, categories, quantities, prices, total values, and statuses.
- Protected `backend/routes/importHistoryRoutes.js` with `router.use(protect)`.

---

## 7. Verification Test Results

### Suite 1: Phase 3C Supplier & Orders Tests (`npm run test:orders`)
Command: `npm run test:orders`
Results: **62 Passed, 0 Failed**
- [Group 1: Route Security]
  - GET /api/suppliers without token rejected with 401
  - GET /api/purchase-orders without token rejected with 401
  - GET /api/import-history without token rejected with 401
- [Group 2: Supplier Management]
  - POST /api/suppliers creates supplier with 201
  - Supplier has 24-character ObjectId
  - Supplier name matches
  - Duplicate supplier name rejected with 400
  - GET /api/suppliers returns 200
  - Created supplier appears in list
  - GET /api/suppliers/:id returns 200
  - Supplier detail matches requested ID
  - PUT /api/suppliers/:id updates supplier phone
  - Updated phone verified
- [Group 3: Purchase Order Operations]
  - Product Azithromycin created with stock = 20
  - POST /api/purchase-orders creates PO with 201
  - PO has 24-character _id
  - Initial status is 'Pending'
  - Total amount accurately calculated (4750 + 1500 = 6250)
  - Items length matches 2
  - GET /api/purchase-orders returns 200
  - Created PO appears in listing
  - GET /api/purchase-orders/:id returns 200
  - PO detail matches requested ID
  - Status updated to 'In Transit'
- [Group 4: Stock Receiving & Idempotency]
  - Status updated to 'Delivered'
  - Delivered status confirmed
  - Existing product stock incremented from 20 to 70 (+50)
  - New product Cetirizine automatically created in inventory
  - New product stock received with quantity 100
  - Duplicate delivery transition rejected with 400
  - Stock was NOT added twice (remains 70)
- [Group 5: Import History & Excel Export]
  - POST /api/import-history creates import record with 201
  - Import record has 24-char ObjectId
  - totalProducts equals 2
  - totalQuantity equals 230
  - totalValue accurately computed as 6700
  - Stock updated to 100 via catalog import
  - New product Ibuprofen created via import
  - GET /api/import-history returns 200
  - Import record appears in history list
  - GET /api/import-history/:id returns 200
  - Detail fileName matches
  - GET /api/import-history/:id/export returns 200
  - Returns valid openxmlformats Excel content-type
  - Valid ZIP/XLSX header verified ('PK')
- [Group 6: Cross-Tenant Isolation]
  - Branch B cannot read Branch A supplier (404)
  - Branch B cannot update Branch A supplier (404)
  - Branch B cannot delete Branch A supplier (404)
  - Branch B cannot read Branch A PO (404)
  - Branch B cannot update Branch A PO status (404)
  - Branch B cannot delete Branch A PO (404)
  - Branch B cannot read Branch A import history (404)
  - Branch B cannot export Branch A import history (404)
  - Branch B cannot delete Branch A import history (404)
- [Group 7: Deletion Integrity]
  - DELETE /api/suppliers/:id returns 200
  - Subsequent GET /api/suppliers/:id returns 404
  - DELETE /api/purchase-orders/:id returns 200
  - Subsequent GET /api/purchase-orders/:id returns 404
  - DELETE /api/import-history/:id returns 200
  - Subsequent GET /api/import-history/:id returns 404

### Suite 2: Phase 3B Customer & POS Tests (`npm run test:pos`)
Command: `npm run test:pos`
Results: **62 Passed, 0 Failed** (Zero regressions in POS checkout, atomic stock deduction, customer CRUD, mobile upsert, invoice numbering, PDF generation, return restocking)

### Suite 3: Phase 3A Auth & Product Tests (`npm run test:api`)
Command: `npm run test:api`
Results: **44 Passed, 0 Failed** (Zero regressions in Staff/Admin auth, session cleanup, product CRUD, SKU duplicate rejection)

### Suite 4: SQLite Foundation & Repository Tests (`npm run test:db`)
Command: `npm run test:db`
Results:
- `database/tests/test_database.js`: **ALL 6 TEST SUITES PASSED**
- `database/tests/test_repositories.js`: **ALL 7 REPOSITORY INTEGRATION TESTS PASSED**

### Suite 5: Frontend Production Compilations (`npm run build:all`)
Command: `npm run build:all`
Results: **PASSED (Exit Code 0)**
- `frontend`: Vite v7.3.8 built in 14.90s
- `admin-frontend`: Vite v6.4.6 built in 13.55s

### Suite 6: Electron Runtime Regression (`electron/verify-runtime.js`)
Command: `node electron/runner.js electron/verify-runtime.js`
Results: **ALL 3 WINDOWS LOADED AND VERIFIED SUCCESSFULLY**
- Portal Window: Title verified, `window.electronAPI` verified.
- Pharmacy Window: Title verified, `#root` DOM verified, `window.electronAPI` verified.
- Admin Window: Title verified, `#root` DOM verified, `window.electronAPI` verified.

---

## 7. Completed Work (Phase 3D — Super Admin, MedAgent & AI Services Migration)

### 1. Super Admin Controller Migration (`backend/controllers/adminController.js`)
- Migrated all Super Admin endpoints to SQLite repositories (`organizationRepository`, `userRepository`, `productRepository`, `saleRepository`) and direct relational aggregate SQL queries:
  - `getAdminStats`: Aggregates total organizations, active count, trial count, and total platform revenue directly from `organizations` and `sales` tables.
  - `getOrganizations`: Lists all tenant organizations with computed trial days remaining (`subscription_expiry_date - CURRENT_TIMESTAMP`), active product count subquery, and lifetime revenue subquery.
  - `getOrganizationById`: Retrieves detailed organization profile, attached staff/admin user accounts (with password hashes strictly omitted), product count, and total revenue.
  - `createOrganization`: Creates new tenant organization (code auto-generated if omitted, default 45-day trial period) and provisions initial organization admin user account inside an atomic transaction. Enforces email uniqueness (HTTP 400).
  - `updateOrganization`: Updates name, address, phone, contact email, and active license tier.
  - `toggleOrganizationStatus`: Flips tenant status between `'Active'` and `'Frozen'`. Users belonging to a `'Frozen'` organization are immediately blocked from logging in (HTTP 403) and existing sessions are invalidated by `authMiddleware`.
  - `updateOrgSubscription`: Extends subscription period and modifies subscription plan (`'Trial'`, `'Monthly'`, `'Annual'`, `'Custom'`).
  - `resetOrgDeviceSession`: Atomically resets device session tokens and session keys for all users of a specified organization, forcing all client terminals to re-authenticate on next request (HTTP 401).
  - `resetOrgPassword`: Resets password for the organization's administrator user, recording the previous hash in password history and verifying the new bcrypt hash.
- Zero Mongoose dependencies remain in `adminController.js`.

### 2. MedAgent AI Inventory Search Migration (`backend/controllers/medAgentController.js`)
- Migrated `crossReferenceInventory`, `getAlternatives`, `getCategories`, and `handleChat` to `productRepository`.
- **Security & Multi-Tenant Isolation Fix**:
  - Legacy code performed an un-scoped `Product.find({})` query which leaked inventory items across different organizations.
  - The SQLite implementation strictly isolates inventory queries to the calling user's tenant organization: `productRepository.findAll(orgId)` and `WHERE organization_id = ?`.
  - Alternative medicine recommendations are scoped strictly to the current pharmacy's inventory by matching categories and composition while excluding out-of-stock items.
- Zero Mongoose dependencies remain in `medAgentController.js`.

### 3. AI Document Parsing Controller Audit (`backend/controllers/aiController.js`)
- Audited `parseInvoice` and `parseBillDocument`:
  - Verified that `aiController.js` performs zero database operations.
  - It receives document payloads (base64 images or PDFs), calls the Google Gemini API (`@google/genai` or `@google/generative-ai`), parses extracted structured medicine line items (names, quantities, prices, batch numbers, expiry dates), and returns JSON directly to the frontend.
  - Enforced route protection via `protect` middleware in `backend/routes/aiRoutes.js`.
- Zero Mongoose dependencies remain in `aiController.js`.

### 4. Supporting Repository Enhancements
- `database/repositories/organizationRepository.js`:
  - Implemented `update(idOrIdStr, data)` supporting partial updates with dynamic SQL SET generation.
- `database/repositories/userRepository.js`:
  - Implemented `updatePassword(userId, newPassword, logEntry)` with bcrypt hashing, password history logging, and `updated_at` tracking.
  - Implemented `resetDeviceSessionsForOrg(orgId, logEntry)` to atomically invalidate session keys across all users of a tenant.

---

## 8. Verification Test Results (All 5 Suites Passing)

### Suite 1: Phase 3D Admin & AI Tests (`npm run test:admin`)
Command: `npm run test:admin`
Results: **49 Passed, 0 Failed**
- [Group 1: Admin Access Control]
  - GET /api/admin/stats without token returns 401
  - Staff user denied admin access with 403
  - Super Admin granted access with 200
  - Stats reports total organizations >= 1
  - Stats reports active organizations >= 1
  - Revenue is reported as a number
- [Group 2: Organization Management]
  - POST /api/admin/organizations creates organization with 201
  - Organization has 24-char ObjectId
  - Organization code is SUN01
  - Organization is Active
  - Initial admin credentials provided
  - Duplicate organization email rejected with 400
- [Group 3: Organization Queries & Summaries]
  - GET /api/admin/organizations returns 200
  - Created organization appears in listing
  - Calculated daysRemaining correctly reflects 45-day trial
  - Includes productCount summary
  - Includes revenue summary
  - GET /api/admin/organizations?search returns 200
  - Organization found via search
  - GET /api/admin/organizations/:id returns 200
  - Organization ID matches
  - Users array included
  - User passwords strictly omitted from response
  - Detailed stats included
  - PUT /api/admin/organizations/:id updates details
  - Updated phone verified
- [Group 4: Subscription & Status Transitions]
  - PATCH /api/admin/organizations/:id/subscription returns 200
  - Plan updated to Annual
  - Subscription extended by 30 days (total > 70)
  - PATCH /api/admin/organizations/:id/status freezes org
  - Status confirmed as Frozen
  - Org admin user exists
  - Login blocked with 403 because organization is Frozen
- [Group 5: Session & Password Resets]
  - Org admin logs in successfully once Active
  - Device session reset succeeds with 200
  - Previous session token rejected with 401 after reset
  - Admin password reset returns 200
  - New password confirmed
  - Previous password recorded in password history
  - Login with new password succeeds with 200
- [Group 6: MedAgent AI Inventory Scoping]
  - GET /api/medagent/categories returns 200
  - Category 'Respiratory' returned
  - POST /api/medagent/alternatives returns 200
  - Alternative Levocetirizine found in inventory
  - Tenant isolation: Staff in Default Org cannot see Sunrise products
- [Group 7: AI Parsing Validation & Security]
  - POST /api/ai/parse-invoice without token rejected with 401
  - POST /api/ai/parse-invoice with empty body returns 400

### Suite 2: Phase 3C Supplier & Orders Tests (`npm run test:orders`)
Command: `npm run test:orders`
Results: **62 Passed, 0 Failed** (Zero regressions in supplier CRUD, PO status flow, stock receiving, duplicate delivery protection, catalog batch import, Excel XLSX streaming)

### Suite 3: Phase 3B Customer & POS Tests (`npm run test:pos`)
Command: `npm run test:pos`
Results: **62 Passed, 0 Failed** (Zero regressions in POS checkout, atomic stock deduction, customer CRUD, mobile upsert, invoice numbering, PDF generation, return restocking)

### Suite 4: Phase 3A Auth & Product Tests (`npm run test:api`)
Command: `npm run test:api`
Results: **44 Passed, 0 Failed** (Zero regressions in Staff/Admin auth, session cleanup, product CRUD, SKU duplicate rejection)

### Suite 5: SQLite Foundation & Repository Tests (`npm run test:db`)
Command: `npm run test:db`
Results:
- `database/tests/test_database.js`: **ALL 6 TEST SUITES PASSED**
- `database/tests/test_repositories.js`: **ALL 7 REPOSITORY INTEGRATION TESTS PASSED**

### Overall Automated Test Summary
- **Total Tests Passing**: **230 assertions / integration tests (100% pass rate)**
- Run all suites with: `npm test`

### Frontend Production Compilations (`npm run build:all`)
Command: `npm run build:all`
Results: **PASSED (Exit Code 0)**
- `frontend`: Vite v7.3.8 built in 14.10s
- `admin-frontend`: Vite v6.4.6 built in 8.69s

### Electron Runtime Regression (`node electron/runner.js electron/verify-runtime.js`)
Command: `node electron/runner.js electron/verify-runtime.js`
Results: **ALL 3 WINDOWS LOADED AND VERIFIED SUCCESSFULLY**
- Portal Window: Title verified, `window.electronAPI` verified.
- Pharmacy Window: Title verified, `#root` DOM verified, `window.electronAPI` verified.
- Admin Window: Title verified, `#root` DOM verified, `window.electronAPI` verified.

---

## 9. Comprehensive Audit of Controllers & Mongoose Deprecation

**ALL 10 BACKEND CONTROLLERS HAVE ZERO MONGOOSE IMPORTS:**
1. `backend/controllers/authController.js` — SQLite (`userRepository`)
2. `backend/controllers/productController.js` — SQLite (`productRepository`)
3. `backend/controllers/customerController.js` — SQLite (`customerRepository`, `saleRepository`)
4. `backend/controllers/saleController.js` — SQLite (`saleRepository`, `organizationRepository`)
5. `backend/controllers/supplierController.js` — SQLite (`supplierRepository`)
6. `backend/controllers/purchaseOrderController.js` — SQLite (`purchaseOrderRepository`, `productRepository`)
7. `backend/controllers/importHistoryController.js` — SQLite (`importHistoryRepository`, `productRepository`)
8. `backend/controllers/adminController.js` — SQLite (`organizationRepository`, `userRepository`, `productRepository`, `saleRepository`)
9. `backend/controllers/medAgentController.js` — SQLite (`productRepository`)
10. `backend/controllers/aiController.js` — Google Gemini API (Stateless)

Only **ONE** file in the entire codebase still references MongoDB/Mongoose:
- `backend/index.js` (Invokes `connectDB()` during server boot, to be removed in Phase 3E)

---

## 10. Next Action (Phase 3E: Complete Offline Isolation & Standalone Startup)
1. **Remove MongoDB Startup**:
   - Remove `connectDB()` invocation and MongoDB connection from `backend/index.js`.
   - Ensure `initDatabase()` handles database seeding and initialization solely on SQLite.
2. **Remove Unused Mongoose Models**:
   - Safely archive or remove deprecated `backend/models/*.js` once Mongoose is disconnected.
3. **Verify Pure Standalone Boot**:
   - Start the backend and verify it boots with zero network calls and zero MongoDB connections.
   - Run complete end-to-end regression tests.
4. **Final Packaging & Distribution Build**:
   - Run `npm run dist` to create the final production installer.
