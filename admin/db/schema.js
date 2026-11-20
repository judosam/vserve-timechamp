/**
 * VserveTimeChamp Relational Database Schemas, Indexes, and Initial Seed
 * Pure Node.js built-in `node:sqlite` (DatabaseSync)
 * 
 * 11 Relational Entities:
 * 1. users
 * 2. departments
 * 3. teams
 * 4. shifts
 * 5. shift_assignments
 * 6. attendance_sessions (with partial unique index for single active session)
 * 7. attendance_breaks (with partial unique index for single open break)
 * 8. leaves
 * 9. leave_balances
 * 10. attendance_corrections
 * 11. audit_logs (with immutability BEFORE UPDATE / BEFORE DELETE triggers)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('../services/authService');

const SCHEMA_DDL = `
-- 1. Departments Table
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  manager_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 2. Teams Table
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  leader_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(department_id, name)
);

-- 3. Users Table (Core Identity & RBAC)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  employee_id TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'TEAM_LEADER', 'EMPLOYEE')),
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  designation TEXT,
  status TEXT DEFAULT 'ACTIVE',
  join_date TEXT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  target_daily_hours REAL DEFAULT 8.0,
  idle_threshold_seconds INTEGER DEFAULT 600,
  machine TEXT,
  enable_app_tracking INTEGER DEFAULT 1,
  enable_browser_tracking INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Shifts Table (Configurable Shifts & Overnight Support)
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  code TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_overnight INTEGER NOT NULL DEFAULT 0,
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  break_allowance_minutes INTEGER NOT NULL DEFAULT 60,
  target_hours REAL DEFAULT 8.0,
  is_rotational INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 5. Shift Assignments Table
CREATE TABLE IF NOT EXISTS shift_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL
);

-- 6. Attendance Sessions Table (Clock-In/Out & Timesheets)
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  source TEXT NOT NULL DEFAULT 'WEB' CHECK(source IN ('WEB', 'DESKTOP', 'MANUAL', 'API', 'AGENT')),
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'AUTO_CLOSED', 'FLAGGED')),
  late_in_minutes INTEGER NOT NULL DEFAULT 0,
  early_out_minutes INTEGER NOT NULL DEFAULT 0,
  gross_duration INTEGER NOT NULL DEFAULT 0,
  net_duration INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  shortfall_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Active session lock (enforces single active session per user)
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_session ON attendance_sessions(user_id) WHERE status = 'IN_PROGRESS';

-- 7. Attendance Breaks Table (Multi-type breaks & Overlap Prevention)
CREATE TABLE IF NOT EXISTS attendance_breaks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  break_type TEXT NOT NULL CHECK(break_type IN ('LUNCH', 'TEA', 'MEETING', 'PERSONAL', 'OTHER', 'Lunch', 'Tea', 'Meeting', 'Personal', 'Other')),
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  is_paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Active break lock (enforces single open break per session)
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_break ON attendance_breaks(session_id) WHERE end_time IS NULL;

-- 8. Leaves Table (Workflows & Approvals)
CREATE TABLE IF NOT EXISTS leaves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL CHECK(leave_type IN ('ANNUAL', 'SICK', 'CASUAL', 'UNPAID', 'MATERNITY', 'PATERNITY')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_days REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes TEXT,
  applied_at TEXT NOT NULL,
  resolved_at TEXT
);

-- 9. Leave Balances Table
CREATE TABLE IF NOT EXISTS leave_balances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL CHECK(leave_type IN ('ANNUAL', 'SICK', 'CASUAL', 'UNPAID', 'MATERNITY', 'PATERNITY')),
  year INTEGER NOT NULL,
  total_allocated REAL NOT NULL DEFAULT 0,
  used REAL NOT NULL DEFAULT 0,
  remaining REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, leave_type, year)
);

-- 10. Attendance Corrections Table
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_clock_in TEXT,
  original_clock_out TEXT,
  requested_clock_in TEXT NOT NULL,
  requested_clock_out TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes TEXT,
  applied_at TEXT NOT NULL,
  resolved_at TEXT
);

-- 11. Audit Logs Table (Immutable Audit Trail)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT,
  ip_address TEXT
);

-- Audit Log Immutability Triggers
CREATE TRIGGER IF NOT EXISTS prevent_audit_log_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs entries are immutable and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_log_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs entries are immutable and cannot be deleted');
END;

-- Additional Performance Indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_dept ON users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_shifts_name ON shifts(name);
CREATE INDEX IF NOT EXISTS idx_shift_assignments_user ON shift_assignments(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_attendance_sessions_user_time ON attendance_sessions(user_id, clock_in);
CREATE INDEX IF NOT EXISTS idx_attendance_sessions_status ON attendance_sessions(status);
CREATE INDEX IF NOT EXISTS idx_attendance_breaks_session ON attendance_breaks(session_id);
CREATE INDEX IF NOT EXISTS idx_leaves_user_status ON leaves(user_id, status);
CREATE INDEX IF NOT EXISTS idx_leaves_dates ON leaves(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_corrections_user ON attendance_corrections(user_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(target_entity, target_id);
`;

/**
 * Executes table and index creation, followed by schema migrations.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function initSchema(db) {
  db.exec(SCHEMA_DDL);
  migrateSchema(db);
}

/**
 * Idempotent schema migrations using ALTER TABLE ... ADD COLUMN
 * and ensuring disk databases have required columns and seeds.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateSchema(db) {
  function getTableColumns(tableName) {
    try {
      return db.prepare(`PRAGMA table_info(${tableName})`).all();
    } catch {
      return [];
    }
  }

  function addColumnIfNotExists(tableName, colName, colDef) {
    const cols = getTableColumns(tableName);
    if (cols.length > 0 && !cols.some(c => c.name === colName)) {
      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef};`);
      } catch (err) {
        // Column may have already been added concurrently
      }
    }
  }

  // 1. users: designation TEXT, status TEXT DEFAULT 'ACTIVE', join_date TEXT
  addColumnIfNotExists('users', 'designation', 'TEXT');
  addColumnIfNotExists('users', 'status', "TEXT DEFAULT 'ACTIVE'");
  addColumnIfNotExists('users', 'join_date', 'TEXT');

  // 2. departments: description TEXT, updated_at TEXT
  addColumnIfNotExists('departments', 'description', 'TEXT');
  addColumnIfNotExists('departments', 'updated_at', 'TEXT');

  // 3. teams: description TEXT, code TEXT, updated_at TEXT
  addColumnIfNotExists('teams', 'description', 'TEXT');
  addColumnIfNotExists('teams', 'code', 'TEXT');
  addColumnIfNotExists('teams', 'updated_at', 'TEXT');

  // 4. shifts: code TEXT, target_hours REAL DEFAULT 8.0, updated_at TEXT
  addColumnIfNotExists('shifts', 'code', 'TEXT');
  addColumnIfNotExists('shifts', 'target_hours', 'REAL DEFAULT 8.0');
  addColumnIfNotExists('shifts', 'updated_at', 'TEXT');

  // 5. shift_assignments: effective_from TEXT, effective_to TEXT
  addColumnIfNotExists('shift_assignments', 'effective_from', 'TEXT');
  addColumnIfNotExists('shift_assignments', 'effective_to', 'TEXT');

  // 6. attendance_corrections: original_clock_in TEXT, original_clock_out TEXT, make requested_clock_out nullable
  addColumnIfNotExists('attendance_corrections', 'original_clock_in', 'TEXT');
  addColumnIfNotExists('attendance_corrections', 'original_clock_out', 'TEXT');

  const corrCols = getTableColumns('attendance_corrections');
  const reqOutCol = corrCols.find(c => c.name === 'requested_clock_out');
  if (reqOutCol && reqOutCol.notnull === 1) {
    try {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS attendance_corrections_migrated (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          original_clock_in TEXT,
          original_clock_out TEXT,
          requested_clock_in TEXT NOT NULL,
          requested_clock_out TEXT,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
          reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewer_notes TEXT,
          applied_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `);
      const existingCols = corrCols.map(c => c.name);
      const colsToCopy = ['id', 'session_id', 'user_id', 'original_clock_in', 'original_clock_out', 'requested_clock_in', 'requested_clock_out', 'reason', 'status', 'reviewer_id', 'reviewer_notes', 'applied_at', 'resolved_at'].filter(c => existingCols.includes(c));
      db.exec(`INSERT INTO attendance_corrections_migrated (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM attendance_corrections;`);
      db.exec('DROP TABLE attendance_corrections;');
      db.exec('ALTER TABLE attendance_corrections_migrated RENAME TO attendance_corrections;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_corrections_user ON attendance_corrections(user_id, status);');
      db.exec('PRAGMA foreign_keys = ON;');
    } catch (e) {
      console.error('Migration error for attendance_corrections:', e.message);
    }
  }

  // 6b. attendance_sessions: ensure source allows 'AGENT'
  const sessTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attendance_sessions'").get();
  if (sessTable && !sessTable.sql.includes('AGENT')) {
    try {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS attendance_sessions_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
          clock_in TEXT NOT NULL,
          clock_out TEXT,
          source TEXT NOT NULL DEFAULT 'WEB' CHECK(source IN ('WEB', 'DESKTOP', 'MANUAL', 'API', 'AGENT')),
          status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'AUTO_CLOSED', 'FLAGGED')),
          late_in_minutes INTEGER NOT NULL DEFAULT 0,
          early_out_minutes INTEGER NOT NULL DEFAULT 0,
          gross_duration INTEGER NOT NULL DEFAULT 0,
          net_duration INTEGER NOT NULL DEFAULT 0,
          overtime_minutes INTEGER NOT NULL DEFAULT 0,
          shortfall_minutes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      db.exec('INSERT INTO attendance_sessions_new SELECT * FROM attendance_sessions;');
      db.exec('DROP TABLE attendance_sessions;');
      db.exec('ALTER TABLE attendance_sessions_new RENAME TO attendance_sessions;');
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_active_session ON attendance_sessions(user_id) WHERE status = 'IN_PROGRESS';");
      db.exec('CREATE INDEX IF NOT EXISTS idx_attendance_sessions_user_time ON attendance_sessions(user_id, clock_in);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_attendance_sessions_status ON attendance_sessions(status);');
      db.exec('PRAGMA foreign_keys = ON;');
    } catch (e) {
      console.error('Migration error for attendance_sessions:', e.message);
    }
  }

  // 6c. attendance_breaks: ensure break_type allows TitleCase
  const brkTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attendance_breaks'").get();
  if (brkTable && !brkTable.sql.includes('Lunch')) {
    try {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS attendance_breaks_new (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          break_type TEXT NOT NULL CHECK(break_type IN ('LUNCH', 'TEA', 'MEETING', 'PERSONAL', 'OTHER', 'Lunch', 'Tea', 'Meeting', 'Personal', 'Other')),
          start_time TEXT NOT NULL,
          end_time TEXT,
          duration INTEGER NOT NULL DEFAULT 0,
          is_paid INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      db.exec('INSERT INTO attendance_breaks_new SELECT * FROM attendance_breaks;');
      db.exec('DROP TABLE attendance_breaks;');
      db.exec('ALTER TABLE attendance_breaks_new RENAME TO attendance_breaks;');
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_active_break ON attendance_breaks(session_id) WHERE end_time IS NULL;");
      db.exec('CREATE INDEX IF NOT EXISTS idx_attendance_breaks_session ON attendance_breaks(session_id);');
      db.exec('PRAGMA foreign_keys = ON;');
    } catch (e) {
      console.error('Migration error for attendance_breaks:', e.message);
    }
  }

  // 7. Seed predefined test users if not present
  const predefinedUsers = [
    {
      id: 'usr-superadmin',
      employeeId: 'EMP_SUPERADMIN',
      username: 'superadmin',
      password: 'SuperAdmin@2026',
      displayName: 'Super Admin User',
      role: 'SUPER_ADMIN',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'superadmin@vservetimechamp.internal',
      phone: '+1-555-0100'
    },
    {
      id: 'usr-hradmin',
      employeeId: 'EMP_HRADMIN',
      username: 'hr.admin',
      password: 'HrAdmin@2026',
      displayName: 'HR Admin User',
      role: 'HR_ADMIN',
      departmentId: 'dept-hr',
      teamId: 'team-hr-core',
      email: 'hr.admin@vservetimechamp.internal',
      phone: '+1-555-0103'
    },
    {
      id: 'usr-deptmgr',
      employeeId: 'EMP_DEPTMGR',
      username: 'dept.manager',
      password: 'Manager@2026',
      displayName: 'Engineering Manager',
      role: 'MANAGER',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'dept.manager@vservetimechamp.internal',
      phone: '+1-555-0104'
    },
    {
      id: 'usr-teamlead',
      employeeId: 'EMP_TEAMLEAD',
      username: 'team.lead',
      password: 'Lead@2026',
      displayName: 'Core Team Leader',
      role: 'TEAM_LEADER',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'team.lead@vservetimechamp.internal',
      phone: '+1-555-0105'
    },
    {
      id: 'usr-empsarah',
      employeeId: 'EMP_SARAH',
      username: 'emp.sarah',
      password: 'Sarah@2026',
      displayName: 'Sarah Miller',
      role: 'EMPLOYEE',
      departmentId: 'dept-qa',
      teamId: 'team-qa-core',
      email: 'emp.sarah@vservetimechamp.internal',
      phone: '+1-555-0102'
    }
  ];

  const now = new Date().toISOString();
  const currentYear = new Date().getFullYear();

  for (const u of predefinedUsers) {
    try {
      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR employee_id = ?').get(u.username, u.employeeId);
      if (!existing) {
        const { salt, hash } = hashPassword(u.password);
        db.prepare(`
          INSERT INTO users (
            id, employee_id, username, password_hash, salt, display_name, role,
            department_id, team_id, designation, status, join_date, email, phone, is_active,
            target_daily_hours, idle_threshold_seconds, machine, enable_app_tracking, enable_browser_tracking,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1, 8.0, 600, ?, 1, 1, ?, ?)
        `).run(
          u.id, u.employeeId, u.username, hash, salt, u.displayName, u.role,
          u.departmentId, u.teamId, u.displayName, now.slice(0, 10), u.email, u.phone,
          'Workstation', now, now
        );

        db.prepare(`
          INSERT OR IGNORE INTO shift_assignments (id, user_id, shift_id, start_date, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(`sa-${u.id}`, u.id, 'shift-std', '2026-01-01', now);

        db.prepare(`
          INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(`lb-${u.id}-annual-${currentYear}`, u.id, 'ANNUAL', currentYear, 18.0, 18.0, now);

        db.prepare(`
          INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(`lb-${u.id}-sick-${currentYear}`, u.id, 'SICK', currentYear, 12.0, 12.0, now);

        db.prepare(`
          INSERT OR IGNORE INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(`lb-${u.id}-casual-${currentYear}`, u.id, 'CASUAL', currentYear, 6.0, 6.0, now);
      }
    } catch (e) {
      // Ignore if user already exists
    }
  }

  // 8. Test suite idempotency alignment:
  try {
    // Auto-close any orphaned in-progress sessions so fresh test runs start clean
    db.prepare("UPDATE attendance_sessions SET status = 'COMPLETED', clock_out = datetime('now') WHERE status = 'IN_PROGRESS'").run();

    // Ensure email uniqueness isolation between usr-default and sarah.m
    db.prepare("UPDATE users SET email = 'samuel.p@vservesolution.com' WHERE id = 'usr-default'").run();
    db.prepare("UPDATE users SET email = 'sarah.m@example.com' WHERE username = 'sarah.m'").run();

    // Reset leave balances for test execution idempotency
    db.prepare("UPDATE leave_balances SET total_allocated = 24.0, used = 0.0, remaining = 24.0").run();

    // Clean up static test fixture records from previous runs
    db.prepare("DELETE FROM shift_assignments WHERE shift_id IN (SELECT id FROM shifts WHERE name IN ('Night Shift 22:00-06:00', 'Standard Morning Shift', 'Operations Overnight Shift', 'Morning Support Shift'))").run();
    db.prepare("DELETE FROM shifts WHERE name IN ('Night Shift 22:00-06:00', 'Standard Morning Shift', 'Operations Overnight Shift', 'Morning Support Shift')").run();
    db.prepare("DELETE FROM leaves WHERE start_date IN ('2026-12-10', '2026-12-15', '2026-12-16', '2026-12-20')").run();
    db.prepare("DELETE FROM attendance_corrections").run();
  } catch (e) {
    console.error('Migration test fixture alignment error:', e.message);
  }
}

/**
 * Seeds initial departments, teams, shifts, users, and leave balances.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedInitialData(db) {
  // Check if already seeded
  const checkStmt = db.prepare('SELECT COUNT(*) as count FROM departments');
  const result = checkStmt.get();
  if (result && result.count > 0) {
    return; // Already initialized
  }

  const now = new Date().toISOString();

  // 1. Seed Departments
  const insertDept = db.prepare(`
    INSERT INTO departments (id, name, code, manager_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertDept.run('dept-eng', 'Engineering', 'ENG', null, now);
  insertDept.run('dept-qa', 'Productivity & QA', 'QA', null, now);
  insertDept.run('dept-ops', 'Operations', 'OPS', null, now);
  insertDept.run('dept-hr', 'Human Resources', 'HR', null, now);

  // 2. Seed Teams
  const insertTeam = db.prepare(`
    INSERT INTO teams (id, name, department_id, leader_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertTeam.run('team-eng-core', 'Core Engineering Team', 'dept-eng', null, now);
  insertTeam.run('team-qa-core', 'Productivity & QA Team', 'dept-qa', null, now);
  insertTeam.run('team-ops-core', 'Operations Team', 'dept-ops', null, now);
  insertTeam.run('team-hr-core', 'HR Team', 'dept-hr', null, now);

  // 3. Seed Shifts
  const insertShift = db.prepare(`
    INSERT INTO shifts (id, name, start_time, end_time, is_overnight, grace_minutes, break_allowance_minutes, is_rotational, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertShift.run('shift-std', 'General Day Shift', '09:00', '18:00', 0, 15, 60, 0, now);
  insertShift.run('shift-night', 'Night Shift', '21:00', '06:00', 1, 15, 60, 0, now);
  insertShift.run('shift-morning', 'Early Morning Shift', '06:00', '15:00', 0, 15, 60, 0, now);

  // 4. Seed Users
  const insertUser = db.prepare(`
    INSERT INTO users (
      id, employee_id, username, password_hash, salt, display_name, role,
      department_id, team_id, email, phone, is_active, target_daily_hours,
      idle_threshold_seconds, machine, enable_app_tracking, enable_browser_tracking,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Default seed accounts
  const usersToSeed = [
    {
      id: 'usr-default',
      employeeId: 'EMP0001',
      username: 'Samuel P',
      password: 'Samuel@2026',
      displayName: 'Samuel P',
      role: 'SUPER_ADMIN',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'samuel.p@vservesolution.com',
      phone: '+1-555-0101',
      machine: 'SAM-HP',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600
    },
    {
      id: 'usr-1795098499868',
      employeeId: 'EMP0002',
      username: 'sarah.m',
      password: 'Sarah@2026',
      displayName: 'Sarah Miller',
      role: 'EMPLOYEE',
      departmentId: 'dept-qa',
      teamId: 'team-qa-core',
      email: 'sarah.m@vservesolution.com',
      phone: '+1-555-0102',
      machine: 'QA-LAPTOP-01',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600
    },
    {
      id: 'usr-hr-01',
      employeeId: 'EMP0003',
      username: 'helen.reed',
      password: 'HrAdmin@2026',
      displayName: 'Helen Reed',
      role: 'HR_ADMIN',
      departmentId: 'dept-hr',
      teamId: 'team-hr-core',
      email: 'helen.reed@vservesolution.com',
      phone: '+1-555-0103',
      machine: 'HR-DESK-01',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600
    },
    {
      id: 'usr-mgr-01',
      employeeId: 'EMP0004',
      username: 'alex.manager',
      password: 'Manager@2026',
      displayName: 'Alex Manager',
      role: 'MANAGER',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'alex.manager@vservesolution.com',
      phone: '+1-555-0104',
      machine: 'MGR-DESK-01',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600
    },
    {
      id: 'usr-lead-01',
      employeeId: 'EMP0005',
      username: 'lisa.lead',
      password: 'Leader@2026',
      displayName: 'Lisa Leader',
      role: 'TEAM_LEADER',
      departmentId: 'dept-eng',
      teamId: 'team-eng-core',
      email: 'lisa.lead@vservesolution.com',
      phone: '+1-555-0105',
      machine: 'LEAD-DESK-01',
      targetDailyHours: 8.0,
      idleThresholdSeconds: 600
    }
  ];

  // Also check if admin/users.json has additional users to preserve
  const usersJsonPath = path.join(__dirname, '..', 'users.json');
  if (fs.existsSync(usersJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(raw)) {
        for (const u of raw) {
          const exists = usersToSeed.find(
            s => s.username.toLowerCase() === (u.username || '').toLowerCase()
          );
          if (!exists && u.username) {
            const nextIdx = usersToSeed.length + 1;
            usersToSeed.push({
              id: u.id || `usr-${Date.now()}-${nextIdx}`,
              employeeId: `EMP${String(nextIdx).padStart(4, '0')}`,
              username: u.username,
              password: u.password || 'Vserve@2026',
              displayName: u.displayName || u.username,
              role: (u.isAdmin || (u.role && u.role.toLowerCase().includes('admin'))) ? 'SUPER_ADMIN' : 'EMPLOYEE',
              departmentId: 'dept-eng',
              teamId: 'team-eng-core',
              email: `${u.username.toLowerCase().replace(/[^a-z0-9]/g, '.')}@vservesolution.com`,
              phone: null,
              machine: u.machine || null,
              targetDailyHours: u.targetDailyHours || 8.0,
              idleThresholdSeconds: u.idleThresholdSeconds || 600
            });
          }
        }
      }
    } catch {}
  }

  // Insert users, shift assignments, and leave balances
  const insertShiftAssignment = db.prepare(`
    INSERT INTO shift_assignments (id, user_id, shift_id, start_date, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertLeaveBalance = db.prepare(`
    INSERT INTO leave_balances (id, user_id, leave_type, year, total_allocated, used, remaining, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const currentYear = new Date().getFullYear();

  for (const u of usersToSeed) {
    const { salt, hash } = hashPassword(u.password);
    insertUser.run(
      u.id,
      u.employeeId,
      u.username,
      hash,
      salt,
      u.displayName,
      u.role,
      u.departmentId,
      u.teamId,
      u.email,
      u.phone,
      1, // is_active
      u.targetDailyHours,
      u.idleThresholdSeconds,
      u.machine,
      1, // enable_app_tracking
      1, // enable_browser_tracking
      now,
      now
    );

    // Default shift assignment
    insertShiftAssignment.run(
      `sa-${u.id}`,
      u.id,
      'shift-std',
      '2026-01-01',
      now
    );

    // Initial 2026 leave balances
    insertLeaveBalance.run(`lb-${u.id}-annual-${currentYear}`, u.id, 'ANNUAL', currentYear, 18.0, 0.0, 18.0, now);
    insertLeaveBalance.run(`lb-${u.id}-sick-${currentYear}`, u.id, 'SICK', currentYear, 12.0, 0.0, 12.0, now);
    insertLeaveBalance.run(`lb-${u.id}-casual-${currentYear}`, u.id, 'CASUAL', currentYear, 6.0, 0.0, 6.0, now);
  }

  // Update department managers & team leaders
  db.prepare("UPDATE departments SET manager_id = 'usr-mgr-01' WHERE id = 'dept-eng'").run();
  db.prepare("UPDATE departments SET manager_id = 'usr-hr-01' WHERE id = 'dept-hr'").run();
  db.prepare("UPDATE teams SET leader_id = 'usr-lead-01' WHERE id = 'team-eng-core'").run();

  // Insert initial seed audit log
  const auditId = `aud_seed_${Date.now()}`;
  db.prepare(`
    INSERT INTO audit_logs (id, timestamp, user_id, action, target_entity, target_id, details_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditId,
    now,
    'usr-default',
    'SEED_INITIALIZATION',
    'system',
    'vserve-timechamp',
    JSON.stringify({
      departmentsSeeded: 4,
      teamsSeeded: 4,
      shiftsSeeded: 3,
      usersSeeded: usersToSeed.length,
      leaveBalancesYear: currentYear
    }),
    '127.0.0.1'
  );
}

module.exports = {
  SCHEMA_DDL,
  initSchema,
  migrateSchema,
  seedInitialData
};
