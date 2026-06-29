// JWT auth middleware: verify `Authorization: Bearer <token>` → req.user.

import jwt from 'jsonwebtoken';
import config from '../config.js';
import { ApiError } from './errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn }
  );
}

export function auth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Token tidak ada.'));
  }
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    req.user = { id: payload.sub, role: payload.role, username: payload.username };
    next();
  } catch {
    next(ApiError.unauthorized('Token tidak valid atau kedaluwarsa.'));
  }
}
