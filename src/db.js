import fs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from './config.js';
import { buildRegionsFromWilayahRows, firstDemoRegion } from './seed/wilayah.js';

let driver = null;
let mysqlPool = null;
let libsqlClient = null;
let initPromise = null;
let MysqlModule = null;

const SQLITE_DEMO = {
  region: {
    prov: '97',
    kab: '9702',
    kec: '9702050',
    desa: '9702050008',
    sls: '97020500084001',
    subsls: '9702050008400100',
  },
  assignment: {
    id: 'a27eed59-b1ac-4c89-94da-cfa2c10ccdc0',
    respondentToken: '01d9c0e0-ae29-4538-a38e-40a706474038',
    nama: 'arfan',
    alamat: 'WILEKAMA',
  },
  submission: {
    id: '02d67be6-a6c5-4fdc-a1eb-714ba2d03f88',
  },
};

const SQLITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    fullname TEXT,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'mitra',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    code TEXT NOT NULL,
    fullcode TEXT NOT NULL UNIQUE,
    name TEXT,
    parent_id TEXT REFERENCES regions(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_regions_level ON regions(level)`,
  `CREATE INDEX IF NOT EXISTS ix_regions_parent ON regions(parent_id)`,
  `CREATE TABLE IF NOT EXISTS user_regions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, region_id)
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    kode_identitas TEXT,
    nama TEXT,
    alamat_prelist TEXT,
    nomor_urut_bangunan TEXT,
    idsbr TEXT,
    nib TEXT,
    email TEXT,
    prelist_type TEXT NOT NULL DEFAULT 'keluarga',
    mode TEXT NOT NULL DEFAULT 'CAWI',
    status TEXT NOT NULL DEFAULT 'open',
    region_id TEXT REFERENCES regions(id) ON DELETE SET NULL,
    region_fullcode TEXT,
    prov_code TEXT,
    kab_code TEXT,
    kec_code TEXT,
    desa_code TEXT,
    sls_code TEXT,
    subsls_code TEXT,
    sample_type TEXT,
    pengawas_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    pencacah_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    predefined TEXT,
    respondent_token TEXT UNIQUE,
    respondent_pin_hash TEXT,
    pin_reset_required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS ix_assign_region_fullcode ON assignments(region_fullcode)`,
  `CREATE INDEX IF NOT EXISTS ix_assign_status ON assignments(status)`,
  `CREATE INDEX IF NOT EXISTS ix_assign_prelist_type ON assignments(prelist_type)`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
    template_id TEXT,
    template_version TEXT,
    answers TEXT,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    filled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS submission_chunks (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    respondent_id TEXT,
    questionnaire_type TEXT,
    block_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'upsert',
    sequence_number INTEGER NOT NULL,
    payload TEXT NOT NULL,
    is_final_submission INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (assignment_id, block_id, sequence_number)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    diff TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normaliseRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = parseMaybeJson(value);
  }
  return out;
}

function ensureSqliteDir() {
  fs.mkdirSync(dirname(config.db.sqlitePath), { recursive: true });
}

// libsql execute returns { rows: [...] } where each row is an array-like object
// with column names as keys (ResultSet). Normalise to plain objects.
function libsqlRows(rs) {
  return rs.rows.map((row) => {
    const obj = {};
    for (const col of rs.columns) obj[col] = row[col];
    return normaliseRow(obj);
  });
}

async function syncSqliteRegions(db) {
  const regionMap = buildRegionsFromWilayahRows();
  const existingRs = await db.execute('SELECT id, fullcode FROM regions');
  const existingRows = libsqlRows(existingRs);
  const existingIdByFullcode = new Map(existingRows.map((row) => [row.fullcode, row.id]));

  for (const region of regionMap.values()) {
    if (existingIdByFullcode.has(region.fullcode)) {
      region.id = existingIdByFullcode.get(region.fullcode);
    }
  }
  for (const region of regionMap.values()) {
    region.parent_id = region.parentFullcode
      ? regionMap.get(region.parentFullcode)?.id || null
      : null;
  }

  const upsertSql = `
    INSERT INTO regions (id, level, code, fullcode, name, parent_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(fullcode) DO UPDATE SET
      level = excluded.level,
      code = excluded.code,
      name = excluded.name,
      parent_id = excluded.parent_id
  `;

  // Batch in chunks to avoid hitting statement limits
  const regions = [...regionMap.values()];
  const CHUNK = 100;
  for (let i = 0; i < regions.length; i += CHUNK) {
    const batch = regions.slice(i, i + CHUNK).map((r) => ({
      sql: upsertSql,
      args: [r.id, r.level, r.code, r.fullcode, r.name, r.parent_id],
    }));
    await db.batch(batch);
  }

  return regionMap;
}

async function seedSqliteDefaults(db) {
  const userRs = await db.execute('SELECT COUNT(*) AS c FROM users');
  const userCount = libsqlRows(userRs)[0]?.c ?? 0;
  if (!userCount) {
    const rounds = config.auth.bcryptRounds;
    const insertSql = `INSERT INTO users (id, username, password_hash, fullname, email, role, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    await db.batch([
      {
        sql: insertSql,
        args: [
          randomUUID(),
          config.seed.adminUsername,
          bcrypt.hashSync(config.seed.adminPassword, rounds),
          'Administrator BPS', null, 'admin', 1,
        ],
      },
      {
        sql: insertSql,
        args: [
          randomUUID(),
          config.seed.mitraUsername,
          bcrypt.hashSync(config.seed.mitraPassword, rounds),
          'Mitra Lapangan', null, 'mitra', 1,
        ],
      },
    ]);
  }

  const regionMap = await syncSqliteRegions(db);

  const assignRs = await db.execute('SELECT COUNT(*) AS c FROM assignments');
  const assignmentCount = libsqlRows(assignRs)[0]?.c ?? 0;
  if (!assignmentCount) {
    const demoRegion = firstDemoRegion(regionMap);
    const regionIdRs = await db.execute({
      sql: 'SELECT id FROM regions WHERE fullcode = ?',
      args: [demoRegion?.fullcode || SQLITE_DEMO.region.subsls],
    });
    const regionId = libsqlRows(regionIdRs)[0]?.id ?? null;
    const predefined = JSON.stringify({
      jenis_prelist: 'keluarga',
      mode: 'CAWI',
      nama_kk: SQLITE_DEMO.assignment.nama,
      is_keluarga: '1',
    });
    await db.batch([
      {
        sql: `INSERT INTO assignments (
          id, kode_identitas, nama, alamat_prelist, prelist_type, mode, status,
          region_id, region_fullcode, prov_code, kab_code, kec_code, desa_code,
          sls_code, subsls_code, predefined, respondent_token, respondent_pin_hash,
          pin_reset_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          SQLITE_DEMO.assignment.id,
          'DEMO-ARFAN',
          SQLITE_DEMO.assignment.nama,
          demoRegion?.name || SQLITE_DEMO.assignment.alamat,
          'keluarga', 'CAWI', 'open',
          regionId,
          demoRegion?.fullcode || SQLITE_DEMO.region.subsls,
          SQLITE_DEMO.region.prov,
          SQLITE_DEMO.region.kab,
          (demoRegion?.fullcode || '').slice(4, 7) || SQLITE_DEMO.region.kec,
          (demoRegion?.fullcode || '').slice(7, 10) || SQLITE_DEMO.region.desa,
          (demoRegion?.fullcode || '').slice(10, 14) || SQLITE_DEMO.region.sls,
          (demoRegion?.fullcode || '').slice(14, 16) || SQLITE_DEMO.region.subsls,
          predefined,
          SQLITE_DEMO.assignment.respondentToken,
          null, 1,
        ],
      },
      {
        sql: `INSERT INTO submissions (
          id, assignment_id, template_id, template_version, answers, summary, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          SQLITE_DEMO.submission.id,
          SQLITE_DEMO.assignment.id,
          '2230fffc-5799-4c8a-a585-12ac286c5bf9',
          '4.9.2',
          JSON.stringify({}),
          JSON.stringify({ answered: 0, errors: 0, warnings: 0, notes: 0 }),
          'draft',
        ],
      },
    ]);
  }
}

async function initLibsql() {
  ensureSqliteDir();
  const { createClient } = await import('@libsql/client');
  libsqlClient = createClient({ url: `file:${config.db.sqlitePath}` });
  // Run schema statements one by one
  for (const stmt of SQLITE_SCHEMA) {
    await libsqlClient.execute(stmt);
  }
  await libsqlClient.execute('PRAGMA journal_mode = WAL');
  await libsqlClient.execute('PRAGMA foreign_keys = ON');
  await seedSqliteDefaults(libsqlClient);
  driver = 'sqlite';
}

async function initMysql() {
  if (!MysqlModule) MysqlModule = await import('mysql2/promise');
  const base = {
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    connectTimeout: 1000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  };
  const connCfg = config.db.socket
    ? { ...base, socketPath: config.db.socket }
    : { ...base, host: config.db.host, port: config.db.port };
  mysqlPool = MysqlModule.default.createPool(connCfg);
  const conn = await mysqlPool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
  driver = 'mysql';
}

async function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      if (config.db.connection === 'sqlite' || config.env !== 'production') {
        await initLibsql();
        return;
      }
      try {
        await initMysql();
      } catch (err) {
        console.warn(`[db] MySQL tidak tersedia, fallback ke SQLite: ${err.message}`);
        await initLibsql();
      }
    })();
  }
  await initPromise;
}

export async function query(sql, params = []) {
  await ensureDb();
  if (driver === 'mysql') {
    const [rows] = await mysqlPool.execute(sql, params);
    return Array.isArray(rows) ? rows.map(normaliseRow) : rows;
  }
  // libsql uses positional ? params passed as args array
  const rs = await libsqlClient.execute({ sql, args: params });
  return libsqlRows(rs);
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

export async function withTransaction(fn) {
  await ensureDb();
  if (driver === 'mysql') {
    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
  // libsql transaction: collect statements then execute as batch
  const stmts = [];
  const txProxy = {
    query: async (sql, args = []) => {
      stmts.push({ sql, args });
      return [];
    },
    execute: async (sql, args = []) => {
      stmts.push({ sql, args });
      return Promise.resolve([]);
    },
  };
  const result = await fn(txProxy);
  if (stmts.length) await libsqlClient.batch(stmts, 'write');
  return result;
}

export async function getDriver() {
  await ensureDb();
  return driver;
}

export async function closeDb() {
  await ensureDb();
  if (driver === 'mysql' && mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }
  if (driver === 'sqlite' && libsqlClient) {
    libsqlClient.close();
    libsqlClient = null;
  }
  initPromise = null;
  driver = null;
}

export { mysqlPool as pool, libsqlClient as sqliteDb };
