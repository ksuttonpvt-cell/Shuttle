process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
// fetch() won't send a made-up Host header, so ask with http.request.
const http = require('node:http');
function get(path, host, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method || 'GET', headers: { Host: host, ...(opts.headers || {}) } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] }, text: async () => body }));
    });
    req.on('error', reject); if (opts.body) req.write(opts.body); req.end();
  });
}

test('the Turas Lúbtha website is served by its own name, and only the website', async () => {
  for (const host of ['turaslubtha.com', 'www.turaslubtha.com', 'website.localhost:3000']) {
    const r = await get('/', host);
    assert.equal(r.status, 200, host);
    assert.match(await r.text(), /Run your customer shuttle from/, host);
  }
  let r = await get('/css/site.css', 'turaslubtha.com');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/css/);
  r = await get('/signin', 'turaslubtha.com'); // works without ".html" too
  assert.equal(r.status, 200); assert.match(await r.text(), /turaslubtha sign in/);
  // Shuttle app pages and its API are not reachable by the website's name.
  for (const path of ['/admin', '/api/me', '/login', '/driver']) {
    r = await get(path, 'turaslubtha.com');
    assert.equal(r.status, 404, path);
    assert.match(await r.text(), /page not found/i, path);
  }
  r = await get('/api/login', 'turaslubtha.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 405);
  // The shuttle address works exactly as before.
  r = await get('/login', 'shuttle.test');
  assert.equal(r.status, 200); assert.match(await r.text(), /Sign in/);
  r = await get('/api/me', 'shuttle.test');
  assert.equal(r.status, 200);
});
