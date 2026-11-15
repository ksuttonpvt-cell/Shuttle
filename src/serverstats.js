// Live numbers for Admin → Server: requests per minute, response times, errors,
// CPU and memory, and who's using the site right now.
const os = require('node:os');

// Kinds of traffic, for the chart's on/off switches (Admin → Server). Order is fixed: it
// sets each kind's color.
const TRAFFIC_TYPES = [
  ['pages', 'Pages'], ['files', 'Files (scripts, styles, images)'], ['rides', 'Ride lists & changes'],
  ['vans', 'Van maps'], ['gps', 'Driver GPS'], ['tracking', 'Customer tracking & requests'],
  ['signin', 'Sign-ins'], ['other', 'Admin & other'],
];
function trafficType(p) {
  if (p.startsWith('/api/')) {
    if (p.startsWith('/api/driver/location')) return 'gps';
    if (p.startsWith('/api/drivers')) return 'vans';
    if (/^\/api\/(rides|offers|route|driver\/|geocode|links)/.test(p)) return 'rides';
    if (p.startsWith('/api/public/')) return 'tracking';
    if (/^\/api\/(login|logout|me\b|password-reset)/.test(p)) return 'signin';
    return 'other';
  }
  if (/^\/(t|request)(\/|$)/.test(p)) return 'tracking';
  if (/^\/(login|reset)(\/|$)/.test(p)) return 'signin';
  if (/^\/(js|css|vendor|brand|icons|img)\//.test(p) || /\.[a-z0-9]{2,5}$/i.test(p)) return 'files';
  if (p === '/healthz') return 'other';
  return 'pages';
}

function createStats({ sampleMs = 5000, timers = true } = {}) {
  const startedAt = new Date();
  const minutes = new Map(); // minute (epoch/60000) -> { n, ms, s5xx, s4xx }
  const seen = new Map();    // user id -> { role, at }
  const viewers = new Map(); // customer tracking link -> last view
  let cpu = { process: 0, system: 0 };
  let lastProc = process.cpuUsage(); let lastAt = process.hrtime.bigint(); let lastSys = sysTimes();

  function sysTimes() {
    let idle = 0; let total = 0;
    for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
    return { idle, total };
  }
  function sample() {
    const now = process.hrtime.bigint(); const elapsedUs = Number(now - lastAt) / 1000;
    const p = process.cpuUsage(lastProc);
    const cores = os.cpus().length || 1;
    cpu.process = Math.min(100, Math.round(((p.user + p.system) / elapsedUs / cores) * 1000) / 10);
    const s = sysTimes(); const dt = s.total - lastSys.total;
    cpu.system = dt > 0 ? Math.round((1 - (s.idle - lastSys.idle) / dt) * 1000) / 10 : 0;
    lastProc = process.cpuUsage(); lastAt = now; lastSys = s;
    // Forget old minutes and old visitors.
    const cut = Math.floor(Date.now() / 60000) - 60;
    for (const k of minutes.keys()) if (k < cut) minutes.delete(k);
    const away = Date.now() - 15 * 60000;
    for (const [k, v] of seen) if (v.at < away) seen.delete(k);
    for (const [k, v] of viewers) if (v < away) viewers.delete(k);
  }
  if (timers) setInterval(sample, sampleMs).unref();

  function middleware(req, res, next) {
    const t0 = process.hrtime.bigint();
    if (req.path === '/api/events') return next(); // instant-update connections stay open; not counted as requests
    const sock = req.socket; const sent0 = sock ? sock.bytesWritten : 0;
    res.on('finish', () => {
      const k = Math.floor(Date.now() / 60000);
      const m = minutes.get(k) || { n: 0, ms: 0, s5xx: 0, s4xx: 0, bytes: 0, by: {} };
      m.n++; m.ms += Number(process.hrtime.bigint() - t0) / 1e6;
      const bytes = sock ? Math.max(0, sock.bytesWritten - sent0) : 0;
      const type = trafficType(req.path);
      const b = m.by[type] || (m.by[type] = [0, 0]);
      b[0]++; b[1] += bytes; m.bytes += bytes;
      if (res.statusCode >= 500) m.s5xx++; else if (res.statusCode >= 400) m.s4xx++;
      minutes.set(k, m);
    });
    next();
  }
  const sawUser = (user) => { if (user) seen.set(user.id, { role: user.role, at: Date.now() }); };
  const sawTracker = (token) => { if (token) viewers.set(String(token).slice(0, 40), Date.now()); };

  function snapshot() {
    const nowMin = Math.floor(Date.now() / 60000);
    const perMinute = [];
    for (let k = nowMin - 59; k <= nowMin; k++) {
      const m = minutes.get(k);
      perMinute.push({ at: new Date(k * 60000).toISOString(), requests: m ? m.n : 0, avg_ms: m && m.n ? Math.round(m.ms / m.n) : 0, errors: m ? m.s5xx : 0,
        bytes: m ? m.bytes : 0, by: m ? m.by : {} }); // by: { type: [requests, bytes] }
    }
    const hour = perMinute.reduce((t, m) => ({ n: t.n + m.requests, e: t.e + m.errors }), { n: 0, e: 0 });
    const lastFive = perMinute.slice(-5);
    const recentN = lastFive.reduce((n, m) => n + m.requests, 0);
    const recentMs = lastFive.reduce((n, m) => n + m.avg_ms * m.requests, 0);
    const online = { admin: 0, advisor: 0, driver: 0 };
    const active = Date.now() - 5 * 60000;
    for (const v of seen.values()) if (v.at >= active && online[v.role] != null) online[v.role]++;
    let customers = 0; for (const v of viewers.values()) if (v >= active) customers++;
    const mem = process.memoryUsage();
    return {
      started_at: startedAt.toISOString(),
      uptime_s: Math.round(process.uptime()),
      requests: { per_minute: perMinute, last_hour: hour.n, errors_last_hour: hour.e, per_minute_now: Math.round(recentN / 5), avg_ms_now: recentN ? Math.round(recentMs / recentN) : 0 },
      online: { ...online, customers },
      cpu: { ...cpu, cores: os.cpus().length },
      memory: { site_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576), pc_total_mb: Math.round(os.totalmem() / 1048576), pc_free_mb: Math.round(os.freemem() / 1048576) },
      machine: { name: os.hostname(), platform: `${os.type()} ${os.release()}`, node: process.version, pc_uptime_s: Math.round(os.uptime()) },
    };
  }
  // Who was active in the last 5 minutes (so copies on other cores aren't counted twice).
  function active() {
    const since = Date.now() - 5 * 60000;
    const users = {}; for (const [id, v] of seen) if (v.at >= since) users[id] = v.role;
    const trackers = []; for (const [k, v] of viewers) if (v >= since) trackers.push(k);
    return { users, trackers };
  }
  return { middleware, sawUser, sawTracker, snapshot, sample, active };
}

// Adds up the numbers from every copy of the site: [{ snapshot, active }].
function mergeSnapshots(parts) {
  if (!parts.length) return {};
  if (parts.length === 1) return parts[0].snapshot;
  const snaps = parts.map((p) => p.snapshot);
  const first = snaps[0];
  const per_minute = first.requests.per_minute.map((m, i) => {
    let requests = 0; let ms = 0; let errors = 0; let bytes = 0; const by = {};
    for (const s of snaps) {
      const x = s.requests.per_minute[i]; if (!x) continue;
      requests += x.requests; ms += x.avg_ms * x.requests; errors += x.errors; bytes += x.bytes || 0;
      for (const [t, [n, b]] of Object.entries(x.by || {})) { const o = by[t] || (by[t] = [0, 0]); o[0] += n; o[1] += b; }
    }
    return { at: m.at, requests, avg_ms: requests ? Math.round(ms / requests) : 0, errors, bytes, by };
  });
  const sum = (f) => snaps.reduce((n, s) => n + (f(s) || 0), 0);
  const recentN = sum((s) => s.requests.per_minute_now);
  const users = {}; const trackers = new Set();
  for (const p of parts) { Object.assign(users, p.active?.users || {}); for (const t of p.active?.trackers || []) trackers.add(t); }
  const online = { admin: 0, advisor: 0, driver: 0 };
  for (const role of Object.values(users)) if (online[role] != null) online[role]++;
  return {
    ...first,
    started_at: snaps.map((s) => s.started_at).sort()[0],
    uptime_s: Math.max(...snaps.map((s) => s.uptime_s)),
    requests: {
      per_minute,
      last_hour: sum((s) => s.requests.last_hour), errors_last_hour: sum((s) => s.requests.errors_last_hour),
      per_minute_now: recentN,
      avg_ms_now: recentN ? Math.round(sum((s) => s.requests.avg_ms_now * s.requests.per_minute_now) / recentN) : 0,
    },
    online: { ...online, customers: trackers.size },
    cpu: { ...first.cpu, process: Math.min(100, Math.round(sum((s) => s.cpu.process) * 10) / 10) },
    memory: { ...first.memory, site_mb: sum((s) => s.memory.site_mb), heap_mb: sum((s) => s.memory.heap_mb) },
  };
}

module.exports = { createStats, mergeSnapshots, trafficType, TRAFFIC_TYPES };
