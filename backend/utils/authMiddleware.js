import jwt from "jsonwebtoken";
import asyncHandler from "express-async-handler";
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

const { userRepository } = repositories;

const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, getJwtSecret());
      const user = userRepository.findById(decoded.id);

      if (!user) {
        res.status(401);
        throw new Error("Not authorized, user not found");
      }

      if (
        user.role !== "superadmin" &&
        user.organization &&
        user.organization.status === "Frozen"
      ) {
        res.status(403);
        throw new Error("Organization is frozen. Please contact administrator.");
      }

      if (
        user.role !== "superadmin" &&
        user.organization &&
        user.organization.subscriptionExpiresAt &&
        new Date(user.organization.subscriptionExpiresAt) < new Date()
      ) {
        res.status(403);
        throw new Error("Organization subscription has expired. Please contact administrator.");
      }

      if (
        user.role !== "superadmin" &&
        decoded.sessionVersion !== undefined &&
        user.sessionVersion !== undefined &&
        decoded.sessionVersion !== user.sessionVersion
      ) {
        res.status(401);
        throw new Error("Session revoked by administrator. Please log in again.");
      }

      const clientSession = req.headers["x-device-session"];
      if (
        user.role !== "superadmin" &&
        user.organization?.singleDeviceEnforced !== false
      ) {
        if (!user.activeSessionKey && clientSession) {
          res.status(401);
          throw new Error("Device session reset by administrator. Please log in again.");
        }
        if (
          user.activeSessionKey &&
          clientSession &&
          clientSession !== user.activeSessionKey
        ) {
          res.status(401);
          throw new Error("Device session expired or active on another device.");
        }
      }

      // Safe user object without password hash
      const { password, ...safeUser } = user;
      req.user = safeUser;

      next();
    } catch (error) {
      res.status(401);
      throw new Error(error.message || "Not authorized, token failed");
    }
  }

  if (!token) {
    res.status(401);
    throw new Error("Not authorized, no token provided");
  }
});

const superAdminOnly = (req, res, next) => {
  if (req.user && req.user.role === "superadmin") {
    next();
  } else {
    res.status(403);
    throw new Error("Access denied. Superadmin privileges required.");
  }
};

const resolveOrganization = async (req) => {
  if (req.user && req.user.organization) {
    return req.user.organization._id;
  }
  const headerOrgId = req.headers["x-organization-id"];
  if (headerOrgId) {
    return headerOrgId;
  }
  const defaultOrg = repositories.organizationRepository.findByCode("DEFAULT");
  return defaultOrg ? defaultOrg._id : null;
};

export { protect, superAdminOnly, resolveOrganization };
