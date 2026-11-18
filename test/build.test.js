process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'boss@build.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'boss@build.test', restart: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('pages carry the build, and the live connection says the current one (so old pages refresh themselves)', async () => {
  const builds = [];
  for (const p of ['/login', '/advisor', '/bdc', '/driver', '/admin', '/request']) {
    const html = await (await fetch(base + p)).text();
    const m = html.match(/<html[^>]* data-build="([0-9a-f]{10})"/);
    assert.ok(m, `${p} has a build`);
    builds.push(m[1]);
  }
  assert.equal(new Set(builds).size, 1, 'one build for every page');

  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@build.test', password: 'adminpass1' }) })).headers.get('set-cookie').split(';')[0];
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let got = '';
  while (!/event: hello\ndata: .*\n/.test(got)) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value); }
  ctrl.abort();
  assert.equal(JSON.parse(got.match(/event: hello\ndata: (.*)\n/)[1]).build, builds[0]);
});
