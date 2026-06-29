# SE2026 Entry App

Aplikasi entri kuesioner **Sensus Ekonomi 2026** berbasis web. Petugas BPS mengisi formulir FormGear interaktif per assignment (rumah tangga / bangunan usaha), dengan autentikasi JWT, filter wilayah bertingkat, dan API MCP untuk akses data oleh AI agent.

## Tech Stack

- **Backend** — Node.js (ESM), Express-like custom router (`tiny-express.js`), SQLite via `better-sqlite3`
- **Frontend** — Vanilla JS + HTML/CSS (tanpa framework)
- **Auth** — JWT (access token 30m), role: `admin` / `mitra`
- **Form engine** — FormGear template (client-side), `engine.js` + `pdf-rules.js`
- **MCP** — Model Context Protocol JSON-RPC 2.0 over HTTP (`/mcp`)

## Setup

```sh
npm install
cp .env.example .env     # sesuaikan PORT, JWT_SECRET
npm run migrate          # buat skema SQLite
npm run seed             # seed wilayah + assignment dari wilayah.json
npm start                # → http://localhost:3000
```

Login default: **admin / admin123**, **mitra / mitra123** (ganti via `.env`).

## Konfigurasi (.env)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port server |
| `NODE_ENV` | `development` | `production` aktifkan redirect HTTPS |
| `JWT_SECRET` | *(wajib diubah)* | Secret JWT |
| `JWT_EXPIRES_IN` | `30m` | Masa berlaku token |
| `DB_SQLITE_PATH` | `data/se_entry.sqlite` | Path file SQLite |
| `SEED_ADMIN_USERNAME` | `admin` | Username admin awal |
| `SEED_ADMIN_PASSWORD` | `admin123` | Password admin awal |
| `MCP_ENABLED` | `true` | Aktifkan endpoint `/mcp` |
| `MCP_API_KEY` | *(kosong)* | API key statis untuk akses mesin-ke-mesin |

## Struktur

```
src/
  server.js           — entry point, routing
  config.js           — baca & validasi .env
  db.js               — koneksi SQLite (better-sqlite3)
  tiny-express.js     — minimal router
  middleware/         — auth.js, authorize.js, errors.js
  routes/             — core.routes.js, mcp.routes.js
  services/           — assignments, submissions, regions, users, validation
  seed/               — wilayah.js (build region tree dari wilayah.json)
migrations/
  001_schema.sql      — DDL semua tabel
  migrate.js          — jalankan migrasi
  seed.js             — seed users + wilayah + assignments
public/
  login.html          — halaman masuk
  data.html/js/css    — layar Data (daftar assignment)
  respondent.html/js  — form FormGear per assignment
  engine.js           — FormGear engine (client-side)
  pdf-rules.js        — skip-logic eksplisit dari SE2026-L.pdf
wilayah.json          — daftar SLS Papua Pegunungan (sumber seed wilayah)
template.json         — template FormGear SE2026-L
validation.json       — aturan validasi FormGear
```

## REST API (ringkas)

| Method | Path | Role |
|---|---|---|
| `POST` | `/api/auth/login` | publik |
| `GET` | `/api/auth/me` | semua |
| `GET` | `/api/assignments` | semua (mitra: wilayah sendiri) |
| `GET` | `/api/assignments/:id` | semua |
| `GET/PUT/DELETE` | `/api/assignments/:id/submission` | semua (mitra read-only) |
| `GET` | `/api/regions` | semua |
| `GET/POST/PATCH/DELETE` | `/api/users` | admin |

Header: `Authorization: Bearer <JWT>`

## MCP (AI Agent Access)

Endpoint: `POST /mcp` (JSON-RPC 2.0), `GET /mcp` (SSE stream)

**Auth:** Bearer JWT atau header `X-Api-Key: <MCP_API_KEY>`

**Tools tersedia:**

| Tool | Keterangan |
|---|---|
| `list_assignments` | Daftar assignment dengan filter & paging |
| `get_assignment` | Detail satu assignment + ringkasan submission |
| `get_submission` | Jawaban lengkap satu submission |
| `list_chunks` | Chunk submission mentah per blok |
| `get_statistics` | Agregasi jumlah per status/tipe/wilayah |
| `run_sql` | Query SELECT bebas (admin only) |

Contoh `initialize`:
```json
POST /mcp
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05", "clientInfo": { "name": "my-agent", "version": "1.0" }, "capabilities": {} } }
```

Contoh `tools/call`:
```json
POST /mcp
Authorization: Bearer <token>
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_assignments", "arguments": { "status": "open", "limit": 10 } } }
```

## Deploy (Hostinger / VPS)

```sh
# Set env vars di panel atau .env (jangan commit .env)
NODE_ENV=production
JWT_SECRET=<acak panjang>
PORT=3000

npm run migrate
npm run seed
npm start
```
