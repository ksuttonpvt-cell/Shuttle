// Driver app updates, handed out by this PC.
//
// After GitHub builds a new Android app, it uploads it here (POST /api/app/upload) with the
// upload key the owner made on the Server page. The newest app is kept in data/app/, phones ask
// GET /api/app/latest whether there's a newer one, and download it from /download/turas-driver.apk.
// Only a hash of the upload key is stored.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 150 * 1024 * 1024;
const APK = 'turas-driver.apk';
const DOWNLOAD_PATH = `/download/${APK}`;
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

function createAppReleases({ dir, getKeyHash, setKeyHash, log = () => {} }) {
  const infoFile = path.join(dir, 'latest.json');
  const apkFile = path.join(dir, APK);
  function latest() {
    try {
      const i = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      return fs.existsSync(apkFile) ? i : null;
    } catch { return null; }
  }
  // A new upload key: shown once, only its hash is kept. Replaces the old one.
  function newKey() {
    const key = `tlu_${crypto.randomBytes(24).toString('base64url')}`;
    setKeyHash(hashKey(key));
    return key;
  }
  const hasKey = () => !!getKeyHash();
  function keyOk(req) {
    const want = getKeyHash();
    const m = /^Bearer\s+(\S{10,200})$/i.exec(String(req.headers.authorization || ''));
    if (!want || !m) return false;
    const a = Buffer.from(hashKey(m[1]), 'hex'); const b = Buffer.from(want, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const send = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };

  // POST /api/app/upload  (body: the .apk; headers X-App-Build, X-App-Version)
  function upload(req, res) {
    if (!keyOk(req)) return send(res, 401, { error: 'Wrong or missing upload key.' });
    const build = Number(req.headers['x-app-build']);
    const version = String(req.headers['x-app-version'] || '').slice(0, 40);
    if (!Number.isInteger(build) || build < 1) return send(res, 400, { error: 'X-App-Build must be a whole number.' });
    if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) return send(res, 400, { error: 'X-App-Version is missing.' });
    const now = latest();
    if (now && build < now.build) return send(res, 409, { error: `Build ${now.build} is already here; not going back to ${build}.` });
    if (Number(req.headers['content-length']) > MAX_BYTES) return send(res, 413, { error: 'That file is too big.' });
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `upload-${process.pid}-${Date.now()}.tmp`);
    const out = fs.createWriteStream(tmp);
    const sha = crypto.createHash('sha256');
    let size = 0; let head = Buffer.alloc(0); let failed = false;
    const fail = (status, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); send(res, status, { error }); req.resume(); };
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BYTES) return fail(413, 'That file is too big.');
      if (head.length < 4) head = Buffer.concat([head, c]).subarray(0, 4);
      sha.update(c);
      out.write(c);
    });
    req.on('error', () => fail(400, 'The upload was cut off.'));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (head.toString('latin1') !== 'PK\u0003\u0004') return fail(400, 'That isn\'t an Android app file (.apk).');
        const info = { build, version, size, sha256: sha.digest('hex'), at: new Date().toISOString() };
        try {
          fs.renameSync(tmp, apkFile);
          fs.writeFileSync(`${infoFile}.tmp`, JSON.stringify(info, null, 2)); fs.renameSync(`${infoFile}.tmp`, infoFile);
        } catch (e) { return fail(500, `Couldn't save it: ${e.message}`); }
        log(`Driver app ${version} (build ${build}, ${Math.round(size / 1048576 * 10) / 10} MB) received. Phones will offer it as an update.`);
        send(res, 201, { ok: true, ...info });
      });
    });
  }

  // GET /api/app/latest: what phones check.
  function latestRoute(req, res) {
    const i = latest();
    send(res, 200, i ? { build: i.build, version: i.version, size: i.size, sha256: i.sha256, at: i.at, url: DOWNLOAD_PATH } : { build: 0 });
  }

  // GET /download/turas-driver.apk
  function download(req, res) {
    const i = latest();
    if (!i) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); return res.end('No app here yet.'); }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', i.size);
    res.setHeader('Content-Disposition', `attachment; filename="turas-driver-${i.version}.apk"`);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(apkFile).on('error', () => res.destroy()).pipe(res);
  }

  // Requests this module answers (any host, like the shared sign-in).
  function handles(req) {
    const u = String(req.url || '').split('?')[0];
    return u === '/api/app/latest' || u === '/api/app/upload' || u === DOWNLOAD_PATH;
  }
  function handle(req, res) {
    const u = String(req.url || '').split('?')[0];
    if (u === '/api/app/upload') return req.method === 'POST' ? upload(req, res) : send(res, 405, { error: 'Use POST.' });
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Use GET.' });
    return u === DOWNLOAD_PATH ? download(req, res) : latestRoute(req, res);
  }

  return { latest, newKey, hasKey, handles, handle, DOWNLOAD_PATH };
}

module.exports = { createAppReleases, DOWNLOAD_PATH };
