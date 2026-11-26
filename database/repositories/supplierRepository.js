/**
 * Mediblix Desktop — Supplier SQLite Repository
 */

const { getDatabase, generateId, resolveOrgInternalId, recordTombstone } = require('./baseRepository');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    organization: row.organization_id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const supplierRepository = {
  findAll(orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let rows;
    if (orgInternalId) {
      rows = db.prepare('SELECT * FROM suppliers WHERE organization_id = ? ORDER BY name ASC').all(orgInternalId);
    } else {
      rows = db.prepare('SELECT * FROM suppliers ORDER BY name ASC').all();
    }
    return rows.map(mapRow);
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM suppliers WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM suppliers WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }
    return mapRow(row);
  },

  findByName(name, orgId) {
    if (!name) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM suppliers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND organization_id = ?').get(name, orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM suppliers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(name);
    }
    return mapRow(row);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO suppliers (_id, organization_id, name, email, phone, address, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      orgInternalId,
      String(data.name).trim(),
      data.email || null,
      data.phone || null,
      data.address || null,
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
      UPDATE suppliers SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        sync_status = 'pending',
        updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      data.name !== undefined ? String(data.name).trim() : null,
      data.email !== undefined ? data.email : null,
      data.phone !== undefined ? data.phone : null,
      data.address !== undefined ? data.address : null,
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

    recordTombstone('supplier', existing._id, existing.organizationId);

    const orgInternalId = resolveOrgInternalId(orgId);
    if (orgInternalId) {
      db.prepare('DELETE FROM suppliers WHERE (_id = ? OR id = ?) AND organization_id = ?').run(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      db.prepare('DELETE FROM suppliers WHERE _id = ? OR id = ?').run(String(idOrIdStr), String(idOrIdStr));
    }
    return true;
  }
};

module.exports = supplierRepository;
