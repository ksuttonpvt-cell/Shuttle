// Keeps the shuttle website running: starts it, restarts it right away after an
// update (exit code 75), and restarts it 10 seconds after a crash.
// This file is read once at start, so updates can safely replace it on disk.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { RESTART_CODE } = require('./updater');

const root = path.join(__dirname, '..');
let child = null; let stopping = false;

function start() {
  const args = [];
  if (fs.existsSync(path.join(root, '.env'))) args.push('--env-file=.env');
  args.push(path.join('src', 'server.js'));
  child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === RESTART_CODE) {
      console.log('\n  Update installed. Starting the new version...\n');
      return start();
    }
    console.log(`\n  The shuttle website stopped unexpectedly (${signal || 'code ' + code}). Restarting in 10 seconds...\n`);
    setTimeout(start, 10000);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { stopping = true; if (child) child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig); else process.exit(0); });
}
start();
