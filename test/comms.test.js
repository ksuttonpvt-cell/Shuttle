process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { validSignature } = require('../src/sms');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SID = ['A', 'C'].join('') + '0123456789abcdef'.repeat(2); // a made-up account id, built here so it doesn't look like a real one
let on = false; const texts = []; const calls = [];
const fakeSms = {
  get configured() { return on; }, get from() { return on ? '+13035550123' : null; },
  config: () => (on ? { sid: SID, token: TOKEN, from: '+13035550123', source: 'settings' } : null),
  send: async (to, body) => { texts.push({ to, body }); }, call: async (to, twiml) => { calls.push({ to, twiml }); },
  checkSignature: (url, params, sig) => on && validSignature(TOKEN, url, params, sig),
};
let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'boss@comms.test', password: 'adminpass1', name: 'Ken' });
  const app = createApp(db, { publicUrl: 'https://shuttle.test', noTimers: true, sms: fakeSms, superEmail: 'boss@comms.test', restart: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
// What Twilio would send: a signed form post.
async function twilio(path, params, { sign = true } = {}) {
  const url = `https://shuttle.test${path}`;
  const sig = sign ? require('node:crypto').createHmac('sha1', TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64') : 'nope';
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params) });
  return { status: res.status, text: await res.text() };
}

test('phone: personal or dealership number, chosen by the dealership; calls and texts in and out', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@comms.test', password: 'adminpass1' } });
  await a('/api/settings', { method: 'PATCH', body: { dealer_phone: '(303) 555-0000' } });
  await a('/api/users', { body: { name: 'Sam Driver', email: 'sam@comms.test', roles: ['driver'], password: 'password123', phone: '720-555-0111' } });
  await a('/api/users', { body: { name: 'Ann Advisor', email: 'ann@comms.test', roles: ['advisor'], password: 'password123' } });
  const sam = client(); const samMe = (await sam('/api/login', { body: { email: 'sam@comms.test', password: 'password123' } })).data.user;
  const ann = client(); await ann('/api/login', { body: { email: 'ann@comms.test', password: 'password123' } });

  // Dealership picks the dealership number before it's set up: staff still use their own phones.
  const pol = { calls: 'dealership', texts: 'dealership', customer_sees: 'line', inbound: 'ride_driver', desk: '303-555-0199' };
  assert.equal((await a('/api/phone', { method: 'PUT', body: { ...pol, desk: 'abc' } })).status, 400);
  assert.equal((await a('/api/phone', { method: 'PUT', body: pol })).status, 200);
  assert.equal((await sam('/api/me')).data.settings.phone_calls, 'personal', 'no number yet');
  const ride = (await ann('/api/rides', { body: { type: 'pickup', customer_name: 'Pat Rider', customer_phone: '(303) 555-0142', address: '1 Main St', lat: 40.01, lng: -105.27, scheduled_at: new Date(Date.now() + 3600000).toISOString(), passengers: 1 } })).data.ride;
  assert.equal((await sam(`/api/rides/${ride.id}/call`, { body: {} })).status, 409);
  let t = (await client()(`/api/public/track/${ride.track_token}`)).data;
  assert.equal(t.dealer.phone, '(303) 555-0000', 'customers see the desk until the number is set up');

  // Setting up the number: checks, and the token never comes back.
  assert.equal((await a('/api/phone', { method: 'PUT', body: { account: true, sid: 'nope', token: TOKEN, number: '303-555-0123' } })).status, 400);
  assert.equal((await a('/api/phone', { method: 'PUT', body: { account: true, sid: SID, token: 'short', number: '303-555-0123' } })).status, 400);
  const saved = await a('/api/phone', { method: 'PUT', body: { account: true, sid: SID, token: TOKEN, number: '303-555-0123' } });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.data).includes(TOKEN), 'token stays on the server');
  assert.ok(!JSON.stringify((await sam('/api/me')).data).includes(TOKEN));
  on = true; // (the fake stands in for Twilio from here)
  assert.equal((await sam('/api/me')).data.settings.phone_calls, 'dealership');
  t = (await client()(`/api/public/track/${ride.track_token}`)).data;
  assert.equal(t.dealer.phone, '(303) 555-0123', 'customers see the shuttle number');

  // Calls out: rings the staff member, shows the dealership number to the customer.
  assert.match((await ann(`/api/rides/${ride.id}/call`, { body: {} })).data.error, /mobile number/, 'needs a number on file');
  const c = await sam(`/api/rides/${ride.id}/call`, { body: {} });
  assert.equal(c.status, 200);
  assert.equal(calls.at(-1).to, '+17205550111');
  assert.match(calls.at(-1).twiml, /callerId="\+13035550123"/);
  assert.match(calls.at(-1).twiml, /<Number>\+13035550142<\/Number>/);

  // Texts out: from the dealership number, signed, kept on the ride.
  assert.equal((await sam(`/api/rides/${ride.id}/text`, { body: { body: '' } })).status, 400);
  assert.equal((await sam(`/api/rides/${ride.id}/text`, { body: { body: 'Running 5 min behind' } })).status, 200);
  assert.equal(texts.at(-1).to, '+13035550142'); assert.match(texts.at(-1).body, /Running 5 min behind\n– Sam/);
  let r = (await ann('/api/rides?scope=open')).data.rides.find((x) => x.id === ride.id);
  assert.match(r.notes, /Text to customer from Sam: Running 5 min behind/);

  // Texts in: signed by Twilio only; added to the customer's ride.
  assert.equal((await twilio('/api/phone/incoming/sms', { From: '+13035550142', Body: 'hi' }, { sign: false })).status, 403);
  assert.equal((await twilio('/api/phone/incoming/sms', { From: '+13035550142', Body: 'I am at the side door' })).status, 200);
  r = (await ann('/api/rides?scope=open')).data.rides.find((x) => x.id === ride.id);
  assert.match(r.notes, /Customer texted: I am at the side door/);

  // Calls in: before a driver, the desk; with a driver, the driver then the desk.
  let v = await twilio('/api/phone/incoming/voice', { From: '+13035550142', To: '+13035550123' });
  assert.match(v.text, /<Dial timeout="20"><Number>\+13035550199<\/Number><\/Dial>/);
  await sam(`/api/rides/${ride.id}`, { method: 'PATCH', body: { driver_id: samMe.id } });
  v = await twilio('/api/phone/incoming/voice', { From: '+13035550142', To: '+13035550123' });
  assert.match(v.text, /<Number>\+17205550111<\/Number><\/Dial><Dial timeout="20"><Number>\+13035550199/);
  // Every driver on shift.
  await a('/api/phone', { method: 'PUT', body: { ...pol, inbound: 'on_shift' } });
  const veh = (await a('/api/vehicles', { body: { name: 'Shuttle 1', seats: 6, use: 'shuttle' } })).data.vehicle;
  await sam('/api/driver/shift', { body: { on_duty: true, vehicle_id: veh.id } });
  v = await twilio('/api/phone/incoming/voice', { From: '+17205559999', To: '+13035550123' });
  assert.match(v.text, /<Number>\+17205550111<\/Number>/);
  // Desk only.
  await a('/api/phone', { method: 'PUT', body: { ...pol, inbound: 'desk' } });
  v = await twilio('/api/phone/incoming/voice', { From: '+17205559999', To: '+13035550123' });
  assert.match(v.text, /<Number>\+13035550199<\/Number>/); assert.doesNotMatch(v.text, /7205550111/);
  assert.equal((await a('/api/phone', { method: 'PUT', body: { ...pol, inbound: 'desk', desk: '' } })).status, 400, 'desk needs a number');

  // Back to personal phones.
  await a('/api/phone', { method: 'PUT', body: { calls: 'personal', texts: 'personal', customer_sees: 'desk', inbound: 'ride_driver' } });
  assert.equal((await sam('/api/me')).data.settings.phone_texts, 'personal');
  assert.equal((await sam(`/api/rides/${ride.id}/text`, { body: { body: 'hello' } })).status, 409);
  on = false;
});

test('email: a dealership mailbox, not anyone\'s own; which emails go out', async () => {
  const a = client(); await a('/api/login', { body: { email: 'boss@comms.test', password: 'adminpass1' } });
  const put = (body) => a('/api/email', { method: 'PUT', body });
  const r1 = await put({ host: 'smtp.office365.com', port: 587, user: 'shuttle@dealer.test', password: 'x', from: 'boss@comms.test' });
  assert.equal(r1.status, 400); assert.match(r1.data.error, /Ken's sign-in email/);
  assert.equal((await put({ host: 'smtp.office365.com', port: 587, user: 'sam@comms.test', password: 'x', from: 'shuttle@dealer.test' })).status, 400);
  assert.equal((await put({ host: 'smtp.office365.com', port: 587, user: 'shuttle@dealer.test', password: 'x', from: 'shuttle@dealer.test' })).status, 200);
  assert.equal((await put({ options: true, reply_to: 'ann@comms.test' })).status, 400, 'replies to a person: no');
  assert.equal((await put({ options: true, report_to: 'not-an-email' })).status, 400);
  const ok = await put({ options: true, from_name: 'Shuttle Desk', reply_to: 'service@dealer.test', report_to: 'gm@dealer.test, fixed@dealer.test', send_reset: true, send_approved: false, send_booked: true });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.from_name, ok.data.reply_to, ok.data.report_to, ok.data.send_reset, ok.data.send_approved, ok.data.send_booked], ['Shuttle Desk', 'service@dealer.test', 'gm@dealer.test, fixed@dealer.test', true, false, true]);
  assert.ok(!JSON.stringify((await a('/api/email')).data).includes('"x"'), 'password not sent back');
  const me = (await a('/api/me')).data.settings;
  assert.equal(me.report_email, undefined, 'report list is not handed to every page');
});
