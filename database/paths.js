/**
 * Mediblix Canonical Database Path Resolver
 *
 * Ensures 100% path consistency across Express Backend, SQLite DAOs, and Electron Main Process.
 * Canonical path: %APPDATA%/Mediblix/mediblix.db (Windows)
 * Supports environment override via MEDIBLIX_DB_PATH for automated testing.
 */

const path = require('path');
const fs = require('fs');

function getCanonicalDbDir() {
  const appData = process.env.APPDATA || (
    process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library/Application Support')
      : path.join(process.env.HOME || '', '.config')
  );
  return path.join(appData, 'Mediblix');
}

function getCanonicalDbPath() {
  const envPath = process.env.MEDIBLIX_DB_PATH || process.env.SQLITE_DB_PATH;
  if (envPath) {
    return envPath === ':memory:' ? ':memory:' : path.resolve(envPath);
  }
  return path.join(getCanonicalDbDir(), 'mediblix.db');
}

function ensureDbDirExists(dbPath = getCanonicalDbPath()) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getInitialCredentialsPath() {
  return path.join(getCanonicalDbDir(), 'INITIAL_ADMIN_CREDENTIALS.txt');
}

function getOrCreateJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 32) {
    return process.env.JWT_SECRET.trim();
  }

  const crypto = require('crypto');
  const secretDir = getCanonicalDbDir();
  ensureDbDirExists(path.join(secretDir, 'dummy.txt'));
  const secretPath = path.join(secretDir, '.jwt_secret');

  if (fs.existsSync(secretPath)) {
    try {
      const stored = fs.readFileSync(secretPath, 'utf8').trim();
      if (stored.length >= 32) {
        process.env.JWT_SECRET = stored;
        return stored;
      }
    } catch (_) {}
  }

  // Generate unique, non-predictable 256-bit cryptographic key
  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, newSecret, { encoding: 'utf8' });
  } catch (err) {
    console.error('[Security] Warning: Could not write persistent JWT secret file:', err.message);
  }
  process.env.JWT_SECRET = newSecret;
  return newSecret;
}

module.exports = {
  getCanonicalDbDir,
  getCanonicalDbPath,
  ensureDbDirExists,
  getInitialCredentialsPath,
  getOrCreateJwtSecret
};
