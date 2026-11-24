// Many businesses on one PC, each in its own separate space.
//
// The PC's own shuttle (the "home" business, data/shuttle.db) runs exactly as before at its own
// address. Every other business gets its own database file (data/businesses/<name>/shuttle.db)
// and its own address, <name>.turaslubtha.com. Nothing is shared between them: staff, rides,
// customers, settings and backups all live in that business's own file.
//
// The directory (data/directory.db) only lists the businesses and holds the one-time sign-in
// hand-offs from the shared sign-in page. No staff or customer details are kept in it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// Names that are other parts of the system (or easy to mistake for them).
const RESERVED = new Set(['app', 'www', 'website', 'mail', 'email', 'smtp', 'api', 'admin', 'home', 'login', 'signin', 'sign-in',
  'help', 'support', 'status', 'docs', 'blog', 'static', 'cdn', 'assets', 'ftp', 'ns1', 'ns2', 'turaslubtha', 'turas', 'demo', 'test',
  // pages and folders of the website itself (turaslubtha.com/<name> is a business)
  'index', 'privacy', 'terms', '404', 'css', 'js', 'img', 'icons', 'brand', 'vendor', 'auth', 'setup', 'reset', 'logout', 'healthz', 'pricing', 'features', 'about', 'contact']);
const HANDOFF_SECONDS = 60;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// A business's name → a suggested web address name ("Pine Valley Auto" → "pinevalleyauto").
function suggestName(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 32);
}

function checkName(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { error: 'Choose a web address name.' };
  if (!NAME_RE.test(s)) return { error: 'Use only letters, numbers and dashes (2–32), starting and ending with a letter or number.' };
  if (s.length < 2) return { error: 'Use at least 2 letters or numbers.' };
  if (RESERVED.has(s)) return { error: `“${s}” is kept for Turas Lúbtha itself. Choose another.` };
  return { slug: s };
}

// openDb: opens (and brings up to date) a business database.
// makeApp(slug, db, file): builds that business's copy of the shuttle app.
function createBusinesses({ dataDir, openDb, makeApp, log = () => {} }) {
  const dirFile = path.join(dataDir, 'directory.db');
  fs.mkdirSync(dataDir, { recursive: true });
  const dir = new DatabaseSync(dirFile);
  dir.exec(`
    PRAGMA busy_timeout = 8000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS businesses (
      slug       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      paused     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (      -- small facts about this PC, like the shuttle's own address
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS demo_requests ( -- "Book a demo" on the website; kept until deleted on Server → Demo requests
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      name       TEXT NOT NULL,
      business   TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      kind       TEXT,
      vans       TEXT,
      best_time  TEXT,
      message    TEXT,
      status     TEXT NOT NULL DEFAULT 'new' -- new | contacted
    );
    CREATE TABLE IF NOT EXISTS handoffs (  -- one-time sign-ins from the shared sign-in page; last 60 seconds
      token_hash TEXT PRIMARY KEY,
      slug       TEXT NOT NULL,            -- '' is the home business
      user_id    INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  const loaded = new Map(); // slug -> { db, app, file }
  const now = () => new Date().toISOString();
  const fileOf = (slug) => path.join(dataDir, 'businesses', slug, 'shuttle.db');

  const row = (slug) => dir.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug) || null;
  function list() {
    return dir.prepare('SELECT * FROM businesses ORDER BY created_at').all().map((b) => ({ ...b, paused: !!b.paused }));
  }
  function load(slug) {
    if (loaded.has(slug)) return loaded.get(slug);
    if (!row(slug)) return null;
    const file = fileOf(slug);
    const db = openDb(file);
    const entry = { slug, db, file, app: null };
    loaded.set(slug, entry); // before makeApp, so anything it calls back finds it
    try { entry.app = makeApp(slug, db, file); } catch (e) { loaded.delete(slug); try { db.close(); } catch { /* closed */ } throw e; }
    return entry;
  }

  function create({ slug, name, by }) {
    const checked = checkName(slug);
    if (checked.error) return checked;
    const nm = String(name || '').trim().slice(0, 120);
    if (!nm) return { error: 'Enter the business name.' };
    if (row(checked.slug) || getMeta('home_slug') === checked.slug) return { error: `${checked.slug} is already taken. Choose another.` };
    const file = fileOf(checked.slug);
    if (fs.existsSync(file)) return { error: `There is already a database for ${checked.slug} on this PC. Choose another name.` };
    dir.prepare('INSERT INTO businesses (slug, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(checked.slug, nm, now(), by || null);
    let entry;
    try { entry = load(checked.slug); } catch (e) {
      dir.prepare('DELETE FROM businesses WHERE slug = ?').run(checked.slug);
      return { error: `Couldn't create it: ${e.message}` };
    }
    // The business's name goes in as a starting point; its owner can change it during setup.
    entry.db.prepare("INSERT INTO settings (key, value) VALUES ('dealer_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(nm);
    const code = (entry.db.prepare("SELECT value FROM settings WHERE key = 'setup_code'").get() || {}).value || '';
    log(`Created business ${checked.slug} (${nm})${by ? ` for ${by}` : ''}.`);
    return { business: { ...row(checked.slug), paused: false }, setup_code: code };
  }

  function setPaused(slug, paused) {
    const r = dir.prepare('UPDATE businesses SET paused = ? WHERE slug = ?').run(paused ? 1 : 0, slug);
    return r.changes > 0;
  }

  // Details for Admin → Server → Businesses, read from each business's own settings.
  function details(slug) {
    const b = row(slug); if (!b) return null;
    let setupDone = false, staff = 0, displayName = b.name, setupCode = '';
    try {
      const { db } = load(slug);
      const s = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key IN ('setup_done','dealer_name','setup_code')").all().map((x) => [x.key, x.value]));
      setupDone = s.setup_done === '1'; displayName = s.dealer_name || b.name; setupCode = setupDone ? '' : (s.setup_code || '');
      staff = db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n;
    } catch (e) { log(`Reading ${slug} failed: ${e.message}`); }
    return { slug: b.slug, name: displayName, created_at: b.created_at, paused: !!b.paused, setup_done: setupDone, setup_code: setupCode, staff };
  }

  // ---------- one-time hand-offs from the shared sign-in page ----------
  function makeHandoff(slug, userId) {
    const token = crypto.randomBytes(24).toString('base64url');
    dir.prepare('DELETE FROM handoffs WHERE expires_at < ?').run(now());
    dir.prepare('INSERT INTO handoffs (token_hash, slug, user_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(hash(token), slug, userId, new Date(Date.now() + HANDOFF_SECONDS * 1000).toISOString());
    return token;
  }
  // Used once, only at the business it was made for, within 60 seconds.
  function redeemHandoff(slug, token) {
    if (!token || String(token).length > 100) return null;
    const h = hash(token);
    const r = dir.prepare('SELECT * FROM handoffs WHERE token_hash = ?').get(h);
    if (!r) return null;
    dir.prepare('DELETE FROM handoffs WHERE token_hash = ?').run(h);
    if (r.slug !== slug || r.expires_at < now()) return null;
    return r.user_id;
  }

  const getMeta = (k) => (dir.prepare('SELECT value FROM meta WHERE key = ?').get(k) || {}).value || '';
  const setMeta = (k, v) => dir.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  // ---------- "Book a demo" requests ----------
  const demoListeners = [];
  function addDemo(d) {
    const id = Number(dir.prepare(`INSERT INTO demo_requests (created_at, name, business, email, phone, kind, vans, best_time, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), d.name, d.business, d.email, d.phone || null, d.kind || null, d.vans || null, d.best_time || null, d.message || null).lastInsertRowid);
    const row = dir.prepare('SELECT * FROM demo_requests WHERE id = ?').get(id);
    for (const fn of demoListeners) { try { fn(row); } catch (e) { log(`Demo request notice failed: ${e.message}`); } }
    return row;
  }
  const demos = {
    add: addDemo,
    list: () => dir.prepare('SELECT * FROM demo_requests ORDER BY id DESC LIMIT 500').all(),
    countNew: () => dir.prepare("SELECT COUNT(*) AS n FROM demo_requests WHERE status = 'new'").get().n,
    countSince: (iso) => dir.prepare('SELECT COUNT(*) AS n FROM demo_requests WHERE created_at > ?').get(iso).n,
    setStatus: (id, status) => dir.prepare('UPDATE demo_requests SET status = ? WHERE id = ?').run(status, id).changes > 0,
    remove: (id) => dir.prepare('DELETE FROM demo_requests WHERE id = ?').run(id).changes > 0,
    onNew: (fn) => { demoListeners.push(fn); },
  };

  return {
    dirFile, list, getMeta, setMeta, demos, row, load, create, setPaused, details, makeHandoff, redeemHandoff,
    loaded: () => [...loaded.values()],
    // The copy of the site that runs background jobs keeps every business loaded, so each
    // one's timers (ride offers, nightly clearing, backups, daily reports) keep running.
    loadAll() { for (const b of list()) { try { load(b.slug); } catch (e) { log(`Starting ${b.slug} failed: ${e.message}`); } } },
    close() { for (const e of loaded.values()) { try { e.db.close(); } catch { /* closed */ } } loaded.clear(); try { dir.close(); } catch { /* closed */ } },
  };
}

// The cluster message bus, but private to one business: its instant updates and background
// job messages never reach another business's copy of the app.
function scopedBus(bus, slug) {
  const k = (kind) => `biz:${slug}:${kind}`;
  return {
    get clustered() { return bus.clustered; },
    get jobs() { return bus.jobs; },
    get worker() { return bus.worker; },
    publish: (kind, data) => bus.publish(k(kind), data),
    on: (kind, fn) => bus.on(k(kind), fn),
    answer: (kind, fn) => bus.answer(k(kind), fn),
    ask: (to, kind, data, ms) => bus.ask(to, to === 'primary' ? kind : k(kind), data, ms),
    gather: (kind, data, ms) => bus.gather(k(kind), data, ms),
  };
}

module.exports = { createBusinesses, scopedBus, checkName, suggestName, NAME_RE, RESERVED, HANDOFF_SECONDS };
