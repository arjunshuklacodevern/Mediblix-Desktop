/**
 * Mediblix Desktop — User & Auth SQLite Repository
 */

const { getDatabase, generateId, resolveOrgInternalId } = require('./baseRepository');
const organizationRepository = require('./organizationRepository');
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e1) {
  try {
    bcrypt = require(require('path').join(__dirname, '../../backend/node_modules/bcryptjs'));
  } catch (e2) {
    throw new Error('bcryptjs module not found: ' + e2.message);
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    lastPassword: row.last_password,
    passwordHistory: JSON.parse(row.password_history || '[]'),
    role: row.role,
    isAdmin: Boolean(row.is_admin),
    organization: row.organization_id ? organizationRepository.findById(row.organization_id) : null,
    organizationId: row.organization_id,
    sessionVersion: row.session_version,
    activeSessionKey: row.active_session_key,
    activeDeviceInfo: JSON.parse(row.active_device_info || '{}'),
    deviceAccessLogs: JSON.parse(row.device_access_logs || '[]'),
    conflictAttemptsCount: row.conflict_attempts_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const userRepository = {
  findByEmail(email) {
    if (!email) return null;
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    return mapRow(row);
  },

  findById(idOrIdStr) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    return mapRow(row);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const orgInternalId = resolveOrgInternalId(data.organization || data.organizationId);
    const now = new Date().toISOString();

    let passwordHash = data.password;
    if (!passwordHash.startsWith('$2a$') && !passwordHash.startsWith('$2b$')) {
      const salt = bcrypt.genSaltSync(10);
      passwordHash = bcrypt.hashSync(passwordHash, salt);
    }

    const info = db.prepare(`
      INSERT INTO users (
        _id, organization_id, name, email, password, role, is_admin,
        session_version, active_session_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      orgInternalId,
      data.name,
      data.email.toLowerCase().trim(),
      passwordHash,
      data.role || 'staff',
      data.isAdmin ? 1 : 0,
      1,
      data.activeSessionKey || null,
      now,
      now
    );

    return this.findById(info.lastInsertRowid);
  },

  matchPassword(enteredPassword, storedHash) {
    if (!enteredPassword || !storedHash) return false;
    return bcrypt.compareSync(enteredPassword, storedHash);
  },

  recordConflictAttempt(userIdOrIdStr, logEntry) {
    const user = this.findById(userIdOrIdStr);
    if (!user) return null;
    const db = getDatabase();
    const now = new Date().toISOString();
    const logs = user.deviceAccessLogs || [];
    logs.unshift(logEntry);
    if (logs.length > 50) logs.length = 50;

    const newConflictCount = (user.conflictAttemptsCount || 0) + 1;
    db.prepare(`
      UPDATE users
      SET conflict_attempts_count = ?, device_access_logs = ?, updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(newConflictCount, JSON.stringify(logs), now, String(userIdOrIdStr), String(userIdOrIdStr));

    return this.findById(userIdOrIdStr);
  },

  recordLoginSuccess(userIdOrIdStr, sessionKey, deviceInfo, logEntry) {
    const user = this.findById(userIdOrIdStr);
    if (!user) return null;
    const db = getDatabase();
    const now = new Date().toISOString();
    const logs = user.deviceAccessLogs || [];
    if (logEntry) {
      logs.unshift(logEntry);
      if (logs.length > 50) logs.length = 50;
    }

    db.prepare(`
      UPDATE users
      SET active_session_key = ?, active_device_info = ?, device_access_logs = ?, updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      sessionKey,
      JSON.stringify(deviceInfo || {}),
      JSON.stringify(logs),
      now,
      String(userIdOrIdStr),
      String(userIdOrIdStr)
    );

    return this.findById(userIdOrIdStr);
  },

  updateSession(userIdOrIdStr, sessionKey, deviceInfo) {
    return this.recordLoginSuccess(userIdOrIdStr, sessionKey, deviceInfo, null);
  },

  clearSession(userIdOrIdStr, logEntry) {
    const user = this.findById(userIdOrIdStr);
    if (!user) return null;
    const db = getDatabase();
    const now = new Date().toISOString();
    const logs = user.deviceAccessLogs || [];
    if (logEntry) {
      logs.unshift(logEntry);
      if (logs.length > 50) logs.length = 50;
    }

    db.prepare(`
      UPDATE users
      SET active_session_key = NULL, device_access_logs = ?, updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(JSON.stringify(logs), now, String(userIdOrIdStr), String(userIdOrIdStr));

    return this.findById(userIdOrIdStr);
  },

  updatePassword(userIdOrIdStr, newPassword, logEntry) {
    const user = this.findById(userIdOrIdStr);
    if (!user) return null;
    const db = getDatabase();
    const now = new Date().toISOString();

    const previousPin = user.lastPassword || "Previously Set Password";
    const history = user.passwordHistory || [];
    if (user.lastPassword) {
      history.unshift({
        pin: user.lastPassword,
        deactivatedAt: now,
        status: "Disabled",
      });
      if (history.length > 15) history.length = 15;
    }

    let passwordHash = newPassword;
    if (!passwordHash.startsWith("$2a$") && !passwordHash.startsWith("$2b$")) {
      const salt = bcrypt.genSaltSync(10);
      passwordHash = bcrypt.hashSync(passwordHash, salt);
    }

    const logs = user.deviceAccessLogs || [];
    if (logEntry) {
      logs.unshift(logEntry);
      if (logs.length > 50) logs.length = 50;
    }

    const newSessionVersion = (user.sessionVersion || 1) + 1;

    db.prepare(`
      UPDATE users SET
        password = ?,
        last_password = ?,
        password_history = ?,
        active_session_key = NULL,
        session_version = ?,
        device_access_logs = ?,
        updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      passwordHash,
      newPassword,
      JSON.stringify(history),
      newSessionVersion,
      JSON.stringify(logs),
      now,
      String(userIdOrIdStr),
      String(userIdOrIdStr)
    );

    return {
      user: this.findById(userIdOrIdStr),
      previousPin,
      passwordHistory: history,
    };
  },

  resetDeviceSessionsForOrg(orgId, logEntry) {
    const orgInternalId = resolveOrgInternalId(orgId);
    if (!orgInternalId) return 0;
    const db = getDatabase();
    const rows = db.prepare("SELECT id, device_access_logs, session_version FROM users WHERE organization_id = ?").all(orgInternalId);
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE users SET
        active_session_key = NULL,
        session_version = session_version + 1,
        conflict_attempts_count = 0,
        device_access_logs = ?,
        updated_at = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      const logs = JSON.parse(row.device_access_logs || "[]");
      if (logEntry) {
        logs.unshift(logEntry);
        if (logs.length > 50) logs.length = 50;
      }
      stmt.run(JSON.stringify(logs), now, row.id);
    }

    return rows.length;
  }
};

module.exports = userRepository;
