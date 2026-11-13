process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice
// Last line of defence: log unexpected errors instead of letting them stop the website.
process.on('unhandledRejection', (e) => console.error(new Date().toLocaleString(), 'Unexpected error (site kept running):', e));
process.on('uncaughtException', (e) => console.error(new Date().toLocaleString(), 'Unexpected error (site kept running):', e));
const path = require('node:path');
const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { createUpdater, RESTART_CODE } = require('./updater');

const port = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'shuttle.db'));

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

let server;
const updater = createUpdater({
  // Finish in-flight requests, then exit so start-shuttle.bat restarts on the new version.
  restart: () => {
    server.close(() => process.exit(RESTART_CODE));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(RESTART_CODE), 3000).unref();
  },
});
server = createApp(db, { updater }).listen(port, () => {
  console.log(`Shuttle app running at http://localhost:${port}`);
  updater.start();
});
// The Cloudflare Tunnel keeps connections open and reuses them. If the server closes an idle
// connection first (Node's default is after 5 seconds) a request can arrive on it at the same
// moment and fail with a random "502 Bad Gateway". Keep connections open longer than the tunnel does.
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;
