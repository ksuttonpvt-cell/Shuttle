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
  assert.match(html, /<html lang="en" data-look="classic" data-site-look="classic" data-logo="" style="--brand:#eb0a1e;--brand-dark:#0d0f12">/);
  assert.match(html, /localStorage\.setItem\("shuttle\.look",q\)/, 'preview with ?look=corwin');
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { look: 'neon' } })).status, 400);
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { brand_color: 'red' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { look: 'corwin', brand_color: '#c8102e' } });
  html = await (await fetch(`${base}/request`)).text();
  assert.match(html, /data-look="corwin" data-site-look="corwin" data-logo="" style="--brand:#c8102e;/);

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
