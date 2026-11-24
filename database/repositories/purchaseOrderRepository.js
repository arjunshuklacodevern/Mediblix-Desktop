/**
 * Mediblix Desktop — Purchase Orders SQLite Repository
 */

const { getDatabase, runInTransaction, generateId, resolveOrgInternalId } = require('./baseRepository');
const productRepository = require('./productRepository');

function mapItemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productName: row.product_name,
    sku: row.sku,
    quantity: row.quantity,
    price: row.price,
    createdAt: row.created_at
  };
}

function mapPoRow(poRow, itemRows = []) {
  if (!poRow) return null;
  return {
    _id: poRow._id,
    id: poRow.id,
    organization: poRow.organization_id,
    organizationId: poRow.organization_id,
    supplierName: poRow.supplier_name,
    supplierEmail: poRow.supplier_email,
    supplierPhone: poRow.supplier_phone,
    deliveryAddress: poRow.delivery_address,
    totalAmount: poRow.total_amount,
    status: poRow.status,
    expectedDeliveryDate: poRow.expected_delivery_date,
    items: itemRows.map(mapItemRow),
    createdAt: poRow.created_at,
    updatedAt: poRow.updated_at
  };
}

const purchaseOrderRepository = {
  findAll(orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let rows;
    if (orgInternalId) {
      rows = db.prepare('SELECT * FROM purchase_orders WHERE organization_id = ? ORDER BY created_at DESC').all(orgInternalId);
    } else {
      rows = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all();
    }

    return rows.map(r => {
      const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(r.id);
      return mapPoRow(r, items);
    });
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM purchase_orders WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM purchase_orders WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }
    if (!row) return null;

    const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(row.id);
    return mapPoRow(row, items);
  },

  create(data) {
    return runInTransaction(() => {
      const db = getDatabase();
      const _id = data._id || generateId();
      const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
      const now = new Date().toISOString();

      let totalAmount = 0;
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        totalAmount += (Number(item.price) || 0) * (Number(item.quantity) || 0);
      }
      if (data.totalAmount !== undefined) {
        totalAmount = Number(data.totalAmount);
      }

      const poInfo = db.prepare(`
        INSERT INTO purchase_orders (
          _id, organization_id, supplier_name, supplier_email, supplier_phone,
          delivery_address, total_amount, status, expected_delivery_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        _id,
        orgInternalId,
        data.supplierName,
        data.supplierEmail || null,
        data.supplierPhone || null,
        data.deliveryAddress || null,
        totalAmount,
        data.status || 'Pending',
        data.expectedDeliveryDate || null,
        now,
        now
      );

      const insertedPoId = poInfo.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO purchase_order_items (purchase_order_id, product_name, sku, quantity, price, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        insertItem.run(
          insertedPoId,
          item.productName,
          item.sku,
          Number(item.quantity) || 1,
          Number(item.price) || 0,
          now
        );
      }

      return this.findById(insertedPoId, orgInternalId);
    });
  },

  updateStatus(idOrIdStr, status, orgId) {
    return runInTransaction(() => {
      const db = getDatabase();
      const orgInternalId = resolveOrgInternalId(orgId);
      const existing = this.findById(idOrIdStr, orgInternalId);
      if (!existing) {
        const err = new Error('Purchase order not found');
        err.statusCode = 404;
        throw err;
      }

      if (existing.status === 'Delivered') {
        const err = new Error('Cannot change status of an already delivered purchase order');
        err.statusCode = 400;
        throw err;
      }

      const validStatuses = ['Pending', 'In Transit', 'Delivered'];
      if (!validStatuses.includes(status)) {
        const err = new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
        err.statusCode = 400;
        throw err;
      }

      const now = new Date().toISOString();

      // If transitioning to Delivered, receive items into product inventory atomically
      if (status === 'Delivered') {
        for (const item of existing.items) {
          const qty = Number(item.quantity) || 1;
          const price = Number(item.price) || 0;
          const prod = productRepository.findBySku(item.sku, orgInternalId);
          if (prod) {
            productRepository.incrementStock(prod.id, qty);
          } else {
            productRepository.create({
              organization: orgInternalId,
              name: item.productName,
              sku: item.sku,
              quantity: qty,
              price: price,
              category: 'General'
            });
          }
        }
      }

      db.prepare(`
        UPDATE purchase_orders
        SET status = ?, updated_at = ?
        WHERE _id = ? OR id = ?
      `).run(status, now, String(idOrIdStr), String(idOrIdStr));

      return this.findById(idOrIdStr, orgInternalId);
    });
  },

  delete(idOrIdStr, orgId) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr, orgId);
    if (!existing) return false;

    const orgInternalId = resolveOrgInternalId(orgId);
    if (orgInternalId) {
      db.prepare('DELETE FROM purchase_orders WHERE (_id = ? OR id = ?) AND organization_id = ?').run(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      db.prepare('DELETE FROM purchase_orders WHERE _id = ? OR id = ?').run(String(idOrIdStr), String(idOrIdStr));
    }
    return true;
  }
};

module.exports = purchaseOrderRepository;
