// Keeps the shuttle website running: starts it, restarts it right away after an
// update (exit code 75), and restarts it 10 seconds after a crash.
// It also runs "Shuttle Control", a small page for this PC only (http://127.0.0.1:3001)
// to see the site's status and log, and start, stop or restart it. Open it with
// "Shuttle Control.bat". It keeps working even while the website itself is stopped.
// This file is read once at start, so updates can safely replace it on disk; changes to
// it take effect the next time start-shuttle.bat is started.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { RESTART_CODE } = require('./updater');
const { createLogbook, eachLine } = require('./logbook');
const tunnelKit = require('./tunnel');

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

function setState(s) { state = s; since = new Date(); }

function start() {
  if (child) return;
  clearTimeout(crashTimer); crashTimer = null;
  wanted = 'running';
  const args = [];
  if (fs.existsSync(envFile)) args.push('--env-file=.env');
  args.push(path.join('src', 'server.js'));
  setState('starting');
  child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHUTTLE_SUPERVISED: '1' }, windowsHide: true });
  eachLine(child.stdout, (l) => { process.stdout.write(`${l}\n`); logbook.add(l); if (state === 'starting' && /running at/i.test(l)) setState('running'); });
  eachLine(child.stderr, (l) => { process.stderr.write(`${l}\n`); logbook.add(l, { fromStderr: true }); });
  child.on('exit', (code, signal) => {
    child = null;
    lastExit = { at: new Date().toISOString(), code, signal };
    if (quitting) return process.exit(0);
    if (restartNext) { restartNext = false; restarts++; say('Restarting the website...'); return start(); }
    if (wanted === 'stopped') { setState('stopped'); say('The website is stopped. Use Start to run it again.'); return; }
    if (code === RESTART_CODE) { restarts++; say('Update installed (or restart asked for). Starting the new version...'); return start(); }
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
  if (child) { setState('stopping'); child.kill(); } else setState('stopped');
}
function restart() {
  if (!child) return start();
  restartNext = true; setState('stopping'); child.kill();
}

// ---------- Cloudflare connection ----------
// With CLOUDFLARE_TUNNEL_TOKEN in .env (saved from Shuttle Control), this runs cloudflared
// too and reconnects it if it drops. If cloudflared already runs another way (for example
// as a Windows service), it's left alone and just shown.
const tunnel = tunnelKit.createTunnel({
  root,
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

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { quitting = true; tunnel.stop(); if (child) child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig); else process.exit(0); });
}

// ---------- Shuttle Control (this PC only) ----------
let version = null;
function readVersion() {
  execFile('git', ['log', '-1', '--format=%h|%cI|%s'], { cwd: root, windowsHide: true, timeout: 10000 }, (err, out) => {
    if (err) return;
    const [hash, date, ...subject] = String(out).trim().split('|');
    version = { hash, date, subject: subject.join('|') };
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
    const t = await tunnelKit.probe();
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
control.on('error', (e) => say(`Shuttle Control could not start on port ${controlPort} (${e.code || e.message}). The website still runs; set CONTROL_PORT in .env to use another port.`, 'warn'));
control.listen(controlPort, '127.0.0.1', () => say(`Shuttle Control is ready at http://127.0.0.1:${controlPort} (this PC only). Open it with "Shuttle Control.bat".`));

readVersion(); setInterval(readVersion, 5 * 60000).unref();
start();
startTunnelIfSetUp();
