process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { routeKey, percentile } = require('../src/serverstats');

let server; let base; let app; let logsDir;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@rep.test', password: 'adminpass1', name: 'Ken' });
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-logs-'));
  app = createApp(db, { noTimers: true, superEmail: 'boss@rep.test', restart: () => {}, logsDir });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(logsDir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, text: type.includes('json') ? null : await res.text(), data: type.includes('json') ? await res.json() : null };
  };
}

test('request names and percentiles for the server report', () => {
  assert.equal(routeKey('POST', '/api/rides/42/arrived'), 'POST /api/rides/:id/arrived');
  assert.equal(routeKey('GET', '/api/public/track/K7M2Q9XA'), 'GET /api/public/track/:code');
  assert.equal(routeKey('GET', '/t/K7M2Q9XA'), 'GET /t/:code');
  assert.equal(routeKey('GET', '/js/app.js'), 'files');
  assert.equal(percentile([90, 5, 5, 0, 0, 0, 0], 0.5), 50);
  assert.equal(percentile([90, 5, 5, 0, 0, 0, 0], 0.95), 100);
  assert.equal(percentile([0, 0, 0, 0, 0, 0, 0], 0.5), null);
});

test('detailed reports: shifts, drivers, vehicles, hours, ride log, and the daily report', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@rep.test', password: 'adminpass1' } });
  await a('/api/users', { body: { name: 'Sam Driver', email: 'sam@rep.test', roles: ['driver'], password: 'password123' } });
  await a('/api/users', { body: { name: 'Ann Advisor', email: 'ann@rep.test', roles: ['advisor'], password: 'password123' } });
  const sam = client(); const samMe = (await sam('/api/login', { body: { email: 'sam@rep.test', password: 'password123' } })).data.user;
  const ann = client(); await ann('/api/login', { body: { email: 'ann@rep.test', password: 'password123' } });
  const v = (await a('/api/vehicles', { body: { name: 'Shuttle 7', seats: 6, use: 'shuttle' } })).data.vehicle;
  assert.equal((await a('/api/me')).data.settings.backup_time, '00:00', 'backups at midnight');

  // A shift with some driving.
  await sam('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  await sam('/api/driver/location', { body: { lat: 40.0, lng: -105.27 } });
  await sam('/api/driver/location', { body: { lat: 40.0005, lng: -105.27 } });
  // A pick up done start to finish, with "I'm here", and a no-show.
  const book = async (name) => (await ann('/api/rides', { body: { type: 'pickup', customer_name: name, customer_phone: '303-555-0100', address: '1 Main', lat: 40.01, lng: -105.27, scheduled_at: new Date(Date.now() + 5 * 60000).toISOString(), passengers: 2 } })).data.ride;
  const r1 = await book('Kai Done'); const r2 = await book('Lee Gone');
  for (const r of [r1, r2]) await sam(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: samMe.id } });
  await sam(`/api/rides/${r1.id}`, { method: 'PATCH', body: { status: 'en_route' } });
  await sam(`/api/rides/${r1.id}/arrived`, { body: {} });
  await sam(`/api/rides/${r1.id}`, { method: 'PATCH', body: { status: 'onboard' } });
  await sam(`/api/rides/${r1.id}`, { method: 'PATCH', body: { status: 'completed' } });
  await sam(`/api/rides/${r2.id}/arrived`, { body: {} });
  await sam(`/api/rides/${r2.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: "No-show: customer didn't come out (driver waited 5 min)" } });
  await sam('/api/driver/shift', { body: { on_duty: false } });

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
  const rep = (await a(`/api/reports?from=${today}&to=${today}`)).data;
  const d = rep.drivers.find((x) => x.name === 'Sam Driver');
  assert.equal(d.shifts, 1); assert.equal(d.completed, 1); assert.equal(d.passengers, 2); assert.equal(d.no_shows, 1, 'the new no-show reason counts');
  assert.ok(d.avg_to_pickup_min != null && d.avg_at_pickup_min != null);
  assert.equal(rep.totals.no_shows, 1);
  const van = rep.vehicles.find((x) => x.name === 'Shuttle 7');
  assert.equal(van.shifts, 1); assert.equal(van.rides, 2);
  assert.equal(rep.hours.length, 24); assert.equal(rep.hours.reduce((n, h) => n + h.pickups, 0), 2);
  assert.equal(rep.totals_shifts.shifts, 1);

  // Ride log, as data and as a spreadsheet.
  const log = (await a(`/api/reports/rides?from=${today}&to=${today}`)).data.rides;
  assert.equal(log.length, 2);
  const done = log.find((x) => x.customer === 'Kai Done');
  assert.ok(done.on_the_way && done.arrived && done.on_board && done.done);
  const csv = await a(`/api/reports/rides?from=${today}&to=${today}&format=csv`);
  assert.match(csv.type, /text\/csv/); assert.match(csv.text, /^"Day","Time","Type"/); assert.match(csv.text, /Drive to pick up \(min\)/);
  assert.equal((await ann(`/api/reports/rides?from=${today}&to=${today}`)).status, 403, 'admins only');

  // Server numbers are saved per hour, then the daily report brings it together.
  fs.writeFileSync(path.join(logsDir, `shuttle-${today}.log`), `${today} 10:00:00  ERROR  Text failed: 21211 invalid number\n${today} 10:01:00  ERROR  Text failed: 21614 invalid number\n${today} 10:02:00  WARN   Too many tries\n`);
  app.locals.saveServerHours();
  const built = await a('/api/server/daily-reports', { body: { day: today } });
  const R = built.data.report;
  assert.equal(R.shuttle.rides, 2); assert.equal(R.shuttle.no_shows, 1); assert.equal(R.shuttle.people, 2); assert.equal(R.shuttle.shifts, 1);
  assert.equal(R.shuttle.drivers[0].name, 'Sam Driver');
  assert.ok(R.server.requests > 10, 'requests counted'); assert.ok(R.server.p95_ms > 0);
  assert.ok(R.server.slowest.every((x) => !/\/\d+/.test(x.name)), 'no ids in request names');
  assert.equal(R.server.log.errors, 2); assert.equal(R.server.log.warnings, 1);
  assert.deepEqual(R.server.log.top_errors[0], { text: 'Text failed: # invalid number', count: 2 });
  assert.ok(!JSON.stringify(R).includes('303-555-0100') && !JSON.stringify(R).includes('Kai Done'), 'no customer details');
  const list = (await a('/api/server/daily-reports')).data.reports;
  assert.equal(list[0].day, today);
  const txt = await a(`/api/server/daily-reports/${today}?format=txt`);
  assert.match(txt.text, /SHUTTLE[\s\S]*Rides: 2[\s\S]*SERVER[\s\S]*Most common errors/);

  // At midnight: the first run only starts the clock; the next day it saves yesterday.
  const t1 = new Date('2031-03-10T18:00:00Z');
  app.locals.dailyReport(new Date('2031-03-09T18:00:00Z'));
  const madeAt = app.locals.dailyReport(new Date('2031-03-10T07:01:00Z')); // 12:01 AM in Denver on the 10th
  assert.equal(madeAt.day, '2031-03-09');
  assert.equal(app.locals.dailyReport(t1), null, 'once a day');
});
