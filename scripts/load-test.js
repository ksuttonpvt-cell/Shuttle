// Load test: simulates many people using the shuttle site at once, the way the real pages do.
// The mix follows a busy service drive: about 20% drivers, 28% advisors, 50% customers
// tracking rides, plus admins. Staff pages keep an instant-updates connection open, drivers
// send GPS every 5 s and check for offers, maps refresh van positions every 5 s, and
// customers' tracking pages refresh every 6 s.
// Run it against a TEST copy of the site (it creates staff, vehicles and rides), for example:
//   ADMIN_EMAIL=admin@load.test ADMIN_PASSWORD=adminpass1 DB_FILE=data/load-test.db PORT=3100 AUTO_UPDATE=0 npm run serve
//   npm run load-test -- http://localhost:3100 60 1 300
// Arguments: <site address> <seconds> <how many times faster than real pages> <people> [processes]
// People sign in spread over a short ramp (like a real morning). With [processes] > 1 the
// simulated crowd is split over several processes so the test machine isn't the bottleneck.
const B = process.argv[2] || 'http://localhost:3100';
const SECONDS = Number(process.argv[3] || 120);
const SPEED = Number(process.argv[4] || 1); // 3 = everyone refreshes 3x as often as real pages
const PEOPLE = Math.max(10, Number(process.argv[5] || 50));
const PROCS = Math.max(1, Number(process.argv[6] || 1));
const RAMP = Math.max(3, Math.round(PEOPLE / 100)); // seconds over which people arrive
const { fork } = require('node:child_process');
const N = { drivers: Math.round(PEOPLE * 0.2), advisors: Math.round(PEOPLE * 0.28), admins: Math.max(1, Math.round(PEOPLE * 0.02)) };
N.customers = PEOPLE - N.drivers - N.advisors - N.admins;
const stats = new Map(); let errors = []; let reqs = 0; let events = 0; let liveOpen = 0; let liveFailed = 0;
function record(name, ms, ok, info) {
  reqs++;
  const s = stats.get(name) || []; s.push(ms); stats.set(name, s);
  if (!ok) errors.push(`${name}: ${info}`);
}
function client() {
  let cookie = '';
  const call = async (name, path, { method, body } = {}) => {
    const t = performance.now();
    try {
      const res = await fetch(B + path, { method: method || (body ? 'POST' : 'GET'),
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const data = await res.json().catch(() => null);
      record(name, performance.now() - t, res.status < 500 && res.status !== 429, `${res.status} ${data && data.error}`);
      return { status: res.status, data };
    } catch (e) { record(name, performance.now() - t, false, e.name + ' ' + e.message + (e.cause && e.cause.code ? ` (${e.cause.code})` : '')); return { status: 0, data: null }; }
  };
  // The instant-updates connection every staff page keeps open.
  call.live = async () => {
    try {
      const res = await fetch(B + '/api/events', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(SECONDS * 1000 + 5000) });
      if (res.status !== 200) { liveFailed++; return; }
      liveOpen++;
      const dec = new TextDecoder();
      for await (const chunk of res.body) events += (dec.decode(chunk).match(/^event:/gm) || []).length;
    } catch { /* closed at the end */ }
  };
  return call;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + Math.random() * 0.4);
let end = 0;
const near = () => ({ lat: 40.0236 + (Math.random() - 0.5) * 0.15, lng: -105.2405 + (Math.random() - 0.5) * 0.15 });
const soon = () => new Date(Date.now() + (35 + Math.random() * 120) * 60000).toISOString();
const every = (ms) => jitter(ms / SPEED);
// Runs fn on its own schedule until the test ends.
async function loop(ms, fn) { await sleep(Math.random() * ms / SPEED); while (Date.now() < end) { await fn(); await sleep(every(ms)); } }

async function setup() {
  const admin = client();
  const r = await admin('setup', '/api/login', { body: { email: 'admin@load.test', password: 'adminpass1' } });
  if (r.status !== 200) throw new Error('admin login failed: ' + r.status);
  await admin('setup', '/api/settings', { method: 'PATCH', body: { dropoff_wait_min: '0' } });
  const veh = [];
  for (let i = 1; i <= N.drivers; i++) veh.push((await admin('setup', '/api/vehicles', { body: { name: `Shuttle ${i}`, seats: 7 } })).data.vehicle.id);
  for (let i = 1; i <= N.drivers; i++) await admin('setup', '/api/users', { body: { name: `Driver ${i}`, email: `d${i}@load.test`, role: 'driver', password: 'driverpw1' } });
  for (let i = 1; i <= N.advisors; i++) await admin('setup', '/api/users', { body: { name: `Advisor ${i}`, email: `a${i}@load.test`, role: 'advisor', password: 'advisorpw1' } });
  for (let i = 2; i <= N.admins; i++) await admin('setup', '/api/users', { body: { name: `Admin ${i}`, email: `m${i}@load.test`, role: 'admin', password: 'adminpass1' } });
  const tokens = [];
  for (let i = 0; i < N.customers; i++) {
    const rr = await admin('setup', '/api/rides', { body: { type: i % 2 ? 'pickup' : 'dropoff', customer_name: `Customer ${i}`, customer_phone: '303555' + String(1000 + i), address: `${100 + i} Main St`, scheduled_at: soon(), ...near() } });
    tokens.push(rr.data.ride.track_token);
  }
  return { veh, tokens };
}

async function driver(i, vehicleId) {
  await sleep(Math.random() * RAMP * 1000);
  const c = client();
  // Sign in, start the shift and load the page, retrying like a phone would if something fails.
  let me = null;
  for (let tries = 0; tries < 6 && !me; tries++) {
    if (tries) await sleep(2000);
    const l = await c('login', '/api/login', { body: { email: `d${i}@load.test`, password: 'driverpw1' } });
    if (l.status !== 200) continue;
    await c('shift', '/api/driver/shift', { body: { on_duty: true, vehicle_id: vehicleId } });
    me = (await c('me', '/api/me')).data?.user || null;
  }
  if (!me) return;
  c.live();
  await Promise.all([
    loop(15000, async () => {                     // ride list refresh
      await c('me', '/api/me');
      const r = await c('rides(driver)', '/api/rides?scope=open');
      await c('route', '/api/route');
      if (r.data && r.data.rides) {
        const mine = r.data.rides.find((x) => x.driver_id === me.id);
        const open = r.data.rides.find((x) => !x.driver_id);
        const next = { assigned: 'en_route', en_route: 'onboard', onboard: 'completed' };
        if (mine) await c('advance', `/api/rides/${mine.id}`, { method: 'PATCH', body: { status: next[mine.status] } });
        else if (open && Math.random() < 0.5) await c('claim', `/api/rides/${open.id}`, { method: 'PATCH', body: { driver_id: me.id } });
      }
    }),
    loop(5000, () => c('gps', '/api/driver/location', { body: near() })),   // phone GPS
    loop(5000, () => c('vans(map)', '/api/drivers/live')),                   // map of other vans
    loop(20000, () => c('offers', '/api/offers/mine')),                      // backup offer check
  ]);
}
async function staffDesk(c, name) {
  c.live();
  await Promise.all([
    loop(15000, async () => {
      await c(`rides(${name})`, '/api/rides?scope=open');
      await c('drivers', '/api/drivers');
      await c('today', '/api/rides?scope=today');
      if (name === 'advisor' && Math.random() < 0.12) await c('book', '/api/rides', { body: { type: Math.random() < 0.5 ? 'pickup' : 'dropoff', customer_name: 'Walk-in', customer_phone: '3035550000', address: 'Somewhere', scheduled_at: soon(), ...near() } });
      if (name === 'admin' && Math.random() < 0.15) await c('reports', '/api/reports');
    }),
    loop(5000, () => c('vans(map)', '/api/drivers/live')),
  ]);
}
async function advisor(i) {
  await sleep(Math.random() * RAMP * 1000);
  const c = client();
  await c('login', '/api/login', { body: { email: `a${i}@load.test`, password: 'advisorpw1' } });
  await staffDesk(c, 'advisor');
}
async function admin(i) {
  await sleep(Math.random() * RAMP * 1000);
  const c = client();
  await c('login', '/api/login', { body: { email: i === 1 ? 'admin@load.test' : `m${i}@load.test`, password: 'adminpass1' } });
  await staffDesk(c, 'admin');
}
async function customer(token, i) {
  await sleep(Math.random() * RAMP * 1000);
  const c = client();
  if (i < 5) await c('public request', '/api/public/rides', { body: { type: 'pickup', customer_name: `Web ${i}`, customer_phone: '3035551111', address: 'Pearl St', scheduled_at: soon(), ...near() } });
  await loop(6000, () => c('track', `/api/public/track/${token}`));
}

// Runs this process's share of the people and reports raw numbers back.
async function runPeople(job) {
  end = job.end;
  const work = [];
  for (const k of job.drivers) work.push(driver(k + 1, job.veh[k]));
  for (const k of job.advisors) work.push(advisor(k + 1));
  for (const k of job.admins) work.push(admin(k + 1));
  for (const k of job.customers) work.push(customer(job.tokens[k], k));
  await Promise.all(work);
  return snapshot();
}
const slice = (n, w, k) => Array.from({ length: n }, (_, i) => i).filter((i) => i % w === k);

const errorKinds = () => { const k = {}; for (const e of errors) { const key = e.replace(/^[^:]+: /, '').replace(/\d{3,}/g, (d) => (d.length === 3 ? d : '#')).slice(0, 80); k[key] = (k[key] || 0) + 1; } return k; };
const snapshot = () => ({ stats: Object.fromEntries(stats), errors: errors.slice(0, 50), kinds: errorKinds(), errorCount: errors.length, reqs, events, liveOpen, liveFailed });
if (process.env.LOAD_TEST_WORKER) {
  process.on('message', async (job) => {
    // Never hang: report whatever we have 25 s after the end.
    setTimeout(() => { process.send(snapshot(), () => process.exit(0)); }, job.end - Date.now() + 25000).unref();
    const r = await runPeople(job);
    process.send(r, () => process.exit(0));
  });
} else (async () => {
  console.log(`Setting up ${PEOPLE} people: ${N.drivers} drivers, ${N.advisors} advisors, ${N.admins} admins, ${N.customers} customers...`);
  const tSetup = performance.now();
  const { veh, tokens } = await setup();
  console.log(`Setup took ${((performance.now() - tSetup) / 1000).toFixed(0)} s. People arrive over ${RAMP} s, then use the site for ${SECONDS} s${PROCS > 1 ? ` (simulated by ${PROCS} processes)` : ''}.`);
  stats.clear(); errors = []; reqs = 0;
  const endAt = Date.now() + (RAMP + SECONDS) * 1000;
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: PROCS }, (_, k) => {
    const job = { end: endAt, veh, tokens, drivers: slice(N.drivers, PROCS, k), advisors: slice(N.advisors, PROCS, k), admins: slice(N.admins, PROCS, k), customers: slice(N.customers, PROCS, k) };
    if (PROCS === 1) return runPeople(job);
    return new Promise((resolve) => {
      const w = fork(__filename, process.argv.slice(2), { env: { ...process.env, LOAD_TEST_WORKER: '1' } });
      let done = false;
      w.on('message', (m) => { done = true; resolve(m); });
      w.on('exit', () => { if (!done) resolve({ stats: {}, errors: ['a test process stopped early'], errorCount: 1, reqs: 0, events: 0, liveOpen: 0, liveFailed: 0 }); });
      w.send(job);
    });
  }));
  const all = new Map(); let total = 0; let errCount = 0; let ev = 0; let open = 0; let refused = 0; const errs = []; const kinds = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.stats)) all.set(k, [...(all.get(k) || []), ...v]);
    total += r.reqs; errCount += r.errorCount; ev += r.events; open += r.liveOpen; refused += r.liveFailed; errs.push(...r.errors); for (const [k, n] of Object.entries(r.kinds || {})) kinds[k] = (kinds[k] || 0) + n;
  }
  const secs = (performance.now() - t0) / 1000;
  const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(`${PEOPLE} people for ${secs.toFixed(0)} s (${SPEED}x real speed): ${total} requests, ${(total / secs).toFixed(1)}/s, errors: ${errCount}`);
  console.log(`instant-update connections: ${open} open, ${refused} refused, ${ev} update messages delivered`);
  console.log('request'.padEnd(18), 'count'.padStart(7), 'median'.padStart(8), 'p95'.padStart(8), 'max'.padStart(8), '(ms)');
  for (const [k, v] of [...all.entries()].sort()) {
    v.sort((a, b) => a - b);
    console.log(k.padEnd(18), String(v.length).padStart(7), pct(v, 0.5).toFixed(0).padStart(8), pct(v, 0.95).toFixed(0).padStart(8), v.at(-1).toFixed(0).padStart(8));
  }
  if (errCount) console.log('first errors:', [...new Set(errs)].slice(0, 8));
  if (errCount) { console.log('errors by kind:'); for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(7)}  ${k}`); }
  process.exit(0);
})();
