// The business the tests run as: an existing install with a dealership near Boulder, CO.
// (A brand-new install starts blank and opens on /setup; see setup.test.js.)
const TEST_SITE = {
  setup_done: '1', dealer_name: 'Corwin Toyota of Boulder', dealer_address: '2465 48th Ct, Boulder, CO 80301',
  dealer_lat: '40.0236', dealer_lng: '-105.2405', timezone: 'America/Denver', service_radius_mi: '15.5',
};
function seedTestSite(db, extra = {}) {
  const put = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ ...TEST_SITE, ...extra })) put.run(k, v);
  return db;
}
module.exports = { seedTestSite, TEST_SITE };
