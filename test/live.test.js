process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base; let theApp;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  theApp = createApp(db, { noTimers: true });
  await new Promise((r) => { server = theApp.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
function client() {
  let cookie = '';
  const call = async (p, { method, body } = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  // Opens the live-updates stream and collects event names.
  call.listen = async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: ctrl.signal });
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      try { for await (const chunk of res.body) for (const m of dec.decode(chunk).matchAll(/^event: (\w+)/gm)) events.push(m[1]); } catch { /* closed */ }
    })();
    return { res, events, close: () => ctrl.abort() };
  };
  return call;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('pages get instant updates when rides change, and offers go only to that driver', async () => {
  assert.equal((await fetch(base + '/api/events')).status, 401, 'staff only');
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Dana', email: 'dana@t.l', role: 'driver', password: 'driverpw1' } });
  await admin('/api/users', { body: { name: 'Eli', email: 'eli@t.l', role: 'driver', password: 'driverpw1' } });
  const v1 = (await admin('/api/vehicles', { body: { name: 'Van 1' } })).data.vehicle;
  const v2 = (await admin('/api/vehicles', { body: { name: 'Van 2' } })).data.vehicle;
  const dana = client(); const eli = client();
  await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } });
  await eli('/api/login', { body: { email: 'eli@t.l', password: 'driverpw1' } });

  const watch = await admin.listen();
  assert.equal(watch.res.status, 200);
  assert.match(watch.res.headers.get('content-type'), /text\/event-stream/);
  const danaWatch = await dana.listen(); const eliWatch = await eli.listen();
  assert.equal(theApp.locals.live.count, 3);

  // A new ride: everyone hears "rides" within a moment (several changes = one message).
  await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Pat', address: '1 Main', lat: 40.0185, lng: -105.2755, scheduled_at: new Date().toISOString() } });
  await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Sam', address: '2 Main', lat: 40.0, lng: -105.0, scheduled_at: new Date().toISOString() } });
  await wait(600);
  assert.equal(watch.events.filter((e) => e === 'rides').length, 1);
  assert.ok(danaWatch.events.includes('rides'));

  // Drivers going on shift and moving: "drivers".
  await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: v1.id } });
  await eli('/api/driver/shift', { body: { on_duty: true, vehicle_id: v2.id } });
  await dana('/api/driver/location', { body: { lat: 40.016, lng: -105.27 } });
  await eli('/api/driver/location', { body: { lat: 39.9, lng: -104.9 } });
  await wait(1800);
  assert.ok(watch.events.includes('drivers'));

  // Ride offers: only the chosen driver is told.
  const before = { dana: danaWatch.events.length, eli: eliWatch.events.length };
  const made = theApp.locals.offerSweep();
  assert.ok(made.length >= 1);
  await wait(400);
  const toDana = made.some((o) => o.driver_id && o.driver_id === made[0].driver_id);
  assert.ok(toDana);
  const offerFor = (w) => w.events.filter((e) => e === 'offer').length;
  assert.equal(offerFor(danaWatch) + offerFor(eliWatch), made.length, 'one offer message per offer, to its driver');
  assert.ok(danaWatch.events.length > before.dana || eliWatch.events.length > before.eli);

  for (const w of [watch, danaWatch, eliWatch]) w.close();
  await wait(100);
  assert.equal(theApp.locals.live.count, 0, 'closed connections are forgotten');
});
