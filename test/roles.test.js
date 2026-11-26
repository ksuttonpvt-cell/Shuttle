process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@roles.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@roles.test', restart: () => {} });
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

test('one person, several roles: advisor who drives, BDC who drives, admin who drives', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@roles.test', password: 'adminpass1' } });
  const mk = async (name, email, roles, extra = {}) => a('/api/users', { body: { name, email, roles, password: 'password123', ...extra } });
  const signIn = async (email) => { const c = client(); const r = await c('/api/login', { body: { email, password: 'password123' } }); return [c, r.data.user]; };

  assert.equal((await mk('No Role', 'none@roles.test', [])).status, 400);
  assert.equal((await mk('Bad Role', 'bad@roles.test', ['pilot'])).status, 400);
  assert.equal((await a('/api/users', { body: { name: 'Old Way', email: 'old@roles.test', role: 'driver', password: 'password123' } })).status, 201, 'one role still works');

  // An advisor who also drives.
  const made = await mk('Ava Both', 'ava@roles.test', ['driver', 'advisor']);
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.user.role, made.data.user.roles, made.data.user.home], ['advisor', ['advisor', 'driver'], '/advisor']);
  const [ava, avaMe] = await signIn('ava@roles.test');
  assert.deepEqual(avaMe.can, ['advisor', 'driver']);
  assert.equal((await ava('/api/route')).status, 200, 'driver pages work');
  assert.equal((await ava('/api/offers/mine')).status, 200);
  const v = (await a('/api/vehicles', { body: { name: 'Shuttle 9', seats: 6, use: 'shuttle' } })).data.vehicle;
  assert.equal((await ava('/api/driver/shift', { body: { on_duty: true, vehicle_id: v.id } })).status, 200, 'can start a shift');
  const drivers = (await a('/api/drivers')).data.drivers;
  assert.ok(drivers.some((d) => d.id === avaMe.id && d.on_duty), 'shows as a driver on shift');
  assert.ok((await a('/api/advisors')).data.advisors.some((x) => x.id === avaMe.id), 'and as a service advisor');
  // Book as an advisor, then take it as the driver.
  const ride = (await ava('/api/rides', { body: { type: 'pickup', customer_name: 'Kai Rider', address: '1 Main St', lat: 40.01, lng: -105.27, scheduled_at: new Date(Date.now() + 3600000).toISOString(), passengers: 1 } })).data.ride;
  assert.equal(ride.advisor_id, avaMe.id);
  const took = await ava(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: avaMe.id } });
  assert.equal(took.status, 200); assert.equal(took.data.ride.driver_id, avaMe.id);
  assert.ok((await ava('/api/rides?scope=open&mine=driver')).data.rides.some((r) => r.id === ride.id));
  assert.ok((await ava('/api/rides?scope=open&mine=advisor')).data.rides.some((r) => r.id === ride.id));
  await ava('/api/driver/shift', { body: { on_duty: false } });

  // Opens to the driver page if the admin says so.
  const set = await a(`/api/users/${avaMe.id}`, { method: 'PATCH', body: { start_page: 'driver' } });
  assert.equal(set.data.user.home, '/driver');
  // Taking driving away.
  const less = await a(`/api/users/${avaMe.id}`, { method: 'PATCH', body: { roles: ['advisor'] } });
  assert.deepEqual([less.data.user.roles, less.data.user.home], [['advisor'], '/advisor']);
  assert.equal((await ava('/api/route')).status, 403);
  assert.ok(!(await a('/api/drivers')).data.drivers.some((d) => d.id === avaMe.id));

  // BDC who drives: still BDC (home, must pick an advisor), and a driver.
  const bd = (await mk('Bo Desk', 'bo@roles.test', ['bdc', 'driver'])).data.user;
  assert.deepEqual([bd.role, bd.team, bd.roles, bd.home], ['advisor', 'bdc', ['bdc', 'driver'], '/bdc']);
  assert.ok((await a('/api/drivers')).data.drivers.some((d) => d.id === bd.id));
  assert.ok(!(await a('/api/advisors')).data.advisors.some((x) => x.id === bd.id), 'BDC is not a service advisor');

  // A driver only can't use the advisor desk.
  const [dan] = await signIn((await mk('Dan Drive', 'dan@roles.test', ['driver'])).data.user.email);
  assert.equal((await dan('/api/rides', { body: { type: 'pickup', customer_name: 'X', address: 'y', scheduled_at: new Date().toISOString() } })).status, 403);

  // Admins who drive show up as drivers; you can't take away your own admin.
  const me = (await a('/api/me')).data.user;
  assert.equal((await a(`/api/users/${me.id}`, { method: 'PATCH', body: { roles: ['driver'] } })).status, 400);
  const adm = await a(`/api/users/${me.id}`, { method: 'PATCH', body: { roles: ['admin', 'driver'] } });
  assert.deepEqual([adm.data.user.role, adm.data.user.roles, adm.data.user.super_admin], ['admin', ['admin', 'driver'], true]);
  assert.ok((await a('/api/drivers')).data.drivers.some((d) => d.id === me.id));

  // Approving an account request with several roles.
  await client()('/api/signup', { body: { name: 'New Person', email: 'new@roles.test', role: 'driver', password: 'mypassword1' } });
  const req = (await a('/api/users')).data.users.find((u) => u.email === 'new@roles.test');
  const ok = await a(`/api/users/${req.id}/approve`, { body: { roles: ['advisor', 'driver'] } });
  assert.deepEqual(ok.data.user.roles, ['advisor', 'driver']);
});

test('first and last name: adding, editing and asking for an account', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@roles.test', password: 'adminpass1' } });
  assert.equal((await a('/api/users', { body: { first_name: 'Ana', last_name: '', email: 'ana@roles.test', roles: ['driver'], password: 'password123' } })).status, 400, 'last name needed');
  const made = await a('/api/users', { body: { first_name: ' Mary  Ann ', last_name: 'Lee', email: 'mary@roles.test', roles: ['driver'], password: 'password123' } });
  assert.equal(made.status, 201); assert.equal(made.data.user.name, 'Mary Ann Lee');
  const ed = await a(`/api/users/${made.data.user.id}`, { method: 'PATCH', body: { first_name: 'Mary', last_name: 'Lee-Park' } });
  assert.equal(ed.data.user.name, 'Mary Lee-Park');
  assert.equal((await a(`/api/users/${made.data.user.id}`, { method: 'PATCH', body: { first_name: 'Mary', last_name: ' ' } })).status, 400);
  assert.equal((await client()('/api/signup', { body: { first_name: 'New', last_name: 'Hire', email: 'hire@roles.test', role: 'driver', password: 'mypassword1' } })).status, 200);
  assert.ok((await a('/api/users')).data.users.some((u) => u.name === 'New Hire'));
  assert.equal((await client()('/api/signup', { body: { first_name: 'Solo', email: 'solo@roles.test', role: 'driver', password: 'mypassword1' } })).status, 400);
});

test('a manager on shift drives like a driver: takes rides, shows up for the desk, can be given rides', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@roles.test', password: 'adminpass1' } });
  await a('/api/users', { body: { name: 'Mo Manager', email: 'mo@roles.test', roles: ['admin'], password: 'password123' } });
  await a('/api/users', { body: { name: 'Ada Advisor', email: 'ada@roles.test', roles: ['advisor'], password: 'password123' } });
  const van = (await a('/api/vehicles', { body: { name: 'Manager Van', seats: 7 } })).data.vehicle;
  const mo = client(); const me = (await mo('/api/login', { body: { email: 'mo@roles.test', password: 'password123' } })).data.user;
  const ada = client(); await ada('/api/login', { body: { email: 'ada@roles.test', password: 'password123' } });
  const book = async (name) => (await ada('/api/rides', { body: { type: 'pickup', customer_name: name, address: '1 Main', scheduled_at: new Date(Date.now() + 30 * 60000).toISOString(), lat: 40.01, lng: -105.27 } })).data.ride;

  // Off shift, a manager isn't one of the drivers.
  let drivers = (await ada('/api/drivers')).data.drivers;
  assert.ok(!drivers.some((d) => d.id === me.id));
  assert.equal((await mo('/api/driver/shift', { body: { on_duty: true, vehicle_id: van.id } })).status, 200);
  drivers = (await ada('/api/drivers')).data.drivers;
  assert.ok(drivers.some((d) => d.id === me.id && d.on_duty), 'on shift: listed as a driver');

  // Takes a ride and runs it, like the driver app does.
  const r1 = await book('Riley Rider');
  let r = await mo(`/api/rides/${r1.id}`, { method: 'PATCH', body: { driver_id: me.id } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ride.driver_id, me.id);
  for (const status of ['en_route', 'onboard', 'completed']) assert.equal((await mo(`/api/rides/${r1.id}`, { method: 'PATCH', body: { status } })).status, 200, status);
  // The desk can give the manager a ride.
  const r2 = await book('Morgan Lee');
  r = await ada(`/api/rides/${r2.id}`, { method: 'PATCH', body: { driver_id: me.id } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Off shift again: no longer a driver to give rides to.
  await mo(`/api/rides/${r2.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Duplicate ride' } });
  await mo('/api/driver/shift', { body: { on_duty: false } });
  const r3 = await book('Sam Ortiz');
  assert.equal((await ada(`/api/rides/${r3.id}`, { method: 'PATCH', body: { driver_id: me.id } })).status, 400);
});
