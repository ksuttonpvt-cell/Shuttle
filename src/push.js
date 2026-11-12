// Phone lock-screen notifications for drivers (Web Push).
// The server makes its own key pair the first time it starts and keeps it in the
// database, so there is nothing to sign up for or configure.
const webpush = require('web-push');

function createPush(db, { sender, subject } = {}) {
  const q = (sql) => db.prepare(sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      device     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT
    );
  `);
  const getSetting = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  let publicKey = getSetting('vapid_public');
  let privateKey = getSetting('vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    const put = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    put.run('vapid_public', publicKey); put.run('vapid_private', privateKey);
  }

  // Push services want a contact: the site's https address, or failing that an admin's email.
  function contact() {
    if (subject) return subject;
    const url = process.env.PUBLIC_URL;
    if (url && url.startsWith('https://')) return url;
    const admin = q("SELECT email FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
    return `mailto:${admin?.email || 'shuttle@example.com'}`;
  }
  const send = sender || ((sub, payload) => webpush.sendNotification(sub, payload, {
    vapidDetails: { subject: contact(), publicKey, privateKey }, TTL: 600, urgency: 'high',
  }));

  function subscribe(userId, sub, device) {
    const endpoint = String(sub?.endpoint || '');
    const p256dh = sub?.keys?.p256dh; const auth = sub?.keys?.auth;
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new Error('That notification sign-up was not valid.');
    q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`)
      .run(userId, endpoint, p256dh, auth, String(device || '').slice(0, 200));
  }
  function unsubscribe(endpoint) { q('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || '')); }
  const countFor = (userId) => q('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;

  // Sends to every phone the given users turned notifications on for.
  // Phones that have switched notifications off (404/410 from the push service) are forgotten.
  async function notifyUsers(userIds, message) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return { sent: 0, failed: 0 };
    const subs = q(`SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const payload = JSON.stringify({ title: 'Shuttle', url: '/driver', ...message });
    let sent = 0; let failed = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        q("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").run(s.id);
        sent++;
      } catch (e) {
        failed++;
        if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint);
        else console.error('Push failed:', e.statusCode || '', e.body || e.message);
      }
    }));
    return { sent, failed };
  }
  function notifyOnDutyDrivers(message, exceptUserId) {
    const ids = q("SELECT id FROM users WHERE role = 'driver' AND active = 1 AND on_duty = 1").all().map((u) => u.id).filter((id) => id !== exceptUserId);
    return notifyUsers(ids, message);
  }

  return { publicKey, subscribe, unsubscribe, countFor, notifyUsers, notifyOnDutyDrivers };
}

module.exports = { createPush };
