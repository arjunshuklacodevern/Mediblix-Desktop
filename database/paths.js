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

module.exports = {
  getCanonicalDbDir,
  getCanonicalDbPath,
  ensureDbDirExists
};
