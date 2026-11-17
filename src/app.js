const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { hashPassword, hashPasswordAsync, verifyPasswordAsync, validatePassword, randomToken, parseCookies } = require('./auth');
const { rankRides, distanceKm } = require('./priority');
const { toE164, createTwilioSender } = require('./sms');
const { createPush } = require('./push');
const { planTrip, KM_TO_MI, STOP_MINUTES } = require('./routing');
const fs = require('node:fs');
const { createStats } = require('./serverstats');
const { createLive } = require('./live');
const tunnelKit = require('./tunnel');
const { readSheet } = require('./sheets');
const { parseFleet, FUELS } = require('./fleet');
const { createLogbook } = require('./logbook');
const { cityOf, estimatedRideMiles } = require('./places');
const { createLimits } = require('./limits');
const { createMailer, ADDR_RE } = require('./mailer');
const { createBus, coresAvailable, coresWanted } = require('./cluster');
const { createThrottle } = require('./throttle');
const { mergeSnapshots, TRAFFIC_TYPES } = require('./serverstats');

// The site's version (package.json) and the "What's new" list (changelog.json).
// Both change only with an update, which restarts the site, so they're read once.
const ROOT_DIR = path.join(__dirname, '..');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, file), 'utf8')); } catch { return fallback; } }
const APP_VERSION = String(readJson('package.json', {}).version || '0.0.0');
const CHANGELOG = (Array.isArray(readJson('changelog.json', [])) ? readJson('changelog.json', []) : [])
  .filter((e) => e && typeof e.version === 'string')
  .map((e) => ({ version: e.version, date: e.date || null, title: String(e.title || ''), changes: Array.isArray(e.changes) ? e.changes.map(String) : [] }));

const SESSION_DAYS = 14;
const RIDE_STATUSES = ['requested', 'assigned', 'en_route', 'onboard', 'completed', 'cancelled'];
const OPEN_STATUSES = ['requested', 'assigned', 'en_route', 'onboard'];

const DEFAULT_SETTINGS = {
  dealer_name: 'Corwin Toyota of Boulder',
  dealer_address: '2465 48th Ct, Boulder, CO 80301',
  dealer_phone: '',
  dealer_lat: '40.0236',
  dealer_lng: '-105.2405',
  public_requests: '1',
  customer_actions: '1', // customers can say they're running late or cancel from their tracking page
  staff_signup: '1', // new staff can ask for an account from the sign-in page (an admin approves it)
  // Driver location: always on while the driver page is open. On a low phone battery
  // (and not charging) it can share less often or pause; drivers can't switch it off
  // themselves unless allowed.
  gps_low_battery_pct: '20',
  gps_low_battery_mode: 'slow', // slow | pause | normal
  driver_gps_toggle: '0',
  timezone: 'America/Denver',
  service_radius_mi: '15.5',
  dropoff_wait_min: '30',   // drop offs leave at least this many minutes after booking, unless urgent
  auto_end_shift: '20:00', // every driver is taken off shift at this local time each day ('' = off)
  auto_sign_out: '00:00',  // everyone is signed out at this local time each day ('' = off)
  ride_offers: '1',
  discord_invite: '',       // optional "Join our Discord" link shown in the Help window
  easter_egg: '1',          // Easter egg: tacos rain for 10 seconds every Tuesday at noon
  look: 'corwin',           // 'corwin' (dealership branding) or 'classic', for everyone
  brand_color: '#eb0a1e',   // Corwin look: accent (buttons, stripes)
  brand_dark: '#0d0f12',    // Corwin look: header and banner background
  brand_name: '',           // Corwin look: name shown in the header (blank = dealership name); first word is big        // offer waiting rides to the closest free driver, who can accept or pass
  clear_customer_info: '00:00',
  backup_time: '00:30',    // nightly database backup, after customer info is cleared ('' = off) // finished rides lose their customer details at this local time each day ('' = off)
  // Automatic customer texts (only sent once Twilio is set up in .env)
  sms_booked: '1',
  sms_en_route: '1',
  sms_cancelled: '1',
};
const YES_NO_SETTINGS = ['public_requests', 'customer_actions', 'staff_signup', 'driver_gps_toggle', 'ride_offers', 'easter_egg', 'sms_booked', 'sms_en_route', 'sms_cancelled'];

function createApp(db, opts = {}) {
  const app = express();
  // Only trust forwarding headers from this same computer (the Cloudflare Tunnel program).
  // Trusting everyone let visitors fake their address to get around the sign-in and
  // request limits.
  app.set('trust proxy', 'loopback');
  // The visitor's real address: Cloudflare sends it in CF-Connecting-IP via the tunnel.
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    const fromTunnel = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    return (fromTunnel && req.get('cf-connecting-ip')) || req.ip || peer;
  };
  // Visitors reach the site over https through Cloudflare, but the tunnel hands requests
  // to this PC as plain http. Cloudflare says how the visitor connected (CF-Visitor), so
  // links, QR codes and secure sign-in cookies use https when the visitor did. This is
  // trusted however the tunnel reaches the site (this PC, another PC on the network, a
  // container): it only changes the links written for that visitor and their own cookie.
  app.use((req, res, next) => {
    const visitor = req.get('cf-visitor') || '';
    const forwarded = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
    if (/"scheme"\s*:\s*"https"/.test(visitor) || forwarded === 'https') {
      Object.defineProperty(req, 'protocol', { value: 'https' });
      Object.defineProperty(req, 'secure', { value: true });
      // Browsers that have visited over https always come back over https (no http step).
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  });
  app.use((req, res, next) => (req.path === '/api/brand/logo' || req.path === '/api/vehicles/import' ? next() : express.json({ limit: '100kb' })(req, res, next)));
  // Live numbers for Admin → Server.
  const stats = opts.stats || createStats({ timers: !opts.noTimers });
  const logbook = opts.logbook || createLogbook();
  let publicBase = opts.publicUrl || process.env.PUBLIC_URL || null; // learned from tunnel visits if not set
  app.use(stats.middleware);
  // Bandwidth limit (Admin → Server, super admins): shared out between the copies of the site.
  const throttle = createThrottle(() => {
    const mbps = Number(getSettings().server_bandwidth_mbps);
    if (!(mbps > 0)) return 0;
    return (mbps * 125000) / (Number(process.env.SHUTTLE_WORKERS) || 1); // megabits/s -> bytes/s per copy
  });
  app.use(throttle.middleware);
  // Instant updates: after any change to rides, offers, routes or drivers, tell open pages
  // right away (they still check now and then in case a message is missed).
  // With one copy of the site per processor core, changes made on one copy reach the
  // others through the bus (see cluster.js). Background jobs run in one copy only.
  const bus = opts.bus || createBus();
  const jobsHere = !opts.noTimers && bus.jobs;
  const rawLive = opts.live || createLive();
  const livePending = new Map();
  const live = {
    handler: rawLive.handler,
    get count() { return rawLive.count; },
    send(event, data = {}, to = null) { rawLive.send(event, data, to); bus.publish('live', { event, data, to }); },
    // Many changes close together become one message (e.g. a driver's location every few seconds).
    soon(event, ms = 600, data = {}, to = null) {
      const key = event + (to ? `?${to.userId}` : '');
      if (livePending.has(key)) return;
      const t = setTimeout(() => { livePending.delete(key); live.send(event, data, to); }, ms);
      t.unref?.(); livePending.set(key, t);
    },
  };
  bus.on('live', (m) => rawLive.send(m.event, m.data, m.to));
  let ridesVersion = 0;
  const ridesChanged = () => { ridesVersion++; bus.publish('changed'); };
  bus.on('changed', () => { ridesVersion++; });
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        if (!/^\/api\/(driver\/location|perf)/.test(req.path)) ridesChanged(); // shared ride lists are rebuilt
        const p = req.path;
        if (/^\/api\/(rides|public\/rides|offers|route)/.test(p)) live.soon('rides', 300);
        if (/^\/api\/driver\/location/.test(p)) live.soon('moved', 3000); // vans move: maps only (at most every 3 s)
        else if (/^\/api\/(driver\/shift|route|users|vehicles)/.test(p)) live.soon('drivers', 300);
      });
    }
    next();
  });
  app.use((req, _res, next) => {
    if (!publicBase && req.get('cf-connecting-ip') && req.get('host')) publicBase = `https://${req.get('host')}`;
    next();
  });

  // Express 4 doesn't catch errors from async handlers; an unhandled one stops the whole
  // server. Wrap every async handler so its errors go to the normal error handler instead.
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) => {
      if (!handlers.length) return original(path); // app.get('setting') reads a setting
      return original(path, ...handlers.map((h) => (typeof h === 'function' && h.constructor.name === 'AsyncFunction'
        ? (req, res, next) => h(req, res, next).catch(next) : h)));
    };
  }

  // ---------- helpers ----------
  const q = (sql) => db.prepare(sql);
  // Steps that check something and then change it (claiming a ride, taking a van, booking
  // the ride back) run as one database transaction. With a copy of the site on each core,
  // two people tapping at the same moment could otherwise both "win".
  function atomic(handler) {
    return (req, res, next) => {
      try { db.exec('BEGIN IMMEDIATE'); } catch (e) { return next(e); }
      try { handler(req, res, next); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already ended */ } next(e); }
    };
  }
  const now = () => new Date().toISOString();

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    q('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  // The Corwin look became the site's look (Nov 2026). Switch existing sites over once;
  // a later choice in Admin → Settings → Look sticks.
  if (!q("SELECT 1 FROM settings WHERE key = 'look_corwin_switched'").get()) {
    q("UPDATE settings SET value = 'corwin' WHERE key = 'look'").run();
    q("INSERT INTO settings (key, value) VALUES ('look_corwin_switched', '1')").run();
  }
  // Settings are read many times per request, so they're kept until the database changes.
  // The uploaded logo image isn't loaded here (only whether there is one).
  let settingsCache = null; let settingsAt = -1;
  function getSettings() {
    // total_changes: this copy's writes; data_version: writes by the copies on other cores.
    const changes = `${q('SELECT total_changes() AS n').get().n}|${q('PRAGMA data_version').get().data_version}`;
    if (settingsCache && changes === settingsAt) return { ...settingsCache };
    const s = {};
    for (const row of q("SELECT key, CASE WHEN key = 'brand_logo' THEN (CASE WHEN value <> '' THEN 'set' END) ELSE value END AS value FROM settings").all()) s[row.key] = row.value;
    settingsCache = s; settingsAt = changes;
    return { ...s };
  }
  // Only these settings ever leave the server (never the notification keys).
  function shareableSettings() {
    const s = getSettings(); const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
    out.logo_v = s.brand_logo ? (s.brand_logo_v || '1') : ''; // the logo itself is served from /brand/logo
    return out;
  }
  // Minutes a drop off waits after booking before the shuttle leaves (0 = none).
  const dropoffWait = () => { const n = Number(getSettings().dropoff_wait_min); return Number.isFinite(n) && n > 0 ? n : 0; };
  // How far from the dealership the shuttle will go, in miles (0 = no limit).
  const serviceRadius = () => Math.max(0, Number(getSettings().service_radius_mi) || 0);
  const milesFromDealer = (lat, lng) => distanceKm(dealerOrigin(), { lat, lng }) * 0.621371;
  function dealerOrigin() {
    const s = getSettings();
    return { lat: Number(s.dealer_lat), lng: Number(s.dealer_lng) };
  }
  function baseUrl(req) {
    let base = (opts.publicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
    // A web address set as http:// (e.g. in .env) becomes https:// for visitors who came over https.
    if (req.secure && /^http:\/\//i.test(base)) base = `https://${base.slice(7)}`;
    return base;
  }
  const publicUser = (u) => u && ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, active: !!u.active,
    on_duty: !!u.on_duty, vehicle_id: u.vehicle_id, last_lat: u.last_lat, last_lng: u.last_lng,
    last_loc_at: u.last_loc_at, created_at: u.created_at, reset_requested_at: u.reset_requested_at || null,
    signup_at: u.signup_at || null, signup_note: u.signup_note || null,
    super_admin: u.role === 'admin' && !!u.super_admin,
  });
  const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  function bad(res, msg, code = 400) { return res.status(code).json({ error: msg }); }

  const RIDE_SELECT = `
    SELECT r.*, a.name AS advisor_name, d.name AS driver_name, d.phone AS driver_phone,
           v.name AS vehicle_name, v.color AS vehicle_color, v.plate AS vehicle_plate, v.make_model AS vehicle_make_model,
           c.name AS cancelled_by_name,
           (SELECT x.id FROM rides x WHERE x.return_of = r.id AND x.status <> 'cancelled' LIMIT 1) AS return_ride_id,
           (SELECT ou.name FROM ride_offers o JOIN users ou ON ou.id = o.driver_id WHERE o.ride_id = r.id AND o.status = 'pending' LIMIT 1) AS offered_to
    FROM rides r
    LEFT JOIN users c ON c.id = r.cancelled_by
    LEFT JOIN users a ON a.id = r.advisor_id
    LEFT JOIN users d ON d.id = r.driver_id
    LEFT JOIN vehicles v ON v.id = r.vehicle_id`;

  function withLinks(req, ride) {
    return ride && { ...ride, track_url: `${baseUrl(req)}/t/${ride.track_token}` };
  }

  // ---------- times in the dealership's time zone ----------
  function tz() {
    const zone = getSettings().timezone || 'America/Denver';
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return 'America/Denver'; }
  }
  const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date(iso)); // YYYY-MM-DD

  // ---------- automatic customer texts ----------
  const sms = opts.sms || createTwilioSender();

  // ---------- driver phone notifications ----------
  const push = createPush(db, { sender: opts.pushSender });
  // ---------- customer links ----------
  // Tracking links use a short code: 8 letters and digits that can't be mixed up
  // (no 0/O, 1/I/L or U), e.g. corwinshuttleservice.com/t/K7M2Q9XA. Upper or lower case both work.
  const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
  function newTrackCode() {
    for (;;) {
      let c = ''; for (let i = 0; i < 8; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!q('SELECT 1 FROM rides WHERE track_token = ?').get(c)) return c;
    }
  }
  // Links sent before short codes keep working (they're matched exactly).
  const trackCode = (t) => { const v = String(t || '').trim(); return CODE_RE.test(v.toUpperCase()) ? v.toUpperCase() : v; };
  // QR codes: links written in capitals fit QR's simpler "alphanumeric" mode, so the code has
  // fewer, bigger squares and scans faster. Only for links where capitals work the same.
  function qrText(url) {
    const m = /^(https?:\/\/[^/?#]+)\/(t\/([^/?#]+)|request)$/i.exec(url);
    if (!m || (m[3] && !CODE_RE.test(m[3].toUpperCase()))) return url;
    return url.toUpperCase();
  }

  const rideLine = (r) => `${r.customer_name} — ${r.type === 'pickup' ? 'Pick up' : 'Drop off'} ${fmtWhen(r.scheduled_at)}${r.address ? ` · ${r.address}` : ''}`;
  const quietly = (p) => Promise.resolve(p).catch((e) => console.error('Notification failed:', e.message));
  function pushNewRide(rideId) {
    const r = q('SELECT * FROM rides WHERE id = ?').get(rideId);
    if (r) quietly(push.notifyOnDutyDrivers({ title: '🚐 New shuttle ride', body: rideLine(r), tag: `ride-${r.id}` }));
    scheduleOfferSweep();
  }
  function smsMessage(event, ride, trackUrl) {
    const s = getSettings();
    const first = (ride.customer_name || '').split(' ')[0] || 'there';
    const dealer = s.dealer_name;
    const call = s.dealer_phone ? ` Questions? Call ${s.dealer_phone}.` : '';
    const what = ride.type === 'pickup' ? 'shuttle pick up' : 'shuttle ride from the dealership';
    if (event === 'booked') return `Hi ${first}, your ${dealer} ${what} is booked for ${fmtWhen(ride.scheduled_at)}. Track your driver here: ${trackUrl}`;
    if (event === 'en_route') {
      const veh = [ride.vehicle_color, ride.vehicle_make_model].filter(Boolean).join(' ') || ride.vehicle_name;
      const driver = ride.driver_name ? ride.driver_name.split(' ')[0] : 'Your driver';
      return `${dealer}: ${driver} is on the way${veh ? ` in a ${veh}` : ''}${ride.vehicle_plate ? ` (plate ${ride.vehicle_plate})` : ''}. Track: ${trackUrl}`;
    }
    if (event === 'cancelled') return `${dealer}: your shuttle ride for ${fmtWhen(ride.scheduled_at)} has been cancelled.${call}`;
    return null;
  }
  const smsLog = (rideId, event, to, body, status, error) =>
    q('INSERT INTO sms_log (ride_id, event, to_number, body, status, error) VALUES (?, ?, ?, ?, ?, ?)').run(rideId, event, to, body, status, error || null);
  // Sends in the background so a slow or failed text never holds up the page.
  function notifyCustomer(rideId, event, trackBase) {
    if (!sms.configured || getSettings()[`sms_${event}`] !== '1') return null;
    const ride = q(`${RIDE_SELECT} WHERE r.id = ?`).get(rideId);
    if (!ride) return null;
    const body = smsMessage(event, ride, `${trackBase}/t/${ride.track_token}`);
    const to = toE164(ride.customer_phone);
    if (!to) { smsLog(ride.id, event, ride.customer_phone, body, 'skipped', 'No valid mobile number'); return null; }
    return Promise.resolve()
      .then(() => sms.send(to, body))
      .then(() => smsLog(ride.id, event, to, body, 'sent'))
      .catch((e) => { smsLog(ride.id, event, to, body, 'failed', e.message); console.error('Text failed:', e.message); });
  }

  // ---------- auth middleware ----------
  app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, now());
      if (row) { req.user = row; req.sessionToken = token; stats.sawUser(row); }
    }
    next();
  });
  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return bad(res, 'Please sign in.', 401);
    if (roles.length && !roles.includes(req.user.role) && req.user.role !== 'admin') return bad(res, 'Not allowed.', 403);
    next();
  };

  // ---------- super admins ----------
  // The Server page (health, logs, updates, restart, backups) is for super admins only.
  // The admin named in .env (ADMIN_EMAIL) is always one; if there are none, the first admin is.
  (function ensureSuperAdmin() {
    const email = opts.superEmail !== undefined ? opts.superEmail : process.env.ADMIN_EMAIL;
    if (email) q("UPDATE users SET super_admin = 1 WHERE email = ? AND role = 'admin'").run(email);
    if (!q("SELECT 1 FROM users WHERE super_admin = 1 AND role = 'admin' AND active = 1").get()) {
      const first = q("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
      if (first) q('UPDATE users SET super_admin = 1 WHERE id = ?').run(first.id);
    }
  })();
  const isSuper = (u) => !!u && u.role === 'admin' && !!u.super_admin;
  app.use(['/api/server', '/api/version', '/api/updates'], (req, res, next) => {
    if (!req.user) return bad(res, 'Please sign in.', 401);
    if (!isSuper(req.user)) return bad(res, 'Only a super admin can use the Server page.', 403);
    next();
  });

  // Sign-in throttle: 10 wrong passwords per 15 min from one address for one email, and
  // 30 per 15 min for one email from anywhere (stops guessing spread over many addresses).
  // Counted in the database, so the limits hold across every copy of the site.
  const limits = createLimits(db);
  const LOGIN_WINDOW = 15 * 60000;
  const throttled = (key, limit = 10) => limits.count(`login|${key}`, LOGIN_WINDOW) >= limit;
  const recordFailure = (key) => limits.hit(`login|${key}`, LOGIN_WINDOW);

  function setSessionCookie(req, res, token, maxAgeSec) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`);
  }

  // ---------- auth routes ----------
  app.post('/api/login', async (req, res) => {
    const email = str(req.body.email, 200);
    const password = String(req.body.password || '').slice(0, 200);
    if (!email || !password) return bad(res, 'Enter your email and password.');
    const key = `${clientIp(req)}|${email.toLowerCase()}`;
    const emailKey = `any|${email.toLowerCase()}`;
    if (throttled(key) || throttled(emailKey, 30)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
    const user = q('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await verifyPasswordAsync(password, user && user.password_hash); // same time whether or not the email exists
    if (user && ok && !user.active && user.signup_at) {
      return bad(res, 'Your account is waiting for a shuttle admin to approve it. You can sign in as soon as they do.', 403);
    }
    if (!user || !user.active || !ok) {
      recordFailure(key); recordFailure(emailKey);
      return bad(res, 'Email or password is incorrect.', 401);
    }
    limits.clear(`login|${key}`);
    const token = randomToken(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) q('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.get('/healthz', (req, res) => { q('SELECT 1').get(); res.json({ ok: true }); });
  app.get('/api/events', requireRole(), (req, res) => live.handler(req, res, req.user));
  app.locals.live = live;

  app.get('/api/me', (req, res) => {
    const isAdmin = req.user?.role === 'admin';
    res.json({ user: publicUser(req.user) || null, settings: shareableSettings(), base_url: baseUrl(req), ...(isAdmin ? { version: APP_VERSION } : {}) });
  });

  app.post('/api/me/password', requireRole(), async (req, res) => {
    const { current, next: nextPw } = req.body;
    const key = `pw|${req.user.id}`;
    if (throttled(key)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
    if (!(await verifyPasswordAsync(String(current || '').slice(0, 200), req.user.password_hash))) {
      recordFailure(key);
      return bad(res, 'Current password is incorrect.');
    }
    const err = validatePassword(nextPw);
    if (err) return bad(res, err);
    q('UPDATE users SET password_hash = ?, reset_requested_at = NULL WHERE id = ?').run(await hashPasswordAsync(nextPw), req.user.id);
    q('DELETE FROM password_resets WHERE user_id = ?').run(req.user.id);
    q('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // ---------- forgot password ----------
  // There's no email server, so "Forgot password?" alerts the admins, and an admin sends the
  // person a one-time reset link (valid 24 hours) by text, QR code or however they like.
  const RESET_HOURS = 24;
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  function validReset(token) {
    if (!token || String(token).length > 100) return null;
    return q(`SELECT u.*, r.token_hash FROM password_resets r JOIN users u ON u.id = r.user_id
              WHERE r.token_hash = ? AND r.expires_at > ? AND u.active = 1`).get(hashToken(token), now()) || null;
  }

  // ---------- email (for password reset links) ----------
  // The dealership's own email account. The password is kept on the server only.
  const mailer = opts.mailer || createMailer(() => {
    const s = getSettings();
    return s.smtp_host ? { host: s.smtp_host, port: s.smtp_port, user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user, fromName: s.smtp_from_name || s.dealer_name } : null;
  });
  const SELF_RESET_MIN = 60; // a link sent straight to the person works for an hour
  // "Forgot password": the reset link goes straight to the person by email (and by text if
  // texting is set up and they have a phone number). If neither can be sent, admins are
  // alerted to send one, as before. Same answer whether or not the email has an account.
  app.post('/api/password-reset/request', (req, res) => {
    const email = str(req.body.email, 200);
    if (!email) return bad(res, 'Enter your email.');
    const ipKey = `reset|${clientIp(req)}`;
    if (throttled(ipKey, 5)) return bad(res, 'Too many requests. Try again in 15 minutes.', 429);
    recordFailure(ipKey);
    const auto = mailer.configured || sms.configured;
    res.json({ ok: true, auto });
    const user = q('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user) return;
    const base = baseUrl(req);
    (async () => {
      let sentBy = [];
      const key = `resetsend|${user.id}`;
      if (auto && limits.count(key, 3600000) < 4) { // at most 4 links an hour per person
        limits.hit(key, 3600000);
        const token = randomToken(24);
        q('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, now()); // only the newest link works
        q('INSERT INTO password_resets (token_hash, user_id, expires_at, created_by) VALUES (?, ?, ?, NULL)')
          .run(hashToken(token), user.id, new Date(Date.now() + SELF_RESET_MIN * 60000).toISOString());
        const url = `${base}/reset/${token}`;
        const dealer = getSettings().dealer_name || 'Shuttle';
        const jobs = [];
        if (mailer.configured) {
          jobs.push(mailer.send({ to: user.email, subject: `Reset your ${dealer} shuttle password`,
            text: `Hi ${user.name.split(' ')[0]},\n\nSomeone (hopefully you) asked to reset your shuttle password. Tap this link to choose a new one:\n\n${url}\n\nIt works once, for the next hour.\n\nDidn't ask? You can ignore this email; your password stays the same.\n\n${dealer} shuttle` })
            .then(() => sentBy.push('email'), (e) => console.error(new Date().toLocaleString(), `[reset] Email to ${user.name} failed: ${e.message}`)));
        }
        const phone = toE164(user.phone || '');
        if (sms.configured && phone) {
          jobs.push(sms.send(phone, `${dealer} shuttle: reset your password here (works once, for 1 hour): ${url} Didn't ask? Ignore this.`)
            .then(() => sentBy.push('text'), (e) => console.error(new Date().toLocaleString(), `[reset] Text to ${user.name} failed: ${e.message}`)));
        }
        await Promise.all(jobs);
        sentBy = [...new Set(sentBy)];
        if (sentBy.length) { console.log(new Date().toLocaleString(), `[reset] Reset link sent to ${user.name} by ${sentBy.join(' and ')}.`); return; }
      }
      // Nothing could be sent: alert admins (once an hour per person, so it can't be used to spam them).
      if (!(user.reset_requested_at && Date.now() - new Date(user.reset_requested_at) < 3600000)) {
        q('UPDATE users SET reset_requested_at = ? WHERE id = ?').run(now(), user.id);
        const admins = q("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map((a) => a.id);
        quietly(push.notifyUsers(admins, { title: '🔑 Password reset requested', body: `${user.name} (${user.email}) forgot their password. Open Admin → Staff & logins to send a reset link.`, tag: `reset-${user.id}`, url: '/admin#users' }));
        live.soon('drivers', 300); // the staff list shows the request
      }
    })().catch((e) => console.error('Password reset failed:', e.message));
  });

  // Admin → Settings → Email: set up, test, or remove the email account used for reset links.
  const emailInfo = () => {
    const c = mailer.config();
    return { configured: mailer.configured, from_env: !!(c && c.source === 'env'), host: c?.host || '', port: Number(c?.port) || 587, user: c?.user || '', from: c?.from || '', has_password: !!(c && c.pass), texting: sms.configured };
  };
  app.get('/api/email', requireRole('admin'), (req, res) => res.json(emailInfo()));
  app.put('/api/email', requireRole('admin'), (req, res) => {
    const b = req.body || {};
    const set = (k, v) => (v ? q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) : q('DELETE FROM settings WHERE key = ?').run(k));
    if (b.clear) { for (const k of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from']) set(k, ''); return res.json(emailInfo()); }
    const host = str(b.host, 200); const user = str(b.user, 200); const from = str(b.from, 200) || user;
    const port = Number(b.port) || 587;
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) return bad(res, 'Enter the email server, like smtp.office365.com.');
    if (![25, 465, 587, 2525].includes(port)) return bad(res, 'Use port 587 (most common) or 465.');
    if (user && !ADDR_RE.test(user) && user.length < 2) return bad(res, 'Enter the email account to sign in with.');
    if (!from || !ADDR_RE.test(from)) return bad(res, 'Enter the email address the links come from.');
    set('smtp_host', host); set('smtp_port', String(port)); set('smtp_user', user || ''); set('smtp_from', from);
    if (b.password) set('smtp_pass', String(b.password).slice(0, 300)); // blank keeps the saved one
    console.log(new Date().toLocaleString(), `[server] ${req.user.name} set up email for reset links (${host}).`);
    res.json(emailInfo());
  });
  app.post('/api/email/test', requireRole('admin'), async (req, res) => {
    if (!mailer.configured) return bad(res, 'Set up the email account first.');
    const to = str(req.body && req.body.to, 200) || req.user.email;
    try {
      await mailer.send({ to, subject: 'Shuttle test email', text: `This is a test from the ${getSettings().dealer_name || ''} shuttle site. Password reset links will be sent like this.` }, { timeoutMs: 15000 });
      res.json({ ok: true, message: `Sent to ${to}. Check that inbox (and spam).` });
    } catch (e) { bad(res, `Couldn't send: ${e.message}`, 502); }
  });

  app.post('/api/users/:id/reset-link', requireRole('admin'), (req, res) => {
    const user = q('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) return bad(res, 'User not found.', 404);
    if (!user.active) return bad(res, 'Enable this account first.');
    const token = randomToken(24);
    const expires = new Date(Date.now() + RESET_HOURS * 3600000).toISOString();
    q('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, now()); // only the newest link works
    q('INSERT INTO password_resets (token_hash, user_id, expires_at, created_by) VALUES (?, ?, ?, ?)').run(hashToken(token), user.id, expires, req.user.id);
    q('UPDATE users SET reset_requested_at = NULL WHERE id = ?').run(user.id);
    res.json({ url: `${baseUrl(req)}/reset/${token}`, expires_at: expires, user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  app.post('/api/users/:id/dismiss-reset', requireRole('admin'), (req, res) => {
    q('UPDATE users SET reset_requested_at = NULL WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/password-reset/:token', (req, res) => {
    const user = validReset(req.params.token);
    if (!user) return bad(res, 'This reset link has expired or was already used. Ask a shuttle admin for a new one.', 404);
    res.json({ name: user.name, email: user.email });
  });

  app.post('/api/password-reset/:token', async (req, res) => {
    const ipKey = `resetuse|${clientIp(req)}`;
    if (throttled(ipKey, 20)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
    const user = validReset(req.params.token);
    if (!user) { recordFailure(ipKey); return bad(res, 'This reset link has expired or was already used. Ask a shuttle admin for a new one.', 404); }
    const err = validatePassword(req.body.password);
    if (err) return bad(res, err);
    const hash = await hashPasswordAsync(String(req.body.password));
    // Check again after the slow hash so two taps can't both use the link.
    if (!q('SELECT 1 FROM password_resets WHERE token_hash = ?').get(user.token_hash)) return bad(res, 'This reset link was already used.', 404);
    q('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    q('UPDATE users SET password_hash = ?, reset_requested_at = NULL WHERE id = ?').run(hash, user.id);
    q('DELETE FROM sessions WHERE user_id = ?').run(user.id); // sign out every old device
    const token = randomToken(32);
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
    res.json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  // ---------- users (admin) ----------
  // Staff list with emails and phone numbers: admins only.
  app.get('/api/users', requireRole('admin'), (req, res) => {
    const rows = q('SELECT * FROM users ORDER BY role, name').all();
    res.json({ users: rows.map(publicUser) });
  });

  // ---------- asking for an account (sign-in page) ----------
  // New staff fill in their details and pick a password; the account stays off until an
  // admin approves it (and picks the role). Nobody can ask to be an admin. Same answer
  // whether or not the email already has an account.
  app.post('/api/signup', async (req, res) => {
    if (getSettings().staff_signup === '0') return bad(res, 'Ask a shuttle admin to make your account.', 403);
    const b = req.body || {};
    const name = str(b.name, 100); const email = str(b.email, 200); const role = b.role;
    if (!name || name.length < 2) return bad(res, 'Enter your name.');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter a valid email.');
    if (!['advisor', 'driver'].includes(role)) return bad(res, 'Pick Advisor or Driver.');
    const err = validatePassword(b.password);
    if (err) return bad(res, err);
    const key = `signup|${clientIp(req)}`;
    if (limits.count(key, 3600000) >= 5) return bad(res, 'Too many requests from here. Try again later, or ask a shuttle admin.', 429);
    limits.hit(key, 3600000);
    const hash = await hashPasswordAsync(b.password);
    const done = { ok: true, message: 'Thanks! A shuttle admin will look at your request. Once they approve it, sign in with this email and password.' };
    if (q('SELECT id FROM users WHERE email = ?').get(email)) return res.json(done);
    let id;
    try {
      id = Number(q('INSERT INTO users (name, email, phone, role, password_hash, active, signup_at, signup_note) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
        .run(name, email, str(b.phone, 40), role, hash, now(), str(b.note, 300)).lastInsertRowid);
    } catch { return res.json(done); } // the same email at the same moment
    const admins = q("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map((a) => a.id);
    quietly(push.notifyUsers(admins, { title: '🙋 New account request', body: `${name} (${email}) wants to be a ${role}. Open Admin → Staff & logins to approve.`, tag: `signup-${id}`, url: '/admin#users' }));
    console.log(new Date().toLocaleString(), `[staff] ${name} asked for a ${role} account.`);
    live.soon('drivers', 300);
    res.json(done);
  });
  app.post('/api/users/:id/approve', requireRole('admin'), (req, res) => {
    const u = q('SELECT * FROM users WHERE id = ? AND signup_at IS NOT NULL').get(Number(req.params.id));
    if (!u) return bad(res, 'Request not found.', 404);
    const role = ['admin', 'advisor', 'driver'].includes(req.body && req.body.role) ? req.body.role : u.role;
    q('UPDATE users SET active = 1, role = ?, signup_at = NULL, signup_note = NULL WHERE id = ?').run(role, u.id);
    console.log(new Date().toLocaleString(), `[staff] ${req.user.name} approved ${u.name} as ${role}.`);
    if (mailer.configured) {
      const dealer = getSettings().dealer_name || 'Shuttle';
      mailer.send({ to: u.email, subject: `Your ${dealer} shuttle account is ready`,
        text: `Hi ${u.name.split(' ')[0]},\n\nYour shuttle account has been approved. Sign in here with your email and the password you chose:\n\n${baseUrl(req)}/login\n\n${dealer} shuttle` })
        .catch((e) => console.error(new Date().toLocaleString(), `[staff] Approval email to ${u.name} failed: ${e.message}`));
    }
    res.json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(u.id)), emailed: mailer.configured });
  });
  app.post('/api/users/:id/decline', requireRole('admin'), (req, res) => {
    const u = q('SELECT * FROM users WHERE id = ? AND signup_at IS NOT NULL AND active = 0').get(Number(req.params.id));
    if (!u) return bad(res, 'Request not found.', 404);
    q('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(new Date().toLocaleString(), `[staff] ${req.user.name} declined ${u.name}'s account request.`);
    res.json({ ok: true });
  });

  app.post('/api/users', requireRole('admin'), async (req, res) => {
    const name = str(req.body.name, 100);
    const email = str(req.body.email, 200);
    const role = req.body.role;
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Name and a valid email are required.');
    if (!['admin', 'advisor', 'driver'].includes(role)) return bad(res, 'Pick a role.');
    const err = validatePassword(req.body.password);
    if (err) return bad(res, err);
    if (q('SELECT id FROM users WHERE email = ?').get(email)) return bad(res, 'That email already has an account.');
    const r = q('INSERT INTO users (name, email, phone, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, str(req.body.phone, 40), role, await hashPasswordAsync(req.body.password));
    res.status(201).json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
  });

  app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
    const user = q('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) return bad(res, 'User not found.', 404);
    const origEmail = String(user.email || '').toLowerCase();
    const b = req.body;
    if (b.email != null) {
      const email = str(b.email, 200);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter a valid email.');
      const clash = q('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, user.id);
      if (clash) return bad(res, 'That email already has an account.');
      user.email = email;
    }
    if (b.name != null) user.name = str(b.name, 100) || user.name;
    if (b.phone !== undefined) user.phone = str(b.phone, 40);
    if (b.role != null) {
      if (!['admin', 'advisor', 'driver'].includes(b.role)) return bad(res, 'Pick a role.');
      if (user.id === req.user.id && b.role !== 'admin') return bad(res, "You can't remove your own admin access.");
      if (b.role !== 'admin' && user.super_admin && !isSuper(req.user)) return bad(res, 'Only a super admin can change a super admin.', 403);
      user.role = b.role;
      if (user.role !== 'admin') user.super_admin = 0;
    }
    if (b.super_admin != null) {
      if (!isSuper(req.user)) return bad(res, 'Only a super admin can give or remove super admin.', 403);
      if (user.id === req.user.id && !b.super_admin) return bad(res, "You can't remove your own super admin access.");
      if (b.super_admin && user.role !== 'admin') return bad(res, 'Only admins can be super admins.');
      user.super_admin = b.super_admin ? 1 : 0;
    }
    const emailChanged = b.email != null && String(b.email).trim().toLowerCase() !== origEmail;
    if ((b.active != null || b.password || emailChanged) && user.super_admin && user.id !== req.user.id && !isSuper(req.user)) {
      return bad(res, "Only a super admin can change another super admin's sign-in.", 403);
    }
    if (b.active != null) {
      if (user.id === req.user.id && !b.active) return bad(res, "You can't deactivate yourself.");
      user.active = b.active ? 1 : 0;
    }
    q('UPDATE users SET name=?, email=?, phone=?, role=?, active=?, super_admin=? WHERE id=?')
      .run(user.name, user.email, user.phone, user.role, user.active, user.super_admin ? 1 : 0, user.id);
    if (user.active) q('UPDATE users SET signup_at = NULL, signup_note = NULL WHERE id = ?').run(user.id); // turned on = approved
    if (b.password) {
      const err = validatePassword(b.password);
      if (err) return bad(res, err);
      q('UPDATE users SET password_hash = ?, reset_requested_at = NULL WHERE id = ?').run(await hashPasswordAsync(b.password), user.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      q('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    }
    if (!user.active) q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  // ---------- vehicles ----------
  const VEHICLE_FIELDS = ['name', 'make_model', 'year', 'color', 'plate', 'vin', 'seats', 'mileage', 'status', 'notes', 'fuel', 'use'];
  function cleanVehicle(b, existing = {}) {
    const v = { ...existing };
    for (const f of VEHICLE_FIELDS) {
      if (b[f] === undefined) continue;
      v[f] = ['year', 'seats', 'mileage'].includes(f) ? num(b[f]) : str(b[f], 300);
    }
    if (!v.name) return { error: 'Vehicle name is required (e.g. "Shuttle 1").' };
    if (!['available', 'maintenance', 'retired'].includes(v.status || 'available')) return { error: 'Bad status.' };
    if (v.fuel && !FUELS.includes(v.fuel)) return { error: 'Pick gas, hybrid, plug-in hybrid or electric.' };
    if (!v.fuel) v.fuel = null;
    v.use = v.use === 'loaner' ? 'loaner' : 'shuttle';
    v.status = v.status || 'available';
    v.seats = v.seats || 7;
    return { v };
  }

  app.get('/api/vehicles', requireRole(), (req, res) => {
    const rows = q(`SELECT v.*, u.name AS driver_name, u.id AS driver_id FROM vehicles v
                    LEFT JOIN users u ON u.vehicle_id = v.id AND u.on_duty = 1
                    ORDER BY v.status = 'retired', v.name`).all();
    res.json({ vehicles: rows });
  });

  app.post('/api/vehicles', requireRole('admin'), (req, res) => {
    const { v, error } = cleanVehicle(req.body);
    if (error) return bad(res, error);
    const r = q(`INSERT INTO vehicles (${VEHICLE_FIELDS.join(',')}) VALUES (${VEHICLE_FIELDS.map(() => '?').join(',')})`)
      .run(...VEHICLE_FIELDS.map((f) => v[f] ?? null));
    res.status(201).json({ vehicle: q('SELECT * FROM vehicles WHERE id = ?').get(r.lastInsertRowid) });
  });

  app.patch('/api/vehicles/:id', requireRole('admin'), (req, res) => {
    const existing = q('SELECT * FROM vehicles WHERE id = ?').get(Number(req.params.id));
    if (!existing) return bad(res, 'Vehicle not found.', 404);
    const { v, error } = cleanVehicle(req.body, existing);
    if (error) return bad(res, error);
    q(`UPDATE vehicles SET ${VEHICLE_FIELDS.map((f) => `${f}=?`).join(',')} WHERE id = ?`)
      .run(...VEHICLE_FIELDS.map((f) => v[f] ?? null), existing.id);
    res.json({ vehicle: q('SELECT * FROM vehicles WHERE id = ?').get(existing.id) });
  });

  // Import the dealership's vehicle list (.xlsx or .csv). Matched by VIN: new vehicles are
  // added as loaners, except service-department ones (status "Service"), which are added as
  // shuttles; flip any of them with one tap. Existing ones get their plate,
  // mileage and status updated. Fuel, seats and Shuttle/Loaner you've set are kept.
  // Vehicles missing from the list are left as they are.
  app.post('/api/vehicles/import', requireRole('admin'), express.json({ limit: '15mb' }), (req, res) => {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(String(req.body.data || ''));
    if (!m) return bad(res, 'Choose the vehicle list file (.xlsx or .csv).');
    let parsed;
    try { parsed = parseFleet(readSheet(Buffer.from(m[2], m[1] ? 'base64' : 'utf8'), String(req.body.filename || ''))); }
    catch (e) { return bad(res, e.message); }
    if (!parsed.vehicles.length) return bad(res, 'No vehicles with a VIN were found in that file.');
    const plan = parsed.vehicles.map((v) => {
      const old = q('SELECT * FROM vehicles WHERE UPPER(vin) = ?').get(v.vin);
      if (!old) return { action: 'add', v };
      const changes = {};
      for (const k of ['plate', 'year', 'make_model', 'mileage', 'status', 'fleet_id', 'fleet_status']) if (v[k] != null && v[k] !== old[k]) changes[k] = v[k];
      if (!old.fuel && v.fuel) changes.fuel = v.fuel;
      return { action: Object.keys(changes).length ? 'update' : 'same', v, old, changes };
    });
    const summary = { found: plan.length, add: plan.filter((p) => p.action === 'add').length, update: plan.filter((p) => p.action === 'update').length,
      same: plan.filter((p) => p.action === 'same').length, skipped: parsed.skipped };
    const rows = plan.map((p) => ({ action: p.action, name: p.old ? p.old.name : p.v.name, make_model: p.v.make_model, year: p.v.year, plate: p.v.plate,
      fuel: p.old?.fuel || p.v.fuel, status: p.v.status, fleet_status: p.v.fleet_status, use: p.old ? p.old.use : p.v.use, changes: Object.keys(p.changes || {}) }));
    if (req.body.preview) return res.json({ summary, rows });
    const add = q(`INSERT INTO vehicles (name, make_model, year, plate, vin, seats, mileage, status, fuel, use, fleet_id, fleet_status, color)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of plan) {
        if (p.action === 'add') add.run(p.v.name, p.v.make_model, p.v.year, p.v.plate, p.v.vin, p.v.seats, p.v.mileage, p.v.status, p.v.fuel, p.v.use, p.v.fleet_id, p.v.fleet_status, p.v.color);
        else if (p.action === 'update') {
          const keys = Object.keys(p.changes);
          q(`UPDATE vehicles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => p.changes[k]), p.old.id);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return bad(res, `Import failed, nothing was changed: ${e.message}`, 500); }
    console.log(new Date().toLocaleString(), `[vehicles] ${req.user.name} imported the vehicle list: ${summary.add} added, ${summary.update} updated.`);
    res.json({ summary, rows });
  });

  app.delete('/api/vehicles/:id', requireRole('admin'), (req, res) => {
    q('DELETE FROM vehicles WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- drivers: shift + location ----------
  app.post('/api/driver/shift', requireRole('driver'), atomic((req, res) => {
    const onDuty = !!req.body.on_duty;
    let vehicleId = num(req.body.vehicle_id);
    if (onDuty) {
      if (!vehicleId) return bad(res, 'Pick the vehicle you are driving.');
      const v = q('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
      if (!v || v.status !== 'available') return bad(res, 'That vehicle is not available.');
      if (v.use === 'loaner') return bad(res, "That's a loaner, not a shuttle. An admin can mark it as a shuttle under Vehicles.");
      const taken = q('SELECT name FROM users WHERE vehicle_id = ? AND on_duty = 1 AND id <> ?').get(vehicleId, req.user.id);
      if (taken) return bad(res, `${taken.name} is already driving that vehicle.`);
    } else vehicleId = null;
    q('UPDATE users SET on_duty = ?, vehicle_id = ? WHERE id = ?').run(onDuty ? 1 : 0, vehicleId, req.user.id);
    if (!onDuty) {
      q('UPDATE users SET route_json = NULL WHERE id = ?').run(req.user.id);
      q("UPDATE ride_offers SET status = 'expired', responded_at = ? WHERE driver_id = ? AND status = 'pending'").run(now(), req.user.id);
    }
    scheduleOfferSweep();
    res.json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  }));

  app.post('/api/driver/location', requireRole('driver'), (req, res) => {
    const lat = num(req.body.lat); const lng = num(req.body.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad(res, 'Bad location.');
    const heading = num(req.body.heading); const speed = num(req.body.speed);
    const bl = num(req.body.battery); // 0–100 (phones that tell), with "+" when charging
    const battery = bl != null && bl >= 0 && bl <= 100 ? `${Math.round(bl)}${req.body.charging ? '+' : ''}` : null;
    // Odometer: add the distance since the last report (on shift, gaps up to 5 minutes,
    // ignoring GPS jitter under 20 m and impossible jumps).
    const u = req.user;
    if (u.on_duty && u.last_lat != null && u.last_loc_at) {
      const dt = (Date.now() - new Date(u.last_loc_at)) / 1000;
      const meters = distanceKm({ lat: u.last_lat, lng: u.last_lng }, { lat, lng }) * 1000;
      const mph = dt > 0 ? (meters / dt) * 2.237 : 0;
      if (dt > 0 && dt <= 300 && mph <= 95 && meters >= 20) {
        q(`INSERT INTO driver_days (driver_id, day, miles, moving_s) VALUES (?, ?, ?, ?)
           ON CONFLICT(driver_id, day) DO UPDATE SET miles = miles + excluded.miles, moving_s = moving_s + excluded.moving_s`)
          .run(u.id, localDate(now()), meters / 1609.344, mph >= 3 ? Math.round(dt) : 0);
      }
    }
    q('UPDATE users SET last_lat = ?, last_lng = ?, last_loc_at = ?, last_heading = ?, last_speed = ?, last_battery = ? WHERE id = ?')
      .run(lat, lng, now(), heading != null && heading >= 0 && heading <= 360 ? heading : null, speed != null && speed >= 0 && speed < 100 ? speed : null, battery, req.user.id);
    scheduleOfferSweep();
    res.json({ ok: true });
  });

  // ---------- live map + planned routes ----------
  // A saved route, minus stops whose ride is finished, cancelled or handed to someone else.
  function liveRoute(user) {
    if (!user.route_json) return null;
    let route; try { route = JSON.parse(user.route_json); } catch { return null; }
    // Every ride on the route: its own stops, and riders listed at dealership stops.
    const ids = [...new Set(route.stops.flatMap((x) => [x.ride_id, ...(x.drop_ids || []), ...(x.load_ids || [])]).filter(Boolean))];
    if (!ids.length) return route;
    const rows = q(`SELECT id, type, status FROM rides WHERE id IN (${ids.map(() => '?').join(',')})
                    AND status IN ('requested','assigned','en_route','onboard') AND (driver_id = ? OR driver_id IS NULL)`).all(...ids, user.id);
    const open = new Map(rows.map((r) => [r.id, r]));
    // A dealership stop along the way is done once the people it was for are off (picked-up
    // customers finished) and on (drop-off customers riding). The last stop always stays.
    const last = route.stops[route.stops.length - 1];
    const dealerDone = (x) => (x.drop_ids || []).every((id) => !open.has(id)) && (x.load_ids || []).every((id) => !open.has(id) || open.get(id).status === 'onboard');
    const stopLeft = (x) => open.has(x.ride_id) && !(x.kind === 'pickup' && open.get(x.ride_id).status === 'onboard'); // picked up = that stop is done
    route.stops = route.stops.filter((x) => (x.ride_id ? stopLeft(x) : x === last || !x.drop_ids || !dealerDone(x)));
    if (!rows.length) return null; // every ride on it is done
    // Older saved routes: the "collect drop-off customers" stop is done once they're all on board.
    const waiting = rows.some((r) => r.type === 'dropoff' && r.status !== 'onboard');
    if (!waiting && route.stops.length > 1 && route.stops[0].kind === 'dealer' && !route.stops[0].drop_ids) route.stops.shift();
    return aheadOnly(route, user);
  }
  // A driver's location counts only if it's recent (the phone may have stopped sharing hours ago).
  const FRESH_MS = 10 * 60000;
  const freshSpot = (u) => (u && u.last_lat != null && u.last_loc_at && Date.now() - new Date(u.last_loc_at) < FRESH_MS ? { lat: u.last_lat, lng: u.last_lng } : null);
  // Maps show only the part of the route still ahead: from the van to the next stop and on.
  // (Only the stretch before the next stop is searched, so a route that comes back past the
  // dealership isn't cut short.)
  function aheadOnly(route, user) {
    const here = freshSpot(user);
    const path = route.path;
    if (!here || !Array.isArray(path) || path.length < 2 || !route.stops.length) return route;
    const pt = ([lat, lng]) => ({ lat, lng });
    const next = route.stops[0];
    let stopAt = path.length - 1; let near = Infinity;
    for (let i = 0; i < path.length; i++) { const km = distanceKm(pt(path[i]), next); if (km < near) { near = km; stopAt = i; } if (km < 0.05) break; }
    // Closest point on each stretch of the line (flat-earth math is fine over a few miles).
    const k = Math.cos((here.lat * Math.PI) / 180);
    let seg = 0; let bestKm = Infinity;
    for (let i = 0; i < Math.max(1, stopAt); i++) {
      const [aLat, aLng] = path[i]; const [bLat, bLng] = path[Math.min(i + 1, path.length - 1)];
      const ax = aLng * k; const bx = bLng * k; const px = here.lng * k;
      const dx = bx - ax; const dy = bLat - aLat; const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (here.lat - aLat) * dy) / len)) : 0;
      const km = distanceKm({ lat: aLat + t * dy, lng: (ax + t * dx) / k }, here);
      if (km < bestKm) { bestKm = km; seg = i; }
    }
    if (bestKm > 1.5) return { ...route, path: [[here.lat, here.lng], ...path.slice(stopAt)] }; // off the planned roads: from the van to the next stop's part
    return { ...route, path: [[here.lat, here.lng], ...path.slice(seg + 1)] };
  }
  // Small and fast, so maps can ask every few seconds.
  // Every map asks for this every few seconds; the same answer is shared for 2 seconds.
  const brief = new Map();
  function briefly(key, ms, build) {
    const hit = brief.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.body;
    const body = build(); brief.set(key, { at: Date.now(), body });
    if (brief.size > 200) brief.delete(brief.keys().next().value);
    return body;
  }
  app.get('/api/drivers/live', requireRole(), (req, res) => {
    res.type('json').send(briefly(`live|${ridesVersion}`, 2000, () => { // rebuilt at once when rides/routes/shifts change
      const rows = q(`SELECT u.*, v.name AS vehicle_name FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
                      WHERE u.role = 'driver' AND u.active = 1 AND u.on_duty = 1`).all();
      return JSON.stringify({
        at: now(),
        drivers: rows.map((u) => ({
          id: u.id, name: u.name, vehicle_name: u.vehicle_name, lat: u.last_lat, lng: u.last_lng, at: u.last_loc_at,
          heading: u.last_heading, speed: u.last_speed, battery: u.last_battery || null, route: liveRoute(u),
        })),
      });
    }));
  });

  // ---------- nearby ride offers ----------
  // A ride waiting for a driver is offered to the closest free driver (no rides, or just
  // finishing one) with a ding and a phone notification. They accept or pass; if they
  // pass or don't answer in time, it goes to the next closest driver.
  const OFFER_SECONDS = 90;
  let sweepTimer = null;
  function scheduleOfferSweep() {
    if (opts.noTimers || sweepTimer) return; // tests run app.locals.offerSweep themselves
    if (!bus.jobs) { bus.ask('jobs', 'sweep').catch(() => {}); return; } // one copy hands out offers
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      try { if (offerSweep().length) { ridesChanged(); live.soon('rides', 300); } } catch (e) { console.error('Ride offers failed:', e.message); }
    }, 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  function offerSweep(at = new Date()) {
    const nowIso = at.toISOString();
    // Close offers that ran out of time, or whose ride was taken or cancelled.
    q(`UPDATE ride_offers SET status = 'expired', responded_at = ? WHERE status = 'pending'
       AND (expires_at <= ? OR ride_id NOT IN (SELECT id FROM rides WHERE status = 'requested' AND driver_id IS NULL))`).run(nowIso, nowIso);
    if (getSettings().ride_offers !== '1') return [];
    const soon = new Date(at.getTime() + 90 * 60000).toISOString(); // rides due in the next 90 minutes (or late)
    const rides = q(`SELECT * FROM rides WHERE status = 'requested' AND driver_id IS NULL AND scheduled_at <= ?
                     AND id NOT IN (SELECT ride_id FROM ride_offers WHERE status = 'pending')
                     ORDER BY priority = 'urgent' DESC, scheduled_at`).all(soon);
    if (!rides.length) return [];
    let drivers = q(`SELECT u.*, (SELECT COUNT(*) FROM rides r WHERE r.driver_id = u.id AND r.status IN ('assigned','en_route','onboard')) AS load,
                       (SELECT COALESCE(SUM(r.passengers), 0) FROM rides r WHERE r.driver_id = u.id AND r.status = 'onboard') AS riding,
                       (SELECT v.seats FROM vehicles v WHERE v.id = u.vehicle_id) AS seats
                     FROM users u WHERE u.role = 'driver' AND u.active = 1 AND u.on_duty = 1 AND u.last_lat IS NOT NULL AND u.last_loc_at >= ?
                     AND u.id NOT IN (SELECT driver_id FROM ride_offers WHERE status = 'pending')`)
      .all(new Date(at.getTime() - 10 * 60000).toISOString());
    const dealer = dealerOrigin();
    // Rotation: a busy driver heading back to the dealership (next stop is the dealership, or
    // within 3 miles of it) can take a ride waiting within 3 miles of where they are: drop
    // the customers off, then grab the next one. Their route updates when they take it.
    const ROTATION_KM = 3 / KM_TO_MI;
    drivers = drivers.map((d) => {
      if (d.load <= 1) return d; // free, or only finishing one ride
      if (!d.riding || d.load >= 4) return null; // rotation is for a van coming back with customers on board
      const here = { lat: d.last_lat, lng: d.last_lng };
      const next = d.route_json ? liveRoute(d)?.stops?.[0] : null;
      const back = (next && next.kind === 'dealer') || distanceKm(here, dealer) <= ROTATION_KM;
      return back ? { ...d, rotation: true } : null;
    }).filter(Boolean);
    const recent = new Date(at.getTime() - 30 * 60000).toISOString();
    const made = [];
    for (const r of rides) {
      if (!drivers.length) break;
      const passed = new Set(q(`SELECT driver_id FROM ride_offers WHERE ride_id = ? AND status IN ('declined','expired') AND created_at >= ?`)
        .all(r.id, recent).map((x) => x.driver_id));
      // Pick ups: go to the customer. Drop offs: the customer is at the dealership.
      const target = r.type === 'pickup' && r.lat != null ? { lat: r.lat, lng: r.lng } : dealer;
      const best = drivers.filter((d) => !passed.has(d.id)
        && (d.rotation ? (!d.seats || r.passengers <= d.seats) && distanceKm({ lat: d.last_lat, lng: d.last_lng }, target) <= ROTATION_KM // close by; seats free up at the dealership
          : (!d.seats || d.riding + r.passengers <= d.seats))) // room in the van
        .map((d) => ({ d, km: distanceKm({ lat: d.last_lat, lng: d.last_lng }, target) + d.load * 2.5 })) // busy drivers count as a bit further away
        .sort((a, b) => a.km - b.km)[0];
      if (!best) continue;
      const miles = Math.round(distanceKm({ lat: best.d.last_lat, lng: best.d.last_lng }, target) * KM_TO_MI * 1.35 * 10) / 10;
      const minutes = Math.max(1, Math.round((miles / 28) * 60));
      const id = Number(q('INSERT INTO ride_offers (ride_id, driver_id, miles, minutes, created_at, expires_at, rotation) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, best.d.id, miles, minutes, nowIso, new Date(at.getTime() + OFFER_SECONDS * 1000).toISOString(), best.d.rotation ? 1 : 0).lastInsertRowid);
      drivers = drivers.filter((d) => d.id !== best.d.id);
      const where = r.type === 'pickup' ? `${miles} mi away (about ${minutes} min)` : `customer is at the dealership, ${miles} mi from you`;
      quietly(push.notifyUsers([best.d.id], {
        title: best.d.rotation ? '🔄 On your way back: ride near you' : best.d.load ? '🚐 Ride near you when you finish' : "🚐 You're free: ride near you",
        body: `${r.type === 'pickup' ? 'Pick up' : 'Drop off'} ${r.customer_name} · ${where}. Want it?`,
        tag: `offer-${id}`, url: '/driver', offer_id: id,
      }));
      made.push({ id, ride_id: r.id, driver_id: best.d.id, miles, minutes });
      live.send('offer', { id }, { userId: best.d.id }); // pops up right away on that driver's phone
    }
    return made;
  }
  bus.answer('sweep', () => { scheduleOfferSweep(); return true; });
  app.locals.offerSweep = (...a) => { const made = offerSweep(...a); if (made.length) { ridesChanged(); live.soon('rides', 300); } return made; };
  if (jobsHere) setInterval(() => { try { if (offerSweep().length) { ridesChanged(); live.soon('rides', 300); } } catch (e) { console.error('Ride offers failed:', e.message); } }, 15000).unref();

  app.get('/api/offers/mine', requireRole('driver'), (req, res) => {
    const o = q(`SELECT o.*, r.customer_name, r.type, r.address, r.lat, r.lng, r.scheduled_at, r.passengers, r.priority, r.notes
                 FROM ride_offers o JOIN rides r ON r.id = o.ride_id
                 WHERE o.driver_id = ? AND o.status = 'pending' AND o.expires_at > ? ORDER BY o.id DESC LIMIT 1`).get(req.user.id, now());
    res.json({ offer: o ? { ...o, seconds_left: Math.max(0, Math.round((new Date(o.expires_at) - Date.now()) / 1000)) } : null });
  });
  app.post('/api/offers/:id/:answer', requireRole('driver'), (req, res) => {
    const answer = req.params.answer;
    if (!['accept', 'decline'].includes(answer)) return bad(res, 'Not found.', 404);
    const o = q('SELECT * FROM ride_offers WHERE id = ? AND driver_id = ?').get(Number(req.params.id), req.user.id);
    if (!o) return bad(res, 'Offer not found.', 404);
    if (o.status !== 'pending' || o.expires_at <= now()) return bad(res, o.status === 'accepted' ? 'You already took this ride.' : 'This offer has ended.', 409);
    if (answer === 'decline') {
      q("UPDATE ride_offers SET status = 'declined', responded_at = ? WHERE id = ?").run(now(), o.id);
      scheduleOfferSweep(); // offer it to the next closest driver
      return res.json({ ok: true });
    }
    const took = q("UPDATE rides SET driver_id = ?, vehicle_id = ?, status = 'assigned', updated_at = ? WHERE id = ? AND driver_id IS NULL AND status = 'requested'")
      .run(req.user.id, req.user.vehicle_id, now(), o.ride_id).changes;
    q('UPDATE ride_offers SET status = ?, responded_at = ? WHERE id = ?').run(took ? 'accepted' : 'expired', now(), o.id);
    if (!took) return bad(res, 'Someone else just took this ride.', 409);
    scheduleOfferSweep();
    const ride = withLinks(req, q(`${RIDE_SELECT} WHERE r.id = ?`).get(o.ride_id));
    // A driver with a saved route gets the new ride worked into it (dealership stop, seats and all).
    const me = q('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const current = liveRoute(me);
    if (!current) return res.json({ ok: true, ride });
    const ids = [...new Set([...current.stops.flatMap((x) => [x.ride_id, ...(x.drop_ids || []), ...(x.load_ids || [])]).filter(Boolean), o.ride_id])]
      .filter((id) => q("SELECT 1 FROM rides WHERE id = ? AND driver_id = ? AND status IN ('assigned','en_route','onboard')").get(id, me.id));
    buildRoute({ body: { ride_ids: ids }, user: me })
      .then((built) => { q('UPDATE users SET route_json = ? WHERE id = ?').run(JSON.stringify(built.route), me.id); live.soon('drivers', 300); res.json({ ok: true, ride, route: built.route }); })
      .catch((e) => { console.error(new Date().toLocaleString(), `[routes] Couldn't add the ride to ${me.name}'s route: ${e.message}`); res.json({ ok: true, ride, route_note: 'Plan your route again to fit this ride in.' }); });
  });

  const MAX_ROUTE_RIDES = 12;
  const keepOrderRequested = (req) => !!(req.body && req.body.keep_order); // saving a route already previewed: same start
  async function buildRoute(req) {
    const asked = (Array.isArray(req.body.ride_ids) ? req.body.ride_ids : []).map(Number).filter(Boolean);
    // Customers already in this driver's van are always part of the trip, whatever was checked.
    const riding = q("SELECT id FROM rides WHERE driver_id = ? AND status = 'onboard'").all(req.user.id).map((r) => r.id);
    const ids = [...new Set([...asked, ...(asked.length ? riding : [])])];
    if (!ids.length) throw new Error('Pick at least one ride for the route.');
    if (ids.length > MAX_ROUTE_RIDES) throw new Error(`A route can have up to ${MAX_ROUTE_RIDES} rides.`);
    const rides = q(`${RIDE_SELECT} WHERE r.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of rides) {
      if (!OPEN_STATUSES.includes(r.status)) throw new Error(`${r.customer_name}'s ride is already ${r.status}.`);
      if (r.driver_id && r.driver_id !== req.user.id) throw new Error(`${r.customer_name}'s ride belongs to ${r.driver_name || 'another driver'}.`);
    }
    if (rides.length !== ids.length) throw new Error('One of those rides no longer exists. Refresh and try again.');
    const dealer = { ...dealerOrigin(), label: 'Dealership', kind: 'dealer' };
    const f = req.body.from || {};
    const fromLat = num(f.lat); const fromLng = num(f.lng);
    let start;
    // Start where the van is now. An old location (the phone stopped sharing) would send the
    // route somewhere the van isn't, so then the route starts at the dealership.
    const fresh = freshSpot(req.user);
    const sent = fromLat != null && fromLng != null && Math.abs(fromLat) <= 90 && Math.abs(fromLng) <= 180 ? { lat: fromLat, lng: fromLng } : null;
    if (sent && (keepOrderRequested(req) || !f.at || Date.now() - Number(f.at) < FRESH_MS)) start = { ...sent, label: 'You' };
    else if (fresh) start = { ...fresh, label: 'You' };
    else start = { ...dealer, label: 'Dealership' };

    const keepOrder = !!req.body.keep_order;
    // Drop offs need an address; picked-up customers already on board just ride back.
    const skipped = rides.filter((r) => r.lat == null && !(r.type === 'pickup' && r.status === 'onboard')).map((r) => r.customer_name);
    const van = req.user.vehicle_id ? q('SELECT name, seats FROM vehicles WHERE id = ?').get(req.user.vehicle_id) : null;
    const capacity = van && van.seats > 0 ? van.seats : null;
    const tripRides = rides.filter((r) => r.lat != null || (r.type === 'pickup' && r.status === 'onboard')).map((r) => ({
      id: r.id, type: r.type, lat: r.lat, lng: r.lng, people: r.passengers || 1, onboard: r.status === 'onboard',
      due: r.scheduled_at ? Date.parse(r.scheduled_at) : null, urgent: r.priority === 'urgent', name: r.customer_name, address: r.address,
    }));
    // keep_order: save exactly the trip the driver just previewed (and sent to Google Maps),
    // including any dealership stops along the way (0 in the sequence).
    let sequence = null;
    if (keepOrder) {
      const want = Array.isArray(req.body.sequence) ? req.body.sequence.map(Number) : ids;
      const need = tripRides.filter((r) => !(r.type === 'pickup' && r.onboard)).map((r) => r.id);
      const given = want.filter((x) => x !== 0);
      if (given.length !== need.length || !need.every((x) => given.includes(x))) throw new Error('The rides changed. Plan the route again.');
      sequence = want.filter((x, i) => x !== 0 || i === 0 || want[i - 1] !== 0); // no two dealership stops in a row
      if (!Array.isArray(req.body.sequence)) { // older pages: collect drop offs at the dealership before the first one
        const i = sequence.findIndex((x) => { const r = tripRides.find((y) => y.id === x); return r && r.type === 'dropoff' && !r.onboard; });
        if (i >= 0 && distanceKm(start, dealer) >= 0.25) sequence.splice(i, 0, 0);
      }
    }
    const plan = await planTrip({ start, dealer: { ...dealer }, rides: tripRides, router: opts.router, capacity, sequence,
      log: (m) => console.log(new Date().toLocaleString(), '[routes]', m) });
    if (capacity && plan.peak > capacity) {
      const e = new Error(keepOrder
        ? `In this order, ${plan.peak} people would be in ${van.name} at once, but it has ${capacity} seats. Plan the route again.`
        : `Too many people for ${van.name}: it has ${capacity} seats, but this trip needs room for ${plan.peak} at once in any order. Uncheck a ride or two and plan again.`);
      e.status = 400; throw e;
    }

    const t0 = Date.now(); let miles = 0; let mins = 0;
    const names = (list) => list.map((r) => r.name).join(', ');
    const out = plan.stops.map((x, i) => {
      miles += x.meters / 1000 * KM_TO_MI; mins += x.seconds / 60;
      let label; let address = x.point.address || getSettings().dealer_address;
      if (x.kind === 'dealer') {
        const bits = [x.off.length ? `drop off ${names(x.off)}` : '', x.on.length ? `pick up ${names(x.on)}` : ''].filter(Boolean).join(' · ');
        label = x.last ? `Back at the dealership${x.off.length ? ` (drop off ${names(x.off)})` : ''}` : `Dealership${bits ? `: ${bits}` : ''}`;
        address = getSettings().dealer_address;
      } else label = `${x.kind === 'pickup' ? 'Pick up' : 'Drop off'} ${x.ride.name}`;
      return {
        kind: x.kind, ride_id: x.ride ? x.ride.id : null, label, address, lat: x.point.lat, lng: x.point.lng,
        leg_mi: Math.round(x.meters / 1000 * KM_TO_MI * 10) / 10, leg_min: i === 0 && x.startVisit ? 0 : Math.max(1, Math.round(x.seconds / 60)),
        on_board: x.load, // people in the van after this stop
        eta: new Date(t0 + x.arrive * 1000).toISOString(),
        ...(x.kind === 'dealer' ? { drop_ids: x.off.map((r) => r.id), load_ids: x.on.map((r) => r.id) } : {}),
        // Pick ups only: a drop off's time is when the customer leaves the dealership, not when they get home.
        ...(x.kind === 'pickup' && x.ride.due && x.arrive * 1000 + t0 > x.ride.due + 5 * 60000 ? { late_min: Math.round((x.arrive * 1000 + t0 - x.ride.due) / 60000) } : {}),
      };
    });
    const startLoad = tripRides.filter((r) => r.onboard).reduce((n, r) => n + r.people, 0);
    // Keep the saved path small: round and thin it out.
    let path = plan.path.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
    if (path.length > 1500) { const step = Math.ceil(path.length / 1500); path = path.filter((_, i) => i % step === 0 || i === path.length - 1); }
    return {
      route: { planned_at: now(), source: plan.source, start: { lat: start.lat, lng: start.lng }, seats: capacity, start_load: startLoad, peak: plan.peak, total_mi: Math.round(miles * 10) / 10,
        total_min: Math.round(plan.finish / 60), finish_at: out.length ? out[out.length - 1].eta : now(), stops: out, path, sequence: plan.sequence },
      skipped, rides,
    };
  }

  app.get('/api/route', requireRole('driver'), (req, res) => {
    res.json({ route: liveRoute(req.user) });
  });
  // Plan (preview) a route; with save: true it becomes the driver's route and any
  // unassigned rides on it are taken by this driver.
  app.post('/api/route', requireRole('driver'), async (req, res) => {
    let built;
    try { built = await buildRoute(req); } catch (e) { return bad(res, e.message); }
    if (req.body.save) {
      for (const r of built.rides) {
        if (r.driver_id) continue;
        const ok = q("UPDATE rides SET driver_id = ?, vehicle_id = ?, status = CASE WHEN status = 'requested' THEN 'assigned' ELSE status END, updated_at = ? WHERE id = ? AND driver_id IS NULL")
          .run(req.user.id, req.user.vehicle_id, now(), r.id).changes;
        if (!ok) return bad(res, `${r.customer_name}'s ride was just taken by someone else. Plan again.`);
      }
      q('UPDATE users SET route_json = ? WHERE id = ?').run(JSON.stringify(built.route), req.user.id);
    }
    res.json({ route: built.route, skipped: built.skipped, saved: !!req.body.save });
  });
  app.delete('/api/route', requireRole('driver'), (req, res) => {
    q('UPDATE users SET route_json = NULL WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/drivers', requireRole(), (req, res, next) => {
    const admin = req.user.role === 'admin';
    const key = `drivers|${admin}|${ridesVersion}`;
    const hit = brief.get(key);
    if (hit && Date.now() - hit.at < 2000) return res.type('json').send(hit.body);
    const send = res.json.bind(res);
    res.json = (data) => { brief.set(key, { at: Date.now(), body: JSON.stringify(data) }); if (brief.size > 200) brief.delete(brief.keys().next().value); return send(data); };
    next();
  }, (req, res) => {
    const rows = q(`SELECT u.*, v.name AS vehicle_name,
                      (SELECT COUNT(*) FROM rides r WHERE r.driver_id = u.id AND r.status IN ('assigned','en_route','onboard')) AS open_rides
                    FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
                    WHERE u.role = 'driver' AND u.active = 1 ORDER BY u.on_duty DESC, u.name`).all();
    // Advisors and drivers see a driver's name and phone (to call them), not their sign-in email.
    const admin = req.user.role === 'admin';
    res.json({ drivers: rows.map((u) => { const d = { ...publicUser(u), vehicle_name: u.vehicle_name, open_rides: u.open_rides }; if (!admin) delete d.email; return d; }) });
  });


  // ---------- rides ----------
  // byAdmin: admins may book outside the service area.
  function cleanRide(b, existing = {}, { byAdmin = false, forCustomer = false } = {}) {
    const r = { ...existing };
    const set = (k, v) => { if (b[k] !== undefined) r[k] = v; };
    set('type', b.type);
    set('customer_name', str(b.customer_name, 120));
    set('customer_phone', str(b.customer_phone, 40));
    set('customer_email', str(b.customer_email, 200));
    set('address', str(b.address, 300));
    set('lat', num(b.lat));
    set('lng', num(b.lng));
    set('priority', b.priority);
    set('passengers', num(b.passengers));
    set('ro_number', str(b.ro_number, 40));
    set('customer_vehicle', str(b.customer_vehicle, 120));
    set('notes', str(b.notes, 1000));
    set('urgent_reason', str(b.urgent_reason, 300));
    if (b.scheduled_at !== undefined) {
      const d = new Date(b.scheduled_at);
      if (Number.isNaN(d.getTime())) return { error: 'Pick a valid date and time.' };
      r.scheduled_at = d.toISOString();
    }
    if (!['pickup', 'dropoff'].includes(r.type)) return { error: 'Choose pick up or drop off.' };
    if (!r.customer_name) return { error: 'Customer name is required.' };
    if (!r.address) return { error: 'Address is required.' };
    if (!r.scheduled_at) return { error: 'Pick a date and time.' };
    r.priority = r.priority === 'urgent' ? 'urgent' : 'normal';
    // Urgent needs a reason, so everyone knows why it jumped the line.
    if (r.priority === 'urgent' && !r.urgent_reason) return { error: 'Give a reason for making this ride urgent.' };
    if (r.priority !== 'urgent') r.urgent_reason = null;
    r.passengers = Math.min(Math.max(r.passengers || 1, 1), 15);
    // Drop offs wait a set time after booking (unless urgent). Only checked when the time,
    // type or urgency is being set, so editing notes on an older ride doesn't move it.
    let adjusted = null;
    const wait = dropoffWait();
    const timing = !existing.id || r.scheduled_at !== existing.scheduled_at || r.type !== existing.type || r.priority !== existing.priority;
    if (timing && wait > 0 && r.type === 'dropoff' && r.priority !== 'urgent') {
      const earliest = new Date(Date.now() + wait * 60000);
      if (new Date(r.scheduled_at) < new Date(earliest.getTime() - 60000)) {
        earliest.setSeconds(0, 0);
        r.scheduled_at = earliest.toISOString(); adjusted = r.scheduled_at;
      }
    }
    // Service area: refuse a new or moved location that's too far from the dealership.
    const moved = r.lat != null && r.lng != null && (r.lat !== existing.lat || r.lng !== existing.lng);
    const radius = serviceRadius();
    if (moved && radius > 0 && !byAdmin) {
      const mi = milesFromDealer(r.lat, r.lng);
      if (mi > radius) {
        const phone = getSettings().dealer_phone;
        return { error: `That address is ${mi.toFixed(1)} miles from the dealership. The shuttle only goes up to ${radius} miles. ${
          forCustomer ? `Please call the service department${phone ? ` at ${phone}` : ''} and we'll help you make other arrangements.` : '(An admin can book it if needed.)'}` };
      }
    }
    return { r, adjusted };
  }

  const RIDE_FIELDS = ['type', 'customer_name', 'customer_phone', 'customer_email', 'address', 'lat', 'lng',
    'scheduled_at', 'priority', 'urgent_reason', 'passengers', 'ro_number', 'customer_vehicle', 'notes'];

  // City and estimated miles for reports (kept when customer details are cleared).
  function stampPlace(id) {
    const r = q('SELECT id, address, lat, lng FROM rides WHERE id = ?').get(id);
    if (!r || r.address === '(cleared)') return;
    q('UPDATE rides SET city = ?, est_miles = ? WHERE id = ?').run(cityOf(r.address, r.lat, r.lng), estimatedRideMiles(dealerOrigin(), r.lat, r.lng), r.id);
  }
  // Rides from before this update get theirs now.
  for (const r of q("SELECT id FROM rides WHERE city IS NULL AND est_miles IS NULL AND address <> '(cleared)'").all()) stampPlace(r.id);

  function insertRide(r, extra) {
    const cols = [...RIDE_FIELDS, 'status', 'source', 'advisor_id', 'track_token', 'return_of'];
    const vals = [...RIDE_FIELDS.map((f) => r[f] ?? null), extra.status || 'requested', extra.source, extra.advisor_id ?? null, newTrackCode(), extra.return_of ?? null];
    const res = q(`INSERT INTO rides (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    stampPlace(res.lastInsertRowid);
    return q(`${RIDE_SELECT} WHERE r.id = ?`).get(res.lastInsertRowid);
  }

  // Many screens ask for the same ride list. Build it once per change and share it:
  // anything that changes rides bumps ridesVersion (see the update middleware), and a
  // copy is never more than 5 seconds old.
  const shared = new Map();
  function sharedRows(key, build) {
    const hit = shared.get(key);
    if (hit && hit.version === ridesVersion && Date.now() - hit.at < 5000) return hit.rows;
    const rows = build();
    shared.set(key, { version: ridesVersion, at: Date.now(), rows });
    if (shared.size > 50) shared.delete(shared.keys().next().value);
    return rows;
  }
  // Queue positions for customers' tracking pages, from the shared open list.
  function queuePositions() {
    return sharedRows('positions', () => {
      const open = q(`${RIDE_SELECT} WHERE r.status IN ('requested','assigned','en_route','onboard') ORDER BY r.scheduled_at LIMIT 500`).all();
      return new Map(rankRides(open, dealerOrigin()).map((r) => [r.id, r.rank]));
    });
  }

  app.get('/api/rides', requireRole(), (req, res) => {
    const where = []; const args = [];
    const scope = req.query.scope || 'open';
    if (scope === 'open') where.push(`r.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), args.push(...OPEN_STATUSES);
    else if (scope === 'today') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      where.push('(r.scheduled_at >= ? OR r.cancelled_at >= ? OR r.completed_at >= ? OR r.status IN (\'requested\',\'assigned\',\'en_route\',\'onboard\'))');
      args.push(start.toISOString(), start.toISOString(), start.toISOString());
    }
    if (req.query.mine === '1' && req.user.role === 'advisor') { where.push('r.advisor_id = ?'); args.push(req.user.id); }
    if (req.query.mine === '1' && req.user.role === 'driver') { where.push('r.driver_id = ?'); args.push(req.user.id); }
    const sql = `${RIDE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.scheduled_at LIMIT 500`;
    const key = `${sql}|${args.join('|')}`;
    const base = baseUrl(req);
    // Rank from the driver's live position if we have it, else from the dealership.
    let origin = null;
    if (req.user.role === 'driver' && req.user.last_lat != null) origin = { lat: req.user.last_lat, lng: req.user.last_lng };
    const build = () => {
      const rides = sharedRows(key, () => q(sql).all(...args)).map((r) => ({ ...r, track_url: `${base}/t/${r.track_token}` }));
      const ranked = rankRides(rides, origin || dealerOrigin());
      const rankById = new Map(ranked.map((r) => [r.id, r]));
      return JSON.stringify({ rides: rides.map((r) => rankById.get(r.id) || r), queue: ranked.map((r) => r.id) });
    };
    // Everyone ranked from the dealership gets the very same answer: send one finished copy.
    const body = origin ? build() : sharedRows(`json|${base}|${key}`, build);
    res.type('json').send(body);
  });

  app.get('/api/rides/:id', requireRole(), (req, res) => {
    const ride = q(`${RIDE_SELECT} WHERE r.id = ?`).get(Number(req.params.id));
    if (!ride) return bad(res, 'Ride not found.', 404);
    res.json({ ride: withLinks(req, ride) });
  });

  app.post('/api/rides', requireRole('advisor'), atomic((req, res) => {
    const { r, error, adjusted } = cleanRide(req.body, {}, { byAdmin: req.user.role === 'admin' });
    if (error) return bad(res, error);
    // "Customer ready": a drop off booked from a pick up remembers which one.
    let returnOf = null;
    if (req.body.return_of != null) {
      const from = q('SELECT id, type FROM rides WHERE id = ?').get(num(req.body.return_of));
      if (!from || from.type !== 'pickup') return bad(res, 'That pick up was not found.');
      const existing = q("SELECT id FROM rides WHERE return_of = ? AND status <> 'cancelled'").get(from.id);
      if (existing) return bad(res, 'A drop off is already booked for this customer.');
      returnOf = from.id;
    }
    const ride = insertRide(r, { source: 'advisor', advisor_id: req.user.id, return_of: returnOf });
    notifyCustomer(ride.id, 'booked', baseUrl(req));
    pushNewRide(ride.id);
    res.status(201).json({ ride: withLinks(req, ride), adjusted_to: adjusted, wait_min: adjusted ? dropoffWait() : 0 });
  }));

  app.patch('/api/rides/:id', requireRole(), atomic((req, res) => {
    const ride = q('SELECT * FROM rides WHERE id = ?').get(Number(req.params.id));
    if (!ride) return bad(res, 'Ride not found.', 404);
    const b = req.body; const role = req.user.role;
    const updates = {};

    // Details: advisors/admins can edit.
    if (role !== 'driver' && RIDE_FIELDS.some((f) => b[f] !== undefined)) {
      const { r, error } = cleanRide(b, ride, { byAdmin: role === 'admin' });
      if (error) return bad(res, error);
      for (const f of RIDE_FIELDS) updates[f] = r[f];
    }

    // Assignment.
    if (b.driver_id !== undefined) {
      if (role === 'driver') {
        // A driver can claim an unassigned ride, or release their own.
        if (b.driver_id === req.user.id && !ride.driver_id) updates.driver_id = req.user.id;
        else if (b.driver_id === null && ride.driver_id === req.user.id) updates.driver_id = null;
        else return bad(res, 'That ride belongs to another driver.', 403);
      } else {
        const id = num(b.driver_id) || null; // 0, false or blank means "no driver"
        if (id && !q("SELECT id FROM users WHERE id = ? AND role = 'driver' AND active = 1").get(id)) return bad(res, 'Driver not found.');
        updates.driver_id = id;
      }
      if (updates.driver_id) {
        const d = q('SELECT vehicle_id FROM users WHERE id = ?').get(updates.driver_id);
        updates.vehicle_id = d.vehicle_id;
        if (ride.status === 'requested') updates.status = 'assigned';
      } else {
        updates.vehicle_id = null;
        if (['assigned', 'en_route'].includes(ride.status)) updates.status = 'requested';
      }
    }
    if (b.vehicle_id !== undefined && role !== 'driver') {
      const vid = num(b.vehicle_id) || null;
      if (vid && !q('SELECT id FROM vehicles WHERE id = ?').get(vid)) return bad(res, 'Vehicle not found.');
      updates.vehicle_id = vid;
    }
    if (b.no_return !== undefined && role !== 'driver') updates.no_return = b.no_return ? 1 : 0;

    // Status.
    if (b.status !== undefined) {
      if (!RIDE_STATUSES.includes(b.status)) return bad(res, 'Bad status.');
      if (role === 'driver' && ride.driver_id !== req.user.id && updates.driver_id !== req.user.id) {
        return bad(res, 'Claim this ride before updating it.', 403);
      }
      if (b.status === 'cancelled') {
        if (['completed', 'cancelled'].includes(ride.status)) return bad(res, `This ride is already ${ride.status}.`);
        const reason = str(b.cancel_reason, 500);
        if (!reason || reason.length < 3) return bad(res, 'Please give a reason for cancelling.');
        updates.cancel_reason = reason;
        updates.cancelled_by = req.user.id;
        updates.cancelled_at = now();
      } else if (ride.status === 'cancelled') {
        // Re-opening a cancelled ride clears the cancellation.
        updates.cancel_reason = null; updates.cancelled_by = null; updates.cancelled_at = null;
      }
      updates.status = b.status;
      updates.completed_at = b.status === 'completed' ? now() : null;
      // Timestamps for the reports (kept from the first time each step happened).
      if (b.status === 'en_route' && !ride.en_route_at) updates.en_route_at = now();
      if (b.status === 'onboard' && !ride.onboard_at) updates.onboard_at = now();
      if (['en_route', 'onboard', 'completed'].includes(b.status) && !ride.driver_id && !updates.driver_id && role === 'driver') {
        updates.driver_id = req.user.id;
      }
    }

    const keys = Object.keys(updates);
    if (!keys.length) return bad(res, 'Nothing to update.');
    q(`UPDATE rides SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => updates[k] ?? null), now(), ride.id);
    if (updates.status && updates.status !== ride.status && ['en_route', 'cancelled'].includes(updates.status)) {
      notifyCustomer(ride.id, updates.status, baseUrl(req));
    }
    // Tell the driver when someone else gives them a ride, or cancels one of theirs.
    const after = q('SELECT * FROM rides WHERE id = ?').get(ride.id);
    if (after.driver_id && after.driver_id !== ride.driver_id && after.driver_id !== req.user.id) {
      quietly(push.notifyUsers([after.driver_id], { title: '🚐 Ride assigned to you', body: rideLine(after), tag: `ride-${after.id}` }));
    }
    if (updates.status === 'cancelled' && ride.status !== 'cancelled' && ride.driver_id && ride.driver_id !== req.user.id) {
      quietly(push.notifyUsers([ride.driver_id], { title: '❌ Ride cancelled', body: `${rideLine(after)}${after.cancel_reason ? ` — ${after.cancel_reason}` : ''}`, tag: `ride-${after.id}` }));
    }
    scheduleOfferSweep(); // a driver may be free now, or a ride may need someone again
    stampPlace(ride.id);
    res.json({ ride: withLinks(req, q(`${RIDE_SELECT} WHERE r.id = ?`).get(ride.id)) });
  }));

  app.delete('/api/rides/:id', requireRole('admin'), (req, res) => {
    q('DELETE FROM rides WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- public: customer requests + tracking ----------
  app.get('/api/public/info', (req, res) => {
    const s = getSettings();
    res.json({
      dealer_name: s.dealer_name, dealer_address: s.dealer_address, dealer_phone: s.dealer_phone,
      dealer_lat: Number(s.dealer_lat), dealer_lng: Number(s.dealer_lng), public_requests: s.public_requests === '1',
      service_radius_mi: serviceRadius(), dropoff_wait_min: dropoffWait(),
    });
  });

  // ---------- dealership logo (Corwin look) ----------
  // Stored in the database so it's included in backups. SVGs are served so they can't run
  // scripts even if opened directly.
  const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
  const setSetting = (k, v) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  app.get('/brand/logo', (req, res) => {
    const logo = q("SELECT value FROM settings WHERE key = 'brand_logo'").get()?.value || '';
    const m = /^data:([a-z/+]+);base64,(.+)$/.exec(logo);
    if (!m || !LOGO_TYPES[m[1]]) return res.status(404).end();
    res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(m[2], 'base64'));
  });
  app.post('/api/brand/logo', requireRole('admin'), express.json({ limit: '900kb' }), (req, res) => {
    const m = /^data:([a-z/+]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
    if (!m || !LOGO_TYPES[m[1]]) return bad(res, 'Upload a PNG, JPG, WebP or SVG image.');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 600 * 1024) return bad(res, 'That image is too big. Keep the logo under 600 KB.');
    if (m[1] === 'image/svg+xml' && !/<svg[\s>]/i.test(bytes.toString('utf8'))) return bad(res, "That file isn't an SVG image.");
    setSetting('brand_logo', `data:${m[1]};base64,${m[2]}`);
    setSetting('brand_logo_v', Date.now().toString(36));
    res.json({ settings: shareableSettings() });
  });
  app.delete('/api/brand/logo', requireRole('admin'), (req, res) => {
    q("DELETE FROM settings WHERE key IN ('brand_logo', 'brand_logo_v')").run();
    res.json({ settings: shareableSettings() });
  });

  app.post('/api/public/rides', (req, res) => {
    if (getSettings().public_requests !== '1') return bad(res, 'Online ride requests are turned off. Please call the dealership.', 403);
    const key = `public|${clientIp(req)}`;
    if (limits.count(key, 3600000) >= 10) return bad(res, 'Too many requests. Please call the dealership.', 429);
    limits.hit(key, 3600000);
    if (!str(req.body.customer_phone)) return bad(res, 'A phone number is required so the driver can reach you.');
    const body = { ...req.body, priority: 'normal', urgent_reason: null };
    const { r, error } = cleanRide(body, {}, { forCustomer: true });
    if (error) return bad(res, error);
    if (serviceRadius() > 0 && (r.lat == null || r.lng == null)) {
      return bad(res, `Please choose your address from the suggestions, or tap the map, so we can check it's within our ${serviceRadius()}-mile shuttle area.`);
    }
    const ride = insertRide(r, { source: 'customer' });
    notifyCustomer(ride.id, 'booked', baseUrl(req));
    pushNewRide(ride.id);
    res.status(201).json({ track_url: `${baseUrl(req)}/t/${ride.track_token}`, token: ride.track_token });
  });

  // Wrong codes are limited per address, so nobody can try codes until one works.
  function trackedRide(req, res) {
    const key = `trackmiss|${clientIp(req)}`;
    if (limits.count(key, 3600000) >= 40) { bad(res, 'Too many tries. Check the link in your text message, or call the dealership.', 429); return null; }
    const ride = q(`${RIDE_SELECT} WHERE r.track_token = ?`).get(trackCode(req.params.token));
    if (!ride) { limits.hit(key, 3600000); bad(res, 'Ride not found. Check the link in your text message, or call the dealership.', 404); return null; }
    return ride;
  }
  app.get('/api/public/track/:token', (req, res) => {
    const ride = trackedRide(req, res);
    if (!ride) return;
    stats.sawTracker(ride.track_token);
    let driverLoc = null;
    if (ride.driver_id && ['en_route', 'onboard'].includes(ride.status)) {
      const d = q('SELECT last_lat, last_lng, last_loc_at FROM users WHERE id = ?').get(ride.driver_id);
      if (d && d.last_lat != null) driverLoc = { lat: d.last_lat, lng: d.last_lng, at: d.last_loc_at };
    }
    // Planned arrival from the driver's route (only while the driver is on the way).
    let eta = null;
    if (ride.driver_id && ['assigned', 'en_route'].includes(ride.status)) {
      const d = q('SELECT * FROM users WHERE id = ?').get(ride.driver_id);
      const stop = d && liveRoute(d)?.stops.find((x) => x.ride_id === ride.id);
      if (stop && new Date(stop.eta) > Date.now() - 15 * 60000) eta = stop.eta;
    }
    // No planned route? Estimate from how far the van is (road miles ≈ 1.35 × straight line, ~28 mph in town).
    let etaEstimated = false;
    const s = getSettings();
    if (!eta && driverLoc && ride.status === 'en_route' && ride.lat != null) {
      const km = distanceKm(driverLoc, { lat: ride.lat, lng: ride.lng });
      eta = new Date(Date.now() + Math.max(1, Math.round(((km * KM_TO_MI * 1.35) / 28) * 60)) * 60000).toISOString(); etaEstimated = true;
    } else if (!eta && driverLoc && ride.status === 'onboard') {
      const target = ride.type === 'pickup' ? dealerOrigin() : (ride.lat != null ? { lat: ride.lat, lng: ride.lng } : null);
      if (target) { const km = distanceKm(driverLoc, target); eta = new Date(Date.now() + Math.max(1, Math.round(((km * KM_TO_MI * 1.35) / 28) * 60)) * 60000).toISOString(); etaEstimated = true; }
    }
    let position = null;
    if (ride.status === 'requested' || ride.status === 'assigned') position = queuePositions().get(ride.id) ?? null;
    res.json({
      ride: {
        type: ride.type, status: ride.status, customer_first_name: ride.customer_name.split(' ')[0],
        address: ride.address, lat: ride.lat, lng: ride.lng, scheduled_at: ride.scheduled_at,
        driver_name: ride.driver_name ? ride.driver_name.split(' ')[0] : null,
        vehicle: ride.vehicle_name ? { name: ride.vehicle_name, color: ride.vehicle_color, make_model: ride.vehicle_make_model, plate: ride.vehicle_plate } : null,
        updated_at: ride.updated_at,
      },
      driver_location: driverLoc,
      eta, eta_estimated: etaEstimated,
      queue_position: position,
      can_change: s.customer_actions !== '0' && ['requested', 'assigned', 'en_route'].includes(ride.status),
      dealer: { name: s.dealer_name, address: s.dealer_address, phone: s.dealer_phone, lat: Number(s.dealer_lat), lng: Number(s.dealer_lng) },
    });
  });

  // ---------- customer actions from the tracking page ----------
  // "Running late" adds a dated note to the ride; "Cancel" cancels it with a reason. The driver
  // (and the advisor) get a phone notification, and every open screen updates right away.
  const tellStaff = (ride, title, body) => {
    const ids = [ride.driver_id, ride.advisor_id].filter(Boolean);
    if (ids.length) quietly(push.notifyUsers([...new Set(ids)], { title, body, tag: `ride-${ride.id}`, url: '/driver' }));
    live.soon('rides', 300);
  };
  const LATE = { 5: 'about 5 minutes', 10: 'about 10 minutes', 15: 'about 15 minutes', 20: '20 minutes or more' };
  app.post('/api/public/track/:token/late', atomic((req, res) => {
    const ride = trackedRide(req, res); if (!ride) return;
    if (getSettings().customer_actions === '0') return bad(res, 'Please call the dealership.', 403);
    if (!['requested', 'assigned', 'en_route'].includes(ride.status)) return bad(res, 'This ride can’t be changed now.', 409);
    const mins = Number(req.body && req.body.minutes);
    if (!LATE[mins]) return bad(res, 'Pick how late you’ll be.');
    const key = `late|${ride.id}`;
    if (limits.count(key, 3600000) >= 3) return bad(res, 'We already have your update. Please call the dealership if anything else changes.', 429);
    limits.hit(key, 3600000);
    const line = `[${fmtWhen(now())}] Customer: running ${LATE[mins]} late.`;
    q('UPDATE rides SET notes = ?, updated_at = ? WHERE id = ?').run(ride.notes ? `${ride.notes}\n${line}` : line, now(), ride.id);
    tellStaff(ride, `⏰ ${ride.customer_name.split(' ')[0]} is running late`, `Running ${LATE[mins]} late · ${rideLine(ride)}`);
    res.json({ ok: true, message: 'Thanks! We told your driver.' });
  }));
  const CUSTOMER_CANCEL = ['My plans changed', 'I found another ride', 'I don’t need the shuttle anymore', 'Other'];
  app.post('/api/public/track/:token/cancel', atomic((req, res) => {
    const ride = trackedRide(req, res); if (!ride) return;
    if (getSettings().customer_actions === '0') return bad(res, 'Please call the dealership to cancel.', 403);
    const reason = String((req.body && req.body.reason) || '');
    if (!CUSTOMER_CANCEL.includes(reason)) return bad(res, 'Pick a reason.');
    const details = str(req.body.details, 200);
    if (reason === 'Other' && (!details || details.length < 3)) return bad(res, 'Please tell us a little more.');
    const text = `Customer cancelled: ${reason === 'Other' ? details : reason}${reason !== 'Other' && details ? ` (${details})` : ''}`;
    const done = q(`UPDATE rides SET status = 'cancelled', cancel_reason = ?, cancelled_by = NULL, cancelled_at = ?, updated_at = ?
                    WHERE id = ? AND status IN ('requested','assigned','en_route')`).run(text, now(), now(), ride.id).changes;
    if (!done) return bad(res, 'This ride can’t be cancelled now. Please call the dealership.', 409);
    q("UPDATE ride_offers SET status = 'expired', responded_at = ? WHERE ride_id = ? AND status = 'pending'").run(now(), ride.id);
    tellStaff(ride, `❌ ${ride.customer_name.split(' ')[0]} cancelled their ride`, `${text} · ${rideLine(ride)}`);
    res.json({ ok: true, message: 'Your ride is cancelled. Thanks for letting us know.' });
  }));
  // "Add to calendar": a one-event calendar file for the ride.
  app.get('/api/public/track/:token/calendar', (req, res) => {
    const ride = trackedRide(req, res); if (!ride) return;
    const s = getSettings();
    const t = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc2 = (v) => String(v || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const start = new Date(ride.scheduled_at);
    const what = ride.type === 'pickup' ? 'Shuttle pick up' : 'Shuttle ride home';
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shuttle//EN', 'BEGIN:VEVENT',
      `UID:ride-${ride.id}@shuttle`, `DTSTAMP:${t(now())}`, `DTSTART:${t(start.toISOString())}`, `DTEND:${t(new Date(start.getTime() + 30 * 60000).toISOString())}`,
      `SUMMARY:${esc2(`${what} · ${s.dealer_name}`)}`, `LOCATION:${esc2(ride.type === 'pickup' ? ride.address : s.dealer_address)}`,
      `DESCRIPTION:${esc2(`Track your driver: ${baseUrl(req)}/t/${ride.track_token}${s.dealer_phone ? `\nQuestions? Call ${s.dealer_phone}` : ''}`)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${esc2(what)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    res.type('text/calendar').set('Content-Disposition', 'attachment; filename="shuttle-ride.ics"').set('Cache-Control', 'no-store').send(ics);
  });

  // ---------- settings ----------
  app.patch('/api/settings', requireRole('admin'), (req, res) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body[k] === undefined) continue;
      let v = String(req.body[k]).slice(0, 300);
      if ((k === 'dealer_lat' || k === 'dealer_lng') && Number.isNaN(Number(v))) return bad(res, 'Latitude/longitude must be numbers.');
      if (YES_NO_SETTINGS.includes(k)) v = req.body[k] && req.body[k] !== '0' ? '1' : '0';
      if (k === 'look' && !['classic', 'corwin'].includes(v)) return bad(res, 'Pick Classic or Corwin.');
      if (k === 'discord_invite' && v && !/^https:\/\/(discord\.gg|(www\.)?discord\.com\/invite)\/[\w-]+$/.test(v.trim())) return bad(res, 'Use a Discord invite link like https://discord.gg/abc123.');
      if ((k === 'brand_color' || k === 'brand_dark') && !/^#[0-9a-f]{6}$/i.test(v)) return bad(res, 'Colors must look like #eb0a1e.');
      if (k === 'gps_low_battery_pct' && !(Number.isInteger(Number(v)) && Number(v) >= 5 && Number(v) <= 50)) return bad(res, 'Pick a battery level from 5% to 50%.');
      if (k === 'gps_low_battery_mode' && !['slow', 'pause', 'normal'].includes(v)) return bad(res, 'Pick what happens on a low battery.');
      if (k === 'timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { return bad(res, 'Unknown time zone.'); } }
      if (k === 'auto_end_shift' || k === 'auto_sign_out' || k === 'clear_customer_info' || k === 'backup_time') {
        v = v.trim();
        if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return bad(res, 'Pick a time, like 8:00 PM, or leave it empty to turn it off.');
      }
      if (k === 'dropoff_wait_min') {
        const n = Number(v);
        if (v === '' || !Number.isInteger(n) || n < 0 || n > 240) return bad(res, 'The drop-off waiting time must be 0 to 240 minutes.');
        v = String(n);
      }
      if (k === 'service_radius_mi') {
        const n = Number(v);
        if (v === '' || Number.isNaN(n) || n < 0 || n > 500) return bad(res, 'The service distance must be a number of miles (0 means no limit).');
        v = String(Math.round(n * 10) / 10);
      }
      const changed = getSettings()[k] !== v;
      q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
      if (k === 'auto_sign_out' && changed) resetSignOutSchedule(v);
      if (k === 'clear_customer_info' && changed) customerWipe.reset(v);
      if (k === 'backup_time' && changed) nightlyBackup.reset(v);
    }
    res.json({ settings: shareableSettings() });
  });

  // ---------- phone notifications (sign up / test) ----------
  app.get('/api/push', requireRole('driver'), (req, res) => {
    res.json({ key: push.publicKey, devices: push.countFor(req.user.id) });
  });
  app.post('/api/push/subscribe', requireRole('driver'), (req, res) => {
    try { push.subscribe(req.user.id, req.body.subscription, req.get('user-agent')); }
    catch (e) { return bad(res, e.message); }
    res.json({ ok: true, devices: push.countFor(req.user.id) });
  });
  app.post('/api/push/unsubscribe', requireRole('driver'), (req, res) => {
    push.unsubscribe(req.body.endpoint);
    res.json({ ok: true, devices: push.countFor(req.user.id) });
  });
  app.post('/api/push/test', requireRole('driver'), async (req, res) => {
    const r = await push.notifyUsers([req.user.id], { title: '🔔 Test notification', body: 'Notifications are working on this phone.', tag: 'test' });
    if (!r.sent) return bad(res, r.failed ? 'The phone\'s notification service refused it. Try turning notifications off and on again.' : 'Notifications aren\'t turned on for any of your phones yet.');
    res.json({ ok: true, sent: r.sent });
  });

  // ---------- automatic end of shift ----------
  // Once a day at the set time (dealership time zone), every driver still on duty is
  // taken off shift: no more new-ride notifications, and their vehicle is freed.
  // Rides they're in the middle of stay assigned so they can still finish them.
  function autoEndShifts(at = new Date()) {
    const s = getSettings();
    const cutoff = (s.auto_end_shift || '').trim();
    if (!/^\d{2}:\d{2}$/.test(cutoff)) return 0;
    const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    const today = localDate(at.toISOString());
    if (nowHM < cutoff || s.auto_end_last === today) return 0;
    q("INSERT INTO settings (key, value) VALUES ('auto_end_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
    const drivers = q("SELECT id FROM users WHERE role = 'driver' AND on_duty = 1").all().map((u) => u.id);
    if (!drivers.length) return 0;
    q("UPDATE users SET on_duty = 0, vehicle_id = NULL, route_json = NULL WHERE role = 'driver' AND on_duty = 1").run();
    const [h, m] = cutoff.split(':').map(Number);
    const label = new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    quietly(push.notifyUsers(drivers, { title: '🌙 Shift ended', body: `Your shift was ended automatically at ${label}. Start a new shift in the app if you're still driving.`, tag: 'shift-ended' }));
    console.log(new Date().toLocaleString(), `[shifts] Ended ${drivers.length} driver shift(s) automatically at ${label}.`);
    ridesChanged();
    live.soon('drivers', 300);
    return drivers.length;
  }
  app.locals.autoEndShifts = autoEndShifts;

  // ---------- automatic sign-out ----------
  // Once a day at the set time (default midnight, dealership time zone) everyone is signed
  // out on every device, and any driver still on shift is taken off. The first time the
  // server sees the setting after its time has already passed today, it waits for the next
  // day, so installing this never signs everyone out on the spot.
  const markSignOutPending = () => q("INSERT INTO settings (key, value) VALUES ('auto_signout_last', 'pending') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  // Called when an admin saves a new sign-out time: a time later today still runs tonight.
  function resetSignOutSchedule(cutoff, at = new Date()) {
    q("DELETE FROM settings WHERE key = 'auto_signout_last'").run();
    if (cutoff) autoSignOut(at); // records 'pending' or today, without signing anyone out
  }
  app.locals.resetSignOutSchedule = resetSignOutSchedule;
  function autoSignOut(at = new Date()) {
    const s = getSettings();
    const cutoff = (s.auto_sign_out || '').trim();
    if (!/^\d{2}:\d{2}$/.test(cutoff)) return 0;
    const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    const today = localDate(at.toISOString());
    const setLast = () => q("INSERT INTO settings (key, value) VALUES ('auto_signout_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
    // First time this setting is seen: if its time already passed today, start tomorrow;
    // otherwise mark it 'pending' so it still runs later today.
    if (!s.auto_signout_last) { if (nowHM >= cutoff) setLast(); else markSignOutPending(); return 0; }
    if (nowHM < cutoff || s.auto_signout_last === today) return 0;
    setLast();
    const signedOut = q('DELETE FROM sessions').run().changes;
    live.soon('drivers', 300);
    q("UPDATE users SET on_duty = 0, vehicle_id = NULL, route_json = NULL WHERE role = 'driver' AND on_duty = 1").run();
    console.log(new Date().toLocaleString(), `[sign-out] Signed everyone out automatically (${signedOut} session(s)).`);
    return signedOut;
  }
  app.locals.autoSignOut = autoSignOut;

  // ---------- nightly customer-info wipe ----------
  // Once a day at the set time (default midnight, dealership time zone), every finished
  // ride (completed or cancelled) loses the customer's name, phone, email, address, map
  // spot and notes, its tracking link stops working, and the text-message log is emptied.
  // Ride counts, times, drivers, vehicles and cancel reasons stay, so reports still work.
  // Rides that are still open keep their details until they're done.
  const CLEARED_NAME = 'Customer (info cleared)';
  function clearCustomerInfo() {
    ridesChanged();
    const ids = q(`SELECT id FROM rides WHERE status IN ('completed','cancelled') AND cleared_at IS NULL`).all().map((r) => r.id);
    const wipe = q(`UPDATE rides SET customer_name = ?, customer_phone = NULL, customer_email = NULL,
                      address = '(cleared)', lat = NULL, lng = NULL, notes = NULL, ro_number = NULL,
                      customer_vehicle = NULL, track_token = ?, cleared_at = ? WHERE id = ?`);
    const at = now();
    for (const id of ids) wipe.run(CLEARED_NAME, randomToken(18), at, id);
    const texts = q('DELETE FROM sms_log').run().changes;
    geoCache.clear(); // searched addresses
    // Hand-made and before-restore backups still hold the day's customer details: remove them.
    if (opts.backups) { try { opts.backups.prune({ temporary: true }); } catch (e) { console.error('Removing temporary backups failed:', e.message); } }
    if (ids.length || texts) console.log(new Date().toLocaleString(), `[privacy] Cleared customer info from ${ids.length} finished ride(s) and ${texts} text log entr${texts === 1 ? 'y' : 'ies'}.`);
    return ids.length;
  }
  // Same daily timing rules as the sign-out above.
  const customerWipe = (() => {
    const LAST = 'clear_customer_last';
    const setLast = (v) => q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(LAST, v);
    function tick(at = new Date()) {
      const s = getSettings();
      const cutoff = (s.clear_customer_info || '').trim();
      if (!/^\d{2}:\d{2}$/.test(cutoff)) return 0;
      const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      const today = localDate(at.toISOString());
      if (!s[LAST]) { setLast(nowHM >= cutoff ? today : 'pending'); return 0; }
      if (nowHM < cutoff || s[LAST] === today) return 0;
      setLast(today);
      return clearCustomerInfo();
    }
    function reset(cutoff, at = new Date()) {
      q('DELETE FROM settings WHERE key = ?').run(LAST);
      if (cutoff) tick(at);
    }
    return { tick, reset };
  })();
  app.locals.clearCustomerInfo = customerWipe.tick;

  // ---------- nightly backup ----------
  // Same daily timing rules: installing it never runs on the spot; a time later today still runs tonight.
  const nightlyBackup = (() => {
    const LAST = 'backup_last';
    const setLast = (v) => q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(LAST, v);
    function tick(at = new Date()) {
      if (!opts.backups) return null;
      const s = getSettings();
      const cutoff = (s.backup_time || '').trim();
      if (!/^\d{2}:\d{2}$/.test(cutoff)) return null;
      const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      const today = localDate(at.toISOString());
      if (!s[LAST]) { setLast(nowHM >= cutoff ? today : 'pending'); return null; }
      if (nowHM < cutoff || s[LAST] === today) return null;
      setLast(today);
      const made = opts.backups.make('daily', at);
      opts.backups.prune();
      return made;
    }
    function reset(cutoff, at = new Date()) {
      q('DELETE FROM settings WHERE key = ?').run(LAST);
      if (cutoff) tick(at);
    }
    return { tick, reset };
  })();
  app.locals.nightlyBackup = nightlyBackup.tick;
  app.locals.resetClearSchedule = customerWipe.reset;
  if (jobsHere) {
    setInterval(() => {
      try { autoEndShifts(); } catch (e) { console.error('Auto end of shift failed:', e.message); }
      try { autoSignOut(); } catch (e) { console.error('Auto sign-out failed:', e.message); }
      try { customerWipe.tick(); } catch (e) { console.error('Clearing customer info failed:', e.message); }
      try { nightlyBackup.tick(); } catch (e) { console.error('Nightly backup failed:', e.message); }
    }, 60000).unref();
  }

  // ---------- reports ----------
  app.get('/api/reports', requireRole('admin'), (req, res) => {
    const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const today = localDate(now());
    const to = isDay(req.query.to) ? req.query.to : today;
    const from = isDay(req.query.from) ? req.query.from : localDate(new Date(Date.now() - 6 * 86400000).toISOString());
    if (from > to) return bad(res, 'The start date is after the end date.');
    // Look a day either side in UTC, then keep rides whose local date is in range.
    const lo = new Date(new Date(from + 'T00:00:00Z').getTime() - 86400000).toISOString();
    const hi = new Date(new Date(to + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString();
    const inRange = q(`${RIDE_SELECT} WHERE r.scheduled_at >= ? AND r.scheduled_at < ?`).all(lo, hi)
      .map((r) => ({ ...r, day: localDate(r.scheduled_at) }))
      .filter((r) => r.day >= from && r.day <= to);
    // Optional pick up / drop off filter; the counts for each are sent for the filter buttons.
    const type = ['pickup', 'dropoff'].includes(req.query.type) ? req.query.type : 'all';
    const typeCounts = { all: inRange.length, pickup: inRange.filter((r) => r.type === 'pickup').length, dropoff: inRange.filter((r) => r.type === 'dropoff').length };
    const rides = type === 'all' ? inRange : inRange.filter((r) => r.type === type);

    const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
    const isNoShow = (r) => r.status === 'cancelled' && /^customer no-show/i.test(r.cancel_reason || '');
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
    function summarize(list) {
      const done = list.filter((r) => r.status === 'completed');
      const timed = done.filter((r) => r.onboard_at);
      const waits = timed.map((r) => Math.max(0, mins(r.scheduled_at, r.onboard_at)));
      return {
        rides: list.length,
        pickups: list.filter((r) => r.type === 'pickup').length,
        dropoffs: list.filter((r) => r.type === 'dropoff').length,
        completed: done.length,
        cancelled: list.filter((r) => r.status === 'cancelled').length,
        no_shows: list.filter(isNoShow).length,
        open: list.filter((r) => OPEN_STATUSES.includes(r.status)).length,
        avg_wait_min: avg(waits),
        on_time_pct: timed.length ? Math.round((waits.filter((w) => w <= 10).length / timed.length) * 100) : null,
        avg_ride_min: avg(timed.filter((r) => r.completed_at).map((r) => mins(r.onboard_at, r.completed_at))),
        // Estimated miles (dealership <-> customer round trip) for completed rides.
        est_miles: Math.round(done.reduce((n, r) => n + (r.est_miles || 0), 0) * 10) / 10,
        // Time on rides: from "on my way" (or customer in) until the ride was complete.
        ride_time_min: Math.round(done.filter((r) => r.completed_at && (r.en_route_at || r.onboard_at))
          .reduce((n, r) => n + Math.max(0, mins(r.en_route_at || r.onboard_at, r.completed_at)), 0)),
      };
    }
    const days = [];
    for (let d = new Date(from + 'T12:00:00Z'); localDate(d.toISOString()) <= to && days.length < 400; d = new Date(d.getTime() + 86400000)) {
      const day = d.toISOString().slice(0, 10);
      days.push({ day, ...summarize(rides.filter((r) => r.day === day)) });
    }
    const group = (keyFn) => {
      const m = new Map();
      for (const r of rides) { const k = keyFn(r); if (k) m.set(k, [...(m.get(k) || []), r]); }
      return [...m.entries()].map(([name, list]) => ({ name, ...summarize(list) })).sort((a, b) => b.rides - a.rides);
    };
    // GPS miles and moving time per driver per day (from the drivers' phones while on shift).
    const gps = q(`SELECT g.*, u.name FROM driver_days g JOIN users u ON u.id = g.driver_id WHERE g.day >= ? AND g.day <= ?`).all(from, to);
    const gpsBy = (key) => { const m = new Map(); for (const g of gps) { const k = key(g); const o = m.get(k) || { miles: 0, moving_s: 0 }; o.miles += g.miles; o.moving_s += g.moving_s; m.set(k, o); } return m; };
    const gpsDriver = gpsBy((g) => g.name); const gpsDay = gpsBy((g) => g.day);
    const r1 = (n) => Math.round(n * 10) / 10;
    for (const d of days) { const g = gpsDay.get(d.day); d.gps_miles = g ? r1(g.miles) : 0; d.moving_min = g ? Math.round(g.moving_s / 60) : 0; }
    const drivers = group((r) => r.driver_name);
    for (const [name] of gpsDriver) if (!drivers.some((d) => d.name === name)) drivers.push({ name, ...summarize([]) });
    for (const d of drivers) { const g = gpsDriver.get(d.name); d.gps_miles = g ? r1(g.miles) : 0; d.moving_min = g ? Math.round(g.moving_s / 60) : 0; }
    // Cities.
    const cities = group((r) => r.city || 'Unknown');
    // Advisor scheduling: what each advisor booked and how much notice they gave.
    const advisors = group((r) => r.advisor_name || (r.source === 'customer' ? 'Customer (online request)' : null));
    for (const a of advisors) {
      const mine = rides.filter((r) => (r.advisor_name || (r.source === 'customer' ? 'Customer (online request)' : null)) === a.name);
      const notice = mine.map((r) => Math.max(0, mins(r.created_at.replace(' ', 'T') + (r.created_at.includes('T') ? '' : 'Z'), r.scheduled_at)));
      a.avg_notice_min = notice.length ? Math.round(notice.reduce((n, x) => n + x, 0) / notice.length) : null;
      a.ahead_pct = notice.length ? Math.round((notice.filter((x) => x >= 30).length / notice.length) * 100) : null;
      a.customer_ready = mine.filter((r) => r.return_of).length;
    }
    const allGps = [...gpsDriver.values()].reduce((t, g) => ({ miles: t.miles + g.miles, s: t.s + g.moving_s }), { miles: 0, s: 0 });
    const reasons = new Map();
    for (const r of rides.filter((x) => x.status === 'cancelled')) {
      const k = (r.cancel_reason || 'No reason given').split(':')[0].trim();
      reasons.set(k, (reasons.get(k) || 0) + 1);
    }
    res.json({
      from, to, timezone: tz(), type, type_counts: typeCounts,
      totals: { ...summarize(rides), gps_miles: r1(allGps.miles), moving_min: Math.round(allGps.s / 60) },
      days,
      drivers: drivers.sort((a, b) => b.rides - a.rides || b.gps_miles - a.gps_miles),
      advisors,
      cities: cities.sort((a, b) => b.rides - a.rides),
      cancel_reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    });
  });

  // ---------- customer texting (admin) ----------
  app.get('/api/sms', requireRole('admin'), (req, res) => {
    res.json({
      configured: sms.configured, from: sms.from || null,
      log: q(`SELECT l.*, r.customer_name FROM sms_log l LEFT JOIN rides r ON r.id = l.ride_id ORDER BY l.id DESC LIMIT 25`).all(),
    });
  });
  app.post('/api/sms/test', requireRole('admin'), async (req, res) => {
    if (!sms.configured) return bad(res, 'Texting is not set up yet. Add your Twilio details to the .env file first.');
    const to = toE164(req.body.to);
    if (!to) return bad(res, 'Enter a valid mobile number.');
    const body = `Test message from the ${getSettings().dealer_name} shuttle website. Customer texts are working.`;
    try { await sms.send(to, body); smsLog(null, 'test', to, body, 'sent'); res.json({ ok: true }); }
    catch (e) { smsLog(null, 'test', to, body, 'failed', e.message); bad(res, `Twilio said: ${e.message}`, 502); }
  });

  // ---------- version + updates ----------
  // The copy running background jobs also runs the automatic updates: ask it.
  async function updaterState() {
    if (!opts.updater) return {};
    if (bus.jobs) return opts.updater.state;
    try { return await bus.ask('jobs', 'updater-state', null, 3000); } catch { return opts.updater.state; }
  }
  bus.answer('updater-state', () => (opts.updater ? opts.updater.state : {}));
  bus.answer('update-check', async () => ({ result: await opts.updater.check(), state: opts.updater.state }));
  // Each copy's live numbers (Admin → Server adds them up).
  bus.answer('stats', () => ({ snapshot: stats.snapshot(), active: stats.active(), live: rawLive.count, worker: bus.worker, pid: process.pid }));
  async function allStats() {
    try { return await bus.gather('stats'); } catch { return [{ snapshot: stats.snapshot(), active: stats.active(), live: rawLive.count, worker: bus.worker, pid: process.pid }]; }
  }
  // With several cores the main process keeps the log: ask it.
  const fromPrimary = async (kind, data, fallback) => {
    if (!bus.clustered) return fallback();
    try { return await bus.ask('primary', kind, data, 3000); } catch { return fallback(); }
  };
  const serverSetting = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  async function coresInfo(parts) {
    const setting = serverSetting('server_cores') || 'auto';
    const ram = Number(serverSetting('server_ram_mb')) || 0;
    const primary = bus.clustered ? await fromPrimary('info', null, () => null) : null;
    return {
      setting, available: coresAvailable(), wanted: coresWanted(setting), running: parts.length,
      ram_mb: ram, bandwidth_mbps: Number(serverSetting('server_bandwidth_mbps')) || 0,
      fixed_by_env: { cores: process.env.CORES || null, ram_mb: process.env.RAM_MB || null }, // .env wins over these settings
      rss_mb: primary ? primary.rss_mb : null, pc_total_mb: Math.round(require('node:os').totalmem() / 1048576),
      used_by_ram: primary ? primary.count : parts.length, ram_restarts: primary ? primary.ram_restarts : 0,
      copies: parts.map((p) => ({ worker: p.worker, pid: p.pid, site_mb: p.snapshot.memory.site_mb, cpu: p.snapshot.cpu.process, live: p.live })).sort((a, b) => a.worker - b.worker),
    };
  }

  app.get('/api/version', requireRole('admin'), async (req, res) => {
    const u = await updaterState();
    res.json({ version: u.version || null, version_date: u.versionDate || null, auto_update: !!u.enabled,
      reason: u.reason || null, last_check: u.lastCheck || null, last_error: u.lastError || null });
  });
  app.post('/api/updates/check', requireRole('admin'), async (req, res) => {
    if (!opts.updater) return bad(res, 'Updates are not available here.');
    const { result, state } = bus.jobs ? { result: await opts.updater.check(), state: opts.updater.state } : await bus.ask('jobs', 'update-check', null, 600000);
    const msg = { 'up-to-date': 'You already have the latest version.', updated: 'Update installed. The site is restarting — reload in a few seconds.',
      busy: 'Already checking — try again in a moment.', skipped: state.reason || 'Automatic updates are off.',
      error: state.lastError || 'The update check failed.' }[result];
    res.status(result === 'error' ? 502 : 200).json({ result, message: msg });
  });

  // ---------- server (Admin → Server) ----------
  const dataDir = opts.dbFile && opts.dbFile !== ':memory:' ? path.dirname(opts.dbFile) : null;
  const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  function diskFree() {
    if (!dataDir || !fs.statfsSync) return null;
    try { const s = fs.statfsSync(dataDir); return { free_mb: Math.round((s.bavail * s.bsize) / 1048576), total_mb: Math.round((s.blocks * s.bsize) / 1048576) }; } catch { return null; }
  }
  // Version and "What's new", for admins.
  app.get('/api/about', requireRole('admin'), (req, res) => {
    const u = opts.updater?.state || {};
    res.json({ version: APP_VERSION, build: { hash: u.version || null, date: u.versionDate || null }, changelog: CHANGELOG });
  });

  app.get('/api/server/status', requireRole('admin'), async (req, res) => {
    const u = await updaterState();
    const b = opts.backups;
    const backups = b ? b.list() : [];
    const parts = await allStats();
    res.json({
      ...mergeSnapshots(parts),
      traffic_types: TRAFFIC_TYPES,
      cores: await coresInfo(parts),
      supervised: !!opts.supervised,
      can_restart: !!opts.restart,
      version: { app: APP_VERSION, version: u.version || null, version_date: u.versionDate || null, auto_update: !!u.enabled, reason: u.reason || null, last_check: u.lastCheck || null, last_error: u.lastError || null, checking: !!u.checking },
      database: { size_mb: Math.round(((fileSize(opts.dbFile) + fileSize(`${opts.dbFile}-wal`)) / 1048576) * 10) / 10, file: opts.dbFile || null },
      disk: diskFree(),
      shuttle: {
        open_rides: q("SELECT COUNT(*) AS n FROM rides WHERE status IN ('requested','assigned','en_route','onboard')").get().n,
        drivers_on_duty: q("SELECT COUNT(*) AS n FROM users WHERE role = 'driver' AND on_duty = 1").get().n,
        signed_in_devices: q('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(now()).n,
      },
      log_counts: await fromPrimary('logcounts', null, () => logbook.counts()),
      backups: b ? {
        count: backups.length, total_mb: Math.round((b.totalSize() / 1048576) * 10) / 10,
        last_daily: backups.find((x) => x.kind === 'daily')?.made_at || null, time: getSettings().backup_time || '', pending_restore: b.pendingRestore(),
      } : null,
      public_url: publicBase,
    });
  });

  // Can the outside world reach us, and can we reach the services we use? (cached a minute)
  let checksCache = null;
  app.get('/api/server/checks', requireRole('admin'), async (req, res) => {
    if (checksCache && Date.now() - checksCache.at < 60000 && !req.query.fresh) return res.json(checksCache.data);
    const timed = async (fn) => {
      const t0 = Date.now();
      try { const note = await fn(); return { ok: true, ms: Date.now() - t0, note: note || null }; } catch (e) { return { ok: false, ms: Date.now() - t0, note: e.message }; }
    };
    const dealer = dealerOrigin();
    const [publicSite, routing] = await Promise.all([
      publicBase ? timed(async () => {
        const r = await fetch(`${publicBase}/healthz`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        return publicBase;
      }) : Promise.resolve({ ok: null, note: 'Not known yet. It appears after the first visit through your web address, or set PUBLIC_URL in .env.' }),
      opts.router ? timed(async () => { await opts.router.path([dealer, { lat: dealer.lat + 0.01, lng: dealer.lng }]); return 'Real road times available'; })
        : Promise.resolve({ ok: null, note: 'Turned off (ROUTING=off). Routes use estimates.' }),
    ]);
    // cloudflared on this PC (it serves its own status on 127.0.0.1).
    const t = await (opts.tunnelProbe || tunnelKit.probe)();
    const tunnel = t.running
      ? { ok: t.ready, note: t.ready ? `${t.connections} connection${t.connections === 1 ? '' : 's'} to Cloudflare${t.locations.length ? ` through ${t.locations.join(', ')}` : ''}` : 'cloudflared is running but not connected yet', connections: t.connections, locations: t.locations }
      : { ok: null, note: "cloudflared's status isn't visible on this PC (an older version, or it isn't running). Open Shuttle Control on the server PC to check or connect." };
    const database = await timed(async () => {
      const r = q('PRAGMA quick_check').get();
      const v = Object.values(r)[0];
      if (v !== 'ok') throw new Error(String(v));
      return 'No problems found';
    });
    const data = { at: now(), public_site: publicSite, routing, database, tunnel, live_clients: (await allStats()).reduce((n, p) => n + p.live, 0) };
    checksCache = { at: Date.now(), data };
    res.json(data);
  });

  app.get('/api/server/logs', requireRole('admin'), async (req, res) => {
    const want = { after: Number(req.query.after) || 0, level: req.query.level, q: req.query.q, limit: req.query.limit };
    res.json({ lines: await fromPrimary('logs', want, () => logbook.recent(want)),
      files: (opts.logsDir ? createLogbook({ dir: opts.logsDir }).files() : []) });
  });
  app.get('/api/server/logs/file/:day', requireRole('admin'), (req, res) => {
    const p = opts.logsDir && createLogbook({ dir: opts.logsDir }).filePath(req.params.day);
    if (!p) return bad(res, 'No log for that day.', 404);
    res.download(p);
  });

  // Speed test: the page times a few of these. Cloudflare's data center code comes from the CF-Ray header.
  // ---------- page speed on real devices ----------
  // Every page reports how long it took to load (see the end of common.js). Only times,
  // the page (tracking links shortened to /t), the kind of device and network are kept.
  const PERF_PAGES = { '/': '/', '/admin': '/admin', '/advisor': '/advisor', '/driver': '/driver', '/login': '/login', '/request': '/request' };
  const PERF_PARTS = ['dns', 'connect', 'tls', 'wait', 'download', 'build', 'ready', 'data', 'tiles'];
  app.post('/api/perf', (req, res) => {
    res.status(204).end();
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const p = String(b.page || '');
    const page = PERF_PAGES[p] || (p.startsWith('/t/') ? '/t' : p.startsWith('/reset/') ? '/reset' : null);
    if (!page) return;
    const key = `perf|${clientIp(req)}`;
    if (limits.count(key, 3600000) >= 120) return; // one device can't flood it
    limits.hit(key, 3600000);
    const n = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 ? Math.min(x, 600000) : 0; };
    const word = (v, ok) => (ok.includes(String(v)) ? String(v) : '');
    const vals = PERF_PARTS.map((k) => n(b[k]));
    if (!vals[PERF_PARTS.indexOf('ready')]) return;
    q(`INSERT INTO perf (at, page, role, device, net, proto, nav, ${PERF_PARTS.join(', ')}, tiles_n) VALUES (?, ?, ?, ?, ?, ?, ?, ${PERF_PARTS.map(() => '?').join(', ')}, ?)`)
      .run(now(), page, req.user ? req.user.role : 'customer', word(b.device, ['phone', 'computer']), word(b.net, ['slow-2g', '2g', '3g', '4g']),
        word(b.proto, ['h3', 'h2', 'http/1.1']), word(b.type, ['navigate', 'reload', 'back_forward', 'prerender']), ...vals, Math.min(n(b.tiles_n), 500));
  });
  app.get('/api/server/perf', requireRole('admin'), (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 14);
    const rows = q('SELECT * FROM perf WHERE at >= ? ORDER BY at DESC LIMIT 20000').all(new Date(Date.now() - days * 86400000).toISOString());
    const pct = (list, p) => { const v = list.filter((x) => x != null).sort((a, c) => a - c); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };
    const sum = (list) => ({ median: pct(list, 0.5), p90: pct(list, 0.9), worst: list.length ? Math.max(...list) : null });
    const fresh = rows.filter((r) => r.dns > 0 || r.connect > 0); // had to look up the address / connect
    const parts = {
      dns: sum(fresh.map((r) => r.dns)), connect: sum(fresh.map((r) => r.connect)), wait: sum(rows.map((r) => r.wait)),
      download: sum(rows.map((r) => r.download)), build: sum(rows.map((r) => r.build)), ready: sum(rows.map((r) => r.ready)),
      data: sum(rows.filter((r) => r.data).map((r) => r.data)), tiles: sum(rows.filter((r) => r.tiles_n).map((r) => r.tiles)),
    };
    const LABEL = { dns: 'Finding the address (DNS)', connect: 'Connecting', wait: 'Waiting for the shuttle PC', download: 'Downloading', build: 'Building the page', data: 'Loading rides and data', tiles: 'Map images' };
    const biggest = (r) => {
      const cand = { dns: r.dns, connect: r.connect, wait: r.wait, download: r.download, build: r.build, data: r.data ? Math.max(0, r.data - r.ready) : 0, tiles: r.tiles_n ? r.tiles : 0 };
      const k = Object.keys(cand).sort((a, c) => cand[c] - cand[a])[0];
      return { part: k, label: LABEL[k], ms: cand[k] };
    };
    const SLOW = 5000;
    const slow = rows.filter((r) => Math.max(r.ready, r.data || 0) >= SLOW).slice(0, 25).map((r) => ({
      at: r.at, page: r.page, role: r.role, device: r.device, net: r.net, proto: r.proto,
      ready: r.ready, data: r.data, dns: r.dns, connect: r.connect, wait: r.wait, download: r.download, tiles: r.tiles, biggest: biggest(r),
    }));
    const blame = {}; for (const s of rows.filter((r) => Math.max(r.ready, r.data || 0) >= SLOW)) { const k = biggest(s).part; blame[k] = (blame[k] || 0) + 1; }
    const byPage = {};
    for (const r of rows) (byPage[r.page] = byPage[r.page] || []).push(r.ready);
    const byDevice = {};
    for (const r of rows) { const k = `${r.device || 'unknown'}${r.net ? ` · ${r.net}` : ''}`; (byDevice[k] = byDevice[k] || []).push(r.ready); }
    res.json({
      days, count: rows.length, slow_ms: SLOW, slow_count: rows.filter((r) => Math.max(r.ready, r.data || 0) >= SLOW).length,
      parts, labels: LABEL, slow, blame,
      pages: Object.entries(byPage).map(([page, v]) => ({ page, count: v.length, ...sum(v) })).sort((a, c) => c.count - a.count),
      devices: Object.entries(byDevice).map(([device, v]) => ({ device, count: v.length, ...sum(v) })).sort((a, c) => c.count - a.count),
    });
  });

  app.get('/api/server/ping', requireRole('admin'), (req, res) => {
    const ray = String(req.get('cf-ray') || '');
    res.set('Cache-Control', 'no-store').json({ t: Date.now(), colo: ray.includes('-') ? tunnelKit.placeOf(ray.split('-').pop()) : null, via_cloudflare: !!req.get('cf-connecting-ip') });
  });

  app.get('/api/server/updates', requireRole('admin'), async (req, res) => {
    res.json({ history: opts.updater?.history ? await opts.updater.history() : [] });
  });

  app.post('/api/server/restart', requireRole('admin'), (req, res) => {
    if (!opts.restart) return bad(res, 'Restart is not available here.');
    console.log(new Date().toLocaleString(), `[server] Restart requested by ${req.user.name}.`);
    res.json({ ok: true, message: 'Restarting. The site will be back in about 10 seconds.' });
    setTimeout(opts.restart, 300);
  });

  // Processor cores, memory and bandwidth (super admins). Cores and memory are used from the
  // next restart; the bandwidth limit right away.
  app.put('/api/server/resources', requireRole('admin'), async (req, res) => {
    const b = req.body || {};
    const avail = coresAvailable();
    const set = (k, v) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    const before = { cores: serverSetting('server_cores') || 'auto', ram: Number(serverSetting('server_ram_mb')) || 0 };
    if (b.cores != null) {
      const v = String(b.cores).trim().toLowerCase();
      const n = Number(v);
      if (v !== 'auto' && !(Number.isInteger(n) && n >= 1 && n <= avail)) return bad(res, `Pick Auto or 1 to ${avail} cores.`);
      set('server_cores', v);
    }
    if (b.ram_mb != null) {
      const n = Number(b.ram_mb);
      if (!(Number.isInteger(n) && (n === 0 || (n >= 512 && n <= 1048576)))) return bad(res, 'Pick no limit, or at least 512 MB.');
      set('server_ram_mb', String(n));
    }
    if (b.bandwidth_mbps != null) {
      const n = Number(b.bandwidth_mbps);
      if (!(Number.isFinite(n) && (n === 0 || (n >= 1 && n <= 10000)))) return bad(res, 'Pick no limit, or 1 to 10000 Mbps.');
      set('server_bandwidth_mbps', String(n));
    }
    const after = { cores: serverSetting('server_cores') || 'auto', ram: Number(serverSetting('server_ram_mb')) || 0 };
    console.log(new Date().toLocaleString(), `[server] ${req.user.name} set cores ${after.cores}, memory ${after.ram ? `${after.ram} MB` : 'no limit'}, bandwidth ${Number(serverSetting('server_bandwidth_mbps')) ? `${serverSetting('server_bandwidth_mbps')} Mbps` : 'no limit'}.`);
    res.json({ cores: await coresInfo(await allStats()), restart_needed: before.cores !== after.cores || before.ram !== after.ram });
  });

  // Backups
  const needBackups = (res) => { if (!opts.backups) { bad(res, 'Backups are not set up on this server.'); return false; } return true; };
  app.get('/api/server/backups', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    res.json({ backups: opts.backups.list(), pending_restore: opts.backups.pendingRestore(), time: getSettings().backup_time || '' });
  });
  app.post('/api/server/backups', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    try { res.status(201).json({ backup: opts.backups.make('manual') }); } catch (e) { bad(res, `Backup failed: ${e.message}`, 500); }
  });
  app.get('/api/server/backups/:name', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    const p = opts.backups.path(req.params.name);
    if (!p) return bad(res, 'Backup not found.', 404);
    res.download(p);
  });
  app.delete('/api/server/backups/:name', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    if (!opts.backups.remove(req.params.name)) return bad(res, 'Backup not found.', 404);
    res.json({ ok: true });
  });
  app.post('/api/server/backups/:name/restore', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    if (!opts.restart) return bad(res, 'Restoring needs the site started with start-shuttle.bat, so it can restart itself.');
    try { opts.backups.scheduleRestore(req.params.name); } catch (e) { return bad(res, e.message); }
    console.log(new Date().toLocaleString(), `[backups] ${req.user.name} asked to restore ${req.params.name}. Restarting to swap it in...`);
    res.json({ ok: true, message: 'Restoring. The site restarts and will be back in about 10 seconds.' });
    setTimeout(opts.restart, 300);
  });
  app.delete('/api/server/restore', requireRole('admin'), (req, res) => {
    if (!needBackups(res)) return;
    opts.backups.cancelRestore(); res.json({ ok: true });
  });

  // ---------- Help & suggestions (Discord) ----------
  // Staff send help requests, ideas and problems from any page. They're saved here and, if a
  // Discord webhook is set (Admin → Settings), posted to that Discord channel. The webhook
  // address is a secret: it's never sent to browsers.
  const KINDS = { help: ['🙋 Help request', 0x1a73e8], idea: ['💡 Suggestion', 0x0f8a3c], problem: ['🐞 Problem', 0xeb0a1e] };
  const WEBHOOK_RE = /^https:\/\/((ptb|canary)\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
  async function postToDiscord({ kind, message, from, page }) {
    const hook = getSettings().discord_webhook;
    if (!hook) return { sent: false, error: null };
    const [title, color] = KINDS[kind] || KINDS.help;
    const body = {
      username: 'Shuttle website', allowed_mentions: { parse: [] }, // never ping @everyone
      embeds: [{ title, description: message.slice(0, 3900), color, timestamp: new Date().toISOString(),
        fields: [{ name: 'From', value: from.slice(0, 200), inline: true }, ...(page ? [{ name: 'Page', value: page.slice(0, 200), inline: true }] : [])],
        footer: { text: getSettings().dealer_name || 'Shuttle' } }],
    };
    try {
      const r = await (opts.discordFetch || fetch)(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`Discord answered ${r.status}`);
      return { sent: true, error: null };
    } catch (e) { return { sent: false, error: e.message }; }
  }
  app.post('/api/feedback', requireRole(), async (req, res) => {
    const kind = KINDS[req.body.kind] ? req.body.kind : 'help';
    const message = str(req.body.message, 2000);
    if (!message || message.length < 3) return bad(res, 'Type a message first.');
    if (limits.count(`feedback|${req.user.id}`, 3600000) >= 10) return bad(res, 'That’s a lot of messages in an hour. Try again a bit later.', 429);
    limits.hit(`feedback|${req.user.id}`, 3600000);
    const page = str(req.body.page, 200);
    const from = `${req.user.name} (${req.user.role})`;
    const out = await postToDiscord({ kind, message, from, page });
    q('INSERT INTO feedback (user_id, kind, message, page, sent, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, kind, message, page, out.sent ? 1 : 0, out.error, now());
    if (out.error) console.error(new Date().toLocaleString(), '[feedback] Could not post to Discord:', out.error);
    res.status(201).json({ ok: true, sent_to_discord: out.sent });
  });
  app.get('/api/feedback', requireRole('admin'), (req, res) => {
    const s = getSettings(); const hook = s.discord_webhook || '';
    res.json({
      webhook_set: !!hook, webhook_hint: hook ? `…/${hook.split('/').pop().slice(-4)}` : null, invite: s.discord_invite || '',
      items: q(`SELECT f.*, u.name AS user_name, u.role AS user_role FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 50`).all(),
    });
  });
  app.put('/api/feedback/webhook', requireRole('admin'), (req, res) => {
    const hook = String(req.body.webhook || '').trim();
    if (hook && !WEBHOOK_RE.test(hook)) return bad(res, 'Paste a Discord webhook link (it starts with https://discord.com/api/webhooks/).');
    if (hook) q("INSERT INTO settings (key, value) VALUES ('discord_webhook', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hook);
    else q("DELETE FROM settings WHERE key = 'discord_webhook'").run();
    res.json({ ok: true, webhook_set: !!hook });
  });
  app.post('/api/feedback/test', requireRole('admin'), async (req, res) => {
    if (!getSettings().discord_webhook) return bad(res, 'Add the Discord webhook link first.');
    const out = await postToDiscord({ kind: 'help', message: 'Test message from the shuttle website. Help & suggestions are connected. ✅', from: `${req.user.name} (admin)`, page: 'Admin → Settings' });
    if (!out.sent) return bad(res, `Discord didn't accept it: ${out.error}`, 502);
    res.json({ ok: true });
  });

  // ---------- QR codes + share links ----------
  app.get('/api/links', requireRole(), (req, res) => {
    const base = baseUrl(req);
    res.json({ links: [
      { key: 'request', label: 'Customer: request a shuttle ride', url: `${base}/request` },
      { key: 'login', label: 'Staff sign-in', url: `${base}/login` },
      { key: 'driver', label: 'Driver app', url: `${base}/driver` },
      { key: 'advisor', label: 'Advisor desk', url: `${base}/advisor` },
    ] });
  });

  app.get('/api/qr', requireRole(), async (req, res) => {
    const text = String(req.query.text || '');
    // Only make QR codes for links to this site, so it can't be used as an open QR generator.
    if (!text.startsWith(baseUrl(req) + '/')) return bad(res, 'QR codes can only point to this site.');
    if (text.length > 500) return bad(res, 'That link is too long for a QR code.');
    const png = await QRCode.toBuffer(qrText(text), { width: Math.min(num(req.query.size) || 320, 1024), margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'private, max-age=3600').send(png);
  });

  // Track pages show their own QR so a customer can hand the link to someone else.
  app.get('/api/public/track/:token/qr', async (req, res) => {
    const ride = trackedRide(req, res); if (!ride) return;
    const png = await QRCode.toBuffer(qrText(`${baseUrl(req)}/t/${ride.track_token}`), { width: 320, margin: 2 });
    res.type('png').send(png);
  });

  app.get('/api/public/request-qr', async (req, res) => {
    const png = await QRCode.toBuffer(qrText(`${baseUrl(req)}/request`), { width: Math.min(num(req.query.size) || 320, 1024), margin: 2 });
    res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
  });

  // ---------- geocoding (address search) ----------
  // Address search uses OpenStreetMap's free Nominatim service, which allows about one
  // lookup a second and blocks sites that go over. Lookups are cached, shared when two
  // people type the same thing, paced to one at a time, and time out after 8 seconds.
  const geoCache = new Map(); const geoInFlight = new Map();
  app.get('/api/geocode', requireRole(), async (req, res) => geocode(req, res));
  app.get('/api/public/geocode', async (req, res) => {
    if (getSettings().public_requests !== '1') return bad(res, 'Disabled.', 403);
    const key = `geo|${clientIp(req)}`; // customer page: lookups per address per hour
    if (limits.count(key, 3600000) >= 60) return res.json({ results: [], error: 'Too many searches. Tap the map to drop a pin instead.' });
    limits.hit(key, 3600000);
    return geocode(req, res);
  });
  async function lookupAddress(text) {
    // The free address service allows about one lookup a second, from all copies together.
    const wait = limits.turn('geocoder', 1100, 5000);
    if (wait === null) throw new Error('busy'); // too many people searching at once
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const o = dealerOrigin();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
      q: text, format: 'jsonv2', limit: '5', countrycodes: 'us',
      viewbox: `${o.lng - 0.6},${o.lat + 0.4},${o.lng + 0.6},${o.lat - 0.4}`, bounded: '0',
    });
    const r = await fetch(url, { headers: { 'User-Agent': 'DealershipShuttleApp/1.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`geocoder ${r.status}`);
    const data = await r.json();
    return data.map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
  }
  async function geocode(req, res) {
    const text = str(req.query.q, 200);
    if (!text || text.length < 3) return res.json({ results: [] });
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (geoCache.has(key)) return res.json({ results: geoCache.get(key) });
    try {
      let job = geoInFlight.get(key);
      if (!job) {
        job = (opts.geocoder ? Promise.resolve(opts.geocoder(text)) : lookupAddress(text)).finally(() => geoInFlight.delete(key));
        geoInFlight.set(key, job);
      }
      const results = await job;
      geoCache.set(key, results);
      if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
      res.json({ results });
    } catch (e) {
      const busy = e.message === 'busy';
      res.json({ results: [], error: busy ? 'Lots of people are searching right now. Keep typing, or tap the map to drop a pin.'
        : 'Address search is unavailable right now. Tap the map to drop a pin instead.' });
    }
  }

  // ---------- pages ----------
  const pub = path.join(__dirname, '..', 'public');
  // Pages are never cached. Every script/stylesheet link in them carries a stamp made
  // from the file's contents, so after an update browsers and Cloudflare fetch only the
  // files that really changed, and keep using their saved copies of the rest.
  const leafletDir = path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist');
  const stamps = new Map();
  function stampOf(url) {
    if (!stamps.has(url)) {
      const file = url.startsWith('/vendor/leaflet/') ? path.join(leafletDir, url.slice('/vendor/leaflet/'.length)) : path.join(pub, url);
      let v = opts.assetVersion || 'x';
      try { v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10); } catch { /* missing: keep the fallback */ }
      stamps.set(url, v);
    }
    return stamps.get(url);
  }
  // Early hints in each page: start connecting to the map image server, and fetch the
  // main fonts while the stylesheet is still on its way.
  const FONT_PRELOAD = ['/vendor/fonts/barlow/barlow-latin-400-normal.woff2', '/vendor/fonts/barlow/barlow-latin-700-normal.woff2']
    .map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`).join('');
  const MAP_HINT = '<link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin><link rel="dns-prefetch" href="https://tile.openstreetmap.org">';
  const pageCache = new Map();
  const page = (file) => (req, res, next) => {
    let html = pageCache.get(file);
    if (!html) {
      try { html = fs.readFileSync(path.join(pub, file), 'utf8'); } catch (e) { return next(e); }
      html = html.replace(/((?:src|href)="(\/(?:js|css|vendor\/leaflet)\/[^"?]+\.(?:js|css)))"/g, (m, attr, url) => `${attr}?v=${stampOf(url)}"`);
      const hints = (html.includes('/vendor/leaflet/') ? MAP_HINT : '') + FONT_PRELOAD;
      html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${hints}`);
      pageCache.set(file, html);
    }
    const s = getSettings();
    const color = /^#[0-9a-f]{6}$/i.test(s.brand_color || '') ? s.brand_color : DEFAULT_SETTINGS.brand_color;
    const dark = /^#[0-9a-f]{6}$/i.test(s.brand_dark || '') ? s.brand_dark : DEFAULT_SETTINGS.brand_dark;
    const look = s.look === 'corwin' ? 'corwin' : 'classic';
    const logo = s.brand_logo ? (s.brand_logo_v || '1') : '';
    const name = String(s.brand_name || s.dealer_name || '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.set('Cache-Control', 'no-store').type('html')
      .send(html.replace('<html lang="en">', `<html lang="en" data-look="${look}" data-site-look="${look}" data-logo="${logo}" data-brand-name="${name}" data-egg="${s.easter_egg === '0' ? '0' : '1'}" data-tz="${tz()}" style="--brand:${color};--brand-dark:${dark}">`));
  };
  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.redirect(`/${req.user.role}`);
  });
  app.get('/login', page('login.html'));
  app.get('/advisor', page('advisor.html'));
  app.get('/driver', page('driver.html'));
  app.get('/admin', page('admin.html'));
  app.get('/request', page('request.html'));
  app.get('/t/:token', page('track.html'));
  app.get('/reset/:token', (req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); }, page('reset.html'));
  // The app manifest must always be fresh, so it's never cached (sw.js has its own route below).
  for (const [route, file, type] of [['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json']]) {
    app.get(route, (req, res) => res.set('Cache-Control', 'no-cache').type(type).sendFile(path.join(pub, file)));
  }
  // Scripts and styles: their links are version-stamped, so they can be cached.
  // The background helper (sw.js) must never be stored by browsers or Cloudflare, or fixes
  // to it would take weeks to reach phones. Its version follows its contents.
  let swText = null;
  app.get('/sw.js', (req, res, next) => {
    if (!swText) {
      try {
        const raw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
        swText = raw.replace('__VERSION__', crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10));
      } catch (e) { return next(e); }
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate').type('application/javascript').send(swText);
  });
  app.use(express.static(pub, {
    index: false, maxAge: '30d',
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
  }));
  // Brand fonts for the Corwin look (bundled, so pages don't depend on an outside font site).
  app.use('/vendor/fonts/barlow', express.static(path.join(path.dirname(require.resolve('@fontsource/barlow/package.json')), 'files'), { maxAge: '30d' }));
  app.use('/vendor/fonts/barlow-sc', express.static(path.join(path.dirname(require.resolve('@fontsource/barlow-semi-condensed/package.json')), 'files'), { maxAge: '30d' }));
  app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { maxAge: '30d' }));

  app.use('/api', (req, res) => bad(res, 'Not found.', 404));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    // Requests that aren't readable (not JSON, or too big) are the sender's mistake, not ours.
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: "That request couldn't be read." });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
    // Two people adding the same email at the same moment: the database refuses the second.
    if (/UNIQUE constraint failed: users\.email/.test(err && err.message)) return res.status(400).json({ error: 'That email already has an account.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  // Forget old sign-in failures and request counts so these lists can't grow forever.
  if (jobsHere) {
    setInterval(() => {
      try { limits.prune(); } catch (e) { console.error('Clearing old limits failed:', e.message); }
      try { q('DELETE FROM perf WHERE at < ?').run(new Date(Date.now() - 14 * 86400000).toISOString()); } catch (e) { console.error('Clearing old page speeds failed:', e.message); }
    }, 10 * 60000).unref();
  }

  return app;
}

function ensureAdmin(db, { email, password, name } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const pw = password || randomToken(9);
  const em = email || 'admin@example.com';
  db.prepare("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'admin', ?)")
    .run(name || 'Shuttle Admin', em, hashPassword(pw));
  return { email: em, password: password ? null : pw };
}

module.exports = { createApp, ensureAdmin };
