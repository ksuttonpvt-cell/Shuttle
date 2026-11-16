process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'cam@cust.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'cam@cust.test', restart: () => {} });
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

const QRCode = require('qrcode');
const soon = (min) => new Date(Date.now() + min * 60000).toISOString();
async function newRide(a, extra = {}) {
  return (await a('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Customer', customer_phone: '3035550101', address: '1300 Pearl St', lat: 40.018, lng: -105.278, scheduled_at: soon(60), passengers: 1, ...extra } })).data.ride;
}

test('tracking links are short, easy to read, and any case works', async () => {
  const a = client(); await a('/api/login', { body: { email: 'cam@cust.test', password: 'adminpass1' } });
  const r = await newRide(a);
  assert.match(r.track_token, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/, 'no 0/O, 1/I/L or U');
  assert.ok(r.track_url.endsWith(`/t/${r.track_token}`));
  const anon = client();
  assert.equal((await anon(`/api/public/track/${r.track_token}`)).status, 200);
  assert.equal((await anon(`/api/public/track/${r.track_token.toLowerCase()}`)).status, 200, 'lower case works too');
  assert.equal((await fetch(`${base}/T/${r.track_token}`)).status, 200, 'the capital-letter QR link opens the page');
  // The QR code is written in capitals (simpler code); same for the request page.
  const png = Buffer.from(await (await fetch(`${base}/api/public/track/${r.track_token}/qr`)).arrayBuffer());
  assert.ok(png.equals(await QRCode.toBuffer(`${base}/t/${r.track_token}`.toUpperCase(), { width: 320, margin: 2 })));
  assert.ok(QRCode.create(`${base}/t/${r.track_token}`.toUpperCase()).version <= QRCode.create(`${base}/t/${r.track_token}`).version);
  const rq = Buffer.from(await (await fetch(`${base}/api/public/request-qr`)).arrayBuffer());
  assert.ok(rq.equals(await QRCode.toBuffer(`${base}/request`.toUpperCase(), { width: 320, margin: 2 })));
});

test('customers can say they are running late, or cancel, from the tracking page', async () => {
  const a = client(); await a('/api/login', { body: { email: 'cam@cust.test', password: 'adminpass1' } });
  const r = await newRide(a);
  const c = client();
  const t = `/api/public/track/${r.track_token}`;
  assert.equal((await c(t)).data.can_change, true);
  assert.equal((await c(`${t}/late`, { body: { minutes: 7 } })).status, 400, 'only the offered choices');
  const late = await c(`${t}/late`, { body: { minutes: 10 } });
  assert.equal(late.status, 200);
  const notes = (await a('/api/rides')).data.rides.find((x) => x.id === r.id).notes;
  assert.match(notes, /Customer: running about 10 minutes late\./);
  await c(`${t}/late`, { body: { minutes: 5 } }); await c(`${t}/late`, { body: { minutes: 5 } });
  assert.equal((await c(`${t}/late`, { body: { minutes: 5 } })).status, 429, 'three updates an hour at most');

  assert.equal((await c(`${t}/cancel`, { body: { reason: 'Because' } })).status, 400);
  assert.equal((await c(`${t}/cancel`, { body: { reason: 'Other' } })).status, 400, '"Other" needs a few words');
  const cx = await c(`${t}/cancel`, { body: { reason: 'I found another ride' } });
  assert.equal(cx.status, 200);
  const after = (await a('/api/rides?scope=all')).data.rides.find((x) => x.id === r.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.cancel_reason, 'Customer cancelled: I found another ride');
  assert.equal((await c(`${t}/cancel`, { body: { reason: 'Other', details: 'again' } })).status, 409);
  assert.equal((await c(t)).data.can_change, false);

  // Admins can turn these off.
  await a('/api/settings', { method: 'PATCH', body: { customer_actions: '0' } });
  const r2 = await newRide(a);
  assert.equal((await c(`/api/public/track/${r2.track_token}`)).data.can_change, false);
  assert.equal((await c(`/api/public/track/${r2.track_token}/late`, { body: { minutes: 5 } })).status, 403);
  await a('/api/settings', { method: 'PATCH', body: { customer_actions: '1' } });
});

test('add to calendar, and an arrival estimate while the driver is on the way', async () => {
  const a = client(); await a('/api/login', { body: { email: 'cam@cust.test', password: 'adminpass1' } });
  const r = await newRide(a);
  const ics = await fetch(`${base}/api/public/track/${r.track_token}/calendar`);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  const body = await ics.text();
  assert.match(body, /BEGIN:VEVENT/); assert.match(body, /SUMMARY:Shuttle pick up/); assert.match(body, new RegExp(`/t/${r.track_token}`));
  // A driver on the way, about 2 km out, with no planned route: the page still gets an estimate.
  await a('/api/users', { body: { name: 'Dee Driver', email: 'dee@cust.test', role: 'driver', password: 'driverpass1' } });
  const v = (await a('/api/vehicles', { body: { name: 'Van 1', seats: 7 } })).data.vehicle;
  const d = client(); const me = (await d('/api/login', { body: { email: 'dee@cust.test', password: 'driverpass1' } })).data.user;
  await d('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  await d('/api/driver/location', { body: { lat: 40.0, lng: -105.278 } });
  await d(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: me.id } });
  await d(`/api/rides/${r.id}`, { method: 'PATCH', body: { status: 'en_route' } });
  const tr = (await client()(`/api/public/track/${r.track_token}`)).data;
  assert.ok(tr.eta, 'has an estimate');
  assert.equal(tr.eta_estimated, true);
  const mins = (new Date(tr.eta) - Date.now()) / 60000;
  assert.ok(mins > 1 && mins < 15, `about ${mins.toFixed(1)} min for ~2 km`);
});

test('guessing tracking codes is cut off', async () => {
  const anon = client();
  let last;
  for (let i = 0; i < 41; i++) last = await anon(`/api/public/track/ZZZZZZZ${'23456789ABCDEFGHJKMNPQRSTVWXYZ'[i % 30]}`);
  assert.equal(last.status, 429);
});
