process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const webpush = require('web-push');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createPush } = require('../src/push');

// A browser-style subscription (real P-256 key) so encryption can be checked too.
function fakeSubscription(n) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

const delivered = [];
let gone = new Set();
async function fakeSender(sub, payload) {
  if (gone.has(sub.endpoint)) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
  delivered.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
}

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { pushSender: fakeSender, sms: { configured: false } });
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
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('keys are made once and real encryption works', () => {
  const db = openDb(':memory:');
  const a = createPush(db); const b = createPush(db);
  assert.equal(a.publicKey, b.publicKey, 'same key after a restart');
  const details = webpush.generateRequestDetails(fakeSubscription(0), 'hello', {
    vapidDetails: { subject: 'mailto:t@t.test', publicKey: a.publicKey, privateKey: db.prepare("SELECT value FROM settings WHERE key='vapid_private'").get().value },
  });
  assert.match(details.headers.Authorization, /^vapid t=/);
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
});

test('drivers get lock-screen notifications for new, assigned and cancelled rides', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@test.local', role: 'driver', password: 'driverpw1' } });
  await admin('/api/users', { body: { name: 'Off Duty', email: 'off@test.local', role: 'driver', password: 'driverpw1' } });
  const v = (await admin('/api/vehicles', { body: { name: 'Shuttle 1' } })).data.vehicle;

  const dana = client(); const off = client();
  const danaUser = (await dana('/api/login', { body: { email: 'dana@test.local', password: 'driverpw1' } })).data.user;
  await off('/api/login', { body: { email: 'off@test.local', password: 'driverpw1' } });

  // Sign up phones
  const { data: k } = await dana('/api/push');
  assert.ok(k.key.length > 80);
  assert.equal((await dana('/api/push/subscribe', { body: { subscription: { endpoint: 'http://bad', keys: {} } } })).status, 400);
  const danaPhone = fakeSubscription(1);
  assert.equal((await dana('/api/push/subscribe', { body: { subscription: danaPhone } })).data.devices, 1);
  await off('/api/push/subscribe', { body: { subscription: fakeSubscription(2) } });

  // Test button
  assert.equal((await dana('/api/push/test', { body: {} })).status, 200);
  assert.equal(delivered.at(-1).title, '🔔 Test notification');

  // New ride -> only on-duty drivers
  await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  delivered.length = 0;
  const ride = (await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Lee', address: '1 Main St', scheduled_at: new Date().toISOString() } })).data.ride;
  await settle();
  assert.equal(delivered.length, 1, 'off-duty driver not notified');
  assert.equal(delivered[0].endpoint, danaPhone.endpoint);
  assert.equal(delivered[0].title, '🚐 New shuttle ride');
  assert.match(delivered[0].body, /^Pat Lee — Pick up .* · 1 Main St$/);
  assert.equal(delivered[0].url, '/driver');

  // Assigned by an advisor/admin -> that driver
  delivered.length = 0;
  await admin(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: danaUser.id } });
  await settle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, '🚐 Ride assigned to you');

  // Cancelled by someone else -> the driver hears about it
  delivered.length = 0;
  await admin(`/api/rides/${ride.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer cancelled' } });
  await settle();
  assert.equal(delivered[0].title, '❌ Ride cancelled');
  assert.match(delivered[0].body, /Customer cancelled$/);

  // A driver taking a ride themselves doesn't notify themselves
  const r2 = (await admin('/api/rides', { body: { type: 'dropoff', customer_name: 'Sam', address: '2 Main', scheduled_at: new Date().toISOString() } })).data.ride;
  await settle(); delivered.length = 0;
  await dana(`/api/rides/${r2.id}`, { method: 'PATCH', body: { driver_id: danaUser.id } });
  await settle();
  assert.equal(delivered.length, 0);

  // A phone that turned notifications off is forgotten
  gone = new Set([danaPhone.endpoint]);
  await admin('/api/rides', { body: { type: 'pickup', customer_name: 'Gone', address: '3 Main', scheduled_at: new Date().toISOString() } });
  await settle();
  assert.equal((await dana('/api/push')).data.devices, 0);

  // Notification files are served fresh
  for (const p of ['/sw.js', '/manifest.webmanifest']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('cache-control'), 'no-cache', p);
  }
  assert.equal((await fetch(base + '/icons/icon-192.png')).status, 200);
  assert.equal((await admin('/api/push')).status, 200, 'admins can use the driver page too');
});
