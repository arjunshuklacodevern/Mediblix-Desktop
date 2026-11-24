/**
 * Mediblix Desktop — Customer SQLite Repository
 */

const { getDatabase, generateId, resolveOrgInternalId } = require('./baseRepository');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    organization: row.organization_id,
    organizationId: row.organization_id,
    name: row.name,
    mobile: row.mobile,
    email: row.email,
    address: row.address,
    notes: row.notes,
    totalPurchases: row.total_purchases || 0,
    purchaseHistory: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const customerRepository = {
  findAll(orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let rows;
    if (orgInternalId) {
      rows = db.prepare('SELECT * FROM customers WHERE organization_id = ? ORDER BY created_at DESC').all(orgInternalId);
    } else {
      rows = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
    }
    const customers = rows.map(mapRow);
    if (customers.length === 0) return customers;

    // Attach purchaseHistory IDs for each customer in a single query
    const saleRows = orgInternalId
      ? db.prepare('SELECT _id, customer_id FROM sales WHERE organization_id = ? AND customer_id IS NOT NULL').all(orgInternalId)
      : db.prepare('SELECT _id, customer_id FROM sales WHERE customer_id IS NOT NULL').all();

    const salesByCustId = {};
    for (const s of saleRows) {
      if (!salesByCustId[s.customer_id]) {
        salesByCustId[s.customer_id] = [];
      }
      salesByCustId[s.customer_id].push(s._id);
    }

    for (const c of customers) {
      c.purchaseHistory = salesByCustId[c.id] || [];
    }

    return customers;
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM customers WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM customers WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }
    return mapRow(row);
  },

  findByMobile(mobile, orgId) {
    if (!mobile) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM customers WHERE mobile = ? AND organization_id = ?').get(String(mobile).trim(), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM customers WHERE mobile = ?').get(String(mobile).trim());
    }
    return mapRow(row);
  },

  search(keyword, orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    const pattern = `%${(keyword || '').trim()}%`;
    let rows;
    if (orgInternalId) {
      rows = db.prepare(`
        SELECT * FROM customers
        WHERE organization_id = ?
          AND (name LIKE ? OR mobile LIKE ? OR email LIKE ?)
        ORDER BY created_at DESC
      `).all(orgInternalId, pattern, pattern, pattern);
    } else {
      rows = db.prepare(`
        SELECT * FROM customers
        WHERE (name LIKE ? OR mobile LIKE ? OR email LIKE ?)
        ORDER BY created_at DESC
      `).all(pattern, pattern, pattern);
    }
    return rows.map(mapRow);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO customers (
        _id, organization_id, name, mobile, email, address, notes, total_purchases, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      orgInternalId,
      data.name,
      String(data.mobile).trim(),
      data.email || null,
      data.address || null,
      data.notes || null,
      Number(data.totalPurchases) || 0,
      now,
      now
    );

    return this.findById(info.lastInsertRowid);
  },

  update(idOrIdStr, data, orgId) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr, orgId);
    if (!existing) return null;

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE customers SET
        name = COALESCE(?, name),
        mobile = COALESCE(?, mobile),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        notes = COALESCE(?, notes),
        updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      data.name !== undefined ? data.name : null,
      data.mobile !== undefined ? String(data.mobile).trim() : null,
      data.email !== undefined ? data.email : null,
      data.address !== undefined ? data.address : null,
      data.notes !== undefined ? data.notes : null,
      now,
      String(idOrIdStr),
      String(idOrIdStr)
    );

    return this.findById(idOrIdStr, orgId);
  },

  delete(idOrIdStr, orgId) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr, orgId);
    if (!existing) return false;

    const orgInternalId = resolveOrgInternalId(orgId);
    if (orgInternalId) {
      db.prepare('DELETE FROM customers WHERE (_id = ? OR id = ?) AND organization_id = ?').run(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      db.prepare('DELETE FROM customers WHERE _id = ? OR id = ?').run(String(idOrIdStr), String(idOrIdStr));
    }
    return true;
  }
};

module.exports = customerRepository;
