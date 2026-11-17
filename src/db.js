// SQLite storage using Node's built-in driver (Node 22.13+).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 8000; -- with one copy of the site per core, wait for another copy's write instead of failing
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON; -- wiped customer info is overwritten on disk, not just marked free

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone         TEXT,
      role          TEXT NOT NULL CHECK (role IN ('admin','advisor','driver')),
      password_hash TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      on_duty       INTEGER NOT NULL DEFAULT 0,
      vehicle_id    INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      last_lat      REAL,
      last_lng      REAL,
      last_loc_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      make_model TEXT,
      year       INTEGER,
      color      TEXT,
      plate      TEXT,
      vin        TEXT,
      seats      INTEGER NOT NULL DEFAULT 7,
      mileage    INTEGER,
      status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','retired')),
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rides (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      type             TEXT NOT NULL CHECK (type IN ('pickup','dropoff')),
      customer_name    TEXT NOT NULL,
      customer_phone   TEXT,
      customer_email   TEXT,
      address          TEXT NOT NULL,
      lat              REAL,
      lng              REAL,
      scheduled_at     TEXT NOT NULL,
      priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
      passengers       INTEGER NOT NULL DEFAULT 1,
      ro_number        TEXT,
      customer_vehicle TEXT,
      notes            TEXT,
      status           TEXT NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested','assigned','en_route','onboard','completed','cancelled')),
      source           TEXT NOT NULL DEFAULT 'advisor',
      advisor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      driver_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      vehicle_id       INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      track_token      TEXT NOT NULL UNIQUE,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS rides_status ON rides(status);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Add columns introduced after the first release (safe to run every start).
  const addColumn = (table, column, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('rides', 'cancel_reason', 'TEXT');
  addColumn('rides', 'cancelled_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumn('rides', 'cancelled_at', 'TEXT');
  addColumn('rides', 'en_route_at', 'TEXT');   // when the driver started heading out
  addColumn('rides', 'onboard_at', 'TEXT');    // when the customer got in
  addColumn('rides', 'return_of', 'INTEGER');  // a drop off booked from this pick up ("Customer ready")
  addColumn('rides', 'no_return', 'INTEGER NOT NULL DEFAULT 0'); // pick up whose customer doesn't need a ride back
  addColumn('rides', 'cleared_at', 'TEXT');    // when the customer's details were wiped overnight
  addColumn('rides', 'urgent_reason', 'TEXT'); // why an advisor made the ride urgent
  addColumn('rides', 'city', 'TEXT');          // for reports; kept after the nightly customer-info clear
  addColumn('rides', 'est_miles', 'REAL');     // estimated round trip dealership <-> customer
  addColumn('vehicles', 'fuel', 'TEXT');                         // gas, hybrid, plugin, electric
  addColumn('vehicles', 'use', "TEXT NOT NULL DEFAULT 'shuttle'"); // shuttle, or loaner (not for the shuttle)
  addColumn('vehicles', 'fleet_id', 'TEXT');                     // ID from the dealership's vehicle list
  addColumn('vehicles', 'fleet_status', 'TEXT');                 // status on that list (Loaned, Body Shop, ...)
  // Indexes for the busiest lookups (ride lists, "ride back booked?", a driver's rides, sign-ins).
  db.exec(`
    CREATE INDEX IF NOT EXISTS rides_return_of ON rides(return_of);
    CREATE INDEX IF NOT EXISTS rides_scheduled ON rides(scheduled_at);
    CREATE INDEX IF NOT EXISTS rides_driver_status ON rides(driver_id, status);
    CREATE INDEX IF NOT EXISTS rides_advisor ON rides(advisor_id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS users_role_duty ON users(role, on_duty);
  `);
  addColumn('users', 'super_admin', 'INTEGER NOT NULL DEFAULT 0'); // can use the Server page
  addColumn('users', 'last_heading', 'REAL');  // direction of travel, degrees (from the phone's GPS)
  addColumn('users', 'last_speed', 'REAL');    // metres per second
  addColumn('users', 'route_json', 'TEXT');    // the driver's planned route (stops in order + path)
  addColumn('users', 'reset_requested_at', 'TEXT'); // set when someone taps "Forgot password?"
  db.exec(`
    CREATE TABLE IF NOT EXISTS spectate_links ( -- read-only live map links admins share; they run out
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      driver_id  INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = every driver on shift
      label      TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      views      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS perf (          -- page load times from real devices (no names, links or IPs); kept 14 days
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, page TEXT, role TEXT, device TEXT, net TEXT, proto TEXT, nav TEXT,
      dns INTEGER, connect INTEGER, tls INTEGER, wait INTEGER, download INTEGER, build INTEGER, ready INTEGER,
      data INTEGER, tiles INTEGER, tiles_n INTEGER
    );
    CREATE INDEX IF NOT EXISTS perf_at ON perf(at);
    CREATE TABLE IF NOT EXISTS feedback (      -- Help & suggestions from staff (also sent to Discord)
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      page       TEXT,
      sent       INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS driver_days (   -- miles and moving time from drivers' GPS, per day
      driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day       TEXT NOT NULL,
      miles     REAL NOT NULL DEFAULT 0,
      moving_s  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (driver_id, day)
    );
    CREATE TABLE IF NOT EXISTS ride_offers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id      INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      driver_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, declined, expired
      miles        REAL,
      minutes      INTEGER,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ride_offers_pending ON ride_offers(status, ride_id);
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sms_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id    INTEGER,
      event      TEXT,
      to_number  TEXT,
      body       TEXT,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  addColumn('users', 'last_battery', 'TEXT');
  addColumn('users', 'team', 'TEXT');
  addColumn('users', 'extra_roles', 'TEXT');
  addColumn('users', 'photo', 'TEXT');       // driver's photo for customers (small JPEG, data URL)
  addColumn('users', 'photo_v', 'INTEGER');  // changes when the photo does
  addColumn('rides', 'arrived_at', 'TEXT');  // driver tapped "I'm here"
  addColumn('rides', 'customer_reply', 'TEXT');    // customer's answer: coming | need5
  addColumn('rides', 'customer_reply_at', 'TEXT'); // other roles a person also has, e.g. "driver" for an advisor who drives
  addColumn('users', 'start_page', 'TEXT'); // the page they open to, for people with several roles
  addColumn('rides', 'booked_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'); // who booked it (e.g. BDC), when not the advisor          // 'bdc': an advisor on the BDC team (their own page)  // phone battery with the last location, e.g. "15" or "15+" (charging)
  addColumn('users', 'signup_at', 'TEXT');   // asked for an account from the sign-in page; waiting for an admin
  addColumn('users', 'signup_note', 'TEXT');
  addColumn('ride_offers', 'rotation', 'INTEGER NOT NULL DEFAULT 0'); // offered on the way back to the dealership
  // Each shift: who, which van, when, and what their phone's GPS saw (for reports).
  db.exec(`CREATE TABLE IF NOT EXISTS shifts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vehicle_id  INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      vehicle_name TEXT,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      ended_by    TEXT,                 -- driver | auto | sign-out
      miles       REAL NOT NULL DEFAULT 0,
      moving_s    INTEGER NOT NULL DEFAULT 0,
      gps_points  INTEGER NOT NULL DEFAULT 0,
      gps_gaps    INTEGER NOT NULL DEFAULT 0, -- times the phone went quiet for 2+ minutes
      longest_gap_s INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS shifts_started ON shifts(started_at);
    -- Server numbers per hour (every copy of the site adds its own): for the daily report.
    CREATE TABLE IF NOT EXISTS server_hours (
      hour     TEXT PRIMARY KEY,          -- 2026-11-17T21 (UTC)
      requests INTEGER NOT NULL DEFAULT 0,
      s4xx     INTEGER NOT NULL DEFAULT 0,
      s5xx     INTEGER NOT NULL DEFAULT 0,
      ms_total REAL NOT NULL DEFAULT 0,
      buckets  TEXT NOT NULL DEFAULT '[]', -- response-time histogram, see serverstats.js
      routes   TEXT NOT NULL DEFAULT '{}'  -- per kind of request: [count, ms total, slowest ms, errors]
    );
    -- The saved daily report (shuttle + server), built at midnight and kept with the backups.
    CREATE TABLE IF NOT EXISTS daily_reports (
      day      TEXT PRIMARY KEY,
      built_at TEXT NOT NULL,
      data     TEXT NOT NULL
    );`);
  return db;
}

module.exports = { openDb };
