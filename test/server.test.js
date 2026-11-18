process.removeAllListeners('warning');
const { seedTestSite } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { createLogbook } = require('../src/logbook');
const { createBackups, applyPendingRestore } = require('../src/backup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-server-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('log book: levels, filters, daily files, and passwords never kept', () => {
  const dir = path.join(tmp, 'logs');
  const log = createLogbook({ dir });
  log.add('11/15/2026, 7:56:23 AM Shuttle app running at http://localhost:3000');
  log.add('Update check failed: offline');
  log.add('Road routing unavailable, using an estimate');
  log.add('    password: hunter2secret   (change it after signing in)');
  const all = log.recent();
  assert.equal(all[0].text, 'Shuttle app running at http://localhost:3000', 'own time added, old one removed');
  assert.deepEqual(all.map((l) => l.level), ['info', 'error', 'warn', 'info']);
  assert.equal(log.recent({ level: 'error' }).length, 1);
  assert.equal(log.recent({ level: 'warn' }).length, 2);
  assert.equal(log.recent({ q: 'ROUTING' }).length, 1);
  assert.equal(log.recent({ after: all[1].seq }).length, 2);
  const files = log.files();
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, files[0].name), 'utf8');
  assert.match(text, /ERROR  Update check failed/);
  assert.ok(!text.includes('hunter2secret') && !JSON.stringify(all).includes('hunter2secret'), 'password hidden');
  assert.equal(log.filePath('../../etc/passwd'), null);
  // Files older than 14 days are removed.
  fs.writeFileSync(path.join(dir, 'shuttle-2000-01-01.log'), 'old');
  createLogbook({ dir }).add('new day');
  assert.ok(!fs.existsSync(path.join(dir, 'shuttle-2000-01-01.log')));
});

test('backups: make, list, prune, and restore on the next start', () => {
  const dbFile = path.join(tmp, 'b', 'shuttle.db');
  const dir = path.join(tmp, 'b', 'backups');
  let db = seedTestSite(openDb(dbFile));
  db.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'before')").run();
  const backups = createBackups({ db, dir });
  const daily = backups.make('daily', new Date(Date.now() - 20 * 86400000));
  const manual = backups.make('manual');
  assert.equal(backups.list().length, 2);
  assert.ok(manual.size > 1000);
  assert.equal(backups.path('../shuttle.db'), null, 'only backup names');
  // Old daily backups go; manual ones go at the nightly clear.
  fs.utimesSync(path.join(dir, daily.name), new Date(Date.now() - 20 * 86400000), new Date(Date.now() - 20 * 86400000));
  assert.equal(backups.prune(), 1);
  backups.make('daily');
  assert.equal(backups.prune({ temporary: true }), 1);
  assert.deepEqual(backups.list().map((b) => b.kind), ['daily']);
  // Restore: change data, ask for a restore, "restart".
  const keep = backups.list()[0].name;
  db.prepare("UPDATE settings SET value = 'after' WHERE key = 'marker'").run();
  assert.throws(() => backups.scheduleRestore('nope.db'), /not found/);
  fs.writeFileSync(path.join(dir, 'shuttle-manual-2026-01-01-000000.db'), 'not a database');
  assert.throws(() => backups.scheduleRestore('shuttle-manual-2026-01-01-000000.db'), /isn't a shuttle database/);
  backups.scheduleRestore(keep);
  assert.equal(backups.pendingRestore().name, keep);
  db.close();
  const logs = [];
  assert.equal(applyPendingRestore({ dbFile, dir, log: (m) => logs.push(m) }), keep);
  assert.equal(backups.pendingRestore(), null, 'marker removed');
  db = seedTestSite(openDb(dbFile));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'before');
  assert.ok(backups.list().some((b) => b.kind === 'before-restore'), 'old database kept');
  assert.equal(applyPendingRestore({ dbFile, dir }), null, 'nothing to do next time');
  db.close();
});

let server; let base; let restarted = 0; let theApp;
before(async () => {
  const dbFile = path.join(tmp, 'app', 'shuttle.db');
  const db = seedTestSite(openDb(dbFile));
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const backups = createBackups({ db, dir: path.join(tmp, 'app', 'backups') });
  const logbook = createLogbook();
  theApp = createApp(db, { noTimers: true, backups, logbook, dbFile, logsDir: path.join(tmp, 'logs'), restart: () => { restarted++; } });
  await new Promise((r) => { server = theApp.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  logbook.add('Nightly backup failed: disk full');
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
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

test('Admin → Server: status, logs, backups and restart are admin-only and work', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  await admin('/api/users', { body: { name: 'Avery Advisor', email: 'av@t.l', role: 'advisor', password: 'advisorpw1' } });
  const advisor = client();
  await advisor('/api/login', { body: { email: 'av@t.l', password: 'advisorpw1' } });
  for (const p of ['/api/server/status', '/api/server/logs', '/api/server/backups', '/api/server/checks']) {
    assert.equal((await advisor(p)).status, 403, p);
    assert.equal((await client()(p)).status, 401, p);
  }
  assert.equal((await advisor('/api/server/restart', { body: {} })).status, 403);

  const s = (await admin('/api/server/status')).data;
  assert.ok(s.uptime_s >= 0 && s.memory.site_mb > 0 && s.cpu.cores > 0);
  assert.equal(s.online.admin, 1); assert.equal(s.online.advisor, 1);
  assert.ok(s.requests.last_hour > 0, 'requests counted');
  assert.ok(s.database.size_mb >= 0);
  assert.equal(s.log_counts.error, 1);
  assert.equal(s.backups.time, '00:00');

  const checks = (await admin('/api/server/checks')).data;
  assert.equal(checks.database.ok, true);
  assert.equal(checks.routing.ok, null, 'routing not set up in tests');

  const logs = (await admin('/api/server/logs?level=error')).data;
  assert.equal(logs.lines.length, 1);
  assert.match(logs.lines[0].text, /disk full/);

  // Backups through the API.
  const made = (await admin('/api/server/backups', { body: {} }));
  assert.equal(made.status, 201);
  const name = made.data.backup.name;
  assert.equal((await admin('/api/server/backups')).data.backups.length, 1);
  const dl = await admin(`/api/server/backups/${name}`);
  assert.equal(dl.status, 200);
  assert.equal((await admin('/api/server/backups/..%2Fshuttle.db')).status, 404);
  assert.equal((await admin(`/api/server/backups/${name}/restore`, { body: {} })).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarted, 1, 'restore restarts the site');
  assert.ok((await admin('/api/server/backups')).data.pending_restore);
  await admin('/api/server/restore', { method: 'DELETE' });
  assert.equal((await admin('/api/server/backups')).data.pending_restore, null);
  assert.equal((await admin(`/api/server/backups/${name}`, { method: 'DELETE' })).status, 200);

  // Restart button.
  assert.equal((await admin('/api/server/restart', { body: {} })).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restarted, 2);

  // Nightly backup time is a setting with the same rules as the other daily times.
  assert.equal((await admin('/api/settings', { method: 'PATCH', body: { backup_time: 'late' } })).status, 400);
  await admin('/api/settings', { method: 'PATCH', body: { backup_time: '01:00' } });
  const nightly = theApp.locals.nightlyBackup;
  assert.equal(nightly(new Date('2030-01-10T07:30:00Z')), null, '00:30 Denver: before 1:00');
  assert.equal(nightly(new Date('2030-01-10T08:05:00Z')).kind, 'daily', '01:05 Denver: made');
  assert.equal(nightly(new Date('2030-01-10T09:05:00Z')), null, 'once a night');
});
