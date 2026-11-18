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

test('a busy status port: the next try uses the next port, and Shuttle Control says why', async () => {
  const fakeBin = path.join(tmp, 'cloudflared-fake2'); fs.writeFileSync(fakeBin, '');
  process.env.CLOUDFLARED_PATH = fakeBin;
  const spawned = [];
  const spawnImpl = (bin, args) => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 5000 + spawned.length;
    c.kill = () => setImmediate(() => c.emit('exit', null, 'SIGTERM'));
    spawned.push({ args, c }); return c;
  };
  const pidFile = path.join(tmp, 'cloudflared.pid');
  const t = tk.createTunnel({ root: tmp, spawnImpl, pidFile });
  t.start({ token: TOKEN });
  assert.equal(fs.readFileSync(pidFile, 'utf8'), '5000', 'its process id is written down');
  spawned[0].c.stderr.write('2026-11-18T07:00:00Z ERR Error opening metrics server listener error="failed to bind to address (127.0.0.1:20241): listen tcp 127.0.0.1:20241: bind: Only one usage of each socket address"\n');
  await new Promise((r) => setImmediate(r));
  assert.match(t.state().last_error, /status port 20241 is in use/);
  const realSetTimeout = global.setTimeout; let waited = null;
  global.setTimeout = (fn, ms) => { waited = ms; return realSetTimeout(fn, 0); };
  spawned[0].c.emit('exit', 1, null);
  global.setTimeout = realSetTimeout;
  assert.equal(waited, 2000, 'tries again right away');
  await new Promise((r) => realSetTimeout(r, 20));
  assert.equal(spawned[1].args[3], '127.0.0.1:20242', 'the next port');
  assert.equal(t.state().metrics_port, 20242);
  // Connected: the reason goes away.
  spawned[1].c.stderr.write('2026-11-18T07:00:05Z INF Registered tunnel connection connIndex=0 location=den01\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(t.state().last_error, null);
  t.stop(); await new Promise((r) => realSetTimeout(r, 20));
  assert.ok(!fs.existsSync(pidFile), 'cleared when it stops');
  delete process.env.CLOUDFLARED_PATH;
});

test('a leftover cloudflared from before is stopped first; anything else with an old id is left alone', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const fake = path.join(tmp, 'fake-cloudflared.js'); fs.writeFileSync(fake, 'setInterval(() => {}, 1000);');
  const other = path.join(tmp, 'something-else.js'); fs.writeFileSync(other, 'setInterval(() => {}, 1000);');
  const leftover = spawn(process.execPath, [fake], { stdio: 'ignore' });
  const innocent = spawn(process.execPath, [other], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tk.isCloudflared(leftover.pid), true); assert.equal(tk.isCloudflared(innocent.pid), false);
  const fakeBin = path.join(tmp, 'cloudflared-fake3'); fs.writeFileSync(fakeBin, ''); process.env.CLOUDFLARED_PATH = fakeBin;
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.pid = 7777; c.kill = () => setImmediate(() => c.emit('exit', null, 'SIGTERM')); return c; };
  const pidFile = path.join(tmp, 'cloudflared2.pid'); const logs = [];
  // Someone else now has the old id: not touched.
  fs.writeFileSync(pidFile, String(innocent.pid));
  let t = tk.createTunnel({ root: tmp, spawnImpl, pidFile, log: (m) => logs.push(m) });
  t.start({ token: TOKEN }); t.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(innocent.exitCode, null, 'still running'); assert.equal(innocent.signalCode, null);
  // A real leftover cloudflared: stopped before the new one starts.
  fs.writeFileSync(pidFile, String(leftover.pid));
  const gone = new Promise((r) => leftover.on('exit', r));
  t = tk.createTunnel({ root: tmp, spawnImpl, pidFile, log: (m) => logs.push(m) });
  t.start({ token: TOKEN });
  await gone;
  assert.ok(logs.some((m) => /Stopped a leftover Cloudflare connection/.test(m)));
  t.stop(); innocent.kill(); delete process.env.CLOUDFLARED_PATH;
});

test('only one copy of the shuttle program runs: a second one says so and closes', async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const [sitePort, controlPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(tmp, 'sup-'));
  const env = { ...process.env, PORT: String(sitePort), CONTROL_PORT: String(controlPort), DB_FILE: path.join(dir, 'shuttle.db'), CLOUDFLARE_TUNNEL_TOKEN: '', ADMIN_EMAIL: 'a@b.test', ADMIN_PASSWORD: 'adminpass1', SHUTTLE_WORKERS: '1' };
  const root = path.join(__dirname, '..');
  const first = spawn(process.execPath, ['src/supervisor.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out1 = ''; first.stdout.on('data', (d) => { out1 += d; });
  for (let i = 0; i < 100 && !/Shuttle Control is ready/.test(out1); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out1, /Shuttle Control is ready/);
  const second = spawn(process.execPath, ['src/supervisor.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; second.stdout.on('data', (d) => { out2 += d; });
  const code = await new Promise((r) => second.on('exit', r));
  assert.equal(code, 0);
  assert.match(out2, /already running on this PC, so this copy will close/);
  assert.doesNotMatch(out2, /Starting/i, 'it never started a second website');
  first.kill('SIGTERM'); await new Promise((r) => first.on('exit', r));
});
