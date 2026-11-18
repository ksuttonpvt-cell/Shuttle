process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createBackups } = require('../src/backup');

let server; let base; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-wipe-'));
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@wipe.test', password: 'adminpass1', name: 'Ken Boss' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@wipe.test', restart: () => {}, backups: createBackups({ db, dir }) });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('remove all staff except super admins: accounts retired, history kept', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@wipe.test', password: 'adminpass1' } });
  const mk = (name, email, roles) => a('/api/users', { body: { name, email, roles, password: 'password123' } });
  await mk('Sam Driver', 'sam@wipe.test', ['driver']); await mk('Ann Advisor', 'ann@wipe.test', ['advisor']); await mk('Pat Admin', 'pat@wipe.test', ['admin']);
  await client()('/api/signup', { body: { name: 'New Person', email: 'new@wipe.test', role: 'driver', password: 'mypassword1' } });
  const sam = client(); const samMe = (await sam('/api/login', { body: { email: 'sam@wipe.test', password: 'password123' } })).data.user;
  const ann = client(); await ann('/api/login', { body: { email: 'ann@wipe.test', password: 'password123' } });
  const pat = client(); await pat('/api/login', { body: { email: 'pat@wipe.test', password: 'password123' } });

  // History: one ride done by Sam, one assigned to Sam but not started.
  const v = (await a('/api/vehicles', { body: { name: 'Shuttle 1', seats: 6, use: 'shuttle' } })).data.vehicle;
  await sam('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  const book = async (name) => (await ann('/api/rides', { body: { type: 'pickup', customer_name: name, customer_phone: '303-555-0100', address: '1 Main', lat: 40.01, lng: -105.27, scheduled_at: new Date(Date.now() + 10 * 60000).toISOString(), passengers: 1 } })).data.ride;
  const done = await book('Done Ride'); const waiting = await book('Waiting Ride');
  for (const r of [done, waiting]) await sam(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: samMe.id } });
  for (const st of ['en_route', 'onboard', 'completed']) await sam(`/api/rides/${done.id}`, { method: 'PATCH', body: { status: st } });

  // Only super admins, and only with the exact words.
  assert.equal((await pat('/api/server/staff-wipe')).status, 403, 'a regular admin can\'t');
  const preview = (await a('/api/server/staff-wipe')).data;
  assert.deepEqual(preview.remove.map((u) => u.name), ['Ann Advisor', 'Pat Admin', 'Sam Driver']);
  assert.equal(preview.requests, 1); assert.deepEqual(preview.keep, ['Ken Boss']);
  assert.equal((await a('/api/server/staff-wipe', { body: { confirm: 'yes' } })).status, 400);

  const r = await a('/api/server/staff-wipe', { body: { confirm: 'remove staff' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.removed, r.data.requests], [3, 1]);
  assert.match(r.data.backup, /^shuttle-manual-/, 'backup made first');
  assert.ok(fs.existsSync(path.join(dir, r.data.backup)));

  // Gone: signed out, can't sign in, hidden from lists.
  assert.equal((await sam('/api/me')).data.user, null, 'signed out');
  assert.equal((await client()('/api/login', { body: { email: 'sam@wipe.test', password: 'password123' } })).status >= 400, true);
  assert.deepEqual((await a('/api/users')).data.users.map((u) => u.name), ['Ken Boss']);
  assert.equal((await a('/api/drivers')).data.drivers.length, 0);
  assert.equal((await a('/api/advisors')).data.advisors.length, 0);
  // Kept: the super admin still works, history keeps names, the unstarted ride is back in line.
  assert.equal((await a('/api/me')).data.user.name, 'Ken Boss');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const rep = (await a(`/api/reports?from=${today}&to=${tomorrow}`)).data;
  assert.ok(rep.drivers.some((d) => d.name === 'Sam Driver' && d.completed === 1), 'reports keep the name');
  const rides = (await a('/api/rides?scope=open')).data.rides;
  const w = rides.find((x) => x.id === waiting.id);
  assert.deepEqual([w.driver_id, w.status, w.advisor_name], [null, 'requested', 'Ann Advisor']);
  // Their email can be used again.
  assert.equal((await mk('Sam Driver', 'sam@wipe.test', ['driver'])).status, 201);
  // Nothing left to remove but the new account.
  assert.deepEqual((await a('/api/server/staff-wipe')).data.remove.map((u) => u.name), ['Sam Driver']);
});
