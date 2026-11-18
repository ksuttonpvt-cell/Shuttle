// Cloudflare Tunnel helpers.
// - probe(): is a cloudflared running on this PC, and is it connected? (reads cloudflared's
//   own local status page, which it serves on 127.0.0.1:20241-20245)
// - createTunnel(): lets Shuttle Control run cloudflared itself with a saved tunnel token,
//   restart it if it stops, and choose the connection type.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
const OWN_METRICS = '127.0.0.1:20241';
// Cloudflare data center codes we're likely to see from Colorado, for friendlier labels.
const PLACES = { den: 'Denver', ord: 'Chicago', dfw: 'Dallas', lax: 'Los Angeles', sjc: 'San Jose', sea: 'Seattle', slc: 'Salt Lake City', phx: 'Phoenix', mci: 'Kansas City', iad: 'Ashburn', atl: 'Atlanta', ewr: 'Newark', msp: 'Minneapolis' };
const placeOf = (code) => { const c = String(code || '').toLowerCase().replace(/\d+$/, ''); return PLACES[c] ? `${PLACES[c]} (${c.toUpperCase()})` : c.toUpperCase(); };

// Asks all the status ports at once (Windows can take a second to refuse a closed port) and
// remembers the answer for a few seconds, so frequent status checks stay quick.
let probeCache = null;
async function probe(opts = {}) {
  const { cacheMs = opts.fetchImpl ? 0 : 4000 } = opts;
  if (cacheMs && probeCache && Date.now() - probeCache.at < cacheMs) return probeCache.value;
  const pending = probeCache?.pending || probeOnce(opts);
  probeCache = { ...(probeCache || {}), pending };
  const value = await pending;
  probeCache = { at: Date.now(), value };
  return value;
}
async function probeOnce({ ports = METRICS_PORTS, timeoutMs = 800, fetchImpl = fetch } = {}) {
  const results = await Promise.all(ports.map((port) => probePort(port, timeoutMs, fetchImpl)));
  return results.find((r) => r && r.ready) || results.find(Boolean) || { running: false, ready: false, connections: 0, locations: [] };
}
async function probePort(port, timeoutMs, fetchImpl) {
  {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await r.json().catch(() => ({}));
      const out = { running: true, port, ready: r.status === 200, connections: Number(body.readyConnections) || 0, connector: body.connectorId || null, locations: [] };
      try {
        const m = await (await fetchImpl(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(timeoutMs) })).text();
        out.locations = [...new Set([...m.matchAll(/edge_location="([a-z]{3})\d*"/g)].map((x) => placeOf(x[1])))];
        const v = /cloudflared_build_info\{[^}]*version="([^"]+)"/.exec(m); if (v) out.version = v[1];
      } catch { /* metrics are optional */ }
      return out;
    } catch { /* nothing on this port */ }
  }
  return null;
}

// Where cloudflared might be on this PC.
function findCloudflared(root) {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const spots = [process.env.CLOUDFLARED_PATH, path.join(root, 'bin', exe)];
  if (process.platform === 'win32') spots.push('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe');
  for (const s of spots) if (s && fs.existsSync(s)) return s;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find(Boolean); if (first && fs.existsSync(first.trim())) return first.trim();
  } catch { /* not on PATH */ }
  return null;
}

// The token from the Cloudflare dashboard. People often paste the whole install command,
// so take the long token out of it.
function cleanToken(text) {
  const words = String(text || '').trim().split(/\s+/);
  const tok = words.reverse().find((w) => /^[A-Za-z0-9+/_=-]{80,}$/.test(w));
  return tok || null;
}
// Which tunnel a token is for (the token is base64 JSON: account, tunnel id, secret).
function tunnelIdOf(token) {
  try { return JSON.parse(Buffer.from(token, 'base64').toString('utf8')).t || null; } catch { return null; }
}

// Save or remove a KEY=value line in the .env file (keeps everything else as it was).
function setEnvValue(envFile, key, value) {
  let text = ''; try { text = fs.readFileSync(envFile, 'utf8'); } catch { /* new file */ }
  const lines = text.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (value == null || value === '') { if (at >= 0) lines.splice(at, 1); } else if (at >= 0) lines[at] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.writeFileSync(envFile, `${lines.join(process.platform === 'win32' ? '\r\n' : '\n')}\n`);
}

const DOWNLOADS = {
  'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'win32-ia32': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe',
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'linux-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
};
async function downloadCloudflared(root, { fetchImpl = fetch } = {}) {
  const url = DOWNLOADS[`${process.platform}-${process.arch}`];
  if (!url) throw new Error('Automatic download is not available for this computer. Install cloudflared from Cloudflare instead.');
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Download failed (${r.status}).`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length < 5 * 1024 * 1024) throw new Error('The download looks incomplete. Try again.');
  const dir = path.join(root, 'bin'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(`${file}.part`, bytes); fs.renameSync(`${file}.part`, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}

// Is this process id a running cloudflared? (So an old id that Windows reused for something
// else is never stopped by mistake.)
function isCloudflared(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      return /cloudflared/i.test(out);
    }
    return /cloudflared/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch { return false; }
}

// Runs cloudflared with the saved token, restarting it if it stops.
// - The id of the cloudflared it starts is written to pidFile. If Shuttle Control was closed
//   without stopping it (the window's X, or Task Manager), that leftover cloudflared is
//   stopped before a new one starts, so two never fight over the same status port.
// - If the status port is taken anyway, the next try uses the next one (20241 → 20245).
function createTunnel({ root, log = () => {}, line = () => {}, spawnImpl = spawn, pidFile = null }) {
  let child = null; let wanted = false; let timer = null; let restarts = 0; let lastExit = null; const fails = [];
  let portAt = 0; let portBusy = false; let lastError = null;
  const metrics = () => `127.0.0.1:${METRICS_PORTS[portAt]}`;
  const state = () => ({ managed: wanted || !!child, running: !!child, pid: child?.pid || null, restarts, last_exit: lastExit, metrics_port: METRICS_PORTS[portAt], last_error: lastError });
  const savePid = (pid) => { if (!pidFile) return; try { if (pid) fs.writeFileSync(pidFile, String(pid)); else fs.rmSync(pidFile, { force: true }); } catch { /* not important */ } };
  function stopLeftover() {
    if (!pidFile) return;
    let pid = null; try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { return; }
    if (pid && pid !== child?.pid && isCloudflared(pid)) {
      try { process.kill(pid); log(`Stopped a leftover Cloudflare connection from before (process ${pid}).`, 'warn'); } catch { /* already gone */ }
    }
    savePid(null);
  }
  // Turn cloudflared's own errors into a plain reason for Shuttle Control.
  function reasonOf(l) {
    if (/metrics server listener|bind: (Only one usage|address already in use)/i.test(l)) { portBusy = true; return `Its status port ${METRICS_PORTS[portAt]} is in use by another program (often a second copy of cloudflared). Trying another port.`; }
    if (/Unauthorized|Invalid tunnel secret|token.*(invalid|not valid)/i.test(l)) return 'Cloudflare refused the tunnel token. Paste a new one from the Cloudflare dashboard.';
    if (/no such host|lookup .* (failed|timeout)|network is unreachable|dial (tcp|udp).*(timeout|refused)/i.test(l)) return 'Can’t reach Cloudflare from this PC. Check the internet connection, or try the HTTP/2 connection type.';
    if (/\bERR\b/.test(l)) return l.replace(/^\S+Z\s+/, '').replace(/^ERR\s+/, '').slice(0, 200);
    return null;
  }
  function start({ token, protocol = 'auto' }) {
    if (child) return;
    const bin = findCloudflared(root);
    if (!bin) throw new Error('cloudflared is not installed on this PC yet. Use "Download cloudflared" first.');
    if (!token) throw new Error('Paste your tunnel token first.');
    wanted = true; clearTimeout(timer);
    stopLeftover();
    if (portBusy) { portAt = (portAt + 1) % METRICS_PORTS.length; portBusy = false; }
    const args = ['tunnel', '--no-autoupdate', '--metrics', metrics()];
    if (['quic', 'http2'].includes(protocol)) args.push('--protocol', protocol);
    args.push('run');
    // The token goes in the environment, not the command line, so it never shows in process lists or logs.
    child = spawnImpl(bin, args, { cwd: root, env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    savePid(child.pid);
    log(`Starting the Cloudflare connection (${protocol === 'auto' ? 'automatic' : protocol.toUpperCase()})...`);
    for (const s of [child.stdout, child.stderr]) {
      let buf = ''; s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (/Registered tunnel connection/i.test(l)) lastError = null; else { const why = reasonOf(l); if (why) lastError = why; }
          line(l);
        }
      });
    }
    child.on('error', (e) => log(`cloudflared could not start: ${e.message}`, 'error'));
    child.on('exit', (code, signal) => {
      child = null; lastExit = { at: new Date().toISOString(), code, signal }; savePid(null);
      if (!wanted) { log('The Cloudflare connection is stopped.'); return; }
      const now = Date.now(); fails.push(now); while (fails.length && now - fails[0] > 120000) fails.shift();
      const wait = portBusy ? 2 : fails.length >= 4 ? 60 : 5; // a busy port: try the next one right away
      log(`The Cloudflare connection stopped (${signal || 'code ' + code}). Reconnecting in ${wait} seconds...`, 'error');
      timer = setTimeout(() => { restarts++; try { start({ token, protocol }); } catch (e) { log(e.message, 'error'); } }, wait * 1000);
    });
  }
  function stop() { wanted = false; clearTimeout(timer); if (child) child.kill(); }
  function restart(opts) { if (!child) return start(opts); const c = child; wanted = true; c.once('exit', () => setTimeout(() => start(opts), 300)); wanted = false; c.kill(); }
  return { start, stop, restart, state };
}

module.exports = { probe, probePort, findCloudflared, cleanToken, tunnelIdOf, setEnvValue, downloadCloudflared, createTunnel, placeOf, isCloudflared, OWN_METRICS, METRICS_PORTS };
