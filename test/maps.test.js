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
  const theApp = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true });
  await new Promise((r) => { server = theApp.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let cookie = '';
async function call(path, { method, body } = {}) {
  const res = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const TOKEN = 'pk.' + 'eyJ1IjoidGVzdCIsImEiOiJjbGFiYyJ9'.padEnd(40, 'x') + '.abcDEF_123-xyz';

test('maps use OpenStreetMap until a service and its key are saved, then that service on every page', async () => {
  await call('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  let page = await (await fetch(`${base}/request`)).text();
  assert.doesNotMatch(page, /data-map=/);
  assert.match(page, /preconnect" href="https:\/\/tile\.openstreetmap\.org"/);

  // Secret tokens and junk are refused; the provider must be one we know.
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { mapbox_token: 'sk.' + 'a'.repeat(60) } })).status, 400);
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { mapbox_token: 'not a token' } })).status, 400);
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { map_provider: 'bing' } })).status, 400);

  // Mapbox picked but no token yet: pages stay on OpenStreetMap.
  assert.equal((await call('/api/settings', { method: 'PATCH', body: { map_provider: 'mapbox' } })).status, 200);
  assert.doesNotMatch(await (await fetch(`${base}/request`)).text(), /data-map=/);

  assert.equal((await call('/api/settings', { method: 'PATCH', body: { map_provider: 'mapbox', mapbox_token: TOKEN } })).status, 200);
  for (const path of ['/request', '/login', '/admin']) {
    page = await (await fetch(base + path)).text();
    assert.match(page, new RegExp(`data-map="mapbox" data-map-key="${TOKEN.replace(/[.]/g, '\\.')}"`), path);
  }
  assert.match(await (await fetch(`${base}/request`)).text(), /preconnect" href="https:\/\/api\.mapbox\.com"/);

  // The other services: each needs its own kind of key, and pages connect to that service.
  const KEYS = { maptiler: ['maptiler_key', 'AbCdEf0123456789xyz', 'api.maptiler.com'], stadia: ['stadia_key', '1a2b3c4d-5e6f-7a8b-9c0d-112233445566', 'tiles.stadiamaps.com'],
    thunderforest: ['thunderforest_key', '0123456789abcdef0123456789abcdef', 'tile.thunderforest.com'], google: ['google_maps_key', 'AIza' + 'B'.repeat(35), 'tile.googleapis.com'] };
  for (const [provider, [setting, key, host]] of Object.entries(KEYS)) {
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { [setting]: 'no good!' } })).status, 400, setting);
    assert.equal((await call('/api/settings', { method: 'PATCH', body: { map_provider: provider, [setting]: key } })).status, 200, provider);
    page = await (await fetch(`${base}/request`)).text();
    assert.match(page, new RegExp(`data-map="${provider}" data-map-key="${key}"`), provider);
    assert.match(page, new RegExp(`preconnect" href="https://${host.replace(/[.]/g, '\\.')}"`), provider);
  }
  // Each key is kept when switching, so going back to Mapbox still works.
  await call('/api/settings', { method: 'PATCH', body: { map_provider: 'mapbox' } });
  assert.match(await (await fetch(`${base}/request`)).text(), /data-map="mapbox"/);

  // Back to OpenStreetMap.
  await call('/api/settings', { method: 'PATCH', body: { map_provider: 'osm' } });
  assert.doesNotMatch(await (await fetch(`${base}/request`)).text(), /data-map=/);
});
