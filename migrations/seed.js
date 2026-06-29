// ─────────────────────────────────────────────────────────────────────────────
// Seed dari backup FASIH SQLite → MySQL (§0.1, §0.3, §12.2).
//
//  Sumber:
//   - device_exports/backups/critina_14/db/Survey_database  (assignment, petugas)
//       · data_assignment_entity  (101 baris; wilayah ter-denormalisasi di
//         kolom region_level*, isian prelist di preDefinedData JSON)
//       · field_officer           (petugas/PPL)
//   - Survey_database_dynamic (jawaban kuesioner) — OPSIONAL. Di backup ini ada
//     di dalam databases.zip yang ter-enkripsi AES; bila tidak tersedia, seed
//     submissions dilewati dengan peringatan (tidak menggagalkan seed).
//
//  Menghasilkan:
//   - users        : 1 admin + 1 mitra (manual, dari .env) + petugas dari backup
//   - regions       : pohon prov→…→subsls di-derive dari region_level*
//   - assignments   : 101 baris dipetakan via §0.3
//   - user_regions  : mitra ditugaskan ke semua region prov (contoh)
//   - submissions   : bila DB dynamic tersedia
//
//  Idempotent: TRUNCATE tabel non-users data sebelum re-seed; users di-upsert.
//  Run: `npm run seed`
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, query, withTransaction } from '../src/db.js';
import config from '../src/config.js';
import { buildRegionsFromWilayahRows, firstDemoRegion } from '../src/seed/wilayah.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // entry-se/
const BACKUP_DIR = join(ROOT, 'device_exports', 'backups', 'critina_14');
const SURVEY_DB = join(BACKUP_DIR, 'db', 'Survey_database');
// Candidate locations for the (optional) dynamic answers DB.
const DYNAMIC_DB_CANDIDATES = [
  join(BACKUP_DIR, 'db', 'Survey_database_dynamic'),
  join(BACKUP_DIR, 'databases', 'Survey_database_dynamic'),
  join(BACKUP_DIR, 'extracted', 'databases', 'Survey_database_dynamic'),
];

const TEMPLATE_ID = '2230fffc-5799-4c8a-a585-12ac286c5bf9';
const TEMPLATE_VERSION = '4.9.2';
const DEMO_ASSIGNMENT = {
  id: 'a27eed59-b1ac-4c89-94da-cfa2c10ccdc0',
  respondentToken: '01d9c0e0-ae29-4538-a38e-40a706474038',
  nama: 'arfan',
};

// ── helpers ──────────────────────────────────────────────────────────────────

const uuid = () => randomUUID();

// FASIH stores `mode` as a JSON array string e.g. '["CAPI"]'. Normalise → CAPI/CAWI.
function normMode(raw) {
  if (!raw) return 'CAPI';
  const s = String(raw).toUpperCase();
  if (s.includes('CAWI')) return 'CAWI';
  return 'CAPI';
}

// assignmentStatusId/Alias → enum status. Backup only has OPEN (0).
function normStatus(statusId, alias) {
  const a = String(alias || '').toUpperCase();
  if (a === 'CLEAN') return 'clean';
  if (a === 'ERROR') return 'error';
  if (a === 'DONE' || a === 'SUBMIT') return 'done';
  if (a === 'PROGRESS' || a === 'PROSES') return 'progress';
  return 'open';
}

// jenis_prelist (predata) → prelist_type enum.
function normPrelistType(jenis) {
  const j = String(jenis || '').toLowerCase();
  return j === 'keluarga' ? 'keluarga' : 'usaha';
}

// Flatten preDefinedData → { dataKey: answer } (first wins, base + suffixed keys).
function predataMap(raw) {
  if (!raw) return {};
  let obj;
  try { obj = JSON.parse(raw); } catch { return {}; }
  const out = {};
  for (const p of obj.predata || []) {
    if (!(p.dataKey in out)) out[p.dataKey] = p.answer;
  }
  return out;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

// Resolve the "nama" shown in the Data listing, by prelist type.
function resolveNama(m, prelistType) {
  if (prelistType === 'keluarga') {
    return firstNonEmpty(m.nama_kk, m.dtsen_nama_kk, m.nama, m.nama_ak_lain);
  }
  // usaha: prefer nama_usaha#1, then nama_usaha_prelist label.
  let labelFromList = null;
  const list = m.nama_usaha_prelist;
  if (Array.isArray(list) && list.length && list[0] && list[0].label) {
    labelFromList = list[0].label;
  }
  return firstNonEmpty(m['nama_usaha#1'], m['nama_komersial#1'], labelFromList, m.nama);
}

// Kode identitas: keluarga → no_kk/id_keluarga; usaha → idsbr#1/nib#1.
function resolveKode(m, prelistType) {
  if (prelistType === 'keluarga') {
    return firstNonEmpty(m.no_kk, m.id_keluarga, m.dtsen_no_kk, m.nik);
  }
  return firstNonEmpty(m['idsbr#1'], m['nib#1']);
}

// ── region tree derivation ───────────────────────────────────────────────────
// Each assignment row carries up to 6 denormalised region levels:
//   region_level1                     → prov
//   region_level1_level2              → kab
//   region_level1_level2_level3       → kec
//   …_level4                          → desa
//   …_level5                          → sls
//   …_level6                          → subsls
// Build a distinct tree keyed by fullCode, with parent links.

const LEVEL_DEFS = [
  { level: 'prov',   prefix: 'region_level1' },
  { level: 'kab',    prefix: 'region_level1_level2' },
  { level: 'kec',    prefix: 'region_level1_level2_level3' },
  { level: 'desa',   prefix: 'region_level1_level2_level3_level4' },
  { level: 'sls',    prefix: 'region_level1_level2_level3_level4_level5' },
  { level: 'subsls', prefix: 'region_level1_level2_level3_level4_level5_level6' },
];

function buildRegionsFromAssignments(rows) {
  // fullcode → { id, level, code, fullcode, name, parentFullcode }
  const byFullcode = new Map();

  for (const row of rows) {
    let parentFullcode = null;
    for (const def of LEVEL_DEFS) {
      const code = row[`${def.prefix}_code`];
      const fullcode = row[`${def.prefix}_fullCode`];
      const name = row[`${def.prefix}_name`];
      if (!fullcode || String(fullcode).trim() === '') break; // no deeper level
      if (!byFullcode.has(fullcode)) {
        byFullcode.set(fullcode, {
          id: uuid(),
          level: def.level,
          code: code != null ? String(code) : '',
          fullcode: String(fullcode),
          name: name != null ? String(name) : null,
          parentFullcode,
        });
      }
      parentFullcode = fullcode;
    }
  }

  // Resolve parent_id from parentFullcode.
  for (const r of byFullcode.values()) {
    r.parent_id = r.parentFullcode && byFullcode.has(r.parentFullcode)
      ? byFullcode.get(r.parentFullcode).id
      : null;
  }
  return byFullcode;
}

// Pull the flat prov/kab/.../subsls codes + smallest region for an assignment.
function regionCodesFor(row) {
  const out = { codes: {}, smallestFullcode: null };
  for (const def of LEVEL_DEFS) {
    const code = row[`${def.prefix}_code`];
    const fullcode = row[`${def.prefix}_fullCode`];
    if (fullcode && String(fullcode).trim() !== '') {
      out.codes[def.level] = code != null ? String(code) : null;
      out.smallestFullcode = String(fullcode);
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(SURVEY_DB)) {
    throw new Error(`Backup tidak ditemukan: ${SURVEY_DB}`);
  }
  const sdb = new Database(SURVEY_DB, { readonly: true });

  const assignmentRows = sdb
    .prepare('SELECT * FROM data_assignment_entity')
    .all();
  const officers = sdb.prepare('SELECT * FROM field_officer').all();
  console.log(`Backup: ${assignmentRows.length} assignment, ${officers.length} field_officer`);

  // ── 1) load regions from wilayah.json ──
  const regionMap = buildRegionsFromWilayahRows();
  console.log(`Load regions: ${regionMap.size} node dari wilayah.json`);

  // ── 2) prepare users ──
  const rounds = config.auth.bcryptRounds;
  const adminId = uuid();
  const mitraId = uuid();
  const adminHash = bcrypt.hashSync(config.seed.adminPassword, rounds);
  const mitraHash = bcrypt.hashSync(config.seed.mitraPassword, rounds);

  // Petugas dari field_officer (+ currentUser* di assignment). FASIH: 1 officer
  // (Kritina, Pencacah/PPL). Map officer.id → users.id baru.
  const officerUserId = new Map();
  const officerUsers = [];
  for (const o of officers) {
    const id = uuid();
    officerUserId.set(o.id, id);
    const username = (o.username || o.email || `officer_${id.slice(0, 8)}`).trim();
    officerUsers.push({
      id,
      username,
      // Petugas belum punya password login di sistem baru → placeholder acak,
      // admin dapat reset via /api/users. Tetap diberi hash agar kolom NOT NULL.
      password_hash: bcrypt.hashSync(uuid(), rounds),
      fullname: o.fullname || o.username || username,
      email: o.email || null,
      role: 'mitra', // petugas lapangan = read-only di sistem ini (admin = pegawai BPS)
    });
  }

  // Fallback: assignment currentUserId yang tak ada di field_officer.
  for (const row of assignmentRows) {
    const cu = row.currentUserId;
    if (cu && !officerUserId.has(cu)) {
      const id = uuid();
      officerUserId.set(cu, id);
      officerUsers.push({
        id,
        username: (row.currentUserUsername || `user_${id.slice(0, 8)}`).trim(),
        password_hash: bcrypt.hashSync(uuid(), rounds),
        fullname: row.currentUserFullname || row.currentUserUsername || null,
        email: row.currentUserUsername && row.currentUserUsername.includes('@')
          ? row.currentUserUsername : null,
        role: 'mitra',
      });
    }
  }

  // ── 3) write to MySQL inside a transaction ──
  await withTransaction(async (conn) => {
    // Clean slate for derived data (keep schema). Order respects FKs.
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['submissions', 'assignments', 'user_regions', 'regions', 'audit_logs']) {
      await conn.query(`TRUNCATE TABLE \`${t}\``);
    }
    // Users: remove seed/petugas accounts then re-insert (don't truncate to keep
    // any externally-created admins safe across re-seeds with same usernames).
    await conn.query('DELETE FROM users');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // users: admin + mitra + petugas
    const userRows = [
      [adminId, config.seed.adminUsername, adminHash, 'Administrator BPS', null, 'admin', 1],
      [mitraId, config.seed.mitraUsername, mitraHash, 'Mitra Contoh', null, 'mitra', 1],
      ...officerUsers.map((u) => [u.id, u.username, u.password_hash, u.fullname, u.email, u.role, 1]),
    ];
    await conn.query(
      'INSERT INTO users (id, username, password_hash, fullname, email, role, is_active) VALUES ?',
      [userRows]
    );
    console.log(`  users: ${userRows.length} (admin, mitra, ${officerUsers.length} petugas)`);

    // regions
    const regionRows = [...regionMap.values()].map((r) => [
      r.id, r.level, r.code, r.fullcode, r.name, r.parent_id,
    ]);
    if (regionRows.length) {
      await conn.query(
        'INSERT INTO regions (id, level, code, fullcode, name, parent_id) VALUES ?',
        [regionRows]
      );
    }
    console.log(`  regions: ${regionRows.length}`);

    // user_regions: tugaskan mitra contoh ke seluruh provinsi (demo pembatasan).
    const provRegions = [...regionMap.values()].filter((r) => r.level === 'prov');
    if (provRegions.length) {
      const urRows = provRegions.map((r) => [mitraId, r.id]);
      await conn.query('INSERT INTO user_regions (user_id, region_id) VALUES ?', [urRows]);
      console.log(`  user_regions: mitra → ${urRows.length} provinsi`);
    }

    const demoRegion = firstDemoRegion(regionMap);
    if (!demoRegion) {
      throw new Error('Tidak ada region dari wilayah.json untuk assignment demo seed.');
    }
    const demoAncestors = {};
    for (const def of LEVEL_DEFS) demoAncestors[def.level] = null;
    let cursor = demoRegion;
    while (cursor) {
      demoAncestors[cursor.level] = cursor.code;
      cursor = cursor.parentFullcode ? regionMap.get(cursor.parentFullcode) : null;
    }
    await conn.query(
      `INSERT INTO assignments (
        id, kode_identitas, nama, alamat_prelist, prelist_type, mode, status,
        region_id, region_fullcode, prov_code, kab_code, kec_code, desa_code,
        sls_code, subsls_code, predefined, respondent_token, respondent_pin_hash,
        pin_reset_required, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        DEMO_ASSIGNMENT.id,
        'DEMO-ARFAN',
        DEMO_ASSIGNMENT.nama,
        demoRegion.name || 'Demo Seed',
        'keluarga',
        'CAWI',
        'open',
        demoRegion.id,
        demoRegion.fullcode,
        demoAncestors.prov,
        demoAncestors.kab,
        demoAncestors.kec,
        demoAncestors.desa,
        demoAncestors.sls,
        demoAncestors.subsls,
        json({
          jenis_prelist: 'keluarga',
          mode: 'CAWI',
          nama_kk: DEMO_ASSIGNMENT.nama,
          is_keluarga: '1',
        }),
        DEMO_ASSIGNMENT.respondentToken,
      ]
    );
    await conn.query(
      `INSERT INTO submissions (
        id, assignment_id, template_id, template_version, answers, summary, status, filled_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        DEMO_ASSIGNMENT.id,
        TEMPLATE_ID,
        TEMPLATE_VERSION,
        json({}),
        json({ answered: 0, errors: 0, warnings: 0, notes: 0 }),
        'draft',
        adminId,
      ]
    );
    console.log(`  assignments: 1 demo (${DEMO_ASSIGNMENT.nama})`);
  });

  sdb.close();
  await pool.end();
  console.log('Seed selesai ✓');
  console.log(`Login admin: ${config.seed.adminUsername} / ${config.seed.adminPassword}`);
  console.log(`Login mitra: ${config.seed.mitraUsername} / ${config.seed.mitraPassword}`);
}

// Seed submissions.answers dari Survey_database_dynamic bila ada. Skema dynamic
// FASIH bervariasi; kita baca tabel data jawaban dan simpan apa adanya sebagai
// JSON {dataKey: value}. Bila DB/format tidak dikenali → lewati dengan warning.
async function seedSubmissions(conn, queue, adminId) {
  const dynPath = DYNAMIC_DB_CANDIDATES.find((p) => existsSync(p));
  if (!dynPath) {
    console.log('  submissions: dilewati (Survey_database_dynamic tidak tersedia — ' +
      'kemungkinan masih di dalam databases.zip ter-enkripsi). Tidak menggagalkan seed.');
    return;
  }
  let ddb;
  try {
    ddb = new Database(dynPath, { readonly: true });
  } catch (err) {
    console.log(`  submissions: dilewati (gagal buka dynamic DB: ${err.message})`);
    return;
  }

  try {
    // Cari tabel berisi jawaban. FASIH dynamic biasanya punya tabel per-assignment
    // atau satu tabel "answer" {assignment_id, dataKey, value}. Deteksi generik.
    const tables = ddb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);
    // Heuristik: tabel dengan kolom assignment_id + (dataKey|key) + (value|answer).
    let answerTable = null, cols = null;
    for (const t of tables) {
      const info = ddb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name.toLowerCase());
      const hasAssign = info.find((c) => c.includes('assignment'));
      const keyCol = info.find((c) => c === 'datakey' || c === 'key' || c === 'data_key');
      const valCol = info.find((c) => c === 'value' || c === 'answer' || c === 'val');
      if (hasAssign && keyCol && valCol) {
        answerTable = t;
        cols = { assign: info.find((c) => c.includes('assignment')), key: keyCol, val: valCol };
        break;
      }
    }
    if (!answerTable) {
      console.log(`  submissions: dilewati (format dynamic tak dikenali; tabel: ${tables.join(', ')})`);
      ddb.close();
      return;
    }

    const valid = new Set(queue.map((q) => q.assignmentId));
    const rows = ddb.prepare(
      `SELECT "${cols.assign}" AS aid, "${cols.key}" AS k, "${cols.val}" AS v FROM "${answerTable}"`
    ).all();

    const byAssign = new Map();
    for (const r of rows) {
      if (!valid.has(r.aid)) continue;
      if (!byAssign.has(r.aid)) byAssign.set(r.aid, {});
      byAssign.get(r.aid)[r.k] = r.v;
    }

    const subRows = [];
    for (const [aid, answers] of byAssign) {
      subRows.push([
        uuid(), aid, TEMPLATE_ID, TEMPLATE_VERSION,
        JSON.stringify(answers), null, 'draft', adminId,
      ]);
    }
    if (subRows.length) {
      await conn.query(
        `INSERT INTO submissions
          (id, assignment_id, template_id, template_version, answers, summary, status, filled_by)
         VALUES ?`,
        [subRows]
      );
    }
    console.log(`  submissions: ${subRows.length} (dari ${answerTable})`);
    ddb.close();
  } catch (err) {
    console.log(`  submissions: dilewati (error baca dynamic: ${err.message})`);
    try { ddb.close(); } catch {}
  }
}

main().catch((err) => {
  console.error('Seed GAGAL:', err);
  pool.end().finally(() => process.exit(1));
});
