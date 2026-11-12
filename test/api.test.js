process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { rankRides } = require('../src/priority');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { geocoder: async () => [{ label: 'Somewhere', lat: 40, lng: -105 }] });
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
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : null, type };
  };
}

test('full shuttle flow', async () => {
  const admin = client();
  assert.equal((await admin('/api/rides')).status, 401);
  assert.equal((await admin('/api/login', { body: { email: 'admin@test.local', password: 'wrong' } })).status, 401);
  assert.equal((await admin('/api/login', { body: { email: 'ADMIN@test.local', password: 'adminpass1' } })).status, 200);

  // Admin creates staff + vehicle.
  let r = await admin('/api/users', { body: { name: 'Ava Advisor', email: 'ava@test.local', role: 'advisor', password: 'shortpw' } });
  assert.equal(r.status, 400, 'short passwords are rejected');
  r = await admin('/api/users', { body: { name: 'Ava Advisor', email: 'ava@test.local', role: 'advisor', password: 'advisorpw1' } });
  assert.equal(r.status, 201);
  r = await admin('/api/users', { body: { name: 'Dan Driver', email: 'dan@test.local', role: 'driver', password: 'driverpw1' } });
  const driverId = r.data.user.id;
  r = await admin('/api/vehicles', { body: { name: 'Shuttle 1', make_model: 'Toyota Sienna', color: 'White', plate: 'ABC123', seats: 7 } });
  assert.equal(r.status, 201);
  const vehicleId = r.data.vehicle.id;

  // Advisor books rides.
  const advisor = client();
  await advisor('/api/login', { body: { email: 'ava@test.local', password: 'advisorpw1' } });
  assert.equal((await advisor('/api/users', { body: { name: 'x', email: 'x@x.co', role: 'admin', password: 'xxxxxxxx' } })).status, 403);
  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  const later = new Date(Date.now() + 90 * 60000).toISOString();
  r = await advisor('/api/rides', { body: { type: 'pickup', customer_name: 'Later Larry', address: '1 Main', scheduled_at: later, lat: 40.01, lng: -105.27 } });
  assert.equal(r.status, 201);
  r = await advisor('/api/rides', { body: { type: 'dropoff', customer_name: 'Soon Sue', customer_phone: '303-555-1234', address: '2 Pearl', scheduled_at: soon, lat: 40.02, lng: -105.25 } });
  const sue = r.data.ride;
  assert.match(sue.track_url, /\/t\/[\w-]+$/);

  r = await advisor('/api/rides');
  assert.equal(r.data.rides.find((x) => x.id === r.data.queue[0]).customer_name, 'Soon Sue', 'soonest ride is first');

  // Customer tracking page works without login and hides private details.
  const anon = client();
  const token = sue.track_url.split('/t/')[1];
  r = await anon(`/api/public/track/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ride.customer_first_name, 'Soon');
  assert.equal(r.data.ride.customer_phone, undefined);
  assert.equal(r.data.queue_position, 1);

  // Driver starts shift, claims, and completes the ride.
  const driver = client();
  await driver('/api/login', { body: { email: 'dan@test.local', password: 'driverpw1' } });
  assert.equal((await driver(`/api/rides/${sue.id}`, { method: 'PATCH', body: { status: 'en_route' } })).status, 403, 'must claim first');
  assert.equal((await driver('/api/driver/shift', { body: { on_duty: true, vehicle_id: vehicleId } })).status, 200);
  r = await driver(`/api/rides/${sue.id}`, { method: 'PATCH', body: { driver_id: driverId } });
  assert.equal(r.data.ride.status, 'assigned');
  assert.equal(r.data.ride.vehicle_name, 'Shuttle 1');
  await driver('/api/driver/location', { body: { lat: 40.015, lng: -105.26 } });
  await driver(`/api/rides/${sue.id}`, { method: 'PATCH', body: { status: 'en_route' } });
  r = await anon(`/api/public/track/${token}`);
  assert.equal(r.data.ride.status, 'en_route');
  assert.deepEqual([r.data.driver_location.lat, r.data.driver_location.lng], [40.015, -105.26]);
  assert.equal(r.data.ride.vehicle.plate, 'ABC123');
  r = await driver(`/api/rides/${sue.id}`, { method: 'PATCH', body: { status: 'completed' } });
  assert.ok(r.data.ride.completed_at);
  assert.equal((await driver(`/api/rides/${sue.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer no-show' } })).status, 400, 'completed rides cannot be cancelled');

  // Cancelling: drivers can cancel their own rides, and everyone must give a reason.
  const larry = (await advisor('/api/rides')).data.rides.find((x) => x.customer_name === 'Later Larry');
  assert.equal((await driver(`/api/rides/${larry.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'No-show' } })).status, 403, "can't cancel a ride that isn't yours");
  await driver(`/api/rides/${larry.id}`, { method: 'PATCH', body: { driver_id: driverId } });
  r = await driver(`/api/rides/${larry.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
  assert.equal(r.status, 400, 'reason is required');
  assert.match(r.data.error, /reason/);
  r = await driver(`/api/rides/${larry.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer no-show: waited 10 min' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ride.status, 'cancelled');
  assert.equal(r.data.ride.cancel_reason, 'Customer no-show: waited 10 min');
  assert.equal(r.data.ride.cancelled_by_name, 'Dan Driver');
  assert.ok(r.data.ride.cancelled_at);
  r = await anon(`/api/public/track/${larry.track_url.split('/t/')[1]}`);
  assert.equal(r.data.ride.status, 'cancelled');
  assert.equal(r.data.ride.cancel_reason, undefined, 'customers do not see the internal reason');
  r = await advisor('/api/rides', { body: { type: 'pickup', customer_name: 'Dup Dave', address: '9 Oak', scheduled_at: later } });
  assert.equal((await advisor(`/api/rides/${r.data.ride.id}`, { method: 'PATCH', body: { status: 'cancelled' } })).status, 400);
  r = await advisor(`/api/rides/${r.data.ride.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Duplicate ride' } });
  assert.equal(r.data.ride.cancelled_by_name, 'Ava Advisor');

  // QR codes: only for this site.
  r = await advisor(`/api/qr?text=${encodeURIComponent(sue.track_url)}`);
  assert.equal(r.status, 200); assert.equal(r.type, 'image/png');
  assert.equal((await advisor(`/api/qr?text=${encodeURIComponent('https://evil.example/')}`)).status, 400);
  assert.equal((await anon('/api/public/request-qr')).type, 'image/png');

  // Public request form, then admin turns it off.
  r = await anon('/api/public/rides', { body: { type: 'pickup', customer_name: 'Web Walt', customer_phone: '303', address: '3 Elm', scheduled_at: later } });
  assert.equal(r.status, 400, 'customers must pin their address so the distance can be checked');
  assert.match(r.data.error, /15\.5-mile/);
  r = await anon('/api/public/rides', { body: { type: 'pickup', customer_name: 'Web Walt', customer_phone: '303', address: '3 Elm', scheduled_at: later, lat: 40.03, lng: -105.25 } });
  assert.equal(r.status, 201);
  await admin('/api/settings', { method: 'PATCH', body: { public_requests: '0' } });
  r = await anon('/api/public/rides', { body: { type: 'pickup', customer_name: 'Web Walt', customer_phone: '303', address: '3 Elm', scheduled_at: later } });
  assert.equal(r.status, 403);

  // Disabling a user logs them out.
  await admin(`/api/users/${driverId}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await driver('/api/rides')).status, 401);
});

test('pages are served', async () => {
  const anon = client();
  for (const p of ['/login', '/request', '/t/abc', '/advisor', '/driver', '/admin']) {
    const r = await anon(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await anon('/')).status, 302);
});

test('priority puts on-board, overdue and urgent rides first', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const at = (m) => new Date(now.getTime() + m * 60000).toISOString();
  const rides = [
    { id: 1, status: 'requested', scheduled_at: at(20), priority: 'normal' },
    { id: 2, status: 'requested', scheduled_at: at(40), priority: 'urgent' },
    { id: 3, status: 'requested', scheduled_at: at(-5), priority: 'normal' },
    { id: 4, status: 'onboard', scheduled_at: at(60), priority: 'normal' },
    { id: 5, status: 'completed', scheduled_at: at(-60), priority: 'normal' },
  ];
  assert.deepEqual(rankRides(rides, null, now).map((r) => r.id), [4, 3, 2, 1]);
});

test('pages are never cached and link version-stamped scripts', async () => {
  const anon = client();
  const res = await fetch(base + '/advisor');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /src="\/js\/common\.js\?v=[a-z0-9]+"/);
  assert.match(html, /href="\/css\/app\.css\?v=[a-z0-9]+"/);
  assert.match(html, /\/vendor\/leaflet\/leaflet\.js\?v=/);
  const js = await fetch(base + '/js/common.js?v=x');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /max-age=2592000/);
  assert.equal((await anon('/login')).status, 200);
});

test('15.5-mile service area (admins can bypass), and settings never leak private keys', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Rae Advisor', email: 'rae@test.local', role: 'advisor', password: 'advisorpw1' } });
  const adv = client();
  await adv('/api/login', { body: { email: 'rae@test.local', password: 'advisorpw1' } });
  const at = new Date(Date.now() + 3600000).toISOString();
  const denver = { lat: 39.7392, lng: -104.9903 }; // about 23 miles from the dealership
  const lafayette = { lat: 39.9936, lng: -105.0897 }; // about 8 miles

  let r = await adv('/api/rides', { body: { type: 'pickup', customer_name: 'Far Away', address: 'Denver', scheduled_at: at, ...denver } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^That address is 2\d\.\d miles from the dealership\. The shuttle only goes up to 15\.5 miles\./);
  r = await adv('/api/rides', { body: { type: 'pickup', customer_name: 'Near By', address: 'Lafayette', scheduled_at: at, ...lafayette } });
  assert.equal(r.status, 201);
  const near = r.data.ride;
  assert.equal((await adv(`/api/rides/${near.id}`, { method: 'PATCH', body: { ...denver } })).status, 400, 'advisors cannot move a ride too far');
  assert.equal((await adv(`/api/rides/${near.id}`, { method: 'PATCH', body: { notes: 'side door' } })).status, 200);

  await admin('/api/settings', { method: 'PATCH', body: { public_requests: '1' } });
  r = await (await fetch(base + '/api/public/rides', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'pickup', customer_name: 'Web Far', customer_phone: '3035550000', address: 'Denver', scheduled_at: at, ...denver }) })).json();
  assert.match(r.error, /Please call the service department/, 'customers are told to call, not about admins');
  assert.doesNotMatch(r.error, /admin/i);

  // Admins can bypass the limit, when booking or editing.
  r = await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Admin Special', address: 'Denver', scheduled_at: at, ...denver } });
  assert.equal(r.status, 201, 'admin can book outside the area');
  assert.equal((await admin(`/api/rides/${near.id}`, { method: 'PATCH', body: { ...denver } })).status, 200, 'admin can move a ride outside the area');
  // ...and the ride stays editable by advisors as long as its location doesn't change.
  assert.equal((await adv(`/api/rides/${r.data.ride.id}`, { method: 'PATCH', body: { notes: 'call first', ...denver } })).status, 200);

  // Admin can change the limit (0 = no limit) and it's validated.
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { service_radius_mi: 'far' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { service_radius_mi: '30' } });
  assert.equal((await adv('/api/rides', { body: { type: 'pickup', customer_name: 'Far OK', address: 'Denver', scheduled_at: at, ...denver } })).status, 201);
  const info = await (await fetch(base + '/api/public/info')).json();
  assert.equal(info.service_radius_mi, 30);
  await admin('/api/settings', { method: 'PATCH', body: { service_radius_mi: '15.5' } });

  // Settings sent to browsers never include the notification keys.
  const me = await (await fetch(base + '/api/me')).json();
  assert.equal(me.settings.vapid_private, undefined);
  assert.equal(me.settings.vapid_public, undefined);
  assert.equal(me.settings.service_radius_mi, '15.5');
  const saved = (await admin('/api/settings', { method: 'PATCH', body: { dealer_phone: '303-555-0000' } })).data.settings;
  assert.equal(saved.vapid_private, undefined);
});
