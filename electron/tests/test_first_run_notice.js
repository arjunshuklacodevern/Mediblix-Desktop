/**
 * Mediblix Desktop — First-run notice regression tests
 *
 * Proves the initial-administrator dialog is a one-shot event:
 *  - an existing installation (no provisioning) never shows it
 *  - a fresh provisioning shows it exactly once
 *  - a notice file / env-provided password never triggers it
 *  - archiving is recoverable, owner-only, and never overwrites or deletes
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseCredentials,
  shouldNotify,
  archivePathFor,
  archiveCredentialsFile,
} = require('../first-run-notice');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ FAIL: ${name}\n      ${error.message}`);
    failed++;
  }
}

console.log('=================================================');
console.log(' First-Run Credential Notice Tests               ');
console.log('=================================================');

const CREDENTIAL_FILE = [
  '===================================================================',
  'Mediblix Desktop — Initial Super Admin Credentials',
  '===================================================================',
  'A unique, secure administrator account was provisioned for this system.',
  '',
  'Email:    admin@mediblix.local',
  'Password: TestOnlyPassword123',
  '',
  'SECURITY NOTICE:',
  '- These one-time credentials were generated on first launch.',
  '===================================================================',
  '',
].join('\r\n');

const NOTICE_FILE = [
  '===================================================================',
  'Mediblix Desktop — Administrator Account Notice',
  '===================================================================',
  'This file intentionally contains no password.',
  '===================================================================',
].join('\r\n');

console.log('\n[Group 1: Credential parsing]');

test('parses an Email/Password pair', () => {
  const parsed = parseCredentials(CREDENTIAL_FILE);
  assert(parsed, 'expected credentials');
  assert.strictEqual(parsed.email, 'admin@mediblix.local');
  assert.strictEqual(parsed.password, 'TestOnlyPassword123');
});

test('rejects the password-less notice file', () => {
  assert.strictEqual(parseCredentials(NOTICE_FILE), null);
});

test('rejects empty input and non-strings', () => {
  assert.strictEqual(parseCredentials(''), null);
  assert.strictEqual(parseCredentials(null), null);
  assert.strictEqual(parseCredentials(undefined), null);
});

console.log('\n[Group 2: Show decision]');

test('existing installation (not provisioned) does NOT notify', () => {
  assert.strictEqual(
    shouldNotify({ provisionedAdmin: false, credentials: parseCredentials(CREDENTIAL_FILE), alreadyHandled: false }),
    false
  );
});

test('fresh provisioning notifies once', () => {
  assert.strictEqual(
    shouldNotify({ provisionedAdmin: true, credentials: parseCredentials(CREDENTIAL_FILE), alreadyHandled: false }),
    true
  );
});

test('already-handled run does NOT notify again', () => {
  assert.strictEqual(
    shouldNotify({ provisionedAdmin: true, credentials: parseCredentials(CREDENTIAL_FILE), alreadyHandled: true }),
    false
  );
});

test('provisioning with env password (no credential file) does NOT notify', () => {
  assert.strictEqual(shouldNotify({ provisionedAdmin: true, credentials: null, alreadyHandled: false }), false);
});

console.log('\n[Group 3: Archive path selection]');

test('uses .shown.txt when free', () => {
  const p = archivePathFor('/tmp/INITIAL_ADMIN_CREDENTIALS.txt', { exists: () => false });
  assert.strictEqual(p, '/tmp/INITIAL_ADMIN_CREDENTIALS.shown.txt');
});

test('never overwrites an existing archive', () => {
  const fixed = new Date('2026-11-28T10:20:30.400Z');
  // Only the primary archive exists; the timestamped name must be chosen.
  const exists = (p) => p === '/tmp/INITIAL_ADMIN_CREDENTIALS.shown.txt';
  const p = archivePathFor('/tmp/INITIAL_ADMIN_CREDENTIALS.txt', { exists, now: () => fixed });
  assert.notStrictEqual(p, '/tmp/INITIAL_ADMIN_CREDENTIALS.shown.txt');
  assert(p.includes('.shown.'));
  assert(p.endsWith('.txt'));
});

test('never hangs when every candidate name appears taken', () => {
  const p = archivePathFor('/tmp/INITIAL_ADMIN_CREDENTIALS.txt', { exists: () => true });
  assert(p.endsWith('.txt'));
  assert(p.includes('.shown.'));
});

console.log('\n[Group 4: Archive behaviour]');

test('renames to the archive and applies owner-only permissions', () => {
  const calls = [];
  const fakeFs = {
    existsSync: (p) => p.endsWith('INITIAL_ADMIN_CREDENTIALS.txt'),
    renameSync: (from, to) => calls.push(['rename', from, to]),
    chmodSync: (p, mode) => calls.push(['chmod', p, mode]),
  };

  const result = archiveCredentialsFile('/app/INITIAL_ADMIN_CREDENTIALS.txt', { fsImpl: fakeFs });
  assert.strictEqual(result.archived, true);
  assert.strictEqual(result.path, '/app/INITIAL_ADMIN_CREDENTIALS.shown.txt');
  assert.deepStrictEqual(calls[0][0], 'rename');
  assert.strictEqual(calls[1][0], 'chmod');
  assert.strictEqual(calls[1][2], 0o600);
});

test('missing file is reported, not thrown', () => {
  const fakeFs = { existsSync: () => false, renameSync: () => {}, chmodSync: () => {} };
  const result = archiveCredentialsFile('/app/INITIAL_ADMIN_CREDENTIALS.txt', { fsImpl: fakeFs });
  assert.strictEqual(result.archived, false);
  assert.strictEqual(result.error, 'missing');
});

test('archive failure never destroys the credentials', () => {
  const fakeFs = {
    existsSync: () => true,
    renameSync: () => {
      throw new Error('EACCES');
    },
    chmodSync: () => {},
  };
  const result = archiveCredentialsFile('/app/INITIAL_ADMIN_CREDENTIALS.txt', { fsImpl: fakeFs });
  assert.strictEqual(result.archived, false);
  assert.strictEqual(result.error, 'EACCES');
});

test('real filesystem: content preserved, original removed, mode 600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediblix-firstrun-'));
  const credPath = path.join(dir, 'INITIAL_ADMIN_CREDENTIALS.txt');
  fs.writeFileSync(credPath, CREDENTIAL_FILE, { encoding: 'utf8', mode: 0o644 });

  const result = archiveCredentialsFile(credPath);
  assert.strictEqual(result.archived, true);
  assert.strictEqual(fs.existsSync(credPath), false, 'original must be moved, not left in place');
  assert.strictEqual(fs.readFileSync(result.path, 'utf8'), CREDENTIAL_FILE, 'content must be identical');
  assert.strictEqual(fs.statSync(result.path).mode & 0o777, 0o600);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second provisioning archives alongside the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediblix-firstrun2-'));
  const credPath = path.join(dir, 'INITIAL_ADMIN_CREDENTIALS.txt');

  fs.writeFileSync(credPath, CREDENTIAL_FILE);
  const first = archiveCredentialsFile(credPath);

  fs.writeFileSync(credPath, CREDENTIAL_FILE);
  const second = archiveCredentialsFile(credPath);

  assert.strictEqual(first.archived, true);
  assert.strictEqual(second.archived, true);
  assert.notStrictEqual(first.path, second.path);
  assert.strictEqual(fs.readFileSync(first.path, 'utf8'), CREDENTIAL_FILE);

  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n=================================================');
console.log(` Summary: ${passed} Passed, ${failed} Failed`);
console.log('=================================================');

if (failed > 0) process.exit(1);
