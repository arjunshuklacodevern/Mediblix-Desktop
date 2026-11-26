import jwt from "jsonwebtoken";
import { createRequire } from "module";
import repositories from "../../database/repositories/index.js";

const require = createRequire(import.meta.url);
const { getOrCreateJwtSecret } = require("../../database/paths.js");

const getJwtSecret = () => {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 32) {
    return process.env.JWT_SECRET.trim();
  }
  const secret = getOrCreateJwtSecret();
  process.env.JWT_SECRET = secret;
  return secret;
};

const { userRepository, organizationRepository } = repositories;

const getTenantContext = async (req) => {
  let orgId = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, getJwtSecret());
      const user = userRepository.findById(decoded.id);
      if (user) {
        req.user = user;
        if (user.organization) {
          orgId = user.organization._id;
          if (user.role !== "superadmin" && user.organization.status === "Frozen") {
            const err = new Error("Organization is frozen by administrator. Action not allowed.");
            err.statusCode = 403;
            throw err;
          }
        }
      }
    } catch (err) {
      if (err.statusCode === 403) throw err;
    }
  }

  // Security enforcement: only superadmin can switch organizations via header
  if (req.user && req.user.role === "superadmin" && req.headers["x-organization-id"]) {
    orgId = req.headers["x-organization-id"];
    const org = organizationRepository.findById(orgId);
    if (org && org.status === "Frozen") {
      const err = new Error("Organization is frozen by administrator. Action not allowed.");
      err.statusCode = 403;
      throw err;
    }
  } else if (!orgId && req.headers["x-organization-id"]) {
    // Unauthenticated caller: check header organization
    const org = organizationRepository.findById(req.headers["x-organization-id"]);
    if (org) {
      if (org.status === "Frozen") {
        const err = new Error("Organization is frozen by administrator. Action not allowed.");
        err.statusCode = 403;
        throw err;
      }
      orgId = org._id;
    }
  }

  if (!orgId) {
    const defaultOrg = organizationRepository.findByCode("DEFAULT");
    if (defaultOrg) {
      orgId = defaultOrg._id;
    }
  }

  return orgId;
};

const getTenantQuery = async (req) => {
  const orgId = await getTenantContext(req);
  if (!orgId) {
    return {};
  }
  return { organization: orgId };
};

export { getTenantContext, getTenantQuery };
