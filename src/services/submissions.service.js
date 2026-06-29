// Submission domain logic (§5.5). 1:1 per assignment, updated in place (§0.1.5);
// change history via audit_logs. Server-side validation runs on save (§7).
//
// Catatan enkripsi (§7.1, DITUNDA): enkripsi answers/summary direncanakan
// dipusatkan di sini (atau helper services/crypto.js) sehingga REST + MCP
// otomatis konsisten. Saat ini answers/summary disimpan sebagai JSON plaintext.

import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db.js';
import { ApiError } from '../middleware/errors.js';
import { getAssignment } from './assignments.service.js';
import { validateAnswers } from './validation.service.js';

const TEMPLATE_ID = '2230fffc-5799-4c8a-a585-12ac286c5bf9';
const TEMPLATE_VERSION = '4.9.2';

// Parse a JSON column that mysql2 may return as object or string.
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export async function getSubmission(assignmentId, user = null) {
  // getAssignment enforces mitra region restriction (read allowed for mitra).
  await getAssignment(assignmentId, user);
  const row = await queryOne(
    'SELECT * FROM submissions WHERE assignment_id = ?', [assignmentId]
  );
  if (!row) return null;
  return {
    ...row,
    answers: parseJson(row.answers),
    summary: parseJson(row.summary),
  };
}

// Upsert answers (admin only — enforced by route). Runs validation, stores
// summary. status:'submitted' is rejected if there are blocking errors (type 2).
export async function upsertSubmission(assignmentId, { answers, status }, user) {
  const assignment = await getAssignment(assignmentId);
  const safeAnswers = answers && typeof answers === 'object' ? answers : {};

  const summary = validateAnswers(safeAnswers);
  const wantSubmitted = status === 'submitted';
  if (wantSubmitted && summary.errors > 0) {
    throw ApiError.badRequest(
      `Tidak bisa submit: masih ada ${summary.errors} galat (type 2).`,
      'has_errors'
    );
  }
  const finalStatus = wantSubmitted ? 'submitted' : 'draft';

  const existing = await queryOne(
    'SELECT * FROM submissions WHERE assignment_id = ?', [assignmentId]
  );

  const answersJson = JSON.stringify(safeAnswers);
  const summaryJson = JSON.stringify(summary);

  let before = null;
  if (existing) {
    before = { status: existing.status, summary: parseJson(existing.summary) };
    await query(
      `UPDATE submissions
          SET answers = ?, summary = ?, status = ?, filled_by = ?, template_id = ?, template_version = ?
        WHERE assignment_id = ?`,
      [answersJson, summaryJson, finalStatus, user.id, TEMPLATE_ID, TEMPLATE_VERSION, assignmentId]
    );
  } else {
    await query(
      `INSERT INTO submissions
        (id, assignment_id, template_id, template_version, answers, summary, status, filled_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), assignmentId, TEMPLATE_ID, TEMPLATE_VERSION,
       answersJson, summaryJson, finalStatus, user.id]
    );
  }

  // Reflect data progress back onto the assignment status (open→progress→done).
  await syncAssignmentStatus(assignmentId, finalStatus, summary);

  return {
    assignment_id: assignmentId,
    answers: safeAnswers,
    summary,
    status: finalStatus,
    _before: before, // returned for the audit diff at the route layer
  };
}

// Just run validation without persisting (§5.5 validate endpoint).
export async function validateSubmission(assignmentId, user = null) {
  await getAssignment(assignmentId, user);
  const sub = await queryOne('SELECT answers FROM submissions WHERE assignment_id = ?', [assignmentId]);
  const answers = sub ? parseJson(sub.answers) || {} : {};
  return validateAnswers(answers);
}

export async function deleteSubmission(assignmentId) {
  await getAssignment(assignmentId);
  await query('DELETE FROM submissions WHERE assignment_id = ?', [assignmentId]);
  await query("UPDATE assignments SET status = 'open' WHERE id = ?", [assignmentId]);
}

// Map submission state → assignment status enum for the Data listing chips.
async function syncAssignmentStatus(assignmentId, subStatus, summary) {
  let status;
  if (subStatus === 'submitted') {
    status = summary.errors > 0 ? 'error' : (summary.warnings > 0 ? 'done' : 'clean');
  } else {
    status = summary.answered > 0 ? 'progress' : 'open';
  }
  await query('UPDATE assignments SET status = ? WHERE id = ?', [status, assignmentId]);
}
