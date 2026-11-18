process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'ann@perf.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'ann@perf.test', restart: () => {} });
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

test('page speed reports: stored without names or links, summed up for admins', async () => {
  const a = client();
  await a('/api/login', { body: { email: 'ann@perf.test', password: 'adminpass1' } });
  const fast = { page: '/advisor', type: 'navigate', proto: 'h2', dns: 20, connect: 60, tls: 40, wait: 150, download: 10, build: 80, ready: 600, data: 900, tiles: 1200, tiles_n: 12, net: '4g', device: 'phone' };
  for (let i = 0; i < 8; i++) assert.equal((await a('/api/perf', { body: fast })).status, 204);
  // A slow one where the address lookup took most of the time, from a customer's tracking link.
  const anon = client();
  await anon('/api/perf', { body: { ...fast, page: '/t/SECRETTOKEN123', dns: 48000, ready: 51000, device: 'phone' } });
  // Junk is ignored.
  await anon('/api/perf', { body: { page: '/nope', ready: 5 } });
  await anon('/api/perf', { body: { page: '/login', ready: 'x' } });
  await anon('/api/perf', { body: { page: '/login', ready: 400, proto: '<script>', device: 'toaster', dns: -5, wait: 1e12 } });

  const d = (await a('/api/server/perf?days=1')).data;
  assert.equal(d.count, 10);
  assert.equal(d.slow_count, 1);
  assert.equal(d.slow[0].page, '/t', 'the tracking link is shortened');
  assert.equal(d.slow[0].role, 'customer');
  assert.equal(d.slow[0].biggest.part, 'dns');
  assert.deepEqual(d.blame, { dns: 1 });
  assert.equal(d.parts.ready.median, 600);
  assert.ok(!JSON.stringify(d).includes('SECRETTOKEN'), 'tracking links are never stored');
  const odd = d.pages.find((p) => p.page === '/login');
  assert.equal(odd.count, 1);
  const raw = d.slow.concat(d.pages);
  assert.ok(!JSON.stringify(raw).includes('<script>'));

  // Only admins (super admins) can read them.
  await a('/api/users', { body: { name: 'Dee', email: 'dee@perf.test', role: 'driver', password: 'driverpass1' } });
  const dr = client(); await dr('/api/login', { body: { email: 'dee@perf.test', password: 'driverpass1' } });
  assert.equal((await dr('/api/server/perf')).status, 403);
  assert.equal((await anon('/api/server/perf')).status, 401);
});

test('pages: file stamps follow the file contents, with early hints for maps and fonts', async () => {
  const r = await fetch(`${base}/advisor`, { redirect: 'manual' });
  // advisor needs a sign-in, so use the public request page (has a map) and the sign-in page
  const req = await (await fetch(`${base}/request`)).text();
  const login = await (await fetch(`${base}/login`)).text();
  void r;
  const stamp = (html, f) => (html.match(new RegExp(`${f.replace(/[.]/g, '\\.')}\\?v=([0-9a-f]+)`)) || [])[1];
  const crypto = require('node:crypto');
  const want = crypto.createHash('sha1').update(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'common.js'))).digest('hex').slice(0, 10);
  assert.equal(stamp(req, '/js/common.js'), want, 'stamp is the file contents');
  assert.equal(stamp(login, '/js/common.js'), want, 'same file, same stamp on every page');
  assert.ok(stamp(req, '/vendor/leaflet/leaflet.js'));
  assert.match(req, /rel="preconnect" href="https:\/\/tile\.openstreetmap\.org"/);
  assert.doesNotMatch(login, /tile\.openstreetmap/, 'no map, no map hint');
  assert.match(login, /rel="preload" href="\/vendor\/fonts\/barlow\/barlow-latin-700-normal\.woff2" as="font"/);
});

test('the background helper (sw.js) is never stored, carries its version, and never keeps live data', async () => {
  const r = await fetch(`${base}/sw.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const js = await r.text();
  assert.match(js, /const VERSION = '[0-9a-f]{10}'/);
  assert.doesNotMatch(js, /__VERSION__/);
  // Only screens, files and map images are kept: API answers always go to the server.
  assert.match(js, /everything else \(rides, tracking, sign-in…\) always goes to the server/);
  assert.doesNotMatch(js, /\/api\/.*caches\.open/);
});
