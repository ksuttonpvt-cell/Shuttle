process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { noTimers: true });
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
const mins = (iso) => (new Date(iso) - Date.now()) / 60000;

test('drop offs wait unless urgent, and urgent needs a reason', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  const ride = (extra) => ({ customer_name: 'Pat', address: '1 Main', lat: 40.02, lng: -105.25, scheduled_at: new Date().toISOString(), ...extra });

  // Default 30 minutes: a drop off for "now" moves to 30 minutes from now.
  let r = await admin('/api/rides', { body: ride({ type: 'dropoff' }) });
  assert.equal(r.status, 201);
  assert.ok(r.data.adjusted_to);
  assert.equal(r.data.wait_min, 30);
  assert.ok(mins(r.data.ride.scheduled_at) > 28 && mins(r.data.ride.scheduled_at) <= 30.1);
  // Later than the wait: left alone.
  const later = new Date(Date.now() + 90 * 60000).toISOString();
  r = await admin('/api/rides', { body: ride({ type: 'dropoff', scheduled_at: later }) });
  assert.equal(r.data.adjusted_to, null);
  assert.equal(r.data.ride.scheduled_at, later);
  // Pick ups never wait.
  r = await admin('/api/rides', { body: ride({ type: 'pickup' }) });
  assert.equal(r.data.adjusted_to, null);
  assert.ok(mins(r.data.ride.scheduled_at) < 1);

  // Urgent skips the wait, but only with a reason.
  r = await admin('/api/rides', { body: ride({ type: 'dropoff', priority: 'urgent' }) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /reason/);
  r = await admin('/api/rides', { body: ride({ type: 'dropoff', priority: 'urgent', urgent_reason: 'Flight at 2 PM' }) });
  assert.equal(r.status, 201);
  assert.equal(r.data.adjusted_to, null);
  assert.equal(r.data.ride.urgent_reason, 'Flight at 2 PM');
  assert.ok(mins(r.data.ride.scheduled_at) < 1);

  // Switching an existing drop off to urgent later also needs a reason; switching back clears it.
  const waiting = (await admin('/api/rides', { body: ride({ type: 'dropoff' }) })).data.ride;
  assert.equal((await admin(`/api/rides/${waiting.id}`, { method: 'PATCH', body: { priority: 'urgent' } })).status, 400);
  r = await admin(`/api/rides/${waiting.id}`, { method: 'PATCH', body: { priority: 'urgent', urgent_reason: 'Customer is upset', scheduled_at: new Date().toISOString() } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ride.priority, 'urgent');
  assert.ok(mins(r.data.ride.scheduled_at) < 1, 'urgent can go now');
  r = await admin(`/api/rides/${waiting.id}`, { method: 'PATCH', body: { priority: 'normal' } });
  assert.equal(r.data.ride.urgent_reason, null);
  assert.ok(mins(r.data.ride.scheduled_at) > 28, 'back to normal waits again');
  // Editing just the notes of an older drop off doesn't move it.
  const before = r.data.ride.scheduled_at;
  r = await admin(`/api/rides/${waiting.id}`, { method: 'PATCH', body: { notes: 'Side door' } });
  assert.equal(r.data.ride.scheduled_at, before);

  // Customers can't make a ride urgent; their drop offs wait too.
  const pub = await fetch(`${base}/api/public/rides`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ride({ type: 'dropoff', customer_phone: '303-555-0101', priority: 'urgent', urgent_reason: 'me first' })) });
  assert.equal(pub.status, 201);
  const mine = (await admin('/api/rides')).data.rides.find((x) => x.source === 'customer');
  assert.equal(mine.priority, 'normal');
  assert.equal(mine.urgent_reason, null);
  assert.ok(mins(mine.scheduled_at) > 28);
  assert.equal((await (await fetch(`${base}/api/public/info`)).json()).dropoff_wait_min, 30);

  // Admin can change or turn off the wait.
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { dropoff_wait_min: '-5' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { dropoff_wait_min: '0' } });
  r = await admin('/api/rides', { body: ride({ type: 'dropoff' }) });
  assert.equal(r.data.adjusted_to, null);
});
