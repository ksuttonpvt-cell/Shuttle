process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { toE164 } = require('../src/sms');

const sent = [];
let failNext = false;
const fakeSms = {
  configured: true, from: '+15550000000',
  async send(to, body) { if (failNext) { failNext = false; throw new Error('Twilio is down'); } sent.push({ to, body }); return 'SM1'; },
};
let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { sms: fakeSms, publicUrl: 'https://shuttle.test' });
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
const settle = () => new Promise((r) => setTimeout(r, 50));

test('phone numbers become +1 numbers', () => {
  assert.equal(toE164('303-555-1234'), '+13035551234');
  assert.equal(toE164('1 (303) 555-1234'), '+13035551234');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('555-1234'), null);
  assert.equal(toE164(''), null);
});

test('texts, customer-ready drop offs, and reports', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@test.local', role: 'driver', password: 'driverpw1' } });
  const v = (await admin('/api/vehicles', { body: { name: 'Shuttle 1', make_model: 'Toyota Sienna', color: 'White', plate: 'CTB-001' } })).data.vehicle;
  const driver = client();
  const me = (await driver('/api/login', { body: { email: 'dana@test.local', password: 'driverpw1' } })).data.user;
  await driver('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });

  // Booking texts the customer a tracking link.
  const soon = new Date(Date.now() - 20 * 60000).toISOString(); // due 20 min ago, so the wait is measurable
  let r = await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Lee', customer_phone: '303-555-1234', address: '1 Main', scheduled_at: soon } });
  const pickup = r.data.ride;
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+13035551234');
  assert.match(sent[0].body, /^Hi Pat, your .* shuttle pick up is booked for .*Track your driver here: https:\/\/shuttle\.test\/t\//);

  // "On my way" texts the driver's name and vehicle.
  await driver(`/api/rides/${pickup.id}`, { method: 'PATCH', body: { driver_id: me.id } });
  await driver(`/api/rides/${pickup.id}`, { method: 'PATCH', body: { status: 'en_route' } });
  await settle();
  assert.match(sent[1].body, /Dana is on the way in a White Toyota Sienna \(plate CTB-001\)/);
  await driver(`/api/rides/${pickup.id}`, { method: 'PATCH', body: { status: 'onboard' } });
  r = await driver(`/api/rides/${pickup.id}`, { method: 'PATCH', body: { status: 'completed' } });
  assert.ok(r.data.ride.en_route_at && r.data.ride.onboard_at && r.data.ride.completed_at);
  assert.equal(sent.length, 2, 'no texts for on board / completed');

  // Admin can turn a message type off.
  await admin('/api/settings', { method: 'PATCH', body: { sms_booked: '0' } });
  await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Quiet Q', customer_phone: '3035550000', address: '2 Main', scheduled_at: soon } });
  await settle();
  assert.equal(sent.length, 2);
  await admin('/api/settings', { method: 'PATCH', body: { sms_booked: '1' } });

  // A failed text is logged and doesn't break booking.
  failNext = true;
  r = await admin('/api/rides', { body: { type: 'dropoff', customer_name: 'Fail F', customer_phone: '3035550001', address: '3 Main', scheduled_at: soon } });
  assert.equal(r.status, 201);
  await settle();
  const log = (await admin('/api/sms')).data;
  assert.equal(log.configured, true);
  assert.equal(log.log[0].status, 'failed');
  assert.match(log.log[0].error, /Twilio is down/);

  // Cancelling texts the customer (without the internal reason).
  await admin(`/api/rides/${r.data.ride.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer no-show: waited 10 min' } });
  await settle();
  assert.match(sent.at(-1).body, /has been cancelled/);
  assert.doesNotMatch(sent.at(-1).body, /no-show/i);

  // Customer ready: book the drop off from the finished pick up, only once.
  r = await admin('/api/rides', { body: { type: 'dropoff', customer_name: 'Pat Lee', customer_phone: '303-555-1234', address: '1 Main', scheduled_at: new Date().toISOString(), return_of: pickup.id } });
  assert.equal(r.status, 201);
  assert.equal(r.data.ride.return_of, pickup.id);
  const again = await admin('/api/rides', { body: { type: 'dropoff', customer_name: 'Pat Lee', address: '1 Main', scheduled_at: new Date().toISOString(), return_of: pickup.id } });
  assert.equal(again.status, 400);
  const list = (await admin('/api/rides?scope=today')).data.rides;
  assert.equal(list.find((x) => x.id === pickup.id).return_ride_id, r.data.ride.id);

  // Reports
  r = await admin('/api/reports');
  assert.equal(r.status, 200);
  const t = r.data.totals;
  assert.equal(t.rides, 4);
  assert.equal(t.completed, 1);
  assert.equal(t.cancelled, 1);
  assert.equal(t.no_shows, 1);
  assert.equal(t.pickups, 2);
  assert.ok(t.avg_wait_min >= 19 && t.avg_wait_min <= 21, `wait was ${t.avg_wait_min}`);
  assert.equal(t.on_time_pct, 0);
  assert.equal(r.data.days.length, 7);
  assert.deepEqual(r.data.cancel_reasons, [{ reason: 'Customer no-show', count: 1 }]);
  assert.equal(r.data.drivers[0].name, 'Dana Driver');
  assert.deepEqual(r.data.type_counts, { all: 4, pickup: 2, dropoff: 2 });
  assert.equal(r.data.type, 'all');
  // Pick up / drop off filter
  let f = (await admin('/api/reports?type=pickup')).data;
  assert.equal(f.type, 'pickup');
  assert.equal(f.totals.rides, 2);
  assert.equal(f.totals.dropoffs, 0);
  assert.equal(f.totals.completed, 1, 'the completed ride was a pick up');
  assert.deepEqual(f.type_counts, { all: 4, pickup: 2, dropoff: 2 }, 'button counts stay the same');
  assert.equal(f.days.reduce((n, d) => n + d.rides, 0), 2);
  f = (await admin('/api/reports?type=dropoff')).data;
  assert.equal(f.totals.rides, 2);
  assert.equal(f.totals.pickups, 0);
  assert.deepEqual(f.cancel_reasons, [{ reason: 'Customer no-show', count: 1 }], 'the no-show was a drop off');
  assert.equal(f.drivers.length, 0, 'the driver only did a pick up');
  assert.equal((await admin('/api/reports?type=nonsense')).data.type, 'all');
  assert.equal((await driver('/api/reports')).status, 403, 'reports are admin only');
  assert.equal((await admin('/api/reports?from=2026-05-02&to=2026-05-01')).status, 400);
});
