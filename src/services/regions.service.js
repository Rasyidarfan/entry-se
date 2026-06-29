// Region tree queries (§5.3) — feeds the cascading Filter Wilayah dropdowns.

import { query } from '../db.js';
import { ApiError } from '../middleware/errors.js';

const LEVELS = ['prov', 'kab', 'kec', 'desa', 'sls', 'subsls'];

// List regions at a level, optionally under a parent (by id or fullcode).
export async function listRegions({ level, parent } = {}) {
  if (level && !LEVELS.includes(level)) throw ApiError.badRequest('level tidak valid.');
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (parent) {
    // Accept either a region id (CHAR36 UUID) or a fullcode.
    where.push('(parent_id = ? OR parent_id = (SELECT id FROM regions WHERE fullcode = ? LIMIT 1))');
    params.push(parent, parent);
  }
  const sql =
    'SELECT id, level, code, fullcode, name, parent_id FROM regions' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY code';
  return query(sql, params);
}
