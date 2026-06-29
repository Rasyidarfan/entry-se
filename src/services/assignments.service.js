// Assignment domain logic (§5.4, §5.6). Listing + filters + paging, plus the
// mitra region restriction (§6). Shared by REST + (future) MCP.

import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db.js';
import { ApiError } from '../middleware/errors.js';
import { getUserRegionPrefixes } from './users.service.js';

const LIST_COLS = `
  a.id, a.kode_identitas, a.nama, a.alamat_prelist, a.nomor_urut_bangunan,
  a.idsbr, a.nib, a.email, a.prelist_type, a.mode, a.status,
  a.region_fullcode, a.prov_code, a.kab_code, a.kec_code, a.desa_code,
  a.sls_code, a.subsls_code, a.sample_type, a.pengawas_id, a.pencacah_id`;

// Build WHERE clause + params from filter query + the requesting user.
async function buildFilter(q, user) {
  const where = [];
  const params = [];

  // Cascading region filter — match against the flat code columns.
  const codeMap = {
    prov: 'a.prov_code', kab: 'a.kab_code', kec: 'a.kec_code',
    desa: 'a.desa_code', sls: 'a.sls_code', subsls: 'a.subsls_code',
  };
  for (const [key, col] of Object.entries(codeMap)) {
    if (q[key]) { where.push(`${col} = ?`); params.push(String(q[key])); }
  }

  if (q.status) { where.push('a.status = ?'); params.push(q.status); }
  if (q.mode) { where.push('a.mode = ?'); params.push(q.mode); }
  if (q.type === 'target' || q.prelist_type) {
    // "Tipe: Target" in the UI maps to prelist target rows; keep flexible.
    if (q.prelist_type) { where.push('a.prelist_type = ?'); params.push(q.prelist_type); }
  }
  if (q.sample_type) { where.push('a.sample_type = ?'); params.push(q.sample_type); }
  if (q.pengawas) { where.push('a.pengawas_id = ?'); params.push(q.pengawas); }
  if (q.pencacah) { where.push('a.pencacah_id = ?'); params.push(q.pencacah); }

  if (q.q) {
    where.push('(a.nama LIKE ? OR a.kode_identitas LIKE ? OR a.idsbr LIKE ? OR a.nib LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like, like);
  }

  // Mitra region restriction: only rows whose region_fullcode begins with one of
  // the assigned region prefixes. Admin sees everything.
  if (user && user.role === 'mitra') {
    const prefixes = await getUserRegionPrefixes(user.id);
    if (!prefixes.length) {
      where.push('1 = 0'); // assigned to nothing → sees nothing
    } else {
      const ors = prefixes.map(() => 'a.region_fullcode LIKE ?');
      where.push(`(${ors.join(' OR ')})`);
      for (const p of prefixes) params.push(`${p}%`);
    }
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SORTABLE = new Set([
  'kode_identitas', 'nama', 'alamat_prelist', 'status', 'mode', 'prelist_type', 'created_at',
]);

export async function listAssignments(q = {}, user = null) {
  const { whereSql, params } = await buildFilter(q, user);

  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const sortCol = SORTABLE.has(q.sort) ? q.sort : 'kode_identitas';
  const order = String(q.order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  // Page of rows + submission status via LEFT JOIN.
  const rows = await query(
    `SELECT ${LIST_COLS}, s.status AS submission_status
       FROM assignments a
       LEFT JOIN submissions s ON s.assignment_id = a.id
       ${whereSql}
       ORDER BY a.${sortCol} ${order}
       LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const totalRow = await queryOne(
    `SELECT COUNT(*) AS total FROM assignments a ${whereSql}`, params
  );
  const total = totalRow ? Number(totalRow.total) : 0;

  // Status counts for the badge chips (within the same filter, ignoring status).
  const counts = await statusCounts(q, user);

  return { data: rows, total, page, limit, counts };
}

// Counts per status (and 'all') under the current filter, excluding the status
// filter itself so the chips show the full breakdown.
async function statusCounts(q, user) {
  const q2 = { ...q };
  delete q2.status;
  const { whereSql, params } = await buildFilter(q2, user);
  const rows = await query(
    `SELECT a.status, COUNT(*) AS c FROM assignments a ${whereSql} GROUP BY a.status`,
    params
  );
  const counts = { all: 0 };
  for (const r of rows) {
    counts[r.status] = Number(r.c);
    counts.all += Number(r.c);
  }
  return counts;
}

// Normalise the predefined column into a flat { dataKey: value } object.
// Accepts: (a) already-flat object, (b) FASIH shape { predata: [{dataKey,answer}] }.
function normalizePredefined(raw) {
  if (raw == null) return {};
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (Array.isArray(obj.predata)) {
    const out = {};
    for (const p of obj.predata) {
      if (p && p.dataKey && !(p.dataKey in out)) out[p.dataKey] = p.answer;
    }
    return out;
  }
  return (obj && typeof obj === 'object') ? obj : {};
}

export async function getAssignment(id, user = null) {
  const a = await queryOne(
    `SELECT a.*, s.status AS submission_status
       FROM assignments a
       LEFT JOIN submissions s ON s.assignment_id = a.id
      WHERE a.id = ?`,
    [id]
  );
  if (!a) throw ApiError.notFound('Assignment tidak ditemukan.');
  // Enforce mitra region restriction on detail access too.
  if (user && user.role === 'mitra') {
    const prefixes = await getUserRegionPrefixes(user.id);
    const allowed = prefixes.some((p) => (a.region_fullcode || '').startsWith(p));
    if (!allowed) throw ApiError.forbidden('Assignment di luar wilayah Anda.');
  }
  // Expose predefined as a flat map the form engine can seed directly.
  a.predefined = normalizePredefined(a.predefined);
  return a;
}

const EDITABLE = [
  'kode_identitas', 'nama', 'alamat_prelist', 'nomor_urut_bangunan', 'idsbr',
  'nib', 'email', 'prelist_type', 'mode', 'status', 'sample_type',
  'pengawas_id', 'pencacah_id',
];

// Walk up the region tree from a fullcode → { regionId, codes, names } where
// codes = {prov_code,...} and names = {prov,kab,kec,desa,sls,...} by level.
async function deriveRegion(fullcode) {
  const codes = {};
  const byLevel = {}; // level → {code, name}
  let cur = await queryOne(
    'SELECT id, level, code, name, parent_id FROM regions WHERE fullcode = ?', [fullcode]);
  let guard = 0;
  const regionId = cur ? cur.id : null;
  while (cur && guard++ < 10) {
    codes[`${cur.level}_code`] = cur.code;
    byLevel[cur.level] = { code: cur.code, name: cur.name };
    cur = cur.parent_id
      ? await queryOne('SELECT id, level, code, name, parent_id FROM regions WHERE id = ?', [cur.parent_id])
      : null;
  }
  return { regionId, codes, byLevel };
}

// Build the form's predefined (locked prelist) object from an admin's inputs.
// Mirrors the dataKeys the FormGear template expects for region + family/usaha.
function buildPredefined(data, byLevel) {
  const fmt = (lvl) => byLevel[lvl] ? `[${byLevel[lvl].code}] ${byLevel[lvl].name || ''}`.trim() : null;
  const pre = {
    mode: data.mode || 'CAPI',
    is_prelist: '1',
    jenis_prelist: data.prelist_type === 'keluarga' ? 'keluarga' : 'UMKM',
    is_keluarga: data.prelist_type === 'keluarga' ? '1' : null,
    is_usaha: data.prelist_type === 'usaha' ? '1' : null,
    // Region (locked, diisi BPS)
    prov: fmt('prov'),
    kab: fmt('kab'),
    kec: fmt('kec'),
    desa: fmt('desa'),
    kode_sls: byLevel.sls ? byLevel.sls.code : (byLevel.subsls ? byLevel.subsls.code : null),
    nama_sls: byLevel.sls ? byLevel.sls.name : (byLevel.subsls ? byLevel.subsls.name : null),
  };
  // Identity by type.
  if (data.prelist_type === 'keluarga') {
    pre.nama_kk = data.nama || null;
    if (data.kode_identitas) pre.no_kk = data.kode_identitas;
  } else {
    pre['nama_usaha#1'] = data.nama || null;
    if (data.kode_identitas) pre['idsbr#1'] = data.kode_identitas;
  }
  // Drop nulls so locked-keys only cover fields we actually set.
  for (const k of Object.keys(pre)) if (pre[k] == null) delete pre[k];
  return pre;
}

export async function createAssignment(data) {
  if (!data.region_fullcode) throw ApiError.badRequest('region_fullcode wajib.');
  if (!data.nama) throw ApiError.badRequest('nama wajib.');
  const id = data.id || randomUUID();
  // Resolve region_id + flat codes (prov..subsls) + names from the region tree.
  const { regionId, codes, byLevel } = await deriveRegion(data.region_fullcode);

  // Per-assignment predefined: caller-supplied, or derived from the inputs so the
  // form opens pre-filled with THIS assignment's prelist (locked) — not a sample.
  const predefined = data.predefined || buildPredefined(data, byLevel);

  const cols = ['id', 'region_fullcode', 'region_id', 'predefined'];
  const vals = [id, data.region_fullcode, regionId, JSON.stringify(predefined)];
  for (const f of EDITABLE) {
    if (data[f] !== undefined) { cols.push(f); vals.push(data[f]); }
  }
  // Prefer derived codes; allow explicit override if caller passed them.
  for (const c of ['prov_code', 'kab_code', 'kec_code', 'desa_code', 'sls_code', 'subsls_code']) {
    const v = data[c] !== undefined ? data[c] : (codes[c] !== undefined ? codes[c] : undefined);
    if (v !== undefined) { cols.push(c); vals.push(v); }
  }
  await query(
    `INSERT INTO assignments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    vals
  );
  return getAssignment(id);
}

export async function updateAssignment(id, data) {
  await getAssignment(id);
  const sets = [];
  const params = [];
  for (const f of EDITABLE) {
    if (data[f] !== undefined) { sets.push(`${f} = ?`); params.push(data[f]); }
  }
  if (data.predefined !== undefined) { sets.push('predefined = ?'); params.push(JSON.stringify(data.predefined)); }
  if (!sets.length) return getAssignment(id);
  params.push(id);
  await query(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ?`, params);
  return getAssignment(id);
}

export async function deleteAssignment(id) {
  await getAssignment(id);
  await query('DELETE FROM assignments WHERE id = ?', [id]); // cascades submission
}

// Bulk import (§5.4 import). items: array of assignment objects.
export async function importAssignments(items = []) {
  if (!Array.isArray(items) || !items.length) throw ApiError.badRequest('items kosong.');
  let created = 0;
  for (const item of items) {
    await createAssignment(item);
    created++;
  }
  return { created };
}
