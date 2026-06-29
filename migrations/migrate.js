// Migration runner: ensures the database exists, then applies every
// migrations/*.sql file in lexical order. Idempotent (uses CREATE TABLE IF NOT
// EXISTS). Run: `npm run migrate`.

import mysql from 'mysql2/promise';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function baseConn(withDb) {
  const base = {
    user: config.db.user,
    password: config.db.password,
    charset: 'utf8mb4',
    multipleStatements: true,
  };
  if (withDb) base.database = config.db.database;
  return config.db.socket
    ? { ...base, socketPath: config.db.socket }
    : { ...base, host: config.db.host, port: config.db.port };
}

async function main() {
  // 1) Ensure the database exists (Hostinger usually creates it via panel, but
  //    locally we create it for convenience).
  const root = await mysql.createConnection(baseConn(false));
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await root.end();

  // 2) Apply each .sql migration in order.
  const conn = await mysql.createConnection(baseConn(true));
  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(__dirname, file), 'utf8');
    process.stdout.write(`→ applying ${file} … `);
    await conn.query(sql);
    console.log('ok');
  }
  await conn.end();
  console.log(`Migrasi selesai (${files.length} file) → db '${config.db.database}'`);
}

main().catch((err) => {
  console.error('Migrasi GAGAL:', err.message);
  process.exit(1);
});
