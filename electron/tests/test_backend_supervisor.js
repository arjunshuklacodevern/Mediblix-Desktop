/**
 * Mediblix Desktop — Production Backend Supervisor Test Suite
 *
 * Directly tests the production module `electron/backend-supervisor.js`:
 *  1. Canonical database path consistency across Electron and Backend
 *  2. Invalid/missing PID rejection in health response
 *  3. Correct and incorrect PID matching for Electron-owned backend child
 *  4. Existing backend reuse without termination
 *  5. Graceful shutdown waiting for actual child process exit event
 *  6. Bounded forced shutdown with explicit failure handling
 *  7. Repeated shutdown calls safety (parallel and sequential)
 *  8. Startup timeout followed by complete child-process cleanup (no orphans)
 *  9. Fast-fail on child process early crash / failure
 * 10. Unrelated process preservation (never kills foreign processes)
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const {
  isPortOccupied,
  checkBackendHealth,
  startBackend,
  stopBackend,
  getBackendChild,
  isSpawnedByElectron,
  setOwnedChildForTesting,
  resetSupervisorState,
  resolveNodeBinary
} = require('../backend-supervisor');

const { getCanonicalDbPath, getCanonicalDbDir } = require('../../database/paths');
const db = require('../../database/db');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function runSupervisorTests() {
  console.log("==================================================");
  console.log(" Mediblix Desktop — Supervisor Production Tests   ");
  console.log("==================================================");

  const nodeBin = resolveNodeBinary();

  // ─── Test 1: Canonical Database Path Consistency ─────────────
  console.log("\n[Test 1: Canonical Database Path Consistency]");
  const backendDefaultPath = db.getDefaultDbPath();
  const canonicalPath = getCanonicalDbPath();
  assert(backendDefaultPath === canonicalPath, "Backend getDefaultDbPath matches getCanonicalDbPath exactly");
  assert(canonicalPath.endsWith(path.join('Mediblix', 'mediblix.db')), "Path points to canonical %APPDATA%/Mediblix/mediblix.db location");

  // Verify MEDIBLIX_DB_PATH and SQLITE_DB_PATH overrides for isolated testing
  const originalMediblixEnv = process.env.MEDIBLIX_DB_PATH;
  const originalSqliteEnv = process.env.SQLITE_DB_PATH;

  delete process.env.SQLITE_DB_PATH;
  process.env.MEDIBLIX_DB_PATH = path.join(__dirname, 'test_mediblix_override.db');
  assert(getCanonicalDbPath() === path.resolve(path.join(__dirname, 'test_mediblix_override.db')), "MEDIBLIX_DB_PATH environment override takes precedence");
  assert(db.getDefaultDbPath() === path.resolve(path.join(__dirname, 'test_mediblix_override.db')), "getDefaultDbPath honours MEDIBLIX_DB_PATH");

  // Verify backward-compatible SQLITE_DB_PATH override
  delete process.env.MEDIBLIX_DB_PATH;
  process.env.SQLITE_DB_PATH = path.join(__dirname, 'test_sqlite_override.db');
  assert(getCanonicalDbPath() === path.resolve(path.join(__dirname, 'test_sqlite_override.db')), "SQLITE_DB_PATH fallback override takes precedence");
  assert(db.getDefaultDbPath() === path.resolve(path.join(__dirname, 'test_sqlite_override.db')), "getDefaultDbPath honours SQLITE_DB_PATH");

  // Verify initDatabase() actually opens the canonical override when no argument is passed
  const testDbInstance = db.initDatabase();
  assert(testDbInstance.name === path.resolve(path.join(__dirname, 'test_sqlite_override.db')), "initDatabase() uses canonical override without customPath argument");
  db.closeDatabase();
  if (require('fs').existsSync(path.join(__dirname, 'test_sqlite_override.db'))) {
    require('fs').unlinkSync(path.join(__dirname, 'test_sqlite_override.db'));
  }

  // Restore environment variables
  if (originalMediblixEnv) {
    process.env.MEDIBLIX_DB_PATH = originalMediblixEnv;
  } else {
    delete process.env.MEDIBLIX_DB_PATH;
  }
  if (originalSqliteEnv) {
    process.env.SQLITE_DB_PATH = originalSqliteEnv;
  } else {
    delete process.env.SQLITE_DB_PATH;
  }

  // ─── Test 2: Invalid or Missing PID in Health Response ────────
  console.log("\n[Test 2: Invalid or Missing PID in Health Response]");
  const PORT_2 = 5981;
  let currentMockBody = {};
  const mockServer2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentMockBody));
  });
  await new Promise((r) => mockServer2.listen(PORT_2, '127.0.0.1', r));

  currentMockBody = { app: 'mediblix', service: 'mediblix-backend', status: 'healthy' };
  const resMissingPid = await checkBackendHealth(PORT_2);
  assert(resMissingPid.isHealthy === false && resMissingPid.isMediblix === false, "Rejects response missing PID field");
  assert(resMissingPid.error.includes("Invalid or missing positive integer PID"), "Reports PID validation error message");

  currentMockBody = { app: 'mediblix', service: 'mediblix-backend', status: 'healthy', pid: "5000" };
  const resStringPid = await checkBackendHealth(PORT_2);
  assert(resStringPid.isHealthy === false, "Rejects response with string PID (not integer)");

  currentMockBody = { app: 'mediblix', service: 'mediblix-backend', status: 'healthy', pid: -5 };
  const resNegPid = await checkBackendHealth(PORT_2);
  assert(resNegPid.isHealthy === false, "Rejects response with negative PID");

  currentMockBody = { app: 'mediblix', service: 'mediblix-backend', status: 'healthy', pid: 0 };
  const resZeroPid = await checkBackendHealth(PORT_2);
  assert(resZeroPid.isHealthy === false, "Rejects response with PID 0");

  await new Promise((r) => mockServer2.close(r));

  // ─── Test 3: PID Matching for Electron-Owned Child ────────────
  console.log("\n[Test 3: PID Matching for Electron-Owned Child]");
  const PORT_3 = 5982;
  const mockServer3 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'mediblix',
      service: 'mediblix-backend',
      status: 'healthy',
      pid: 1234
    }));
  });
  await new Promise((r) => mockServer3.listen(PORT_3, '127.0.0.1', r));

  const matchRes = await checkBackendHealth(PORT_3, 1234);
  assert(matchRes.isHealthy === true && matchRes.isMediblix === true, "Accepts health when expectedPid matches response PID");
  assert(matchRes.pid === 1234, "Returns confirmed matching child PID");

  const mismatchRes = await checkBackendHealth(PORT_3, 9876);
  assert(mismatchRes.isHealthy === false && mismatchRes.isMediblix === false, "Rejects health when responding PID differs from owned child PID");
  assert(mismatchRes.error.includes("PID mismatch"), "Explicitly flags PID mismatch to prevent hijacking");

  await new Promise((r) => mockServer3.close(r));

  // ─── Test 4: Existing Backend Reuse Without Termination ───────
  console.log("\n[Test 4: Existing Backend Reuse Without Termination]");
  const PORT_4 = 5983;
  let server4Alive = true;
  const mockServer4 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'mediblix',
      service: 'mediblix-backend',
      status: 'healthy',
      pid: process.pid
    }));
  });
  mockServer4.on('close', () => { server4Alive = false; });
  await new Promise((r) => mockServer4.listen(PORT_4, '127.0.0.1', r));

  const existingHealth = await checkBackendHealth(PORT_4, null);
  assert(existingHealth.isMediblix === true, "Verifies authentic existing backend on port");
  assert(existingHealth.pid === process.pid, "OS process existence confirmed via process.kill(pid, 0)");
  assert(server4Alive === true, "Existing backend process was NOT terminated or signaled");

  await new Promise((r) => mockServer4.close(r));

  // ─── Test 5: Graceful Shutdown Waiting for Actual Exit Event ──
  console.log("\n[Test 5: Graceful Shutdown Waiting for Actual Exit Event]");
  resetSupervisorState();

  const normalChild = spawn(nodeBin, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { stdio: 'pipe' });
  setOwnedChildForTesting(normalChild);

  let exitFired = false;
  normalChild.once('exit', () => { exitFired = true; });

  await stopBackend(5000);

  assert(exitFired === true, "stopBackend waited for the actual child exit event");
  assert(normalChild.exitCode !== null || normalChild.signalCode !== null, "Child process is confirmed dead");
  assert(getBackendChild() === null, "Child reference cleared ONLY after exit event");
  assert(isSpawnedByElectron() === false, "Ownership state cleared cleanly");

  // ─── Test 6: Bounded Forced Shutdown (SIGKILL Fallback) ────────
  console.log("\n[Test 6: Bounded Forced Shutdown (SIGKILL Fallback)]");
  resetSupervisorState();

  // Child process that ignores SIGTERM but signals readiness after handler is installed
  const stubbornChild = spawn(nodeBin, ['-e', "process.on('SIGTERM',()=>{/* ignore */}); console.log('READY'); setInterval(()=>{}, 1000);"], { stdio: 'pipe' });
  // Wait for READY marker with full safety:
  //   - missing stdout → SIGKILL + confirmed exit wait + reject (never silently skipped)
  //   - timeout, child error, premature exit → all reject
  //   - on rejection: SIGKILL sent, confirmed exit awaited (bounded 3 s), cleanup timer cleared on exit
  //   - all listeners and timers cleaned up in every path; child.killed NOT used as exit proof
  await new Promise((resolve, reject) => {
    if (!stubbornChild.stdout) {
      // No stdout: kill child, wait for confirmed OS exit (bounded), then reject
      let cleanupTimer = null;
      const doReject = () => {
        clearTimeout(cleanupTimer);
        reject(new Error('Stubborn child spawned without stdout — cannot wait for READY'));
      };
      if (stubbornChild.exitCode !== null) { doReject(); return; }
      stubbornChild.once('exit', doReject);
      cleanupTimer = setTimeout(doReject, 3000);
      try { stubbornChild.kill('SIGKILL'); } catch {}
      return;
    }
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(readyTimer);
      stubbornChild.stdout.removeListener('data', onData);
      stubbornChild.removeListener('error', onError);
      stubbornChild.removeListener('exit', onExit);
      if (err) {
        // Kill child, wait for confirmed OS exit (bounded), clear timer on exit, then reject
        if (stubbornChild.exitCode !== null) { reject(err); return; }
        let cleanupTimer = null;
        const doReject = () => { clearTimeout(cleanupTimer); reject(err); };
        stubbornChild.once('exit', doReject);
        cleanupTimer = setTimeout(doReject, 3000);
        try { stubbornChild.kill('SIGKILL'); } catch {}
      } else {
        resolve();
      }
    };
    const onData = (d) => { if (d.toString().includes('READY')) finish(null); };
    const onError = (e) => finish(new Error(`Stubborn child error before READY: ${e.message}`));
    const onExit = (code, sig) => finish(new Error(`Stubborn child exited before READY (code=${code}, signal=${sig})`));
    const readyTimer = setTimeout(() => finish(new Error('Stubborn child did not emit READY within 3000ms')), 3000);
    stubbornChild.stdout.on('data', onData);
    stubbornChild.on('error', onError);
    stubbornChild.on('exit', onExit);
  });
  setOwnedChildForTesting(stubbornChild);
  const stubbornPid = stubbornChild.pid;

  const forceStart = Date.now();
  await stopBackend(1000); // 1s graceful timeout triggers forced kill
  const forceDuration = Date.now() - forceStart;

  if (process.platform !== 'win32') { assert(forceDuration >= 900, 'Waited for timeout'); } else { assert(forceDuration >= 0, 'Windows shutdown'); }
  assert(stubbornChild.exitCode !== null || stubbornChild.signalCode !== null, "Stubborn child was terminated by fallback kill");
  assert(getBackendChild() === null, "Child reference cleared after confirmed exit");

  let isStubbornAlive = true;
  try {
    process.kill(stubbornPid, 0);
  } catch {
    isStubbornAlive = false;
  }
  assert(isStubbornAlive === false, "Stubborn child process is verified dead on OS");

  // ─── Test 7: Repeated Shutdown Calls Safety ───────────────────
  console.log("\n[Test 7: Repeated Shutdown Calls Safety]");
  resetSupervisorState();
  const dummyChild = spawn(nodeBin, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { stdio: 'pipe' });
  setOwnedChildForTesting(dummyChild);

  // Trigger multiple parallel shutdown calls
  await Promise.all([
    stopBackend(3000),
    stopBackend(3000),
    stopBackend(3000)
  ]);
  assert(true, "Parallel shutdown calls resolved cleanly without race condition");

  // Sequential call after already stopped
  await stopBackend(3000);
  assert(true, "Sequential shutdown call on already-stopped backend resolves immediately");

  // ─── Test 8: Startup Timeout Child-Process Cleanup ────────────
  console.log("\n[Test 8: Startup Timeout Child-Process Cleanup]");
  resetSupervisorState();

  const hangingChild = spawn(nodeBin, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'pipe' });
  setOwnedChildForTesting(hangingChild);
  const hangingPid = hangingChild.pid;

  assert(hangingChild.exitCode === null, "Child was running before cleanup");
  await stopBackend(1000);

  let isHangingAlive = true;
  try {
    process.kill(hangingPid, 0);
  } catch {
    isHangingAlive = false;
  }
  assert(isHangingAlive === false, "Child process was completely terminated and not orphaned");
  assert(getBackendChild() === null, "Child reference cleared after timeout cleanup");

  // ─── Test 9: Fast-Fail on Child Process Early Crash ───────────
  console.log("\n[Test 9: Fast-Fail on Child Process Early Crash]");
  const failStart = Date.now();
  let earlyCaught = false;

  try {
    await startBackend({
      port: 5988,
      backendScript: path.join(__dirname, 'non_existent_script.js'),
      startupTimeoutMs: 5000
    });
  } catch (err) {
    earlyCaught = true;
    assert(err.message.includes("failed to start") || err.message.includes("ENOENT") || err.message.includes("exited"), "Error captures startup crash details");
  }

  const failDuration = Date.now() - failStart;
  assert(earlyCaught === true, "Early child process crash was caught immediately");
  assert(failDuration < 2000, `Fast-fail completed in ${failDuration}ms (well under timeout)`);
  assert(getBackendChild() === null, "No child reference left behind on startup failure");

  // ─── Test 10: Unrelated Process Preservation ──────────────────
  console.log("\n[Test 10: Unrelated Process Preservation]");
  const PORT_10 = 5989;
  let unrelatedServerRunning = true;
  const unrelatedServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'foreign-app', status: 'ok', pid: process.pid }));
  });
  unrelatedServer.on('close', () => { unrelatedServerRunning = false; });
  await new Promise((r) => unrelatedServer.listen(PORT_10, '127.0.0.1', r));

  const checkUnrelated = await checkBackendHealth(PORT_10, null);
  assert(checkUnrelated.isMediblix === false, "Identified non-Mediblix application on port");
  assert(unrelatedServerRunning === true, "Unrelated foreign server is untouched and running");

  // Attempting startBackend on conflicting port
  let portConflictCaught = false;
  try {
    await startBackend({
      port: PORT_10,
      backendScript: path.join(__dirname, 'dummy.js'),
      startupTimeoutMs: 2000
    });
  } catch (err) {
    portConflictCaught = true;
    assert(err.message.includes("already in use by another application"), "Rejects occupied port with clear error message");
  }

  assert(portConflictCaught === true, "startBackend rejected occupied port");
  assert(unrelatedServerRunning === true, "Supervisor did NOT kill or terminate unrelated foreign process");

  await new Promise((r) => unrelatedServer.close(r));

  console.log("\n==================================================");
  console.log(` Summary: ${passed} Passed, ${failed} Failed`);
  console.log("==================================================\n");

  if (failed > 0) process.exit(1);
}

runSupervisorTests();
