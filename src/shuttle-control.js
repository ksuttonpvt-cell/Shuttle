// Keeps the shuttle website running: starts it, restarts it right away after an
// update (exit code 75), and restarts it 10 seconds after a crash.
// It also runs "Shuttle Control", a small page for this PC only (http://127.0.0.1:3001)
// to see the site's status and log, and start, stop or restart it. Open it with
// "Shuttle Control.bat". It keeps working even while the website itself is stopped.
// It's started by src/supervisor.js (the starter). This file is read once at start, so
// updates can safely replace it on disk. When an update changes it (or the parts it loads),
// it stops cleanly and exits with code 76, and the starter runs the new version.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { RESTART_CODE } = require('./updater');
const { createLogbook, eachLine } = require('./logbook');
const tunnelKit = require('./tunnel');
const crypto = require('node:crypto');
const rollback = require('./rollback');

// The code Shuttle Control runs. If an update changes any of it, Shuttle Control restarts
// itself (through the starter) so the fix applies without anyone touching the PC.
const OWN_CODE = ['shuttle-control.js', 'tunnel.js', 'logbook.js', 'updater.js', 'rollback.js'].map((f) => path.join(__dirname, f));
if (process.env.SHUTTLE_CONTROL_EXTRA_CODE) OWN_CODE.push(process.env.SHUTTLE_CONTROL_EXTRA_CODE); // tests: a file to change instead of the real code
const fingerprint = () => {
  const h = crypto.createHash('sha1');
  for (const f of OWN_CODE) { try { h.update(fs.readFileSync(f)); } catch { h.update(`missing ${f}`); } }
  return h.digest('hex');
};
const startedWith = fingerprint();
const RELOAD_CODE = 76;

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) { try { process.loadEnvFile(envFile); } catch { /* the site reads it too */ } }
const sitePort = Number(process.env.PORT) || 3000;
const controlPort = Number(process.env.CONTROL_PORT) || 3001;
const dataDir = path.dirname(path.resolve(root, process.env.DB_FILE || path.join('data', 'shuttle.db')));
const logsDir = path.join(dataDir, 'logs');
const backupsDir = path.join(dataDir, 'backups');

// Everything the site prints shows in this window as-is, and goes to data/logs/shuttle-<day>.log
// (with any password hidden).
const logbook = createLogbook({ dir: logsDir, max: 3000 });
const say = (text, level) => { console.log(`  ${text}`); logbook.add(`[control] ${text}`, { level, source: 'control' }); };

let child = null;
let state = 'stopped'; // starting, running, stopping, stopped, waiting (after a crash)
let since = new Date(); let wanted = 'running'; let restartNext = false; let quitting = false;
let restarts = 0; let lastExit = null; let crashTimer = null; const crashes = [];
// A freshly installed update is on trial: if it keeps the website from running, it's undone.
const probation = rollback.createProbation({ dataDir, keepAfterMs: Number(process.env.UPDATE_TRIAL_KEEP_MS) || undefined, giveUpAfterMs: Number(process.env.UPDATE_TRIAL_GIVE_UP_MS) || undefined });
let undoing = false;

function setState(s) { state = s; since = new Date(); }

function start() {
  if (child) return;
  clearTimeout(crashTimer); crashTimer = null;
  wanted = 'running';
  const args = [];
  if (fs.existsSync(envFile)) args.push('--env-file=.env');
  args.push(path.join('src', 'server.js'));
  setState('starting');
  probation.started();
  child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHUTTLE_SUPERVISED: '1' }, windowsHide: true });
  eachLine(child.stdout, (l) => { process.stdout.write(`${l}\n`); logbook.add(l); if (state === 'starting' && /running at/i.test(l)) setState('running'); });
  eachLine(child.stderr, (l) => { process.stderr.write(`${l}\n`); logbook.add(l, { fromStderr: true }); });
  child.on('exit', (code, signal) => {
    child = null;
    lastExit = { at: new Date().toISOString(), code, signal };
    if (quitting) return process.exit(0);
    if (undoing) return; // stopped on purpose to put the old version back
    if (restartNext) { restartNext = false; restarts++; say('Restarting the website...'); return start(); }
    if (wanted === 'stopped') { setState('stopped'); say('The website is stopped. Use Start to run it again.'); return; }
    if (code === RESTART_CODE) {
      // Started by the starter, and the update changed Shuttle Control itself: hand over to the new version.
      if (process.env.SHUTTLE_KEEPER === '1' && fingerprint() !== startedWith) return reloadSelf();
      restarts++; say('Update installed (or restart asked for). Starting the new version...'); return start();
    }
    // Crashed right after an update? Put the version before it back.
    const why = probation.crashed();
    if (why) return undoUpdate(why);
    // Crashed. Wait 10 seconds, or a minute if it keeps crashing.
    const now = Date.now(); crashes.push(now); while (crashes.length && now - crashes[0] > 120000) crashes.shift();
    const wait = crashes.length >= 5 ? 60 : 10;
    say(`The website stopped unexpectedly (${signal || 'code ' + code}). Restarting in ${wait} seconds...`, 'error');
    setState('waiting');
    crashTimer = setTimeout(() => { restarts++; start(); }, wait * 1000);
  });
}
function stop() {
  wanted = 'stopped'; clearTimeout(crashTimer); crashTimer = null;
  probation.stop(); // stopped by hand: the trial starts over next time it's started
  if (child) { setState('stopping'); child.kill(); } else setState('stopped');
}
function restart() {
  if (!child) return start();
  restartNext = true; setState('stopping'); child.kill();
}

// ---------- auto-undo for bad updates ----------
async function undoUpdate(reason) {
  if (undoing) return;
  undoing = true;
  probation.stop();
  clearTimeout(crashTimer); crashTimer = null;
  const p = rollback.pending(dataDir);
  say(`The update to ${p ? p.to.slice(0, 7) : 'the new version'} isn't working (${reason}). Putting the version before it back...`, 'error');
  setState('stopping');
  if (child) { const c = child; await new Promise((r) => { c.once('exit', r); c.kill(); setTimeout(r, 8000); }); }
  try {
    const rec = await rollback.undo({ root, dataDir, reason });
    say(`Back on ${rec.good.slice(0, 7)}. That update won't be installed again; the next one will install as usual.`, 'warn');
  } catch (e) {
    say(`Couldn't undo the update: ${e.message}`, 'error');
    rollback.clearPending(dataDir); // don't keep trying; the crash restarts below still run
  }
  undoing = false;
  if (process.env.SHUTTLE_KEEPER === '1' && fingerprint() !== startedWith) return reloadSelf();
  restarts++; start();
}
// While an update is on trial, check the website every few seconds.
setInterval(async () => {
  if (!probation.watching || undoing || wanted !== 'running') return;
  const ok = !!child && state === 'running' && await siteHealthy();
  const verdict = probation.healthy(ok);
  if (verdict === 'keep') say('The update is working. Keeping it.');
  else if (verdict) undoUpdate(verdict);
}, Number(process.env.UPDATE_TRIAL_CHECK_MS) || 5000).unref();

// ---------- Cloudflare connection ----------
// With CLOUDFLARE_TUNNEL_TOKEN in .env (saved from Shuttle Control), this runs cloudflared
// too and reconnects it if it drops. If cloudflared already runs another way (for example
// as a Windows service), it's left alone and just shown.
const tunnel = tunnelKit.createTunnel({
  root, pidFile: path.join(dataDir, 'cloudflared.pid'),
  log: (m, level) => say(`[tunnel] ${m}`, level),
  line: (l) => {
    const level = /\bERR\b/.test(l) ? 'error' : /\bWRN\b/.test(l) ? 'warn' : 'info';
    logbook.add(`[cloudflared] ${l.replace(/^\S+Z\s+/, '')}`, { level, source: 'tunnel' });
  },
});
const tunnelOpts = () => ({ token: process.env.CLOUDFLARE_TUNNEL_TOKEN || '', protocol: process.env.TUNNEL_PROTOCOL || 'auto' });
async function startTunnelIfSetUp() {
  if (!process.env.CLOUDFLARE_TUNNEL_TOKEN) return;
  const other = await tunnelKit.probe();
  if (other.ready && !tunnel.state().running) {
    say(`Cloudflare is already connected by another cloudflared on this PC (status port ${other.port}), so Shuttle Control won't start a second one.`);
    return;
  }
  try { tunnel.start(tunnelOpts()); } catch (e) { say(`[tunnel] ${e.message}`, 'warn'); }
}

// Stop the Cloudflare connection (and wait until it's closed), free Shuttle Control's port,
// then exit with 76 so the starter runs the updated Shuttle Control, which starts it all again.
async function reloadSelf() {
  say('This update also changed Shuttle Control. Restarting it so the new version takes over; the website is back in a few seconds.');
  quitting = true; setState('stopping');
  await tunnel.stopAndWait(5000);
  control.close(); if (control.closeAllConnections) control.closeAllConnections();
  setTimeout(() => process.exit(RELOAD_CODE), 200);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { quitting = true; tunnel.stop(); if (child) child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig); else process.exit(0); });
}

// ---------- Shuttle Control (this PC only) ----------
let version = null;
function readVersion() {
  execFile('git', ['log', '-1', '--format=%h|%cI|%s'], { cwd: root, windowsHide: true, timeout: 10000 }, (err, out) => {
    if (err) return;
    const [hash, date, ...subject] = String(out).trim().split('|');
    let app = null;
    try { app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch { /* unknown */ }
    version = { app, hash, date, subject: subject.join('|') };
  });
}
async function siteHealthy() {
  try { const r = await fetch(`http://127.0.0.1:${sitePort}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
}
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.setEncoding('utf8');
  req.on('data', (d) => { s += d; if (s.length > 20000) { reject(new Error('too big')); req.destroy(); } });
  req.on('end', () => resolve(s)); req.on('error', reject);
});
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

const control = http.createServer(async (req, res) => {
  // Only this PC: the page must be opened as 127.0.0.1 or localhost (stops other websites
  // reaching it through DNS tricks), and actions need a header other websites can't send.
  const host = String(req.headers.host || '');
  if (![`127.0.0.1:${controlPort}`, `localhost:${controlPort}`].includes(host)) return json(res, 403, { error: 'Open Shuttle Control on this PC only.' });
  const url = new URL(req.url, `http://${host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    return res.end(fs.readFileSync(path.join(__dirname, 'control.html'), 'utf8').replaceAll('{{SITE_PORT}}', String(sitePort)));
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const token = process.env.CLOUDFLARE_TUNNEL_TOKEN || '';
    // Our own cloudflared's status port when we run it; otherwise any cloudflared on this PC.
    const own = tunnel.state();
    const t = own.running ? (await tunnelKit.probePort(own.metrics_port, 800, fetch) || { running: true, ready: false, connections: 0, locations: [] }) : await tunnelKit.probe();
    return json(res, 200, {
      tunnel: { ...tunnel.state(), ...t, has_token: !!token, tunnel_id: token ? tunnelKit.tunnelIdOf(token) : null,
        protocol: process.env.TUNNEL_PROTOCOL || 'auto', installed: !!tunnelKit.findCloudflared(root) },
      state, since: since.toISOString(), pid: child?.pid || null, restarts, last_exit: lastExit,
      site_ok: state === 'running' ? await siteHealthy() : false, site_url: `http://localhost:${sitePort}`,
      control_started: startedAt, version, log_counts: logbook.counts(), logs_dir: logsDir, data_dir: dataDir,
      log_files: logbook.files().slice(0, 7),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const p = url.searchParams;
    return json(res, 200, { lines: logbook.recent({ after: Number(p.get('after')) || 0, level: p.get('level') || '', q: p.get('q') || '', limit: p.get('limit') || 500 }) });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (req.headers['x-shuttle-control'] !== '1') return json(res, 403, { error: 'Not allowed.' });
    const action = url.pathname.slice(5);
    if (action.startsWith('tunnel/')) {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'Bad request.' }); }
      try {
        const what = action.slice(7);
        if (what === 'token') {
          const token = tunnelKit.cleanToken(body.token);
          if (!token) return json(res, 400, { error: "That doesn't look like a tunnel token. Copy the long code from the Cloudflare dashboard (it starts with eyJ)." });
          tunnelKit.setEnvValue(envFile, 'CLOUDFLARE_TUNNEL_TOKEN', token);
          process.env.CLOUDFLARE_TUNNEL_TOKEN = token;
          say('Tunnel token saved. Connecting to Cloudflare...');
          tunnel.restart(tunnelOpts());
        } else if (what === 'forget') {
          tunnel.stop(); tunnelKit.setEnvValue(envFile, 'CLOUDFLARE_TUNNEL_TOKEN', null); delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
          say('Tunnel token removed. Shuttle Control no longer runs the Cloudflare connection.', 'warn');
        } else if (what === 'protocol') {
          const p = ['auto', 'quic', 'http2'].includes(body.protocol) ? body.protocol : 'auto';
          tunnelKit.setEnvValue(envFile, 'TUNNEL_PROTOCOL', p === 'auto' ? null : p);
          if (p === 'auto') delete process.env.TUNNEL_PROTOCOL; else process.env.TUNNEL_PROTOCOL = p;
          say(`Cloudflare connection type set to ${p === 'auto' ? 'automatic' : p.toUpperCase()}.`);
          if (tunnel.state().running) tunnel.restart(tunnelOpts());
        } else if (what === 'start') { tunnel.start(tunnelOpts()); say('Start Cloudflare pressed.'); }
        else if (what === 'stop') { tunnel.stop(); say('Stop Cloudflare pressed.', 'warn'); }
        else if (what === 'restart') { tunnel.restart(tunnelOpts()); say('Reconnect Cloudflare pressed.'); }
        else if (what === 'download') {
          say('Downloading cloudflared from Cloudflare...');
          const file = await tunnelKit.downloadCloudflared(root);
          say(`cloudflared downloaded to ${file}.`);
        } else return json(res, 404, { error: 'Not found.' });
        return json(res, 200, { ok: true });
      } catch (e) { say(`[tunnel] ${e.message}`, 'error'); return json(res, 400, { error: e.message }); }
    }
    if (action === 'start') { say('Start pressed in Shuttle Control.'); start(); return json(res, 200, { ok: true }); }
    if (action === 'stop') { say('Stop pressed in Shuttle Control.', 'warn'); stop(); return json(res, 200, { ok: true }); }
    if (action === 'restart') { say('Restart pressed in Shuttle Control.'); restart(); return json(res, 200, { ok: true }); }
    if (action === 'open-logs') { openFolder(logsDir); return json(res, 200, { ok: true }); }
    if (action === 'open-backups') { openFolder(backupsDir); return json(res, 200, { ok: true }); }
    if (action === 'open-app') { openFolder(root); return json(res, 200, { ok: true }); }
    if (action === 'quit') {
      say('Turned off completely from Shuttle Control.', 'warn');
      json(res, 200, { ok: true });
      quitting = true; tunnel.stop(); setTimeout(() => (child ? child.kill() : process.exit(0)), 300);
      return;
    }
  }
  json(res, 404, { error: 'Not found.' });
});
const startedAt = new Date().toISOString();
// Only one copy at a time: Shuttle Control's port is the lock. If another copy already has it,
// this one says so and quits, instead of starting a second website and a second Cloudflare
// connection that would fight the first one.
let begun = false;
function begin() {
  if (begun) return; begun = true;
  readVersion(); setInterval(readVersion, 5 * 60000).unref();
  start();
  startTunnelIfSetUp();
}
control.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    let other = false;
    try { other = (await fetch(`http://127.0.0.1:${controlPort}/api/status`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* not Shuttle Control */ }
    if (other) {
      const msg = 'The shuttle website is already running on this PC, so this copy will close. Open "Shuttle Control.bat" to see it.';
      console.log(`\n  ${msg}\n`); logbook.add(`[control] ${msg}`, { level: 'warn', source: 'control' });
      process.exit(0);
    }
  }
  say(`Shuttle Control could not start on port ${controlPort} (${e.code || e.message}). The website still runs; set CONTROL_PORT in .env to use another port.`, 'warn');
  begin();
});
control.listen(controlPort, '127.0.0.1', () => {
  say(`Shuttle Control is ready at http://127.0.0.1:${controlPort} (this PC only). Open it with "Shuttle Control.bat".`);
  begin();
});
