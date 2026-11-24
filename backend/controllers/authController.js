import asyncHandler from "express-async-handler";
import crypto from "crypto";
import repositories from "../../database/repositories/index.js";
import generateToken from "../utils/generateToken.js";

const { userRepository } = repositories;

const parseDeviceName = (uaString = "") => {
  let browser = "Web Browser";
  let os = "Desktop";

  if (/iphone/i.test(uaString)) os = "iPhone";
  else if (/ipad/i.test(uaString)) os = "iPad";
  else if (/android/i.test(uaString)) os = "Android";
  else if (/macintosh|mac os x/i.test(uaString)) os = "macOS";
  else if (/windows nt/i.test(uaString)) os = "Windows";
  else if (/linux/i.test(uaString)) os = "Linux";

  if (/edg/i.test(uaString)) browser = "Edge";
  else if (/chrome|crios/i.test(uaString)) browser = "Chrome";
  else if (/firefox|fxios/i.test(uaString)) browser = "Firefox";
  else if (/safari/i.test(uaString)) browser = "Safari";

  return `${browser} on ${os}`;
};

const authUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const normalizedEmail = email ? email.toLowerCase().trim() : "";
  const user = userRepository.findByEmail(normalizedEmail);

  if (!user || !userRepository.matchPassword(password, user.password)) {
    return res.status(401).json({
      message: "Invalid email or password",
    });
  }

  const rawUa = req.headers["user-agent"] || "";
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    "Unknown IP";
  const deviceName = parseDeviceName(rawUa);
  const clientSession = req.headers["x-device-session"] || req.body.activeSessionKey;

  if (
    user.role !== "superadmin" &&
    user.organization &&
    user.organization.status === "Frozen"
  ) {
    return res.status(403).json({
      message: "This organization is frozen by administrator. Access restricted.",
      isFrozen: true,
      organizationName: user.organization.name,
    });
  }

  if (
    user.role !== "superadmin" &&
    user.organization &&
    user.organization.subscriptionExpiresAt &&
    new Date(user.organization.subscriptionExpiresAt) < new Date()
  ) {
    return res.status(403).json({
      message: `Organization subscription expired on ${new Date(
        user.organization.subscriptionExpiresAt
      ).toLocaleDateString("en-IN")}. Please contact administrator to renew.`,
      isExpired: true,
      organizationName: user.organization.name,
      expiresAt: user.organization.subscriptionExpiresAt,
    });
  }

  if (
    user.role !== "superadmin" &&
    user.activeSessionKey &&
    clientSession !== user.activeSessionKey
  ) {
    const conflictLog = {
      attemptedAt: new Date().toISOString(),
      ip: clientIp,
      userAgent: rawUa,
      deviceName,
      status: "Blocked_Device_Conflict",
      details: `Concurrent login attempt blocked while active on ${
        user.activeDeviceInfo?.deviceName || "Terminal"
      }`,
    };

    userRepository.recordConflictAttempt(user._id, conflictLog);

    return res.status(403).json({
      message: `Account is currently logged in on another device (${
        user.activeDeviceInfo?.deviceName || "Active Terminal"
      }). Single-device policy is strictly enforced. Please log out from that device or contact your administrator to reset access.`,
      isDeviceConflict: true,
      activeDevice: user.activeDeviceInfo?.deviceName || "Active Terminal",
      conflictCount: (user.conflictAttemptsCount || 0) + 1,
    });
  }

  const sessionKey = crypto.randomBytes(24).toString("hex");
  const activeDeviceInfo = {
    deviceName,
    ip: clientIp,
    userAgent: rawUa,
    loggedInAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };

  const successLog = {
    attemptedAt: new Date().toISOString(),
    ip: clientIp,
    userAgent: rawUa,
    deviceName,
    status: "Success",
    details: "Authorized session started",
  };

  userRepository.recordLoginSuccess(user._id, sessionKey, activeDeviceInfo, successLog);

  res.json({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role || (user.isAdmin ? "superadmin" : "staff"),
    isAdmin: user.isAdmin,
    organization: user.organization || null,
    token: generateToken(user._id, user.sessionVersion || 1),
    sessionKey,
    activeDevice: activeDeviceInfo,
  });
});

const logoutUser = asyncHandler(async (req, res) => {
  if (req.user) {
    const rawUa = req.headers["user-agent"] || "";
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "Unknown IP";
    const deviceName = parseDeviceName(rawUa);

    const logoutLog = {
      attemptedAt: new Date().toISOString(),
      ip: clientIp,
      userAgent: rawUa,
      deviceName,
      status: "Logged_Out",
      details: "Session terminated cleanly by user",
    };

    userRepository.clearSession(req.user._id, logoutLog);
  }

  res.json({ message: "Logged out successfully" });
});

const getMe = asyncHandler(async (req, res) => {
  const user = userRepository.findById(req.user._id);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

export { authUser, logoutUser, getMe };
