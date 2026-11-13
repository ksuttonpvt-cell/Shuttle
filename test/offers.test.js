process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

const pushes = [];
let server; let base; let theApp;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const pushSender = async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); };
  theApp = createApp(db, { publicUrl: 'https://shuttle.test', pushSender, noTimers: true });
  await new Promise((r) => { server = theApp.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
function client() {
  let cookie = '';
  return async (path, { method, body } = {}) => {
    const res = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('waiting rides are offered to the closest free driver, who can take it or pass', async () => {
  const sweep = theApp.locals.offerSweep;
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  const drivers = {};
  for (const [key, name] of [['dana', 'Dana Near'], ['eli', 'Eli Far']]) {
    await admin('/api/users', { body: { name, email: `${key}@t.l`, role: 'driver', password: 'driverpw1' } });
    const v = (await admin('/api/vehicles', { body: { name: `Van ${key}` } })).data.vehicle;
    const c = client();
    const me = (await c('/api/login', { body: { email: `${key}@t.l`, password: 'driverpw1' } })).data.user;
    await c('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
    await c('/api/push/subscribe', { body: { subscription: { endpoint: `https://push.test/${key}`, keys: { p256dh: 'x', auth: 'y' } } } });
    drivers[key] = { c, id: me.id };
  }
  const { dana, eli } = drivers;
  await dana.c('/api/driver/location', { body: { lat: 40.015, lng: -105.27 } }); // downtown
  await eli.c('/api/driver/location', { body: { lat: 40.10, lng: -105.10 } });  // far away

  const at = new Date(Date.now() + 20 * 60000).toISOString();
  const ride = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Lee', address: '1300 Pearl St', lat: 40.018, lng: -105.275, scheduled_at: at } })).data.ride;
  pushes.length = 0;

  // Closest driver gets the offer, with a notification that can be answered.
  let made = sweep();
  assert.equal(made.length, 1);
  assert.equal(made[0].driver_id, dana.id);
  assert.ok(made[0].miles < 1.5);
  await settle();
  const note = pushes.find((p) => p.endpoint === 'https://push.test/dana');
  assert.ok(note && note.offer_id === made[0].id);
  assert.match(note.body, /Pick up Pat Lee .* mi away/);
  assert.equal(sweep().length, 0, 'one offer at a time');
  let r = await dana.c('/api/offers/mine');
  assert.equal(r.data.offer.customer_name, 'Pat Lee');
  assert.ok(r.data.offer.seconds_left > 60);
  assert.equal((await eli.c('/api/offers/mine')).data.offer, null);
  // Advisors see who it's offered to.
  let open = (await admin('/api/rides')).data.rides.find((x) => x.id === ride.id);
  assert.equal(open.offered_to, 'Dana Near');
  // Someone else can't answer Dana's offer.
  assert.equal((await eli.c(`/api/offers/${made[0].id}/accept`, { body: {} })).status, 404);

  // Dana passes: it goes to the next closest driver.
  assert.equal((await dana.c(`/api/offers/${made[0].id}/decline`, { body: {} })).status, 200);
  made = sweep();
  assert.equal(made[0].driver_id, eli.id);
  // Eli doesn't answer in time: it expires, and nobody who passed is asked again.
  assert.deepEqual(sweep(new Date(Date.now() + 100000)), []);
  assert.equal((await eli.c(`/api/offers/${made[0].id}/accept`, { body: {} })).status, 409);
  assert.equal((await admin('/api/rides')).data.rides.find((x) => x.id === ride.id).driver_id, null);

  // A new ride: Dana takes it.
  const ride2 = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Sam Ortiz', address: 'Spruce St', lat: 40.02, lng: -105.27, scheduled_at: at } })).data.ride;
  made = sweep();
  const o = made.find((x) => x.ride_id === ride2.id);
  assert.equal(o.driver_id, dana.id);
  r = await dana.c(`/api/offers/${o.id}/accept`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.ride.driver_id, dana.id);
  assert.equal(r.data.ride.status, 'assigned');
  assert.equal((await dana.c(`/api/offers/${o.id}/accept`, { body: {} })).status, 409, 'only once');

  // Drop offs are measured from the dealership, where the customer waits.
  const ride3 = (await admin('/api/rides', { body: { type: 'dropoff', customer_name: 'Kim Home', address: 'Far Rd', lat: 40.2, lng: -105.0, scheduled_at: at } })).data.ride;
  made = sweep();
  const o3 = made.find((x) => x.ride_id === ride3.id);
  assert.equal(o3.driver_id, dana.id, 'Dana (one ride, close to the dealership) is still offered it');
  // If the ride gets taken another way, the offer closes.
  await admin(`/api/rides/${ride3.id}`, { method: 'PATCH', body: { driver_id: eli.id } });
  sweep();
  assert.equal((await dana.c('/api/offers/mine')).data.offer, null);

  // Drivers with two rides already, stale locations, or off shift aren't offered rides.
  const ride4 = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Lou Park', address: 'Arapahoe', lat: 40.04, lng: -105.17, scheduled_at: at } })).data.ride;
  await dana.c(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: dana.id } }); // Dana now has 2 rides
  made = sweep();
  assert.equal(made.find((x) => x.ride_id === ride4.id).driver_id, eli.id, 'busy Dana is skipped');
  await eli.c('/api/driver/shift', { body: { on_duty: false } });
  assert.equal((await eli.c('/api/offers/mine')).data.offer, null, 'going off shift drops the offer');
  assert.deepEqual(sweep(), [], 'nobody free');

  // Admin can turn offers off.
  await admin('/api/settings', { method: 'PATCH', body: { ride_offers: '0' } });
  await dana.c(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: null } });
  assert.deepEqual(sweep(), []);
});
