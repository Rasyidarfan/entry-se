'use strict';

// Question-appearance rules transcribed from the SE2026-L printed questionnaire
// (the orange "→ Lanjut ke / → STOP / [Jika ...]" annotations and the
// "Blok X hanya ditanyakan kepada responden ..." headers).
//
// Each entry is dataKey -> (engine) => boolean | undefined.
//   true      → force visible
//   false     → force hidden (skipped)
//   undefined → defer to the template's own enableCondition
//
// `code(engine, key)` reads a radio/choice answer as its plain string code.

(function (global) {
  function code(engine, key) {
    const v = engine.rawGet(key);
    if (Array.isArray(v)) return v[0] && v[0].value != null ? String(v[0].value) : '';
    return v == null ? '' : String(v);
  }
  function num(engine, key) {
    const n = Number(engine.rawGet(key));
    return Number.isFinite(n) ? n : 0;
  }
  const isKeluarga = (e) => code(e, 'jenis_prelist') === 'keluarga' || code(e, 'is_keluarga') === '1';
  const isUsaha = (e) => !isKeluarga(e);

  const RULES = {
    // ── Block scope: family vs business ─────────────────────────────────────
    // Blok II (usaha) only for business respondents; Blok I & IV (perumahan)
    // only for family respondents.
    badan_usaha: (e) => isUsaha(e) || undefined,
    jaringan: (e) => isUsaha(e) || undefined,
    lokasi_usaha: (e) => isUsaha(e) || undefined,
    punya_nib: (e) => isUsaha(e) || undefined,
    jns_bangunan: (e) => isKeluarga(e) || undefined,
    tempat_bab: (e) => isKeluarga(e) || undefined,
    sumber_penerangan: (e) => isKeluarga(e) || undefined,
    air_minum: (e) => isKeluarga(e) || undefined,
    buang_tinja: (e) => isKeluarga(e) || undefined,

    // ── Blok I r9a Keberadaan AK → STOP / branching ─────────────────────────
    // 2 Meninggal / 6 Sudah pisah KK / 7 Tidak dikenal → STOP (hide downstream).
    // 3 → r10DN, 4 → r10LN, 5 → r11. Domisili (9b) only when ditemukan.
    hubungan: (e) => {
      const c = code(e, 'ada_keluarga');
      if (['2', '6', '7'].includes(c)) return false; // STOP
      return undefined;
    },
    status_kawin: (e) => (['2', '6', '7'].includes(code(e, 'ada_keluarga')) ? false : undefined),
    jk_dtsen: (e) => (['2', '6', '7'].includes(code(e, 'ada_keluarga')) ? false : undefined),
    umur_ak: (e) => (['2', '6', '7'].includes(code(e, 'ada_keluarga')) ? false : undefined),
    // Domisili dalam negeri shown only for r9a=3; luar negeri only for r9a=4.
    alamat_dn: (e) => (code(e, 'ada_keluarga') === '3' ? true : undefined),
    domisili_ln: (e) => (code(e, 'ada_keluarga') === '4' ? true : undefined),

    // ── Blok III: age-gated questions ───────────────────────────────────────
    // 14/15 usia 5+, 16/17 usia 10+. Without an age we don't force-hide, but a
    // very young recorded age skips them.
    sekolah: (e) => (num(e, 'umur_ak') > 0 && num(e, 'umur_ak') < 5 ? false : undefined),
    ijazah: (e) => (num(e, 'umur_ak') > 0 && num(e, 'umur_ak') < 5 ? false : undefined),
    profesi: (e) => (num(e, 'umur_ak') > 0 && num(e, 'umur_ak') < 10 ? false : undefined),
    status_kerja: (e) => {
      if (num(e, 'umur_ak') > 0 && num(e, 'umur_ak') < 10) return false;
      // "Tidak bekerja" (profesi 000) → skip status kedudukan (r16 → r18).
      if (code(e, 'profesi') === '000' || code(e, 'profesi') === '0') return false;
      return undefined;
    },
    // 16b "profesi lainnya" only when profesi = kode 185 (Lainnya).
    profesi_lainnya: (e) => (code(e, 'profesi') === '185' ? true : undefined),

    // ── Blok II business sub-branches ───────────────────────────────────────
    // 10b NIB number only when punya_nib = 1 (Ya); 10c reason only when = 2.
    nib: (e) => {
      if (!isUsaha(e)) return false;
      return code(e, 'punya_nib') === '1' ? true : (code(e, 'punya_nib') === '2' ? false : undefined);
    },
    tidak_nib: (e) => {
      if (!isUsaha(e)) return false;
      return code(e, 'punya_nib') === '2' ? true : (code(e, 'punya_nib') === '1' ? false : undefined);
    },
    nib_lainnya: (e) => (code(e, 'tidak_nib') === '5' ? true : undefined),
    // r11 koperasi sub-questions only when badan_usaha = 3 (Koperasi).
    koperasi_kdkmp: (e) => (code(e, 'badan_usaha') === '3' ? true : false),
    jenis_koperasi: (e) => (code(e, 'badan_usaha') === '3' ? true : false),
    lap_keuangan: (e) => (code(e, 'badan_usaha') === '3' ? true : false),

    // ── Blok IV housing branches ────────────────────────────────────────────
    jns_bangunan_lain: (e) => (code(e, 'jns_bangunan') === '5' ? true : undefined),
    bukti_kepemilikan: (e) => (code(e, 'status_kepemilikan') === '1' ? true : false),
    // r10 jenis kloset only when r9 (tempat_bab) in {1,2,3}.
    jns_closet: (e) => (['1', '2', '3'].includes(code(e, 'tempat_bab')) ? true : false),
    // r14 PLN meter detail only when sumber_penerangan = 1 (PLN ber-meteran).
    jml_meteran: (e) => (code(e, 'sumber_penerangan') === '1' ? true : undefined),
  };

  global.PDF_RULES = RULES;
})(window);
