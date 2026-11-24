const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');

// Ensure ELECTRON_RUN_AS_NODE is stripped so Electron runs in App mode, not Node CLI mode
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('close', (code, signal) => {
  if (code !== null) {
    process.exit(code);
  } else {
    process.exit(1);
  }
});
