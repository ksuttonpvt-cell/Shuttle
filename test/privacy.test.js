process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

const fakeSms = { configured: true, from: '+15550000000', async send() { return 'SM1'; } };
let server; let base; let theApp;
before(async () => {
  const db = openDb(':memory:');
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

test('customer info on finished rides is deleted at midnight', async () => {
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

  await admin('/api/settings', { method: 'PATCH', body: { clear_customer_info: '00:00' } });
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
