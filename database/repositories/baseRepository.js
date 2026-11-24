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

module.exports = {
  getDatabase,
  runInTransaction,
  generateId,
  resolveOrgInternalId
};
