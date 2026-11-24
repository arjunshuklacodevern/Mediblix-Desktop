/**
 * Mediblix Desktop — Import History SQLite Repository
 */

const { getDatabase, generateId, resolveOrgInternalId } = require('./baseRepository');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    organization: row.organization_id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    totalProducts: row.total_products,
    totalQuantity: row.total_quantity,
    totalValue: row.total_value,
    items: JSON.parse(row.items_json || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const importHistoryRepository = {
  findAll(orgId) {
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let rows;
    if (orgInternalId) {
      rows = db.prepare('SELECT * FROM import_history WHERE organization_id = ? ORDER BY created_at DESC').all(orgInternalId);
    } else {
      rows = db.prepare('SELECT * FROM import_history ORDER BY created_at DESC').all();
    }
    return rows.map(mapRow);
  },

  findById(idOrIdStr, orgId) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const orgInternalId = resolveOrgInternalId(orgId);
    let row;
    if (orgInternalId) {
      row = db.prepare('SELECT * FROM import_history WHERE (_id = ? OR id = ?) AND organization_id = ?').get(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      row = db.prepare('SELECT * FROM import_history WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    }
    return mapRow(row);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO import_history (
        _id, organization_id, file_name, total_products, total_quantity, total_value, items_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      orgInternalId,
      data.fileName || 'Manual Entry',
      Number(data.totalProducts) || 0,
      Number(data.totalQuantity) || 0,
      Number(data.totalValue) || 0,
      JSON.stringify(data.items || []),
      now,
      now
    );

    return this.findById(info.lastInsertRowid);
  },

  delete(idOrIdStr, orgId) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr, orgId);
    if (!existing) return false;

    const orgInternalId = resolveOrgInternalId(orgId);
    if (orgInternalId) {
      db.prepare('DELETE FROM import_history WHERE (_id = ? OR id = ?) AND organization_id = ?').run(String(idOrIdStr), String(idOrIdStr), orgInternalId);
    } else {
      db.prepare('DELETE FROM import_history WHERE _id = ? OR id = ?').run(String(idOrIdStr), String(idOrIdStr));
    }
    return true;
  }
};

module.exports = importHistoryRepository;
