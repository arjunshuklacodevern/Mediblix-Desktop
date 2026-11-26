/**
 * Mediblix Desktop — Sync Service & Client
 *
 * Implements bidirectional data synchronization between local SQLite and AWS Cloud Backend:
 *   1. Push: Collects pending local changes + tombstones, submits via POST /api/sync/push
 *   2. Poll: Polls GET /api/sync/status/:jobId until status === 'completed'
 *   3. Confirm: Marks acknowledged records as 'synced' in SQLite
 *   4. Pull: Downloads cloud-side changes via GET /api/sync/pull?lastSyncTime=<ISO>
 *   5. Apply: Ingests cloud changes into SQLite inside atomic ACID transactions
 *   6. Cursor: Updates persistent sync cursor only after successful commit
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { getDatabase, runInTransaction } = require('../../database/db');
const { getCanonicalDbPath } = require('../../database/paths');
const { makeRequest, getSyncMetadata, setSyncMetadata } = require('./syncUtils');

const DEFAULT_CLOUD_URL = process.env.MEDIBLIX_CLOUD_URL || 'https://backend.app.mediblix.com';
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;

/**
 * Collects pending records from local SQLite
 */
function collectPendingChanges(orgId) {
  const db = getDatabase();
  
  // 1. Pending Products
  const products = db.prepare(`
    SELECT p.*, o.code as org_code
    FROM products p
    LEFT JOIN organizations o ON p.organization_id = o.id
    WHERE p.sync_status = 'pending'
  `).all().map(p => ({
    _id: p._id,
    name: p.name,
    sku: p.sku,
    category: p.category,
    quantity: p.quantity,
    price: p.price,
    status: p.status,
    expiryDate: p.expiry_date,
    mfgDate: p.mfg_date,
    hsn: p.hsn,
    packaging: p.packaging,
    tabletsPerStrip: p.tablets_per_strip,
    batchNumber: p.batch_number,
    manufacturer: p.manufacturer,
    mrp: p.mrp,
    costPrice: p.cost_price,
    minStock: p.min_stock,
    rackLocation: p.rack_location,
    description: p.description,
    unit: p.unit,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  }));

  // 2. Pending Customers
  const customers = db.prepare(`
    SELECT * FROM customers WHERE sync_status = 'pending'
  `).all().map(c => ({
    _id: c._id,
    name: c.name,
    mobile: c.mobile,
    email: c.email,
    address: c.address,
    notes: c.notes,
    totalPurchases: c.total_purchases,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  }));

  // 3. Pending Sales (Header + Items)
  const saleRows = db.prepare(`SELECT * FROM sales WHERE sync_status = 'pending'`).all();
  const sales = saleRows.map(s => {
    const items = db.prepare(`
      SELECT si.*, p._id as product_mongo_id, p.name as product_name
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `).all(s.id).map(si => ({
      _id: si._id,
      product: si.product_mongo_id,
      quantity: si.quantity,
      price: si.price,
      unit: si.unit,
      discount: si.discount,
      returnedQuantity: si.returned_quantity,
      createdAt: si.created_at
    }));

    const cust = s.customer_id ? db.prepare('SELECT _id, name, mobile FROM customers WHERE id = ?').get(s.customer_id) : null;

    return {
      _id: s._id,
      customer: cust ? cust._id : null,
      totalAmount: s.total_amount,
      paymentMethod: s.payment_method,
      invoiceNumber: s.invoice_number,
      items,
      createdAt: s.created_at,
      updatedAt: s.updated_at
    };
  });

  // 4. Pending Suppliers
  const suppliers = db.prepare(`SELECT * FROM suppliers WHERE sync_status = 'pending'`).all().map(sup => ({
    _id: sup._id,
    name: sup.name,
    email: sup.email,
    phone: sup.phone,
    address: sup.address,
    createdAt: sup.created_at,
    updatedAt: sup.updated_at
  }));

  // 5. Pending Purchase Orders
  const poRows = db.prepare(`SELECT * FROM purchase_orders WHERE sync_status = 'pending'`).all();
  const purchaseOrders = poRows.map(po => {
    const items = db.prepare(`SELECT * FROM purchase_order_items WHERE purchase_order_id = ?`).all(po.id).map(poi => ({
      productName: poi.product_name,
      sku: poi.sku,
      quantity: poi.quantity,
      price: poi.price,
      createdAt: poi.created_at
    }));

    return {
      _id: po._id,
      supplierName: po.supplier_name,
      supplierEmail: po.supplier_email,
      supplierPhone: po.supplier_phone,
      deliveryAddress: po.delivery_address,
      totalAmount: po.total_amount,
      status: po.status,
      expectedDeliveryDate: po.expected_delivery_date,
      items,
      createdAt: po.created_at,
      updatedAt: po.updated_at
    };
  });

  // 6. Pending Tombstones (Deletions)
  const tombstones = db.prepare(`SELECT * FROM sync_tombstones WHERE sync_status = 'pending'`).all().map(t => ({
    id: t.id,
    entityType: t.entity_type,
    entityMongoId: t.entity_mongo_id,
    deletedAt: t.deleted_at
  }));

  return {
    products,
    customers,
    sales,
    suppliers,
    purchaseOrders,
    tombstones
  };
}

/**
 * Marks pushed records and tombstones as 'synced' in SQLite
 */
function markLocalRecordsSynced(confirmedData, nowIso) {
  const db = getDatabase();

  runInTransaction(() => {
    // Products
    if (confirmedData.products && confirmedData.products.length > 0) {
      const stmt = db.prepare("UPDATE products SET sync_status = 'synced', synced_at = ? WHERE _id = ?");
      for (const p of confirmedData.products) {
        stmt.run(nowIso, p._id);
      }
    }

    // Customers
    if (confirmedData.customers && confirmedData.customers.length > 0) {
      const stmt = db.prepare("UPDATE customers SET sync_status = 'synced', synced_at = ? WHERE _id = ?");
      for (const c of confirmedData.customers) {
        stmt.run(nowIso, c._id);
      }
    }

    // Sales
    if (confirmedData.sales && confirmedData.sales.length > 0) {
      const stmt = db.prepare("UPDATE sales SET sync_status = 'synced', synced_at = ? WHERE _id = ?");
      for (const s of confirmedData.sales) {
        stmt.run(nowIso, s._id);
      }
    }

    // Suppliers
    if (confirmedData.suppliers && confirmedData.suppliers.length > 0) {
      const stmt = db.prepare("UPDATE suppliers SET sync_status = 'synced', synced_at = ? WHERE _id = ?");
      for (const sup of confirmedData.suppliers) {
        stmt.run(nowIso, sup._id);
      }
    }

    // Purchase Orders
    if (confirmedData.purchaseOrders && confirmedData.purchaseOrders.length > 0) {
      const stmt = db.prepare("UPDATE purchase_orders SET sync_status = 'synced', synced_at = ? WHERE _id = ?");
      for (const po of confirmedData.purchaseOrders) {
        stmt.run(nowIso, po._id);
      }
    }

    // Tombstones
    if (confirmedData.tombstones && confirmedData.tombstones.length > 0) {
      const stmt = db.prepare("UPDATE sync_tombstones SET sync_status = 'synced', synced_at = ? WHERE id = ?");
      for (const t of confirmedData.tombstones) {
        stmt.run(nowIso, t.id);
      }
    }
  });
}

/**
 * Applies pulled cloud changes and cloud tombstones into SQLite inside an atomic transaction
 */
function applyPulledChanges(changes, defaultOrgId) {
  const db = getDatabase();

  return runInTransaction(() => {
    let appliedCount = 0;
    let tombstonesCount = 0;

    // 1. Process Cloud Tombstones (Deletions) first
    if (changes.tombstones && Array.isArray(changes.tombstones)) {
      for (const t of changes.tombstones) {
        const id = t.entityMongoId || t._id;
        if (!id) continue;
        if (t.entityType === 'product') {
          db.prepare('DELETE FROM products WHERE _id = ?').run(id);
          tombstonesCount++;
        } else if (t.entityType === 'customer') {
          db.prepare('DELETE FROM customers WHERE _id = ?').run(id);
          tombstonesCount++;
        } else if (t.entityType === 'supplier') {
          db.prepare('DELETE FROM suppliers WHERE _id = ?').run(id);
          tombstonesCount++;
        } else if (t.entityType === 'purchase_order') {
          db.prepare('DELETE FROM purchase_orders WHERE _id = ?').run(id);
          tombstonesCount++;
        }
      }
    }

    // 2. Upsert Products
    if (changes.products && Array.isArray(changes.products)) {
      const upsertProduct = db.prepare(`
        INSERT INTO products (
          _id, organization_id, name, sku, category, quantity, price, status,
          expiry_date, mfg_date, hsn, packaging, tablets_per_strip, batch_number,
          manufacturer, mrp, cost_price, min_stock, rack_location, description, unit,
          sync_status, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'), ?, ?)
        ON CONFLICT(_id) DO UPDATE SET
          name = excluded.name,
          sku = excluded.sku,
          category = excluded.category,
          quantity = excluded.quantity,
          price = excluded.price,
          status = excluded.status,
          expiry_date = excluded.expiry_date,
          mfg_date = excluded.mfg_date,
          hsn = excluded.hsn,
          packaging = excluded.packaging,
          tablets_per_strip = excluded.tablets_per_strip,
          batch_number = excluded.batch_number,
          manufacturer = excluded.manufacturer,
          mrp = excluded.mrp,
          cost_price = excluded.cost_price,
          min_stock = excluded.min_stock,
          rack_location = excluded.rack_location,
          description = excluded.description,
          unit = excluded.unit,
          sync_status = 'synced',
          synced_at = datetime('now'),
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= products.updated_at OR products.sync_status = 'synced'
      `);

      for (const p of changes.products) {
        if (!p._id || !p.sku) continue;
        upsertProduct.run(
          p._id,
          defaultOrgId,
          p.name || 'Unnamed Product',
          p.sku,
          p.category || 'General',
          Number(p.quantity) || 0,
          Number(p.price) || 0,
          p.status || 'In Stock',
          p.expiryDate || null,
          p.mfgDate || null,
          p.hsn || null,
          p.packaging || '10 Tablets / Strip',
          Number(p.tabletsPerStrip) || 10,
          p.batchNumber || null,
          p.manufacturer || null,
          Number(p.mrp) || 0,
          Number(p.costPrice) || 0,
          Number(p.minStock) || 10,
          p.rackLocation || null,
          p.description || null,
          p.unit || 'Tablet',
          p.createdAt || new Date().toISOString(),
          p.updatedAt || new Date().toISOString()
        );
        appliedCount++;
      }
    }

    // 3. Upsert Customers
    if (changes.customers && Array.isArray(changes.customers)) {
      const upsertCustomer = db.prepare(`
        INSERT INTO customers (
          _id, organization_id, name, mobile, email, address, notes, total_purchases,
          sync_status, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'), ?, ?)
        ON CONFLICT(_id) DO UPDATE SET
          name = excluded.name,
          mobile = excluded.mobile,
          email = excluded.email,
          address = excluded.address,
          notes = excluded.notes,
          total_purchases = excluded.total_purchases,
          sync_status = 'synced',
          synced_at = datetime('now'),
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= customers.updated_at OR customers.sync_status = 'synced'
      `);

      for (const c of changes.customers) {
        if (!c._id || !c.mobile) continue;
        upsertCustomer.run(
          c._id,
          defaultOrgId,
          c.name || 'Customer',
          c.mobile,
          c.email || null,
          c.address || null,
          c.notes || null,
          Number(c.totalPurchases) || 0,
          c.createdAt || new Date().toISOString(),
          c.updatedAt || new Date().toISOString()
        );
        appliedCount++;
      }
    }

    // 4. Upsert Suppliers
    if (changes.suppliers && Array.isArray(changes.suppliers)) {
      const upsertSupplier = db.prepare(`
        INSERT INTO suppliers (
          _id, organization_id, name, email, phone, address,
          sync_status, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'synced', datetime('now'), ?, ?)
        ON CONFLICT(_id) DO UPDATE SET
          name = excluded.name,
          email = excluded.email,
          phone = excluded.phone,
          address = excluded.address,
          sync_status = 'synced',
          synced_at = datetime('now'),
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= suppliers.updated_at OR suppliers.sync_status = 'synced'
      `);

      for (const sup of changes.suppliers) {
        if (!sup._id || !sup.name) continue;
        upsertSupplier.run(
          sup._id,
          defaultOrgId,
          sup.name,
          sup.email || '',
          sup.phone || '',
          sup.address || '',
          sup.createdAt || new Date().toISOString(),
          sup.updatedAt || new Date().toISOString()
        );
        appliedCount++;
      }
    }

    // 5. Ingest Sales (Sales are local-authoritative; cloud sales only ingested if not present)
    if (changes.sales && Array.isArray(changes.sales)) {
      const insertSale = db.prepare(`
        INSERT OR IGNORE INTO sales (
          _id, organization_id, customer_id, total_amount, payment_method, invoice_number,
          sync_status, synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'synced', datetime('now'), ?, ?)
      `);

      for (const s of changes.sales) {
        if (!s._id || !s.invoiceNumber) continue;
        const custRow = s.customer ? db.prepare('SELECT id FROM customers WHERE _id = ?').get(s.customer) : null;
        const sInfo = insertSale.run(
          s._id,
          defaultOrgId,
          custRow ? custRow.id : null,
          Number(s.totalAmount) || 0,
          s.paymentMethod || 'Cash',
          s.invoiceNumber,
          s.createdAt || new Date().toISOString(),
          s.updatedAt || new Date().toISOString()
        );

        if (sInfo.changes > 0 && Array.isArray(s.items)) {
          const insertItem = db.prepare(`
            INSERT OR IGNORE INTO sale_items (
              _id, sale_id, product_id, quantity, price, unit, discount, returned_quantity, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const item of s.items) {
            const prodRow = db.prepare('SELECT id FROM products WHERE _id = ?').get(item.product);
            if (prodRow) {
              insertItem.run(
                item._id || crypto.randomBytes(12).toString('hex'),
                sInfo.lastInsertRowid,
                prodRow.id,
                Number(item.quantity) || 1,
                Number(item.price) || 0,
                item.unit || 'Tablet',
                Number(item.discount) || 0,
                Number(item.returnedQuantity) || 0,
                item.createdAt || new Date().toISOString()
              );
            }
          }
          appliedCount++;
        }
      }
    }

    return { appliedCount, tombstonesCount };
  });
}

/**
 * Main Bidirectional Synchronization Routine
 */
async function performBidirectionalSync(options = {}) {
  const cloudUrl = options.cloudUrl || DEFAULT_CLOUD_URL;
  const token = options.token;

  if (!token) {
    throw new Error('JWT token is required for cloud synchronization');
  }

  const db = getDatabase();
  const defaultOrg = db.prepare('SELECT id, _id FROM organizations WHERE code = ?').get('DEFAULT') ||
                     db.prepare('SELECT id, _id FROM organizations LIMIT 1').get();
  const defaultOrgId = defaultOrg ? defaultOrg.id : 1;

  // Reuse existing pending clientSyncId across retries to maintain idempotency
  let clientSyncId = options.clientSyncId;
  if (!clientSyncId) {
    try {
      clientSyncId = getSyncMetadata('pending_client_sync_id');
    } catch (_) {}
  }
  if (!clientSyncId) {
    clientSyncId = `sync_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    try {
      setSyncMetadata('pending_client_sync_id', clientSyncId);
    } catch (_) {}
  }
  const nowIso = new Date().toISOString();

  // Record initial telemetry in sync_history
  const historyInsert = db.prepare(`
    INSERT INTO sync_history (client_sync_id, direction, status, started_at)
    VALUES (?, 'bidirectional', 'in_progress', ?)
  `).run(clientSyncId, nowIso);
  const historyId = historyInsert.lastInsertRowid;

  try {
    // -------------------------------------------------------------
    // STEP 1: PUSH LOCAL CHANGES
    // -------------------------------------------------------------
    const pending = collectPendingChanges(defaultOrgId);
    const totalPendingCount =
      pending.products.length +
      pending.customers.length +
      pending.sales.length +
      pending.suppliers.length +
      pending.purchaseOrders.length;
    const tombstonesCount = pending.tombstones.length;

    let recordsPushed = 0;

    if (totalPendingCount > 0 || tombstonesCount > 0) {
      console.log(`[Sync] Pushing ${totalPendingCount} pending records & ${tombstonesCount} tombstones to cloud...`);

      const pushRes = await makeRequest(`${cloudUrl}/api/sync/push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }, {
        clientSyncId,
        changes: {
          products: pending.products,
          customers: pending.customers,
          sales: pending.sales,
          suppliers: pending.suppliers,
          purchaseOrders: pending.purchaseOrders
        },
        deletions: pending.tombstones
      });

      if (pushRes.statusCode !== 202 && pushRes.statusCode !== 200) {
        throw new Error(`Cloud push rejected with status ${pushRes.statusCode}: ${JSON.stringify(pushRes.data)}`);
      }

      const jobId = pushRes.data.jobId;

      // STEP 2: POLL STATUS
      if (jobId) {
        console.log(`[Sync] Polling job status for jobId: ${jobId}...`);
        let jobFinished = false;
        let attempts = 0;

        while (!jobFinished && attempts < MAX_POLL_ATTEMPTS) {
          attempts++;
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

          const statusRes = await makeRequest(`${cloudUrl}/api/sync/status/${jobId}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` }
          });

          if (statusRes.statusCode === 200) {
            const status = statusRes.data.status;
            if (status === 'completed') {
              jobFinished = true;
              console.log('[Sync] Cloud processing completed successfully.');
            } else if (status === 'failed') {
              throw new Error(`Cloud background sync job failed: ${statusRes.data.error || 'Unknown error'}`);
            }
          }
        }

        if (!jobFinished) {
          throw new Error('Cloud background sync job polling timed out');
        }
      }

      // STEP 3: MARK ACKNOWLEDGED RECORDS SYNCED
      markLocalRecordsSynced(pending, nowIso);
      recordsPushed = totalPendingCount;
      try {
        setSyncMetadata('pending_client_sync_id', '');
      } catch (_) {}
      console.log(`[Sync] Confirmed: ${recordsPushed} records marked synced locally.`);
    } else {
      try {
        setSyncMetadata('pending_client_sync_id', '');
      } catch (_) {}
    }

    // -------------------------------------------------------------
    // STEP 4: PULL CLOUD CHANGES
    // -------------------------------------------------------------
    const lastSyncCursor = getSyncMetadata('last_cloud_sync_time') || '1970-01-01T00:00:00.000Z';
    console.log(`[Sync] Pulling cloud changes since cursor: ${lastSyncCursor}...`);

    const pullUrl = `${cloudUrl}/api/sync/pull?lastSyncTime=${encodeURIComponent(lastSyncCursor)}`;
    const pullRes = await makeRequest(pullUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });

    let recordsPulled = 0;
    let tombstonesPulled = 0;
    let newSyncCursor = nowIso;

    if (pullRes.statusCode === 200 && pullRes.data) {
      const incomingChanges = pullRes.data.changes || {};
      const incomingTombstones = pullRes.data.tombstones || [];
      newSyncCursor = pullRes.data.serverTime || nowIso;

      const applyRes = applyPulledChanges({
        ...incomingChanges,
        tombstones: incomingTombstones
      }, defaultOrgId);

      recordsPulled = applyRes.appliedCount;
      tombstonesPulled = applyRes.tombstonesCount;

      // Update cursor in SQLite metadata only after successful transaction
      setSyncMetadata('last_cloud_sync_time', newSyncCursor);
      console.log(`[Sync] Pulled ${recordsPulled} updates and ${tombstonesPulled} tombstones from cloud.`);
    }

    // Complete telemetry in sync_history
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE sync_history SET
        status = 'completed',
        records_pushed = ?,
        records_pulled = ?,
        tombstones_pushed = ?,
        tombstones_pulled = ?,
        cursor_used = ?,
        cursor_new = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      recordsPushed,
      recordsPulled,
      tombstonesCount,
      tombstonesPulled,
      lastSyncCursor,
      newSyncCursor,
      completedAt,
      historyId
    );

    return {
      success: true,
      clientSyncId,
      recordsPushed,
      recordsPulled,
      tombstonesPushed: tombstonesCount,
      tombstonesPulled,
      lastSyncCursor,
      newSyncCursor,
      completedAt
    };
  } catch (error) {
    console.error('[Sync Error]', error.message);
    const failedAt = new Date().toISOString();
    db.prepare(`
      UPDATE sync_history SET
        status = 'failed',
        error_message = ?,
        completed_at = ?
      WHERE id = ?
    `).run(error.message, failedAt, historyId);

    throw error;
  }
}

module.exports = {
  makeRequest,
  collectPendingChanges,
  markLocalRecordsSynced,
  applyPulledChanges,
  getSyncMetadata,
  setSyncMetadata,
  performBidirectionalSync
};
