// The shuttle program's starter. start-shuttle.bat (and `npm start`) run this file.
//
// It runs Shuttle Control (src/shuttle-control.js), which runs the website and the Cloudflare
// connection. Updates install themselves and restart the website, but Shuttle Control is
// loaded once, so a fix to Shuttle Control itself would wait for someone to restart the PC
// program. Instead, when an update changes Shuttle Control, it stops cleanly and exits with
// code 76, and this starter starts the new version right away.
//
// Keep this file small and unchanging: it's the one part an update can't refresh by itself.
const path = require('node:path');
const { spawn } = require('node:child_process');

const RELOAD_CODE = 76; // "I was updated, start me again"
const root = path.join(__dirname, '..');
let child = null; let stopping = false; const crashes = [];

function run() {
  child = spawn(process.execPath, [path.join(__dirname, 'shuttle-control.js')], {
    cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, SHUTTLE_KEEPER: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === RELOAD_CODE) { console.log('\n  Shuttle Control was updated. Starting the new version...\n'); return setTimeout(run, 300); }
    if (code === 0) return process.exit(0); // turned off on purpose, or another copy is already running
    // It crashed: start it again, unless it keeps crashing.
    const now = Date.now(); crashes.push(now); while (crashes.length && now - crashes[0] > 10 * 60000) crashes.shift();
    if (crashes.length > 5) { console.log('\n  Shuttle Control keeps stopping. Close this window and start the shuttle again.\n'); return process.exit(1); }
    console.log(`\n  Shuttle Control stopped unexpectedly (${signal || `code ${code}`}). Starting it again in 10 seconds...\n`);
    setTimeout(run, 10000);
  });
}

// Ctrl+C or closing: Shuttle Control gets it too and shuts the website and Cloudflare down.
// On Windows the whole window gets Ctrl+C; elsewhere, pass it on.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    stopping = true;
    if (!child) return process.exit(0);
    if (process.platform !== 'win32') child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig);
  });
}

run();
