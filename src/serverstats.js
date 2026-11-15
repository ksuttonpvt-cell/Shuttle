// Live numbers for Admin → Server: requests per minute, response times, errors,
// CPU and memory, and who's using the site right now.
const os = require('node:os');

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
    res.on('finish', () => {
      const k = Math.floor(Date.now() / 60000);
      const m = minutes.get(k) || { n: 0, ms: 0, s5xx: 0, s4xx: 0 };
      m.n++; m.ms += Number(process.hrtime.bigint() - t0) / 1e6;
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
      perMinute.push({ at: new Date(k * 60000).toISOString(), requests: m ? m.n : 0, avg_ms: m && m.n ? Math.round(m.ms / m.n) : 0, errors: m ? m.s5xx : 0 });
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
  return { middleware, sawUser, sawTracker, snapshot, sample };
}

module.exports = { createStats };
