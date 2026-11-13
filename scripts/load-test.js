// Load test: simulates 50 people using the shuttle site at once, the way the real pages do:
// 10 drivers, 14 advisors, 1 admin and 25 customers tracking rides.
// Run it against a TEST copy of the site (it creates staff, vehicles and rides), for example:
//   ADMIN_EMAIL=admin@load.test ADMIN_PASSWORD=adminpass1 DB_FILE=data/load-test.db PORT=3100 AUTO_UPDATE=0 npm start
//   npm run load-test -- http://localhost:3100 60 3
// Arguments: <site address> <seconds> <how many times faster than real pages refresh>
const B = process.argv[2] || 'http://localhost:3100';
const SECONDS = Number(process.argv[3] || 120);
const SPEED = Number(process.argv[4] || 1); // 3 = everyone refreshes 3x as often as real pages
const stats = new Map(); let errors = []; let reqs = 0;
function record(name, ms, ok, info) {
  reqs++;
  const s = stats.get(name) || []; s.push(ms); stats.set(name, s);
  if (!ok) errors.push(`${name}: ${info}`);
}
function client() {
  let cookie = '';
  return async (name, path, { method, body } = {}) => {
    const t = performance.now();
    try {
      const res = await fetch(B + path, { method: method || (body ? 'POST' : 'GET'),
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const data = await res.json().catch(() => null);
      record(name, performance.now() - t, res.status < 500 && res.status !== 429, `${res.status} ${data && data.error}`);
      return { status: res.status, data };
    } catch (e) { record(name, performance.now() - t, false, e.name + ' ' + e.message); return { status: 0, data: null }; }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + Math.random() * 0.4);
const end = Date.now() + SECONDS * 1000;
const near = () => ({ lat: 40.0236 + (Math.random() - 0.5) * 0.15, lng: -105.2405 + (Math.random() - 0.5) * 0.15 });
const soon = () => new Date(Date.now() + (5 + Math.random() * 120) * 60000).toISOString();
const POLL = 15000 / SPEED;

async function setup() {
  const admin = client();
  const r = await admin('setup', '/api/login', { body: { email: 'admin@load.test', password: 'adminpass1' } });
  if (r.status !== 200) throw new Error('admin login failed: ' + r.status);
  const veh = [];
  for (let i = 1; i <= 10; i++) veh.push((await admin('setup', '/api/vehicles', { body: { name: `Shuttle ${i}`, seats: 7 } })).data.vehicle.id);
  for (let i = 1; i <= 10; i++) await admin('setup', '/api/users', { body: { name: `Driver ${i}`, email: `d${i}@load.test`, role: 'driver', password: 'driverpw1' } });
  for (let i = 1; i <= 14; i++) await admin('setup', '/api/users', { body: { name: `Advisor ${i}`, email: `a${i}@load.test`, role: 'advisor', password: 'advisorpw1' } });
  const tokens = [];
  for (let i = 0; i < 25; i++) {
    const rr = await admin('setup', '/api/rides', { body: { type: i % 2 ? 'pickup' : 'dropoff', customer_name: `Customer ${i}`, customer_phone: '303555' + String(1000 + i), address: `${100 + i} Main St`, scheduled_at: soon(), ...near() } });
    tokens.push(rr.data.ride.track_token);
  }
  return { admin, veh, tokens };
}

async function driver(i, vehicleId) {
  const c = client();
  await c('login', '/api/login', { body: { email: `d${i}@load.test`, password: 'driverpw1' } });
  await c('shift', '/api/driver/shift', { body: { on_duty: true, vehicle_id: vehicleId } });
  const me = (await c('me', '/api/me')).data.user;
  await sleep(Math.random() * POLL);
  while (Date.now() < end) {
    await c('me', '/api/me');
    const r = await c('rides(driver)', '/api/rides?scope=open');
    await c('drivers', '/api/drivers');
    await c('gps', '/api/driver/location', { body: near() });
    if (r.data && r.data.rides) {
      const mine = r.data.rides.find((x) => x.driver_id === me.id);
      const open = r.data.rides.find((x) => !x.driver_id);
      const next = { assigned: 'en_route', en_route: 'onboard', onboard: 'completed' };
      if (mine) await c('advance', `/api/rides/${mine.id}`, { method: 'PATCH', body: { status: next[mine.status] } });
      else if (open && Math.random() < 0.5) await c('claim', `/api/rides/${open.id}`, { method: 'PATCH', body: { driver_id: me.id } });
    }
    await sleep(jitter(POLL));
  }
}
async function advisor(i) {
  const c = client();
  await c('login', '/api/login', { body: { email: `a${i}@load.test`, password: 'advisorpw1' } });
  await sleep(Math.random() * POLL);
  while (Date.now() < end) {
    await c('rides(advisor)', '/api/rides?scope=open');
    await c('drivers', '/api/drivers');
    await c('today', '/api/rides?scope=today');
    if (Math.random() < 0.15) await c('book', '/api/rides', { body: { type: Math.random() < 0.5 ? 'pickup' : 'dropoff', customer_name: `Walk-in ${i}`, customer_phone: '3035550000', address: 'Somewhere', scheduled_at: soon(), ...near() } });
    await sleep(jitter(POLL));
  }
}
async function adminLoop(admin) {
  while (Date.now() < end) {
    await admin('dash(open)', '/api/rides?scope=open'); await admin('drivers', '/api/drivers'); await admin('today', '/api/rides?scope=today');
    if (Math.random() < 0.2) await admin('reports', '/api/reports');
    await sleep(jitter(POLL));
  }
}
async function customer(token, i) {
  const c = client();
  await sleep(Math.random() * POLL);
  if (i % 5 === 0) await c('public request', '/api/public/rides', { body: { type: 'pickup', customer_name: `Web ${i}`, customer_phone: '3035551111', address: 'Pearl St', scheduled_at: soon(), ...near() } });
  while (Date.now() < end) { await c('track', `/api/public/track/${token}`); await sleep(jitter(POLL)); }
}

(async () => {
  const { admin, veh, tokens } = await setup();
  stats.clear(); errors = []; reqs = 0;
  // Everyone signs in at once (like the morning after the midnight sign-out).
  const t0 = performance.now();
  await Promise.all([
    ...Array.from({ length: 10 }, (_, k) => driver(k + 1, veh[k])),
    ...Array.from({ length: 14 }, (_, k) => advisor(k + 1)),
    adminLoop(admin),
    ...tokens.map((t, k) => customer(t, k)),
  ]);
  const secs = (performance.now() - t0) / 1000;
  const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(`50 users for ${secs.toFixed(0)} s (refresh ${SPEED}x real speed): ${reqs} requests, ${(reqs / secs).toFixed(1)}/s, errors: ${errors.length}`);
  console.log('request'.padEnd(18), 'count'.padStart(6), 'median'.padStart(8), 'p95'.padStart(8), 'max'.padStart(8), '(ms)');
  for (const [k, v] of [...stats.entries()].sort()) {
    v.sort((a, b) => a - b);
    console.log(k.padEnd(18), String(v.length).padStart(6), pct(v, 0.5).toFixed(0).padStart(8), pct(v, 0.95).toFixed(0).padStart(8), v.at(-1).toFixed(0).padStart(8));
  }
  if (errors.length) console.log('first errors:', [...new Set(errors)].slice(0, 8));
})();
