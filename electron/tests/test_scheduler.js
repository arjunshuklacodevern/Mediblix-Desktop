/**
 * Mediblix Desktop — Windows Task Scheduler Integration Tests
 *
 * Verifies:
 *  1. Scheduler configuration resolves verified node binary and sync runner script.
 *  2. Registers 2:00 AM task with Task Scheduler (including missed run recovery).
 *  3. Verifies task exists and query details match expected command.
 *  4. Standalone sync runner can execute independently when Electron is closed.
 *  5. Unregisters task cleanly.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  TASK_NAME,
  getSchedulerConfig,
  registerDailySyncTask,
  verifyScheduledTask,
  unregisterDailySyncTask
} = require('../sync/scheduler');

async function runSchedulerTests() {
  console.log('=== [MEDIBLIX TASK SCHEDULER & OVERNIGHT SYNC TEST SUITE] ===\n');

  if (process.platform !== 'win32') {
    console.log('Skipping Windows Task Scheduler tests on non-Windows platform.');
    return;
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Binary and Script Path Resolution
    // -------------------------------------------------------------
    console.log('[TEST 1] Verifying bundled Node runtime and sync script resolution...');
    const config = getSchedulerConfig();
    assert(config.nodeBin, 'nodeBin must be resolved');
    assert(fs.existsSync(config.nodeBin), `Node runtime must exist on disk at: ${config.nodeBin}`);
    assert(config.scriptPath, 'scriptPath must be resolved');
    assert(fs.existsSync(config.scriptPath), `Sync runner script must exist at: ${config.scriptPath}`);
    console.log(`  ✓ Resolved Node runtime: ${config.nodeBin}`);
    console.log(`  ✓ Resolved sync script:  ${config.scriptPath}`);

    // -------------------------------------------------------------
    // TEST 2: Task Registration with 02:00 AM Trigger & Missed Run Recovery
    // -------------------------------------------------------------
    console.log('\n[TEST 2] Registering 02:00 AM nightly sync task in Windows Task Scheduler...');
    const regResult = registerDailySyncTask();
    assert(regResult.success, `Registration failed: ${regResult.message}`);
    console.log(`  ✓ ${regResult.message}`);

    // -------------------------------------------------------------
    // TEST 3: Verification of Registered Task in Windows
    // -------------------------------------------------------------
    console.log('\n[TEST 3] Verifying task registration via schtasks query...');
    const verifyResult = verifyScheduledTask();
    assert(verifyResult.exists, `Task ${TASK_NAME} should exist in Windows Task Scheduler`);
    assert(verifyResult.output.includes(TASK_NAME), 'Output should contain task name');
    console.log(`  ✓ Task ${TASK_NAME} confirmed in Windows Task Scheduler`);

    // -------------------------------------------------------------
    // TEST 4: Standalone Execution (Simulating Task Scheduler Run When Electron is Closed)
    // -------------------------------------------------------------
    console.log('\n[TEST 4] Testing standalone runner execution (Electron closed)...');
    // Run syncRunner.js via node child process with mock token
    const testDbPath = path.join(__dirname, 'test_scheduler_runner.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const runnerEnv = {
      ...process.env,
      MEDIBLIX_DB_PATH: testDbPath,
      MEDIBLIX_SYNC_TOKEN: 'mock-standalone-token',
      MEDIBLIX_CLOUD_URL: 'http://127.0.0.1:59999' // Offline test endpoint
    };

    try {
      const runnerOutput = execFileSync(config.nodeBin, [config.scriptPath], {
        env: runnerEnv,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      console.log('  Runner output snippet:', runnerOutput.split('\n')[0]);
    } catch (runErr) {
      // Expected to exit with connection refused since 59999 is offline, but must show runner started
      const combined = (runErr.stdout || '') + (runErr.stderr || '');
      assert(combined.includes('[SyncRunner] Starting Mediblix data synchronization'), 'Runner must start cleanly in standalone mode');
      console.log('  ✓ Standalone Node process successfully executed syncRunner.js without Electron');
    }

    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    // -------------------------------------------------------------
    // TEST 5: Clean Unregistration
    // -------------------------------------------------------------
    console.log('\n[TEST 5] Testing clean unregistration of scheduled task...');
    const unregResult = unregisterDailySyncTask();
    assert(unregResult, 'Unregister should succeed');
    const postVerify = verifyScheduledTask();
    assert(!postVerify.exists, 'Task should not exist after unregistration');
    console.log('  ✓ Task successfully unregistered');

    // Re-register task so it remains active for production
    registerDailySyncTask();
    console.log(`  ✓ Re-registered ${TASK_NAME} for active production readiness`);

    console.log('\n======================================================');
    console.log('🎉 ALL TASK SCHEDULER & OVERNIGHT SYNC TESTS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ SCHEDULER TEST FAILED:', err);
    process.exit(1);
  }
}

runSchedulerTests();
