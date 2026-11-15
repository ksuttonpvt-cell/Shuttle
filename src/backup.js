// Database backups: data/backups/shuttle-<kind>-2026-11-15-003000.db
//   daily          made automatically each night (after customer info is cleared), kept 14 days
//   manual         "Back up now"; removed at the next nightly customer-info clear
//   before-restore the database as it was just before a restore; removed the same way
// A backup is a complete, consistent copy made with SQLite's VACUUM INTO, so it can be
// taken while the site is running. Restoring happens on the next start (nothing is
// using the database then): the site restarts, swaps the file in, and carries on.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const KINDS = ['daily', 'manual', 'before-restore'];
const NAME_RE = /^shuttle-(daily|manual|before-restore)-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const MARKER = 'restore-pending.json';

// Only real shuttle databases can be restored.
function looksLikeShuttleDb(file) {
  try {
    const head = Buffer.alloc(16); const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\u0000') return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
      return ['users', 'rides', 'settings'].every((t) => names.includes(t));
    } finally { db.close(); }
  } catch { return false; }
}

function createBackups({ db, dir, keepDays = 14, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const full = (name) => {
    if (!NAME_RE.test(String(name))) return null;
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : null;
  };
  function list() {
    return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).map((f) => {
      const m = NAME_RE.exec(f); const st = fs.statSync(path.join(dir, f));
      return { name: f, kind: m[1], made_at: st.mtime.toISOString(), size: st.size };
    }).sort((a, b) => b.name.slice(-20).localeCompare(a.name.slice(-20)));
  }
  function make(kind = 'manual', at = new Date()) {
    if (!KINDS.includes(kind)) throw new Error('Unknown backup kind.');
    let name = `shuttle-${kind}-${stamp(at)}.db`;
    let n = 0; while (fs.existsSync(path.join(dir, name)) && n < 60) name = `shuttle-${kind}-${stamp(new Date(at.getTime() + ++n * 1000))}.db`;
    const file = path.join(dir, name);
    db.prepare('VACUUM INTO ?').run(file);
    log(`Backup made: ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    return list().find((b) => b.name === name);
  }
  function remove(name) {
    const p = full(name); if (!p) return false;
    fs.rmSync(p, { force: true }); return true;
  }
  // Old daily backups go after keepDays; manual and before-restore copies go when
  // customer info is cleared, so customer details never outlive the nightly clear for long.
  function prune({ temporary = false, now = Date.now() } = {}) {
    let removed = 0;
    for (const b of list()) {
      const old = b.kind === 'daily' && now - new Date(b.made_at).getTime() > keepDays * 86400000;
      if (old || (temporary && b.kind !== 'daily')) { remove(b.name); removed++; }
    }
    return removed;
  }
  function scheduleRestore(name) {
    const p = full(name);
    if (!p) throw new Error('That backup was not found.');
    if (!looksLikeShuttleDb(p)) throw new Error("That file isn't a shuttle database backup.");
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ name, asked_at: new Date().toISOString() }));
    return true;
  }
  const pendingRestore = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; } };
  function cancelRestore() { fs.rmSync(path.join(dir, MARKER), { force: true }); }
  const totalSize = () => list().reduce((n, b) => n + b.size, 0);
  return { dir, list, make, remove, prune, scheduleRestore, pendingRestore, cancelRestore, path: full, totalSize };
}

// Runs at start-up, before the database is opened. If a restore was asked for, save the
// current database as a before-restore backup, then put the chosen backup in its place.
function applyPendingRestore({ dbFile, dir, log = console.log }) {
  const marker = path.join(dir, MARKER);
  if (!fs.existsSync(marker)) return null;
  let name = null;
  try {
    ({ name } = JSON.parse(fs.readFileSync(marker, 'utf8')));
    const src = NAME_RE.test(String(name)) ? path.join(dir, name) : null;
    if (!src || !fs.existsSync(src) || !looksLikeShuttleDb(src)) throw new Error(`backup ${name} is missing or not a shuttle database`);
    if (fs.existsSync(dbFile)) {
      const current = new DatabaseSync(dbFile);
      try { current.prepare('VACUUM INTO ?').run(path.join(dir, `shuttle-before-restore-${stamp(new Date())}.db`)); } finally { current.close(); }
    }
    for (const extra of ['-wal', '-shm']) fs.rmSync(dbFile + extra, { force: true });
    fs.copyFileSync(src, dbFile);
    log(`Restored the database from backup ${name}. The previous database was saved as a before-restore backup.`);
    return name;
  } catch (e) {
    log(`Restore failed, so nothing was changed: ${e.message}`);
    return null;
  } finally {
    fs.rmSync(marker, { force: true }); // never retry in a loop
  }
}

module.exports = { createBackups, applyPendingRestore, looksLikeShuttleDb, NAME_RE };
