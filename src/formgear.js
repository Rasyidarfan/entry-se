// FormGear parser: turns template.json + validation.json into a structure the
// frontend can render, and fills every input field with a plausible dummy value.

// Component type ids used by FASIH FormGear templates.
const TYPE = {
  BLOCK: 1,        // section / block container
  HTML: 3,         // rich-text / styled HTML content (intro cards, hidden css)
  HIDDEN: 4,       // hidden variable (mode, is_cawi, etc.)
  ACTION: 6,       // button (e.g. CEK NIK)
  INNER: 20,       // inner/nested group
  TEXT: 25,        // free text input
  RADIO: 26,       // single choice (radio)
  RADIO_PLUS: 27,  // single choice with extra/open option
  NUMBER: 28,      // numeric input
  TABLE: 29,       // tabular / roster
  NOTES: 30,       // long text / textarea
  PHOTO: 32,       // photo capture
  GEO: 33,         // geotagging
  COMPUTED: 24,    // computed/expression field (e.g. thn_lahir, tahun_operasi)
  TIME: 35,        // date-time picker
};

// Types that become a visible input row on the form.
const INPUT_TYPES = new Set([TYPE.ACTION, TYPE.TEXT, TYPE.RADIO, TYPE.RADIO_PLUS, TYPE.NUMBER, TYPE.NOTES, TYPE.PHOTO, TYPE.GEO, TYPE.TIME, TYPE.COMPUTED]);

const TYPE_NAME = {
  6: 'action', 24: 'computed', 25: 'text', 26: 'radio', 27: 'radio+', 28: 'number',
  30: 'notes', 32: 'photo', 33: 'geo', 35: 'datetime',
};

// Fields to always hide (removed from FASIH mobile UI per design spec).
const FORCE_HIDDEN = new Set([
  // BLOK II usaha: kantor pusat / unit fields
  'kp_unit', 'kp_jenis', 'kp_prov', 'kp_kab',
  // BLOK II: kawasan (except jenis_kawasan which stays)
  'nama_kek_ki', 'nama_kawasan',
  // BLOK II: CEK NIB button, KBLI GenAI button, PML-only checks
  'cek_nib', 'genai_button', 'cek_kbli_pml',
  'cek_asetThn_pml', 'cek_output26f_pml', 'cek_input27c_pml',
  'cek_asetBln_pml', 'cek_output30f_pml', 'cek_input31c_pml',
  'cek_tk_jk_pml', 'cek_tk_bayar_pml',
]);

// FASIH substitutes a few literal tokens at runtime. Replace them so the demo
// reads like the live app instead of showing raw template placeholders.
const TOKEN_SUBS = [
  [/\$ket\b/g, ''],
  [/\$hide_on_cawi\b/g, ''],
  [/\$hide\b/g, ''],
];
function applyTokens(s) {
  let out = String(s || '');
  for (const [re, rep] of TOKEN_SUBS) out = out.replace(re, rep);
  return out;
}

function decodeEntities(s) {
  return applyTokens(String(s || ''))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function sanitizeLabelHtml(raw) {
  return decodeEntities(raw)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<small[\s\S]*?<\/small>/gi, ' ')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(<br\s*\/?>\s*)+$/gi, '')
    .trim();
}

// Strip HTML to a plain label, but keep a hint line if the template embeds a
// small orange note (the FASIH "$ket" helper text).
function parseLabel(raw) {
  const text = decodeEntities(raw);
  // Split the main label from any <small>/<br> helper text.
  const brSplit = text.split(/<br\s*\/?>/i);
  const main = stripTags(brSplit[0]);
  let hint = '';
  if (brSplit.length > 1) {
    hint = stripTags(brSplit.slice(1).join(' '));
  }
  // Pull <small>...</small> as hint if present in the main part.
  const smallMatch = text.match(/<small[^>]*>([\s\S]*?)<\/small>/i);
  if (smallMatch && !hint) hint = stripTags(smallMatch[1]);
  return {
    label: main.trim(),
    hint: hint.trim(),
    labelHtml: sanitizeLabelHtml(brSplit[0]),
  };
}

function stripTags(s) {
  return decodeEntities(String(s || ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only keep "real" HTML content cards (intro text), not the css-only / hidden
// blocks the template uses to toggle field visibility.
function extractHtmlCard(raw, hasEnableCondition) {
  // Conditionally-shown HTML blocks are almost always visibility-control hacks
  // (e.g. css_hidden / pml_hidden) — skip them.
  if (hasEnableCondition) return null;
  const text = decodeEntities(raw);
  const withoutStyle = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  const plain = stripTags(withoutStyle);
  if (plain.length < 60) return null; // css-only / control block
  // Drop blocks that are full HTML documents used purely for styling.
  if (/<!DOCTYPE|<html/i.test(text) && plain.length < 200) return null;
  // Keep a safe subset of tags for display.
  const safe = withoutStyle
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '');
  return safe.trim();
}

// Many radio fields reference a `sourceOption` (the dataKey of a hidden type-4
// variable whose `expression` returns an array of {value,label}). We can't run
// that JS, but we can pull the option literals out of the expression text.
function parseOptionLiterals(expression) {
  if (!expression) return [];
  const out = [];
  const seen = new Set();
  const re = /\{\s*['"]value['"]\s*:\s*['"]([^'"]*)['"]\s*,\s*['"]label['"]\s*:\s*['"]([^'"]*)['"]\s*\}/g;
  let m;
  while ((m = re.exec(expression))) {
    const value = m[1];
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: m[2] });
  }
  return out;
}

// Walk the whole template once, collecting sourceOption definitions.
function buildOptionSources(template) {
  const map = new Map();
  const walk = (groups) => {
    for (const group of groups || []) {
      for (const item of group || []) {
        if (!item || typeof item !== 'object') continue;
        if (item.dataKey && item.expression && item.type === TYPE.HIDDEN) {
          const opts = parseOptionLiterals(item.expression);
          if (opts.length) map.set(item.dataKey, opts);
        }
        if (item.components) walk(item.components);
      }
    }
  };
  walk(template.components);
  return map;
}

// Hidden (type-4) variables with an `expression` are computed values the visible
// fields read via getValue(). Export them so the engine can recompute them
// whenever an answer changes (e.g. ec_keluarga, ec_non_keluarga, is_usaha).
function buildHiddenVars(template) {
  const vars = [];
  const walk = (groups) => {
    for (const group of groups || []) {
      for (const item of group || []) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === TYPE.HIDDEN && item.dataKey && item.expression) {
          vars.push({ dataKey: item.dataKey, expression: item.expression });
        }
        if (item.components) walk(item.components);
      }
    }
  };
  walk(template.components);
  return vars;
}

// ---- Validation map ---------------------------------------------------------
// Each entry carries the raw `test` expression so the browser engine can run it
// live. `type` 2 = error (galat), 1 = warning (peringatan).

function buildValidationMap(validation) {
  const map = new Map();
  for (const rule of (validation && validation.testFunctions) || []) {
    const messages = (rule.validations || [])
      .map((v) => ({ message: v.message, type: v.type, test: v.test }))
      .filter((v) => v.message || v.test);
    if (!messages.length) continue;
    const deps = rule.componentValidation || [];
    const entry = { messages, deps };
    if (map.has(rule.dataKey)) {
      const prev = map.get(rule.dataKey);
      prev.messages.push(...messages);
      prev.deps = [...new Set([...prev.deps, ...deps])];
    } else {
      map.set(rule.dataKey, entry);
    }
  }
  return map;
}

// ---- Traversal --------------------------------------------------------------

function collectFields(components, ctx, acc, htmlCards) {
  const { valMap, optionSources, rowNamespace } = ctx;
  for (const group of components || []) {
    for (const item of group || []) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === TYPE.BLOCK || item.type === TYPE.INNER) {
        // nested group: recurse but keep flat field list per block
        collectFields(item.components, ctx, acc, htmlCards);
        continue;
      }

      if (item.type === TYPE.HTML) {
        if (String(item.label || '').includes('CEK NIK')) continue;
        const card = extractHtmlCard(item.label, !!item.enableCondition);
        if (card) htmlCards.push(card);
        continue;
      }

      if (item.type === TYPE.HIDDEN) continue;

      if (INPUT_TYPES.has(item.type)) {
        if (item.type === TYPE.ACTION && /CEK NIK/i.test(String(item.label || ''))) continue;
        // Skip COMPUTED fields that are not the ones we want to show
        if (item.type === TYPE.COMPUTED && item.dataKey !== 'thn_lahir' && item.dataKey !== 'tahun_operasi') continue;
        let options = (item.options || []).map((o) => ({
          value: o.value,
          label: stripTags(o.label),
        }));
        // Resolve options that come from a named source expression.
        if (!options.length && item.sourceOption && optionSources.has(item.sourceOption)) {
          options = optionSources.get(item.sourceOption);
        }
        options = sortOptions(options);
        const parsed = parseLabel(item.label);
        const rule = valMap.get(item.dataKey);
        const field = {
          dataKey: item.dataKey || '',
          type: item.type,
          typeName: TYPE_NAME[item.type] || `type${item.type}`,
          label: parsed.label || item.dataKey || '',
          labelHtml: parsed.labelHtml || '',
          hint: parsed.hint,
          required: !!item.required,
          // Raw FormGear expressions, run live in the browser engine.
          enableCondition: item.enableCondition || null,
          readOnlyCondition: item.readOnlyCondition || null,
          conditional: !!item.enableCondition,
          inputMode: item.inputMode || null,
          currency: !!item.currency,
          isDecimal: !!item.isDecimal,
          lengthInput: item.lengthInput || null,
          // Roster namespace: member-scoped (anggota) / business-scoped (usaha)
          // fields are repeated per row by the flow builder.
          rowNamespace: rowNamespace || null,
          labelVariables: Array.isArray(item.labelVariable) ? item.labelVariable : [],
          options,
          // Validation rules with raw test expressions + dependency keys.
          rules: rule ? rule.messages : [],
          ruleDeps: rule ? rule.deps : [],
        };
        applyFieldOverrides(field);
        acc.push(field);
      }

      if (item.components && item.components.length) {
        collectFields(item.components, ctx, acc, htmlCards);
      }
    }
  }
}

function sortOptions(options) {
  if (!Array.isArray(options) || options.length < 2) return options;
  const numeric = options.every((o) => /^-?\d+(\.\d+)?$/.test(String(o.value ?? '').trim()));
  return [...options].sort((a, b) => {
    if (numeric) return Number(a.value) - Number(b.value);
    return String(a.label || a.value || '').localeCompare(String(b.label || b.value || ''), 'id');
  });
}

function applyFieldOverrides(field) {
  if (field.hint === 'Perbaiki jika terdapat kesalahan penulisan') {
    field.hint = '';
  }
  if (field.dataKey === 'alamat_prelist') {
    field.label = 'Alamat lengkap';
  }
  // Force-hide fields removed from mobile UI
  if (FORCE_HIDDEN.has(field.dataKey)) {
    field.forceHidden = true;
  }
  // nib: always visible when punya_nib=1 (remove its enableCondition gate so
  // it renders; the engine's own condition still controls runtime visibility)
  if (field.dataKey === 'nib') {
    field.alwaysRender = true;
  }
  // kbli_genai: show as plain text input (not sourceOption radio)
  if (field.dataKey === 'kbli_genai') {
    field.overrideType = 'text';
  }
  // pengusaha_var: this is the dropdown variant — skip in favour of pengusaha
  if (field.dataKey === 'pengusaha_var') {
    field.forceHidden = true;
  }
  // profesi: show as text input even though it's RADIO_PLUS with many options
  // (mobile spec: free-text entry for Profesi Pekerjaan Utama in BLOK III)
  if (field.dataKey === 'profesi') {
    field.overrideType = 'text';
  }
}

function filterBlockFields(blockKey, fields) {
  if (blockKey === 'b0') {
    return fields.filter((field) => field.dataKey === 'mulai');
  }
  if (blockKey === 'b1_p') {
    const keep = new Set(['prov', 'kab', 'kec', 'desa', 'kode_sls', 'nama_sls', 'kodepos']);
    return fields.filter((field) => keep.has(field.dataKey));
  }
  return fields;
}

function injectRosterFields(blockKey, fields) {
  if (blockKey !== 'b_ak') return fields;
  const extras = [
    {
      dataKey: 'no_urut_kk',
      type: TYPE.NUMBER,
      typeName: TYPE_NAME[TYPE.NUMBER] || 'number',
      label: '5. Nomor urut anggota keluarga',
      labelHtml: '5. Nomor urut anggota keluarga',
      hint: '',
      required: false,
      enableCondition: null,
      readOnlyCondition: 'true',
      conditional: false,
      inputMode: 'numeric',
      currency: false,
      isDecimal: false,
      lengthInput: null,
      rowNamespace: 'anggota',
      labelVariables: [],
      options: [],
      rules: [],
      ruleDeps: [],
    },
    {
      dataKey: 'nama_dtsen',
      type: TYPE.TEXT,
      typeName: TYPE_NAME[TYPE.TEXT] || 'text',
      label: '6. Nama anggota keluarga',
      labelHtml: '6. Nama anggota keluarga',
      hint: '',
      required: true,
      enableCondition: null,
      readOnlyCondition: null,
      conditional: false,
      inputMode: null,
      currency: false,
      isDecimal: false,
      lengthInput: null,
      rowNamespace: 'anggota',
      labelVariables: [],
      options: [],
      rules: [],
      ruleDeps: [],
    },
  ];
  return [...extras, ...fields.filter((field) => !extras.some((extra) => extra.dataKey === field.dataKey))];
}

export function buildForm(template, validation) {
  const valMap = buildValidationMap(validation);
  const optionSources = buildOptionSources(template);
  const hiddenVars = buildHiddenVars(template);
  const blocks = [];

  // Blocks whose questions are asked once per family member / per business.
  const ROSTER_BLOCKS = {
    b_ak: 'anggota',          // BLOK I  — keterangan anggota keluarga
    b_ak_lanjutan: 'anggota', // BLOK III — sosial ekonomi anggota keluarga
    blokl: 'usaha',           // BLOK II — keterangan usaha/perusahaan
  };

  for (const group of template.components || []) {
    for (const item of group || []) {
      if (item.type !== TYPE.BLOCK) continue;
      if (item.dataKey === 'anomali_section') continue;
      const rowNamespace = ROSTER_BLOCKS[item.dataKey] || null;
      const ctx = { valMap, optionSources, rowNamespace };
      const fields = [];
      const htmlCards = [];
      collectFields(item.components, ctx, fields, htmlCards);
      const filteredFields = injectRosterFields(item.dataKey, filterBlockFields(item.dataKey, fields));
      // Title shown inside the orange card (image 3 uses a friendlier label).
      const titleOverrides = {
        b5: 'KETERANGAN KELUARGA DAN USAHA',
        b1_p: 'BLOK I. IDENTITAS WILAYAH',
      };
      blocks.push({
        dataKey: item.dataKey,
        name: stripTags(item.label),
        cardTitle: titleOverrides[item.dataKey] || stripTags(item.label),
        subtitle: blockSubtitle(item.dataKey),
        rowNamespace,
        htmlCards,
        fields: filteredFields,
      });
    }
  }

  const ruleCount = [...valMap.values()].reduce((n, e) => n + e.messages.length, 0);
  return {
    meta: {
      title: stripTags(template.title) || 'SENSUS EKONOMI 2026',
      version: template.version,
      period: '09 Mei 2026 – 31 Agt 2026',
      blockCount: blocks.length,
      fieldCount: blocks.reduce((n, b) => n + b.fields.length, 0),
      ruleCount,
    },
    // Predefined "keluarga" sample + locked-field list (PDF bold + BPS-filled).
    predefined: PREDEFINED_VALUES,
    locked: LOCKED_KEYS,
    // Computed hidden variables read by getValue() inside conditions.
    hiddenVars,
    blocks,
  };
}

// ---- Predefined keluarga sample --------------------------------------------
// One example family. Bold fields in the SE2026-L PDF and "[Kode diisi oleh BPS]"
// fields are pre-filled and locked; everything else starts blank for the user.

const PREDEFINED_VALUES = {
  // engine control
  mode: 'CAPI',
  is_prelist: '1',
  is_keluarga: '1',
  jenis_prelist: 'keluarga',
  // Blok identitas wilayah (diisi BPS / prelist)
  prov: '[97] PAPUA PEGUNUNGAN',
  kab: '[02] JAYAWIJAYA',
  kec: '[150] HUBIKIAK',
  desa: '[007] LIKINO',
  klas_desa: 'Perdesaan',
  kode_sls: '000200',
  nama_sls: 'RT 002',
  kodepos: '99999',
  // Blok SE2026-P / Blok I keluarga (predefined bold)
  no_kk: '9102441210180002',
  nik: '9102440607900006',
  nama_kk: 'MAEL WENDA',
  nama_ak_lain: 'MIRA KOGOYA',
  jumlah_usaha_prelist: '3',
  jumlah_ak_kk: '3',
  // survey timing
  mulai: '24 Juni 2026, 14:52:59',
  kunjungan_1: '27 Juni 2026, 15:56:47',
};

// Keys the user cannot edit (predefined / diisi BPS). Region + family identity.
const LOCKED_KEYS = [
  'prov', 'kab', 'kec', 'desa', 'klas_desa', 'kode_sls', 'nama_sls',
  'no_kk', 'nik', 'nama_kk', 'nama_ak_lain', 'jumlah_usaha_prelist',
  'jenis_prelist', 'mulai', 'kunjungan_1',
];

// Sidebar sub-labels matching the FASIH screenshots.
function blockSubtitle(dataKey) {
  const map = {
    b1_p: 'BLOK I. IDENTITAS WILAYAH',
    b5: 'KETERANGAN KELUARGA DAN BANGUNAN',
  };
  return map[dataKey] || '';
}
