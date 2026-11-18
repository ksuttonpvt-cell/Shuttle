process.removeAllListeners('warning');
// Several processor cores: the site runs as several copies that must stay in step.
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { openDb } = require('../src/db');
const { createLimits } = require('../src/limits');
const { createThrottle } = require('../src/throttle');
const { mergeSnapshots, trafficType } = require('../src/serverstats');
const { coresWanted } = require('../src/cluster');

const PORT = 3600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
let proc; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-cores-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DB_FILE: path.join(dir, 's.db'), PORT: String(PORT), AUTO_UPDATE: '0', ROUTING: 'off', CORES: '3', ADMIN_EMAIL: 'boss@cores.test', ADMIN_PASSWORD: 'adminpass1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok && /on 3 processor cores/.test(out)) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1500)); // every copy listening
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(p, { method, body, cookie } = {}) {
  const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Connection: 'close', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], data: await r.json().catch(() => null) };
}
function listen(cookie) {
  const got = [];
  const req = http.get(`${base}/api/events`, { headers: { Cookie: cookie }, agent: new http.Agent() }, (res) => {
    res.setEncoding('utf8'); res.on('data', (d) => { for (const m of d.matchAll(/event: (\w+)/g)) got.push(m[1]); });
  });
  return { got, close: () => req.destroy() };
}

test('three copies: updates reach every screen, limits are shared, numbers add up', async () => {
  const { cookie } = await call('/api/login', { body: { email: 'boss@cores.test', password: 'adminpass1' } });
  assert.ok(cookie);
  const screens = Array.from({ length: 6 }, () => listen(cookie));
  await new Promise((r) => setTimeout(r, 800));
  const st = (await call('/api/server/status', { cookie })).data;
  assert.equal(st.cores.running, 3);
  assert.equal(st.cores.copies.length, 3);
  assert.equal(st.cores.copies.reduce((n, c) => n + c.live, 0), 6, 'the open screens are spread over the copies');
  assert.ok(st.cores.copies.filter((c) => c.live).length >= 2, 'more than one copy has screens');
  assert.ok(st.traffic_types.length >= 8);

  // A change made on whichever copy answers reaches screens on all copies.
  assert.equal((await call('/api/users', { cookie, body: { name: 'Dee', email: 'dee@cores.test', role: 'driver', password: 'driverpass1' } })).status, 201);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(screens.map((s) => s.got.includes('drivers')), screens.map(() => true));
  screens.forEach((s) => s.close());

  // Wrong passwords are counted across copies (new connection each time, so they spread out).
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await call('/api/login', { body: { email: 'dee@cores.test', password: 'nopenope1' } })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(codes.slice(10), [429, 429]);

  // Settings changed on one copy are seen by all of them.
  await call('/api/settings', { cookie, method: 'PATCH', body: { dealer_name: 'Core Motors' } });
  const names = new Set();
  for (let i = 0; i < 9; i++) names.add((await call('/api/me', { cookie })).data.settings.dealer_name);
  assert.deepEqual([...names], ['Core Motors']);

  // The log from every copy is in one place.
  const log = (await call('/api/server/logs', { cookie })).data.lines.map((l) => l.text).join('\n');
  assert.match(log, /on 3 processor cores/);
});

test('two drivers tapping at once on different copies: only one gets the ride or the van', async () => {
  const { cookie } = await call('/api/login', { body: { email: 'boss@cores.test', password: 'adminpass1' } });
  const drivers = [];
  for (let i = 0; i < 6; i++) {
    const u = (await call('/api/users', { cookie, body: { name: `Racer ${i}`, email: `racer${i}@cores.test`, role: 'driver', password: 'driverpass1' } })).data.user;
    drivers.push({ id: u.id, cookie: (await call('/api/login', { body: { email: `racer${i}@cores.test`, password: 'driverpass1' } })).cookie });
  }
  const ride = (k) => ({ type: 'pickup', customer_name: `Race ${k}`, customer_phone: '3035550101', address: '1300 Pearl St', lat: 40.018, lng: -105.278, scheduled_at: new Date(Date.now() + 3600e3).toISOString(), passengers: 1 });
  for (let k = 0; k < 10; k++) {
    const r = (await call('/api/rides', { cookie, body: ride(k) })).data.ride;
    const res = await Promise.all(drivers.map((d) => call(`/api/rides/${r.id}`, { method: 'PATCH', cookie: d.cookie, body: { driver_id: d.id } })));
    const winners = res.map((x, i) => (x.status === 200 ? drivers[i].id : null)).filter(Boolean);
    assert.equal(winners.length, 1, `ride ${k}: ${res.map((x) => x.status).join(' ')}`);
    assert.equal((await call(`/api/rides?scope=all`, { cookie })).data.rides.find((x) => x.id === r.id).driver_id, winners[0], 'the winner really has it');
  }
  const v = (await call('/api/vehicles', { cookie, body: { name: 'Race Van', seats: 7 } })).data.vehicle;
  const shifts = await Promise.all(drivers.map((d) => call('/api/driver/shift', { cookie: d.cookie, body: { on_duty: true, vehicle_id: v.id } })));
  assert.equal(shifts.filter((x) => x.status === 200).length, 1, 'one driver per van');
  const p = (await call('/api/rides', { cookie, body: ride('p') })).data.ride;
  const backs = await Promise.all(Array.from({ length: 5 }, () => call('/api/rides', { cookie, body: { ...ride('back'), type: 'dropoff', return_of: p.id } })));
  assert.equal(backs.filter((x) => x.status === 201).length, 1, 'the ride back is booked once');
  const dup = await Promise.all(Array.from({ length: 4 }, (_, i) => call('/api/users', { cookie, body: { name: `Dup ${i}`, email: 'dup@cores.test', role: 'advisor', password: 'testpass1' } })));
  assert.deepEqual(dup.map((x) => x.status).sort(), [201, 400, 400, 400]);
});

test('cores, memory and bandwidth settings are checked and saved', async () => {
  const { cookie } = await call('/api/login', { body: { email: 'boss@cores.test', password: 'adminpass1' } });
  assert.equal((await call('/api/server/resources', { cookie, method: 'PUT', body: { cores: 999 } })).status, 400);
  assert.equal((await call('/api/server/resources', { cookie, method: 'PUT', body: { ram_mb: 100 } })).status, 400);
  assert.equal((await call('/api/server/resources', { cookie, method: 'PUT', body: { bandwidth_mbps: -3 } })).status, 400);
  const r = await call('/api/server/resources', { cookie, method: 'PUT', body: { cores: 2, ram_mb: 1024, bandwidth_mbps: 25 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.restart_needed, true);
  assert.equal(r.data.cores.setting, '2');
  assert.equal(r.data.cores.ram_mb, 1024);
  assert.equal(r.data.cores.bandwidth_mbps, 25);
  assert.equal(r.data.cores.fixed_by_env.cores, '3', 'CORES in .env wins, and the page says so');
  assert.equal((await call('/api/server/resources', { cookie, method: 'PUT', body: { bandwidth_mbps: 0 } })).data.restart_needed, false);
  // Drivers can't change them.
  await call('/api/users', { cookie, body: { name: 'Eve', email: 'eve@cores.test', role: 'driver', password: 'driverpass1' } });
  const d = await call('/api/login', { body: { email: 'eve@cores.test', password: 'driverpass1' } });
  assert.equal((await call('/api/server/resources', { cookie: d.cookie, method: 'PUT', body: { cores: 1 } })).status, 403);
});

test('auto uses every core (up to 16); a number is capped at what the PC has', () => {
  assert.equal(coresWanted('auto', 8), 8);
  assert.equal(coresWanted('', 4), 4);
  assert.equal(coresWanted('auto', 64), 16);
  assert.equal(coresWanted('2', 8), 2);
  assert.equal(coresWanted('12', 8), 8);
  assert.equal(coresWanted('0', 8), 8);
});

test('shared limits count in windows and space out turns', () => {
  const db = seedTestSite(openDb(':memory:'));
  const l = createLimits(db);
  assert.equal(l.count('a', 1000), 0);
  assert.equal(l.hit('a', 1000), 1); assert.equal(l.hit('a', 1000), 2);
  assert.equal(l.count('a', 1000), 2);
  assert.equal(l.count('a', -1), 0, 'an old window counts as zero');
  assert.equal(l.hit('a', -1), 1, 'and starts again');
  l.clear('a'); assert.equal(l.count('a', 1000), 0);
  assert.equal(l.turn('geo', 1000, 5000), 0);
  const w = l.turn('geo', 1000, 5000); assert.ok(w > 900 && w <= 1000, `waits about a second (${w})`);
  for (let i = 0; i < 4; i++) l.turn('geo', 1000, 5000);
  assert.equal(l.turn('geo', 1000, 5000), null, 'too long a queue: no turn');
});

test('bandwidth limit slows big responses and keeps every byte', async () => {
  let rate = 100 * 1024; // bytes per second
  const app = express();
  const t = createThrottle(() => rate);
  app.use(t.middleware);
  const big = Buffer.alloc(150 * 1024, 7);
  app.get('/big', (req, res) => res.send(big));
  app.get('/stream', (req, res) => { res.type('bin'); res.write(big.subarray(0, 50000)); res.write(big.subarray(50000)); res.end(); });
  app.get('/healthz', (req, res) => res.send('ok'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let t0 = Date.now(); let body = Buffer.from(await (await fetch(`${url}/big`)).arrayBuffer());
    const slow = Date.now() - t0;
    assert.ok(body.equals(big)); assert.ok(slow > 900, `150 KB at 100 KB/s took ${slow} ms`);
    t0 = Date.now(); body = Buffer.from(await (await fetch(`${url}/stream`)).arrayBuffer());
    assert.ok(body.equals(big)); assert.ok(Date.now() - t0 > 900);
    t0 = Date.now(); assert.equal(await (await fetch(`${url}/healthz`)).text(), 'ok'); assert.ok(Date.now() - t0 < 300);
    rate = 0; // limit off
    t0 = Date.now(); body = Buffer.from(await (await fetch(`${url}/big`)).arrayBuffer());
    assert.ok(body.equals(big)); assert.ok(Date.now() - t0 < 300);
  } finally { server.close(); }
});

test('traffic kinds and adding up numbers from several copies', () => {
  assert.equal(trafficType('/api/driver/location'), 'gps');
  assert.equal(trafficType('/api/drivers/live'), 'vans');
  assert.equal(trafficType('/api/rides/4'), 'rides');
  assert.equal(trafficType('/t/abc'), 'tracking');
  assert.equal(trafficType('/api/login'), 'signin');
  assert.equal(trafficType('/js/common.js'), 'files');
  assert.equal(trafficType('/advisor'), 'pages');
  assert.equal(trafficType('/api/reports'), 'other');
  const snap = (n, by) => ({ started_at: '2026-01-01', uptime_s: 5, requests: { per_minute: [{ at: 'x', requests: n, avg_ms: 10, errors: 0, bytes: 100 * n, by }], last_hour: n, errors_last_hour: 0, per_minute_now: n, avg_ms_now: 10 },
    online: {}, cpu: { process: 10, system: 20, cores: 4 }, memory: { site_mb: 80, heap_mb: 20 } });
  const m = mergeSnapshots([
    { snapshot: snap(3, { gps: [3, 300] }), active: { users: { 1: 'driver', 2: 'admin' }, trackers: ['t1'] } },
    { snapshot: snap(2, { gps: [1, 100], pages: [1, 100] }), active: { users: { 1: 'driver' }, trackers: ['t1', 't2'] } },
  ]);
  assert.equal(m.requests.last_hour, 5);
  assert.deepEqual(m.requests.per_minute[0].by, { gps: [4, 400], pages: [1, 100] });
  assert.equal(m.requests.per_minute[0].bytes, 500);
  assert.deepEqual(m.online, { admin: 1, advisor: 0, driver: 1, customers: 2 }, 'people on two copies are counted once');
  assert.equal(m.memory.site_mb, 160);
  assert.equal(m.cpu.process, 20);
});
