// Auth routes (§5.1).

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler, ApiError } from '../middleware/errors.js';
import { auth, signToken } from '../middleware/auth.js';
import { getUserByUsername, getUser } from '../services/users.service.js';

const router = Router();

function publicUser(u) {
  return { id: u.id, username: u.username, fullname: u.fullname, email: u.email, role: u.role };
}

// POST /api/auth/login → { token, user }
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw ApiError.badRequest('username & password wajib.');
  const user = await getUserByUsername(username);
  if (!user || !user.is_active) throw ApiError.unauthorized('Kredensial salah.', 'invalid_credentials');
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) throw ApiError.unauthorized('Kredensial salah.', 'invalid_credentials');
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
}));

// GET /api/auth/me → profil dari token
router.get('/me', auth, asyncHandler(async (req, res) => {
  const user = await getUser(req.user.id);
  res.json({ user });
}));

// POST /api/auth/logout → stateless (klien buang token)
router.post('/logout', auth, (_req, res) => {
  res.json({ ok: true });
});

export default router;
