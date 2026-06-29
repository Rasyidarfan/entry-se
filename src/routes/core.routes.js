import express from '../tiny-express.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'node:crypto';
import config from '../config.js';
import { query, queryOne } from '../db.js';
import { generateQrDataUrl } from '../services/qr.service.js';

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function json(v) {
  return JSON.stringify(v ?? null);
}

function parseObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildAssignmentLink(req, token) {
  return `${req.protocol}://${req.get('host')}/respondent?v=10&access=${encodeURIComponent(token)}`;
}

function maskUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullname: user.fullname,
    email: user.email,
    role: user.role,
    is_active: !!user.is_active,
  };
}

function signUserToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, kind: 'user' },
    config.auth.jwtSecret,
    { expiresIn: '30m' }
  );
}

function signRespondentToken(assignment) {
  const fingerprint = createHash('sha1')
    .update(`${assignment.id}:${assignment.respondent_token}:${assignment.updated_at || ''}`)
    .digest('hex');
  return jwt.sign(
    {
      sub: assignment.id,
      kind: 'respondent',
      access: assignment.respondent_token,
      fp: fingerprint,
    },
    config.auth.jwtSecret,
    { expiresIn: '30m' }
  );
}

function verifyBearer(req) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) throw httpError(401, 'AUTH_REQUIRED', 'Token tidak ditemukan.');
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch {
    throw httpError(401, 'AUTH_INVALID', 'Sesi tidak valid atau sudah kedaluwarsa.');
  }
}

async function requireUser(req, _res, next) {
  try {
    const decoded = verifyBearer(req);
    if (decoded.kind !== 'user') throw httpError(401, 'AUTH_INVALID', 'Jenis sesi tidak sesuai.');
    const user = await queryOne('SELECT * FROM users WHERE id = ? AND is_active = 1', [decoded.sub]);
    if (!user) throw httpError(401, 'AUTH_INVALID', 'Pengguna tidak aktif.');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(httpError(403, 'FORBIDDEN', 'Hanya admin yang diizinkan.'));
  }
  next();
}

async function requireRespondent(req, _res, next) {
  try {
    const decoded = verifyBearer(req);
    if (decoded.kind !== 'respondent') throw httpError(401, 'AUTH_INVALID', 'Jenis sesi tidak sesuai.');
    const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [decoded.sub]);
    if (!assignment || assignment.respondent_token !== decoded.access) {
      throw httpError(401, 'AUTH_INVALID', 'Akses responden tidak valid.');
    }
    req.respondent = { decoded, assignment };
    next();
  } catch (err) {
    next(err);
  }
}

function validatePin(pin) {
  return /^\d{6}$/.test(String(pin || ''));
}

async function insertAudit(userId, action, entity, entityId, diff) {
  await query(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, diff) VALUES (?, ?, ?, ?, ?)',
    [userId || null, action, entity || null, entityId || null, json(diff || null)]
  );
}

async function getRegionByFullcode(fullcode) {
  const region = await queryOne('SELECT * FROM regions WHERE fullcode = ?', [fullcode]);
  if (!region) throw httpError(400, 'REGION_NOT_FOUND', 'Wilayah tidak ditemukan.');
  return region;
}

async function getRegionAncestors(fullcode) {
  const rows = await query('SELECT level, code, fullcode, name FROM regions ORDER BY LENGTH(fullcode)');
  const map = new Map(rows.map((row) => [row.fullcode, row]));
  const values = { prov: null, kab: null, kec: null, desa: null, sls: null, subsls: null };
  for (const row of rows) {
    if (fullcode.startsWith(row.fullcode)) values[row.level] = row.code;
  }
  return { map, values };
}

function buildAssignmentPredefined({ prelistType, mode, ancestors, base = {} }) {
  const fmt = (level) => {
    const code = ancestors.values[level];
    const row = [...ancestors.map.values()].find((item) => item.level === level && item.code === code);
    if (!code || !row?.name) return null;
    return `[${code}] ${row.name}`;
  };
  const slsCode = ancestors.values.sls || ancestors.values.subsls || null;
  const slsRow = [...ancestors.map.values()].find((item) => (
    (item.level === 'sls' || item.level === 'subsls') && item.code === slsCode
  ));
  const predefined = {
    ...base,
    mode: mode === 'CAPI' ? 'CAPI' : 'CAWI',
    is_prelist: '1',
    jenis_prelist: prelistType === 'usaha' ? 'usaha' : 'keluarga',
    is_keluarga: prelistType === 'keluarga' ? '1' : null,
    is_usaha: prelistType === 'usaha' ? '1' : null,
    prov: fmt('prov'),
    kab: fmt('kab'),
    kec: fmt('kec'),
    desa: fmt('desa'),
    kode_sls: slsCode,
    nama_sls: slsRow?.name || null,
    kodepos: base.kodepos || null,
    nama_kk: prelistType === 'keluarga' ? (base.nama_kk || base.nama || null) : (base.nama_kk || null),
    no_kk: prelistType === 'keluarga' ? (base.no_kk || base.kode_identitas || null) : (base.no_kk || null),
  };
  if (predefined.is_keluarga == null) delete predefined.is_keluarga;
  if (predefined.is_usaha == null) delete predefined.is_usaha;
  for (const key of ['prov', 'kab', 'kec', 'desa', 'kode_sls', 'nama_sls', 'kodepos']) {
    if (predefined[key] == null) delete predefined[key];
  }
  return predefined;
}

async function respondentPredefined(row) {
  const base = parseObject(row.predefined, {});
  if (!row?.region_fullcode) return base;
  const ancestors = await getRegionAncestors(row.region_fullcode);
  return buildAssignmentPredefined({
    prelistType: row.prelist_type,
    mode: row.mode,
    ancestors,
    base,
  });
}

async function ensureSubmission(assignmentId) {
  let submission = await queryOne('SELECT * FROM submissions WHERE assignment_id = ?', [assignmentId]);
  if (!submission) {
    const id = randomUUID();
    await query(
      'INSERT INTO submissions (id, assignment_id, answers, summary, status) VALUES (?, ?, ?, ?, ?)',
      [id, assignmentId, json({}), json({ answered: 0, errors: 0, warnings: 0 }), 'draft']
    );
    submission = await queryOne('SELECT * FROM submissions WHERE assignment_id = ?', [assignmentId]);
  }
  return {
    ...submission,
    answers: parseObject(submission.answers, {}),
    summary: parseObject(submission.summary, {}),
  };
}

function computeSummary(answers) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.reduce((n, item) => n + walk(item), 0);
    if (value && typeof value === 'object') return Object.values(value).reduce((n, item) => n + walk(item), 0);
    return value === '' || value == null ? 0 : 1;
  };
  return { answered: walk(answers), errors: 0, warnings: 0, notes: 0 };
}

async function getVisibleAssignmentsFor(user) {
  const rows = await query('SELECT * FROM assignments ORDER BY updated_at DESC, created_at DESC');
  if (user.role === 'admin') return rows;
  const regions = await query(
    `SELECT r.fullcode
       FROM user_regions ur
       JOIN regions r ON r.id = ur.region_id
      WHERE ur.user_id = ?`,
    [user.id]
  );
  const scopes = regions.map((row) => row.fullcode);
  return rows.filter((row) => scopes.some((scope) => String(row.region_fullcode || '').startsWith(scope)));
}

function serialiseAssignment(req, row) {
  const predefined = parseObject(row.predefined, {});
  const respondent_token = row.respondent_token || randomUUID();
  const link = buildAssignmentLink(req, respondent_token);
  return {
    ...row,
    predefined,
    respondent_token,
    respondent_link: link,
    qr_url: generateQrDataUrl(link),
    pin_is_set: !!row.respondent_pin_hash && !row.pin_reset_required,
  };
}

router.post('/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await queryOne('SELECT * FROM users WHERE username = ? LIMIT 1', [String(username || '').trim()]);
  if (!user || !user.is_active) throw httpError(401, 'LOGIN_FAILED', 'Username atau password salah.');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw httpError(401, 'LOGIN_FAILED', 'Username atau password salah.');
  const token = signUserToken(user);
  res.json({ token, user: maskUser(user) });
}));

router.post('/auth/logout', (_req, res) => {
  res.json({ ok: true });
});

router.get('/users', requireUser, requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query('SELECT * FROM users ORDER BY username');
  res.json({ data: rows.map(maskUser) });
}));

router.post('/users', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, fullname, email, role } = req.body || {};
  if (!String(username || '').trim()) throw httpError(400, 'USERNAME_REQUIRED', 'Username wajib diisi.');
  if (!String(password || '')) throw httpError(400, 'PASSWORD_REQUIRED', 'Password wajib diisi.');
  const exists = await queryOne('SELECT id FROM users WHERE username = ?', [String(username).trim()]);
  if (exists) throw httpError(409, 'USERNAME_EXISTS', 'Username sudah digunakan.');
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, username, password_hash, fullname, email, role, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, String(username).trim(), await bcrypt.hash(String(password), config.auth.bcryptRounds), fullname || null, email || null, role === 'admin' ? 'admin' : 'mitra']
  );
  await insertAudit(req.user.id, 'create_user', 'user', id, { username, role });
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
  res.status(201).json({ user: maskUser(user) });
}));

router.patch('/users/:id', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const current = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!current) throw httpError(404, 'USER_NOT_FOUND', 'User tidak ditemukan.');
  const body = req.body || {};
  const password_hash = body.password
    ? await bcrypt.hash(String(body.password), config.auth.bcryptRounds)
    : current.password_hash;
  await query(
    `UPDATE users
        SET fullname = ?, email = ?, role = ?, is_active = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      body.fullname ?? current.fullname ?? null,
      body.email ?? current.email ?? null,
      body.role === 'admin' ? 'admin' : 'mitra',
      body.is_active === false ? 0 : 1,
      password_hash,
      req.params.id,
    ]
  );
  await insertAudit(req.user.id, 'update_user', 'user', req.params.id, body);
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  res.json({ user: maskUser(user) });
}));

router.delete('/users/:id', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  await query('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
  await insertAudit(req.user.id, 'deactivate_user', 'user', req.params.id, null);
  res.json({ ok: true });
}));

router.get('/users/:id/regions', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const assigned = await query(
    `SELECT r.id, r.level, r.code, r.fullcode, r.name
       FROM user_regions ur
       JOIN regions r ON r.id = ur.region_id
      WHERE ur.user_id = ?
      ORDER BY LENGTH(r.fullcode), r.fullcode`,
    [req.params.id]
  );
  res.json({ data: assigned });
}));

router.put('/users/:id/regions', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const regionIds = Array.isArray(req.body?.region_ids) ? req.body.region_ids : [];
  await query('DELETE FROM user_regions WHERE user_id = ?', [req.params.id]);
  for (const regionId of regionIds) {
    await query('INSERT INTO user_regions (user_id, region_id) VALUES (?, ?)', [req.params.id, regionId]);
  }
  await insertAudit(req.user.id, 'assign_user_regions', 'user', req.params.id, { region_ids: regionIds });
  res.json({ ok: true, count: regionIds.length });
}));

router.get('/regions', requireUser, asyncHandler(async (req, res) => {
  const level = req.query.level ? String(req.query.level) : null;
  const parent = req.query.parent ? String(req.query.parent) : null;
  let sql = 'SELECT * FROM regions';
  const params = [];
  if (level && parent) {
    sql += ' WHERE level = ? AND parent_id = (SELECT id FROM regions WHERE fullcode = ? LIMIT 1)';
    params.push(level, parent);
  } else if (level) {
    sql += ' WHERE level = ?';
    params.push(level);
  }
  sql += ' ORDER BY code';
  res.json({ data: await query(sql, params) });
}));

router.get('/regions/tree', requireUser, requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query('SELECT * FROM regions ORDER BY LENGTH(fullcode), code');
  const map = new Map();
  for (const row of rows) {
    map.set(row.id, { ...row, children: [] });
  }
  const roots = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) map.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  res.json({ data: roots });
}));

router.get('/assignments', requireUser, asyncHandler(async (req, res) => {
  let rows = await getVisibleAssignmentsFor(req.user);
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();
  const type = String(req.query.prelist_type || '').trim();
  const regionKeys = ['prov', 'kab', 'kec', 'desa', 'sls', 'subsls'];
  if (status) rows = rows.filter((row) => row.status === status);
  if (type) rows = rows.filter((row) => row.prelist_type === type);
  if (q) {
    rows = rows.filter((row) => [row.nama, row.kode_identitas, row.alamat_prelist].some((value) =>
      String(value || '').toLowerCase().includes(q)));
  }
  for (const key of regionKeys) {
    const expected = String(req.query[key] || '').trim();
    if (expected) rows = rows.filter((row) => String(row[`${key}_code`] || '') === expected);
  }
  const total = rows.length;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
  const start = (page - 1) * limit;
  const slice = rows.slice(start, start + limit);
  const data = [];
  for (const row of slice) {
    const submission = await queryOne('SELECT status FROM submissions WHERE assignment_id = ?', [row.id]);
    data.push({ ...row, submission_status: submission?.status || null });
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  res.json({ data, total, page, limit, counts });
}));

router.post('/assignments', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const assignmentName = String(body.nama || '').trim();
  if (!assignmentName) {
    const what = body.prelist_type === 'usaha' ? 'Nama bangunan/usaha' : 'Nama kepala keluarga';
    throw httpError(400, 'NAME_REQUIRED', `${what} wajib diisi.`);
  }
  if (!String(body.region_fullcode || '').trim()) throw httpError(400, 'REGION_REQUIRED', 'Wilayah wajib dipilih.');
  const region = await getRegionByFullcode(String(body.region_fullcode));
  const ancestors = await getRegionAncestors(region.fullcode);
  const id = randomUUID();
  const respondentToken = randomUUID();
  const predefined = buildAssignmentPredefined({
    prelistType: body.prelist_type === 'usaha' ? 'usaha' : 'keluarga',
    mode: body.mode === 'CAPI' ? 'CAPI' : 'CAWI',
    ancestors,
    base: {
      ...(body.predefined || {}),
      nama_kk: assignmentName || null,
      nama: assignmentName || null,
      no_kk: body.kode_identitas || null,
      kode_identitas: body.kode_identitas || null,
    },
  });
  await query(
    `INSERT INTO assignments (
      id, kode_identitas, nama, alamat_prelist, nomor_urut_bangunan, idsbr, nib, email,
      prelist_type, mode, status, region_id, region_fullcode, prov_code, kab_code, kec_code,
      desa_code, sls_code, subsls_code, predefined, respondent_token, respondent_pin_hash,
      pin_reset_required, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      body.kode_identitas || null,
      assignmentName,
      body.alamat_prelist || null,
      body.nomor_urut_bangunan || null,
      body.idsbr || null,
      body.nib || null,
      body.email || null,
      body.prelist_type === 'usaha' ? 'usaha' : 'keluarga',
      body.mode === 'CAPI' ? 'CAPI' : 'CAWI',
      'open',
      region.id,
      region.fullcode,
      ancestors.values.prov,
      ancestors.values.kab,
      ancestors.values.kec,
      ancestors.values.desa,
      ancestors.values.sls,
      ancestors.values.subsls,
      json(predefined),
      respondentToken,
    ]
  );
  await insertAudit(req.user.id, 'create_assignment', 'assignment', id, body);
  const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [id]);
  res.status(201).json({ assignment: serialiseAssignment(req, assignment) });
}));

router.patch('/assignments/:id', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const current = await queryOne('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
  if (!current) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  const body = req.body || {};
  const targetFullcode = String(body.region_fullcode || current.region_fullcode || '').trim();
  if (!targetFullcode) throw httpError(400, 'REGION_REQUIRED', 'Wilayah wajib dipilih.');
  const region = await getRegionByFullcode(targetFullcode);
  const ancestors = await getRegionAncestors(region.fullcode);
  const currentPredefined = parseObject(current.predefined, {});
  const predefined = buildAssignmentPredefined({
    prelistType: body.prelist_type === 'usaha' ? 'usaha' : (body.prelist_type === 'keluarga' ? 'keluarga' : current.prelist_type),
    mode: body.mode === 'CAPI' ? 'CAPI' : (body.mode === 'CAWI' ? 'CAWI' : current.mode),
    ancestors,
    base: {
      ...currentPredefined,
      ...(body.predefined || {}),
      nama_kk: body.nama ?? current.nama ?? currentPredefined.nama_kk ?? null,
      nama: body.nama ?? current.nama ?? null,
      no_kk: body.kode_identitas ?? current.kode_identitas ?? currentPredefined.no_kk ?? null,
      kode_identitas: body.kode_identitas ?? current.kode_identitas ?? null,
    },
  });
  await query(
    `UPDATE assignments
        SET kode_identitas = ?, nama = ?, alamat_prelist = ?, nomor_urut_bangunan = ?, idsbr = ?, nib = ?, email = ?,
            prelist_type = ?, mode = ?, region_id = ?, region_fullcode = ?, prov_code = ?, kab_code = ?, kec_code = ?,
            desa_code = ?, sls_code = ?, subsls_code = ?, predefined = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      body.kode_identitas ?? current.kode_identitas ?? null,
      body.nama ? String(body.nama).trim() : current.nama,
      body.alamat_prelist ?? current.alamat_prelist ?? null,
      body.nomor_urut_bangunan ?? current.nomor_urut_bangunan ?? null,
      body.idsbr ?? current.idsbr ?? null,
      body.nib ?? current.nib ?? null,
      body.email ?? current.email ?? null,
      body.prelist_type === 'usaha' ? 'usaha' : (body.prelist_type === 'keluarga' ? 'keluarga' : current.prelist_type),
      body.mode === 'CAPI' ? 'CAPI' : (body.mode === 'CAWI' ? 'CAWI' : current.mode),
      region.id,
      region.fullcode,
      ancestors.values.prov,
      ancestors.values.kab,
      ancestors.values.kec,
      ancestors.values.desa,
      ancestors.values.sls,
      ancestors.values.subsls,
      json(predefined),
      req.params.id,
    ]
  );
  await insertAudit(req.user.id, 'update_assignment', 'assignment', req.params.id, body);
  const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
  res.json({ assignment: serialiseAssignment(req, assignment) });
}));

router.delete('/assignments/:id', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const current = await queryOne('SELECT id FROM assignments WHERE id = ?', [req.params.id]);
  if (!current) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  await query('DELETE FROM assignments WHERE id = ?', [req.params.id]);
  await insertAudit(req.user.id, 'delete_assignment', 'assignment', req.params.id, null);
  res.json({ ok: true });
}));

router.get('/assignments/:id', requireUser, asyncHandler(async (req, res) => {
  const rows = await getVisibleAssignmentsFor(req.user);
  const assignment = rows.find((row) => row.id === req.params.id);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  res.json({ assignment: serialiseAssignment(req, assignment) });
}));

router.get('/assignments/:id/access', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  const payload = serialiseAssignment(req, assignment);
  res.json({
    assignment: payload,
    print: {
      title: 'Struk Akses Responden',
      width_mm: 50,
      instructions: 'Buka tautan atau pindai QR, lalu buat PIN 6 digit saat pertama kali masuk.',
    },
  });
}));

router.post('/assignments/:id/reset-pin', requireUser, requireAdmin, asyncHandler(async (req, res) => {
  const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  await query(
    'UPDATE assignments SET respondent_pin_hash = NULL, pin_reset_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [req.params.id]
  );
  await insertAudit(req.user.id, 'reset_pin', 'assignment', req.params.id, null);
  res.json({ ok: true });
}));

router.get('/assignments/:id/submission', requireUser, asyncHandler(async (req, res) => {
  const rows = await getVisibleAssignmentsFor(req.user);
  const assignment = rows.find((row) => row.id === req.params.id);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  const submission = await ensureSubmission(req.params.id);
  res.json({ submission });
}));

router.put('/assignments/:id/submission', requireUser, asyncHandler(async (req, res) => {
  const rows = await getVisibleAssignmentsFor(req.user);
  const assignment = rows.find((row) => row.id === req.params.id);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  if (req.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', 'Mode ini hanya untuk admin.');
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const status = req.body?.status === 'submitted' ? 'submitted' : 'draft';
  const summary = computeSummary(answers);
  const submission = await ensureSubmission(req.params.id);
  await query(
    `UPDATE submissions
        SET answers = ?, summary = ?, status = ?, filled_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [json(answers), json(summary), status, req.user.id, submission.id]
  );
  await query(
    'UPDATE assignments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status === 'submitted' ? 'done' : 'progress', req.params.id]
  );
  await insertAudit(req.user.id, 'save_submission', 'submission', submission.id, { status });
  res.json({ status, summary });
}));

router.post('/respondent/session/init', asyncHandler(async (req, res) => {
  const { access, pin } = req.body || {};
  const assignment = await queryOne('SELECT * FROM assignments WHERE respondent_token = ?', [String(access || '').trim()]);
  if (!assignment) throw httpError(404, 'ACCESS_NOT_FOUND', 'Tautan responden tidak ditemukan.');
  if (assignment.respondent_pin_hash && !assignment.pin_reset_required) {
    throw httpError(409, 'PIN_ALREADY_SET', 'PIN sudah dibuat. Silakan masuk menggunakan PIN.');
  }
  if (!validatePin(pin)) throw httpError(400, 'PIN_INVALID', 'PIN harus terdiri dari 6 digit angka.');
  const hash = await bcrypt.hash(String(pin), config.auth.bcryptRounds);
  await query(
    'UPDATE assignments SET respondent_pin_hash = ?, pin_reset_required = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [hash, assignment.id]
  );
  await insertAudit(null, 'respondent_set_pin', 'assignment', assignment.id, null);
  const fresh = await queryOne('SELECT * FROM assignments WHERE id = ?', [assignment.id]);
  const submission = await ensureSubmission(assignment.id);
  res.json({
    token: signRespondentToken(fresh),
    assignment: {
      id: fresh.id,
      nama: fresh.nama,
      prelist_type: fresh.prelist_type,
      mode: fresh.mode,
      predefined: await respondentPredefined(fresh),
    },
    submission,
  });
}));

router.post('/respondent/session/login', asyncHandler(async (req, res) => {
  const { access, pin } = req.body || {};
  const assignment = await queryOne('SELECT * FROM assignments WHERE respondent_token = ?', [String(access || '').trim()]);
  if (!assignment) throw httpError(404, 'ACCESS_NOT_FOUND', 'Tautan responden tidak ditemukan.');
  if (!assignment.respondent_pin_hash || assignment.pin_reset_required) {
    throw httpError(409, 'PIN_NOT_SET', 'PIN belum aktif. Silakan buat PIN baru.');
  }
  const ok = await bcrypt.compare(String(pin || ''), assignment.respondent_pin_hash);
  if (!ok) throw httpError(401, 'PIN_WRONG', 'PIN yang Anda masukkan salah.');
  const submission = await ensureSubmission(assignment.id);
  res.json({
    token: signRespondentToken(assignment),
    assignment: {
      id: assignment.id,
      nama: assignment.nama,
      prelist_type: assignment.prelist_type,
      mode: assignment.mode,
      predefined: await respondentPredefined(assignment),
    },
    submission,
  });
}));

router.get('/respondent/access/:access', asyncHandler(async (req, res) => {
  const assignment = await queryOne('SELECT * FROM assignments WHERE respondent_token = ?', [String(req.params.access || '').trim()]);
  if (!assignment) throw httpError(404, 'ACCESS_NOT_FOUND', 'Tautan responden tidak ditemukan.');
  const submission = await ensureSubmission(assignment.id);
  res.json({
    assignment: {
      id: assignment.id,
      nama: assignment.nama,
      prelist_type: assignment.prelist_type,
      mode: assignment.mode,
      predefined: await respondentPredefined(assignment),
      pin_is_set: !!assignment.respondent_pin_hash && !assignment.pin_reset_required,
      pin_reset_required: !!assignment.pin_reset_required,
    },
    submission,
  });
}));

router.get('/respondent/session', requireRespondent, asyncHandler(async (req, res) => {
  const submission = await ensureSubmission(req.respondent.assignment.id);
  res.json({
    assignment: {
      id: req.respondent.assignment.id,
      nama: req.respondent.assignment.nama,
      prelist_type: req.respondent.assignment.prelist_type,
      mode: req.respondent.assignment.mode,
      predefined: await respondentPredefined(req.respondent.assignment),
    },
    submission,
  });
}));

router.post('/v1/survey/submit-chunk', asyncHandler(async (req, res) => {
  let assignmentId = req.body?.assignment_id;
  let actor = null;
  try {
    const decoded = verifyBearer(req);
    if (decoded.kind === 'respondent') {
      assignmentId = decoded.sub;
      actor = { kind: 'respondent', id: decoded.sub };
    } else if (decoded.kind === 'user') {
      actor = { kind: 'user', id: decoded.sub };
    }
  } catch {
    if (req.body?.session_token) {
      try {
        const decoded = jwt.verify(String(req.body.session_token), config.auth.jwtSecret);
        if (decoded.kind === 'respondent') {
          assignmentId = decoded.sub;
          actor = { kind: 'respondent', id: decoded.sub };
        }
      } catch {
        throw httpError(401, 'AUTH_INVALID', 'Session token chunk tidak valid.');
      }
    }
  }
  if (!assignmentId) throw httpError(400, 'ASSIGNMENT_REQUIRED', 'assignment_id wajib diisi.');
  const assignment = await queryOne('SELECT * FROM assignments WHERE id = ?', [assignmentId]);
  if (!assignment) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment tidak ditemukan.');
  const chunk = req.body?.chunk_info || {};
  if (!String(chunk.block_id || '').trim()) throw httpError(400, 'BLOCK_REQUIRED', 'block_id wajib diisi.');
  const sequence = Number(chunk.sequence_number || 0);
  if (!Number.isFinite(sequence) || sequence < 0) throw httpError(400, 'SEQUENCE_INVALID', 'sequence_number tidak valid.');
  const action = chunk.action === 'replace' ? 'replace' : 'upsert';
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  const submission = await ensureSubmission(assignment.id);
  const answers = parseObject(submission.answers, {});
  const blockKey = String(chunk.block_id);
  answers[blockKey] = action === 'replace'
    ? payload
    : { ...(answers[blockKey] || {}), ...payload };
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith('__')) answers[key] = value;
  }
  const summary = computeSummary(answers);
  const existingChunk = await queryOne(
    'SELECT id FROM submission_chunks WHERE assignment_id = ? AND block_id = ? AND sequence_number = ?',
    [assignment.id, blockKey, sequence]
  );
  if (existingChunk) {
    await query(
      `UPDATE submission_chunks
          SET payload = ?, action = ?, is_final_submission = ?
        WHERE id = ?`,
      [json(payload), action, req.body?.is_final_submission ? 1 : 0, existingChunk.id]
    );
  } else {
    await query(
      `INSERT INTO submission_chunks
       (id, assignment_id, respondent_id, questionnaire_type, block_id, action, sequence_number, payload, is_final_submission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        assignment.id,
        req.body?.respondent_id || null,
        req.body?.questionnaire_type || assignment.prelist_type,
        blockKey,
        action,
        sequence,
        json(payload),
        req.body?.is_final_submission ? 1 : 0,
      ]
    );
  }
  await query(
    `UPDATE submissions
        SET answers = ?, summary = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [json(answers), json(summary), req.body?.is_final_submission ? 'submitted' : 'draft', submission.id]
  );
  await query(
    'UPDATE assignments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [req.body?.is_final_submission ? 'done' : 'progress', assignment.id]
  );
  await insertAudit(actor?.kind === 'user' ? actor.id : null, 'submit_chunk', 'assignment', assignment.id, {
    block_id: blockKey,
    sequence_number: sequence,
    final: !!req.body?.is_final_submission,
  });
  res.json({
    ok: true,
    assignment_id: assignment.id,
    submission_status: req.body?.is_final_submission ? 'submitted' : 'draft',
    summary,
  });
}));

export default router;
