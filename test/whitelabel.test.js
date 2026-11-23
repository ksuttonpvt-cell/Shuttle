process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@brand.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@brand.test', restart: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const html = async (p) => (await fetch(base + p)).text();

test('your own business: name, words, icon, banner, tab titles, app manifest, short link and web address', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@brand.test', password: 'adminpass1' } });
  const patch = (body) => a('/api/settings', { method: 'PATCH', body });

  // A shuttle service, not a dealership, with its own word for its base.
  assert.equal((await patch({ business_type: 'airline' })).status, 400);
  assert.equal((await patch({ place_word: '<b>' })).status, 400);
  assert.equal((await patch({ business_type: 'shuttle', dealer_name: 'Pine Lodge Hotel', place_word: '' })).status, 200);
  assert.equal((await a('/api/me')).data.settings.place, 'office', 'shuttle services default to "office"');
  await patch({ place_word: 'Hotel' });
  assert.equal((await a('/api/me')).data.settings.place, 'hotel');
  let page = await html('/login');
  assert.match(page, /data-place="hotel"/);
  assert.match(page, /<title>Sign in · Pine Lodge Hotel<\/title>/, 'your name in the browser tab');
  assert.match(await html('/driver'), /<title>Driver · Pine Lodge Hotel<\/title>/);

  // App icon: three square PNGs; the default shuttle icon until then.
  let r = await fetch(`${base}/brand/icon-192.png`);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const kept = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(kept, require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/assets/legacy-icons/icon-192.png')), 'a site from before keeps the icon it had');
  const defaultIcon = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/icons/icon-192.png'));
  assert.equal((await a('/api/brand/icon', { body: { i512: JPEG, i192: PNG, i180: PNG } })).status, 400, 'PNGs only');
  const up = await a('/api/brand/icon', { body: { i512: PNG, i192: PNG, i180: PNG } });
  assert.equal(up.status, 200); assert.ok(up.data.settings.icon_v);
  r = await fetch(`${base}/brand/icon-192.png`);
  assert.notDeepEqual(Buffer.from(await r.arrayBuffer()), kept, 'your icon now');
  page = await html('/advisor');
  assert.match(page, new RegExp(`<link rel="icon" href="/brand/icon-192.png\\?v=${up.data.settings.icon_v}">`));
  assert.match(page, /<link rel="manifest" href="\/manifest.webmanifest\?v=/);
  assert.equal((page.match(/rel="icon"/g) || []).length, 1, 'one icon link');
  const mf = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(mf.name, 'Pine Lodge Hotel · Turas Lúbtha'); assert.equal(mf.short_name, 'Pine');
  assert.match(mf.icons[0].src, /\/brand\/icon-192.png\?v=/);
  await a('/api/brand/icon', { method: 'DELETE' });
  r = await fetch(`${base}/brand/icon-192.png`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), defaultIcon, 'back to the plain built-in icon');

  // Banner behind the name.
  assert.equal((await a('/api/brand/banner', { body: { data: PNG } })).status, 400, 'JPEG only (the page converts it)');
  const bn = await a('/api/brand/banner', { body: { data: JPEG } });
  assert.equal(bn.status, 200);
  page = await html('/request');
  assert.match(page, /data-banner="1"/); assert.match(page, /--banner:url\(\/brand\/banner.jpg\?v=/);
  assert.equal((await fetch(`${base}/brand/banner.jpg`)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await client()('/api/brand/banner', { body: { data: JPEG } })).status, 401, 'admins only');

  // Short link for customers.
  assert.equal((await patch({ request_path: 'admin' })).status, 400, 'not a word the site uses');
  assert.equal((await patch({ request_path: '/Ride/' })).status, 200);
  assert.equal((await a('/api/me')).data.settings.request_path, 'ride');
  const ride = await fetch(`${base}/ride`); assert.equal(ride.status, 200);
  assert.match(await ride.text(), /Request a shuttle ride/);
  assert.equal((await fetch(`${base}/nothing-here`)).status, 404);

  // Your own web address in links.
  assert.equal((await a('/api/site-url', { method: 'PUT', body: { url: 'http://' } })).status, 400);
  assert.equal((await a('/api/site-url', { method: 'PUT', body: { url: 'shuttle.pinelodge.test/page' } })).status, 400, 'no paths');
  const su = await a('/api/site-url', { method: 'PUT', body: { url: 'Shuttle.PineLodge.test' } });
  assert.equal(su.data.in_use, 'https://shuttle.pinelodge.test');
  const links = (await a('/api/links')).data.links;
  assert.equal(links.find((l) => l.key === 'request').url, 'https://shuttle.pinelodge.test/ride');
  assert.equal((await client()('/api/site-url')).status, 401);
  assert.ok((await (await fetch(`${base}/api/site-id`)).json()).id, 'this site has an id for the check');
  await a('/api/site-url', { method: 'PUT', body: { url: '' } });
  assert.match((await a('/api/links')).data.links[0].url, /^http:\/\/127\.0\.0\.1/, 'back to automatic');
});
