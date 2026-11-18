process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createBackups } = require('../src/backup');

let server; let base; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-wipe-'));
  const db = seedTestSite(openDb(':memory:'));
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

test('delete one person: managers and super admins can; history is kept', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@wipe.test', password: 'adminpass1' } }); // super admin
  const mk = async (name, email, roles) => (await a('/api/users', { body: { name, email, roles, password: 'password123' } })).data.user;
  const mgr = await mk('Mia Manager', 'mia@wipe.test', ['admin']);
  const drv = await mk('Dee Driver', 'dee@wipe.test', ['driver']);
  const adv = await mk('Abe Advisor', 'abe@wipe.test', ['advisor']);
  const m = client(); await m('/api/login', { body: { email: 'mia@wipe.test', password: 'password123' } });
  const ab = client(); await ab('/api/login', { body: { email: 'abe@wipe.test', password: 'password123' } });
  const d = client(); await d('/api/login', { body: { email: 'dee@wipe.test', password: 'password123' } });
  // A finished ride by Dee, for history.
  const v = (await a('/api/vehicles', { body: { name: 'Van 9', seats: 6, use: 'shuttle' } })).data.vehicle;
  await d('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } });
  const r = (await ab('/api/rides', { body: { type: 'pickup', customer_name: 'Hist Ride', customer_phone: '303-555-0100', address: '1 Main', lat: 40.01, lng: -105.27, scheduled_at: new Date(Date.now() + 600000).toISOString(), passengers: 1 } })).data.ride;
  await d(`/api/rides/${r.id}`, { method: 'PATCH', body: { driver_id: drv.id } });
  for (const st of ['en_route', 'onboard', 'completed']) await d(`/api/rides/${r.id}`, { method: 'PATCH', body: { status: st } });

  assert.equal((await ab(`/api/users/${drv.id}`, { method: 'DELETE' })).status, 403, 'advisors can\'t');
  const boss = (await a('/api/me')).data.user;
  assert.equal((await m(`/api/users/${boss.id}`, { method: 'DELETE' })).status, 403, 'a manager can\'t delete a super admin');
  assert.equal((await m(`/api/users/${mgr.id}`, { method: 'DELETE' })).status, 400, 'nobody deletes themselves');
  // A manager deletes the driver.
  assert.equal((await m(`/api/users/${drv.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await d('/api/me')).data.user, null, 'signed out');
  assert.ok((await client()('/api/login', { body: { email: 'dee@wipe.test', password: 'password123' } })).status >= 400);
  assert.ok(!(await a('/api/users')).data.users.some((u) => u.id === drv.id));
  assert.equal((await m(`/api/users/${drv.id}`, { method: 'DELETE' })).status, 404, 'already gone');
  const ride = (await a('/api/rides?scope=recent')).data.rides.find((x) => x.id === r.id);
  assert.equal(ride.driver_name, 'Dee Driver', 'history keeps the name');
  assert.equal((await mk('Dee Driver', 'dee@wipe.test', ['driver'])).email, 'dee@wipe.test', 'email can be reused');
  // The super admin deletes the manager.
  assert.equal((await a(`/api/users/${mgr.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await m('/api/me')).data.user, null);
});
