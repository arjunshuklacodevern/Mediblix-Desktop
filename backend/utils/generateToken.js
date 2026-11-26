import jwt from "jsonwebtoken";
import { createRequire } from "module";

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

const generateToken = (id, sessionVersion = 1) => {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error("JWT secret key is not available");
  }
  return jwt.sign({ id, sessionVersion }, secret, {
    expiresIn: "30d",
  });
};

export default generateToken;
