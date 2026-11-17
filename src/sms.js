// The dealership's phone number, through Twilio (https://www.twilio.com): automatic customer
// texts, texts staff send from the shuttle site, and calls that show the dealership number
// instead of anyone's own phone.
// Set up in Admin → Phone & email, or with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM in .env (those win). Without it nothing is sent and staff use their own phones.
const crypto = require('node:crypto');

// US numbers: "303-555-1234" -> "+13035551234". Returns null if it can't be a phone number.
function toE164(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Twilio signs every request it sends us: HMAC-SHA1 of the full URL plus the sorted
// form fields, with the account's auth token. Anything else is refused.
function validSignature(token, url, params, signature) {
  if (!token || !signature) return false;
  const data = url + Object.keys(params || {}).sort().map((k) => k + params[k]).join('');
  const want = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(want); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// getConfig() returns { sid, token, from } saved in Admin, or null. .env wins.
function createTwilioSender(getConfig = () => null) {
  // Older callers passed the details directly.
  if (getConfig && typeof getConfig === 'object') { const fixed = getConfig; getConfig = () => fixed; }
  const cfg = () => {
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
      return { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, from: toE164(process.env.TWILIO_FROM) || process.env.TWILIO_FROM, source: 'env' };
    }
    const c = getConfig() || {};
    return c.sid && c.token && c.from ? { ...c, from: toE164(c.from) || c.from, source: 'settings' } : null;
  };
  async function post(path, fields) {
    const c = cfg();
    if (!c) throw new Error('The dealership phone number is not set up.');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/${path}`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: c.from, ...fields }),
      signal: AbortSignal.timeout(15000), // never let a slow Twilio hold things up
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
    return data.sid;
  }
  return {
    config: cfg,
    get configured() { return !!cfg(); },
    get from() { const c = cfg(); return c ? c.from : null; },
    send(to, body) { return post('Messages.json', { To: to, Body: body }); },
    // Ring `to`; when they answer, Twilio follows the TwiML (e.g. connect them to a customer).
    call(to, twiml) { return post('Calls.json', { To: to, Twiml: twiml }); },
    checkSignature(url, params, signature) { const c = cfg(); return !!c && validSignature(c.token, url, params, signature); },
  };
}

module.exports = { toE164, createTwilioSender, validSignature, xml };
