process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@app.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true, superEmail: 'boss@app.test', restart: () => {} });
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
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, data: type.includes('json') ? await res.json().catch(() => null) : null };
  };
}
// A real (tiny) JPEG: 1x1 pixel.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('ride-app features: driver card, stops before you, "I\'m here", and the wait estimate', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@app.test', password: 'adminpass1' } });
  await a('/api/users', { body: { name: 'Sam Driver', email: 'sam@app.test', roles: ['driver'], password: 'password123' } });
  await a('/api/users', { body: { name: 'Ann Advisor', email: 'ann@app.test', roles: ['advisor'], password: 'password123' } });
  const sam = client(); const samMe = (await sam('/api/login', { body: { email: 'sam@app.test', password: 'password123' } })).data.user;
  const ann = client(); await ann('/api/login', { body: { email: 'ann@app.test', password: 'password123' } });
  const pub = client();

  // Nobody on shift: no estimate.
  assert.equal((await pub('/api/wait')).data.level, 'closed');

  // Sam starts a shift in a van with a plate, and adds a photo.
  const v = (await a('/api/vehicles', { body: { name: 'Shuttle 2', seats: 6, use: 'shuttle', color: 'White', make_model: 'Toyota Sienna', plate: 'CRW 482' } })).data.vehicle;
  assert.equal((await sam('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } })).status, 200);
  assert.equal((await sam('/api/me/photo', { body: { image: 'data:image/png;base64,AAAA' } })).status, 400, 'JPEG only');
  assert.equal((await sam('/api/me/photo', { body: { image: 'data:image/jpeg;base64,AAAA' } })).status, 400, 'must really be a JPEG');
  const ph = await sam('/api/me/photo', { body: { image: JPEG } });
  assert.equal(ph.status, 200); assert.match(ph.data.user.photo_url, /^\/api\/users\/\d+\/photo\?v=1$/);

  // Free van: the estimate is the drive, at least 5 minutes.
  const w1 = (await pub('/api/wait?lat=40.02&lng=-105.25')).data;
  assert.deepEqual([w1.on_duty, w1.out, w1.level], [1, 0, 'quiet']);
  assert.ok(w1.wait_min >= 5 && w1.wait_min % 5 === 0);

  // Two pick ups for Sam, planned as a route.
  const book = async (name, lat) => (await ann('/api/rides', { body: { type: 'pickup', customer_name: name, customer_phone: '303-555-0100', address: `${name} St`, lat, lng: -105.25, scheduled_at: new Date(Date.now() + 20 * 60000).toISOString(), passengers: 1 } })).data.ride;
  const near = await book('Near One', 40.02); const far = await book('Far Two', 40.06);
  for (const r of [near, far]) await sam(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: samMe.id } });
  const plan = await sam('/api/route', { body: { ride_ids: [near.id, far.id], save: true } });
  assert.equal(plan.status, 200);
  const order = plan.data.route.stops.filter((x) => x.ride_id).map((x) => x.ride_id);
  const second = order[1] === near.id ? near : far;
  const first = second === near ? far : near;

  // The second customer's page: driver card info and one stop before them.
  let t = (await pub(`/api/public/track/${second.track_token}`)).data;
  assert.equal(t.ride.driver_name, 'Sam');
  assert.deepEqual([t.ride.vehicle.color, t.ride.vehicle.make_model, t.ride.vehicle.plate], ['White', 'Toyota Sienna', 'CRW 482']);
  assert.match(t.driver_photo, /\/api\/public\/track\/.+\/photo\?v=1/);
  assert.equal(t.stops_before, 1);
  assert.equal((await pub(`/api/public/track/${first.track_token}`)).data.stops_before, 0, 'the first one is next');
  const img = await fetch(base + t.driver_photo);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');

  // Busy van: the wait goes up, and it's counted as out.
  const w2 = (await pub('/api/wait?lat=40.02&lng=-105.25')).data;
  assert.equal(w2.out, 1); assert.ok(w2.wait_min >= w1.wait_min);

  // "I'm here" for the first customer.
  assert.equal((await pub(`/api/public/track/${first.track_token}/reply`, { body: { answer: 'coming' } })).status, 409, 'not before the driver is there');
  assert.equal((await ann(`/api/rides/${first.id}/arrived`, { body: {} })).status, 403, 'drivers only');
  const arr = await sam(`/api/rides/${first.id}/arrived`, { body: {} });
  assert.equal(arr.status, 200); assert.ok(arr.data.ride.arrived_at); assert.equal(arr.data.ride.status, 'en_route');
  t = (await pub(`/api/public/track/${first.track_token}`)).data;
  assert.ok(t.arrived_at); assert.equal(t.arrive_wait_min, 5); assert.equal(t.customer_reply, null);
  assert.equal((await pub(`/api/public/track/${first.track_token}/reply`, { body: { answer: 'maybe' } })).status, 400);
  const rep = await pub(`/api/public/track/${first.track_token}/reply`, { body: { answer: 'coming' } });
  assert.equal(rep.status, 200);
  assert.equal((await pub(`/api/public/track/${first.track_token}`)).data.customer_reply, 'coming');
  const staffView = (await ann('/api/rides?scope=open')).data.rides.find((r) => r.id === first.id);
  assert.equal(staffView.customer_reply, 'coming', 'advisor sees it');
  // Undo, then arrive again: the old answer is cleared.
  await sam(`/api/rides/${first.id}/arrived`, { body: { undo: true } });
  assert.equal((await pub(`/api/public/track/${first.track_token}`)).data.arrived_at, null);
  await sam(`/api/rides/${first.id}/arrived`, { body: {} });
  assert.equal((await pub(`/api/public/track/${first.track_token}`)).data.customer_reply, null);
  // No-show: the driver cancels with the reason.
  const ns = await sam(`/api/rides/${first.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: "No-show: customer didn't come out (driver waited 5 min)" } });
  assert.equal(ns.data.ride.status, 'cancelled');
  assert.equal((await sam(`/api/rides/${first.id}/arrived`, { body: {} })).status, 409);

  // Giving a ride back clears "I'm here".
  await sam(`/api/rides/${second.id}/arrived`, { body: {} });
  await sam(`/api/rides/${second.id}`, { method: 'PATCH', body: { driver_id: null } });
  const back = (await ann('/api/rides?scope=open')).data.rides.find((r) => r.id === second.id);
  assert.equal(back.arrived_at, null);
  assert.equal((await pub(`/api/public/track/${second.track_token}`)).data.driver_photo, null, 'no driver, no photo');

  // Setting: wait at a pick up.
  assert.equal((await a('/api/settings', { method: 'PATCH', body: { arrive_wait_min: '0' } })).status, 400);
  assert.equal((await a('/api/settings', { method: 'PATCH', body: { arrive_wait_min: '8' } })).status, 200);

  // Admins can remove a photo.
  const del = await a(`/api/users/${samMe.id}/photo`, { body: { image: null } });
  assert.equal(del.data.user.photo_url, null);
});
