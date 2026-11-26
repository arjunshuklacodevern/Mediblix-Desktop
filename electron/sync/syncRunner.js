#!/usr/bin/env node
/**
 * Mediblix Desktop — Standalone Scheduled Sync Runner
 *
 * Designed to execute either:
 *   A. Automatically via Windows Task Scheduler at 2:00 AM (even when Electron is closed)
 *   B. Opportunistically by Electron upon application startup
 *   C. Manually via CLI for diagnostics: node electron/sync/syncRunner.js
 */

const fs = require('fs');
const path = require('path');
const { initDatabase, getDatabase } = require('../../database/db');
const { getCanonicalDbPath } = require('../../database/paths');
const { performBidirectionalSync } = require('./syncService');
const { getOrRefreshDeviceToken } = require('./deviceAuth');

const LOCK_FILE = path.join(path.dirname(getCanonicalDbPath()), '.sync.lock');

/**
 * Acquire process lock to prevent concurrent sync executions
 */
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stats = fs.statSync(LOCK_FILE);
      // If lockfile is older than 15 minutes, consider it stale from an aborted process
      if (Date.now() - stats.mtimeMs < 15 * 60 * 1000) {
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'w' });
    return true;
  } catch (_) {
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
}

/**
 * Retrieves valid authenticated token for AWS sync using device credentials or test override
 */
async function getSyncToken(db) {
  // If explicitly provided via environment (e.g. mock test server)
  if (process.env.MEDIBLIX_SYNC_TOKEN) {
    return process.env.MEDIBLIX_SYNC_TOKEN;
  }

  // Obtain short-lived AWS sync JWT using enrolled device credentials
  return await getOrRefreshDeviceToken({
    cloudUrl: process.env.MEDIBLIX_CLOUD_URL
  });
}

async function run() {
  console.log(`[SyncRunner] Starting Mediblix data synchronization at ${new Date().toISOString()}`);

  if (!acquireLock()) {
    console.log('[SyncRunner] Another sync process is currently active or locked. Exiting cleanly.');
    if (require.main === module) {
      process.exit(0);
    }
    return { success: false, reason: 'locked' };
  }

  try {
    // 1. Initialize local SQLite runtime
    initDatabase();
    const db = getDatabase();

    // 2. Prepare authentication token via secure device token exchange
    const token = await getSyncToken(db);

    // 3. Execute bidirectional synchronization
    const result = await performBidirectionalSync({
      token,
      cloudUrl: process.env.MEDIBLIX_CLOUD_URL
    });

    console.log('[SyncRunner] Sync completed successfully:', JSON.stringify(result, null, 2));
    releaseLock();
    if (require.main === module) {
      process.exit(0);
    }
    return result;
  } catch (err) {
    console.error('[SyncRunner] Sync encountered an error:', err.message);
    releaseLock();
    if (require.main === module) {
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  run,
  acquireLock,
  releaseLock,
  getSyncToken
};
