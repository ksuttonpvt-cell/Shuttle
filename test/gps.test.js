process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@gps.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@gps.test', restart: () => {} });
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

test('driver location: battery comes with it, admins set the low-battery rule and whether drivers can turn it off', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@gps.test', password: 'adminpass1' } });
  const me = (await a('/api/me')).data.settings;
  assert.equal(me.gps_low_battery_pct, '20'); assert.equal(me.gps_low_battery_mode, 'slow'); assert.equal(me.driver_gps_toggle, '0', 'drivers cannot turn it off unless allowed');
  assert.equal((await a('/api/settings', { method: 'PATCH', body: { gps_low_battery_pct: '3' } })).status, 400);
  assert.equal((await a('/api/settings', { method: 'PATCH', body: { gps_low_battery_mode: 'off' } })).status, 400);
  assert.equal((await a('/api/settings', { method: 'PATCH', body: { gps_low_battery_pct: '15', gps_low_battery_mode: 'pause', driver_gps_toggle: '1' } })).status, 200);
  const s = (await a('/api/me')).data.settings;
  assert.deepEqual([s.gps_low_battery_pct, s.gps_low_battery_mode, s.driver_gps_toggle], ['15', 'pause', '1']);

  await a('/api/users', { body: { name: 'Dee', email: 'dee@gps.test', role: 'driver', password: 'driverpass1' } });
  const v = (await a('/api/vehicles', { body: { name: 'Van', seats: 6 } })).data.vehicle;
  const d = client(); await d('/api/login', { body: { email: 'dee@gps.test', password: 'driverpass1' } });
  await d('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  await d('/api/driver/location', { body: { lat: 40.02, lng: -105.25, battery: 14.6, charging: false } });
  assert.equal((await a('/api/drivers/live')).data.drivers[0].battery, '15');
  const wait = () => new Promise((r) => setTimeout(r, 2100)); // the van map is shared for 2 seconds
  await wait();
  await d('/api/driver/location', { body: { lat: 40.02, lng: -105.25, battery: 15, charging: true } });
  await wait();
  assert.equal((await a('/api/drivers/live')).data.drivers[0].battery, '15+', 'charging');
  await d('/api/driver/location', { body: { lat: 40.02, lng: -105.25, battery: 900 } });
  await wait();
  assert.equal((await a('/api/drivers/live')).data.drivers[0].battery, null, 'nonsense is ignored');
  // Off shift, the location is still taken (the page shares whenever it's open).
  await d('/api/driver/shift', { body: { on_duty: false } });
  assert.equal((await d('/api/driver/location', { body: { lat: 40.03, lng: -105.26 } })).status, 200);
});
