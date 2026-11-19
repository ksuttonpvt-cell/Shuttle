// Adds sample vehicles, staff and rides so you can try the app. Run: npm run seed:demo
process.removeAllListeners('warning');
const path = require('node:path');
const { openDb } = require('./db');
const { hashPassword, randomToken } = require('./auth');

const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'shuttle.db'));
const pw = process.env.DEMO_PASSWORD || 'shuttle123';

const users = [
  ['Alex Advisor', 'advisor@demo.local', 'advisor', '555-555-0101'],
  ['Dana Driver', 'driver@demo.local', 'driver', '555-555-0102'],
  ['Sam Shuttle', 'driver2@demo.local', 'driver', '555-555-0103'],
];
for (const [name, email, role, phone] of users) {
  db.prepare('INSERT OR IGNORE INTO users (name, email, role, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, role, phone, hashPassword(pw));
}
if (!db.prepare('SELECT COUNT(*) n FROM vehicles').get().n) {
  const v = db.prepare('INSERT INTO vehicles (name, make_model, year, color, plate, seats, mileage) VALUES (?, ?, ?, ?, ?, ?, ?)');
  v.run('Shuttle 1', 'Ford Transit', 2025, 'White', 'DEMO-001', 7, 12450);
  v.run('Shuttle 2', 'Ford Transit', 2024, 'Silver', 'DEMO-002', 7, 28810);
  v.run('Shuttle Van', 'Chevrolet Express', 2024, 'Black', 'DEMO-003', 8, 19020);
}
const advisor = db.prepare("SELECT id FROM users WHERE email = 'advisor@demo.local'").get();
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
// Sample rides a few miles around your business (from Setup / Admin → Settings).
const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const lat0 = Number(setting('dealer_lat')) || 39.8283; const lng0 = Number(setting('dealer_lng')) || -98.5795;
const near = (dLat, dLng) => [Math.round((lat0 + dLat) * 1e4) / 1e4, Math.round((lng0 + dLng) * 1e4) / 1e4];
const rides = [
  ['pickup', 'Jordan Lee', '555-555-0201', '1777 Sample Ave (demo)', ...near(0.03, -0.03), inMin(20), 'normal', 'RO-10231', '2021 RAV4'],
  ['dropoff', 'Priya Patel', '555-555-0202', '3300 Example St (demo)', ...near(0.02, 0.02), inMin(5), 'urgent', 'RO-10232', '2019 Camry'],
  ['pickup', 'Chris Gomez', '555-555-0203', '600 Test Rd (demo)', ...near(-0.04, 0.06), inMin(45), 'normal', 'RO-10233', '2023 Tacoma'],
  ['dropoff', 'Morgan Kim', '555-555-0204', '12 Demo Ct (demo)', ...near(-0.01, -0.02), inMin(-10), 'normal', 'RO-10234', '2020 Highlander'],
];
for (const r of rides) {
  db.prepare(`INSERT INTO rides (type, customer_name, customer_phone, address, lat, lng, scheduled_at, priority, ro_number, customer_vehicle, advisor_id, track_token)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...r, advisor.id, randomToken(12));
}
console.log(`Demo data added. Staff logins use password "${pw}":`);
for (const [, email, role] of users) console.log(`  ${role.padEnd(8)} ${email}`);
