process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:')); global.__db = db;
  ensureAdmin(db, { email: 'boss@spec.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@spec.test', restart: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('spectator links: a live, read-only map that runs out, with no customer details', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@spec.test', password: 'adminpass1' } });
  const dee = (await a('/api/users', { body: { name: 'Dee Driver', email: 'dee@spec.test', role: 'driver', password: 'driverpass1' } })).data.user;
  await a('/api/users', { body: { name: 'Eli Driver', email: 'eli@spec.test', role: 'driver', password: 'driverpass1' } });
  const v = (await a('/api/vehicles', { body: { name: 'Shuttle 2', make_model: 'Toyota Sienna', color: 'Silver', seats: 7 } })).data.vehicle;
  const d = client(); await d('/api/login', { body: { email: 'dee@spec.test', password: 'driverpass1' } });
  await d('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  await d('/api/driver/location', { body: { lat: 40.03, lng: -105.24, speed: 13.4, battery: 62 } });
  const ride = (await a('/api/rides', { body: { type: 'pickup', customer_name: 'Secret Customer', customer_phone: '3035559999', address: '42 Private Lane', lat: 40.02, lng: -105.10, scheduled_at: new Date(Date.now() + 1800e3).toISOString(), passengers: 1 } })).data.ride;
  await d(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: dee.id } });
  await d('/api/route', { body: { ride_ids: [ride.id], save: true } });

  // Only admins make links; hours are checked.
  assert.equal((await d('/api/spectate-links', { body: { hours: 4 } })).status, 403);
  assert.equal((await a('/api/spectate-links', { body: { hours: 3 } })).status, 400);
  const made = await a('/api/spectate-links', { body: { driver_id: dee.id, hours: 4, label: 'Test drive' } });
  assert.equal(made.status, 201);
  const token = made.data.url.split('/s/')[1];
  assert.ok(token.length >= 20);
  assert.equal((await fetch(`${base}/s/${token}`)).status, 200, 'the page opens');

  const anon = client();
  const view = await anon(`/api/spectate/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.label, 'Test drive');
  const me = view.data.drivers[0];
  assert.equal(me.name, 'Dee'); assert.equal(me.vehicle, 'Silver Toyota Sienna');
  assert.deepEqual([me.lat, me.lng, me.battery], [40.03, -105.24, '62']);
  assert.ok(me.route && me.route.path.length > 1 && me.route.stops.length >= 2, 'route line and stops');
  const text = JSON.stringify(view.data);
  for (const secret of ['Secret Customer', '3035559999', '42 Private Lane', 'dee@spec.test']) assert.ok(!text.includes(secret), `never shows ${secret}`);

  // "Every driver on shift": Eli is off shift, so only Dee.
  const all = (await a('/api/spectate-links', { body: { hours: 1 } })).data.url.split('/s/')[1];
  assert.deepEqual((await anon(`/api/spectate/${all}`)).data.drivers.map((x) => x.name), ['Dee']);

  // The admin list shows views; revoking ends it at once.
  const list = (await a('/api/spectate-links')).data.links;
  const mine = list.find((l) => l.label === 'Test drive');
  assert.equal(mine.active, true); assert.equal(mine.views, 1); assert.equal(mine.driver_name, 'Dee Driver');
  assert.equal((await a(`/api/spectate-links/${mine.id}/revoke`, { body: {} })).status, 200);
  assert.equal((await anon(`/api/spectate/${token}`)).status, 410);
  // Running out ends it too.
  global.__db.prepare('UPDATE spectate_links SET expires_at = ? WHERE revoked_at IS NULL').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await anon(`/api/spectate/${all}`)).status, 410);
  // Made-up links: refused, and guessing is cut off.
  let last;
  for (let i = 0; i < 41; i++) last = await anon(`/api/spectate/guess${i}`);
  assert.equal(last.status, 429);
});
