/**
 * Mediblix Desktop — Product & Inventory SQLite Repository
 */

const { getDatabase, generateId, resolveOrgInternalId, recordTombstone } = require('./baseRepository');

function computeStatus(quantity) {
  const qty = Number(quantity) || 0;
  if (qty === 0) return 'Out of Stock';
  if (qty < 10) return 'Low Stock';
  return 'In Stock';
}

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    organization: row.organization_id,
    organizationId: row.organization_id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    quantity: row.quantity,
    price: row.price,
    status: row.status,
    expiryDate: row.expiry_date,
    mfgDate: row.mfg_date,
    hsn: row.hsn,
    packaging: row.packaging,
    tabletsPerStrip: row.tablets_per_strip,
    batchNumber: row.batch_number,
    manufacturer: row.manufacturer,
    mrp: row.mrp,
    costPrice: row.cost_price,
    minStock: row.min_stock,
    rackLocation: row.rack_location,
    description: row.description,
    unit: row.unit,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const productRepository = {
  findAll(orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let rows;
    if (orgInternalId) {
      rows = db.prepare('SELECT * FROM products WHERE organization_id = ? ORDER BY name ASC').all(orgInternalId);
    } else {
      rows = db.prepare('SELECT * FROM products ORDER BY name ASC').all();
    }
    return rows.map(mapRow);
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM products WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM products WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }
    return mapRow(row);
  },

  findBySku(sku, orgId) {
    if (!sku) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM products WHERE sku = ? AND organization_id = ?').get(String(sku).trim(), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM products WHERE sku = ?').get(String(sku).trim());
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
        SELECT * FROM products
        WHERE organization_id = ?
          AND (name LIKE ? OR sku LIKE ? OR category LIKE ?)
        ORDER BY name ASC
      `).all(orgInternalId, pattern, pattern, pattern);
    } else {
      rows = db.prepare(`
        SELECT * FROM products
        WHERE (name LIKE ? OR sku LIKE ? OR category LIKE ?)
        ORDER BY name ASC
      `).all(pattern, pattern, pattern);
    }
    return rows.map(mapRow);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
    const now = new Date().toISOString();
    const quantity = Number(data.quantity) || 0;
    const status = data.status || computeStatus(quantity);

    const info = db.prepare(`
      INSERT INTO products (
        _id, organization_id, name, sku, category, quantity, price, status,
        expiry_date, mfg_date, hsn, packaging, tablets_per_strip, batch_number,
        manufacturer, mrp, cost_price, min_stock, rack_location, description, unit,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      orgInternalId,
      data.name,
      String(data.sku).trim(),
      data.category,
      quantity,
      Number(data.price) || 0,
      status,
      data.expiryDate || null,
      data.mfgDate || null,
      data.hsn || null,
      data.packaging || '10 Tablets / Strip',
      Number(data.tabletsPerStrip) || 10,
      data.batchNumber || null,
      data.manufacturer || null,
      Number(data.mrp) || 0,
      Number(data.costPrice) || 0,
      Number(data.minStock) || 10,
      data.rackLocation || null,
      data.description || null,
      data.unit || 'Tablet',
      now,
      now
    );

    return this.findById(info.lastInsertRowid);
  },

  update(idOrIdStr, data) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr);
    if (!existing) return null;

    const quantity = data.quantity !== undefined ? Number(data.quantity) : existing.quantity;
    const status = data.status || computeStatus(quantity);
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE products SET
        name = COALESCE(?, name),
        sku = COALESCE(?, sku),
        category = COALESCE(?, category),
        quantity = ?,
        price = COALESCE(?, price),
        status = ?,
        expiry_date = COALESCE(?, expiry_date),
        mfg_date = COALESCE(?, mfg_date),
        hsn = COALESCE(?, hsn),
        packaging = COALESCE(?, packaging),
        tablets_per_strip = COALESCE(?, tablets_per_strip),
        sync_status = 'pending',
        updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      data.name !== undefined ? data.name : null,
      data.sku !== undefined ? String(data.sku).trim() : null,
      data.category !== undefined ? data.category : null,
      quantity,
      data.price !== undefined ? Number(data.price) : null,
      status,
      data.expiryDate !== undefined ? data.expiryDate : null,
      data.mfgDate !== undefined ? data.mfgDate : null,
      data.hsn !== undefined ? data.hsn : null,
      data.packaging !== undefined ? data.packaging : null,
      data.tabletsPerStrip !== undefined ? Number(data.tabletsPerStrip) : null,
      now,
      String(idOrIdStr),
      String(idOrIdStr)
    );

    return this.findById(idOrIdStr);
  },

  decrementStock(productId, qty) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const res = db.prepare(`
      UPDATE products
      SET quantity = quantity - ?,
          status = CASE
            WHEN quantity - ? <= 0 THEN 'Out of Stock'
            WHEN quantity - ? < 10 THEN 'Low Stock'
            ELSE 'In Stock'
          END,
          sync_status = 'pending',
          updated_at = ?
      WHERE id = ? AND quantity >= ?
    `).run(qty, qty, qty, now, productId, qty);
    return res.changes > 0;
  },

  incrementStock(productId, qty) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const res = db.prepare(`
      UPDATE products
      SET quantity = quantity + ?,
          status = CASE
            WHEN quantity + ? <= 0 THEN 'Out of Stock'
            WHEN quantity + ? < 10 THEN 'Low Stock'
            ELSE 'In Stock'
          END,
          sync_status = 'pending',
          updated_at = ?
      WHERE id = ?
    `).run(qty, qty, qty, now, productId);
    return res.changes > 0;
  },

  delete(idOrIdStr) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr);
    if (existing) {
      recordTombstone('product', existing._id, existing.organizationId);
    }
    const res = db.prepare('DELETE FROM products WHERE _id = ? OR id = ?').run(String(idOrIdStr), String(idOrIdStr));
    return res.changes > 0;
  }
};

module.exports = productRepository;
