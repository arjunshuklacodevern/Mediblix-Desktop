/**
 * Mediblix Desktop — Base Repository Utilities
 *
 * Provides shared row-to-model mappers and query utilities ensuring
 * 100% backward compatibility with React frontends expecting camelCase fields
 * and 24-character hexadecimal `_id` strings.
 */

const { getDatabase, runInTransaction, generateId } = require('../db');

/**
 * Resolves an organization's integer internal ID from either an integer id or string _id
 */
function resolveOrgInternalId(orgIdOrCode) {
  if (!orgIdOrCode) return null;
  const db = getDatabase();
  
  if (typeof orgIdOrCode === 'number' || (/^\d+$/.test(orgIdOrCode) && String(Number(orgIdOrCode)) === String(orgIdOrCode))) {
    const row = db.prepare('SELECT id FROM organizations WHERE id = ?').get(Number(orgIdOrCode));
    if (row) return row.id;
  }
  
  const byId = db.prepare('SELECT id FROM organizations WHERE _id = ? OR code = ?').get(String(orgIdOrCode), String(orgIdOrCode));
  if (byId) return byId.id;

  // Fallback to DEFAULT organization
  const defaultOrg = db.prepare('SELECT id FROM organizations WHERE code = ?').get('DEFAULT');
  return defaultOrg ? defaultOrg.id : null;
}

/**
 * Records a deletion tombstone for synchronization
 */
function recordTombstone(entityType, entityMongoId, organizationId) {
  if (!entityMongoId) return;
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO sync_tombstones (entity_type, entity_mongo_id, organization_id, deleted_at, sync_status)
      VALUES (?, ?, ?, datetime('now'), 'pending')
    `).run(entityType, String(entityMongoId), organizationId ? resolveOrgInternalId(organizationId) : null);
  } catch (err) {
    // If table doesn't exist yet (e.g., pre-migration tests), ignore safely
  }
}

module.exports = {
  getDatabase,
  runInTransaction,
  generateId,
  resolveOrgInternalId,
  recordTombstone
};
