/**
 * Mediblix Desktop — First-run credential notice helpers
 *
 * Kept free of Electron imports so the decision logic and the archive step can
 * be unit tested without launching a browser window.
 *
 * Rules implemented here:
 *  - The notice is shown only when a superadmin was genuinely provisioned by
 *    the backend process that is currently running.
 *  - The credentials file must actually contain a credential pair (a notice
 *    file or an env-provided password must never trigger a dialog).
 *  - The notice is one-shot per application run, and the file is archived
 *    afterwards so a later launch cannot replay it.
 *  - Archiving never overwrites an existing archive, keeps the file readable
 *    only by its owner, and never destroys the credentials if it fails.
 */

const fs = require('fs');
const path = require('path');

/**
 * Extracts the credential pair from the first-run file.
 * @returns {{ email: string, password: string } | null}
 */
function parseCredentials(content) {
  if (typeof content !== 'string' || content.length === 0) return null;

  const emailMatch = content.match(/^Email:\s*([^\r\n]+)/m);
  const passMatch = content.match(/^Password:\s*([^\r\n]+)/m);

  if (!emailMatch || !passMatch) return null;

  const email = emailMatch[1].trim();
  const password = passMatch[1].trim();
  if (!email || !password) return null;

  return { email, password };
}

/**
 * Decides whether the first-run dialog may be shown.
 */
function shouldNotify({ provisionedAdmin, credentials, alreadyHandled }) {
  return Boolean(provisionedAdmin) && Boolean(credentials) && !alreadyHandled;
}

/**
 * Chooses a non-destructive archive path next to the original file.
 */
function archivePathFor(credPath, { exists = fs.existsSync, now = () => new Date() } = {}) {
  const base = credPath.replace(/\.txt$/i, '');
  const primary = `${base}.shown.txt`;
  if (!exists(primary)) return primary;

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  let candidate = `${base}.shown.${stamp}.txt`;

  // Bounded search: a predicate that is always true must never hang the app.
  for (let counter = 1; counter <= 1000; counter += 1) {
    if (!exists(candidate)) return candidate;
    candidate = `${base}.shown.${stamp}-${counter}.txt`;
  }

  return `${base}.shown.${stamp}-${Math.random().toString(36).slice(2, 8)}.txt`;
}

/**
 * Renames the credentials file to a restricted-permission archive.
 * Never throws and never deletes the original if the rename fails.
 *
 * @returns {{ archived: boolean, path?: string, error?: string }}
 */
function archiveCredentialsFile(credPath, { fsImpl = fs, now = () => new Date() } = {}) {
  try {
    if (!fsImpl.existsSync(credPath)) {
      return { archived: false, error: 'missing' };
    }

    const target = archivePathFor(credPath, { exists: fsImpl.existsSync, now });
    fsImpl.renameSync(credPath, target);

    // The archive still holds a password: owner-only permissions.
    try {
      fsImpl.chmodSync(target, 0o600);
    } catch {
      // Best effort; the rename already succeeded.
    }

    return { archived: true, path: target };
  } catch (error) {
    return { archived: false, error: error.message };
  }
}

module.exports = {
  parseCredentials,
  shouldNotify,
  archivePathFor,
  archiveCredentialsFile,
};
