/**
 * Mediblix Desktop — Shared Sync Utilities
 *
 * Isolated transport and SQLite metadata helpers extracted to prevent circular
 * dependencies between deviceAuth.js and syncService.js.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getDatabase } = require('../../database/db');

/**
 * Generic HTTP/HTTPS JSON Request Helper
 */
function makeRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      timeout: options.timeout || 30000
    };

    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : {};
        } catch (_) {
          json = { raw: data };
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${urlStr} timed out`));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Reads sync metadata key-value from SQLite
 */
function getSyncMetadata(key) {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM sync_metadata WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Sets sync metadata key-value in SQLite
 */
function setSyncMetadata(key, value) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sync_metadata (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

module.exports = {
  makeRequest,
  getSyncMetadata,
  setSyncMetadata
};
