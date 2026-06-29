// Role authorization. Use after `auth`. authorize('admin') → reject non-admin.

import { ApiError } from './errors.js';

export function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (roles.length && !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Hanya untuk peran: ' + roles.join(', ')));
    }
    next();
  };
}

export const adminOnly = authorize('admin');
