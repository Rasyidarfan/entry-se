// User domain logic (§5.2). Shared by REST + (future) MCP.

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db.js';
import config from '../config.js';
import { ApiError } from '../middleware/errors.js';

const PUBLIC_COLS =
  'id, username, fullname, email, role, is_active, created_at, updated_at';

export async function listUsers({ role, q } = {}) {
  const where = [];
  const params = [];
  if (role) { where.push('role = ?'); params.push(role); }
  if (q) {
    where.push('(username LIKE ? OR fullname LIKE ? OR email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sql =
    `SELECT ${PUBLIC_COLS} FROM users` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY role, username';
  return query(sql, params);
}

export async function getUser(id) {
  const u = await queryOne(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, [id]);
  if (!u) throw ApiError.notFound('User tidak ditemukan.');
  return u;
}

export async function getUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

export async function createUser({ username, password, fullname, role, email }) {
  if (!username || !password) throw ApiError.badRequest('username & password wajib.');
  if (!['admin', 'mitra'].includes(role)) throw ApiError.badRequest('role tidak valid.');
  const existing = await getUserByUsername(username);
  if (existing) throw ApiError.conflict('Username sudah dipakai.');
  const id = randomUUID();
  const hash = bcrypt.hashSync(password, config.auth.bcryptRounds);
  await query(
    'INSERT INTO users (id, username, password_hash, fullname, email, role, is_active) VALUES (?,?,?,?,?,?,1)',
    [id, username, hash, fullname || null, email || null, role]
  );
  return getUser(id);
}

export async function updateUser(id, fields) {
  await getUser(id); // 404 if missing
  const sets = [];
  const params = [];
  if (fields.fullname !== undefined) { sets.push('fullname = ?'); params.push(fields.fullname); }
  if (fields.email !== undefined) { sets.push('email = ?'); params.push(fields.email); }
  if (fields.role !== undefined) {
    if (!['admin', 'mitra'].includes(fields.role)) throw ApiError.badRequest('role tidak valid.');
    sets.push('role = ?'); params.push(fields.role);
  }
  if (fields.is_active !== undefined) { sets.push('is_active = ?'); params.push(fields.is_active ? 1 : 0); }
  if (fields.password) {
    sets.push('password_hash = ?');
    params.push(bcrypt.hashSync(fields.password, config.auth.bcryptRounds));
  }
  if (!sets.length) return getUser(id);
  params.push(id);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return getUser(id);
}

// Soft-delete by default (is_active=0); hard delete only if requested.
export async function deactivateUser(id, { hard = false } = {}) {
  await getUser(id);
  if (hard) {
    await query('DELETE FROM users WHERE id = ?', [id]);
  } else {
    await query('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
  }
}

export async function setUserRegions(userId, regionIds = []) {
  await getUser(userId);
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM user_regions WHERE user_id = ?', [userId]);
    if (regionIds.length) {
      const rows = regionIds.map((rid) => [userId, rid]);
      await conn.query('INSERT INTO user_regions (user_id, region_id) VALUES ?', [rows]);
    }
  });
  return getUserRegions(userId);
}

export async function getUserRegions(userId) {
  return query(
    `SELECT r.id, r.level, r.code, r.fullcode, r.name
       FROM user_regions ur JOIN regions r ON r.id = ur.region_id
      WHERE ur.user_id = ?`,
    [userId]
  );
}

// Region fullcode prefixes a mitra is allowed to see (§6 region restriction).
export async function getUserRegionPrefixes(userId) {
  const rows = await query(
    `SELECT r.fullcode FROM user_regions ur
       JOIN regions r ON r.id = ur.region_id WHERE ur.user_id = ?`,
    [userId]
  );
  return rows.map((r) => r.fullcode).filter(Boolean);
}
