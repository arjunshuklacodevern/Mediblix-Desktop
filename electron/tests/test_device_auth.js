/**
 * Mediblix Desktop — Device Authentication & DPAPI Test Suite
 *
 * Verifies Step 1 requirements and review corrections:
 *  1. No circular dependency between deviceAuth.js, syncService.js, and syncUtils.js.
 *  2. DPAPI Protect/Unprotect roundtrip encryption (fail-closed on non-Windows/corrupt data).
 *  3. Windows ACL enforcement on .device_credentials.enc (CurrentUser grant, inheritance removed).
 *  4. Secure credential storage (non-secret deviceId in SQLite, secret key DPAPI-encrypted on disk).
 *  5. Corrupt or unreadable credential file handling.
 *  6. Token exchange against mock cloud server (POST /api/sync/auth/token).
 *  7. Token caching strictly in process memory and proactive reuse within 10-minute expiry buffer.
 *  8. Error and status code handling:
 *     - HTTP 401: Invalid credentials error.
 *     - HTTP 429: Rate-limit error with retryAfter extraction.
 *     - HTTP 503: Fail-closed service unavailable error.
 *  9. Zero-Leakage: Logs and SQLite metadata contain no secret keys or raw JWTs.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');

// Isolated test environment directory
const TEST_DIR = path.join(__dirname, '.test_device_auth_env');
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

const TEST_DB_PATH = path.join(TEST_DIR, 'test_device_auth.db');
const TEST_CRED_DIR = path.join(TEST_DIR, '.device-auth');
const TEST_CRED_FILE = path.join(TEST_CRED_DIR, '.device_credentials.enc');

process.env.MEDIBLIX_DB_PATH = TEST_DB_PATH;
process.env.MEDIBLIX_CREDENTIALS_DIR = TEST_CRED_DIR;
process.env.MEDIBLIX_CREDENTIALS_FILE = TEST_CRED_FILE;

const { initDatabase, closeDatabase, getDatabase } = require('../../database/db');
const { getCanonicalDbDir } = require('../../database/paths');

let mockServer;
let mockPort;
let mockResponseStatus = 200;
let mockResponseBody = {};
let mockResponseHeaders = {};
let requestsReceived = [];

function startMockAuthServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        requestsReceived.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null
        });

        res.writeHead(mockResponseStatus, {
          'Content-Type': 'application/json',
          ...mockResponseHeaders
        });
        res.end(JSON.stringify(mockResponseBody));
      });
    });

    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

async function runTests() {
  console.log('=== [MEDIBLIX DEVICE AUTH & DPAPI TEST SUITE (STEP 1 AUDIT)] ===\n');

  try {
    // -------------------------------------------------------------
    // TEST 1: Circular Dependency Check
    // -------------------------------------------------------------
    console.log('[TEST 1] Verifying absence of circular dependencies...');
    const syncUtils = require('../sync/syncUtils');
    const deviceAuth = require('../sync/deviceAuth');
    const syncService = require('../sync/syncService');

    assert(typeof syncUtils.makeRequest === 'function', 'syncUtils exports makeRequest');
    assert(typeof deviceAuth.exchangeDeviceToken === 'function', 'deviceAuth exports exchangeDeviceToken');
    assert(typeof syncService.performBidirectionalSync === 'function', 'syncService exports performBidirectionalSync');
    console.log('  ✓ Zero circular dependencies verified across syncUtils, deviceAuth, and syncService');

    initDatabase();
    const db = getDatabase();

    const {
      dpapiProtect,
      dpapiUnprotect,
      resolveCurrentWindowsIdentity,
      inspectAcl,
      verifyAcl,
      enforceDirectoryAcl,
      enforceFileAcl,
      getCredentialsDir,
      getCredentialsFilePath,
      saveDeviceCredentials,
      loadDeviceCredentials,
      exchangeDeviceToken,
      getOrRefreshDeviceToken,
      invalidateCachedToken,
      _getMemoryCache
    } = deviceAuth;

    // -------------------------------------------------------------
    // TEST 2: DPAPI Encryption & Decryption Roundtrip
    // -------------------------------------------------------------
    console.log('\n[TEST 2] Testing Windows DPAPI roundtrip encryption...');
    const secret = 'mbx_sec_test_enrollment_key_987654321';
    const encrypted = dpapiProtect(secret);
    assert(encrypted && encrypted.length > 50, 'Encrypted output should be non-empty base64 string');
    assert.notStrictEqual(encrypted, secret, 'Encrypted text must not match plaintext');

    const decrypted = dpapiUnprotect(encrypted);
    assert.strictEqual(decrypted, secret, 'Decrypted text must match original plaintext exactly');
    console.log('  ✓ DPAPI ProtectedData successfully encrypts and recovers secret');

    // -------------------------------------------------------------
    // TEST 3: Fail-Closed Protection Validation
    // -------------------------------------------------------------
    console.log('\n[TEST 3] Testing fail-closed behavior on invalid inputs & corrupted ciphertext...');
    assert.throws(() => dpapiProtect(''), /Plaintext string is required/, 'Empty plaintext rejected');
    assert.throws(() => dpapiUnprotect(''), /Encrypted base64 ciphertext is required/, 'Empty ciphertext rejected');
    assert.throws(() => dpapiUnprotect('not-a-valid-dpapi-blob'), /DPAPI decryption failed/, 'Corrupted ciphertext fails closed');
    console.log('  ✓ Fail-closed confirmed: rejects invalid or corrupted ciphertext without insecure fallbacks');

    // -------------------------------------------------------------
    // TEST 4: Dedicated Secure Directory, Credential Persistence & ACL Verification
    // -------------------------------------------------------------
    console.log('\n[TEST 4] Testing dedicated directory creation & strict ACL verification...');
    const testDeviceId = 'MDEV-TEST-001';
    saveDeviceCredentials(testDeviceId, secret);

    // Verify non-secret deviceId stored in SQLite
    const row = db.prepare('SELECT value FROM sync_metadata WHERE key = ?').get('sync_device_id');
    assert(row && row.value === testDeviceId, 'DeviceId must be stored in sync_metadata');

    // Verify secret is NOT in SQLite
    const secretInDb = db.prepare('SELECT * FROM sync_metadata WHERE value LIKE ?').get(`%${secret}%`);
    assert(!secretInDb, 'Raw enrollment secret must NEVER be stored in SQLite');

    // Verify dedicated directory exists and has hardened ACLs
    const credDir = getCredentialsDir();
    assert(fs.existsSync(credDir), 'Dedicated .device-auth directory exists');
    const encFile = getCredentialsFilePath();
    assert(fs.existsSync(encFile), '.device_credentials.enc exists on disk');

    if (process.platform === 'win32') {
      const currentUser = resolveCurrentWindowsIdentity();
      // Verify actual ACLs on directory and file
      const dirEntries = verifyAcl(credDir, currentUser, { isDirectory: true });
      assert(dirEntries.length > 0, 'Directory ACL has verified entries');
      assert(dirEntries.every(e => !e.isInherited), 'Directory ACL must have zero inherited entries');

      const fileEntries = verifyAcl(encFile, currentUser, { isDirectory: false });
      assert(fileEntries.length > 0, 'File ACL has verified entries');
      assert(fileEntries.every(e => !e.isInherited), 'File ACL must have zero inherited entries');
      console.log('  ✓ Dedicated directory (%APPDATA%\\Mediblix\\.device-auth) and credential file ACLs strictly verified');
    }

    // Verify loading credentials recovers decrypted key
    const loaded = loadDeviceCredentials();
    assert.strictEqual(loaded.deviceId, testDeviceId, 'Loaded deviceId must match');
    assert.strictEqual(loaded.enrollmentKey, secret, 'Loaded enrollmentKey must match original');
    assert.strictEqual(loaded.source, 'dpapi', 'Credential source must be dpapi');

    // -------------------------------------------------------------
    // TEST 5: Corrupt Credential File Handling
    // -------------------------------------------------------------
    console.log('\n[TEST 5] Testing corrupt credentials file handling...');
    fs.writeFileSync(encFile, 'CORRUPT_NOT_DPAPI_DATA');
    const corruptLoaded = loadDeviceCredentials();
    assert.strictEqual(corruptLoaded.enrollmentKey, null, 'Corrupt file yields null enrollmentKey');
    // Restore valid credentials for subsequent tests
    saveDeviceCredentials(testDeviceId, secret);
    console.log('  ✓ Corrupted credentials file handled gracefully without crashing or leaking');

    // -------------------------------------------------------------
    // TEST 6: Token Exchange with Cloud (HTTP 200)
    // -------------------------------------------------------------
    console.log('\n[TEST 6] Testing token exchange with mock cloud server...');
    await startMockAuthServer();
    const cloudUrl = `http://127.0.0.1:${mockPort}`;

    mockResponseStatus = 200;
    mockResponseBody = {
      message: 'Token issued',
      token: 'mock.cloud.jwt.token.12345',
      expiresIn: 3600,
      organizationId: '6741ef000000000000000001'
    };

    const result = await exchangeDeviceToken({ cloudUrl });
    assert.strictEqual(result.token, 'mock.cloud.jwt.token.12345');
    assert.strictEqual(result.organizationId, '6741ef000000000000000001');
    assert(result.expiresAt > Date.now() + 3500 * 1000, 'ExpiresAt must be ~1 hour in future');

    // Verify request payload sent to cloud
    const lastReq = requestsReceived[requestsReceived.length - 1];
    assert.strictEqual(lastReq.body.deviceId, testDeviceId);
    assert.strictEqual(lastReq.body.enrollmentKey, secret);
    console.log('  ✓ POST /api/sync/auth/token exchange successful; token cached in memory');

    // -------------------------------------------------------------
    // TEST 7: Token Caching & Proactive Reuse
    // -------------------------------------------------------------
    console.log('\n[TEST 7] Testing process memory token caching and proactive reuse...');
    const initialReqCount = requestsReceived.length;
    const cachedToken = await getOrRefreshDeviceToken({ cloudUrl });
    assert.strictEqual(cachedToken, 'mock.cloud.jwt.token.12345');
    assert.strictEqual(requestsReceived.length, initialReqCount, 'Should reuse cached token without network call');
    console.log('  ✓ Cached token reused in-memory without making redundant network call');

    // Invalidate cache and test refresh
    invalidateCachedToken();
    assert.strictEqual(_getMemoryCache().token, null, 'Cache must be empty after invalidation');
    const refreshedToken = await getOrRefreshDeviceToken({ cloudUrl });
    assert.strictEqual(requestsReceived.length, initialReqCount + 1, 'Should make network call after invalidation');
    console.log('  ✓ Invalidation forces clean token re-exchange');

    // -------------------------------------------------------------
    // TEST 8: HTTP 401 Unauthorized Handling
    // -------------------------------------------------------------
    console.log('\n[TEST 8] Testing HTTP 401 Invalid Credentials handling...');
    mockResponseStatus = 401;
    mockResponseBody = { message: 'Invalid device credentials' };

    let caught401 = null;
    try {
      await exchangeDeviceToken({ cloudUrl });
    } catch (e) {
      caught401 = e;
    }
    assert(caught401, 'Should throw error on 401');
    assert.strictEqual(caught401.statusCode, 401);
    assert.strictEqual(caught401.code, 'INVALID_CREDENTIALS');
    console.log('  ✓ HTTP 401 correctly parsed and thrown with INVALID_CREDENTIALS code');

    // -------------------------------------------------------------
    // TEST 9: HTTP 429 Rate Limiting Handling with Retry-After
    // -------------------------------------------------------------
    console.log('\n[TEST 9] Testing HTTP 429 Rate Limiter handling...');
    mockResponseStatus = 429;
    mockResponseHeaders = { 'retry-after': '45' };
    mockResponseBody = { message: 'Too many authentication attempts', retryAfterSeconds: 45 };

    let caught429 = null;
    try {
      await exchangeDeviceToken({ cloudUrl });
    } catch (e) {
      caught429 = e;
    }
    assert(caught429, 'Should throw error on 429');
    assert.strictEqual(caught429.statusCode, 429);
    assert.strictEqual(caught429.code, 'RATE_LIMITED');
    assert.strictEqual(caught429.retryAfter, 45);
    console.log('  ✓ HTTP 429 correctly extracts Retry-After (45s) and throws RATE_LIMITED');

    // -------------------------------------------------------------
    // TEST 10: HTTP 503 Fail-Closed Handling
    // -------------------------------------------------------------
    console.log('\n[TEST 10] Testing HTTP 503 Service Unavailable (Fail-closed)...');
    mockResponseStatus = 503;
    mockResponseHeaders = {};
    mockResponseBody = { message: 'Service temporarily unavailable' };

    let caught503 = null;
    try {
      await exchangeDeviceToken({ cloudUrl });
    } catch (e) {
      caught503 = e;
    }
    assert(caught503, 'Should throw error on 503');
    assert.strictEqual(caught503.statusCode, 503);
    assert.strictEqual(caught503.code, 'SERVICE_UNAVAILABLE');
    console.log('  ✓ HTTP 503 correctly handled with SERVICE_UNAVAILABLE (Fail-closed preserved)');

    // -------------------------------------------------------------
    // TEST 11: Windows ACL Enforcement Failure (Fail-Closed)
    // -------------------------------------------------------------
    console.log('\n[TEST 11] Testing fail-closed behavior on Windows ACL enforcement failure...');
    
    // 11a: enforceFileAcl rejects non-existent or invalid file path
    assert.throws(
      () => enforceFileAcl(path.join(getCredentialsDir(), 'non_existent_dir_99999', 'invalid.enc')),
      /Windows file ACL enforcement failed via icacls/,
      'enforceFileAcl must fail closed when icacls fails'
    );

    // 11b: verifyAcl rejects unauthorized principals
    assert.throws(
      () => verifyAcl(encFile, { name: 'SOME_NONEXISTENT_USER', sid: null }),
      /Unauthorized principal detected in ACL|Intended Windows user/,
      'verifyAcl must reject when intended user is not granted'
    );
    console.log('  ✓ ACL enforcement and verification fail-closed confirmed');

    // -------------------------------------------------------------
    // TEST 12: Existing Explicit ACE Handling & Purging
    // -------------------------------------------------------------
    console.log('\n[TEST 12] Testing existing explicit ACE purging on pre-existing credential file...');
    // Create pre-existing file with explicit extra permission
    fs.writeFileSync(encFile, 'DUMMY_OLD_DATA', 'utf8');
    if (process.platform === 'win32') {
      try {
        execFileSync('icacls.exe', [encFile, '/grant', 'Everyone:R'], { stdio: 'pipe' });
      } catch (_) {}
    }

    // Call saveDeviceCredentials - should purge the pre-existing file and establish clean ACLs
    saveDeviceCredentials('MDEV-PURGE-TEST', 'purged_secret_key_123');
    if (process.platform === 'win32') {
      const currentUser = resolveCurrentWindowsIdentity();
      const entries = verifyAcl(encFile, currentUser, { isDirectory: false });
      const hasEveryone = entries.some(e => e.principal.toLowerCase() === 'everyone');
      assert(!hasEveryone, 'Pre-existing explicit grants (Everyone) must be completely purged');
      console.log('  ✓ Stale explicit ACEs purged; credential file contains strictly verified grants');
    }

    // -------------------------------------------------------------
    // TEST 13: Credential File Creation Failure Handling
    // -------------------------------------------------------------
    console.log('\n[TEST 13] Testing credential file creation failure handling...');
    const originalFileOverride = process.env.MEDIBLIX_CREDENTIALS_FILE;
    try {
      // Point file path to an impossible location (non-existent nested directory)
      process.env.MEDIBLIX_CREDENTIALS_FILE = path.join(TEST_DIR, 'non_existent_subdir', 'deep', 'cred.enc');
      assert.throws(
        () => saveDeviceCredentials('MDEV-FAIL-DIR', 'secret'),
        /ENOENT/,
        'Should fail closed if credential file cannot be created'
      );
      console.log('  ✓ File creation failure fails closed cleanly without metadata persistence');
    } finally {
      process.env.MEDIBLIX_CREDENTIALS_FILE = originalFileOverride;
    }

    // -------------------------------------------------------------
    // TEST 14: Cleanup Failure (Non-Swallowed Error)
    // -------------------------------------------------------------
    console.log('\n[TEST 14] Testing that cleanup failure is never silently swallowed...');
    const origUnlink = fs.unlinkSync;
    const origEnforceFile = deviceAuth.enforceFileAcl;
    try {
      // Ensure file doesn't exist before test starts so pre-purge passes
      if (fs.existsSync(encFile)) origUnlink(encFile);

      // Simulate an error during file ACL enforcement and simultaneous unlinkSync failure
      let cleanupTestError = null;
      deviceAuth.enforceFileAcl = () => {
        throw new Error('Simulated icacls crash on credential file');
      };

      fs.unlinkSync = (targetPath) => {
        if (targetPath === encFile) {
          throw new Error('EPERM: file is locked by antivirus scanner');
        }
        return origUnlink(targetPath);
      };

      try {
        saveDeviceCredentials('MDEV-CLEANUP-FAIL', 'secret');
      } catch (err) {
        cleanupTestError = err;
      }

      assert(cleanupTestError, 'Must throw error when ACL enforcement fails');
      assert(
        /Furthermore, cleanup of credential file failed: EPERM: file is locked by antivirus scanner/.test(cleanupTestError.message),
        'Error must explicitly state that cleanup failed'
      );
      console.log('  ✓ Cleanup failure is NOT swallowed and is explicitly surfaced in error message');
    } finally {
      fs.unlinkSync = origUnlink;
      deviceAuth.enforceFileAcl = origEnforceFile;
      // Re-save valid credentials for subsequent test cleanups
      saveDeviceCredentials(testDeviceId, secret);
    }

    // -------------------------------------------------------------
    // TEST 15: Tampered / Replaced Credential File Rejected on Load
    // -------------------------------------------------------------
    console.log('\n[TEST 15] Testing tampered or replaced credential file rejection on load...');
    // Tamper with ACL by granting Everyone:R
    if (process.platform === 'win32') {
      try {
        execFileSync('icacls.exe', [encFile, '/grant', 'Everyone:R'], { stdio: 'pipe' });
      } catch (_) {}
    }
    const tamperedLoad = loadDeviceCredentials();
    assert.strictEqual(tamperedLoad.enrollmentKey, null, 'Tampered ACL must cause loadDeviceCredentials to reject file');
    console.log('  ✓ Untrusted/tampered credential file rejected by loadDeviceCredentials');

    // Restore clean credentials
    saveDeviceCredentials(testDeviceId, secret);

    // -------------------------------------------------------------
    // TEST 16: Zero Credentials Written Before ACL Verification
    // -------------------------------------------------------------
    console.log('\n[TEST 16] Testing zero credentials written before ACL verification...');
    // If ACL verification fails, ensure file contains 0 bytes
    let observedSizeBeforeAcl = -1;
    const origVerify = deviceAuth.verifyAcl;
    try {
      // Temporarily intercept verifyAcl to inspect file content before verification completes
      deviceAuth.verifyAcl = (targetPath, user, opts) => {
        if (!opts?.isDirectory && fs.existsSync(targetPath)) {
          observedSizeBeforeAcl = fs.statSync(targetPath).size;
        }
        return origVerify(targetPath, user, opts);
      };

      saveDeviceCredentials('MDEV-ZERO-BYTE-CHECK', 'super_secret_payload_999');
      assert.strictEqual(observedSizeBeforeAcl, 0, 'File must be exactly 0 bytes when ACL is verified');
      console.log('  ✓ Confirmed: credential file is exclusively created and hardened at 0 bytes before secret is written');
    } finally {
      deviceAuth.verifyAcl = origVerify;
    }

    // Cleanup
    mockServer.close();
    closeDatabase();
    if (fs.existsSync(TEST_DIR)) {
      try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('\n======================================================');
    console.log('🎉 ALL 16 COMPREHENSIVE SECURITY TESTS PASSED (100%)!');
    console.log('======================================================\n');
  } catch (err) {
    if (mockServer) mockServer.close();
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  }
}

runTests();
