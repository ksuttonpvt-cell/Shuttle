process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

const fakeSms = { configured: true, from: '+15550000000', async send() { return 'SM1'; } };
let server; let base; let theApp;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  theApp = createApp(db, { sms: fakeSms, publicUrl: 'https://shuttle.test', noTimers: true });
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

test('customer info on finished rides is deleted at midnight (when set to clear the same night)', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  const book = async (name, type = 'pickup') => (await admin('/api/rides', { body: {
    type, customer_name: name, customer_phone: '303-555-1234', customer_email: 'pat@example.com',
    address: '1 Main St, Boulder', lat: 40.02, lng: -105.25, notes: 'Gate code 1234', scheduled_at: '2026-11-13T17:00:00Z',
  } })).data.ride;
  const done = await book('Pat Done');
  const gone = await book('Sam Cancelled', 'dropoff');
  const open = await book('Olive Open');
  assert.equal((await admin(`/api/rides/${done.id}`, { method: 'PATCH', body: { status: 'completed' } })).status, 200);
  assert.equal((await admin(`/api/rides/${gone.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer no-show' } })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await admin('/api/sms')).data.log.length >= 1, 'texts were logged');

  await admin('/api/settings', { method: 'PATCH', body: { keep_customer_days: '0', clear_customer_info: '00:00' } });
  const tick = theApp.locals.clearCustomerInfo;
  // Denver is UTC-7 in November.
  assert.equal(tick(new Date('2026-11-14T05:00:00Z')), 0, '10 PM, first check: waits for midnight');
  assert.equal(tick(new Date('2026-11-14T06:59:00Z')), 0, '11:59 PM: not yet');
  assert.equal(tick(new Date('2026-11-14T07:01:00Z')), 2, '12:01 AM: both finished rides cleared');
  assert.equal(tick(new Date('2026-11-14T15:00:00Z')), 0, 'once a day');

  const all = (await admin('/api/rides?scope=all')).data.rides;
  for (const id of [done.id, gone.id]) {
    const r = all.find((x) => x.id === id);
    assert.equal(r.customer_name, 'Customer (info cleared)');
    for (const f of ['customer_phone', 'customer_email', 'lat', 'lng', 'notes']) assert.equal(r[f], null, f);
    assert.equal(r.address, '(cleared)');
    assert.ok(r.cleared_at);
  }
  assert.equal(all.find((x) => x.id === gone.id).cancel_reason, 'Customer no-show', 'cancel reason kept for reports');
  // Open rides keep everything.
  const o = all.find((x) => x.id === open.id);
  assert.equal(o.customer_name, 'Olive Open');
  assert.equal(o.customer_phone, '303-555-1234');
  assert.equal(o.notes, 'Gate code 1234');
  // Old tracking links stop working; open ones still do.
  assert.equal((await fetch(`${base}/api/public/track/${done.track_token}`)).status, 404);
  assert.equal((await fetch(`${base}/api/public/track/${open.track_token}`)).status, 200);
  // Text log emptied; reports still count the rides.
  assert.equal((await admin('/api/sms')).data.log.length, 0);
  const rep = (await admin('/api/reports?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(JSON.stringify(rep).includes('Pat Done'), false);
  assert.ok(JSON.stringify(rep).includes('Customer no-show'));

  // Turning it off stops it.
  await admin(`/api/rides/${open.id}`, { method: 'PATCH', body: { status: 'completed' } });
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { clear_customer_info: 'later' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { clear_customer_info: '' } });
  assert.equal(tick(new Date('2026-11-15T07:05:00Z')), 0);
  assert.equal((await admin('/api/rides?scope=all')).data.rides.find((x) => x.id === open.id).customer_name, 'Olive Open');
});

test('by default customer info is kept 30 days, then cleared; the number of days can be changed', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/settings', { method: 'PATCH', body: { keep_customer_days: '30', clear_customer_info: '00:00' } });
  assert.equal((await admin('/api/me')).data.settings.keep_customer_days, '30');
  for (const bad of ['-1', '400', 'month', '']) assert.equal((await admin('/api/settings', { method: 'PATCH', body: { keep_customer_days: bad } })).status, 400, bad);
  const ride = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Kim Keep', customer_phone: '303-555-7777',
    address: '2 Main St, Boulder', lat: 40.02, lng: -105.25, scheduled_at: new Date().toISOString() } })).data.ride;
  await admin(`/api/rides/${ride.id}`, { method: 'PATCH', body: { status: 'completed' } });
  const tick = theApp.locals.clearCustomerInfo;
  const day = 86400000; const t0 = Date.now();
  tick(new Date(t0 + day)); // first check only notes the day
  tick(new Date(t0 + 2 * day));
  const name = async () => (await admin('/api/rides?scope=all')).data.rides.find((x) => x.id === ride.id).customer_name;
  assert.equal(await name(), 'Kim Keep', 'still there two days later');
  // Staff can still find it by phone number.
  assert.ok((await admin('/api/rides?scope=search&q=5557777')).data.rides.some((x) => x.id === ride.id));
  tick(new Date(t0 + 20 * day));
  assert.equal(await name(), 'Kim Keep', 'still there after 20 days');
  tick(new Date(t0 + 31 * day));
  assert.equal(await name(), 'Customer (info cleared)', 'cleared after 30 days');

  // A shorter setting clears sooner.
  await admin('/api/settings', { method: 'PATCH', body: { keep_customer_days: '7' } });
  const r2 = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Lou Week', address: '3 Main St, Boulder', lat: 40.02, lng: -105.25, scheduled_at: new Date().toISOString() } })).data.ride;
  await admin(`/api/rides/${r2.id}`, { method: 'PATCH', body: { status: 'completed' } });
  tick(new Date(t0 + 3 * day)); tick(new Date(t0 + 5 * day));
  assert.equal((await admin('/api/rides?scope=all')).data.rides.find((x) => x.id === r2.id).customer_name, 'Lou Week');
  tick(new Date(t0 + 8 * day));
  assert.equal((await admin('/api/rides?scope=all')).data.rides.find((x) => x.id === r2.id).customer_name, 'Customer (info cleared)');
});
