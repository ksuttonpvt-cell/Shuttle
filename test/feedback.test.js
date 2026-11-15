process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

const posts = []; let discordDown = false;
const discordFetch = async (url, init) => { if (discordDown) return { ok: false, status: 500 }; posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; };
let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { noTimers: true, discordFetch });
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
const HOOK = 'https://discord.com/api/webhooks/123456789/abcDEF-secret_token';

test('help & suggestions are saved and posted to Discord; the webhook stays secret', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Dana Driver', email: 'dana@t.l', role: 'driver', password: 'driverpw1' } });
  const dana = client();
  await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } });

  // Without a webhook, messages are still saved.
  let r = await dana('/api/feedback', { body: { kind: 'idea', message: 'Add a coffee stop button', page: '/driver' } });
  assert.equal(r.status, 201); assert.equal(r.data.sent_to_discord, false);

  // Only admins set it up, and only real Discord webhook links are accepted.
  assert.equal((await dana('/api/feedback/webhook', { method: 'PUT', body: { webhook: HOOK } })).status, 403);
  assert.equal((await admin('/api/feedback/webhook', { method: 'PUT', body: { webhook: 'https://evil.example/hook' } })).status, 400);
  assert.equal((await admin('/api/feedback/webhook', { method: 'PUT', body: { webhook: HOOK } })).status, 200);
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { discord_invite: 'https://example.com/x' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { discord_invite: 'https://discord.gg/corwin1' } });

  // The webhook is never sent to browsers; the invite is.
  const me = (await dana('/api/me')).data;
  assert.equal(JSON.stringify(me).includes('secret_token'), false);
  assert.equal(me.settings.discord_invite, 'https://discord.gg/corwin1');
  const list = (await admin('/api/feedback')).data;
  assert.equal(list.webhook_set, true);
  assert.equal(JSON.stringify(list).includes('secret_token'), false, 'admins only see a hint');
  assert.equal((await dana('/api/feedback')).status, 403);

  // Posting: goes to Discord with no @everyone pings.
  r = await dana('/api/feedback', { body: { kind: 'problem', message: 'Map froze @everyone', page: '/driver' } });
  assert.equal(r.data.sent_to_discord, true);
  const p = posts.at(-1);
  assert.equal(p.url, HOOK);
  assert.deepEqual(p.body.allowed_mentions, { parse: [] });
  assert.match(p.body.embeds[0].title, /Problem/);
  assert.equal(p.body.embeds[0].fields[0].value, 'Dana Driver (driver)');
  // Test button.
  assert.equal((await admin('/api/feedback/test', { body: {} })).status, 200);
  // If Discord is down, the message is kept with the error.
  discordDown = true;
  r = await dana('/api/feedback', { body: { kind: 'help', message: 'How do I end my shift?' } });
  assert.equal(r.data.sent_to_discord, false);
  discordDown = false;
  const items = (await admin('/api/feedback')).data.items;
  assert.equal(items.length, 3);
  assert.match(items[0].error, /500/);
  // Validation and limits.
  assert.equal((await dana('/api/feedback', { body: { message: '' } })).status, 400);
  let last;
  for (let i = 0; i < 10; i++) last = await dana('/api/feedback', { body: { message: `note ${i}` } });
  assert.equal(last.status, 429);
});
