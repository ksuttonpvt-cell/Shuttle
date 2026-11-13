// SQLite storage using Node's built-in driver (Node 22.13+).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
  addColumn('users', 'reset_requested_at', 'TEXT'); // set when someone taps "Forgot password?"
  db.exec(`
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
  return db;
}

module.exports = { openDb };
