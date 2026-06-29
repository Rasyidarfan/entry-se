'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  form: null,
  engine: null,
  blocks: [],
  pages: [],
  current: 0,
  assignment: null,
  assignmentId: null,   // current assignment (from ?assignment=)
  readOnly: false,      // true for mitra (and when no assignment context)
  rosterDrafts: { anggota: '', usaha: '' },
};

const MONTHS_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function deviceTimeValue(date = new Date()) {
  return `${pad2(date.getDate())} ${MONTHS_SHORT_ID[date.getMonth()]} ${date.getFullYear()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function photoPreviewHtml(field, value) {
  return value
    ? `<img class="fg-photo-preview" src="${esc(value)}" alt="${esc(field.label)}" />`
    : '<div class="fg-photo-empty">Belum ada foto</div>';
}

function normalizeRosterRows(ns) {
  const rows = state.engine.rowsOf(ns);
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') rows[index] = {};
    const current = rows[index];
    current.__order = index + 1;
    if (ns === 'anggota') {
      if (!current.nama_ak && current.nama_dtsen) current.nama_ak = current.nama_dtsen;
      if (current.no_urut_kk == null || current.no_urut_kk === '') current.no_urut_kk = index + 1;
    }
  });
}

function seedRosters(predefined) {
  const anggota = Array.isArray(predefined.roster_anggota) ? predefined.roster_anggota : null;
  const usaha = Array.isArray(predefined.roster_usaha) ? predefined.roster_usaha : null;
  if (anggota) {
    state.engine.rosters.anggota = anggota.map((m) => ({
      ...m,
      nama_dtsen: m.nama_dtsen || m.nama_ak || '',
      nama_ak: m.nama_ak || m.nama_dtsen || '',
      __isPrelist: String(m.is_prelist || '') === '1',
      __seededHead: false,
    }));
  } else if (predefined.is_keluarga === '1' || predefined.jenis_prelist === 'keluarga') {
    state.engine.rosters.anggota = [{
      nama_dtsen: predefined.nama_kk || 'Kepala Keluarga',
      nama_ak: predefined.nama_kk || 'Kepala Keluarga',
      hubungan: '1',
      __isPrelist: false,
      __seededHead: true,
    }];
  }
  if (usaha) {
    state.engine.rosters.usaha = usaha.map((u) => ({
      ...u,
      __isPrelist: String(u.is_prelist || '') === '1',
    }));
  }
  normalizeRosterRows('anggota');
  normalizeRosterRows('usaha');
}

function memberName(row, i) {
  return (row && (row.nama_dtsen || row.nama_ak)) || `Anggota ${i + 1}`;
}

function usahaName(row, i) {
  return (row && (row.nama_usaha_edit || row.nama_usaha_bang)) || `Usaha ${i + 1}`;
}

const NS_LABELS = {
  anggota: { single: 'Anggota Keluarga', add: 'Tambah Anggota Keluarga' },
  usaha: { single: 'Usaha', add: 'Tambah Usaha' },
};

function rowLabel(ns, row, i) {
  return ns === 'usaha' ? usahaName(row, i) : memberName(row, i);
}

function buildPages() {
  const pages = [];
  const nsFirstBlock = {};
  for (let b = 0; b < state.blocks.length; b++) {
    if (state.blocks[b].rowNamespace && !(state.blocks[b].rowNamespace in nsFirstBlock)) {
      nsFirstBlock[state.blocks[b].rowNamespace] = b;
    }
  }
  for (let b = 0; b < state.blocks.length; b++) {
    const block = state.blocks[b];
    const ns = block.rowNamespace;
    if (!ns) {
      pages.push({ kind: 'block', block: b, ns: null, row: null, name: block.name, sub: block.subtitle, label: null });
      continue;
    }
    if (nsFirstBlock[ns] === b) {
      pages.push({ kind: 'roster', block: b, ns, row: null, name: block.name, sub: block.subtitle, label: ns === 'usaha' ? 'Daftar Usaha' : 'Daftar Anggota' });
    }
    const rows = state.engine.rosters[ns] || [];
    rows.forEach((row, i) => {
      pages.push({ kind: 'row', block: b, ns, row: i, name: block.name, sub: block.subtitle, label: rowLabel(ns, row, i) });
    });
  }
  state.pages = pages;
  if (state.current >= pages.length) state.current = pages.length - 1;
}

function pageFields(page) {
  return state.blocks[page.block].fields;
}

function refreshRowLabels(ns, rowIndex) {
  state.pages.forEach((page) => {
    if (page.ns === ns && page.row === rowIndex) {
      page.label = rowLabel(ns, state.engine.rosters[ns][rowIndex], rowIndex);
    }
  });
}

function withPageRow(page, fn) {
  if (page.ns != null && page.row != null) {
    return state.engine.withRow(page.ns, page.row, fn);
  }
  return fn();
}

function addRosterRow(ns, initial = {}) {
  const rows = state.engine.rowsOf(ns);
  const row = { ...initial, __isPrelist: false, __seededHead: false };
  if (ns === 'anggota') {
    const name = String(initial.nama_dtsen || initial.nama_ak || '').trim();
    row.nama_dtsen = name;
    row.nama_ak = name;
    row.no_urut_kk = rows.length + 1;
  }
  rows.push(row);
  normalizeRosterRows(ns);
  state.rosterDrafts[ns] = '';
  buildPages();
  renderSidebar();
  const idx = state.pages.findIndex((p) => p.kind === 'row' && p.ns === ns && p.row === rows.length - 1);
  goTo(idx >= 0 ? idx : state.current);
}

function removeRosterRow(ns, rowIndex) {
  const rows = state.engine.rowsOf(ns);
  if (rowIndex < 0 || rowIndex >= rows.length) return;
  const label = rowLabel(ns, rows[rowIndex], rowIndex);
  if (!window.confirm(`Hapus "${label}" dari daftar? Semua jawaban untuk baris ini akan ikut terhapus.`)) return;
  rows.splice(rowIndex, 1);
  normalizeRosterRows(ns);
  buildPages();
  renderSidebar();
  const idx = state.pages.findIndex((p) => p.kind === 'roster' && p.ns === ns);
  goTo(idx >= 0 ? idx : 0);
}

const USAHA_LABEL_ACCENTS = {
  usaha_kos: { text: 'usaha penyewaan lahan atau kontrakan atau kos kosan', color: '#d97706' },
  usaha_keliling: { text: 'usaha keliling', color: '#d97706' },
  usaha_online: { text: 'usaha online', color: '#d97706' },
  usaha_bongkar: { text: 'usaha di luar tempat tinggal', color: '#d97706' },
  usaha_konstruksi: { text: 'usaha sebagai pemborong konstruksi/perusahaan konstruksi', color: '#d97706' },
  usaha_lain: { text: 'usaha lain', color: '#d97706' },
};

function fieldNameContext() {
  const namaKk = String(
    state.engine?.rawGet('nama_kk')
    || state.engine?.rawGet('nama')
    || state.assignment?.nama
    || ''
  ).trim();
  const name = String(state.engine?.rawGet('nama_dtsen') || state.engine?.rawGet('nama_ak') || '').trim();
  return {
    namaKK: namaKk || 'Kepala Keluarga',
    NAME: name || namaKk || '',
  };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveLabelContext(field) {
  const ctx = fieldNameContext();
  for (const item of field.labelVariables || []) {
    const variable = String(item?.variable || '').trim();
    const expr = String(item?.value || '');
    const match = expr.match(/getValue\('([^']+)'\)/);
    if (!variable || !match) continue;
    const value = String(state.engine?.rawGet(match[1]) || '').trim();
    if (value) ctx[variable] = value;
  }
  return ctx;
}

function applyUsahaAccent(field, html) {
  const accent = USAHA_LABEL_ACCENTS[field.dataKey];
  if (!accent || !html.includes(accent.text)) return html;
  return html.replace(accent.text, `<span style="color:${accent.color};font-weight:700">${accent.text}</span>`);
}

function formatFieldLabel(field) {
  const ctx = resolveLabelContext(field);
  let html = field.labelHtml || esc(field.label);
  for (const [name, value] of Object.entries(ctx)) {
    const safeValue = esc(value);
    html = html.replace(new RegExp(`\\$${escapeRegExp(name)}\\$`, 'g'), safeValue);
    html = html.replace(new RegExp(`\\$${escapeRegExp(name)}\\b`, 'g'), safeValue);
  }
  return applyUsahaAccent(field, html);
}

function syncFieldLabel(field, row) {
  const labelEl = row?.querySelector('.fl-text');
  if (!labelEl) return;
  const reqStar = field.required ? '<span class="fl-req">*</span>' : '';
  const next = `${formatFieldLabel(field)}${reqStar}`;
  if (labelEl.innerHTML !== next) labelEl.innerHTML = next;
}

// ---- control renderers (editable, bound to engine store) --------------------

function controlHtml(field, value, readOnly) {
  const ro = readOnly ? 'readonly' : '';
  const roAttr = readOnly ? 'disabled' : '';
  const v = value == null ? '' : value;

  // overrideType: render as text input regardless of original type
  const effectiveType = field.overrideType === 'text' ? 25 : field.type;

  // pengusaha dropdown: pick from anggota roster who has usaha
  if (field.dataKey === 'pengusaha') {
    const anggota = state.engine?.rosters?.anggota || [];
    const opts = anggota
      .map((a) => (a.nama_dtsen || a.nama_ak || '').trim())
      .filter(Boolean);
    if (opts.length) {
      return `<select class="fg-select" data-key="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>
        <option value="">— Pilih anggota —</option>
        ${opts.map((n) => `<option value="${esc(n)}" ${n === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>`;
    }
  }

  switch (effectiveType) {
    case 6: // action button
      return `<button type="button" class="fg-action" disabled>${esc(field.label || 'AKSI')}</button>`;
    case 26: // radio
    case 27: { // radio+
      if (!field.options.length) {
        return `<input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" />`;
      }
      return `<div class="fg-options">` + field.options.map((o) => {
        const checked = String(o.value) === String(v);
        return `<label class="fg-opt ${checked ? 'checked' : ''} ${readOnly ? 'locked' : ''}">
          <input type="radio" name="r_${esc(field.dataKey)}" value="${esc(o.value)}"
                 data-key="${esc(field.dataKey)}" ${checked ? 'checked' : ''} ${roAttr} hidden />
          <span class="fg-radio"></span>
          <span>${esc(o.label)}</span>
        </label>`;
      }).join('') + `</div>`;
    }
    case 30: // notes / textarea
      return `<textarea class="fg-textarea" data-key="${esc(field.dataKey)}" ${ro}
                placeholder="${readOnly ? '' : 'Tulis di sini…'}">${esc(v)}</textarea>`;
    case 35: // datetime
      return `<div class="datetime-control">
        <input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" placeholder="dd Mmm yyyy, hh:mm" />
        <button type="button" class="fg-device-time" data-device-time="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>Ambil waktu device</button>
      </div>`;
    case 33: // geo
      return `<div class="media-control">
        <input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" placeholder="Lat, Long" />
        <button type="button" class="fg-device-geo" data-device-geo="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>Ambil lokasi device</button>
      </div>`;
    case 32: { // photo
      return `<div class="photo-control">
        <input type="hidden" data-key="${esc(field.dataKey)}" value="${esc(v)}" />
        ${photoPreviewHtml(field, v)}
        <label class="fg-photo-btn ${readOnly ? 'disabled' : ''}">
          <input type="file" accept="image/*" capture="environment" data-photo-key="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''} hidden />
          <span>Input gambar</span>
        </label>
      </div>`;
    }
    case 28: // number
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" inputmode="numeric"
                ${ro} value="${esc(v)}" placeholder="${readOnly ? '' : '0'}" />`;
    case 24: // computed (e.g. thn_lahir) — numeric input
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" inputmode="numeric"
                ${ro} value="${esc(v)}" placeholder="${readOnly ? '' : 'cth. 1990'}" />`;
    default: // text (type 25) and overrideType='text'
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" ${ro}
                value="${esc(v)}" placeholder="${readOnly ? '' : 'Tulis di sini…'}" />`;
  }
}

function iconInput(field, v, readOnly, icon, ph) {
  const ro = readOnly ? 'readonly' : '';
  return `<div class="input-wrap">
    <span class="input-icon">${icon}</span>
    <input class="fg-input with-icon" data-key="${esc(field.dataKey)}" ${ro}
           value="${esc(v)}" placeholder="${readOnly ? '' : ph}" />
  </div>`;
}

// ---- field row --------------------------------------------------------------

function fieldRowHtml(field) {
  const engine = state.engine;
  const value = engine.rawGet(field.dataKey);
  // Global read-only (mitra) forces every field read-only; otherwise per-field.
  const readOnly = state.readOnly || engine.isReadOnly(field);
  const initialHidden = field.forceHidden || (!engine.isVisible(field) && field.conditional);

  if (field.type === 6) {
    return `<div class="field-row" data-field="${esc(field.dataKey)}"${initialHidden ? ' hidden' : ''}>
      <div></div>
      <div class="field-input">${controlHtml(field, value, readOnly)}</div>
      <div></div>
    </div>`;
  }

  const reqStar = field.required ? '<span class="fl-req">*</span>' : '';
  const hint = field.hint ? `<span class="fl-hint">${esc(field.hint)}</span>` : '';
  const lockBadge = readOnly ? '<span class="fl-lock">🔒 terkunci</span>' : '';
  const typeLabel = field.overrideType === 'text' ? 'text' : (field.typeName || '');

  return `<div class="field-row" data-field="${esc(field.dataKey)}"${initialHidden ? ' hidden' : ''}>
    <div class="field-label">
      <span class="fl-text">${formatFieldLabel(field)}${reqStar}</span>
      ${hint}
      ${lockBadge}
    </div>
    <div class="field-input">
      ${controlHtml(field, value, readOnly)}
      <div class="fg-msgs" data-msgs="${esc(field.dataKey)}"></div>
    </div>
    <div class="field-remark"><span class="fl-type" title="${esc(typeLabel)}">◉</span></div>
  </div>`;
}

// Update only the validation messages + visibility for the current block,
// without re-rendering inputs (so focus/caret is preserved while typing).
function refreshBlock() {
  const page = state.pages[state.current];
  if (page.kind === 'roster') { updateSidebarStatus(); return; }
  const engine = state.engine;
  withPageRow(page, () => {
    for (const field of pageFields(page)) {
      const row = document.querySelector(`.field-row[data-field="${cssEsc(field.dataKey)}"]`);
      if (!row) continue;
      const visible = engine.isVisible(field) && !field.forceHidden;
      row.hidden = !visible;
      if (visible) syncFieldLabel(field, row);
      if (visible) syncControlValue(field);
      const box = row.querySelector(`[data-msgs="${cssEsc(field.dataKey)}"]`);
      if (!box) continue;
      if (!visible) { box.innerHTML = ''; continue; }
      const res = engine.validateField(field);
      let html = '';
      for (const m of res.errors) html += `<div class="fg-msg err">⛔ ${esc(m)}</div>`;
      for (const m of res.warnings) html += `<div class="fg-msg warn">⚠️ ${esc(m)}</div>`;
      box.innerHTML = html;
      row.classList.toggle('has-error', res.errors.length > 0);
      row.classList.toggle('has-warn', res.errors.length === 0 && res.warnings.length > 0);
    }
  });
  updateSidebarStatus();
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function syncControlValue(field) {
  const value = state.engine.rawGet(field.dataKey);
  const effectiveType = field.overrideType === 'text' ? 25 : field.type;
  if ((effectiveType === 26 || effectiveType === 27) && field.dataKey !== 'pengusaha') {
    document.querySelectorAll(`input[data-key="${cssEsc(field.dataKey)}"]`).forEach((input) => {
      const checked = String(input.value) === String(value == null ? '' : value);
      input.checked = checked;
      input.closest('.fg-opt')?.classList.toggle('checked', checked);
    });
    return;
  }
  const input = document.querySelector(`[data-key="${cssEsc(field.dataKey)}"]`);
  const normalized = value == null ? '' : String(value);
  if (input && 'value' in input && input.value !== normalized) input.value = normalized;
  if (field.type === 32) {
    const row = document.querySelector(`.field-row[data-field="${cssEsc(field.dataKey)}"] .photo-control`);
    if (row) {
      const current = row.querySelector('.fg-photo-preview')?.getAttribute('src') || '';
      if (current !== normalized) {
        const preview = row.querySelector('.fg-photo-preview, .fg-photo-empty');
        if (preview) preview.outerHTML = photoPreviewHtml(field, normalized);
      }
    }
  }
}

// ---- block / page renderers -------------------------------------------------

function pageIssues(page) {
  if (page.kind === 'roster') return { err: 0, warn: 0, visible: 0 };
  return withPageRow(page, () => {
    let err = 0, warn = 0, visible = 0;
    for (const f of pageFields(page)) {
      if (f.type === 6) continue;
      if (!state.engine.isVisible(f)) continue;
      visible++;
      const r = state.engine.validateField(f);
      err += r.errors.length;
      warn += r.warnings.length;
    }
    return { err, warn, visible };
  });
}

function renderRosterList(page) {
  const block = state.blocks[page.block];
  const ns = page.ns;
  const rows = state.engine.rowsOf(ns);
  const intro = (block.htmlCards || []).map((html) => `<div class="intro-card">${html}</div>`).join('');
  const addValue = state.rosterDrafts[ns] || '';
  const items = rows.map((row, i) => {
    const { err, warn } = pageIssues({ kind: 'row', block: page.block, ns, row: i });
    const status = err ? '<span class="roster-badge err">galat</span>'
      : warn ? '<span class="roster-badge warn">peringatan</span>'
      : '<span class="roster-badge ok">lengkap</span>';
    return `<div class="roster-item">
      <div class="roster-item-main">
        <span class="roster-num">${i + 1}</span>
        <span class="roster-name">${esc(rowLabel(ns, row, i))}</span>
        ${status}
      </div>
      <div class="roster-item-actions">
        <button type="button" class="roster-open" data-roster-open="${ns}" data-row="${i}">Lihat</button>
        ${state.readOnly ? '' : `<button type="button" class="roster-remove" data-roster-remove="${ns}" data-row="${i}" aria-label="Hapus">Hapus</button>`}
      </div>
    </div>`;
  }).join('');
  const empty = rows.length ? '' : `<div class="roster-empty">Belum ada ${ns === 'usaha' ? 'usaha' : 'anggota keluarga'}. Klik tombol di bawah untuk menambah.</div>`;
  $('#formCard').innerHTML = `
    <div class="card-band">
      <div class="ttl">${esc(block.cardTitle)}</div>
    </div>
    <div class="card-band-rule"></div>
    ${intro}
    <div class="roster-head">
      <h3>${ns === 'usaha' ? 'Daftar Usaha/Perusahaan' : 'Daftar Anggota Keluarga'}</h3>
      <span class="roster-count">${rows.length} ${ns === 'usaha' ? 'usaha' : 'anggota'}</span>
    </div>
    <div class="roster-add-inline">
      <label class="roster-add-label" for="rosterDraft_${ns}">${ns === 'usaha' ? 'Nama usaha/perusahaan' : 'Nama anggota keluarga'}</label>
      <div class="roster-add-row">
        <input id="rosterDraft_${ns}" class="fg-input roster-draft-input" data-roster-draft="${ns}" value="${esc(addValue)}" placeholder="${ns === 'usaha' ? 'Tuliskan nama usaha/perusahaan' : 'Tuliskan nama anggota keluarga'}" ${state.readOnly ? 'readonly' : ''} />
        ${state.readOnly ? '' : `<button type="button" class="roster-add-inline-btn" data-roster-add="${ns}">＋ Tambah Baru</button>`}
      </div>
    </div>
    <div class="roster-list">${items}${empty}</div>
    ${!state.readOnly && ns === 'usaha' ? `<button type="button" class="roster-add" data-roster-add="${ns}">＋ ${esc(NS_LABELS[ns].add)}</button>` : ''}
  `;
}

function renderBlock(page) {
  if (page.kind === 'roster') { renderRosterList(page); updateSidebarStatus(); return; }
  const block = state.blocks[page.block];
  const rosterChip = page.ns
    ? `<div class="member-chip">${page.ns === 'usaha' ? 'Usaha' : 'Anggota Keluarga'}: <strong>${esc(page.label || '')}</strong>
        ${state.readOnly ? '' : `<button type="button" class="chip-remove" data-roster-remove="${page.ns}" data-row="${page.row}">Hapus baris</button>`}</div>`
    : '';
  withPageRow(page, () => {
    const intro = (block.htmlCards || [])
      .map((html) => `<div class="intro-card">${html}</div>`)
      .join('');
    const fields = block.fields.map(fieldRowHtml).join('') ||
      '<div class="loading">Tidak ada field input pada blok ini.</div>';
    $('#formCard').innerHTML = `
      <div class="card-band">
        <div class="ttl">${esc(block.cardTitle)}</div>
      </div>
      <div class="card-band-rule"></div>
      ${rosterChip}
      ${intro}
      ${fields}
    `;
  });
  refreshBlock();
}

function renderSidebar() {
  let html = '';
  let lastBlock = -1;
  state.pages.forEach((page, i) => {
    const block = state.blocks[page.block];
    if (page.ns) {
      if (page.block !== lastBlock) {
        html += `<div class="nav-group-head">${esc(block.name)}${block.subtitle ? `<span class="nav-group-sub">${esc(block.subtitle)}</span>` : ''}</div>`;
      }
      if (page.kind === 'roster') {
        html += `<button class="block-item roster-nav ${i === state.current ? 'active' : ''}" data-i="${i}">
          <span class="bi-row"><span class="bi-name">${page.ns === 'usaha' ? '🏪 Daftar Usaha' : '👪 Daftar Anggota'}</span>
          <span class="bi-count">${(state.engine.rosters[page.ns] || []).length}</span></span>
        </button>`;
      } else {
        html += `<button class="block-item member ${i === state.current ? 'active' : ''}" data-i="${i}">
          <span class="bi-row"><span class="bi-name member-name">${esc(page.label || '')}</span>
          <span class="bi-dot" data-dot="${i}"></span></span>
        </button>`;
      }
    } else {
      const sub = block.subtitle ? `<span class="bi-sub">${esc(block.subtitle)}</span>` : '';
      html += `<button class="block-item ${i === state.current ? 'active' : ''}" data-i="${i}">
        <span class="bi-row">
          <span class="bi-name">${esc(block.name)}</span>
          <span class="bi-dot" data-dot="${i}"></span>
        </span>
        ${sub}
      </button>`;
    }
    lastBlock = page.block;
  });
  $('#blockNav').innerHTML = html;
}

function updateSidebarStatus() {
  state.pages.forEach((page, i) => {
    const { err, warn } = pageIssues(page);
    const dot = document.querySelector(`[data-dot="${i}"]`);
    if (!dot) return;
    dot.className = 'bi-dot' + (err ? ' dot-err' : warn ? ' dot-warn' : '');
  });
}

function pageNavLabel(page) {
  if (!page) return '';
  return page.ns ? `${page.label}` : page.name;
}

function renderNav() {
  const page = state.pages[state.current];
  const prev = state.pages[state.current - 1];
  const next = state.pages[state.current + 1];
  $('#centerLabel').textContent = page.kind === 'roster'
    ? `${page.name} · ${page.label}`
    : (page.ns ? `${page.name} · ${page.label}` : page.name);

  const prevBtn = $('#prevBtn');
  if (prev) { prevBtn.hidden = false; $('#prevLabel').textContent = pageNavLabel(prev); }
  else prevBtn.hidden = true;

  const nextBtn = $('#nextBtn');
  if (next) { nextBtn.hidden = false; $('#nextLabel').textContent = pageNavLabel(next); }
  else nextBtn.hidden = true;
}

function goTo(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.current = i;
  renderSidebar();
  renderBlock(state.pages[i]);
  renderNav();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---- input handling ---------------------------------------------------------

function onInput(e) {
  const rosterDraft = e.target.closest('[data-roster-draft]');
  if (rosterDraft) {
    state.rosterDrafts[rosterDraft.dataset.rosterDraft] = rosterDraft.value;
    return;
  }
  const el = e.target.closest('[data-key]');
  if (!el) return;
  const key = el.dataset.key;
  let value;
  if (el.type === 'radio') {
    if (!el.checked) return;
    value = el.value;
    // reflect checked styling
    const group = el.closest('.fg-options');
    if (group) group.querySelectorAll('.fg-opt').forEach((lab) => {
      const input = lab.querySelector('input');
      lab.classList.toggle('checked', input && input.checked);
    });
  } else {
    value = el.value;
  }
  const page = state.pages[state.current];
  withPageRow(page, () => state.engine.setUserValue(key, value));
  const relabel = page.ns && /^(nama_dtsen|nama_ak|nama_usaha_edit|nama_usaha_bang)$/.test(key);
  if (relabel) {
    if (page.ns === 'anggota') state.engine.rosters.anggota[page.row].nama_ak = state.engine.rosters.anggota[page.row].nama_dtsen || '';
    refreshRowLabels(page.ns, page.row);
    renderSidebar();
    renderNav();
  }
  refreshBlock();
}

async function handleGeoPick(key) {
  if (!navigator.geolocation) throw new Error('Geolocation tidak didukung di device ini.');
  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
  const coords = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
  withPageRow(state.pages[state.current], () => state.engine.setUserValue(key, coords));
  refreshBlock();
}

async function handlePhotoPick(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Gagal membaca gambar.'));
    reader.readAsDataURL(file);
  });
  withPageRow(state.pages[state.current], () => state.engine.setUserValue(input.dataset.photoKey, dataUrl));
  refreshBlock();
}

// ---- summary modal ----------------------------------------------------------

function openSummary() {
  const s = flowSummary();
  $('#summaryCount').textContent = `${s.answered} Jawaban`;
  $('#sumError').textContent = String(s.errors);
  $('#sumWarn').textContent = String(s.warnings);
  $('#sumNote').textContent = String(s.notes);
  $('#sumEmpty').textContent = String(s.empty);
  $('#summaryModal').hidden = false;
}
function closeSummary() { $('#summaryModal').hidden = true; }

function flowSummary() {
  let errors = 0, warnings = 0, empty = 0, answered = 0;
  for (const page of state.pages) {
    if (page.kind === 'roster') continue;
    withPageRow(page, () => {
      for (const f of pageFields(page)) {
        if (f.type === 6) continue;
        if (!state.engine.isVisible(f)) continue;
        const v = state.engine.rawGet(f.dataKey);
        if (v !== undefined && v !== null && String(v).trim() !== '') answered++;
        else empty++;
        const res = state.engine.validateField(f);
        errors += res.errors.length;
        warnings += res.warnings.length;
      }
    });
  }
  return { errors, warnings, empty, answered, notes: 0 };
}

function serializeSubmissionAnswers() {
  return {
    ...state.engine.values,
    __rosters: state.engine.rosters,
  };
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  // Auth gate (§9.3): the form view is only reachable when logged in.
  if (!window.SE || !SE.requireAuth()) return;

  const user = SE.getUser();
  state.assignmentId = new URLSearchParams(location.search).get('assignment');
  // Mitra is always read-only (§1.1). Admin edits when an assignment is open.
  state.readOnly = !(user && user.role === 'admin');

  // Header chrome.
  $('#userBadge').textContent = user ? `${user.fullname || user.username} · ${user.role}` : '';
  $('#logoutBtn').addEventListener('click', () => SE.logout());
  if (state.readOnly) $('#readonlyBanner').hidden = false;

  try {
    const form = await SE.api('/api/form');
    state.form = form;
    state.blocks = form.blocks;

    // Per-assignment data: each assignment has its OWN predefined (prelist) and
    // its OWN answers. The global form.predefined (a demo family) is only used
    // when the form is opened without an assignment context.
    if (state.assignmentId) {
      let assignment = null;
      let submission = null;
      try {
        ({ assignment } = await SE.api(
          `/api/assignments/${encodeURIComponent(state.assignmentId)}`));
      } catch (e) { /* ignore */ }
      state.assignment = assignment;
      try {
        ({ submission } = await SE.api(
          `/api/assignments/${encodeURIComponent(state.assignmentId)}/submission`));
      } catch (e) { /* no submission yet */ }

      // Build the engine seeded with THIS assignment's predefined (locked
      // prelist fields), NOT the global template sample.
      const predefined = Object.assign({}, (assignment && assignment.predefined) || {});
      if (!predefined.nama_kk && assignment?.nama) predefined.nama_kk = assignment.nama;
      if (!predefined.nama && assignment?.nama) predefined.nama = assignment.nama;
      const seededForm = Object.assign({}, form, {
        predefined,
        locked: Object.keys(predefined).filter((key) => key !== 'kodepos'),
      });
      state.engine = new FormEngine(seededForm, window.PDF_RULES);

      seedRosters(predefined);

      // Overlay saved answers (the user's own work) on top of predefined.
      if (submission && submission.answers) {
        for (const [k, v] of Object.entries(submission.answers)) {
          if (k === '__rosters' && v && typeof v === 'object') {
            if (Array.isArray(v.anggota)) state.engine.rosters.anggota = v.anggota;
            if (Array.isArray(v.usaha)) state.engine.rosters.usaha = v.usaha;
            continue;
          }
          if (k.startsWith('__')) continue;
          state.engine.values[k] = v;
        }
        normalizeRosterRows('anggota');
        normalizeRosterRows('usaha');
        state.engine.recomputeHidden();
      }
    } else {
      // No assignment context (demo) → keep the template sample family.
      state.engine = new FormEngine(form, window.PDF_RULES);
    }

    document.title = `${form.meta.title} — FormGear`;
    $('#surveyTitle').textContent = form.meta.title;
    $('#sidebarTitle').textContent = form.meta.title;
    $('#surveyChip').textContent = form.meta.title;
    $('#periodChip').textContent = form.meta.period;

    // Admin with an assignment context gets Save / Submit buttons.
    if (!state.readOnly && state.assignmentId) {
      $('#saveBtn').hidden = false;
      $('#submitBtn').hidden = false;
      $('#saveBtn').addEventListener('click', () => saveSubmission('draft'));
      $('#submitBtn').addEventListener('click', () => saveSubmission('submitted'));
    }

    buildPages();
    renderSidebar();
    goTo(0);
  } catch (err) {
    $('#formCard').innerHTML = `<div class="loading">Gagal memuat form: ${esc(err.message)}</div>`;
  }
}

// Persist the current answers to the backend (admin only).
async function saveSubmission(status) {
  const statusEl = $('#saveStatus');
  statusEl.hidden = false;
  statusEl.className = 'save-status';
  statusEl.textContent = status === 'submitted' ? 'Submit…' : 'Menyimpan…';
  try {
    const res = await SE.api(
      `/api/assignments/${encodeURIComponent(state.assignmentId)}/submission`,
      { method: 'PUT', body: JSON.stringify({ answers: serializeSubmissionAnswers(), status }) }
    );
    const s = res.summary || {};
    statusEl.className = 'save-status ok';
    statusEl.textContent =
      `Tersimpan (${res.status}). Galat: ${s.errors || 0}, Peringatan: ${s.warnings || 0}, Terisi: ${s.answered || 0}.`;
  } catch (err) {
    statusEl.className = 'save-status err';
    statusEl.textContent = 'Gagal: ' + (err.message || 'kesalahan');
  }
}

document.addEventListener('click', (e) => {
  const timeBtn = e.target.closest('[data-device-time]');
  if (timeBtn) {
    state.engine.setUserValue(timeBtn.dataset.deviceTime, deviceTimeValue());
    refreshBlock();
    return;
  }
  const geoBtn = e.target.closest('[data-device-geo]');
  if (geoBtn) {
    handleGeoPick(geoBtn.dataset.deviceGeo).catch((err) => alert(err.message || 'Gagal mengambil lokasi.'));
    return;
  }
  const add = e.target.closest('[data-roster-add]');
  if (add) {
    const ns = add.dataset.rosterAdd;
    const typed = String(state.rosterDrafts[ns] || '').trim();
    if (ns === 'anggota') {
      if (!typed) { alert('Isi nama anggota keluarga baru terlebih dahulu.'); return; }
      if (!/^[A-Za-z ]+$/.test(typed)) { alert('Nama anggota keluarga hanya boleh berisi huruf dan spasi.'); return; }
      addRosterRow(ns, { nama_dtsen: typed, nama_ak: typed });
      return;
    }
    addRosterRow(ns);
    return;
  }
  const open = e.target.closest('[data-roster-open]');
  if (open) {
    const ns = open.dataset.rosterOpen;
    const row = Number(open.dataset.row);
    const idx = state.pages.findIndex((p) => p.kind === 'row' && p.ns === ns && p.row === row);
    if (idx >= 0) goTo(idx);
    return;
  }
  const remove = e.target.closest('[data-roster-remove]');
  if (remove) {
    removeRosterRow(remove.dataset.rosterRemove, Number(remove.dataset.row));
    return;
  }
  const item = e.target.closest('.block-item');
  if (item) goTo(Number(item.dataset.i));
});
// `input` for text/number/textarea, `change` for radios.
$('#formCard') && document.getElementById('formCard').addEventListener('input', onInput);
document.getElementById('formCard').addEventListener('change', onInput);
document.getElementById('formCard').addEventListener('change', (e) => {
  const fileInput = e.target.closest('[data-photo-key]');
  if (fileInput) handlePhotoPick(fileInput).catch((err) => alert(err.message || 'Gagal membaca gambar.'));
});
$('#prevBtn').addEventListener('click', () => goTo(state.current - 1));
$('#nextBtn').addEventListener('click', () => goTo(state.current + 1));
$('#summaryBtn').addEventListener('click', openSummary);
$('#modalClose').addEventListener('click', closeSummary);
$('#summaryModal').addEventListener('click', (e) => {
  if (e.target.id === 'summaryModal') closeSummary();
});

// ── Mobile sidebar toggle ─────────────────────────────────────────────────────
(function () {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!toggle || !sidebar || !overlay) return;
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('open');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }
  toggle.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  overlay.addEventListener('click', closeSidebar);
  // Close sidebar when a nav item is tapped on mobile.
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.block-item') && window.innerWidth <= 900) closeSidebar();
  });
})();

boot();
