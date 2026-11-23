process.removeAllListeners('warning');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seedTestSite } = require('./helpers');

async function serve(db, opts = {}) {
  const app = createApp(db, { noTimers: true, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (p, { method, body } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  return { server, call };
}
const BUSINESS = { business_type: 'shuttle', dealer_name: 'Pine Lodge Hotel', dealer_phone: '(970) 555-0100', place_word: 'hotel', dealer_address: '1 Lodge Rd, Estes Park, CO', dealer_lat: 40.3772, dealer_lng: -105.5217, timezone: 'America/Denver', brand_color: '#1d6b45', brand_dark: '#0b2a1c' };

test('a brand-new install starts blank and opens on Setup, protected by the setup code', async () => {
  assert.equal(ensureAdmin(openDb(':memory:'), {}), null, 'no placeholder admin without ADMIN_EMAIL');
  const db = openDb(':memory:');
  const { server, call } = await serve(db);
  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  assert.equal(setting('dealer_name'), '', 'no business name until Setup');
  assert.notEqual(setting('dealer_lat'), '40.0236', 'not anybody else\'s location');
  assert.equal(setting('look'), 'branded');
  assert.equal((await call('/')).location, '/setup');
  assert.equal((await call('/login')).location, '/setup');
  assert.equal((await call('/setup')).status, 200);
  const info = (await call('/api/setup')).data;
  assert.deepEqual([info.done, info.need_admin], [false, true]);
  const code = setting('setup_code'); assert.match(code, /^[A-Z0-9x]{4}-[A-Z0-9x]{4}$/i);

  const admin = { first_name: 'Lee', last_name: 'Owner', email: 'lee@pinelodge.test', password: 'owner-pass-1' };
  assert.equal((await call('/api/setup', { body: { ...BUSINESS, code: 'NOPE-NOPE', admin } })).status, 400, 'wrong code');
  assert.equal((await call('/api/setup', { body: { ...BUSINESS, code, dealer_lat: null, admin } })).status, 400, 'needs the location');
  const ok = await call('/api/setup', { body: { ...BUSINESS, code: code.toLowerCase(), admin } });
  assert.equal(ok.status, 200);
  const me = (await call('/api/me')).data.user;
  assert.deepEqual([me.email, me.role, me.super_admin], ['lee@pinelodge.test', 'admin', true], 'signed straight in as a super admin');
  assert.deepEqual([setting('dealer_name'), setting('place_word'), setting('timezone'), setting('dealer_lat'), setting('brand_color'), setting('setup_done')],
    ['Pine Lodge Hotel', 'hotel', 'America/Denver', '40.3772', '#1d6b45', '1']);
  assert.equal(setting('setup_code'), undefined, 'the code is used up');
  assert.equal((await call('/setup')).location, '/', 'Setup is done');
  assert.equal((await call('/api/setup', { body: { ...BUSINESS, code, admin } })).status, 409, 'can\'t be run again');
  assert.equal((await call('/admin')).status, 200);
  server.close();
});

test('the first admin from .env: they sign in, then finish Setup without a code', async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@env.test', password: 'adminpass1', name: 'Env Boss' });
  const { server, call } = await serve(db, { superEmail: 'boss@env.test' });
  assert.equal((await call('/login')).status, 200, 'sign-in works (there is an admin)');
  await call('/api/login', { body: { email: 'boss@env.test', password: 'adminpass1' } });
  assert.equal((await call('/admin')).location, '/setup', 'the admin is sent to Setup first');
  assert.equal((await call('/api/setup')).data.need_admin, false);
  assert.equal((await call('/api/setup', { body: BUSINESS })).status, 200, 'no code needed when signed in');
  assert.equal((await call('/admin')).status, 200);
  server.close();
});

test('an existing install never sees Setup and keeps everything it had', async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@old.test', password: 'adminpass1', name: 'Old Boss' });
  const { server, call } = await serve(db);
  assert.equal((await call('/login')).status, 200);
  assert.equal((await call('/setup')).location, '/');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Corwin Toyota of Boulder', 'its name is untouched');
  assert.equal((await call('/api/setup', { body: BUSINESS })).status, 409);
  server.close();
});

test('with several cores (the database prepared, then each copy starting) a new install still needs Setup', () => {
  const db = openDb(':memory:');
  createApp(db, { noTimers: true }); // the main process gets the database ready
  createApp(db, { noTimers: true }); // a copy of the site on one core
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'setup_done'").get().value, '0');
  // An install from before Setup existed: settings saved, no setup_done mark (like a live site).
  const existing = openDb(':memory:');
  existing.prepare("INSERT INTO settings (key, value) VALUES ('dealer_name', 'Corwin Toyota of Boulder')").run();
  createApp(existing, { noTimers: true });
  assert.equal(existing.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get().value, 'Corwin Toyota of Boulder');
  assert.equal(existing.prepare("SELECT value FROM settings WHERE key = 'setup_done'").get().value, '1');
});

test('a new install has no branding: plain colors, plain icon, no extras; the light-background logo slot works', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const db = openDb(':memory:');
  const { server, call } = await serve(db);
  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  assert.deepEqual([setting('brand_color'), setting('brand_dark'), setting('easter_egg'), setting('dealer_name')], ['#6d28d9', '#1e1b4b', '0', '']);
  assert.equal(setting('brand_icon_512'), undefined, 'no icon saved: the plain built-in one');
  const port = server.address().port;
  const icon = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/brand/icon-192.png`)).arrayBuffer());
  assert.deepEqual(icon, fs.readFileSync(path.join(__dirname, '../public/icons/icon-192.png')));
  // Finish Setup, then the logo for light backgrounds.
  const code = setting('setup_code');
  await call('/api/setup', { body: { ...BUSINESS, code, admin: { first_name: 'Lee', last_name: 'Owner', email: 'lee@x.test', password: 'owner-pass-1' } } });
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const up = await call('/api/brand/logo-light', { body: { data: PNG } });
  assert.equal(up.status, 200); assert.ok(up.data.settings.logo_light_v);
  const html = await (await fetch(`http://127.0.0.1:${port}/login`)).text();
  assert.match(html, new RegExp(`data-logo-light="${up.data.settings.logo_light_v}"`));
  assert.equal((await fetch(`http://127.0.0.1:${port}/brand/logo-light`)).headers.get('content-type'), 'image/png');
  assert.equal((await call('/api/brand/logo-light', { method: 'DELETE' })).data.settings.logo_light_v, '');
  assert.equal((await fetch(`http://127.0.0.1:${port}/brand/logo-light`)).status, 404);
  server.close();
});
