process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@signup.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@signup.test', restart: () => {} });
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

test('new staff ask for an account from the sign-in page; an admin approves it', async () => {
  const anon = client();
  const ask = (body) => anon('/api/signup', { body: { name: 'Riley New', email: 'riley@signup.test', role: 'driver', password: 'mypassword1', phone: '303-555-0111', note: 'Started Monday', ...body } });
  assert.equal((await ask({ role: 'admin' })).status, 400, 'nobody can ask to be an admin');
  assert.equal((await ask({ password: 'short' })).status, 400);
  assert.equal((await ask({ email: 'nope' })).status, 400);
  const r = await ask({});
  assert.equal(r.status, 200); assert.match(r.data.message, /admin will look at your request/);
  // Same answer for an email that already has an account, and nothing changes.
  assert.deepEqual((await anon('/api/signup', { body: { name: 'Fake Boss', email: 'boss@signup.test', role: 'driver', password: 'mypassword1' } })).data, r.data);

  // Waiting: can't sign in yet (only told why with the right password).
  const me = client();
  const wait = await me('/api/login', { body: { email: 'riley@signup.test', password: 'mypassword1' } });
  assert.equal(wait.status, 403); assert.match(wait.data.error, /waiting for a shuttle admin/);
  assert.equal((await me('/api/login', { body: { email: 'riley@signup.test', password: 'wrongpass99' } })).status, 401);

  // The admin sees it, approves as an advisor instead.
  const a = client(); await a('/api/login', { body: { email: 'boss@signup.test', password: 'adminpass1' } });
  const req = (await a('/api/users')).data.users.find((u) => u.email === 'riley@signup.test');
  assert.ok(req.signup_at); assert.equal(req.active, false); assert.equal(req.role, 'driver'); assert.equal(req.signup_note, 'Started Monday');
  const d = client(); await a('/api/users', { body: { name: 'Dee', email: 'dee@signup.test', role: 'driver', password: 'driverpass1' } });
  await d('/api/login', { body: { email: 'dee@signup.test', password: 'driverpass1' } });
  assert.equal((await d(`/api/users/${req.id}/approve`, { body: {} })).status, 403, 'drivers cannot approve');
  const ok = await a(`/api/users/${req.id}/approve`, { body: { role: 'advisor' } });
  assert.equal(ok.status, 200); assert.equal(ok.data.user.role, 'advisor'); assert.equal(ok.data.user.active, true); assert.equal(ok.data.user.signup_at, null);
  const signedIn = await me('/api/login', { body: { email: 'riley@signup.test', password: 'mypassword1' } });
  assert.equal(signedIn.status, 200); assert.equal(signedIn.data.user.role, 'advisor');

  // Decline removes the request.
  await anon('/api/signup', { body: { name: 'Sam Spam', email: 'sam@signup.test', role: 'advisor', password: 'mypassword1' } });
  const sam = (await a('/api/users')).data.users.find((u) => u.email === 'sam@signup.test');
  assert.equal((await a(`/api/users/${sam.id}/decline`, { body: {} })).status, 200);
  assert.ok(!(await a('/api/users')).data.users.some((u) => u.email === 'sam@signup.test'));
  assert.equal((await a(`/api/users/${ok.data.user.id}/decline`, { body: {} })).status, 404, 'an approved account cannot be declined');

  // Admins can turn the link off.
  await a('/api/settings', { method: 'PATCH', body: { staff_signup: '0' } });
  assert.equal((await anon('/api/me')).data.settings.staff_signup, '0');
  assert.equal((await ask({ email: 'late@signup.test' })).status, 403);
});
