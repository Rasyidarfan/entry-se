// Region routes (§5.3) — feed cascading Filter Wilayah dropdowns.

import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { auth } from '../middleware/auth.js';
import { listRegions } from '../services/regions.service.js';

const router = Router();

// GET /api/regions?level=prov | ?level=kab&parent=<id|fullcode> …
router.get('/', auth, asyncHandler(async (req, res) => {
  const data = await listRegions({ level: req.query.level, parent: req.query.parent });
  res.json({ data });
}));

export default router;
