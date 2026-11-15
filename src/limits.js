// Counters kept in the database so every copy of the site (one per processor core) sees
// the same numbers: wrong-password limits, request limits, and spacing for address lookups.
function createLimits(db) {
  db.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL)');
  const get = db.prepare('SELECT count, first FROM limits WHERE key = ?');
  // A new window starts when the old one has run out.
  const bump = db.prepare(`INSERT INTO limits (key, count, first) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN first < ? THEN 1 ELSE count + 1 END,
                                   first = CASE WHEN first < ? THEN excluded.first ELSE first END
    RETURNING count`);
  const del = db.prepare('DELETE FROM limits WHERE key = ?');
  // For spacing: "first" holds the next free time.
  const reserve = db.prepare(`INSERT INTO limits (key, count, first) VALUES (?, 0, ? + ?)
    ON CONFLICT(key) DO UPDATE SET first = MAX(first, ?) + ? RETURNING first`);
  const old = db.prepare('DELETE FROM limits WHERE first < ?');

  return {
    // How many times in the current window (0 when it has run out).
    count(key, windowMs) {
      const r = get.get(key);
      return r && r.first >= Date.now() - windowMs ? r.count : 0;
    },
    // Count one more; returns the new count.
    hit(key, windowMs) {
      const t = Date.now();
      return bump.get(key, t, t - windowMs, t - windowMs).count;
    },
    clear(key) { del.run(key); },
    // Take the next turn, spacingMs apart from the last one. Returns how long to wait,
    // or null (without taking a turn) when the wait would be longer than maxWaitMs.
    turn(key, spacingMs, maxWaitMs) {
      const t = Date.now();
      const r = get.get(key);
      if (r && r.first - t > maxWaitMs) return null;
      const next = reserve.get(key, t, spacingMs, t, spacingMs).first;
      return Math.max(0, next - spacingMs - t);
    },
    // Forget windows older than two hours.
    prune() { old.run(Date.now() - 2 * 3600000); },
  };
}

module.exports = { createLimits };
