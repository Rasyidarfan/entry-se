// Centralised configuration: reads .env once, validates, exports a frozen object.
// Used by db.js, auth middleware, and the seed/migrate scripts.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function bool(v, def = false) {
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),

  db: {
    connection: (process.env.DB_CONNECTION || 'mysql').trim().toLowerCase(),
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    database: process.env.DB_DATABASE || 'se_entry',
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    // When DB_SOCKET is set (local MAMP) we connect via socket; otherwise host+port
    // (Hostinger). db.js chooses based on this value being non-empty.
    socket: (process.env.DB_SOCKET || '').trim() || null,
    sqlitePath: process.env.DB_SQLITE_PATH || join(__dirname, '..', 'data', 'se_entry.sqlite'),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30m',
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  },

  seed: {
    adminUsername: process.env.SEED_ADMIN_USERNAME || 'admin',
    adminPassword: process.env.SEED_ADMIN_PASSWORD || 'admin123',
    mitraUsername: process.env.SEED_MITRA_USERNAME || 'mitra',
    mitraPassword: process.env.SEED_MITRA_PASSWORD || 'mitra123',
  },

  // Enkripsi answers — ditunda (§7.1). Disediakan agar mudah diaktifkan nanti.
  encryptionKey: (process.env.ENCRYPTION_KEY || '').trim() || null,

  mcp: {
    enabled: bool(process.env.MCP_ENABLED, true),
    transport: process.env.MCP_TRANSPORT || 'http',
    httpPort: int(process.env.MCP_HTTP_PORT, 3333),
  },

  // Static API key for MCP machine-to-machine access (optional).
  // If set, clients can authenticate with X-Api-Key: <key> instead of JWT.
  mcpApiKey: (process.env.MCP_API_KEY || '').trim() || null,
};

if (config.env === 'production' && config.auth.jwtSecret === 'dev-insecure-secret-change-me') {
  console.warn('[config] WARNING: JWT_SECRET belum di-set di production!');
}

export default Object.freeze(config);
