// Audit trail (§4.6, §6). Every admin mutation records an entry.

import { query } from '../db.js';

export async function logAudit({ userId, action, entity, entityId, diff = null }) {
  try {
    await query(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, diff) VALUES (?,?,?,?,?)',
      [userId || null, action, entity || null, entityId != null ? String(entityId) : null,
       diff == null ? null : JSON.stringify(diff)]
    );
  } catch (err) {
    // Audit failure must never break the main operation.
    console.error('[audit] gagal mencatat:', err.message);
  }
}
