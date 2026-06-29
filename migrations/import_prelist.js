// ─────────────────────────────────────────────────────────────────────────────
// Impor prelist keluarga dari CSV → assignments (1 keluarga = 1 assignment).
//
//  Sumber : ../data_kk_wilekama.csv  (data anggota keluarga per baris)
//  Output : tiap no_kk unik menjadi satu assignment keluarga, dengan:
//            - nama        = kepala keluarga
//            - kode_identitas = no_kk
//            - predefined  = wilayah terkunci + identitas KK + roster anggota
//              (list_individu_dtsen_prelist), meniru bentuk prelist FASIH.
//
//  Wilayah : kec NAPUA (050) & desa WILEKAMA (008) belum ada di master regions;
//            skrip memastikan node-nya dibuat di bawah prov 97 / kab 02 (Jayawijaya)
//            dengan kode resmi yang diberikan: 97 02 050 008 4001 00.
//
//  Idempotent: assignment dengan kode_identitas (no_kk) yang sama akan dilewati.
//  Run: node migrations/import_prelist.js  [path/ke/file.csv]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pool, query, queryOne, withTransaction } from '../src/db.js';
import { createAssignment } from '../src/services/assignments.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_CSV = join(ROOT, 'data_kk_wilekama.csv');

// Kode wilayah resmi yang diberikan: prov-kab-kec-desa-sls-subsls.
const WIL = {
  prov:   { code: '97',   name: 'PAPUA PEGUNUNGAN' },
  kab:    { code: '02',   name: 'JAYAWIJAYA' },
  kec:    { code: '050',  name: 'NAPUA' },
  desa:   { code: '008',  name: 'WILEKAMA' },
  sls:    { code: '4001', name: 'WILEKAMA' },
  subsls: { code: '00',   name: 'WILEKAMA' },
};
const LEVEL_ORDER = ['prov', 'kab', 'kec', 'desa', 'sls', 'subsls'];

// --- minimal CSV parser (handles quoted fields with commas) ------------------
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length > 1 && r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Ensure the whole region chain exists; return the deepest fullcode.
async function ensureRegions() {
  let parentId = null;
  let fullcode = '';
  for (const level of LEVEL_ORDER) {
    const seg = WIL[level];
    fullcode += seg.code;
    let region = await queryOne('SELECT id FROM regions WHERE fullcode = ?', [fullcode]);
    if (!region) {
      const id = randomUUID();
      await query(
        'INSERT INTO regions (id, level, code, fullcode, name, parent_id) VALUES (?,?,?,?,?,?)',
        [id, level, seg.code, fullcode, seg.name, parentId]
      );
      region = { id };
      console.log(`  + region ${level} ${seg.code} (${seg.name}) fullcode=${fullcode}`);
    }
    parentId = region.id;
  }
  return fullcode; // deepest = subsls
}

function isHead(member) {
  return /KEPALA KELUARGA/i.test(member.status_hubungan_keluarga || '');
}

// Build predefined for one family: locked wilayah + KK identity + member roster.
function buildFamilyPredefined(noKk, members) {
  const head = members.find(isHead) || members[0];
  const roster = members.map((m, idx) => ({
    value: idx + 1,
    label: m.nama_anggota,
    nama_ak: m.nama_anggota,
    nik: m.nik || null,
    jk: /LAKI/i.test(m.jenis_kelamin) ? '1' : '2',           // 1=L, 2=P (konvensi FASIH)
    hubungan: m.status_hubungan_keluarga || null,
    tempat_lahir: m.tempat_lahir || null,
    tanggal_lahir: m.tanggal_lahir || null,
    is_prelist: 1,
  }));

  return {
    mode: 'CAPI',
    is_prelist: '1',
    is_keluarga: '1',
    jenis_prelist: 'keluarga',
    // Wilayah (terkunci, diisi BPS)
    prov: `[${WIL.prov.code}] ${WIL.prov.name}`,
    kab: `[${WIL.kab.code}] ${WIL.kab.name}`,
    kec: `[${WIL.kec.code}] ${WIL.kec.name}`,
    desa: `[${WIL.desa.code}] ${WIL.desa.name}`,
    klas_desa: 'Perdesaan',
    kode_sls: WIL.sls.code,
    nama_sls: WIL.sls.name,
    kodepos: members[0].kode_pos || null,
    // Identitas keluarga
    no_kk: noKk,
    nomor_kartu_keluarga: noKk,
    dtsen_no_kk: noKk,
    nama_kk: head.nama_anggota || head.kepala_keluarga,
    dtsen_nama_kk: head.nama_anggota || head.kepala_keluarga,
    nik: head.nik || null,
    alamat_prelist: members[0].alamat || WIL.desa.name,
    jumlah_ak_kk: String(members.length),
    // Roster anggota (dipakai form: list_individu_dtsen_prelist)
    list_individu_dtsen_prelist: roster,
  };
}

async function main() {
  const csvPath = resolve(process.argv[2] || DEFAULT_CSV);
  if (!existsSync(csvPath)) throw new Error(`CSV tidak ditemukan: ${csvPath}`);
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  console.log(`CSV: ${rows.length} baris anggota dari ${csvPath}`);

  // Group by no_kk → family.
  const families = new Map();
  for (const r of rows) {
    if (!r.no_kk) continue;
    if (!families.has(r.no_kk)) families.set(r.no_kk, []);
    families.get(r.no_kk).push(r);
  }
  console.log(`Keluarga unik: ${families.size}`);

  // Ensure region chain (inside a tx so partial failure rolls back).
  const regionFullcode = await withTransaction(async () => ensureRegions());
  console.log(`Region target (subsls): ${regionFullcode}`);

  let created = 0, skipped = 0;
  for (const [noKk, members] of families) {
    const exists = await queryOne(
      'SELECT id FROM assignments WHERE kode_identitas = ? LIMIT 1', [noKk]
    );
    if (exists) { skipped++; continue; }

    const predefined = buildFamilyPredefined(noKk, members);
    const head = members.find(isHead) || members[0];
    await createAssignment({
      prelist_type: 'keluarga',
      nama: head.nama_anggota || head.kepala_keluarga,
      kode_identitas: noKk,
      alamat_prelist: members[0].alamat || WIL.desa.name,
      region_fullcode: regionFullcode,
      predefined, // override: pakai predefined kaya (roster) ini
    });
    created++;
  }

  await pool.end();
  console.log(`Impor selesai ✓  dibuat: ${created}, dilewati (sudah ada): ${skipped}`);
}

main().catch((err) => {
  console.error('Impor GAGAL:', err.message);
  pool.end().finally(() => process.exit(1));
});
