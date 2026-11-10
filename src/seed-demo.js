// Adds sample vehicles, staff and rides so you can try the app. Run: npm run seed:demo
process.removeAllListeners('warning');
const path = require('node:path');
const { openDb } = require('./db');
const { hashPassword, randomToken } = require('./auth');

const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'shuttle.db'));
const pw = process.env.DEMO_PASSWORD || 'shuttle123';

const users = [
  ['Alex Advisor', 'advisor@demo.local', 'advisor', '303-555-0101'],
  ['Dana Driver', 'driver@demo.local', 'driver', '303-555-0102'],
  ['Sam Shuttle', 'driver2@demo.local', 'driver', '303-555-0103'],
];
for (const [name, email, role, phone] of users) {
  db.prepare('INSERT OR IGNORE INTO users (name, email, role, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, role, phone, hashPassword(pw));
}
if (!db.prepare('SELECT COUNT(*) n FROM vehicles').get().n) {
  const v = db.prepare('INSERT INTO vehicles (name, make_model, year, color, plate, seats, mileage) VALUES (?, ?, ?, ?, ?, ?, ?)');
  v.run('Shuttle 1', 'Toyota Sienna', 2025, 'White', 'CTB-001', 7, 12450);
  v.run('Shuttle 2', 'Toyota Sienna', 2024, 'Silver', 'CTB-002', 7, 28810);
  v.run('Shuttle Van', 'Toyota Sequoia', 2024, 'Black', 'CTB-003', 8, 19020);
}
const advisor = db.prepare("SELECT id FROM users WHERE email = 'advisor@demo.local'").get();
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const rides = [
  ['pickup', 'Jordan Lee', '303-555-0201', '1777 Broadway, Boulder, CO', 40.0176, -105.2797, inMin(20), 'normal', 'RO-10231', '2021 RAV4'],
  ['dropoff', 'Priya Patel', '303-555-0202', '3300 28th St, Boulder, CO', 40.0262, -105.2580, inMin(5), 'urgent', 'RO-10232', '2019 Camry'],
  ['pickup', 'Chris Gomez', '303-555-0203', '600 S Public Rd, Lafayette, CO', 39.9930, -105.0900, inMin(45), 'normal', 'RO-10233', '2023 Tacoma'],
  ['dropoff', 'Morgan Kim', '303-555-0204', 'University of Colorado Boulder', 40.0076, -105.2659, inMin(-10), 'normal', 'RO-10234', '2020 Highlander'],
];
for (const r of rides) {
  db.prepare(`INSERT INTO rides (type, customer_name, customer_phone, address, lat, lng, scheduled_at, priority, ro_number, customer_vehicle, advisor_id, track_token)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...r, advisor.id, randomToken(12));
}
console.log(`Demo data added. Staff logins use password "${pw}":`);
for (const [, email, role] of users) console.log(`  ${role.padEnd(8)} ${email}`);
