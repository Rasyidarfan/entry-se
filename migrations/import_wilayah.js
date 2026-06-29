// ─────────────────────────────────────────────────────────────────────────────
// Import master wilayah dari `wilayah.json` → tabel `regions`.
//
//   node migrations/import_wilayah.js
//   npm run import:wilayah
//
// wilayah.json berisi baris terkecil (SLS/sub-SLS) dengan kolom:
//   kdkab, kdkec, nmkec, kddesa, nmdesa, kdsls, kdsubsls, nmsls
// Provinsi tidak ada di file (seluruhnya Papua Pegunungan = 97).
//
// Fullcode mengikuti konvensi yang sudah ada di DB:
//   prov   97                 (2)
//   kab    9702               (+2)
//   kec    9702050            (+3)
//   desa   9702050008         (+3)
//   sls    97020500084001     (+4)
//   subsls 9702050008400100   (+2)
//
// Idempotent: upsert berdasarkan `fullcode` (UNIQUE). Aman dijalankan berulang.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, queryOne, closeDb } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Provinsi & kabupaten tidak punya nama di wilayah.json — petakan manual.
const PROV = { code: '97', name: 'PAPUA PEGUNUNGAN' };
const KAB_NAMES = {
  '02': 'JAYAWIJAYA',
  '05': 'MAMBERAMO TENGAH',
};

function titleCaseKeep(s) {
  return String(s == null ? '' : s).trim();
}

// Build the full region tree (prov→subsls) from the flat SLS rows.
function deriveRegions(rows) {
  // fullcode → { id, level, code, fullcode, name, parentFullcode }
  const byFullcode = new Map();
  const ensure = (level, code, fullcode, name, parentFullcode) => {
    if (!byFullcode.has(fullcode)) {
      byFullcode.set(fullcode, { id: randomUUID(), level, code: String(code), fullcode, name: titleCaseKeep(name), parentFullcode });
    } else if (name && !byFullcode.get(fullcode).name) {
      byFullcode.get(fullcode).name = titleCaseKeep(name);
    }
    return byFullcode.get(fullcode);
  };

  for (const r of rows) {
    const kdkab = String(r.kdkab).padStart(2, '0');
    const kdkec = String(r.kdkec).padStart(3, '0');
    const kddesa = String(r.kddesa).padStart(3, '0');
    const kdsls = String(r.kdsls).padStart(4, '0');
    const kdsubsls = String(r.kdsubsls).padStart(2, '0');

    const fProv = PROV.code;
    const fKab = fProv + kdkab;
    const fKec = fKab + kdkec;
    const fDesa = fKec + kddesa;
    const fSls = fDesa + kdsls;
    const fSubsls = fSls + kdsubsls;

    ensure('prov', PROV.code, fProv, PROV.name, null);
    ensure('kab', kdkab, fKab, KAB_NAMES[kdkab] || `KAB ${kdkab}`, fProv);
    ensure('kec', kdkec, fKec, r.nmkec, fKab);
    ensure('desa', kddesa, fDesa, r.nmdesa, fKec);
    ensure('sls', kdsls, fSls, r.nmsls, fDesa);
    // subsls hanya bila benar-benar sub-SLS (kdsubsls != '00').
    if (kdsubsls !== '00') {
      ensure('subsls', kdsubsls, fSubsls, r.nmsls, fSls);
    }
  }
  return byFullcode;
}

async function upsertRegion(node, parentId) {
  const existing = await queryOne('SELECT id FROM regions WHERE fullcode = ?', [node.fullcode]);
  if (existing) {
    await query(
      'UPDATE regions SET level = ?, code = ?, name = ?, parent_id = ? WHERE id = ?',
      [node.level, node.code, node.name, parentId, existing.id]
    );
    return existing.id;
  }
  await query(
    'INSERT INTO regions (id, level, code, fullcode, name, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
    [node.id, node.level, node.code, node.fullcode, node.name, parentId]
  );
  return node.id;
}

async function main() {
  const rows = JSON.parse(readFileSync(join(ROOT, 'wilayah.json'), 'utf8'));
  console.log(`wilayah.json: ${rows.length} baris SLS/sub-SLS`);

  const regionMap = deriveRegions(rows);
  // Urutkan dari fullcode terpendek → terpanjang agar induk dibuat lebih dulu.
  const ordered = [...regionMap.values()].sort((a, b) => a.fullcode.length - b.fullcode.length || a.fullcode.localeCompare(b.fullcode));

  // fullcode → id (terisi saat kita meng-upsert, dipakai anak untuk parent_id).
  const idByFullcode = new Map();
  const counts = {};
  for (const node of ordered) {
    const parentId = node.parentFullcode ? (idByFullcode.get(node.parentFullcode) || null) : null;
    const id = await upsertRegion(node, parentId);
    idByFullcode.set(node.fullcode, id);
    counts[node.level] = (counts[node.level] || 0) + 1;
  }

  console.log('Tersimpan ke regions:');
  for (const lv of ['prov', 'kab', 'kec', 'desa', 'sls', 'subsls']) {
    if (counts[lv]) console.log(`  ${lv.padEnd(7)}: ${counts[lv]}`);
  }
  const total = await queryOne('SELECT COUNT(*) AS c FROM regions');
  console.log(`Total baris regions di DB: ${total.c}`);
}

main()
  .then(async () => { await closeDb().catch(() => {}); process.exit(0); })
  .catch(async (err) => { console.error('Gagal import wilayah:', err); await closeDb().catch(() => {}); process.exit(1); });
