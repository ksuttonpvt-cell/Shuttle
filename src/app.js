const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { hashPassword, hashPasswordAsync, verifyPasswordAsync, validatePassword, randomToken, parseCookies } = require('./auth');
const { rankRides, distanceKm } = require('./priority');
const { toE164, createTwilioSender } = require('./sms');
const { createPush } = require('./push');
const { planRoute, KM_TO_MI, STOP_MINUTES } = require('./routing');

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
  timezone: 'America/Denver',
  service_radius_mi: '15.5',
  auto_end_shift: '20:00', // every driver is taken off shift at this local time each day ('' = off)
  auto_sign_out: '00:00',  // everyone is signed out at this local time each day ('' = off)
  ride_offers: '1',        // offer waiting rides to the closest free driver, who can accept or pass
  clear_customer_info: '00:00', // finished rides lose their customer details at this local time each day ('' = off)
  // Automatic customer texts (only sent once Twilio is set up in .env)
  sms_booked: '1',
  sms_en_route: '1',
  sms_cancelled: '1',
};
const YES_NO_SETTINGS = ['public_requests', 'ride_offers', 'sms_booked', 'sms_en_route', 'sms_cancelled'];

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
  app.use(express.json({ limit: '100kb' }));

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
  const now = () => new Date().toISOString();

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    q('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  function getSettings() {
    const s = {};
    for (const row of q('SELECT key, value FROM settings').all()) s[row.key] = row.value;
    return s;
  }
  // Only these settings ever leave the server (never the notification keys).
  function shareableSettings() {
    const s = getSettings(); const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
    return out;
  }
  // How far from the dealership the shuttle will go, in miles (0 = no limit).
  const serviceRadius = () => Math.max(0, Number(getSettings().service_radius_mi) || 0);
  const milesFromDealer = (lat, lng) => distanceKm(dealerOrigin(), { lat, lng }) * 0.621371;
  function dealerOrigin() {
    const s = getSettings();
    return { lat: Number(s.dealer_lat), lng: Number(s.dealer_lng) };
  }
  function baseUrl(req) {
    return (opts.publicUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  }
  const publicUser = (u) => u && ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, active: !!u.active,
    on_duty: !!u.on_duty, vehicle_id: u.vehicle_id, last_lat: u.last_lat, last_lng: u.last_lng,
    last_loc_at: u.last_loc_at, created_at: u.created_at, reset_requested_at: u.reset_requested_at || null,
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
      if (row) { req.user = row; req.sessionToken = token; }
    }
    next();
  });
  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return bad(res, 'Please sign in.', 401);
    if (roles.length && !roles.includes(req.user.role) && req.user.role !== 'admin') return bad(res, 'Not allowed.', 403);
    next();
  };

  // Sign-in throttle: 10 wrong passwords per 15 min from one address for one email, and
  // 30 per 15 min for one email from anywhere (stops guessing spread over many addresses).
  const failures = new Map();
  function throttled(key, limit = 10) {
    const f = failures.get(key);
    if (!f) return false;
    if (Date.now() - f.first > 15 * 60000) { failures.delete(key); return false; }
    return f.count >= limit;
  }
  function recordFailure(key) {
    const f = failures.get(key) || { count: 0, first: Date.now() };
    f.count += 1; failures.set(key, f);
  }

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
    if (!user || !user.active || !ok) {
      recordFailure(key); recordFailure(emailKey);
      return bad(res, 'Email or password is incorrect.', 401);
    }
    failures.delete(key);
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

  app.get('/api/me', (req, res) => {
    res.json({ user: publicUser(req.user) || null, settings: shareableSettings(), base_url: baseUrl(req) });
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

  app.post('/api/password-reset/request', (req, res) => {
    const email = str(req.body.email, 200);
    if (!email) return bad(res, 'Enter your email.');
    const ipKey = `reset|${clientIp(req)}`;
    if (throttled(ipKey, 5)) return bad(res, 'Too many requests. Try again in 15 minutes.', 429);
    recordFailure(ipKey);
    const user = q('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    // Only alert admins once an hour per person, so the button can't be used to spam them.
    if (user && !(user.reset_requested_at && Date.now() - new Date(user.reset_requested_at) < 3600000)) {
      q('UPDATE users SET reset_requested_at = ? WHERE id = ?').run(now(), user.id);
      const admins = q("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map((a) => a.id);
      quietly(push.notifyUsers(admins, { title: '🔑 Password reset requested', body: `${user.name} (${user.email}) forgot their password. Open Admin → Staff & logins to send a reset link.`, tag: `reset-${user.id}`, url: '/admin#users' }));
    }
    // Same answer whether or not the email has an account.
    res.json({ ok: true });
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
  app.get('/api/users', requireRole('admin', 'advisor'), (req, res) => {
    const rows = q('SELECT * FROM users ORDER BY role, name').all();
    res.json({ users: rows.map(publicUser) });
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
      user.role = b.role;
    }
    if (b.active != null) {
      if (user.id === req.user.id && !b.active) return bad(res, "You can't deactivate yourself.");
      user.active = b.active ? 1 : 0;
    }
    q('UPDATE users SET name=?, email=?, phone=?, role=?, active=? WHERE id=?')
      .run(user.name, user.email, user.phone, user.role, user.active, user.id);
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
  const VEHICLE_FIELDS = ['name', 'make_model', 'year', 'color', 'plate', 'vin', 'seats', 'mileage', 'status', 'notes'];
  function cleanVehicle(b, existing = {}) {
    const v = { ...existing };
    for (const f of VEHICLE_FIELDS) {
      if (b[f] === undefined) continue;
      v[f] = ['year', 'seats', 'mileage'].includes(f) ? num(b[f]) : str(b[f], 300);
    }
    if (!v.name) return { error: 'Vehicle name is required (e.g. "Shuttle 1").' };
    if (!['available', 'maintenance', 'retired'].includes(v.status || 'available')) return { error: 'Bad status.' };
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

  app.delete('/api/vehicles/:id', requireRole('admin'), (req, res) => {
    q('DELETE FROM vehicles WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- drivers: shift + location ----------
  app.post('/api/driver/shift', requireRole('driver'), (req, res) => {
    const onDuty = !!req.body.on_duty;
    let vehicleId = num(req.body.vehicle_id);
    if (onDuty) {
      if (!vehicleId) return bad(res, 'Pick the vehicle you are driving.');
      const v = q('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
      if (!v || v.status !== 'available') return bad(res, 'That vehicle is not available.');
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
  });

  app.post('/api/driver/location', requireRole('driver'), (req, res) => {
    const lat = num(req.body.lat); const lng = num(req.body.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad(res, 'Bad location.');
    const heading = num(req.body.heading); const speed = num(req.body.speed);
    q('UPDATE users SET last_lat = ?, last_lng = ?, last_loc_at = ?, last_heading = ?, last_speed = ? WHERE id = ?')
      .run(lat, lng, now(), heading != null && heading >= 0 && heading <= 360 ? heading : null, speed != null && speed >= 0 && speed < 100 ? speed : null, req.user.id);
    scheduleOfferSweep();
    res.json({ ok: true });
  });

  // ---------- live map + planned routes ----------
  // A saved route, minus stops whose ride is finished, cancelled or handed to someone else.
  function liveRoute(user) {
    if (!user.route_json) return null;
    let route; try { route = JSON.parse(user.route_json); } catch { return null; }
    const ids = route.stops.filter((x) => x.ride_id).map((x) => x.ride_id);
    if (!ids.length) return route;
    const rows = q(`SELECT id, type, status FROM rides WHERE id IN (${ids.map(() => '?').join(',')})
                    AND status IN ('requested','assigned','en_route','onboard') AND (driver_id = ? OR driver_id IS NULL)`).all(...ids, user.id);
    const open = new Map(rows.map((r) => [r.id, r]));
    route.stops = route.stops.filter((x) => !x.ride_id || open.has(x.ride_id));
    if (!route.stops.some((x) => x.ride_id)) return null; // every ride on it is done
    // The "collect drop-off customers at the dealership" stop is done once they're all on board.
    const waiting = rows.some((r) => r.type === 'dropoff' && r.status !== 'onboard');
    if (!waiting && route.stops.length > 1 && route.stops[0].kind === 'dealer') route.stops.shift();
    return route;
  }
  // Small and fast, so maps can ask every few seconds.
  app.get('/api/drivers/live', requireRole(), (req, res) => {
    const rows = q(`SELECT u.*, v.name AS vehicle_name FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
                    WHERE u.role = 'driver' AND u.active = 1 AND u.on_duty = 1`).all();
    res.json({
      at: now(),
      drivers: rows.map((u) => ({
        id: u.id, name: u.name, vehicle_name: u.vehicle_name, lat: u.last_lat, lng: u.last_lng, at: u.last_loc_at,
        heading: u.last_heading, speed: u.last_speed, route: liveRoute(u),
      })),
    });
  });

  // ---------- nearby ride offers ----------
  // A ride waiting for a driver is offered to the closest free driver (no rides, or just
  // finishing one) with a ding and a phone notification. They accept or pass; if they
  // pass or don't answer in time, it goes to the next closest driver.
  const OFFER_SECONDS = 90;
  let sweepTimer = null;
  function scheduleOfferSweep() {
    if (opts.noTimers || sweepTimer) return; // tests run app.locals.offerSweep themselves
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      try { offerSweep(); } catch (e) { console.error('Ride offers failed:', e.message); }
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
      .all(new Date(at.getTime() - 10 * 60000).toISOString())
      .filter((d) => d.load <= 1); // free, or only finishing one ride
    const dealer = dealerOrigin();
    const recent = new Date(at.getTime() - 30 * 60000).toISOString();
    const made = [];
    for (const r of rides) {
      if (!drivers.length) break;
      const passed = new Set(q(`SELECT driver_id FROM ride_offers WHERE ride_id = ? AND status IN ('declined','expired') AND created_at >= ?`)
        .all(r.id, recent).map((x) => x.driver_id));
      // Pick ups: go to the customer. Drop offs: the customer is at the dealership.
      const target = r.type === 'pickup' && r.lat != null ? { lat: r.lat, lng: r.lng } : dealer;
      const best = drivers.filter((d) => !passed.has(d.id) && (!d.seats || d.riding + r.passengers <= d.seats)) // room in the van
        .map((d) => ({ d, km: distanceKm({ lat: d.last_lat, lng: d.last_lng }, target) + d.load * 2.5 })) // busy drivers count as a bit further away
        .sort((a, b) => a.km - b.km)[0];
      if (!best) continue;
      const miles = Math.round(distanceKm({ lat: best.d.last_lat, lng: best.d.last_lng }, target) * KM_TO_MI * 1.35 * 10) / 10;
      const minutes = Math.max(1, Math.round((miles / 28) * 60));
      const id = Number(q('INSERT INTO ride_offers (ride_id, driver_id, miles, minutes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.id, best.d.id, miles, minutes, nowIso, new Date(at.getTime() + OFFER_SECONDS * 1000).toISOString()).lastInsertRowid);
      drivers = drivers.filter((d) => d.id !== best.d.id);
      const where = r.type === 'pickup' ? `${miles} mi away (about ${minutes} min)` : `customer is at the dealership, ${miles} mi from you`;
      quietly(push.notifyUsers([best.d.id], {
        title: best.d.load ? '🚐 Ride near you when you finish' : "🚐 You're free: ride near you",
        body: `${r.type === 'pickup' ? 'Pick up' : 'Drop off'} ${r.customer_name} · ${where}. Want it?`,
        tag: `offer-${id}`, url: '/driver', offer_id: id,
      }));
      made.push({ id, ride_id: r.id, driver_id: best.d.id, miles, minutes });
    }
    return made;
  }
  app.locals.offerSweep = offerSweep;
  if (!opts.noTimers) setInterval(() => { try { offerSweep(); } catch (e) { console.error('Ride offers failed:', e.message); } }, 15000).unref();

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
    res.json({ ok: true, ride: withLinks(req, q(`${RIDE_SELECT} WHERE r.id = ?`).get(o.ride_id)) });
  });

  const MAX_ROUTE_RIDES = 12;
  async function buildRoute(req) {
    const ids = [...new Set((Array.isArray(req.body.ride_ids) ? req.body.ride_ids : []).map(Number).filter(Boolean))];
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
    if (fromLat != null && fromLng != null && Math.abs(fromLat) <= 90 && Math.abs(fromLng) <= 180) start = { lat: fromLat, lng: fromLng, label: 'You' };
    else if (req.user.last_lat != null) start = { lat: req.user.last_lat, lng: req.user.last_lng, label: 'You' };
    else start = { ...dealer, label: 'Dealership' };

    const skipped = rides.filter((r) => r.lat == null).map((r) => r.customer_name);
    // keep_order: save the exact order the driver just previewed (and sent to Google Maps).
    const keepOrder = !!req.body.keep_order;
    if (keepOrder) rides.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const stops = rides.filter((r) => r.lat != null && !(r.type === 'pickup' && r.status === 'onboard')).map((r) => ({
      lat: r.lat, lng: r.lng, kind: r.type, ride_id: r.id, label: `${r.type === 'pickup' ? 'Pick up' : 'Drop off'} ${r.customer_name}`, address: r.address,
      people: r.type === 'pickup' ? r.passengers : -r.passengers, // getting in / getting out
    }));
    // Drop-off customers have to be collected at the dealership before anything else.
    const atDealer = distanceKm(start, dealer) < 0.25;
    const needDealer = rides.some((r) => r.type === 'dropoff' && r.status !== 'onboard') && !atDealer;
    // Seats: who's in the van now, who gets in at the dealership, and the van's seat count.
    const waiting = rides.filter((r) => r.type === 'dropoff' && r.status !== 'onboard').reduce((n, r) => n + r.passengers, 0);
    const startLoad = rides.filter((r) => r.status === 'onboard').reduce((n, r) => n + r.passengers, 0) + (needDealer ? 0 : waiting);
    const van = req.user.vehicle_id ? q('SELECT name, seats FROM vehicles WHERE id = ?').get(req.user.vehicle_id) : null;
    const capacity = van && van.seats > 0 ? van.seats : null;
    const via = needDealer ? { ...dealer, label: 'Dealership: pick up drop-off customers', people: waiting } : null;
    const plan = await planRoute({ start, via, stops, end: { ...dealer, label: 'Back to the dealership', people: 0 }, router: opts.router, keepOrder, capacity, startLoad,
      log: (m) => console.log(new Date().toLocaleString(), '[routes]', m) });
    if (capacity && plan.peak > capacity) {
      const e = new Error(keepOrder
        ? `In this order, ${plan.peak} people would be in ${van.name} at once, but it has ${capacity} seats. Plan the route again.`
        : `Too many people for ${van.name}: it has ${capacity} seats, but this trip needs room for ${plan.peak} at once in any order. Uncheck a ride or two and plan again.`);
      e.status = 400; throw e;
    }

    let t = Date.now(); let miles = 0; let mins = 0;
    const out = plan.legs.map((leg, i) => {
      if (i > 0) t += STOP_MINUTES * 60000;
      t += leg.seconds * 1000; miles += leg.meters / 1000 * KM_TO_MI; mins += leg.seconds / 60;
      const p = leg.point;
      return {
        kind: p.kind || 'dealer', ride_id: p.ride_id || null, label: p.label, address: p.address || getSettings().dealer_address,
        lat: p.lat, lng: p.lng, leg_mi: Math.round(leg.meters / 1000 * KM_TO_MI * 10) / 10, leg_min: Math.max(1, Math.round(leg.seconds / 60)),
        on_board: plan.loads[i], // people in the van after this stop
        eta: new Date(t).toISOString(),
      };
    });
    // Keep the saved path small: round and thin it out.
    let path = plan.path.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
    if (path.length > 1500) { const step = Math.ceil(path.length / 1500); path = path.filter((_, i) => i % step === 0 || i === path.length - 1); }
    return {
      route: { planned_at: now(), source: plan.source, start: { lat: start.lat, lng: start.lng }, seats: capacity, start_load: startLoad, peak: plan.peak, total_mi: Math.round(miles * 10) / 10,
        total_min: Math.round(mins + STOP_MINUTES * Math.max(0, out.length - 1)), finish_at: out.length ? out[out.length - 1].eta : now(), stops: out, path },
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

  app.get('/api/drivers', requireRole(), (req, res) => {
    const rows = q(`SELECT u.*, v.name AS vehicle_name,
                      (SELECT COUNT(*) FROM rides r WHERE r.driver_id = u.id AND r.status IN ('assigned','en_route','onboard')) AS open_rides
                    FROM users u LEFT JOIN vehicles v ON v.id = u.vehicle_id
                    WHERE u.role = 'driver' AND u.active = 1 ORDER BY u.on_duty DESC, u.name`).all();
    res.json({ drivers: rows.map((u) => ({ ...publicUser(u), vehicle_name: u.vehicle_name, open_rides: u.open_rides })) });
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
    r.passengers = Math.min(Math.max(r.passengers || 1, 1), 15);
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
    return { r };
  }

  const RIDE_FIELDS = ['type', 'customer_name', 'customer_phone', 'customer_email', 'address', 'lat', 'lng',
    'scheduled_at', 'priority', 'passengers', 'ro_number', 'customer_vehicle', 'notes'];

  function insertRide(r, extra) {
    const cols = [...RIDE_FIELDS, 'status', 'source', 'advisor_id', 'track_token', 'return_of'];
    const vals = [...RIDE_FIELDS.map((f) => r[f] ?? null), extra.status || 'requested', extra.source, extra.advisor_id ?? null, randomToken(12), extra.return_of ?? null];
    const res = q(`INSERT INTO rides (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    return q(`${RIDE_SELECT} WHERE r.id = ?`).get(res.lastInsertRowid);
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
    const rides = q(sql).all(...args).map((r) => withLinks(req, r));
    // Rank from the driver's live position if we have it, else from the dealership.
    let origin = dealerOrigin();
    if (req.user.role === 'driver' && req.user.last_lat != null) origin = { lat: req.user.last_lat, lng: req.user.last_lng };
    const ranked = rankRides(rides, origin);
    const rankById = new Map(ranked.map((r) => [r.id, r]));
    res.json({
      rides: rides.map((r) => rankById.get(r.id) || r),
      queue: ranked.map((r) => r.id),
    });
  });

  app.get('/api/rides/:id', requireRole(), (req, res) => {
    const ride = q(`${RIDE_SELECT} WHERE r.id = ?`).get(Number(req.params.id));
    if (!ride) return bad(res, 'Ride not found.', 404);
    res.json({ ride: withLinks(req, ride) });
  });

  app.post('/api/rides', requireRole('advisor'), (req, res) => {
    const { r, error } = cleanRide(req.body, {}, { byAdmin: req.user.role === 'admin' });
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
    res.status(201).json({ ride: withLinks(req, ride) });
  });

  app.patch('/api/rides/:id', requireRole(), (req, res) => {
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
        const id = num(b.driver_id);
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
    if (b.vehicle_id !== undefined && role !== 'driver') updates.vehicle_id = num(b.vehicle_id);
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
    res.json({ ride: withLinks(req, q(`${RIDE_SELECT} WHERE r.id = ?`).get(ride.id)) });
  });

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
      service_radius_mi: serviceRadius(),
    });
  });

  const publicHits = new Map();
  app.post('/api/public/rides', (req, res) => {
    if (getSettings().public_requests !== '1') return bad(res, 'Online ride requests are turned off. Please call the dealership.', 403);
    const key = clientIp(req); const t = Date.now();
    const hits = (publicHits.get(key) || []).filter((x) => t - x < 3600000);
    if (hits.length >= 10) return bad(res, 'Too many requests. Please call the dealership.', 429);
    hits.push(t); publicHits.set(key, hits);
    if (!str(req.body.customer_phone)) return bad(res, 'A phone number is required so the driver can reach you.');
    const body = { ...req.body, priority: 'normal' };
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

  app.get('/api/public/track/:token', (req, res) => {
    const ride = q(`${RIDE_SELECT} WHERE r.track_token = ?`).get(String(req.params.token));
    if (!ride) return bad(res, 'Ride not found.', 404);
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
    let position = null;
    if (ride.status === 'requested' || ride.status === 'assigned') {
      const rk = rankRides(q(`${RIDE_SELECT} WHERE r.status IN ('requested','assigned','en_route','onboard')`).all(), dealerOrigin());
      const me = rk.find((x) => x.id === ride.id);
      position = me ? me.rank : null;
    }
    const s = getSettings();
    res.json({
      ride: {
        type: ride.type, status: ride.status, customer_first_name: ride.customer_name.split(' ')[0],
        address: ride.address, lat: ride.lat, lng: ride.lng, scheduled_at: ride.scheduled_at,
        driver_name: ride.driver_name ? ride.driver_name.split(' ')[0] : null,
        vehicle: ride.vehicle_name ? { name: ride.vehicle_name, color: ride.vehicle_color, make_model: ride.vehicle_make_model, plate: ride.vehicle_plate } : null,
        updated_at: ride.updated_at,
      },
      driver_location: driverLoc,
      eta,
      queue_position: position,
      dealer: { name: s.dealer_name, address: s.dealer_address, phone: s.dealer_phone, lat: Number(s.dealer_lat), lng: Number(s.dealer_lng) },
    });
  });

  // ---------- settings ----------
  app.patch('/api/settings', requireRole('admin'), (req, res) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body[k] === undefined) continue;
      let v = String(req.body[k]).slice(0, 300);
      if ((k === 'dealer_lat' || k === 'dealer_lng') && Number.isNaN(Number(v))) return bad(res, 'Latitude/longitude must be numbers.');
      if (YES_NO_SETTINGS.includes(k)) v = req.body[k] && req.body[k] !== '0' ? '1' : '0';
      if (k === 'timezone') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { return bad(res, 'Unknown time zone.'); } }
      if (k === 'auto_end_shift' || k === 'auto_sign_out' || k === 'clear_customer_info') {
        v = v.trim();
        if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return bad(res, 'Pick a time, like 8:00 PM, or leave it empty to turn it off.');
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
    const ids = q(`SELECT id FROM rides WHERE status IN ('completed','cancelled') AND cleared_at IS NULL`).all().map((r) => r.id);
    const wipe = q(`UPDATE rides SET customer_name = ?, customer_phone = NULL, customer_email = NULL,
                      address = '(cleared)', lat = NULL, lng = NULL, notes = NULL, ro_number = NULL,
                      customer_vehicle = NULL, track_token = ?, cleared_at = ? WHERE id = ?`);
    const at = now();
    for (const id of ids) wipe.run(CLEARED_NAME, randomToken(18), at, id);
    const texts = q('DELETE FROM sms_log').run().changes;
    geoCache.clear(); // searched addresses
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
  app.locals.resetClearSchedule = customerWipe.reset;
  if (!opts.noTimers) {
    setInterval(() => {
      try { autoEndShifts(); } catch (e) { console.error('Auto end of shift failed:', e.message); }
      try { autoSignOut(); } catch (e) { console.error('Auto sign-out failed:', e.message); }
      try { customerWipe.tick(); } catch (e) { console.error('Clearing customer info failed:', e.message); }
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
    const reasons = new Map();
    for (const r of rides.filter((x) => x.status === 'cancelled')) {
      const k = (r.cancel_reason || 'No reason given').split(':')[0].trim();
      reasons.set(k, (reasons.get(k) || 0) + 1);
    }
    res.json({
      from, to, timezone: tz(), type, type_counts: typeCounts,
      totals: summarize(rides),
      days,
      drivers: group((r) => r.driver_name),
      advisors: group((r) => r.advisor_name || (r.source === 'customer' ? 'Customer (online request)' : null)),
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
  app.get('/api/version', requireRole('admin'), (req, res) => {
    const u = opts.updater?.state || {};
    res.json({ version: u.version || null, version_date: u.versionDate || null, auto_update: !!u.enabled,
      reason: u.reason || null, last_check: u.lastCheck || null, last_error: u.lastError || null });
  });
  app.post('/api/updates/check', requireRole('admin'), async (req, res) => {
    if (!opts.updater) return bad(res, 'Updates are not available here.');
    const result = await opts.updater.check();
    const msg = { 'up-to-date': 'You already have the latest version.', updated: 'Update installed. The site is restarting — reload in a few seconds.',
      busy: 'Already checking — try again in a moment.', skipped: opts.updater.state.reason || 'Automatic updates are off.',
      error: opts.updater.state.lastError || 'The update check failed.' }[result];
    res.status(result === 'error' ? 502 : 200).json({ result, message: msg });
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
    const png = await QRCode.toBuffer(text, { width: Math.min(num(req.query.size) || 320, 1024), margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'private, max-age=3600').send(png);
  });

  // Track pages show their own QR so a customer can hand the link to someone else.
  app.get('/api/public/track/:token/qr', async (req, res) => {
    const ride = q('SELECT track_token FROM rides WHERE track_token = ?').get(String(req.params.token));
    if (!ride) return bad(res, 'Ride not found.', 404);
    const png = await QRCode.toBuffer(`${baseUrl(req)}/t/${ride.track_token}`, { width: 320, margin: 2 });
    res.type('png').send(png);
  });

  app.get('/api/public/request-qr', async (req, res) => {
    const png = await QRCode.toBuffer(`${baseUrl(req)}/request`, { width: Math.min(num(req.query.size) || 320, 1024), margin: 2 });
    res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
  });

  // ---------- geocoding (address search) ----------
  // Address search uses OpenStreetMap's free Nominatim service, which allows about one
  // lookup a second and blocks sites that go over. Lookups are cached, shared when two
  // people type the same thing, paced to one at a time, and time out after 8 seconds.
  const geoCache = new Map(); const geoInFlight = new Map(); let geoNextSlot = 0;
  const geoHits = new Map(); // customer page: lookups per address per hour
  app.get('/api/geocode', requireRole(), async (req, res) => geocode(req, res));
  app.get('/api/public/geocode', async (req, res) => {
    if (getSettings().public_requests !== '1') return bad(res, 'Disabled.', 403);
    const ip = clientIp(req); const t = Date.now();
    const hits = (geoHits.get(ip) || []).filter((x) => t - x < 3600000);
    if (hits.length >= 60) return res.json({ results: [], error: 'Too many searches. Tap the map to drop a pin instead.' });
    hits.push(t); geoHits.set(ip, hits);
    return geocode(req, res);
  });
  async function lookupAddress(text) {
    const wait = Math.max(0, geoNextSlot - Date.now());
    if (wait > 5000) throw new Error('busy'); // too many people searching at once
    geoNextSlot = Math.max(Date.now(), geoNextSlot) + 1100;
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
  // Pages are never cached, and every script/stylesheet link in them carries a
  // version stamp that changes on each start. After an update (which restarts the
  // app) browsers and Cloudflare fetch the new files instead of showing old ones.
  const assetVersion = opts.assetVersion || Date.now().toString(36);
  const pageCache = new Map();
  const page = (file) => (req, res, next) => {
    let html = pageCache.get(file);
    if (!html) {
      try { html = require('node:fs').readFileSync(path.join(pub, file), 'utf8'); } catch (e) { return next(e); }
      html = html.replace(/((?:src|href)="\/(?:js|css|vendor\/leaflet)\/[^"?]+\.(?:js|css))"/g, `$1?v=${assetVersion}"`);
      pageCache.set(file, html);
    }
    res.set('Cache-Control', 'no-store').type('html').send(html);
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
  // The notification worker and app manifest must always be fresh, so they're never cached.
  for (const [route, file, type] of [['/sw.js', 'sw.js', 'application/javascript'], ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json']]) {
    app.get(route, (req, res) => res.set('Cache-Control', 'no-cache').type(type).sendFile(path.join(pub, file)));
  }
  // Scripts and styles: their links are version-stamped, so they can be cached.
  app.use(express.static(pub, {
    index: false, maxAge: '30d',
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
  }));
  app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'), { maxAge: '30d' }));

  app.use('/api', (req, res) => bad(res, 'Not found.', 404));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  // Forget old sign-in failures and request counts so these lists can't grow forever.
  if (!opts.noTimers) {
    setInterval(() => {
      const t = Date.now();
      for (const [k, f] of failures) if (t - f.first > 15 * 60000) failures.delete(k);
      for (const m of [publicHits, geoHits]) for (const [k, v] of m) if (!v.some((x) => t - x < 3600000)) m.delete(k);
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
