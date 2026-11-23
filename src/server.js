process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice
// Last line of defence: log unexpected errors instead of letting them stop the website.
process.on('unhandledRejection', (e) => console.error(new Date().toLocaleString(), 'Unexpected error (site kept running):', e));
process.on('uncaughtException', (e) => console.error(new Date().toLocaleString(), 'Unexpected error (site kept running):', e));
const path = require('node:path');
const cluster = require('node:cluster');
const { openDb } = require('./db');
const { createLogbook, eachLine } = require('./logbook');
const { createBackups, applyPendingRestore } = require('./backup');
const { createApp, ensureAdmin } = require('./app');
const { createOsrmRouter } = require('./routing');
const { createUpdater, RESTART_CODE } = require('./updater');
const { createBus, startPrimary, coresWanted } = require('./cluster');
const http = require('node:http');
const { createBusinesses } = require('./businesses');
const { createSite } = require('./frontdoor');

const port = Number(process.env.PORT) || 3000;
const dbFile = path.resolve(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'shuttle.db'));
const dataDir = path.dirname(dbFile);
// When started by supervisor.js, it writes the log files (it sees crashes too); otherwise this does.
const supervised = process.env.SHUTTLE_SUPERVISED === '1';
const logsDir = path.join(dataDir, 'logs');
const stampNow = () => new Date().toLocaleString();
const MB_PER_COPY = 192; // the least memory one copy of the site needs
// Other businesses hosted on this PC live at <name>.BUSINESS_DOMAIN; the shared sign-in is app.BUSINESS_DOMAIN.
const businessDomain = String(process.env.BUSINESS_DOMAIN || 'turaslubtha.com').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

if (cluster.isPrimary) primary(); else worker();

// The main process: gets the database ready, then runs one copy of the site per processor
// core (Admin → Server → Cores & memory), or the site itself when that's one core.
function primary() {
  const logbook = createLogbook({ dir: supervised ? null : logsDir });
  // A restore asked for in Admin → Server happens here, before anything opens the database.
  applyPendingRestore({ dbFile, dir: path.join(dataDir, 'backups'), log: (m) => console.log(stampNow(), '[backups]', m) });
  const db = openDb(dbFile);
  const created = ensureAdmin(db, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME,
  });
  if (created) {
    console.log('\n  First admin account created:');
    console.log(`    email:    ${created.email}`);
    if (created.password) console.log(`    password: ${created.password}   (change it after signing in)`);
    console.log('');
  }
  logbook.captureConsole(); // after the first-admin details, so they're only shown on screen

  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const cores = coresWanted(process.env.CORES || setting('server_cores') || 'auto');
  const ramMb = Number(process.env.RAM_MB || setting('server_ram_mb')) || 0;
  const count = ramMb ? Math.max(1, Math.min(cores, Math.floor(ramMb / MB_PER_COPY))) : cores;

  if (count === 1 && !ramMb) { runSite(db, { logbook, bus: createBus() }); return; } // one core: as it always was

  // Set up the database (new settings and one-time changes) once, before the copies start.
  createApp(db, { noTimers: true });
  db.close();
  // The same for every other business on this PC.
  const dir = createBusinesses({ dataDir, openDb, makeApp: (slug, bdb) => createApp(bdb, { noTimers: true, business: slug }) });
  dir.loadAll(); dir.close();
  const heapMb = ramMb ? Math.max(96, Math.floor((ramMb / count) * 0.7)) : 0; // the rest is for Node itself
  let group = null;
  const restartAll = () => {
    if (!group) return;
    const g = group; group = null;
    g.stop().then(() => process.exit(RESTART_CODE));
  };
  group = startPrimary({
    count, heapMb, ramMb,
    env: { SHUTTLE_WORKERS: String(count), SHUTTLE_ASSET_VERSION: Date.now().toString(36) },
    output: (stream, isErr) => eachLine(stream, (line) => {
      (isErr ? process.stderr : process.stdout).write(`${line}\n`);
      logbook.add(line, { fromStderr: isErr });
    }),
    handle: {
      restart: () => { setTimeout(restartAll, 100); return true; },
      logs: (o) => logbook.recent(o || {}),
      logcounts: () => logbook.counts(),
      info: () => ({ count: group ? group.count : 0, ram_restarts: group ? group.ramRestarts : 0, rss_mb: group ? group.rssMb : 0 }),
    },
    log: (m) => console.log(stampNow(), '[server]', m),
  });
  console.log(`Shuttle app running at http://localhost:${port} on ${count} processor core${count === 1 ? '' : 's'}${ramMb ? ` with a ${ramMb} MB memory limit` : ''}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { const g = group; group = null; (g ? g.stop() : Promise.resolve()).then(() => process.exit(0)); });
}

// One copy of the site (started by the main process).
function worker() {
  // If the main process goes away, stop at once (quietly: its log pipe is gone too).
  for (const out of [process.stdout, process.stderr]) out.on('error', () => {});
  process.on('disconnect', () => process.exit(0));
  const db = openDb(dbFile); // the main process already brought the database up to date
  runSite(db, { logbook: createLogbook(), bus: createBus() });
}

function runSite(db, { logbook, bus }) {
  const backups = createBackups({ db, dir: path.join(dataDir, 'backups'), log: (m) => console.log(stampNow(), '[backups]', m) });
  let server;
  // Finish in-flight requests, then exit; supervisor.js (start-shuttle.bat) starts it again right away.
  // With several cores the main process restarts every copy.
  function restart() {
    if (bus.clustered) { bus.ask('primary', 'restart').catch(() => process.exit(RESTART_CODE)); return; }
    server.close(() => process.exit(RESTART_CODE));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(RESTART_CODE), 3000).unref();
  }
  const updater = createUpdater({ restart });
  // Road routing for the driver route planner (ROUTING=off turns it off; ROUTING_URL picks another OSRM server).
  const router = process.env.ROUTING === 'off' ? null : createOsrmRouter({ baseUrl: process.env.ROUTING_URL || undefined });
  const say = (m) => console.log(stampNow(), '[businesses]', m);
  const assetVersion = process.env.SHUTTLE_ASSET_VERSION || undefined;
  const site = createSite({
    db, dataDir, domain: businessDomain, bus, openDb, createApp, log: say,
    homeOpts: { updater, router, logbook, logsDir, backups, dbFile, supervised, restart, assetVersion },
    // Every other business on this PC: its own database, backups and private messages.
    businessOpts: (slug, bdb, file) => ({ router, assetVersion,
      backups: createBackups({ db: bdb, dir: path.join(path.dirname(file), 'backups'), log: (m) => say(`${slug}: ${m}`) }) }),
  });
  server = http.createServer(site.handler).listen(port, () => {
    if (!bus.clustered) console.log(`Shuttle app running at http://localhost:${port}`);
    if (bus.jobs) updater.start(); else updater.readVersion(); // one copy checks for updates
  });
  // The Cloudflare Tunnel keeps connections open and reuses them. If the server closes an idle
  // connection first (Node's default is after 5 seconds) a request can arrive on it at the same
  // moment and fail with a random "502 Bad Gateway". Keep connections open longer than the tunnel does.
  server.keepAliveTimeout = 120 * 1000;
  server.headersTimeout = 125 * 1000;
}
