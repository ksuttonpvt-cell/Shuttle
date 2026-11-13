process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { planRoute } = require('../src/routing');

const DEALER = { lat: 40.0236, lng: -105.2405 };

test('planner drops people off before picking more up when the van is full', async () => {
  // 3 people already aboard to drop off far west; pick up 3 right next to the driver (east).
  // Shortest is to grab the pickup first (6 aboard); with 4 seats it must drop off first.
  const dropoff = { lat: 40.0236, lng: -105.40, people: -3 };
  const pickup = { lat: 40.0236, lng: -105.09, people: 3 };
  const start = { lat: 40.0236, lng: -105.10 };
  const free = await planRoute({ start, stops: [dropoff, pickup], end: DEALER, startLoad: 3 });
  assert.equal(free.legs[0].point, pickup, 'without a limit the close pickup comes first');
  assert.equal(free.peak, 6);
  const limited = await planRoute({ start, stops: [dropoff, pickup], end: DEALER, startLoad: 3, capacity: 4 });
  assert.equal(limited.legs[0].point, dropoff, 'with 4 seats, drop off first');
  assert.equal(limited.peak, 3);
  assert.deepEqual(limited.loads, [0, 3, 3]);
});

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true });
  app.locals.db = db;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  server.app = app;
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

test('routes and ride offers respect the van\'s seats', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@t.l', role: 'driver', password: 'driverpw1' } });
  const van = (await admin('/api/vehicles', { body: { name: 'Small Van', seats: 4 } })).data.vehicle;
  assert.equal(van.seats, 4);
  const dana = client();
  await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } });
  await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: van.id } });
  await dana('/api/driver/location', { body: { lat: 40.0236, lng: -105.19 } });

  const at = new Date(Date.now() + 20 * 60000).toISOString();
  const book = async (name, type, lng, passengers) => (await admin('/api/rides', { body: { type, customer_name: name, address: name, lat: 40.0236, lng, passengers, scheduled_at: at } })).data.ride;
  const far = await book('Far Dropoff', 'dropoff', -105.05, 3);
  const near = await book('Near Pickup', 'pickup', -105.20, 3);
  const other = await book('Other Pickup', 'pickup', -105.22, 2);

  // Fits if the drop off happens first; seats after each stop are shown.
  let r = await dana('/api/route', { body: { ride_ids: [far.id, near.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rt = r.data.route;
  assert.equal(rt.seats, 4);
  assert.equal(rt.peak, 3);
  assert.deepEqual(rt.stops.map((x) => x.ride_id), [null, far.id, near.id, null]);
  assert.deepEqual(rt.stops.map((x) => x.on_board), [3, 0, 3, 3]);

  // Two pick ups of 3 and 2 = 5 people riding back together: too many for 4 seats in any order.
  r = await dana('/api/route', { body: { ride_ids: [near.id, other.id] } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Small Van: it has 4 seats, but this trip needs room for 5/);

  // A saved order that would overfill the van is refused too.
  r = await dana('/api/route', { body: { ride_ids: [near.id, far.id], save: true, keep_order: true } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /6 people would be in Small Van at once/);

  // Ride offers skip a van that can't fit the party.
  const big = await book('Big Group', 'pickup', -105.19, 5);
  const made = server.app.locals.offerSweep();
  assert.ok(!made.some((o) => o.ride_id === big.id), 'a party of 5 is not offered to a 4-seat van');
  assert.ok(made.length >= 1, 'smaller rides are still offered');
});
