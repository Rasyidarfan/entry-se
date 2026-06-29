// Assignment + nested submission routes (§5.4, §5.5, §5.6).

import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { auth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/authorize.js';
import { logAudit } from '../services/audit.service.js';
import * as assignments from '../services/assignments.service.js';
import * as submissions from '../services/submissions.service.js';

const router = Router();

// ── Listing & detail (semua role; mitra dibatasi wilayah) ────────────────────

// GET /api/assignments  — daftar + filter + paging (§5.6)
router.get('/', auth, asyncHandler(async (req, res) => {
  res.json(await assignments.listAssignments(req.query, req.user));
}));

// GET /api/assignments/:id — detail + predefined
router.get('/:id', auth, asyncHandler(async (req, res) => {
  res.json({ assignment: await assignments.getAssignment(req.params.id, req.user) });
}));

// ── Mutations (admin only) ───────────────────────────────────────────────────

router.post('/', auth, adminOnly, asyncHandler(async (req, res) => {
  const a = await assignments.createAssignment(req.body || {});
  await logAudit({ userId: req.user.id, action: 'assignment.create', entity: 'assignment', entityId: a.id });
  res.status(201).json({ assignment: a });
}));

router.post('/import', auth, adminOnly, asyncHandler(async (req, res) => {
  const items = (req.body && req.body.items) || req.body || [];
  const result = await assignments.importAssignments(items);
  await logAudit({ userId: req.user.id, action: 'assignment.import', entity: 'assignment', entityId: null, diff: result });
  res.status(201).json(result);
}));

router.patch('/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const a = await assignments.updateAssignment(req.params.id, req.body || {});
  await logAudit({ userId: req.user.id, action: 'assignment.update', entity: 'assignment', entityId: a.id, diff: req.body });
  res.json({ assignment: a });
}));

router.delete('/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  await assignments.deleteAssignment(req.params.id);
  await logAudit({ userId: req.user.id, action: 'assignment.delete', entity: 'assignment', entityId: req.params.id });
  res.json({ ok: true });
}));

// ── Submissions (isian kuesioner) — §5.5 ─────────────────────────────────────

// GET .../submission — lihat isian (mitra read-only)
router.get('/:id/submission', auth, asyncHandler(async (req, res) => {
  const submission = await submissions.getSubmission(req.params.id, req.user);
  res.json({ submission });
}));

// PUT .../submission — simpan/edit jawaban (admin)
router.put('/:id/submission', auth, adminOnly, asyncHandler(async (req, res) => {
  const { answers, status } = req.body || {};
  const result = await submissions.upsertSubmission(req.params.id, { answers, status }, req.user);
  await logAudit({
    userId: req.user.id, action: 'submission.update', entity: 'submission',
    entityId: req.params.id,
    diff: { status: result.status, summary: result.summary, before: result._before },
  });
  delete result._before;
  res.json(result);
}));

// POST .../submission/validate — validasi server-side (admin)
router.post('/:id/submission/validate', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ summary: await submissions.validateSubmission(req.params.id, req.user) });
}));

// DELETE .../submission — hapus isian (admin)
router.delete('/:id/submission', auth, adminOnly, asyncHandler(async (req, res) => {
  await submissions.deleteSubmission(req.params.id);
  await logAudit({ userId: req.user.id, action: 'submission.delete', entity: 'submission', entityId: req.params.id });
  res.json({ ok: true });
}));

export default router;
