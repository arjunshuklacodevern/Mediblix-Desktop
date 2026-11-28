/**
 * Mediblix Desktop — First-run provisioning regression tests
 *
 * Proves:
 *  1. A fresh database provisions the superadmin once and reports it.
 *  2. /api/health exposes that fact as a boolean (and no credential material).
 *  3. Re-initialising the same database reports "not provisioned" and does not
 *     duplicate or reset the administrator.
 *  4. An isolated/test database never overwrites the canonical credentials file.
 */

import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "mediblix_first_run_test_secret_2026_0123456789abcdef";
// Force the "random password" provisioning path, which is the one that used to
// write the canonical credentials file.
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_EMAIL;

const tmpDb = path.join(os.tmpdir(), `mediblix_firstrun_${Date.now()}.db`);
process.env.MEDIBLIX_DB_PATH = tmpDb;

const { initDatabase, closeDatabase, getDatabase, wasSuperadminProvisionedThisLaunch } = require("../../database/db.js");
const { getInitialCredentialsPath } = require("../../database/paths.js");

const canonicalCredPath = getInitialCredentialsPath();

function cleanTempDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + ext);
    } catch {
      // ignore
    }
  }
}

function fileHash(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 4000, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

let passed = 0;
let failed = 0;
const assert = (cond, label) => {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
};

async function runTests() {
  console.log("=================================================");
  console.log(" First-Run Provisioning Tests                    ");
  console.log("=================================================");

  cleanTempDb();
  const canonicalHashBefore = fileHash(canonicalCredPath);

  let server = null;

  try {
    // ── Fresh database ────────────────────────────────────────────
    console.log("\n[Group 1: Fresh database provisions once]");
    initDatabase(tmpDb);

    assert(wasSuperadminProvisionedThisLaunch() === true, "provisioning flag is true after fresh init");

    const db = getDatabase();
    const admins = db.prepare("SELECT _id, email, role, created_at FROM users WHERE role = 'superadmin'").all();
    assert(admins.length === 1, "exactly one superadmin exists after fresh init");
    const firstCreatedAt = admins[0]?.created_at;

    // ── Health wiring ─────────────────────────────────────────────
    console.log("\n[Group 2: /api/health reports provisioning without secrets]");
    const { default: app } = await import("../index.js");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const health = await getJson(port, "/api/health");
    assert(health.status === 200, "GET /api/health returns 200");
    assert(health.json?.provisionedAdmin === true, "health reports provisionedAdmin=true for a fresh database");

    const serialized = JSON.stringify(health.json).toLowerCase();
    assert(!serialized.includes("password"), "health payload contains no password field");
    assert(!serialized.includes("@"), "health payload contains no email address");

    // ── Restart semantics ─────────────────────────────────────────
    console.log("\n[Group 3: Restart does not re-provision or replay]");
    closeDatabase();
    initDatabase(tmpDb);

    assert(wasSuperadminProvisionedThisLaunch() === false, "provisioning flag is false after re-init");

    const afterRestart = await getJson(port, "/api/health");
    assert(afterRestart.json?.provisionedAdmin === false, "health reports provisionedAdmin=false after restart");

    const dbAfter = getDatabase();
    const adminsAfter = dbAfter.prepare("SELECT _id, email, created_at FROM users WHERE role = 'superadmin'").all();
    assert(adminsAfter.length === 1, "still exactly one superadmin after restart");
    assert(adminsAfter[0]?._id === admins[0]?._id, "superadmin row identity preserved");
    assert(adminsAfter[0]?.created_at === firstCreatedAt, "superadmin creation timestamp unchanged (not recreated)");

    // ── Canonical file isolation ──────────────────────────────────
    console.log("\n[Group 4: Isolated database never touches the canonical file]");
    const canonicalHashAfter = fileHash(canonicalCredPath);
    assert(canonicalHashAfter === canonicalHashBefore, "canonical credentials file is byte-identical");

    const strayFiles = fs.readdirSync(path.dirname(tmpDb)).filter((name) => name.startsWith("INITIAL_ADMIN_CREDENTIALS"));
    assert(strayFiles.length === 0, "no credentials file was written next to the temporary database");
  } catch (error) {
    console.error("Unexpected error:", error);
    failed++;
  } finally {
    if (server) {
      try {
        server.closeAllConnections?.();
      } catch {}
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase();
    cleanTempDb();
  }

  console.log("\n=================================================");
  console.log(` Summary: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");

  // Explicit exit: no lingering handle should keep the test process alive.
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
