// Sends email through the dealership's own email account (Microsoft 365, Gmail, or any
// provider with SMTP), using Node's built-in network and encryption, with no extra packages.
// Used for password reset links. Passwords are only ever sent over an encrypted connection.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const ADDR_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const isLocal = (host) => /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host);

// One SMTP conversation. cfg: { host, port, user, pass, from, fromName, tlsOptions }
async function smtpSend(cfg, { to, subject, text }, { timeoutMs = 20000 } = {}) {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port) || 587;
  const from = String(cfg.from || cfg.user || '').trim();
  if (!host) throw new Error('No email server is set.');
  if (!ADDR_RE.test(from)) throw new Error('The "from" address is not a valid email address.');
  if (!ADDR_RE.test(String(to || ''))) throw new Error('Not a valid email address.');

  let socket = port === 465 ? tls.connect({ host, port, servername: host, ...(cfg.tlsOptions || {}) }) : net.connect({ host, port });
  let encrypted = port === 465;
  let buf = ''; let waiting = null; const replies = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      (onData.lines = onData.lines || []).push(line);
      if (/^\d{3}( |$)/.test(line)) { // last line of a reply
        const lines = onData.lines; onData.lines = [];
        const reply = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') };
        if (waiting) { const w = waiting; waiting = null; w.resolve(reply); } else replies.push(reply);
      }
    }
  };
  let failed = null;
  const fail = (e) => { failed = failed || e; if (waiting) { const w = waiting; waiting = null; w.reject(failed); } };
  const attach = (s) => { s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new Error('The email server closed the connection.'))); };
  attach(socket);
  const timer = setTimeout(() => { fail(new Error('The email server did not answer in time.')); socket.destroy(); }, timeoutMs);
  const read = () => (replies.length ? Promise.resolve(replies.shift()) : failed ? Promise.reject(failed) : new Promise((resolve, reject) => { waiting = { resolve, reject }; }));
  const say = (line) => socket.write(`${line}\r\n`);
  async function expect(ok, line, what) {
    if (line != null) say(line);
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`${what}: ${r.code} ${r.text.split('\n')[0].slice(0, 200)}`);
    return r;
  }
  const name = 'shuttle.local';
  try {
    await expect([220], null, 'Email server greeting');
    let ehlo = await expect([250], `EHLO ${name}`, 'Email server hello');
    if (!encrypted) {
      if (/\bSTARTTLS\b/i.test(ehlo.text)) {
        await expect([220], 'STARTTLS', 'Starting encryption');
        socket.removeAllListeners('data'); socket.removeAllListeners('error'); socket.removeAllListeners('close');
        socket = tls.connect({ socket, servername: host, ...(cfg.tlsOptions || {}) });
        attach(socket);
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        encrypted = true;
        ehlo = await expect([250], `EHLO ${name}`, 'Email server hello');
      } else if (!isLocal(host)) {
        throw new Error('This email server does not offer encryption, so the password was not sent. Use port 587 or 465.');
      }
    }
    if (cfg.user) {
      const auth = (/^AUTH\b(.*)$/im.exec(ehlo.text) || [])[1] || '';
      if (/\bPLAIN\b/i.test(auth)) {
        await expect([235], `AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64')}`, 'Signing in to the email account');
      } else {
        await expect([334], 'AUTH LOGIN', 'Signing in to the email account');
        await expect([334], Buffer.from(String(cfg.user)).toString('base64'), 'Signing in to the email account');
        await expect([235], Buffer.from(String(cfg.pass || '')).toString('base64'), 'Signing in to the email account');
      }
    }
    await expect([250], `MAIL FROM:<${from}>`, 'Sender');
    await expect([250, 251], `RCPT TO:<${to}>`, 'Recipient');
    await expect([354], 'DATA', 'Message');
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
    const fromName = String(cfg.fromName || '').replace(/["\r\n]/g, '').trim();
    const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
    const msg = [
      `From: ${fromName ? `"${enc(fromName)}" ` : ''}<${from}>`, `To: <${to}>`, `Subject: ${enc(String(subject).replace(/[\r\n]/g, ' '))}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${from.split('@')[1]}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
    ].join('\r\n');
    await expect([250], `${msg}\r\n.`, 'Sending the message'); // base64 lines never start with "."
    say('QUIT');
    return { ok: true };
  } finally {
    clearTimeout(timer);
    setTimeout(() => socket.destroy(), 200).unref?.();
  }
}

// getConfig() returns the current settings (or null). Settings in .env win.
function createMailer(getConfig) {
  const cfg = () => {
    if (process.env.SMTP_HOST) {
      return { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.SMTP_FROM || process.env.SMTP_USER, fromName: process.env.SMTP_FROM_NAME, source: 'env' };
    }
    const c = getConfig() || {};
    return c.host ? { ...c, source: 'settings' } : null;
  };
  return {
    config: cfg,
    get configured() { const c = cfg(); return !!(c && c.host && (c.from || c.user)); },
    send(message, opts) { const c = cfg(); if (!c) return Promise.reject(new Error('Email is not set up.')); return smtpSend(c, message, opts); },
  };
}

module.exports = { createMailer, smtpSend, ADDR_RE };
