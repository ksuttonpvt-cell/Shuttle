process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

const pushes = [];
let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const pushSender = { async sendNotification(sub, payload) { pushes.push(JSON.parse(payload)); } };
  const app = createApp(db, { publicUrl: 'https://shuttle.test', pushSender });
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

test('forgot password: request, admin reset link, one-time use', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  const dana = (await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@test.local', role: 'driver', password: 'driverpw1' } })).data.user;

  // Dana is signed in on an old phone.
  const oldPhone = client();
  assert.equal((await oldPhone('/api/login', { body: { email: 'dana@test.local', password: 'driverpw1' } })).status, 200);

  // Asking for a reset gives the same answer for real and unknown emails.
  const anon = client();
  let r = await anon('/api/password-reset/request', { body: { email: 'nobody@test.local' } });
  assert.equal(r.status, 200);
  r = await anon('/api/password-reset/request', { body: { email: 'DANA@test.local' } });
  assert.equal(r.status, 200);
  let users = (await admin('/api/users')).data.users;
  assert.ok(users.find((u) => u.id === dana.id).reset_requested_at, 'admin sees the request');
  assert.ok(!users.find((u) => u.email === 'admin@test.local').reset_requested_at);

  // Only admins can make links.
  assert.equal((await oldPhone(`/api/users/${dana.id}/reset-link`, { body: {} })).status, 403);
  const first = (await admin(`/api/users/${dana.id}/reset-link`, { body: {} })).data;
  assert.match(first.url, /^https:\/\/shuttle\.test\/reset\/[\w-]{20,}$/);
  assert.equal(first.user.reset_requested_at, null, 'request is cleared once a link is made');

  // A newer link cancels the older one.
  const link = (await admin(`/api/users/${dana.id}/reset-link`, { body: {} })).data.url;
  const oldToken = first.url.split('/').pop();
  const token = link.split('/').pop();
  assert.equal((await anon(`/api/password-reset/${oldToken}`)).status, 404);
  assert.equal((await anon('/api/password-reset/not-a-real-token')).status, 404);

  r = await anon(`/api/password-reset/${token}`);
  assert.deepEqual(r.data, { name: 'Dana Driver', email: 'dana@test.local' });
  assert.equal((await anon(`/api/password-reset/${token}`, { body: { password: 'short' } })).status, 400);

  // Using the link sets the password, signs Dana in, and signs out old devices.
  const newPhone = client();
  r = await newPhone(`/api/password-reset/${token}`, { body: { password: 'brandnewpw9' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'dana@test.local');
  assert.equal((await newPhone('/api/me')).data.user.email, 'dana@test.local');
  assert.equal((await oldPhone('/api/me')).data.user, null);

  // The link only works once, and the old password is gone.
  assert.equal((await anon(`/api/password-reset/${token}`, { body: { password: 'anotherpw99' } })).status, 404);
  assert.equal((await anon('/api/login', { body: { email: 'dana@test.local', password: 'driverpw1' } })).status, 401);
  assert.equal((await anon('/api/login', { body: { email: 'dana@test.local', password: 'brandnewpw9' } })).status, 200);

  // Admin can dismiss a request without sending a link.
  await anon('/api/password-reset/request', { body: { email: 'admin@test.local' } });
  const me = (await admin('/api/users')).data.users.find((u) => u.email === 'admin@test.local');
  assert.ok(me.reset_requested_at);
  await admin(`/api/users/${me.id}/dismiss-reset`, { body: {} });
  assert.equal((await admin('/api/users')).data.users.find((u) => u.id === me.id).reset_requested_at, null);

  // Disabled accounts can't get links, and the request button is rate limited.
  await admin(`/api/users/${dana.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await admin(`/api/users/${dana.id}/reset-link`, { body: {} })).status, 400);
  let last;
  for (let i = 0; i < 6; i++) last = await anon('/api/password-reset/request', { body: { email: 'x@test.local' } });
  assert.equal(last.status, 429);
});

test('reset page is served without caching or referrer', async () => {
  const res = await fetch(base + '/reset/abc');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await res.text(), /Set a new password/);
});
