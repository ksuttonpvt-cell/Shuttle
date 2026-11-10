process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice
const path = require('node:path');
const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');

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

createApp(db).listen(port, () => console.log(`Shuttle app running at http://localhost:${port}`));
