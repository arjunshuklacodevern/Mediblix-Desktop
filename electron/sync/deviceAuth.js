/**
 * Mediblix Desktop — Device Authentication & Credential Management
 *
 * Implements secure desktop device authentication with the AWS Cloud Backend:
 *  1. DPAPI-protected local credential storage (compatible with both Electron main and standalone Node.js syncRunner).
 *     - Strict Fail-Closed: If platform DPAPI is unavailable, operations immediately fail without fallback to insecure encoding.
 *     - Windows ACL Enforcement: Files are protected with inherited permissions removed and granted strictly to CurrentUser.
 *  2. Device credential exchange with AWS via POST /api/sync/auth/token.
 *  3. In-memory-only JWT caching:
 *     - Short-lived AWS sync JWTs are held strictly in process memory with proactive refresh (10-minute expiry buffer).
 *     - Each new standalone syncRunner process performs a fresh exchange; JWTs are never stored on disk.
 *     - Only non-sensitive expiry timestamps and deviceId are recorded in SQLite sync_metadata.
 *  4. Robust HTTP status handling:
 *     - 401 Unauthorized: Invalidates in-memory token.
 *     - 429 Too Many Requests: Reads Retry-After header and backs off.
 *     - 503 Service Unavailable: Handles fail-closed policy when Redis rate limiter is down.
 *  5. Strict Zero-Leakage: Never logs raw enrollment keys or JWTs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDatabase } = require('../../database/db');
const { getCanonicalDbDir } = require('../../database/paths');
const { makeRequest, getSyncMetadata, setSyncMetadata } = require('./syncUtils');

const DEFAULT_CLOUD_URL = process.env.MEDIBLIX_CLOUD_URL || 'https://backend.app.mediblix.com';
const EXPIRATION_BUFFER_MS = 10 * 60 * 1000; // 10 minutes prior to expiry

// In-memory token cache (process-lifetime only; never written to disk or SQLite)
let memoryTokenCache = {
  token: null,
  expiresAt: null,
  organizationId: null,
  deviceId: null
};

/**
 * Rejects symbolic links or reparse points to prevent path redirection attacks.
 */
function assertNotSymlink(targetPath) {
  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Rejected symbolic link or reparse point: ${targetPath}`);
    }
  }
}

/**
 * Returns the dedicated secure directory for credential storage (%APPDATA%\Mediblix\.device-auth\).
 * Isolates credential storage from the general database directory.
 */
function getCredentialsDir() {
  let dir;
  if (process.env.MEDIBLIX_CREDENTIALS_DIR) {
    dir = path.resolve(process.env.MEDIBLIX_CREDENTIALS_DIR);
  } else if (process.env.MEDIBLIX_DB_PATH && process.env.MEDIBLIX_DB_PATH !== ':memory:') {
    dir = path.join(path.dirname(path.resolve(process.env.MEDIBLIX_DB_PATH)), '.device-auth');
  } else {
    dir = path.join(getCanonicalDbDir(), '.device-auth');
  }
  assertNotSymlink(dir);
  return dir;
}

/**
 * Returns the path to the DPAPI-encrypted device credentials file.
 * Restricts custom credential file paths to the approved secure directory.
 */
function getCredentialsFilePath() {
  const credDir = getCredentialsDir();
  if (process.env.MEDIBLIX_CREDENTIALS_FILE) {
    const customPath = path.resolve(process.env.MEDIBLIX_CREDENTIALS_FILE);
    const isTestMode = Boolean(process.env.MEDIBLIX_DB_PATH || process.env.NODE_ENV === 'test');
    if (!isTestMode && !customPath.startsWith(credDir)) {
      throw new Error(`Custom credential file path must reside within the approved secure directory: ${credDir}`);
    }
    assertNotSymlink(customPath);
    return customPath;
  }
  const defaultPath = path.join(credDir, '.device_credentials.enc');
  assertNotSymlink(defaultPath);
  return defaultPath;
}

/**
 * Safely resolves the active Windows user identity and SID without relying solely on environment strings.
 */
function resolveCurrentWindowsIdentity() {
  if (process.platform !== 'win32') {
    throw new Error('Windows identity resolution is only supported on Windows platforms.');
  }

  // Allow explicit test override
  if (process.env.MEDIBLIX_TEST_WINDOWS_USER) {
    return {
      name: process.env.MEDIBLIX_TEST_WINDOWS_USER.trim(),
      sid: process.env.MEDIBLIX_TEST_WINDOWS_SID ? process.env.MEDIBLIX_TEST_WINDOWS_SID.trim() : null
    };
  }

  try {
    const rawUser = execFileSync('whoami.exe', [], { encoding: 'utf8' }).trim();
    if (!rawUser) throw new Error('whoami returned empty username');

    let sid = null;
    try {
      const sidOutput = execFileSync('whoami.exe', ['/user'], { encoding: 'utf8' });
      const match = sidOutput.match(/(S-1-5-21-[\d-]+|\bS-1-[\d-]+)/);
      if (match) sid = match[1];
    } catch (_) {}

    return { name: rawUser, sid };
  } catch (err) {
    const username = process.env.USERNAME;
    const domain = process.env.USERDOMAIN;
    if (username) {
      return { name: domain ? `${domain}\\${username}` : username, sid: null };
    }
    throw new Error(`Unable to resolve current Windows identity: ${err.message}`);
  }
}

/**
 * Parses actual Access Control Entries (ACEs) from icacls output for a target path.
 */
function inspectAcl(targetPath) {
  if (process.platform !== 'win32') {
    throw new Error('ACL inspection is only supported on Windows platforms.');
  }

  const output = execFileSync('icacls.exe', [targetPath], { encoding: 'utf8' });
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const normalizedTarget = path.resolve(targetPath).toLowerCase();

  const entries = [];
  for (let line of lines) {
    if (line.startsWith('Successfully processed') || line.startsWith('Failed processing')) {
      continue;
    }
    if (line.toLowerCase().startsWith(normalizedTarget)) {
      line = line.slice(normalizedTarget.length).trim();
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const principal = line.slice(0, colonIdx).trim();
      const perms = line.slice(colonIdx + 1).trim();
      entries.push({
        principal,
        perms,
        isInherited: perms.includes('(I)')
      });
    }
  }
  return entries;
}

/**
 * Verifies that target path contains only authorized Windows principals and zero inherited permissions.
 */
function verifyAcl(targetPath, expectedUser = resolveCurrentWindowsIdentity(), options = {}) {
  const entries = inspectAcl(targetPath);
  if (entries.length === 0) {
    throw new Error(`ACL verification failed: No access control entries found for ${targetPath}`);
  }

  const normalizedUser = expectedUser.name.toLowerCase();
  const userNameOnly = normalizedUser.includes('\\') ? normalizedUser.split('\\')[1] : normalizedUser;
  const userSid = expectedUser.sid ? expectedUser.sid.toLowerCase() : null;

  for (const entry of entries) {
    if (entry.isInherited) {
      throw new Error(`ACL verification failed: Inherited permissions detected on ${targetPath} for ${entry.principal}`);
    }

    const principalNorm = entry.principal.toLowerCase();
    const isCurrentUser = (
      principalNorm === normalizedUser ||
      principalNorm === userNameOnly ||
      principalNorm.endsWith(`\\${userNameOnly}`) ||
      (userSid && principalNorm === userSid)
    );
    const isSystem = (
      principalNorm === 'nt authority\\system' ||
      principalNorm === 'system' ||
      principalNorm === 's-1-5-18'
    );

    if (!isCurrentUser && !isSystem) {
      throw new Error(`ACL verification failed: Unauthorized principal detected in ACL for ${targetPath}: ${entry.principal}`);
    }
  }

  const hasUserGrant = entries.some(entry => {
    const p = entry.principal.toLowerCase();
    return p === normalizedUser || p === userNameOnly || p.endsWith(`\\${userNameOnly}`) || (userSid && p === userSid);
  });

  if (!hasUserGrant) {
    throw new Error(`ACL verification failed: Intended Windows user ${expectedUser.name} not found in ACL grants for ${targetPath}`);
  }

  return entries;
}

/**
 * Enforces restrictive permissions on the dedicated credential directory.
 * Disables inheritance, removes unexpected grants, and gives full control to CurrentUser and SYSTEM.
 */
function enforceDirectoryAcl(dirPath, currentUser = resolveCurrentWindowsIdentity()) {
  if (process.platform !== 'win32') {
    throw new Error('ACL enforcement is only supported on Windows platforms.');
  }

  try {
    execFileSync('icacls.exe', [
      dirPath,
      '/inheritance:r',
      '/grant:r',
      `${currentUser.name}:(OI)(CI)F`,
      '/grant',
      '*S-1-5-18:(OI)(CI)F'
    ], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Windows directory ACL enforcement failed via icacls: ${err.message}`);
  }

  return module.exports.verifyAcl(dirPath, currentUser, { isDirectory: true });
}

/**
 * Enforces restrictive permissions on the credential file.
 * Disables inheritance, removes unexpected grants, and gives full control to CurrentUser and SYSTEM.
 */
function enforceFileAcl(filePath, currentUser = resolveCurrentWindowsIdentity()) {
  if (process.platform !== 'win32') {
    throw new Error('ACL enforcement is only supported on Windows platforms.');
  }

  try {
    execFileSync('icacls.exe', [
      filePath,
      '/inheritance:r',
      '/grant:r',
      `${currentUser.name}:F`,
      '/grant',
      '*S-1-5-18:F'
    ], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Windows file ACL enforcement failed via icacls: ${err.message}`);
  }

  return module.exports.verifyAcl(filePath, currentUser, { isDirectory: false });
}

/**
 * Windows DPAPI encryption wrapper using CurrentUser scope.
 * Strict Fail-Closed: Fails immediately if not on Windows or if ProtectedData fails.
 */
function dpapiProtect(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Plaintext string is required for DPAPI protection');
  }

  if (process.platform !== 'win32') {
    throw new Error('DPAPI secure credential storage is only supported on Windows platforms. Failing closed.');
  }

  const inputBase64 = Buffer.from(plaintext, 'utf8').toString('base64');
  const psCommand = `
    Add-Type -AssemblyName System.Security;
    $bytes = [Convert]::FromBase64String('${inputBase64}');
    $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Convert]::ToBase64String($enc);
  `;

  try {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8' });
    const trimmed = result.trim();
    if (!trimmed) {
      throw new Error('DPAPI encryption returned empty ciphertext');
    }
    return trimmed;
  } catch (err) {
    throw new Error(`DPAPI encryption failed: ${err.message}`);
  }
}

/**
 * Windows DPAPI decryption wrapper using CurrentUser scope.
 * Strict Fail-Closed: Fails immediately if not on Windows or if ciphertext is invalid.
 */
function dpapiUnprotect(encryptedBase64) {
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.trim().length === 0) {
    throw new Error('Encrypted base64 ciphertext is required for DPAPI decryption');
  }

  if (process.platform !== 'win32') {
    throw new Error('DPAPI secure credential decryption is only supported on Windows platforms. Failing closed.');
  }

  const psCommand = `
    Add-Type -AssemblyName System.Security;
    $bytes = [Convert]::FromBase64String('${encryptedBase64.trim()}');
    $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Convert]::ToBase64String($dec);
  `;

  try {
    const resultBase64 = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8' }).trim();
    if (!resultBase64) {
      throw new Error('DPAPI decryption returned empty plaintext');
    }
    return Buffer.from(resultBase64, 'base64').toString('utf8');
  } catch (err) {
    throw new Error(`DPAPI decryption failed: ${err.message}`);
  }
}

/**
 * Stores enrollment credentials securely on the local machine using DPAPI and Windows ACLs.
 * 1. Establishes and verifies dedicated directory (%APPDATA%\Mediblix\.device-auth\).
 * 2. Purges any pre-existing credential file to eliminate stale explicit ACEs.
 * 3. Exclusively creates a 0-byte credential file and establishes verified ACLs BEFORE writing secrets.
 * 4. Encrypts secret enrollmentKey via DPAPI and writes to verified file.
 * 5. Strict Fail-Closed: If verification fails, storage aborts and cleanup errors are never swallowed.
 */
function saveDeviceCredentials(deviceId, enrollmentKey) {
  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('Valid deviceId is required');
  }
  if (!enrollmentKey || typeof enrollmentKey !== 'string' || !enrollmentKey.trim()) {
    throw new Error('Valid enrollmentKey is required');
  }

  const currentUser = resolveCurrentWindowsIdentity();

  // 1. Establish and enforce ACLs on dedicated secure directory
  const credDir = getCredentialsDir();
  if (!fs.existsSync(credDir)) {
    fs.mkdirSync(credDir, { recursive: true });
  }
  module.exports.enforceDirectoryAcl(credDir, currentUser);

  // 2. Prepare credential file path
  const credPath = getCredentialsFilePath();

  // Purge pre-existing file to prevent retaining unexpected explicit ACEs
  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
  }

  // 3. Exclusively create 0-byte file and establish verified permissions BEFORE writing credentials
  const fd = fs.openSync(credPath, 'wx');
  fs.closeSync(fd);

  try {
    module.exports.enforceFileAcl(credPath, currentUser);
  } catch (aclErr) {
    let cleanupErr = null;
    try {
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
      }
    } catch (uErr) {
      cleanupErr = uErr;
    }
    if (cleanupErr) {
      throw new Error(`Credential storage aborted: Failed to enforce secure file permissions: ${aclErr.message}. Furthermore, cleanup of credential file failed: ${cleanupErr.message}`);
    }
    throw new Error(`Credential storage aborted: Failed to enforce secure file permissions: ${aclErr.message}`);
  }

  // 4. Encrypt secret enrollmentKey via DPAPI
  const payload = JSON.stringify({
    deviceId: deviceId.trim(),
    enrollmentKey: enrollmentKey.trim(),
    savedAt: new Date().toISOString()
  });

  const encrypted = dpapiProtect(payload);

  // 5. Write encrypted payload into already-hardened, verified file
  try {
    fs.writeFileSync(credPath, encrypted, { encoding: 'utf8' });
  } catch (writeErr) {
    try {
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
      }
    } catch (_) {}
    throw new Error(`Credential storage aborted: Failed to write encrypted credentials: ${writeErr.message}`);
  }

  // 6. Store non-secret deviceId in SQLite metadata only after secure storage succeeds
  setSyncMetadata('sync_device_id', deviceId.trim());
}

/**
 * Loads device credentials, checking:
 *  1. Environment overrides (MEDIBLIX_DEVICE_ID / MEDIBLIX_ENROLLMENT_KEY)
 *  2. DPAPI-protected credentials file (.device_credentials.enc) with strict ACL verification.
 */
function loadDeviceCredentials() {
  // Check environment variables first
  if (process.env.MEDIBLIX_DEVICE_ID && process.env.MEDIBLIX_ENROLLMENT_KEY) {
    return {
      deviceId: process.env.MEDIBLIX_DEVICE_ID.trim(),
      enrollmentKey: process.env.MEDIBLIX_ENROLLMENT_KEY.trim(),
      source: 'env'
    };
  }

  // Check DPAPI-encrypted file
  const credPath = getCredentialsFilePath();
  if (fs.existsSync(credPath)) {
    try {
      // Verify ACL on credentials file before trusting its content
      const currentUser = resolveCurrentWindowsIdentity();
      verifyAcl(credPath, currentUser, { isDirectory: false });

      const encrypted = fs.readFileSync(credPath, 'utf8').trim();
      const decryptedJson = dpapiUnprotect(encrypted);
      const data = JSON.parse(decryptedJson);
      if (data.deviceId && data.enrollmentKey) {
        return {
          deviceId: data.deviceId,
          enrollmentKey: data.enrollmentKey,
          source: 'dpapi'
        };
      }
    } catch (err) {
      console.error('[DeviceAuth Error] Could not read or verify credentials file:', err.message);
    }
  }

  // Fallback notice from SQLite sync_metadata
  let deviceId = null;
  try {
    deviceId = getSyncMetadata('sync_device_id');
  } catch (_) {}

  return {
    deviceId,
    enrollmentKey: null,
    source: 'none'
  };
}

/**
 * Exchanges device credentials with AWS backend: POST /api/sync/auth/token
 */
async function exchangeDeviceToken(options = {}) {
  const cloudUrl = options.cloudUrl || DEFAULT_CLOUD_URL;
  const credentials = options.credentials || loadDeviceCredentials();

  if (!credentials.deviceId || !credentials.enrollmentKey) {
    throw new Error('Device is not enrolled. Missing deviceId or enrollmentKey.');
  }

  const endpoint = `${cloudUrl}/api/sync/auth/token`;
  const body = {
    deviceId: credentials.deviceId,
    enrollmentKey: credentials.enrollmentKey,
    deviceInfo: {
      hostname: process.env.COMPUTERNAME || 'Mediblix-Terminal',
      os: process.platform,
      appVersion: '1.0.0'
    }
  };

  const res = await makeRequest(endpoint, {
    method: 'POST'
  }, body);

  if (res.statusCode === 200 && res.data && res.data.token) {
    const token = res.data.token;
    const expiresInSec = res.data.expiresIn || 3600;
    const expiresAt = Date.now() + expiresInSec * 1000;
    const organizationId = res.data.organizationId || null;

    // Cache in process memory ONLY
    memoryTokenCache = {
      token,
      expiresAt,
      organizationId,
      deviceId: credentials.deviceId
    };

    // Store non-sensitive metadata only in SQLite
    try {
      setSyncMetadata('sync_jwt_expires_at', new Date(expiresAt).toISOString());
      if (organizationId) {
        setSyncMetadata('sync_cloud_org_id', organizationId);
      }
    } catch (_) {}

    return {
      token,
      expiresAt,
      organizationId,
      deviceId: credentials.deviceId
    };
  }

  if (res.statusCode === 429) {
    const retryAfter = res.headers['retry-after'] || res.data?.retryAfterSeconds || 60;
    const err = new Error(`Authentication rate limited by cloud. Retry after ${retryAfter} seconds.`);
    err.code = 'RATE_LIMITED';
    err.statusCode = 429;
    err.retryAfter = Number(retryAfter);
    throw err;
  }

  if (res.statusCode === 503) {
    const err = new Error('Cloud sync authentication service temporarily unavailable (rate limiter check failed).');
    err.code = 'SERVICE_UNAVAILABLE';
    err.statusCode = 503;
    throw err;
  }

  if (res.statusCode === 401) {
    const err = new Error(`Device authentication rejected: ${res.data?.message || 'Invalid device credentials'}`);
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  throw new Error(`Device token exchange failed [HTTP ${res.statusCode}]: ${res.data?.message || JSON.stringify(res.data)}`);
}

/**
 * Retrieves valid cloud token from in-memory cache or performs exchange if expired/missing.
 */
async function getOrRefreshDeviceToken(options = {}) {
  const forceRefresh = options.forceRefresh || false;
  const now = Date.now();

  // If memory cache has token and expiration is safely in the future (> 10 mins)
  if (!forceRefresh && memoryTokenCache.token && memoryTokenCache.expiresAt && memoryTokenCache.expiresAt - now > EXPIRATION_BUFFER_MS) {
    return memoryTokenCache.token;
  }

  // Otherwise, perform fresh exchange
  const result = await exchangeDeviceToken(options);
  return result.token;
}

/**
 * Invalidates the in-memory token cache (e.g. upon receiving 401 from sync endpoints).
 */
function invalidateCachedToken() {
  memoryTokenCache = {
    token: null,
    expiresAt: null,
    organizationId: null,
    deviceId: null
  };
  try {
    setSyncMetadata('sync_jwt_expires_at', '0');
  } catch (_) {}
}

module.exports = {
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
  _getMemoryCache: () => memoryTokenCache
};
