// User management routes (§5.2) — admin only.

import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { auth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/authorize.js';
import { logAudit } from '../services/audit.service.js';
import * as users from '../services/users.service.js';

const router = Router();

// GET /api/users — list (admin sees all; mitra may read for petugas dropdowns)
router.get('/', auth, asyncHandler(async (req, res) => {
  res.json({ data: await users.listUsers({ role: req.query.role, q: req.query.q }) });
}));

router.get('/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ user: await users.getUser(req.params.id) });
}));

router.post('/', auth, adminOnly, asyncHandler(async (req, res) => {
  const user = await users.createUser(req.body || {});
  await logAudit({ userId: req.user.id, action: 'user.create', entity: 'user', entityId: user.id });
  res.status(201).json({ user });
}));

router.patch('/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const user = await users.updateUser(req.params.id, req.body || {});
  await logAudit({ userId: req.user.id, action: 'user.update', entity: 'user', entityId: user.id, diff: req.body });
  res.json({ user });
}));

router.delete('/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  await users.deactivateUser(req.params.id, { hard: req.query.hard === '1' });
  await logAudit({ userId: req.user.id, action: 'user.delete', entity: 'user', entityId: req.params.id });
  res.json({ ok: true });
}));

// PUT /api/users/:id/regions — set wilayah untuk mitra
router.put('/:id/regions', auth, adminOnly, asyncHandler(async (req, res) => {
  const regionIds = (req.body && req.body.region_ids) || [];
  const regions = await users.setUserRegions(req.params.id, regionIds);
  await logAudit({ userId: req.user.id, action: 'user.set_regions', entity: 'user', entityId: req.params.id, diff: { region_ids: regionIds } });
  res.json({ regions });
}));

export default router;
