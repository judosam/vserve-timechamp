/**
 * VserveTimeChamp Embedded Database Manager
 * Pure Node.js built-in `node:sqlite` (DatabaseSync)
 * Zero external npm dependencies
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { initSchema, seedInitialData } = require('./schema');

let activeDb = null;
let currentDbPath = null;

const DEFAULT_DB_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'timechamp.db');

/**
 * Initializes the SQLite database connection, pragmas, schema, and seed data.
 * @param {string} [dbPath] - Optional custom DB path or ':memory:'
 * @returns {DatabaseSync}
 */
function initDb(dbPath = null) {
  const targetPath = dbPath || process.env.DB_PATH || DEFAULT_DB_PATH;

  if (activeDb && currentDbPath === targetPath) {
    return activeDb;
  }

  if (activeDb) {
    closeDb();
  }

  // Ensure target directory exists if file-based
  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(`Failed to create database directory ${dir}:`, err);
      }
    }
  }

  const db = new DatabaseSync(targetPath);

  // Apply performance and integrity pragmas
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (targetPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    } catch {}
  }

  // Initialize schema DDL and Seed initial data
  initSchema(db);
  seedInitialData(db);

  activeDb = db;
  currentDbPath = targetPath;
  return activeDb;
}

/**
 * Returns active DatabaseSync instance (initializes default if null).
 * @returns {DatabaseSync}
 */
function getDb() {
  if (!activeDb) {
    return initDb();
  }
  return activeDb;
}

/**
 * Closes the active database connection.
 */
function closeDb() {
  if (activeDb) {
    try {
      activeDb.close();
    } catch (err) {
      console.error('Error closing database:', err);
    }
    activeDb = null;
    currentDbPath = null;
  }
}

/**
 * Executes a query returning all rows.
 * @param {string} sql
 * @param {Array|any} [params=[]]
 * @returns {Array}
 */
function query(sql, params = []) {
  const db = getDb();
  const p = Array.isArray(params) ? params : [params];
  return db.prepare(sql).all(...p);
}

/**
 * Executes a query returning a single row or null.
 * @param {string} sql
 * @param {Array|any} [params=[]]
 * @returns {Object|null}
 */
function get(sql, params = []) {
  const db = getDb();
  const p = Array.isArray(params) ? params : [params];
  return db.prepare(sql).get(...p) || null;
}

/**
 * Executes an INSERT/UPDATE/DELETE statement.
 * @param {string} sql
 * @param {Array|any} [params=[]]
 * @returns {{ changes: number, lastInsertRowid: number|bigint }}
 */
function run(sql, params = []) {
  const db = getDb();
  const p = Array.isArray(params) ? params : [params];
  return db.prepare(sql).run(...p);
}

/**
 * Executes raw SQL statements.
 * @param {string} sql
 */
function exec(sql) {
  const db = getDb();
  return db.exec(sql);
}

/**
 * Wraps a synchronous callback within an immediate transaction.
 * Automatically commits on success and rolls back on exception.
 * @template T
 * @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    throw err;
  }
}

module.exports = {
  initDb,
  getDb,
  closeDb,
  query,
  get,
  run,
  exec,
  transaction
};
