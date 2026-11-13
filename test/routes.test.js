process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { planRoute, createOsrmRouter, bestOrder } = require('../src/routing');

// Dealership (default settings) is at 40.0236, -105.2405.
const DEALER = { lat: 40.0236, lng: -105.2405 };
const EAST = { lat: 40.0236, lng: -105.10 };
const FAR_EAST = { lat: 40.0236, lng: -105.00 };
const WEST = { lat: 40.0236, lng: -105.30 };

test('best order visits stops in the sensible line, exact and 2-opt agree', async () => {
  // Start at the dealership, stops scattered east, back to the dealership: go out to the far one and back.
  const r = await planRoute({ start: DEALER, stops: [FAR_EAST, WEST, EAST], end: DEALER });
  assert.equal(r.source, 'estimate');
  const order = r.legs.map((l) => l.point);
  assert.ok(order[0] === WEST || order[order.length - 2] === WEST, 'west stop is first or last, not in the middle');
  assert.equal(order.at(-1), DEALER);
  // Bigger sets use the heuristic; it should match the exact answer on a simple line.
  const pts = Array.from({ length: 11 }, (_, i) => ({ lat: 40, lng: -105 + (i % 2 ? i : -i) * 0.01 }));
  const n = pts.length; const cost = pts.map((a) => pts.map((b) => Math.abs(a.lng - b.lng)));
  const order2 = bestOrder(cost, [0], Array.from({ length: n - 1 }, (_, i) => i + 1), null);
  const lngs = order2.map((i) => pts[i].lng);
  const total = lngs.reduce((t, x, i) => t + Math.abs(x - (i ? lngs[i - 1] : pts[0].lng)), 0);
  assert.ok(total < 0.5, `heuristic found a short tour (${total.toFixed(2)})`);
});

test('road router is used when it answers, and the estimate when it fails', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('/table/')) {
      const n = url.split('/driving/')[1].split('?')[0].split(';').length;
      const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * 60));
      return { ok: true, json: async () => ({ code: 'Ok', durations: m, distances: m.map((row) => row.map((v) => v * 10)) }) };
    }
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [[-105.24, 40.02], [-105.2, 40.03], [-105.1, 40.02]] } }] }) };
  };
  const router = createOsrmRouter({ baseUrl: 'https://osrm.test/', fetchImpl: fakeFetch });
  const r = await planRoute({ start: DEALER, stops: [EAST, WEST], end: DEALER, router });
  assert.equal(r.source, 'roads');
  assert.equal(r.path.length, 3);
  assert.ok(calls[0].startsWith('https://osrm.test/table/v1/driving/-105.240500,40.023600;'));
  const broken = createOsrmRouter({ fetchImpl: async () => { throw new Error('offline'); } });
  const logs = [];
  const r2 = await planRoute({ start: DEALER, stops: [EAST], end: DEALER, router: broken, log: (m) => logs.push(m) });
  assert.equal(r2.source, 'estimate');
  assert.match(logs[0], /offline/);
});

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
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

test('drivers plan, save and share routes; maps get live positions', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  for (const [name, email] of [['Dana Driver', 'dana@t.l'], ['Eli Driver', 'eli@t.l']]) await admin('/api/users', { body: { name, email, role: 'driver', password: 'driverpw1' } });
  const v1 = (await admin('/api/vehicles', { body: { name: 'Shuttle 1' } })).data.vehicle;
  const v2 = (await admin('/api/vehicles', { body: { name: 'Shuttle 2' } })).data.vehicle;
  const dana = client(); const eli = client();
  const danaMe = (await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } })).data.user;
  await eli('/api/login', { body: { email: 'eli@t.l', password: 'driverpw1' } });
  await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: v1.id } });
  await eli('/api/driver/shift', { body: { on_duty: true, vehicle_id: v2.id } });

  const at = new Date(Date.now() + 30 * 60000).toISOString();
  const book = async (name, type, p) => (await admin('/api/rides', { body: { type, customer_name: name, address: name + ' St', ...p, scheduled_at: at } })).data.ride;
  const east = await book('East Pickup', 'pickup', EAST);
  const west = await book('West Pickup', 'pickup', WEST);
  const home = await book('Home Dropoff', 'dropoff', FAR_EAST);
  const elis = await book('Eli Ride', 'pickup', EAST);
  await eli(`/api/rides/${elis.id}`, { method: 'PATCH', body: { driver_id: (await eli('/api/me')).data.user.id } });
  await dana(`/api/rides/${east.id}`, { method: 'PATCH', body: { driver_id: danaMe.id } });

  // Live location with direction and speed.
  await dana('/api/driver/location', { body: { lat: 40.03, lng: -105.2, heading: 90, speed: 12 } });
  let live = (await admin('/api/drivers/live')).data.drivers;
  const d = live.find((x) => x.name === 'Dana Driver');
  assert.deepEqual([d.lat, d.lng, d.heading, d.speed], [40.03, -105.2, 90, 12]);
  assert.equal((await client()('/api/drivers/live')).status, 401, 'staff only');

  // Can't plan with another driver's ride.
  let r = await dana('/api/route', { body: { ride_ids: [east.id, elis.id] } });
  assert.equal(r.status, 400); assert.match(r.data.error, /Eli Driver/);

  // Preview: a drop off that isn't on board yet means a dealership stop first, and the route ends there.
  r = await dana('/api/route', { body: { ride_ids: [east.id, west.id, home.id], from: { lat: 40.03, lng: -105.2 } } });
  assert.equal(r.status, 200);
  const rt = r.data.route;
  assert.equal(rt.stops[0].kind, 'dealer');
  assert.equal(rt.stops.at(-1).kind, 'dealer');
  assert.equal(rt.stops.filter((x) => x.ride_id).length, 3);
  assert.ok(rt.total_mi > 0 && rt.total_min > 0);
  assert.ok(new Date(rt.stops[1].eta) < new Date(rt.stops[2].eta), 'arrival times go up');
  assert.equal((await dana('/api/route')).data.route, null, 'preview is not saved');
  assert.equal((await admin('/api/rides?scope=all')).data.rides.find((x) => x.id === west.id).driver_id, null);

  // Save: unassigned rides on the route become Dana's.
  r = await dana('/api/route', { body: { ride_ids: [east.id, west.id, home.id], save: true } });
  assert.equal(r.data.saved, true);
  const all = (await admin('/api/rides?scope=all')).data.rides;
  for (const id of [west.id, home.id]) {
    const ride = all.find((x) => x.id === id);
    assert.equal(ride.driver_id, danaMe.id); assert.equal(ride.status, 'assigned'); assert.equal(ride.vehicle_id, v1.id);
  }
  live = (await admin('/api/drivers/live')).data.drivers;
  assert.equal(live.find((x) => x.name === 'Dana Driver').route.stops.length, 5);

  // Customers see the planned arrival time.
  const track = (await fetch(`${base}/api/public/track/${west.track_token}`).then((x) => x.json()));
  assert.ok(track.eta, 'tracking page gets an ETA');

  // Finished rides drop off the route; once the drop-off customer is on board the dealership stop goes too.
  await dana(`/api/rides/${home.id}`, { method: 'PATCH', body: { status: 'en_route' } });
  await dana(`/api/rides/${home.id}`, { method: 'PATCH', body: { status: 'onboard' } });
  let mine = (await dana('/api/route')).data.route;
  assert.notEqual(mine.stops[0].kind, 'dealer');
  await dana(`/api/rides/${west.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer no-show' } });
  mine = (await dana('/api/route')).data.route;
  assert.ok(!mine.stops.some((x) => x.ride_id === west.id));

  // Clearing, and ending the shift, remove the route.
  await dana('/api/route', { method: 'DELETE' });
  assert.equal((await dana('/api/route')).data.route, null);
  await dana('/api/route', { body: { ride_ids: [east.id], save: true } });
  await dana('/api/driver/shift', { body: { on_duty: false } });
  assert.equal((await dana('/api/route')).data.route, null);
  assert.equal((await admin('/api/drivers/live')).data.drivers.some((x) => x.name === 'Dana Driver'), false, 'off-duty drivers leave the live map');

  // Validation.
  assert.equal((await eli('/api/route', { body: { ride_ids: [] } })).status, 400);
  assert.equal((await admin('/api/route', { body: { ride_ids: [east.id] } })).status, 400, 'admins have no GPS start but can still preview');
});
