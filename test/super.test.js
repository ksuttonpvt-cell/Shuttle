process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'ken@test.local', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'ken@test.local', restart: () => {} });
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

test('only super admins can use the Server page, and they manage who else can', async () => {
  const ken = client();
  const me = (await ken('/api/login', { body: { email: 'ken@test.local', password: 'adminpass1' } })).data.user;
  assert.equal(me.super_admin, true, 'the .env admin is a super admin');
  const andrea = (await ken('/api/users', { body: { name: 'Andrea', email: 'andrea@test.local', role: 'admin', password: 'adminpass2' } })).data.user;
  assert.equal(andrea.super_admin, false);
  const a = client();
  await a('/api/login', { body: { email: 'andrea@test.local', password: 'adminpass2' } });

  // A regular admin: no Server page, no restarts or backups.
  for (const p of ['/api/server/status', '/api/server/logs', '/api/server/backups', '/api/version']) assert.equal((await a(p)).status, 403, p);
  assert.equal((await a('/api/server/restart', { body: {} })).status, 403);
  assert.equal((await a('/api/updates/check', { body: {} })).status, 403);
  assert.equal((await ken('/api/server/status')).status, 200);

  // Regular admins can't make themselves (or anyone) super, or lock out a super admin.
  assert.equal((await a(`/api/users/${andrea.id}`, { method: 'PATCH', body: { super_admin: true } })).status, 403);
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { active: false } })).status, 403);
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { password: 'hijacked123' } })).status, 403);
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { email: 'evil@test.local' } })).status, 403);
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { role: 'driver' } })).status, 403);
  // A manager can't change a super admin at all, not even their name.
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { name: 'Ken S', email: 'KEN@test.local', phone: '303' } })).status, 403);
  assert.equal(me.owner, true, 'the .env admin owns the PC');

  // A super admin can make another super admin: the top of the business, but not the server side.
  let r = await ken(`/api/users/${andrea.id}`, { method: 'PATCH', body: { super_admin: true } });
  assert.deepEqual([r.data.user.super_admin, r.data.user.owner], [true, false]);
  assert.equal((await a('/api/server/status')).status, 403, 'super admins never see the server side');
  assert.equal((await a('/api/site-url')).status, 403, 'nor the web address');
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { phone: '303' } })).status, 403, 'only the owner changes the owner');
  assert.equal((await a(`/api/users/${andrea.id}`, { method: 'PATCH', body: { owner: true } })).status, 403, 'only the owner makes owners');
  // The owner can share ownership; then Andrea sees the Server page.
  r = await ken(`/api/users/${andrea.id}`, { method: 'PATCH', body: { owner: true } });
  assert.equal(r.data.user.owner, true);
  assert.equal((await a('/api/server/status')).status, 200);
  assert.equal((await ken(`/api/users/${me.id}`, { method: 'PATCH', body: { owner: false } })).status, 400, 'no locking yourself out');
  r = await ken(`/api/users/${andrea.id}`, { method: 'PATCH', body: { owner: false } });
  assert.equal(r.data.user.owner, false);
  // Nobody can remove their own super admin (no lock-out); changing role away from admin removes it.
  assert.equal((await ken(`/api/users/${me.id}`, { method: 'PATCH', body: { super_admin: false } })).status, 400);
  r = await ken(`/api/users/${andrea.id}`, { method: 'PATCH', body: { role: 'advisor' } });
  assert.equal(r.data.user.super_admin, false);
  assert.equal((await ken(`/api/users/${andrea.id}`, { method: 'PATCH', body: { super_admin: true } })).status, 400, 'only admins');
  // Advisors never see the staff list.
  assert.equal((await a('/api/users')).status, 403);
});
