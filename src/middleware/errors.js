// Uniform API error type + Express error handler.
// Response shape (§5): { "error": { "code": "...", "message": "..." } }

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  static badRequest(msg, code = 'bad_request') { return new ApiError(400, code, msg); }
  static unauthorized(msg = 'Tidak terautentikasi', code = 'unauthorized') { return new ApiError(401, code, msg); }
  static forbidden(msg = 'Akses ditolak', code = 'forbidden') { return new ApiError(403, code, msg); }
  static notFound(msg = 'Tidak ditemukan', code = 'not_found') { return new ApiError(404, code, msg); }
  static conflict(msg, code = 'conflict') { return new ApiError(409, code, msg); }
}

// Wrap async route handlers so thrown errors reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  // Duplicate key etc. from MySQL.
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: { code: 'conflict', message: 'Data sudah ada (duplikat).' } });
  }
  console.error('[api] unhandled error:', err);
  return res.status(500).json({ error: { code: 'internal', message: 'Kesalahan server.' } });
}
