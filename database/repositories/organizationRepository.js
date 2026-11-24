/**
 * Mediblix Desktop — Organization SQLite Repository
 */

const { getDatabase, generateId } = require('./baseRepository');

function mapRow(row) {
  if (!row) return null;
  return {
    _id: row._id,
    id: row.id,
    name: row.name,
    code: row.code,
    contactPerson: row.contact_person,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    address: row.address,
    status: row.status,
    plan: row.plan,
    subscriptionStartDate: row.subscription_start_date,
    subscriptionExpiresAt: row.subscription_expires_at,
    billingCycle: row.billing_cycle,
    billingAmount: row.billing_amount,
    singleDeviceEnforced: Boolean(row.single_device_enforced),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const organizationRepository = {
  findAll() {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM organizations ORDER BY name ASC').all();
    return rows.map(mapRow);
  },

  findById(idOrIdStr) {
    if (!idOrIdStr) return null;
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM organizations WHERE _id = ? OR id = ?').get(String(idOrIdStr), String(idOrIdStr));
    return mapRow(row);
  },

  findByCode(code) {
    if (!code) return null;
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM organizations WHERE code = ?').get(String(code).toUpperCase().trim());
    return mapRow(row);
  },

  create(data) {
    const db = getDatabase();
    const _id = data._id || generateId();
    const code = (data.code || 'ORG_' + _id.slice(0, 6)).toUpperCase().trim();
    const status = data.status || 'Active';
    const plan = data.plan || 'Trial';
    const now = new Date().toISOString();
    const expiresAt = data.subscriptionExpiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const info = db.prepare(`
      INSERT INTO organizations (
        _id, name, code, contact_person, contact_email, contact_phone, address,
        status, plan, subscription_start_date, subscription_expires_at,
        billing_cycle, billing_amount, single_device_enforced, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      _id,
      data.name,
      code,
      data.contactPerson || 'Administrator',
      data.contactEmail || '',
      data.contactPhone || '',
      data.address || '',
      status,
      plan,
      data.subscriptionStartDate || now,
      expiresAt,
      data.billingCycle || 'Monthly',
      Number(data.billingAmount) || 0,
      data.singleDeviceEnforced !== false ? 1 : 0,
      now,
      now
    );

    return this.findById(info.lastInsertRowid);
  },

  updateStatus(idOrIdStr, status) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE organizations
      SET status = ?, updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(status, now, String(idOrIdStr), String(idOrIdStr));
    return this.findById(idOrIdStr);
  },

  update(idOrIdStr, data) {
    const db = getDatabase();
    const existing = this.findById(idOrIdStr);
    if (!existing) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE organizations SET
        name = COALESCE(?, name),
        contact_person = COALESCE(?, contact_person),
        contact_email = COALESCE(?, contact_email),
        contact_phone = COALESCE(?, contact_phone),
        address = COALESCE(?, address),
        plan = COALESCE(?, plan),
        status = COALESCE(?, status),
        subscription_expires_at = COALESCE(?, subscription_expires_at),
        billing_amount = COALESCE(?, billing_amount),
        single_device_enforced = COALESCE(?, single_device_enforced),
        updated_at = ?
      WHERE _id = ? OR id = ?
    `).run(
      data.name !== undefined ? data.name : null,
      data.contactPerson !== undefined ? data.contactPerson : null,
      data.contactEmail !== undefined ? data.contactEmail.toLowerCase().trim() : null,
      data.contactPhone !== undefined ? data.contactPhone : null,
      data.address !== undefined ? data.address : null,
      data.plan !== undefined ? data.plan : null,
      data.status !== undefined ? data.status : null,
      data.subscriptionExpiresAt !== undefined ? data.subscriptionExpiresAt : null,
      data.billingAmount !== undefined ? Number(data.billingAmount) : null,
      data.singleDeviceEnforced !== undefined ? (data.singleDeviceEnforced ? 1 : 0) : null,
      now,
      String(idOrIdStr),
      String(idOrIdStr)
    );

    return this.findById(idOrIdStr);
  }
};

module.exports = organizationRepository;
