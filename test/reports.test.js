process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base; let db; let theApp;
before(async () => {
  db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  theApp = createApp(db, { noTimers: true });
  await new Promise((r) => { server = theApp.listen(0, r); });
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

test('reports: miles, miles per driver, cities, time driving, advisor scheduling', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/settings', { method: 'PATCH', body: { dropoff_wait_min: '0' } }); // this test is about reports, not the drop-off wait
  await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@t.l', role: 'driver', password: 'driverpw1' } });
  await admin('/api/users', { body: { name: 'Avery Advisor', email: 'av@t.l', role: 'advisor', password: 'advisorpw1' } });
  const van = (await admin('/api/vehicles', { body: { name: 'Van' } })).data.vehicle;
  const dana = client(); const avery = client();
  const danaId = (await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } })).data.user.id;
  await avery('/api/login', { body: { email: 'av@t.l', password: 'advisorpw1' } });
  await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: van.id } });

  // GPS: 1 km east every minute = moving. Pretend each report came a minute after the last.
  const step = async (lng) => {
    db.prepare('UPDATE users SET last_loc_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), danaId);
    await dana('/api/driver/location', { body: { lat: 40.0, lng } });
  };
  await dana('/api/driver/location', { body: { lat: 40.0, lng: -105.20 } });
  for (const lng of [-105.1883, -105.1766, -105.1649]) await step(lng); // ~3 km
  await step(-105.1649); // parked: no distance, no moving time
  // A jump of 100 km in a minute is a GPS glitch and is ignored.
  await step(-104.0);

  // Advisor books a pick up (Longmont) for 2 hours from now and a drop off (Louisville) for 10 minutes from now.
  const later = new Date(Date.now() + 120 * 60000).toISOString();
  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  const p = (await avery('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Lee', address: '123 Main St, Longmont, CO 80501', lat: 40.1672, lng: -105.1019, scheduled_at: later } })).data.ride;
  const d = (await avery('/api/rides', { body: { type: 'dropoff', customer_name: 'Kim Ng', address: '900 Front St', lat: 39.9778, lng: -105.1319, scheduled_at: soon } })).data.ride;
  const row = db.prepare('SELECT city, est_miles FROM rides WHERE id = ?').get(p.id);
  assert.equal(row.city, 'Longmont');
  assert.ok(row.est_miles > 25 && row.est_miles < 40, `round trip estimate ${row.est_miles}`);
  assert.equal(db.prepare('SELECT city FROM rides WHERE id = ?').get(d.id).city, 'Louisville', 'from the map spot');

  // Dana does both; time on rides counts from "on my way" to "complete".
  for (const r of [p, d]) {
    await dana(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: danaId } });
    for (const st of ['en_route', 'onboard', 'completed']) await dana(`/api/rides/${r.id}`, { method: 'PATCH', body: { status: st } });
  }
  db.prepare("UPDATE rides SET en_route_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 60000).toISOString(), p.id);

  // The nightly clear removes the address but keeps city and miles.
  db.prepare("INSERT INTO settings (key, value) VALUES ('clear_customer_info', '00:00') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('clear_customer_last', '2000-01-01') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  theApp.locals.clearCustomerInfo(new Date(new Date().setHours(23, 59, 0, 0)));
  const cleared = db.prepare('SELECT address, city, est_miles FROM rides WHERE id = ?').get(p.id);
  assert.equal(cleared.address, '(cleared)');
  assert.equal(cleared.city, 'Longmont');
  assert.ok(cleared.est_miles > 0);

  // "Today" at the dealership (Denver), not on the test machine's clock.
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // (Through tomorrow: late in the evening the 2-hours-from-now pick up is already tomorrow's.)
  const tomorrow = new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const rep = (await admin(`/api/reports?from=${ymd}&to=${tomorrow}`)).data;
  assert.ok(rep.totals.gps_miles > 1.5 && rep.totals.gps_miles < 2.3, `GPS miles ${rep.totals.gps_miles}`);
  assert.equal(rep.totals.moving_min, 3, 'three moving minutes; parked and glitch not counted');
  assert.ok(rep.totals.est_miles > 20);
  assert.ok(rep.totals.ride_time_min >= 25);
  const dr = rep.drivers.find((x) => x.name === 'Dana Driver');
  assert.equal(dr.gps_miles, rep.totals.gps_miles);
  assert.equal(dr.completed, 2);
  assert.deepEqual(rep.cities.map((c) => [c.name, c.pickups, c.dropoffs]).sort(), [['Longmont', 1, 0], ['Louisville', 0, 1]]);
  const av = rep.advisors.find((x) => x.name === 'Avery Advisor');
  assert.equal(av.pickups, 1); assert.equal(av.dropoffs, 1);
  assert.ok(av.avg_notice_min >= 60 && av.avg_notice_min <= 70, `avg notice ${av.avg_notice_min}`);
  assert.equal(av.ahead_pct, 50);
  assert.equal(rep.days[0].gps_miles, rep.totals.gps_miles);
  // Pick-up-only filter still works with the new numbers.
  const onlyUp = (await admin(`/api/reports?from=${ymd}&to=${tomorrow}&type=pickup`)).data;
  assert.deepEqual(onlyUp.cities.map((c) => c.name), ['Longmont']);
});
