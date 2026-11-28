import asyncHandler from "express-async-handler";
import crypto from "crypto";
import repositories from "../../database/repositories/index.js";
import generateToken from "../utils/generateToken.js";

const { getDatabase, organizationRepository, userRepository, saleRepository } = repositories;

const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const normalizedEmail = email ? email.toLowerCase().trim() : "";
  const user = userRepository.findByEmail(normalizedEmail);

  if (!user || !userRepository.matchPassword(password, user.password)) {
    res.status(401);
    throw new Error("Invalid admin credentials");
  }

  if (user.role !== "superadmin" && !user.isAdmin) {
    res.status(403);
    throw new Error("Access restricted to platform administrators");
  }

  res.json({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: "superadmin",
    isAdmin: true,
    token: generateToken(user._id),
  });
});

const getAdminStats = asyncHandler(async (req, res) => {
  const db = getDatabase();
  const totalOrgs = db.prepare("SELECT COUNT(*) as count FROM organizations").get().count;
  const activeOrgs = db.prepare("SELECT COUNT(*) as count FROM organizations WHERE status = 'Active'").get().count;
  const frozenOrgs = db.prepare("SELECT COUNT(*) as count FROM organizations WHERE status = 'Frozen'").get().count;
  const totalProducts = db.prepare("SELECT COUNT(*) as count FROM products").get().count;
  const totalSalesCount = db.prepare("SELECT COUNT(*) as count FROM sales").get().count;
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;

  const now = new Date().toISOString();
  const expiredOrgs = db.prepare(
    "SELECT COUNT(*) as count FROM organizations WHERE subscription_expires_at IS NOT NULL AND subscription_expires_at < ?"
  ).get(now).count;

  const revRow = db.prepare("SELECT COALESCE(SUM(total_amount), 0) as totalRevenue FROM sales").get();
  const totalRevenue = revRow ? revRow.totalRevenue : 0;

  res.json({
    totalOrgs,
    activeOrgs,
    frozenOrgs,
    expiredOrgs,
    totalProducts,
    totalSalesCount,
    totalUsers,
    totalRevenue,
  });
});

const getOrganizations = asyncHandler(async (req, res) => {
  const db = getDatabase();
  const { search, status } = req.query;

  let query = "SELECT * FROM organizations WHERE 1=1";
  const params = [];

  if (status && status !== "All") {
    query += " AND status = ?";
    params.push(status);
  }

  if (search && search.trim()) {
    const pattern = `%${search.trim()}%`;
    query += " AND (name LIKE ? OR code LIKE ? OR contact_email LIKE ? OR contact_person LIKE ?)";
    params.push(pattern, pattern, pattern, pattern);
  }

  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...params);
  const now = new Date();

  const orgSummaries = rows.map((orgRow) => {
    const orgInternalId = orgRow.id;
    const productCount = db.prepare("SELECT COUNT(*) as count FROM products WHERE organization_id = ?").get(orgInternalId).count;
    const saleCount = db.prepare("SELECT COUNT(*) as count FROM sales WHERE organization_id = ?").get(orgInternalId).count;
    const userCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE organization_id = ?").get(orgInternalId).count;

    const revRow = db.prepare("SELECT COALESCE(SUM(total_amount), 0) as rev FROM sales WHERE organization_id = ?").get(orgInternalId);
    const revenue = revRow ? revRow.rev : 0;

    const orgAdminRow = db.prepare("SELECT * FROM users WHERE organization_id = ? AND role = 'org_admin' LIMIT 1").get(orgInternalId);
    const orgAdmin = orgAdminRow ? userRepository.findById(orgAdminRow.id) : null;

    const expiresAt = orgRow.subscription_expires_at ? new Date(orgRow.subscription_expires_at) : null;
    const isExpired = expiresAt ? expiresAt < now : false;
    const diffMs = expiresAt ? expiresAt - now : 0;
    const daysRemaining = expiresAt ? Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24))) : 0;

    return {
      _id: orgRow._id,
      id: orgRow.id,
      name: orgRow.name,
      code: orgRow.code,
      contactPerson: orgRow.contact_person,
      contactEmail: orgRow.contact_email,
      contactPhone: orgRow.contact_phone,
      address: orgRow.address,
      status: orgRow.status,
      plan: orgRow.plan,
      subscriptionStartDate: orgRow.subscription_start_date,
      subscriptionExpiresAt: orgRow.subscription_expires_at,
      billingCycle: orgRow.billing_cycle,
      billingAmount: orgRow.billing_amount,
      singleDeviceEnforced: Boolean(orgRow.single_device_enforced),
      createdAt: orgRow.created_at,
      updatedAt: orgRow.updated_at,
      productCount,
      saleCount,
      userCount,
      revenue,
      isExpired,
      daysRemaining,
      activeDeviceName: orgAdmin?.activeDeviceInfo?.deviceName || null,
      hasActiveSession: !!orgAdmin?.activeSessionKey,
      conflictAttemptsCount: orgAdmin?.conflictAttemptsCount || 0,
      // Credentials are hash-only at rest; a recoverable PIN is never exposed.
      lastPassword: null,
      passwordHistory: orgAdmin?.passwordHistory || [],
    };
  });

  res.json(orgSummaries);
});

const getOrganizationById = asyncHandler(async (req, res) => {
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  const db = getDatabase();
  const orgInternalId = org.id;

  const userRows = db.prepare("SELECT * FROM users WHERE organization_id = ?").all(orgInternalId);
  const users = userRows.map((u) => {
    const { password, ...safe } = userRepository.findById(u.id);
    return safe;
  });

  const productCount = db.prepare("SELECT COUNT(*) as count FROM products WHERE organization_id = ?").get(orgInternalId).count;
  const saleCount = db.prepare("SELECT COUNT(*) as count FROM sales WHERE organization_id = ?").get(orgInternalId).count;
  const customerCount = db.prepare("SELECT COUNT(*) as count FROM customers WHERE organization_id = ?").get(orgInternalId).count;
  const purchaseOrderCount = db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE organization_id = ?").get(orgInternalId).count;

  const revRow = db.prepare("SELECT COALESCE(SUM(total_amount), 0) as rev FROM sales WHERE organization_id = ?").get(orgInternalId);
  const revenue = revRow ? revRow.rev : 0;

  const recentSales = saleRepository.findAll({ organization: org._id }).slice(0, 5);

  const now = new Date();
  const expiresAt = org.subscriptionExpiresAt ? new Date(org.subscriptionExpiresAt) : null;
  const isExpired = expiresAt ? expiresAt < now : false;
  const diffMs = expiresAt ? expiresAt - now : 0;
  const daysRemaining = expiresAt ? Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24))) : 0;

  res.json({
    organization: {
      ...org,
      isExpired,
      daysRemaining,
    },
    users,
    stats: {
      productCount,
      saleCount,
      customerCount,
      purchaseOrderCount,
      revenue,
    },
    recentSales,
  });
});

const createOrganization = asyncHandler(async (req, res) => {
  const {
    name,
    code,
    contactPerson,
    contactEmail,
    contactPhone,
    address,
    password,
    plan = "Trial",
    durationDays = 30,
    billingAmount = 0,
  } = req.body;

  if (!name || !contactPerson || !contactEmail) {
    res.status(400);
    throw new Error("Name, Contact Person, and Contact Email are required");
  }

  const db = getDatabase();
  const cleanEmail = contactEmail.trim().toLowerCase();
  const existingOrg = db.prepare(
    "SELECT id FROM organizations WHERE LOWER(contact_email) = ? OR UPPER(code) = ?"
  ).get(cleanEmail, code ? code.toUpperCase().trim() : "");

  if (existingOrg) {
    res.status(400);
    throw new Error("An organization with this email or code already exists");
  }

  const existingUser = userRepository.findByEmail(cleanEmail);
  if (existingUser) {
    res.status(400);
    throw new Error("A user with this email already exists");
  }

  const generatedCode =
    code && code.trim()
      ? code.trim().toUpperCase()
      : name
          .replace(/[^a-zA-Z0-9]/g, "")
          .substring(0, 6)
          .toUpperCase() + Math.floor(100 + Math.random() * 900);

  const initialPassword =
    password && password.trim()
      ? password.trim()
      : "Mediblix@" + crypto.randomBytes(4).toString("hex");

  const subscriptionExpiresAt = new Date(
    Date.now() + parseInt(durationDays || 30, 10) * 24 * 60 * 60 * 1000
  ).toISOString();

  const org = organizationRepository.create({
    name: name.trim(),
    code: generatedCode,
    contactPerson: contactPerson.trim(),
    contactEmail: cleanEmail,
    contactPhone: contactPhone ? contactPhone.trim() : "",
    address: address ? address.trim() : "",
    status: "Active",
    plan,
    subscriptionStartDate: new Date().toISOString(),
    subscriptionExpiresAt,
    billingAmount: parseFloat(billingAmount) || 0,
    singleDeviceEnforced: true,
  });

  const orgAdmin = userRepository.create({
    name: contactPerson.trim(),
    email: cleanEmail,
    password: initialPassword,
    role: "org_admin",
    isAdmin: true,
    organization: org._id,
  });

  res.status(201).json({
    message: "Organization created successfully",
    organization: org,
    credentials: {
      email: orgAdmin.email,
      password: initialPassword,
    },
  });
});

const updateOrganization = asyncHandler(async (req, res) => {
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  const updatedOrg = organizationRepository.update(req.params.id, {
    name: req.body.name,
    contactPerson: req.body.contactPerson,
    contactEmail: req.body.contactEmail,
    contactPhone: req.body.contactPhone,
    address: req.body.address,
  });

  res.json(updatedOrg);
});

const updateOrgSubscription = asyncHandler(async (req, res) => {
  const { plan, daysToAdd, subscriptionExpiresAt, billingAmount } = req.body;
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  let newExpiry = org.subscriptionExpiresAt;
  if (daysToAdd) {
    const currentExpiry =
      org.subscriptionExpiresAt && new Date(org.subscriptionExpiresAt) > new Date()
        ? new Date(org.subscriptionExpiresAt)
        : new Date();
    newExpiry = new Date(
      currentExpiry.getTime() + parseInt(daysToAdd, 10) * 24 * 60 * 60 * 1000
    ).toISOString();
  } else if (subscriptionExpiresAt) {
    newExpiry = new Date(subscriptionExpiresAt).toISOString();
  }

  const updatedOrg = organizationRepository.update(req.params.id, {
    plan: plan || org.plan,
    billingAmount: billingAmount !== undefined ? parseFloat(billingAmount) : org.billingAmount,
    subscriptionExpiresAt: newExpiry,
  });

  const now = new Date();
  const expiresAt = new Date(updatedOrg.subscriptionExpiresAt);
  const isExpired = expiresAt < now;
  const diffMs = expiresAt - now;
  const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

  res.json({
    message: "Subscription updated successfully",
    organization: {
      ...updatedOrg,
      isExpired,
      daysRemaining,
    },
  });
});

const resetOrgDeviceSession = asyncHandler(async (req, res) => {
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  const logEntry = {
    attemptedAt: new Date().toISOString(),
    ip: req.ip || "Admin Portal",
    userAgent: "Admin Console",
    deviceName: "Platform Administrator",
    status: "Session_Invalidated",
    details: "Active session unlocked and conflict counter reset by Superadmin",
  };

  userRepository.resetDeviceSessionsForOrg(org.id, logEntry);

  res.json({
    message: `All device sessions unlocked and reset for ${org.name}. Users can now log in freely on a new device.`,
  });
});

const toggleOrganizationStatus = asyncHandler(async (req, res) => {
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  const newStatus = req.body.status || (org.status === "Active" ? "Frozen" : "Active");
  const updatedOrg = organizationRepository.updateStatus(req.params.id, newStatus);

  res.json({
    message: `Organization status updated to ${newStatus}`,
    organization: updatedOrg,
  });
});

const resetOrgPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  const org = organizationRepository.findById(req.params.id);

  if (!org) {
    res.status(404);
    throw new Error("Organization not found");
  }

  const db = getDatabase();
  const orgAdminRow = db.prepare("SELECT id FROM users WHERE organization_id = ? AND role = 'org_admin' LIMIT 1").get(org.id);

  if (!orgAdminRow) {
    res.status(404);
    throw new Error("Admin user for this organization not found");
  }

  const generatedPassword =
    newPassword && newPassword.trim()
      ? newPassword.trim()
      : "Mediblix@" + crypto.randomBytes(4).toString("hex");

  const logEntry = {
    attemptedAt: new Date().toISOString(),
    ip: req.ip || "Admin Console",
    userAgent: "Admin Console",
    deviceName: "Platform Administrator",
    status: "Session_Invalidated",
    details: "Credentials reset. Previous PIN disabled and active session invalidated.",
  };

  const result = userRepository.updatePassword(orgAdminRow.id, generatedPassword, logEntry);

  res.json({
    message: "Credentials reset successfully. Previous PIN has been disabled.",
    credentials: {
      email: result.user.email,
      password: generatedPassword,
    },
    previousCredentials: {
      // The previous credential is archived as a hash only and cannot be shown.
      password: null,
      recoverable: false,
      status: "Disabled",
    },
    passwordHistory: result.passwordHistory,
  });
});

export {
  adminLogin,
  getAdminStats,
  getOrganizations,
  getOrganizationById,
  createOrganization,
  updateOrganization,
  updateOrgSubscription,
  resetOrgDeviceSession,
  toggleOrganizationStatus,
  resetOrgPassword,
};
