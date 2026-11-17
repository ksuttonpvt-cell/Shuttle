process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@bdc.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@bdc.test', restart: () => {} });
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

test('BDC team: their own page, booking, and finding a customer by name, phone or RO', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@bdc.test', password: 'adminpass1' } });
  const made = await a('/api/users', { body: { name: 'Bea Caller', email: 'bea@bdc.test', role: 'bdc', password: 'bdcpass123' } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.user.role, made.data.user.team, made.data.user.home], ['advisor', 'bdc', '/bdc'], 'a BDC person is an advisor on the BDC team');
  const b = client();
  const login = await b('/api/login', { body: { email: 'bea@bdc.test', password: 'bdcpass123' } });
  assert.equal(login.data.user.home, '/bdc');
  const home = await fetch(`${base}/`, { headers: { Cookie: (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bea@bdc.test', password: 'bdcpass123' }) })).headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
  assert.equal(home.headers.get('location'), '/bdc', 'signing in lands on the BDC page');
  assert.equal((await fetch(`${base}/bdc`)).status, 200);

  // Book rides: today, and for an appointment next week.
  const soon = (min) => new Date(Date.now() + min * 60000).toISOString();
  const ride = (name, phone, when, extra = {}) => b('/api/rides', { body: { type: 'pickup', customer_name: name, customer_phone: phone, address: '1 Main St', lat: 40.01, lng: -105.27, scheduled_at: when, passengers: 1, ...extra } });
  assert.equal((await ride('Maria Lopez', '(303) 555-0142', soon(45), { ro_number: 'RO-88123' })).status, 201);
  assert.equal((await ride('Dan Brooks', '720.555.0199', soon(7 * 24 * 60))).status, 201);

  // Find them while they're on the phone.
  const find = async (q) => (await b(`/api/rides?scope=search&q=${encodeURIComponent(q)}`)).data.rides.map((r) => r.customer_name);
  assert.deepEqual(await find('maria'), ['Maria Lopez'], 'by name');
  assert.deepEqual(await find('3035550142'), ['Maria Lopez'], 'by phone digits, whatever the format');
  assert.deepEqual(await find('555-0199'), ['Dan Brooks']);
  assert.deepEqual(await find('88123'), ['Maria Lopez'], 'by RO number');
  assert.deepEqual(await find('x'), [], 'too short');
  assert.deepEqual(await find('%'), [], 'wildcards are just text');

  // Today / booked ahead / finished.
  const upcoming = (await b('/api/rides?scope=upcoming')).data.rides.map((r) => r.customer_name);
  assert.deepEqual(upcoming, ['Dan Brooks']);
  const maria = (await b('/api/rides?scope=search&q=maria')).data.rides[0];
  await b(`/api/rides/${maria.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: 'Customer called to cancel' } });
  assert.deepEqual((await b('/api/rides?scope=recent')).data.rides.map((r) => r.customer_name), ['Maria Lopez']);

  // Asking for an account as BDC, and approving as BDC.
  await client()('/api/signup', { body: { name: 'New Caller', email: 'new@bdc.test', role: 'bdc', password: 'mypassword1' } });
  const req = (await a('/api/users')).data.users.find((u) => u.email === 'new@bdc.test');
  assert.equal(req.team, 'bdc');
  const ok = await a(`/api/users/${req.id}/approve`, { body: {} });
  assert.deepEqual([ok.data.user.role, ok.data.user.team], ['advisor', 'bdc'], 'kept as BDC');
  // Moving someone off the BDC team.
  const moved = await a(`/api/users/${made.data.user.id}`, { method: 'PATCH', body: { role: 'advisor' } });
  assert.deepEqual([moved.data.user.team, moved.data.user.home], [null, '/advisor']);
});
