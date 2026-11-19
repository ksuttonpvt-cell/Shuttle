process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
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

  // Book rides: today, and for an appointment next week, for a service advisor.
  const adv = (await a('/api/users', { body: { name: 'Sam Advisor', email: 'sam@bdc.test', role: 'advisor', password: 'advpass123' } })).data.user;
  const soon = (min) => new Date(Date.now() + min * 60000).toISOString();
  const ride = (name, phone, when, extra = {}) => b('/api/rides', { body: { type: 'pickup', customer_name: name, customer_phone: phone, address: '1 Main St', lat: 40.01, lng: -105.27, scheduled_at: when, passengers: 1, advisor_id: adv.id, ...extra } });
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
  const day = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(ms));
  const mariaTomorrow = day(Date.now() + 45 * 60000) !== day(Date.now()); // after about 11 PM, it's tomorrow's ride
  assert.deepEqual(upcoming, mariaTomorrow ? ['Maria Lopez', 'Dan Brooks'] : ['Dan Brooks']);
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

test('BDC picks the service advisor; the advisor is told and sees it as theirs', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@bdc.test', password: 'adminpass1' } });
  const mk = async (name, email, role) => (await a('/api/users', { body: { name, email, role, password: 'password123' } })).data.user;
  const bdc = await mk('Cal Desk', 'cal@bdc.test', 'bdc');
  const kim = await mk('Kim Service', 'kim@bdc.test', 'advisor');
  const lee = await mk('Lee Service', 'lee@bdc.test', 'advisor');
  const b = client(); await b('/api/login', { body: { email: 'cal@bdc.test', password: 'password123' } });
  const k = client(); await k('/api/login', { body: { email: 'kim@bdc.test', password: 'password123' } });

  // The list has service advisors only: not the BDC team.
  const list = (await b('/api/advisors')).data.advisors;
  assert.ok(list.some((x) => x.id === kim.id) && list.some((x) => x.id === lee.id));
  assert.ok(!list.some((x) => x.id === bdc.id), 'BDC people are not advisors to pick');

  // Kim's desk is open: listen for the "for you" pop-up.
  const ctrl = new AbortController();
  const cookieK = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kim@bdc.test', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const es = await fetch(`${base}/api/events`, { headers: { Cookie: cookieK }, signal: ctrl.signal });
  const reader = es.body.getReader(); let got = '';
  const heard = (async () => { const dec = new TextDecoder(); while (!got.includes('event: foryou')) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value); } })().catch(() => {});

  const body = { type: 'dropoff', customer_name: 'Pat Caller', customer_phone: '303-555-0100', address: '2 Pine St', lat: 40.02, lng: -105.25, scheduled_at: new Date(Date.now() + 3600000).toISOString(), passengers: 1 };
  assert.equal((await b('/api/rides', { body })).status, 400, 'BDC must pick an advisor');
  assert.equal((await b('/api/rides', { body: { ...body, advisor_id: bdc.id } })).status, 400, 'not a BDC person');
  assert.equal((await b('/api/rides', { body: { ...body, advisor_id: 99999 } })).status, 400);
  const made = await b('/api/rides', { body: { ...body, advisor_id: kim.id } });
  assert.equal(made.status, 201);
  const r = made.data.ride;
  assert.equal(r.advisor_id, kim.id);
  assert.equal(r.advisor_name, 'Kim Service');
  assert.equal(r.booked_by, bdc.id);
  assert.deepEqual([r.booked_by_name, r.booked_by_team], ['Cal Desk', 'bdc']);

  await Promise.race([heard, new Promise((res) => setTimeout(res, 3000))]);
  ctrl.abort();
  assert.match(got, /event: foryou/, 'the advisor desk heard about it');
  assert.match(got, /Cal \(BDC\) booked a drop off for you/);

  // It's under "My customers only" for Kim.
  const mine = (await k('/api/rides?scope=open&mine=1')).data.rides.map((x) => x.id);
  assert.ok(mine.includes(r.id));

  // BDC moves it to Lee from Edit.
  const moved = await b(`/api/rides/${r.id}`, { method: 'PATCH', body: { advisor_id: lee.id } });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.ride.advisor_id, lee.id);
  assert.equal((await b(`/api/rides/${r.id}`, { method: 'PATCH', body: { advisor_id: bdc.id } })).status, 400);
  assert.ok(!(await k('/api/rides?scope=open&mine=1')).data.rides.some((x) => x.id === r.id));

  // A service advisor booking for themselves: no booked-by line.
  const own = await k('/api/rides', { body });
  assert.equal(own.status, 201);
  assert.deepEqual([own.data.ride.advisor_id, own.data.ride.booked_by], [kim.id, null]);
});
