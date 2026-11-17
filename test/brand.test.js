process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { noTimers: true });
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
    return { status: res.status, res, data: await res.clone().json().catch(() => null) };
  };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('Corwin look: setting, page markup, preview script, and a safe logo upload', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });

  // Pages carry the look and colors before anything draws.
  let html = await (await fetch(`${base}/login`)).text();
  assert.match(html, /<html lang="en" data-look="corwin" data-site-look="corwin" data-logo="" data-brand-name="Corwin Toyota of Boulder" data-egg="1" data-tz="America\/Denver" data-build="[0-9a-f]{10}" style="--brand:#eb0a1e;--brand-dark:#0d0f12">/);
  assert.match(html, /localStorage\.setItem\("shuttle\.look",q\)/, 'preview with ?look=corwin');
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { look: 'neon' } })).status, 400);
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { brand_color: 'red' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { look: 'corwin', brand_color: '#c8102e' } });
  html = await (await fetch(`${base}/request`)).text();
  assert.match(html, /data-look="corwin" data-site-look="corwin" data-logo="" data-brand-name="Corwin Toyota of Boulder" data-egg="1" data-tz="America\/Denver" data-build="[0-9a-f]{10}" style="--brand:#c8102e;/);

  // Easter egg switch (on by default).
  await admin('/api/settings', { method: 'PATCH', body: { easter_egg: '0' } });
  assert.match(await (await fetch(`${base}/login`)).text(), /data-egg="0"/);
  await admin('/api/settings', { method: 'PATCH', body: { easter_egg: '1' } });
  assert.match(await (await fetch(`${base}/login`)).text(), /data-egg="1"/);

  // A custom header name is used, and can't break out of the page markup.
  await admin('/api/settings', { method: 'PATCH', body: { brand_name: 'Corwin "Toyota" <b>Boulder' } });
  html = await (await fetch(`${base}/login`)).text();
  assert.match(html, /data-brand-name="Corwin &#34;Toyota&#34; &#60;b&#62;Boulder"/);
  await admin('/api/settings', { method: 'PATCH', body: { brand_name: '' } });

  // Logo: admins only, images only, and an SVG can't run scripts.
  const advisor = client();
  await admin('/api/users', { body: { name: 'Av', email: 'av@t.l', role: 'advisor', password: 'advisorpw1' } });
  await advisor('/api/login', { body: { email: 'av@t.l', password: 'advisorpw1' } });
  assert.equal((await advisor('/api/brand/logo', { body: { data: PNG } })).status, 403);
  assert.equal((await admin('/api/brand/logo', { body: { data: 'data:text/html;base64,PGgxPmhpPC9oMT4=' } })).status, 400);
  assert.equal((await admin('/api/brand/logo', { body: { data: 'data:image/svg+xml;base64,' + Buffer.from('<html>nope</html>').toString('base64') } })).status, 400);
  let r = await admin('/api/brand/logo', { body: { data: PNG } });
  assert.equal(r.status, 200);
  assert.ok(r.data.settings.logo_v);
  assert.equal(r.data.settings.brand_logo, undefined, 'the image itself is not sent with settings');
  let logo = await fetch(`${base}/brand/logo`);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal((await logo.arrayBuffer()).byteLength, 70);
  html = await (await fetch(`${base}/login`)).text();
  assert.match(html, new RegExp(`data-logo="${r.data.settings.logo_v}"`));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
  await admin('/api/brand/logo', { body: { data: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') } });
  logo = await fetch(`${base}/brand/logo`);
  assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  assert.match(logo.headers.get('content-security-policy'), /sandbox/);
  assert.match(logo.headers.get('content-security-policy'), /default-src 'none'/);
  // Big uploads are refused (the logo route has its own size limit).
  const big = 'data:image/png;base64,' + Buffer.alloc(700 * 1024).toString('base64');
  assert.notEqual((await admin('/api/brand/logo', { body: { data: big } })).status, 200);
  // Remove it.
  r = await admin('/api/brand/logo', { method: 'DELETE' });
  assert.equal(r.data.settings.logo_v, '');
  assert.equal((await fetch(`${base}/brand/logo`)).status, 404);
});

test('links and QR codes use https when visitors come through Cloudflare', async () => {
  const admin = client();
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Visitor': '{"scheme":"https"}', 'CF-Connecting-IP': '203.0.113.9', Host: 'corwinshuttle.example' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'adminpass1' }) });
  assert.match(login.headers.get('set-cookie'), /; Secure/, 'sign-in cookie is marked secure');
  assert.equal(login.headers.get('strict-transport-security'), 'max-age=31536000', 'browsers remember to use https');
  assert.equal((await fetch(`${base}/login`)).headers.get('strict-transport-security'), null, 'not on plain office-network visits');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const links = await (await fetch(`${base}/api/links`, { headers: { Cookie: cookie, 'CF-Visitor': '{"scheme":"https"}', Host: 'corwinshuttle.example' } })).json();
  assert.match(links.links[0].url, /^https:\/\/127\.0\.0\.1:\d+\/request$/, 'https when the visitor used https');
  const qr = await fetch(`${base}/api/qr?text=${encodeURIComponent(links.links[0].url + '?type=pickup')}`, { headers: { Cookie: cookie, 'CF-Visitor': '{"scheme":"https"}', Host: 'corwinshuttle.example' } });
  assert.equal(qr.status, 200);
  // Without Cloudflare's header (e.g. opened on the server PC itself) it stays http.
  const plain = await (await fetch(`${base}/api/links`, { headers: { Cookie: cookie } })).json();
  assert.match(plain.links[0].url, /^http:\/\/127\.0\.0\.1/);
  void admin;
});

test('existing sites switch to the Corwin look once; a later choice sticks', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('look', 'classic')").run(); // a site from before the switch
  createApp(db, { noTimers: true });
  const look = () => db.prepare("SELECT value FROM settings WHERE key = 'look'").get().value;
  assert.equal(look(), 'corwin');
  db.prepare("UPDATE settings SET value = 'classic' WHERE key = 'look'").run(); // an admin picks Classic later
  createApp(db, { noTimers: true }); // restart
  assert.equal(look(), 'classic');
});
