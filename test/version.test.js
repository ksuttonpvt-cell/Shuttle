process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
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

const pkg = require('../package.json');
const changelog = require('../changelog.json');

test('admins see the version and what changed; others do not', async () => {
  const ken = client();
  const me = await ken('/api/login', { body: { email: 'ken@test.local', password: 'adminpass1' } });
  assert.equal(me.status, 200);
  assert.equal((await ken('/api/me')).data.version, pkg.version);
  const about = (await ken('/api/about')).data;
  assert.equal(about.version, pkg.version);
  assert.equal(about.changelog[0].version, pkg.version, 'the newest changelog entry matches package.json');
  assert.ok(about.changelog.every((e) => e.title && e.changes.length), 'every entry has a title and changes');

  await ken('/api/users', { body: { name: 'Dee', email: 'dee@test.local', role: 'driver', password: 'driverpass1' } });
  const d = client();
  await d('/api/login', { body: { email: 'dee@test.local', password: 'driverpass1' } });
  assert.equal((await d('/api/me')).data.version, undefined);
  assert.equal((await d('/api/about')).status, 403);
  assert.equal((await client()('/api/about')).status, 401);
});

test('changelog versions are unique and newest first', () => {
  const vs = changelog.map((e) => e.version);
  assert.equal(new Set(vs).size, vs.length);
  const n = (v) => v.split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
  for (let i = 1; i < vs.length; i++) assert.ok(n(vs[i - 1]) > n(vs[i]), `${vs[i - 1]} before ${vs[i]}`);
});
