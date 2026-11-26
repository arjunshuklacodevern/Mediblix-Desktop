/**
 * Mediblix Desktop — Windows Task Scheduler Integration
 *
 * Configures a Windows Scheduled Task to run the standalone sync runner
 * every day at 02:00 AM using the bundled Node runtime.
 * Includes recovery for missed runs (computer off or asleep at 02:00 AM).
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { resolveNodeBinary } = require('../backend-supervisor');

const TASK_NAME = 'MediblixNightlySync';

function getSchedulerConfig() {
  const isPackaged = process.resourcesPath && !process.defaultApp;
  const nodeBin = resolveNodeBinary(isPackaged ? process.resourcesPath : null);

  const scriptPath = isPackaged
    ? path.join(process.resourcesPath, 'electron', 'sync', 'syncRunner.js')
    : path.resolve(__dirname, 'syncRunner.js');

  return { nodeBin, scriptPath };
}

/**
 * Registers or updates the 02:00 AM daily sync task in Windows Task Scheduler
 * Configured with -StartWhenAvailable to automatically catch up missed runs.
 */
function registerDailySyncTask() {
  if (process.platform !== 'win32') {
    return { success: false, message: 'Platform is not Windows' };
  }

  const { nodeBin, scriptPath } = getSchedulerConfig();

  if (!fs.existsSync(scriptPath)) {
    return { success: false, message: `Sync script not found at ${scriptPath}` };
  }

  const command = `"${nodeBin}" "${scriptPath}"`;

  // Strategy A: PowerShell Register-ScheduledTask with -StartWhenAvailable for missed run catch-up
  try {
    const escapedNode = nodeBin.replace(/'/g, "''");
    const escapedScript = scriptPath.replace(/'/g, "''");
    const workingDir = path.dirname(scriptPath).replace(/'/g, "''");
    const psCmd = `
      $action = New-ScheduledTaskAction -Execute '${escapedNode}' -Argument '${escapedScript}' -WorkingDirectory '${workingDir}';
      $trigger = New-ScheduledTaskTrigger -Daily -At 02:00AM;
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew;
      Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force;
    `.replace(/\r?\n\s*/g, ' ');

    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: 'pipe' });
    return { success: true, message: `Task ${TASK_NAME} registered for daily execution at 02:00 AM with missed-run recovery` };
  } catch (psErr) {
    // Strategy B: Fallback to standard schtasks CLI
    try {
      const schCmd = `schtasks /Create /TN "${TASK_NAME}" /TR '${command}' /SC DAILY /ST 02:00 /F`;
      execSync(schCmd, { stdio: 'pipe' });
      return { success: true, message: `Task ${TASK_NAME} registered for daily execution at 02:00 AM via schtasks` };
    } catch (schErr) {
      return { success: false, message: `Failed to register scheduled task: ${schErr.message}` };
    }
  }
}

/**
 * Queries the registration status and configuration of the scheduled task.
 */
function verifyScheduledTask() {
  if (process.platform !== 'win32') {
    return { exists: false, details: 'Not a Windows platform' };
  }

  try {
    const output = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST`, { encoding: 'utf8', stdio: 'pipe' });
    return { exists: true, output: output.trim() };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

/**
 * Removes the scheduled sync task
 */
function unregisterDailySyncTask() {
  if (process.platform !== 'win32') return false;
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  TASK_NAME,
  getSchedulerConfig,
  registerDailySyncTask,
  verifyScheduledTask,
  unregisterDailySyncTask
};
