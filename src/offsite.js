// Off-PC backups: after the nightly backup, a fresh copy of every database (this shuttle, the
// businesses directory and each business) is sent to cloud storage, so a dead PC or disk
// doesn't take the data with it.
//
// Works with Cloudflare R2, Amazon S3, Backblaze B2 and anything else that speaks the S3 API.
// Requests are signed with AWS Signature Version 4 (done here, no extra packages).
// Files go to <bucket>/<prefix><date>/<name>.db. Old copies are removed by the bucket's own
// rule (in R2: bucket → Settings → Object lifecycle rules → delete after 30 days).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as Signature Version 4 wants it.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Signs a request. headers: lower-case names, must include host. Returns the Authorization value.
function signV4({ method, path: p, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date }) {
  const day = date.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonical = [
    method, p, query,
    names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'), payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

// Checks and tidies what the owner typed in. Throws with a plain message when something's off.
function cleanConfig(c) {
  const out = {
    endpoint: String(c.endpoint || '').trim().replace(/\/+$/, ''),
    bucket: String(c.bucket || '').trim(),
    region: String(c.region || '').trim() || 'auto',
    access_key_id: String(c.access_key_id || '').trim(),
    secret_access_key: String(c.secret_access_key || '').trim(),
    prefix: String(c.prefix || '').trim().replace(/^\/+/, ''),
  };
  let u;
  try { u = new URL(out.endpoint); } catch { throw new Error('The endpoint should be a web address, like https://<account id>.r2.cloudflarestorage.com'); }
  if (u.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new Error('The endpoint must start with https://');
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('Put only the endpoint (no bucket or folder after it). The bucket has its own box.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(out.bucket)) throw new Error('Bucket names are 3 to 63 lower-case letters, numbers, dots or dashes.');
  if (!/^[A-Za-z0-9]{8,128}$/.test(out.access_key_id)) throw new Error('That access key ID doesn\'t look right.');
  if (out.secret_access_key.length < 16 || out.secret_access_key.length > 256 || /\s/.test(out.secret_access_key)) throw new Error('That secret access key doesn\'t look right.');
  if (!/^[a-z0-9-]{2,30}$/.test(out.region)) throw new Error('The region should look like auto or us-east-1.');
  if (out.prefix && !/^[A-Za-z0-9._/-]{1,100}$/.test(out.prefix)) throw new Error('The folder can use letters, numbers, dots, dashes and slashes.');
  if (out.prefix && !out.prefix.endsWith('/')) out.prefix += '/';
  return out;
}

// getConfig(): the saved settings or null. sources(): [{ name, file }] databases to copy.
// saveStatus(status): remembers how the last run went.
function createOffsite({ getConfig, sources, tmpDir, saveStatus = () => {}, fetchImpl = fetch, log = () => {}, now = () => new Date() }) {
  let running = null;

  async function put(cfg, key, body, contentType = 'application/octet-stream') {
    const u = new URL(cfg.endpoint);
    const p = `/${enc(cfg.bucket)}/${key.split('/').map(enc).join('/')}`;
    const date = amzDate(now());
    const payloadHash = sha256(body);
    const headers = { host: u.host, 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
    const authorization = signV4({ method: 'PUT', path: p, headers, payloadHash, accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key, region: cfg.region, date });
    const { host, ...send } = headers; // fetch sets Host itself
    let res;
    try {
      res = await fetchImpl(`${u.origin}${p}`, { method: 'PUT', headers: { ...send, authorization }, body, signal: AbortSignal.timeout(10 * 60000) });
    } catch (e) {
      throw new Error(`Couldn't reach ${u.host}: ${e.cause?.code || e.message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
      const why = { AccessDenied: 'the key isn\'t allowed to write to this bucket', NoSuchBucket: 'there\'s no bucket with that name', SignatureDoesNotMatch: 'the secret access key is wrong', InvalidAccessKeyId: 'the access key ID is wrong' }[code];
      throw new Error(`The storage said no (${res.status}${code ? ` ${code}` : ''})${why ? `: ${why}` : ''}.`);
    }
  }

  // A small file, to check the settings work.
  async function test(cfg = getConfig()) {
    if (!cfg) throw new Error('Off-PC backups aren\'t set up.');
    await put(cfg, `${cfg.prefix || ''}connection-test.txt`, Buffer.from(`Turas Lúbtha off-PC backup test, ${now().toISOString()}\n`), 'text/plain; charset=utf-8');
    return true;
  }

  async function runOnce() {
    const cfg = getConfig();
    if (!cfg) return null;
    const started = now();
    const day = started.toISOString().slice(0, 10);
    const sent = []; const failed = [];
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const s of sources()) {
      if (!s.file || !fs.existsSync(s.file)) continue;
      const tmp = path.join(tmpDir, `offsite-${process.pid}-${Date.now()}.db`);
      try {
        // A consistent copy, made while the site keeps running.
        const db = new DatabaseSync(s.file, { readOnly: true });
        try { db.prepare('VACUUM INTO ?').run(tmp); } finally { db.close(); }
        const body = fs.readFileSync(tmp);
        await put(cfg, `${cfg.prefix || ''}${day}/${s.name}.db`, body);
        sent.push({ name: s.name, size: body.length });
      } catch (e) {
        failed.push({ name: s.name, error: e.message });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const status = { at: started.toISOString(), ok: !failed.length && sent.length > 0, sent, failed, bytes: sent.reduce((n, x) => n + x.size, 0) };
    saveStatus(status);
    if (failed.length) log(`Off-PC backup: ${failed.length} of ${failed.length + sent.length} failed. ${failed[0].name}: ${failed[0].error}`, 'error');
    else log(`Off-PC backup sent: ${sent.length} database${sent.length === 1 ? '' : 's'} (${Math.round(status.bytes / 1024)} KB).`);
    return status;
  }
  // One run at a time.
  function run() {
    if (!running) running = runOnce().finally(() => { running = null; });
    return running;
  }

  return { run, test, get busy() { return !!running; } };
}

module.exports = { createOffsite, cleanConfig, signV4, amzDate };
