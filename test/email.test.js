process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

let server; let base;
before(async () => {
  const db = seedTestSite(openDb(':memory:'));
  ensureAdmin(db, { email: 'eve@mail.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { noTimers: true, superEmail: 'eve@mail.test', restart: () => {} });
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

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { smtpSend } = require('../src/mailer');

// A small stand-in email server: offers STARTTLS, takes AUTH PLAIN, and keeps what it receives.
function fakeSmtp({ starttls = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const key = fs.readFileSync(path.join(dir, 'k.pem')); const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const got = { auth: [], data: '', rcpt: [], encrypted: false };
  const server = net.createServer((sock) => {
    let s = sock; let inData = false; let buf = '';
    const say = (l) => s.write(`${l}\r\n`);
    const onLine = (line) => {
      if (inData) { if (line === '.') { inData = false; say('250 OK queued'); } else got.data += `${line}\n`; return; }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') { say('250-fake.smtp'); if (starttls && !got.encrypted) say('250-STARTTLS'); say('250 AUTH PLAIN LOGIN'); }
      else if (cmd === 'STARTTLS') {
        say('220 Go ahead');
        s.removeAllListeners('data');
        s = new tls.TLSSocket(sock, { isServer: true, key, cert });
        got.encrypted = true; s.on('data', onData);
      } else if (cmd === 'AUTH') { got.auth.push(line); say('235 OK'); }
      else if (cmd === 'MAIL') say('250 OK');
      else if (cmd === 'RCPT') { got.rcpt.push(line); say('250 OK'); }
      else if (cmd === 'DATA') { inData = true; say('354 Go'); }
      else if (cmd === 'QUIT') { say('221 Bye'); s.end(); }
      else say('500 ?');
    };
    const onData = (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } };
    s.on('data', onData); s.on('error', () => {});
    say('220 fake ESMTP');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, got })));
}

test('the built-in sender talks real SMTP: encrypts first, signs in, sends the message', async () => {
  const { server, port, got } = await fakeSmtp({ starttls: true });
  try {
    await smtpSend({ host: '127.0.0.1', port, user: 'shuttle@dealer.test', pass: 's3cret', from: 'shuttle@dealer.test', fromName: 'Corwin Shuttle', tlsOptions: { rejectUnauthorized: false } },
      { to: 'pat@dealer.test', subject: 'Reset your password', text: 'Hi Pat,\nTap: https://x.test/reset/abc\n.' });
    assert.equal(got.encrypted, true, 'switched to encryption before signing in');
    assert.equal(got.auth[0], `AUTH PLAIN ${Buffer.from('\0shuttle@dealer.test\0s3cret').toString('base64')}`);
    assert.deepEqual(got.rcpt, ['RCPT TO:<pat@dealer.test>']);
    assert.match(got.data, /^Subject: Reset your password$/m);
    assert.match(got.data, /^From: "Corwin Shuttle" <shuttle@dealer.test>$/m);
    const body = Buffer.from(got.data.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString();
    assert.match(body, /https:\/\/x\.test\/reset\/abc/);
  } finally { server.close(); }
  await assert.rejects(smtpSend({ host: '127.0.0.1', port: 1, from: 'a@b.test' }, { to: 'x@y.test', subject: 's', text: 't' }, { timeoutMs: 3000 }));
  await assert.rejects(smtpSend({ host: '127.0.0.1', port, from: 'not an address' }, { to: 'x@y.test', subject: 's', text: 't' }), /from/);
});

test('forgot password: the link goes straight to the person; admins only hear about it if it cannot be sent', async () => {
  const sent = []; const texts = [];
  let failMail = false;
  const db = seedTestSite(require('../src/db').openDb(':memory:'));
  require('../src/app').ensureAdmin(db, { email: 'boss@mail.test', password: 'adminpass1', name: 'Boss' });
  const app = require('../src/app').createApp(db, { noTimers: true,
    mailer: { configured: true, config: () => ({ host: 'x', source: 'settings' }), send: async (m) => { if (failMail) throw new Error('down'); sent.push(m); } },
    sms: { configured: true, send: async (to, body) => { texts.push({ to, body }); } } });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body) => { const r = await fetch(b + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const wait = () => new Promise((r) => setTimeout(r, 150));
  try {
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@mail.test', password: 'adminpass1' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fetch(`${b}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'Pat Lee', email: 'pat@mail.test', role: 'advisor', password: 'oldpassword1', phone: '303-555-0100' }) });

    const r = await call('/api/password-reset/request', { email: 'pat@mail.test' });
    assert.deepEqual(r.data, { ok: true, auto: true });
    await wait();
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'pat@mail.test');
    const link = /https?:\/\/\S+\/reset\/(\S+)/.exec(sent[0].text);
    assert.ok(link, 'email has the link');
    assert.equal(texts.length, 1); assert.equal(texts[0].to, '+13035550100'); assert.match(texts[0].body, /\/reset\//);
    assert.equal(db.prepare("SELECT reset_requested_at FROM users WHERE email = 'pat@mail.test'").get().reset_requested_at, null, 'no admin alert needed');
    // The link works once.
    const token = link[1];
    assert.equal((await call(`/api/password-reset/${token}`, { password: 'brandnewpass1' })).status, 200);
    assert.equal((await call(`/api/password-reset/${token}`, { password: 'anotherpass12' })).status >= 400, true);
    assert.equal((await call('/api/login', { email: 'pat@mail.test', password: 'brandnewpass1' })).status, 200);

    // Unknown emails get the same answer and nothing is sent.
    assert.deepEqual((await call('/api/password-reset/request', { email: 'nobody@mail.test' })).data, { ok: true, auto: true });
    await wait(); assert.equal(sent.length, 1);

    // If sending fails (and texting too), admins are alerted instead.
    failMail = true; texts.length = 0;
    db.prepare("UPDATE users SET phone = NULL WHERE email = 'pat@mail.test'").run();
    await call('/api/password-reset/request', { email: 'pat@mail.test' }); await wait();
    assert.ok(db.prepare("SELECT reset_requested_at FROM users WHERE email = 'pat@mail.test'").get().reset_requested_at, 'admins alerted');
  } finally { srv.close(); }
});

test('email settings: admins only, password never shown, checked before saving', async () => {
  const a = client(); await a('/api/login', { body: { email: 'eve@mail.test', password: 'adminpass1' } });
  assert.equal((await a('/api/email')).data.configured, false);
  assert.equal((await a('/api/email', { method: 'PUT', body: { host: 'smtp.office365.com', port: 99, user: 'x@y.test', from: 'x@y.test' } })).status, 400);
  assert.equal((await a('/api/email', { method: 'PUT', body: { host: 'bad host!', user: 'x@y.test', from: 'x@y.test' } })).status, 400);
  const ok = await a('/api/email', { method: 'PUT', body: { host: 'smtp.office365.com', port: 587, user: 'shuttle@dealer.test', password: 'TopSecret99', from: 'shuttle@dealer.test' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.configured, true); assert.equal(ok.data.has_password, true);
  assert.ok(!JSON.stringify(ok.data).includes('TopSecret99'));
  const me = await a('/api/me');
  assert.ok(!JSON.stringify(me.data).includes('TopSecret99'), 'never sent to browsers');
  // Saving again without a password keeps the old one.
  assert.equal((await a('/api/email', { method: 'PUT', body: { host: 'smtp.office365.com', port: 587, user: 'shuttle@dealer.test', from: 'shuttle@dealer.test' } })).data.has_password, true);
  await a('/api/users', { body: { name: 'Dee', email: 'dee@mail.test', role: 'driver', password: 'driverpass1' } });
  const d = client(); await d('/api/login', { body: { email: 'dee@mail.test', password: 'driverpass1' } });
  assert.equal((await d('/api/email')).status, 403);
  assert.equal((await a('/api/email', { method: 'PUT', body: { clear: true } })).data.configured, false);
});
