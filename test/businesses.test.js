process.removeAllListeners('warning');
// Many businesses on one PC: each gets its own separate space, and the shared Turas Lúbtha
// sign-in takes each person straight to their own business.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { seedTestSite } = require('./helpers');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createBus } = require('../src/cluster');
const { createSite, routeOf } = require('../src/frontdoor');
const { checkName, suggestName } = require('../src/businesses');

let server; let port; let site; let dataDir; let homeDb;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-biz-'));
  homeDb = seedTestSite(openDb(path.join(dataDir, 'shuttle.db')));
  ensureAdmin(homeDb, { email: 'boss@home.test', password: 'home-pass-1', name: 'Home Boss' });
  site = createSite({
    db: homeDb, dataDir, domain: 'turaslubtha.com', bus: createBus(), openDb, createApp,
    homeOpts: { noTimers: true, superEmail: 'boss@home.test', publicUrl: 'https://shuttle.test' },
    businessOpts: () => ({ noTimers: true }),
    homeUrl: () => 'https://shuttle.test',
  });
  await new Promise((r) => { server = http.createServer(site.handler).listen(0, r); });
  port = server.address().port;
});
after(() => { server.close(); site.businesses.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// fetch() won't send a made-up Host header, so ask with http.request.
function call(host, p, { body, cookie, method } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || (data ? 'POST' : 'GET'),
      headers: { Host: host.includes(':') || host.includes('.test') ? host : `${host}:${port}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* page */ }
        const sid = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=') && c.length > 4);
        resolve({ status: res.statusCode, data: json, text, location: res.headers.location, cookie: sid });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const HOME = 'shuttle.test';
const signIn = async (host, email, password) => (await call(host, '/api/login', { body: { email, password } })).cookie;
const SETUP = { business_type: 'shuttle', dealer_phone: '(970) 555-0100', place_word: 'dealership', dealer_address: '1 Main St, Loveland, CO', dealer_lat: 40.39, dealer_lng: -105.07, timezone: 'America/Denver', brand_color: '#6d28d9', brand_dark: '#1e1b4b' };

test('web address names: the rules and the suggestion', () => {
  assert.equal(suggestName('Pine Valley Auto & Tire'), 'pinevalleyautoandtire');
  assert.equal(checkName('pine-valley').slug, 'pine-valley');
  for (const bad of ['', 'a', '-pine', 'pine-', 'pine valley', 'pine.valley', 'app', 'www', 'website', 'x'.repeat(33)]) assert.ok(checkName(bad).error, bad);
  assert.deepEqual(routeOf('app.turaslubtha.com', 'turaslubtha.com'), { front: true });
  assert.deepEqual(routeOf('pinevalley.turaslubtha.com', 'turaslubtha.com'), { slug: 'pinevalley' });
  assert.deepEqual(routeOf('www.turaslubtha.com', 'turaslubtha.com'), { home: true });
  assert.deepEqual(routeOf('turaslubtha.com', 'turaslubtha.com'), { home: true });
  assert.deepEqual(routeOf('corwinshuttleservice.com', 'turaslubtha.com'), { home: true });
  assert.deepEqual(routeOf('a.b.turaslubtha.com', 'turaslubtha.com'), { home: true });
});

test('a super admin adds a business: it gets its own empty space and a one-time setup link', async () => {
  const boss = await signIn(HOME, 'boss@home.test', 'home-pass-1');
  assert.ok(boss);
  // Only super admins (the Server page) can add businesses.
  assert.equal((await call(HOME, '/api/server/businesses', { body: { name: 'X', slug: 'xx' } })).status, 401);
  const made = await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Pine Valley Auto', slug: 'PineValley' } });
  assert.equal(made.status, 201, made.text);
  const b = made.data.business;
  assert.equal(b.slug, 'pinevalley');
  assert.equal(b.setup_done, false);
  assert.equal(b.url, 'https://pinevalley.turaslubtha.com');
  assert.match(b.setup_url, /^https:\/\/pinevalley\.turaslubtha\.com\/setup\?code=[A-Z0-9x]{4}-[A-Z0-9x]{4}$/i);
  assert.ok(fs.existsSync(path.join(dataDir, 'businesses', 'pinevalley', 'shuttle.db')), 'its own database file');
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Again', slug: 'pinevalley' } })).status, 400, 'taken');
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Front', slug: 'app' } })).status, 400, 'reserved');
  const list = (await call(HOME, '/api/server/businesses', { cookie: boss })).data;
  assert.equal(list.available, true);
  assert.deepEqual(list.businesses.map((x) => [x.slug, x.name]), [['pinevalley', 'Pine Valley Auto']]);

  // Its owner opens the setup link: a brand-new site, with the name filled in.
  const host = 'pinevalley.localhost';
  assert.equal((await call(host, '/')).location, '/setup');
  const info = (await call(host, '/api/setup')).data;
  assert.deepEqual([info.done, info.need_admin, info.values.dealer_name], [false, true, 'Pine Valley Auto']);
  const code = new URL(b.setup_url).searchParams.get('code');
  const admin = { first_name: 'Pat', last_name: 'Owner', email: 'pat@pinevalley.test', password: 'pine-pass-1' };
  const done = await call(host, '/api/setup', { body: { ...SETUP, dealer_name: 'Pine Valley Auto', code, admin } });
  assert.equal(done.status, 200, done.text);
  const me = (await call(host, '/api/me', { cookie: done.cookie })).data.user;
  assert.deepEqual([me.email, me.role, me.super_admin], ['pat@pinevalley.test', 'admin', false], 'a business owner is an admin, never a super admin');
  // The Server page runs the whole PC, so a hosted business can't open it.
  assert.equal((await call(host, '/api/server/status', { cookie: done.cookie })).status, 403);
  assert.equal((await call(host, '/api/server/businesses', { cookie: done.cookie })).status, 403);
  const after = (await call(HOME, '/api/server/businesses', { cookie: boss })).data.businesses[0];
  assert.deepEqual([after.setup_done, after.setup_url, after.staff], [true, '', 1]);
});

test('each business is separate: accounts and data never cross over', async () => {
  const host = 'pinevalley.localhost';
  // The home shuttle's boss can't sign in at Pine Valley, and Pine Valley's owner can't sign in at home.
  assert.equal((await call(host, '/api/login', { body: { email: 'boss@home.test', password: 'home-pass-1' } })).status, 401);
  assert.equal((await call(HOME, '/api/login', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } })).status, 401);
  const pat = await signIn(host, 'pat@pinevalley.test', 'pine-pass-1');
  const boss = await signIn(HOME, 'boss@home.test', 'home-pass-1');
  // A sign-in from one business means nothing at another.
  assert.equal((await call(HOME, '/api/me', { cookie: pat })).data.user, null);
  assert.equal((await call(host, '/api/me', { cookie: boss })).data.user, null);
  assert.equal((await call(HOME, '/api/users', { cookie: pat })).status, 401);
  const staffAt = async (h, c) => (await call(h, '/api/users', { cookie: c })).data.users.map((u) => u.email).sort();
  assert.deepEqual(await staffAt(host, pat), ['pat@pinevalley.test']);
  assert.ok(!(await staffAt(HOME, boss)).includes('pat@pinevalley.test'));
  // Settings are its own too.
  assert.equal(site.businesses.load('pinevalley').db.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Pine Valley Auto');
  assert.equal(homeDb.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Corwin Toyota of Boulder');
});

test('the shared sign-in takes you straight into your own business, once', async () => {
  const front = 'app.localhost';
  const page = await call(front, '/');
  assert.equal(page.status, 200, 'the sign-in page');
  assert.match(page.text, /api\/frontdoor\/signin/);
  assert.match(page.text, /href="http:\/\/website\.localhost:\d+\/#demo"/, 'website links go to the website');
  const r = await call(front, '/api/frontdoor/signin', { body: { email: 'PAT@pinevalley.test', password: 'pine-pass-1' } });
  assert.equal(r.status, 200, r.text);
  const go = new URL(r.data.go);
  assert.equal(go.host, `pinevalley.localhost:${port}`);
  assert.equal(go.pathname, '/auth/handoff');
  // The pass only works at Pine Valley…
  const elsewhere = await call(HOME, `/auth/handoff${go.search}`);
  assert.equal(elsewhere.location, '/login?expired=1');
  assert.equal(elsewhere.cookie, undefined);
  // …and the wrong-place try used it up, so ask again.
  const r2 = await call(front, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  const go2 = new URL(r2.data.go);
  const landed = await call('pinevalley.localhost', `/auth/handoff${go2.search}`);
  assert.equal(landed.location, '/');
  assert.ok(landed.cookie, 'signed in');
  assert.equal((await call('pinevalley.localhost', '/api/me', { cookie: landed.cookie })).data.user.email, 'pat@pinevalley.test');
  // Used once only.
  assert.equal((await call('pinevalley.localhost', `/auth/handoff${go2.search}`)).location, '/login?expired=1');
  // The home shuttle's people are sent to the home address.
  const home = await call(front, '/api/frontdoor/signin', { body: { email: 'boss@home.test', password: 'home-pass-1' } });
  assert.match(home.data.go, /^https:\/\/shuttle\.test\/auth\/handoff\?t=/);
  // The form also works from the website's own Sign in page (any address).
  assert.equal((await call('turaslubtha.com', '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } })).status, 200);
});

test('the shared sign-in never says which emails or businesses exist', async () => {
  const front = 'app.localhost';
  const wrongPw = await call(front, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'nope-nope-1' } });
  const noEmail = await call(front, '/api/frontdoor/signin', { body: { email: 'nobody@nowhere.test', password: 'nope-nope-1' } });
  assert.deepEqual([wrongPw.status, noEmail.status], [401, 401]);
  assert.equal(wrongPw.data.error, noEmail.data.error);
  assert.equal((await call(front, '/api/frontdoor/signin', { body: { email: 'x@y.test' } })).status, 400);
  // Too many wrong tries for one email.
  for (let i = 0; i < 10; i++) await call(front, '/api/frontdoor/signin', { body: { email: 'guess@me.test', password: `wrong-${i}-pass` } });
  assert.equal((await call(front, '/api/frontdoor/signin', { body: { email: 'guess@me.test', password: 'wrong-x-pass' } })).status, 429);
});

test('someone at two businesses picks which one', async () => {
  const boss = await signIn(HOME, 'boss@home.test', 'home-pass-1');
  const made = await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Lakeside Hotel', slug: 'lakeside' } });
  const code = new URL(made.data.business.setup_url).searchParams.get('code');
  const admin = { first_name: 'Pat', last_name: 'Owner', email: 'pat@pinevalley.test', password: 'pine-pass-1' }; // same person, same password
  assert.equal((await call('lakeside.localhost', '/api/setup', { body: { ...SETUP, dealer_name: 'Lakeside Hotel', code, admin } })).status, 200);
  const r = await call('app.localhost', '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.choose.map((c) => c.name).sort(), ['Lakeside Hotel', 'Pine Valley Auto']);
  for (const c of r.data.choose) assert.match(c.url, /^http:\/\/(pinevalley|lakeside)\.localhost:\d+\/auth\/handoff\?t=/);
});

test('a paused business is closed until it is turned back on; unknown addresses say so', async () => {
  const boss = await signIn(HOME, 'boss@home.test', 'home-pass-1');
  const p = await call(HOME, '/api/server/businesses/lakeside/pause', { cookie: boss, body: { paused: true } });
  assert.equal(p.data.business.paused, true);
  const closed = await call('lakeside.localhost', '/login');
  assert.equal(closed.status, 503);
  assert.match(closed.text, /paused/i);
  // Pat can still get into Pine Valley; only the paused one drops out of the choice.
  const r = await call('app.localhost', '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  assert.match(r.data.go, /pinevalley\.localhost/);
  await call(HOME, '/api/server/businesses/lakeside/pause', { cookie: boss, body: { paused: false } });
  assert.equal((await call('lakeside.localhost', '/login')).status, 200);
  const none = await call('nobody.localhost', '/');
  assert.equal(none.status, 404);
  assert.match(none.text, /no business at this address/i);
  // The home shuttle and the website carry on as before.
  assert.equal((await call(HOME, '/login')).status, 200);
  assert.match((await call('turaslubtha.com', '/')).text, /Run your customer shuttle from/);
});
