process.removeAllListeners('warning');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tk = require('../src/tunnel');
const { createLogbook } = require('../src/logbook');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-tunnel-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const TOKEN = Buffer.from(JSON.stringify({ a: 'acct123', t: '6ff42ae2-765d-4adf-8112-31c55c1551ef', s: 'secretsecretsecretsecretsecretsecret' })).toString('base64');

test('tunnel token: pasted command or token, tunnel id, never logged', () => {
  assert.equal(tk.cleanToken(TOKEN), TOKEN);
  assert.equal(tk.cleanToken(`cloudflared.exe service install ${TOKEN}`), TOKEN, 'the whole install command works');
  assert.equal(tk.cleanToken(`cloudflared tunnel run --token ${TOKEN}`), TOKEN);
  assert.equal(tk.cleanToken('hello'), null);
  assert.equal(tk.tunnelIdOf(TOKEN), '6ff42ae2-765d-4adf-8112-31c55c1551ef');
  const log = createLogbook();
  log.add(`cloudflared.exe service install ${TOKEN}`);
  assert.ok(!log.recent()[0].text.includes(TOKEN.slice(0, 30)), 'token hidden in the log');
});

test('.env values are added, changed and removed without touching other lines', () => {
  const env = path.join(tmp, '.env');
  fs.writeFileSync(env, 'ADMIN_EMAIL=a@b.c\nPORT=3000\n');
  tk.setEnvValue(env, 'CLOUDFLARE_TUNNEL_TOKEN', 'abc');
  tk.setEnvValue(env, 'PORT', '3005');
  assert.equal(fs.readFileSync(env, 'utf8').replace(/\r/g, ''), 'ADMIN_EMAIL=a@b.c\nPORT=3005\nCLOUDFLARE_TUNNEL_TOKEN=abc\n');
  tk.setEnvValue(env, 'CLOUDFLARE_TUNNEL_TOKEN', null);
  assert.equal(fs.readFileSync(env, 'utf8').replace(/\r/g, ''), 'ADMIN_EMAIL=a@b.c\nPORT=3005\n');
  tk.setEnvValue(path.join(tmp, 'new.env'), 'X', '1');
  assert.equal(fs.readFileSync(path.join(tmp, 'new.env'), 'utf8').trim(), 'X=1');
});

test('probe reads cloudflared status, connections and data centers', async () => {
  const fakeFetch = async (url) => {
    if (url.includes(':20241/')) throw new Error('refused');
    if (url.endsWith('/ready')) return { status: 200, json: async () => ({ status: 200, readyConnections: 4, connectorId: 'c1' }) };
    return { text: async () => 'cloudflared_build_info{goversion="go1.22",version="2026.10.0"} 1\ncloudflared_tunnel_server_locations{connection_id="0",edge_location="den01"} 1\ncloudflared_tunnel_server_locations{connection_id="1",edge_location="den04"} 1\ncloudflared_tunnel_server_locations{connection_id="2",edge_location="ord02"} 1' };
  };
  const p = await tk.probe({ fetchImpl: fakeFetch });
  assert.deepEqual([p.running, p.ready, p.connections, p.port, p.version], [true, true, 4, 20242, '2026.10.0']);
  assert.deepEqual(p.locations, ['Denver (DEN)', 'Chicago (ORD)']);
  const none = await tk.probe({ fetchImpl: async () => { throw new Error('refused'); } });
  assert.deepEqual([none.running, none.ready], [false, false]);
});

test('Shuttle Control runs cloudflared with the token kept out of the command line, and reconnects', async () => {
  const fakeBin = path.join(tmp, 'cloudflared-fake');
  fs.writeFileSync(fakeBin, '');
  process.env.CLOUDFLARED_PATH = fakeBin;
  const spawned = [];
  const spawnImpl = (bin, args, opts) => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 1000 + spawned.length;
    c.kill = () => setImmediate(() => c.emit('exit', null, 'SIGTERM'));
    spawned.push({ bin, args, env: opts.env, c });
    return c;
  };
  const logs = []; const lines = [];
  const t = tk.createTunnel({ root: tmp, log: (m) => logs.push(m), line: (l) => lines.push(l), spawnImpl });
  assert.throws(() => t.start({ token: '' }), /token/);
  t.start({ token: TOKEN, protocol: 'http2' });
  const first = spawned[0];
  assert.equal(first.bin, fakeBin);
  assert.deepEqual(first.args, ['tunnel', '--no-autoupdate', '--metrics', tk.OWN_METRICS, '--protocol', 'http2', 'run']);
  assert.ok(!first.args.join(' ').includes(TOKEN), 'token not on the command line');
  assert.equal(first.env.TUNNEL_TOKEN, TOKEN);
  first.c.stderr.write('2026-11-15T08:00:00Z INF Registered tunnel connection connIndex=0 location=den01\n');
  await new Promise((r) => setImmediate(r));
  assert.match(lines[0], /Registered tunnel connection/);
  assert.equal(t.state().running, true);
  // It drops: reconnects by itself after 5 seconds.
  const realSetTimeout = global.setTimeout; let waited = null;
  global.setTimeout = (fn, ms) => { waited = ms; return realSetTimeout(fn, 0); };
  first.c.emit('exit', 1, null);
  global.setTimeout = realSetTimeout;
  assert.equal(waited, 5000);
  await new Promise((r) => realSetTimeout(r, 20));
  assert.equal(spawned.length, 2, 'started again');
  assert.equal(t.state().restarts, 1);
  // Stop means stop: no reconnect.
  t.stop();
  await new Promise((r) => realSetTimeout(r, 20));
  assert.equal(spawned.length, 2);
  assert.equal(t.state().running, false);
  delete process.env.CLOUDFLARED_PATH;
});
