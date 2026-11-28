process.removeAllListeners('warning');
// Many businesses on one PC, each at its own path: turaslubtha.com/pinevalley. Each gets its own
// separate space, and the shared Turas Lúbtha sign-in takes each person straight to their own.
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
const { rewrite } = require('../src/pathmount');

const SITE = 'turaslubtha.com';
const HOME = 'shuttle.test'; // the PC's shuttle at its old address

let server; let port; let site; let dataDir; let homeDb;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-biz-'));
  homeDb = seedTestSite(openDb(path.join(dataDir, 'shuttle.db')));
  ensureAdmin(homeDb, { email: 'boss@home.test', password: 'home-pass-1', name: 'Home Boss' });
  site = createSite({
    db: homeDb, dataDir, domain: SITE, bus: createBus(), openDb, createApp,
    homeOpts: { noTimers: true, superEmail: 'boss@home.test', publicUrl: 'https://shuttle.test' },
    businessOpts: () => ({ noTimers: true }),
    homeUrl: () => 'https://shuttle.test',
  });
  await new Promise((r) => { server = http.createServer(site.handler).listen(0, r); });
  port = server.address().port;
});
after(() => { server.close(); site.businesses.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// fetch() won't send a made-up Host header, so ask with http.request. Visitors come over https.
function call(host, p, { body, cookie, method } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || (data ? 'POST' : 'GET'),
      headers: { Host: host, 'CF-Visitor': '{"scheme":"https"}', ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* page */ }
        const raw = (res.headers['set-cookie'] || []).find((c) => /^sid=[^;]+/.test(c));
        resolve({ status: res.statusCode, data: json, text, location: res.headers.location, cookie: raw && raw.split(';')[0], rawCookie: raw, headers: res.headers });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const signIn = async (host, prefix, email, password) => (await call(host, `${prefix}/api/login`, { body: { email, password } })).cookie;
const SETUP = { business_type: 'shuttle', dealer_phone: '(970) 555-0100', place_word: 'dealership', dealer_address: '1 Main St, Loveland, CO', dealer_lat: 40.39, dealer_lng: -105.07, timezone: 'America/Denver', brand_color: '#6d28d9', brand_dark: '#1e1b4b' };

test('names: the rules, the suggestion, and website pages that can’t be taken', () => {
  assert.equal(suggestName('Pine Valley Auto & Tire'), 'pinevalleyautoandtire');
  assert.equal(checkName('pine-valley').slug, 'pine-valley');
  for (const bad of ['', 'a', '-pine', 'pine-', 'pine valley', 'pine.valley', 'app', 'www', 'website', 'signin', 'privacy', 'terms', 'css', 'img', 'x'.repeat(33)]) assert.ok(checkName(bad).error, bad);
  assert.deepEqual(routeOf('pinevalley.turaslubtha.com', SITE), { slug: 'pinevalley' }, 'name.turaslubtha.com still works too');
});

test('pages under a path keep every link, picture and request under that path', () => {
  const html = rewrite('<html><head><title>x</title></head><body><a href="/admin">A</a><img src="/brand/logo"><a href="https://x.test/y">B</a><a href="//cdn.test/z">C</a><form action="/api/login"></form><a href="/pv/driver">D</a></body></html>', '/pv', 'text/html');
  assert.match(html, /<head><script>\(function\(\)\{var B="\/pv"/, 'the helper script runs first');
  assert.match(html, /href="\/pv\/admin"/);
  assert.match(html, /src="\/pv\/brand\/logo"/);
  assert.match(html, /action="\/pv\/api\/login"/);
  assert.match(html, /href="https:\/\/x\.test\/y"/, 'other sites untouched');
  assert.match(html, /href="\/\/cdn\.test\/z"/);
  assert.match(html, /href="\/pv\/driver"/, 'never doubled');
  assert.equal(rewrite('a{background:url(/img/a.png)} b{src:url("/f.woff2")}', '/pv', 'text/css'), 'a{background:url(/pv/img/a.png)} b{src:url("/pv/f.woff2")}');
  assert.equal(rewrite('{"start_url": "/driver", "scope": "/", "icons": [{"src": "/i.png"}]}', '/pv', 'application/manifest+json'), '{"start_url": "/pv/driver", "scope": "/pv/", "icons": [{"src": "/pv/i.png"}]}');
});

test('a super admin adds a business: it gets its own empty space at turaslubtha.com/<name>', async () => {
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  assert.ok(boss);
  assert.equal((await call(HOME, '/api/server/businesses', { body: { name: 'X', slug: 'xx' } })).status, 401, 'only super admins');
  const made = await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Pine Valley Auto', slug: 'PineValley' } });
  assert.equal(made.status, 201, made.text);
  const b = made.data.business;
  assert.deepEqual([b.slug, b.url, b.setup_done], ['pinevalley', 'https://turaslubtha.com/pinevalley', false]);
  assert.match(b.setup_url, /^https:\/\/turaslubtha\.com\/pinevalley\/setup\?code=[A-Z0-9x]{4}-[A-Z0-9x]{4}$/i);
  assert.ok(fs.existsSync(path.join(dataDir, 'businesses', 'pinevalley', 'shuttle.db')), 'its own database file');
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Again', slug: 'pinevalley' } })).status, 400, 'taken');
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Page', slug: 'privacy' } })).status, 400, 'a website page');
  const list = (await call(HOME, '/api/server/businesses', { cookie: boss })).data;
  assert.equal(list.signin_url, 'https://turaslubtha.com/signin');
  assert.deepEqual(list.businesses.map((x) => [x.slug, x.name]), [['pinevalley', 'Pine Valley Auto']]);

  // Its owner opens the setup link: a brand-new site, with the name filled in.
  assert.equal((await call(SITE, '/pinevalley')).location, '/pinevalley/', 'adds the slash');
  assert.equal((await call(SITE, '/PineValley/login')).location, '/pinevalley/login', 'any capitals');
  assert.equal((await call(SITE, '/pinevalley/')).location, '/pinevalley/setup');
  const setupPage = await call(SITE, '/pinevalley/setup');
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.text, /var B="\/pinevalley"/);
  assert.match(setupPage.text, /src="\/pinevalley\/js\/common\.js/);
  assert.doesNotMatch(setupPage.text, /src="\/js\//, 'no link escapes the path');
  const info = (await call(SITE, '/pinevalley/api/setup')).data;
  assert.deepEqual([info.done, info.need_admin, info.values.dealer_name], [false, true, 'Pine Valley Auto']);
  const code = new URL(b.setup_url).searchParams.get('code');
  const admin = { first_name: 'Pat', last_name: 'Owner', email: 'pat@pinevalley.test', password: 'pine-pass-1' };
  const done = await call(SITE, '/pinevalley/api/setup', { body: { ...SETUP, dealer_name: 'Pine Valley Auto', code, admin } });
  assert.equal(done.status, 200, done.text);
  assert.match(done.rawCookie, /; Path=\/pinevalley(;|$)/, 'its sign-in stays with its own path');
  const me = (await call(SITE, '/pinevalley/api/me', { cookie: done.cookie })).data;
  assert.deepEqual([me.user.email, me.user.role, me.user.super_admin, me.user.owner], ['pat@pinevalley.test', 'admin', true, false], 'the person who sets up a business is its super admin, never the PC owner');
  assert.equal(me.base_url, 'https://turaslubtha.com/pinevalley', 'its links and QR codes use its path');
  assert.equal((await call(SITE, '/pinevalley/api/server/status', { cookie: done.cookie })).status, 403, 'no Server page');
  assert.equal((await call(SITE, '/pinevalley/api/site-url', { cookie: done.cookie })).status, 403, 'no web address setting');
  // Redirects stay inside the path: signed out, its front page goes to its own sign-in.
  assert.equal((await call(SITE, '/pinevalley/')).location, '/pinevalley/login');
  // The owner sees how many people the business has (counts only).
  const people = (await call(HOME, '/api/server/businesses', { cookie: boss })).data.businesses[0].people;
  assert.deepEqual([people.active, people.managers, people.drivers, people.rides_30d], [1, 1, 0, 0]);
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: boss })).data.home.people.managers, 1, 'and for this shuttle');
  const manifest = await call(SITE, '/pinevalley/manifest.webmanifest');
  assert.match(manifest.text, /"start_url"\s*:\s*"\/pinevalley\//);
});

test('each business is separate: accounts and data never cross over', async () => {
  assert.equal((await call(SITE, '/pinevalley/api/login', { body: { email: 'boss@home.test', password: 'home-pass-1' } })).status, 401);
  assert.equal((await call(HOME, '/api/login', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } })).status, 401);
  const pat = await signIn(SITE, '/pinevalley', 'pat@pinevalley.test', 'pine-pass-1');
  const boss = await signIn(SITE, '/shuttle', 'boss@home.test', 'home-pass-1');
  assert.equal((await call(SITE, '/shuttle/api/me', { cookie: pat })).data.user, null);
  assert.equal((await call(SITE, '/pinevalley/api/me', { cookie: boss })).data.user, null);
  const staffAt = async (p, c) => (await call(SITE, `${p}/api/users`, { cookie: c })).data.users.map((u) => u.email).sort();
  assert.deepEqual(await staffAt('/pinevalley', pat), ['pat@pinevalley.test']);
  assert.ok(!(await staffAt('/shuttle', boss)).includes('pat@pinevalley.test'));
  assert.equal(site.businesses.load('pinevalley').db.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Pine Valley Auto');
  assert.equal(homeDb.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Corwin Toyota of Boulder');
});

test('the shared sign-in takes you straight into your own business, once', async () => {
  const page = await call(SITE, '/signin');
  assert.equal(page.status, 200);
  assert.match(page.text, /api\/frontdoor\/signin/);
  const r = await call(SITE, '/api/frontdoor/signin', { body: { email: 'PAT@pinevalley.test', password: 'pine-pass-1' } });
  assert.equal(r.status, 200, r.text);
  const go = new URL(r.data.go);
  assert.equal(`${go.origin}${go.pathname}`, 'https://turaslubtha.com/pinevalley/auth/handoff');
  // The pass only works at Pine Valley…
  assert.equal((await call(SITE, `/shuttle/auth/handoff${go.search}`)).location, '/shuttle/login?expired=1');
  // …and that try used it up, so ask again.
  const r2 = await call(SITE, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  const go2 = new URL(r2.data.go);
  const landed = await call(SITE, `/pinevalley/auth/handoff${go2.search}`);
  assert.equal(landed.location, '/pinevalley/');
  assert.match(landed.rawCookie, /; Path=\/pinevalley(;|$)/);
  assert.equal((await call(SITE, '/pinevalley/api/me', { cookie: landed.cookie })).data.user.email, 'pat@pinevalley.test');
  assert.equal((await call(SITE, `/pinevalley/auth/handoff${go2.search}`)).location, '/pinevalley/login?expired=1', 'used once only');
  // This PC's own shuttle is at turaslubtha.com/shuttle.
  const home = await call(SITE, '/api/frontdoor/signin', { body: { email: 'boss@home.test', password: 'home-pass-1' } });
  assert.match(home.data.go, /^https:\/\/turaslubtha\.com\/shuttle\/auth\/handoff\?t=/);
  assert.equal((await call(SITE, `/shuttle/auth/handoff${new URL(home.data.go).search}`)).location, '/shuttle/');
});

test('the shared sign-in never says which emails or businesses exist', async () => {
  const wrongPw = await call(SITE, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'nope-nope-1' } });
  const noEmail = await call(SITE, '/api/frontdoor/signin', { body: { email: 'nobody@nowhere.test', password: 'nope-nope-1' } });
  assert.deepEqual([wrongPw.status, noEmail.status], [401, 401]);
  assert.equal(wrongPw.data.error, noEmail.data.error);
  assert.equal((await call(SITE, '/api/frontdoor/signin', { body: { email: 'x@y.test' } })).status, 400);
  for (let i = 0; i < 10; i++) await call(SITE, '/api/frontdoor/signin', { body: { email: 'guess@me.test', password: `wrong-${i}-pass` } });
  assert.equal((await call(SITE, '/api/frontdoor/signin', { body: { email: 'guess@me.test', password: 'wrong-x-pass' } })).status, 429);
});

test('someone at two businesses picks which one', async () => {
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  const made = await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Lakeside Hotel', slug: 'lakeside' } });
  const code = new URL(made.data.business.setup_url).searchParams.get('code');
  const admin = { first_name: 'Pat', last_name: 'Owner', email: 'pat@pinevalley.test', password: 'pine-pass-1' };
  assert.equal((await call(SITE, '/lakeside/api/setup', { body: { ...SETUP, dealer_name: 'Lakeside Hotel', code, admin } })).status, 200);
  const r = await call(SITE, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  assert.deepEqual(r.data.choose.map((c) => c.name).sort(), ['Lakeside Hotel', 'Pine Valley Auto']);
  for (const c of r.data.choose) assert.match(c.url, /^https:\/\/turaslubtha\.com\/(pinevalley|lakeside)\/auth\/handoff\?t=/);
});

test('a paused business is closed until it is turned back on; the website carries on', async () => {
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  assert.equal((await call(HOME, '/api/server/businesses/lakeside/pause', { cookie: boss, body: { paused: true } })).data.business.paused, true);
  const closed = await call(SITE, '/lakeside/login');
  assert.equal(closed.status, 503);
  assert.match(closed.text, /paused/i);
  const r = await call(SITE, '/api/frontdoor/signin', { body: { email: 'pat@pinevalley.test', password: 'pine-pass-1' } });
  assert.match(r.data.go, /\/pinevalley\//);
  await call(HOME, '/api/server/businesses/lakeside/pause', { cookie: boss, body: { paused: false } });
  assert.equal((await call(SITE, '/lakeside/login')).status, 200);
  // Anything else on turaslubtha.com is the website, as before.
  assert.match((await call(SITE, '/')).text, /Run your customer shuttle from/);
  assert.equal((await call(SITE, '/nobody/')).status, 404);
  assert.equal((await call(HOME, '/login')).status, 200, 'the old address still works');
});

test('this shuttle is at turaslubtha.com/shuttle, and can be renamed', async () => {
  assert.equal(site.businesses.getMeta('home_slug'), 'shuttle', 'the default name');
  const boss = await signIn(SITE, '/shuttle', 'boss@home.test', 'home-pass-1');
  assert.ok(boss, 'signs in at turaslubtha.com/shuttle');
  assert.equal((await call(SITE, '/shuttle/api/me', { cookie: boss })).data.base_url, 'https://turaslubtha.com/shuttle', 'links use the new address');
  for (const bad of ['pinevalley', 'app', 'signin', 'x']) assert.equal((await call(SITE, '/shuttle/api/server/businesses/home', { cookie: boss, body: { slug: bad } })).status, 400, bad);
  const set = await call(SITE, '/shuttle/api/server/businesses/home', { cookie: boss, body: { slug: 'Hometown' } });
  assert.deepEqual([set.data.home.slug, set.data.home.url], ['hometown', 'https://turaslubtha.com/hometown']);
  assert.equal((await call(SITE, '/hometown/login')).status, 200);
  assert.equal((await call(SITE, '/shuttle/login')).status, 404, 'the old name is free again');
  assert.equal((await call(HOME, '/api/server/businesses', { cookie: await signIn(HOME, '', 'boss@home.test', 'home-pass-1'), body: { name: 'Copycat', slug: 'hometown' } })).status, 400);
  // New links and QR codes: switch to the new address, and back.
  const boss2 = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  assert.equal((await call(HOME, '/api/server/businesses/home/links', { cookie: boss2, body: { use: true } })).data.home.links_use_it, true);
  assert.equal(homeDb.prepare("SELECT value FROM settings WHERE key = 'site_url'").get().value, 'https://turaslubtha.com/hometown');
  await call(HOME, '/api/server/businesses/home/links', { cookie: boss2, body: { use: false } });
  assert.equal(homeDb.prepare("SELECT value FROM settings WHERE key = 'site_url'").get().value, 'https://shuttle.test');
  const pat = await signIn(SITE, '/pinevalley', 'pat@pinevalley.test', 'pine-pass-1');
  assert.equal((await call(SITE, '/pinevalley/api/server/businesses/home', { cookie: pat, body: { slug: 'mine' } })).status, 403);
});

test('“Book a demo” on the website: saved for super admins, safe from robots', async () => {
  const page = await call(SITE, '/demo');
  assert.equal(page.status, 200);
  assert.match(page.text, /api\/frontdoor\/demo/);
  assert.match((await call(SITE, '/')).text, /href="demo\.html"/, 'the home page links to it');
  const good = { name: 'Riley Buyer', business: 'Lakeview Motors', email: 'riley@lakeview.test', phone: '(555) 010-2000', kind: 'dealership', vans: '2-3', best_time: 'mornings', message: 'Two vans, busy Mondays.' };
  assert.equal((await call(SITE, '/api/frontdoor/demo', { body: { ...good, email: 'nope' } })).status, 400);
  assert.equal((await call(SITE, '/api/frontdoor/demo', { body: { ...good, business: '' } })).status, 400);
  const ok = await call(SITE, '/api/frontdoor/demo', { body: { ...good, kind: 'spaceship', vans: '99' } });
  assert.deepEqual([ok.status, ok.data], [200, { ok: true }]);
  // A robot that fills the hidden field is told "thanks" but nothing is saved.
  assert.equal((await call(SITE, '/api/frontdoor/demo', { body: { ...good, name: 'Bot', company_website: 'http://spam.test' } })).status, 200);
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  const list = (await call(HOME, '/api/server/demos', { cookie: boss })).data;
  assert.equal(list.new, 1);
  assert.equal(list.demos.length, 1);
  const r = list.demos[0];
  assert.deepEqual([r.name, r.business, r.email, r.kind, r.vans, r.status], ['Riley Buyer', 'Lakeview Motors', 'riley@lakeview.test', 'other', null, 'new'], 'unknown choices are cleaned up');
  assert.equal((await call(HOME, `/api/server/demos/${r.id}`, { cookie: boss, body: { status: 'contacted' } })).status, 200);
  assert.equal((await call(HOME, '/api/server/demos', { cookie: boss })).data.new, 0);
  // Business owners never see them.
  const pat = await signIn(SITE, '/pinevalley', 'pat@pinevalley.test', 'pine-pass-1');
  assert.equal((await call(SITE, '/pinevalley/api/server/demos', { cookie: pat })).status, 403);
  assert.equal((await call(HOME, `/api/server/demos/${r.id}`, { cookie: boss, method: 'DELETE' })).status, 200);
  assert.equal((await call(HOME, '/api/server/demos', { cookie: boss })).data.demos.length, 0);
  // Too many from one address.
  for (let i = 0; i < 6; i++) await call(SITE, '/api/frontdoor/demo', { body: { ...good, name: `Again ${i}` } });
  assert.equal((await call(SITE, '/api/frontdoor/demo', { body: good })).status, 429);
});

test('the owner sets each business up: starting settings, features and limits', async () => {
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  // Starting settings and a plan, chosen when the business is added.
  const made = await call(HOME, '/api/server/businesses', { cookie: boss, body: {
    name: 'Harbor Hotel', slug: 'harbor',
    settings: { business_type: 'shuttle', place_word: 'hotel', timezone: 'America/Chicago', brand_color: '#0d9488' },
    plan: { features: { reports: false, bdc: false }, limits: { max_drivers: 1, max_vans: 1 } },
  } });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(made.data.business.plan.features.reports, false);
  assert.deepEqual(made.data.business.plan.limits, { max_drivers: 1, max_vans: 1 });
  const setup = (await call(SITE, '/harbor/api/setup')).data.values;
  assert.deepEqual([setup.business_type, setup.place_word, setup.timezone, setup.brand_color, setup.dealer_name], ['shuttle', 'hotel', 'America/Chicago', '#0d9488', 'Harbor Hotel'], 'their Setup page starts with the owner’s choices');
  const code = new URL(made.data.business.setup_url).searchParams.get('code');
  const done = await call(SITE, '/harbor/api/setup', { body: { ...SETUP, business_type: 'shuttle', place_word: 'hotel', dealer_name: 'Harbor Hotel', code, admin: { first_name: 'Hal', last_name: 'Harbor', email: 'hal@harbor.test', password: 'harbor-pass-1' } } });
  const hal = done.cookie;

  // Features that are off are gone for them: from their settings and from the server.
  assert.equal((await call(SITE, '/harbor/api/me', { cookie: hal })).data.settings.features.reports, false);
  assert.equal((await call(SITE, '/harbor/api/reports', { cookie: hal })).status, 403);
  assert.equal((await call(SITE, '/harbor/bdc')).status, 404);
  assert.equal((await call(SITE, '/harbor/api/users', { cookie: hal, body: { first_name: 'Bea', last_name: 'Desk', email: 'bea@harbor.test', roles: ['bdc'], password: 'password123' } })).status, 400);
  assert.equal((await call(SITE, '/harbor/request')).status, 200, 'what is on stays on');
  // Limits: one driver, one van.
  assert.equal((await call(SITE, '/harbor/api/users', { cookie: hal, body: { first_name: 'Dee', last_name: 'One', email: 'dee@harbor.test', roles: ['driver'], password: 'password123' } })).status, 201);
  const second = await call(SITE, '/harbor/api/users', { cookie: hal, body: { first_name: 'Dan', last_name: 'Two', email: 'dan@harbor.test', roles: ['driver'], password: 'password123' } });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /up to 1 driver/);
  assert.equal((await call(SITE, '/harbor/api/vehicles', { cookie: hal, body: { name: 'Van 1', seats: 7 } })).status, 201);
  assert.equal((await call(SITE, '/harbor/api/vehicles', { cookie: hal, body: { name: 'Van 2', seats: 7 } })).status, 400);
  assert.equal((await call(SITE, '/harbor/api/vehicles', { cookie: hal, body: { name: 'Loaner', use: 'loaner' } })).status, 201, 'loaners don’t count');

  // The owner changes the plan any time: reports back on, room for more drivers.
  const changed = await call(HOME, '/api/server/businesses/harbor/plan', { cookie: boss, body: { features: { bdc: false }, limits: { max_drivers: 5 } } });
  assert.equal(changed.status, 200);
  assert.equal((await call(SITE, '/harbor/api/reports', { cookie: hal })).status, 200);
  assert.equal((await call(SITE, '/harbor/api/users', { cookie: hal, body: { first_name: 'Dan', last_name: 'Two', email: 'dan@harbor.test', roles: ['driver'], password: 'password123' } })).status, 201);
  assert.equal((await call(SITE, '/harbor/api/server/businesses/harbor/plan', { cookie: hal, body: { features: {} } })).status, 403, 'only the owner changes plans');
});

test('the owner opens any business as hidden Turas Lúbtha support', async () => {
  const boss = await signIn(HOME, '', 'boss@home.test', 'home-pass-1');
  const v = await call(HOME, '/api/server/businesses/harbor/visit', { cookie: boss, body: {} });
  assert.equal(v.status, 200, v.text);
  const u = new URL(v.data.url);
  assert.equal(u.pathname, '/harbor/auth/handoff');
  const landed = await call(SITE, `/harbor/auth/handoff${u.search}`);
  assert.equal(landed.location, '/harbor/');
  const support = landed.cookie;
  const me = (await call(SITE, '/harbor/api/me', { cookie: support })).data.user;
  assert.deepEqual([me.name, me.support, me.role, me.super_admin], ['Turas Lúbtha support', true, 'admin', true], 'full access, marked as support');
  assert.equal((await call(SITE, '/harbor/api/settings', { cookie: support, method: 'PATCH', body: { dealer_phone: '(312) 555-0100' } })).status, 200, 'can fix their settings');
  // Hidden from the business: not in the staff list or counts, can't be changed, can't sign in by password.
  const hal = await signIn(SITE, '/harbor', 'hal@harbor.test', 'harbor-pass-1');
  const staff = (await call(SITE, '/harbor/api/users', { cookie: hal })).data.users.map((x) => x.name);
  assert.ok(!staff.includes('Turas Lúbtha support'));
  assert.equal((await call(SITE, `/harbor/api/users/${me.id}`, { cookie: hal, method: 'PATCH', body: { active: false } })).status, 403);
  assert.equal((await call(SITE, `/harbor/api/users/${me.id}`, { cookie: hal, method: 'DELETE' })).status, 403);
  const people = (await call(HOME, '/api/server/businesses', { cookie: boss })).data.businesses.find((b) => b.slug === 'harbor').people;
  assert.equal(people.managers, 1, 'only Hal');
  assert.equal((await call(SITE, '/api/frontdoor/signin', { body: { email: 'support@turaslubtha.invalid', password: 'anything-1' } })).status, 401);
  // Only the owner can open a business; one that isn't set up yet can't be opened.
  assert.equal((await call(SITE, '/harbor/api/server/businesses/pinevalley/visit', { cookie: hal, body: {} })).status, 403);
  await call(HOME, '/api/server/businesses', { cookie: boss, body: { name: 'Not Ready', slug: 'notready' } });
  assert.equal((await call(HOME, '/api/server/businesses/notready/visit', { cookie: boss, body: {} })).status, 400);
});
