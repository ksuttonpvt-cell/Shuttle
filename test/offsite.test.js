process.removeAllListeners('warning');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { signV4, createOffsite, cleanConfig } = require('../src/offsite');

const KEY = { access_key_id: 'AKIDEXAMPLE12345', secret_access_key: 'not-a-real-secret-0123456789' };

// A pretend S3/R2: checks each request's signature the way the real one does, and keeps the files.
function fakeStorage({ secret = KEY.secret_access_key, refuse = null } = {}) {
  const files = new Map();
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (refuse) { res.writeHead(403); return res.end(`<Error><Code>${refuse}</Code></Error>`); }
      const auth = req.headers.authorization || '';
      const signed = /SignedHeaders=([^,]+)/.exec(auth)[1].split(';');
      const scope = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(auth)[1];
      const headers = Object.fromEntries(signed.map((h) => [h, req.headers[h]]));
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      const expected = signV4({ method: req.method, path: req.url, headers, payloadHash: hash, accessKeyId: KEY.access_key_id, secretAccessKey: secret, region: scope, date: req.headers['x-amz-date'] });
      if (expected !== auth || req.headers['x-amz-content-sha256'] !== hash) { res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      files.set(decodeURIComponent(req.url), body); res.writeHead(200); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, files, endpoint: `http://127.0.0.1:${srv.address().port}` })));
}

test('signing matches the example in the AWS documentation', () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const auth = signV4({ method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' },
    payloadHash: empty, accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: '20130524T000000Z' });
  assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('settings are checked before they are saved', () => {
  const ok = cleanConfig({ endpoint: 'https://abc123.r2.cloudflarestorage.com/', bucket: 'turas-backups', ...KEY, prefix: 'pc1' });
  assert.equal(ok.endpoint, 'https://abc123.r2.cloudflarestorage.com');
  assert.equal(ok.region, 'auto');
  assert.equal(ok.prefix, 'pc1/');
  for (const bad of [{ endpoint: 'http://example.com' }, { endpoint: 'https://x.r2.cloudflarestorage.com/bucket' }, { bucket: 'No Caps' }, { access_key_id: 'a b' }, { secret_access_key: 'short' }]) {
    assert.throws(() => cleanConfig({ endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'turas-backups', ...KEY, ...bad }), Error, JSON.stringify(bad));
  }
});

test('every database is copied and sent, signed; problems are reported plainly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-off-'));
  const mk = (name, rows) => { const f = path.join(dir, name); const db = new DatabaseSync(f); db.exec('CREATE TABLE t (x)'); for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(i); db.close(); return f; };
  const sources = [{ name: 'shuttle', file: mk('a.db', 3) }, { name: 'businesses/pinevalley', file: mk('b.db', 5) }, { name: 'gone', file: path.join(dir, 'missing.db') }];
  const store = await fakeStorage();
  let status = null;
  const cfg = cleanConfig({ endpoint: store.endpoint, bucket: 'turas-backups', ...KEY, prefix: 'pc1' });
  const off = createOffsite({ getConfig: () => cfg, sources: () => sources, tmpDir: path.join(dir, 'tmp'), saveStatus: (s) => { status = s; }, now: () => new Date('2026-11-29T07:00:00Z') });
  assert.equal(await off.test(), true);
  assert.ok(store.files.has('/turas-backups/pc1/connection-test.txt'));
  const r = await off.run();
  assert.equal(r.ok, true);
  assert.deepEqual(r.sent.map((x) => x.name), ['shuttle', 'businesses/pinevalley'], 'missing files are skipped');
  assert.equal(status, r);
  const copy = store.files.get('/turas-backups/pc1/2026-11-29/businesses/pinevalley.db');
  assert.equal(copy.subarray(0, 15).toString(), 'SQLite format 3');
  const f = path.join(dir, 'check.db'); fs.writeFileSync(f, copy);
  const db = new DatabaseSync(f); assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 5); db.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'temporary copies are removed');
  store.srv.close();

  // Wrong secret, or a key without permission: plain words.
  const wrong = await fakeStorage({ secret: 'something-else-entirely-000' });
  const bad = createOffsite({ getConfig: () => ({ ...cfg, endpoint: wrong.endpoint }), sources: () => sources, tmpDir: path.join(dir, 'tmp') });
  await assert.rejects(bad.test(), /secret access key is wrong/);
  const r2 = await bad.run();
  assert.equal(r2.ok, false); assert.equal(r2.failed.length, 2);
  wrong.srv.close();
  const no = await fakeStorage({ refuse: 'AccessDenied' });
  await assert.rejects(createOffsite({ getConfig: () => ({ ...cfg, endpoint: no.endpoint }), sources: () => [], tmpDir: dir }).test(), /isn't allowed to write/);
  no.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
