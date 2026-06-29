'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  access: '',
  token: '',
  form: null,
  engine: null,
  blocks: [],
  pages: [],        // flattened navigation pages (intro blocks + per-member/usaha)
  current: 0,       // index into state.pages
  assignment: null,
  submission: null,
  gateMode: 'loading',
  sequence: 0,
  rosterDrafts: { anggota: '', usaha: '' },
};

const RESP_PREFIX = 'se_respondent_';
const DRAFT_PREFIX = 'se_respondent_draft_';
const DB_NAME = 'se2026-offline';
const DB_VERSION = 1;
const STORE_NAME = 'pending_chunks';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tokenKey() { return RESP_PREFIX + state.access; }
function draftKey() { return DRAFT_PREFIX + (state.assignment?.id || state.access); }

function getStoredToken() { return localStorage.getItem(tokenKey()) || ''; }
function setStoredToken(token) { localStorage.setItem(tokenKey(), token); }
function clearStoredToken() { localStorage.removeItem(tokenKey()); }
function saveLocalDraft() {
  if (!state.engine || !state.assignment) return;
  localStorage.setItem(draftKey(), JSON.stringify({
    values: state.engine.values,
    rosters: state.engine.rosters,
  }));
}
function loadLocalDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || '{}'); } catch { return {}; }
}
function clearLocalDraft() {
  if (state.assignment) localStorage.removeItem(draftKey());
}

function normalizeRosterRows(ns) {
  const rows = state.engine.rowsOf(ns);
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') rows[index] = {};
    const current = rows[index];
    current.__order = index + 1;
    if (ns === 'anggota' && !current.nama_ak && current.nama_dtsen) current.nama_ak = current.nama_dtsen;
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('assignment_id', 'assignment_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = run(store, resolve, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueChunk(item) {
  return withStore('readwrite', (store) => store.put(item));
}

async function readQueuedChunks() {
  return withStore('readonly', (store, resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
}

async function removeQueuedChunk(id) {
  return withStore('readwrite', (store) => store.delete(id));
}

async function api(path, opts = {}, token = state.token) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

function gateError(message) {
  $('#gateError').textContent = message;
  $('#gateError').hidden = false;
}

function clearGateError() {
  $('#gateError').hidden = true;
  $('#gateError').textContent = '';
}

function setStatus(message, kind = '') {
  const el = $('#saveStatus');
  el.hidden = false;
  el.className = 'save-status' + (kind ? ` ${kind}` : '');
  el.textContent = message;
}

function clearSession() {
  clearStoredToken();
  clearLocalDraft();
  state.token = '';
  $('#clearRespondentSessionBtn').hidden = true;
}

function setGateOnlyMode(enabled) {
  document.body.classList.toggle('gate-only', enabled);
}

function renderGate(mode, payload) {
  setGateOnlyMode(true);
  state.gateMode = mode;
  const assignment = payload.assignment;
  $('#gateTypeChip').textContent = assignment.prelist_type === 'usaha' ? 'Kuesioner Usaha' : 'Kuesioner Keluarga';
  $('#gateTitle').textContent = assignment.nama || 'Responden';
  $('#gateSubtitle').textContent = mode === 'setup'
    ? 'Buat PIN 6 digit untuk membuka dan melanjutkan kuesioner.'
    : 'Masukkan PIN 6 digit untuk melanjutkan pengisian draft terakhir.';
  $('#gateForm').innerHTML = mode === 'setup'
    ? `
      <div class="pin-field">
        <span class="pin-label">PIN 6 digit</span>
        ${pinBoxesHtml('pin')}
        <input id="pinInput" type="hidden" />
      </div>
      <div class="pin-field">
        <span class="pin-label">Ulangi PIN</span>
        ${pinBoxesHtml('pinConfirm')}
        <input id="pinConfirmInput" type="hidden" />
      </div>`
    : `
      <div class="pin-field">
        <span class="pin-label">PIN 6 digit</span>
        ${pinBoxesHtml('pin')}
        <input id="pinInput" type="hidden" />
      </div>`;
  $('#gateSubmitBtn').textContent = mode === 'setup' ? 'Buat PIN & Mulai' : 'Masuk';
  setupPinGroup('pin', 'pinInput', true);
  if (mode === 'setup') setupPinGroup('pinConfirm', 'pinConfirmInput', false);
  // Final focus must stay on the first PIN row in setup mode.
  const initialBox = document.querySelector('[data-pin="pin"][data-i="0"]');
  if (initialBox) requestAnimationFrame(() => initialBox.focus());
}

// Render six single-digit boxes for a PIN group.
function pinBoxesHtml(group) {
  let html = `<div class="pin-boxes" data-pin-group="${esc(group)}">`;
  for (let i = 0; i < 6; i++) {
    html += `<input class="pin-box" data-pin="${esc(group)}" data-i="${i}"
                    inputmode="numeric" maxlength="1" autocomplete="off"
                    aria-label="Digit ${i + 1}" />`;
  }
  return html + '</div>';
}

// Wire auto-advance / backspace / paste behaviour and mirror into the hidden input.
function setupPinGroup(group, hiddenId, autoFocus = true) {
  const boxes = Array.from(document.querySelectorAll(`[data-pin="${group}"]`));
  const hidden = document.getElementById(hiddenId);
  const sync = () => { hidden.value = boxes.map((b) => b.value).join(''); };
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      box.classList.toggle('filled', !!box.value);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      sync();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        boxes[i - 1].focus();
        boxes[i - 1].value = '';
        boxes[i - 1].classList.remove('filled');
        sync();
      } else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      else if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      else if (e.key === 'Enter') { e.preventDefault(); onGateSubmit(); }
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6).split('');
      boxes.forEach((b, j) => {
        b.value = digits[j] || '';
        b.classList.toggle('filled', !!b.value);
      });
      sync();
      const next = Math.min(digits.length, boxes.length - 1);
      boxes[next].focus();
    });
  });
  if (autoFocus && boxes[0]) boxes[0].focus();
}

async function loadGate() {
  clearGateError();
  const accessInfo = await api('/api/respondent/access/' + encodeURIComponent(state.access), {}, '');
  state.assignment = accessInfo.assignment;
  state.submission = accessInfo.submission;
  const stored = getStoredToken();
  if (stored) {
    try {
      state.token = stored;
      const session = await api('/api/respondent/session');
      await startFormSession(session);
      return;
    } catch {
      clearStoredToken();
      state.token = '';
    }
  }
  renderGate(accessInfo.assignment.pin_is_set && !accessInfo.assignment.pin_reset_required ? 'login' : 'setup', accessInfo);
}

// ── Flow builder ─────────────────────────────────────────────────────────────
// Expand blocks into a flat list of navigation pages. Non-roster blocks become a
// single page; roster blocks (anggota / usaha) become one page per row so the
// per-member questions of Blok I & III and per-usaha questions of Blok II appear
// in the order the spec describes.

// Seed engine rosters from the assignment's predefined block. `roster_anggota`
// and `roster_usaha` (if present) are arrays of {dataKey: value} maps describing
// pre-listed family members / businesses; the user fills the rest.
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
  // Track the first block index that owns each namespace so the roster overview
  // (the add/remove list) is shown once even though two blocks share `anggota`.
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
    // Roster overview page (only on the namespace's first block).
    if (nsFirstBlock[ns] === b) {
      pages.push({ kind: 'roster', block: b, ns, row: null, name: block.name, sub: block.subtitle,
        label: ns === 'usaha' ? 'Daftar Usaha' : 'Daftar Anggota' });
    }
    const rows = state.engine.rosters[ns] || [];
    rows.forEach((row, i) => {
      pages.push({ kind: 'row', block: b, ns, row: i, name: block.name, sub: block.subtitle, label: rowLabel(ns, row, i) });
    });
  }
  state.pages = pages;
  if (state.current >= pages.length) state.current = pages.length - 1;
}

// ── Roster add / remove ───────────────────────────────────────────────────────
function addRosterRow(ns, initial = {}) {
  const rows = state.engine.rowsOf(ns);
  const row = { ...initial, __isPrelist: false, __seededHead: false };
  if (ns === 'anggota') {
    const name = String(initial.nama_dtsen || initial.nama_ak || '').trim();
    row.nama_dtsen = name;
    row.nama_ak = name;
  }
  rows.push(row);
  normalizeRosterRows(ns);
  state.rosterDrafts[ns] = '';
  saveLocalDraft();
  buildPages();
  renderSidebar();
  // Jump straight into the newly added row's first block page.
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
  saveLocalDraft();
  buildPages();
  renderSidebar();
  // Land on the roster overview for this namespace.
  const idx = state.pages.findIndex((p) => p.kind === 'roster' && p.ns === ns);
  goTo(idx >= 0 ? idx : 0);
}

function pageFields(page) {
  return state.blocks[page.block].fields;
}

// Run a callback with the engine bound to the page's row context (if any).
function withPageRow(page, fn) {
  if (page.ns != null && page.row != null) {
    return state.engine.withRow(page.ns, page.row, fn);
  }
  return fn();
}

const MONTHS_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'];

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

function controlHtml(field, value, readOnly) {
  const ro = readOnly ? 'readonly' : '';
  const roAttr = readOnly ? 'disabled' : '';
  const v = value == null ? '' : value;
  const effectiveType = field.overrideType === 'text' ? 25 : field.type;

  // pengusaha: dropdown from anggota roster
  if (field.dataKey === 'pengusaha') {
    const anggota = state.engine?.rosters?.anggota || [];
    const opts = anggota.map((a) => (a.nama_dtsen || a.nama_ak || '').trim()).filter(Boolean);
    if (opts.length) {
      return `<select class="fg-select" data-key="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>
        <option value="">— Pilih anggota —</option>
        ${opts.map((n) => `<option value="${esc(n)}" ${n === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>`;
    }
  }

  switch (effectiveType) {
    case 6: // action button
      return `<button type="button" class="fg-action" disabled>${esc(field.label)}</button>`;
    case 26:
    case 27:
      if (!(field.options || []).length) {
        return `<input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" />`;
      }
      return `<div class="fg-options">` + (field.options || []).map((o) => {
        const checked = String(o.value) === String(v);
        return `<label class="fg-opt ${checked ? 'checked' : ''} ${readOnly ? 'locked' : ''}">
          <input type="radio" name="r_${esc(field.dataKey)}" value="${esc(o.value)}"
                 data-key="${esc(field.dataKey)}" ${checked ? 'checked' : ''} ${roAttr} hidden />
          <span class="fg-radio"></span>
          <span>${esc(o.label)}</span>
        </label>`;
      }).join('') + '</div>';
    case 30:
      return `<textarea class="fg-textarea" data-key="${esc(field.dataKey)}" ${ro}>${esc(v)}</textarea>`;
    case 28:
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" inputmode="numeric" ${ro} value="${esc(v)}" />`;
    case 24: // computed (e.g. thn_lahir)
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" inputmode="numeric" ${ro} value="${esc(v)}" placeholder="cth. 1990" />`;
    case 32: // photo
      return `<div class="photo-control">
        <input type="hidden" data-key="${esc(field.dataKey)}" value="${esc(v)}" />
        ${photoPreviewHtml(field, v)}
        <label class="fg-photo-btn ${readOnly ? 'disabled' : ''}">
          <input type="file" accept="image/*" capture="environment" data-photo-key="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''} hidden />
          <span>Input gambar</span>
        </label>
      </div>`;
    case 33: // geo
      return `<div class="media-control">
        <input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" placeholder="Lat, Long" />
        <button type="button" class="fg-device-geo" data-device-geo="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>Ambil lokasi device</button>
      </div>`;
    case 35: // datetime
      return `<div class="datetime-control">
        <input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" placeholder="dd Mmm yyyy, hh:mm" />
        <button type="button" class="fg-device-time" data-device-time="${esc(field.dataKey)}" ${readOnly ? 'disabled' : ''}>Ambil waktu device</button>
      </div>`;
    default: // text (25) and overrideType='text'
      return `<input class="fg-input" data-key="${esc(field.dataKey)}" ${ro} value="${esc(v)}" placeholder="${readOnly ? '' : 'Tulis di sini…'}" />`;
  }
}

const TYPE_ICON = {
  6: '▶', 25: '✎', 26: '◉', 27: '◉', 28: '#', 30: '¶', 32: '📷', 33: '📍', 35: '🕑',
};

function fieldRowHtml(field) {
  const value = state.engine.rawGet(field.dataKey);
  const readOnly = state.engine.isReadOnly(field);
  const initialHidden = field.forceHidden || (!state.engine.isVisible(field) && field.conditional);
  const reqStar = field.required ? '<span class="fl-req">*</span>' : '';
  const hint = field.hint ? `<span class="fl-hint">${esc(field.hint)}</span>` : '';
  const lock = readOnly ? '<span class="fl-lock">Terkunci</span>' : '';
  const icon = TYPE_ICON[field.type] || '•';
  return `<div class="field-row" data-field="${esc(field.dataKey)}"${initialHidden ? ' hidden' : ''}>
    <div class="field-label">
      <span class="fl-text">${formatFieldLabel(field)}${reqStar}</span>
      ${hint}
      ${lock}
    </div>
    <div class="field-input">
      ${controlHtml(field, value, readOnly)}
      <div class="fg-msgs" data-msgs="${esc(field.dataKey)}"></div>
    </div>
    <div class="field-remark"><span class="fl-type" title="${esc(field.typeName)}">${icon}</span></div>
  </div>`;
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// Count visible-field errors/warnings for a page (in its row context).
function pageIssues(page) {
  if (page.kind === 'roster') return { err: 0, warn: 0, visible: 0 };
  return withPageRow(page, () => {
    let err = 0, warn = 0, visible = 0;
    for (const f of pageFields(page)) {
      if (f.type === 6) continue;
      if (!state.engine.isVisible(f) || f.forceHidden) continue;
      visible++;
      const r = state.engine.validateField(f);
      err += r.errors.length;
      warn += r.warnings.length;
    }
    return { err, warn, visible };
  });
}

function updateSidebarStatus() {
  state.pages.forEach((page, i) => {
    const { err, warn } = pageIssues(page);
    const dot = document.querySelector(`[data-dot="${i}"]`);
    if (dot) dot.className = 'bi-dot' + (err ? ' dot-err' : warn ? ' dot-warn' : '');
  });
}

function refreshBlock() {
  const page = state.pages[state.current];
  if (page.kind === 'roster') { updateSidebarStatus(); return; }
  withPageRow(page, () => {
    for (const field of pageFields(page)) {
      const row = document.querySelector(`.field-row[data-field="${cssEsc(field.dataKey)}"]`);
      if (!row) continue;
      const visible = state.engine.isVisible(field) && !field.forceHidden;
      row.hidden = !visible;
      // Keep displayed value in sync with the active row context.
      if (visible) syncFieldLabel(field, row);
      if (visible) syncControlValue(field);
      const box = row.querySelector(`[data-msgs="${cssEsc(field.dataKey)}"]`);
      if (!box) continue;
      if (!visible) { box.innerHTML = ''; continue; }
      const result = state.engine.validateField(field);
      box.innerHTML =
        result.errors.map((m) => `<div class="fg-msg err">⛔ ${esc(m)}</div>`).join('') +
        result.warnings.map((m) => `<div class="fg-msg warn">⚠️ ${esc(m)}</div>`).join('');
      row.classList.toggle('has-error', result.errors.length > 0);
      row.classList.toggle('has-warn', result.errors.length === 0 && result.warnings.length > 0);
    }
  });
  updateSidebarStatus();
}

// Reflect the engine's current value for a field into its rendered control.
function syncControlValue(field) {
  const v = state.engine.rawGet(field.dataKey);
  const effectiveType = field.overrideType === 'text' ? 25 : field.type;
  if ((effectiveType === 26 || effectiveType === 27) && field.dataKey !== 'pengusaha') {
    document.querySelectorAll(`input[data-key="${cssEsc(field.dataKey)}"]`).forEach((input) => {
      const on = String(input.value) === String(v == null ? '' : v);
      input.checked = on;
      input.closest('.fg-opt')?.classList.toggle('checked', on);
    });
  } else {
    const el = document.querySelector(`[data-key="${cssEsc(field.dataKey)}"]`);
    if (el && 'value' in el && el.value !== (v == null ? '' : String(v))) el.value = v == null ? '' : v;
  }
  if (field.type === 32) {
    const control = document.querySelector(`.field-row[data-field="${cssEsc(field.dataKey)}"] .photo-control`);
    const normalized = v == null ? '' : String(v);
    if (control) {
      const current = control.querySelector('.fg-photo-preview')?.getAttribute('src') || '';
      if (current !== normalized) {
        const preview = control.querySelector('.fg-photo-preview, .fg-photo-empty');
        if (preview) preview.outerHTML = photoPreviewHtml(field, normalized);
      }
    }
  }
}

function renderRosterList(page) {
  const block = state.blocks[page.block];
  const ns = page.ns;
  const rows = state.engine.rowsOf(ns);
  const lbl = NS_LABELS[ns];
  const intro = (block.htmlCards || []).map((html) => `<div class="intro-card">${html}</div>`).join('');
  const addLabel = ns === 'usaha' ? 'Nama usaha/perusahaan' : 'Nama anggota keluarga';
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
        <button type="button" class="roster-remove" data-roster-remove="${ns}" data-row="${i}" aria-label="Hapus">Hapus</button>
      </div>
    </div>`;
  }).join('');
  const empty = rows.length ? '' : `<div class="roster-empty">Belum ada ${ns === 'usaha' ? 'usaha' : 'anggota keluarga'}. Klik tombol di bawah untuk menambah.</div>`;
  $('#formCard').innerHTML = `
    <div class="card-band">
      <div class="ttl">${esc(block.cardTitle)}</div>
      ${block.subtitle ? `<div class="sub">${esc(block.subtitle)}</div>` : ''}
    </div>
    <div class="card-band-rule"></div>
    ${intro}
    <div class="roster-head">
      <h3>${ns === 'usaha' ? 'Daftar Usaha/Perusahaan' : 'Daftar Anggota Keluarga'}</h3>
      <span class="roster-count">${rows.length} ${ns === 'usaha' ? 'usaha' : 'anggota'}</span>
    </div>
    <div class="roster-add-inline">
      <label class="roster-add-label" for="rosterDraft_${ns}">${addLabel}</label>
      <div class="roster-add-row">
        <input id="rosterDraft_${ns}" class="fg-input roster-draft-input" data-roster-draft="${ns}" value="${esc(addValue)}" placeholder="${ns === 'usaha' ? 'Tuliskan nama usaha/perusahaan' : 'Tuliskan nama anggota keluarga'}" />
        <button type="button" class="roster-add-inline-btn" data-roster-add="${ns}">＋ ${ns === 'usaha' ? 'Tambah Baru' : 'Tambah Baru'}</button>
      </div>
    </div>
    <div class="roster-list">${items}${empty}</div>
    ${ns === 'usaha' ? `<button type="button" class="roster-add" data-roster-add="${ns}">＋ ${esc(lbl.add)}</button>` : ''}
  `;
}

function renderBlock(page) {
  if (page.kind === 'roster') { renderRosterList(page); updateSidebarStatus(); return; }
  const block = state.blocks[page.block];
  const rosterChip = page.ns
    ? `<div class="member-chip">${page.ns === 'usaha' ? 'Usaha' : 'Anggota Keluarga'}: <strong>${esc(page.label || '')}</strong>
        <button type="button" class="chip-remove" data-roster-remove="${page.ns}" data-row="${page.row}">Hapus baris</button></div>`
    : '';
  withPageRow(page, () => {
    $('#formCard').innerHTML = `
      <div class="card-band">
        <div class="ttl">${esc(block.cardTitle)}</div>
        ${block.subtitle ? `<div class="sub">${esc(block.subtitle)}</div>` : ''}
      </div>
      <div class="card-band-rule"></div>
      ${rosterChip}
      ${(block.htmlCards || []).map((html) => `<div class="intro-card">${html}</div>`).join('')}
      ${(block.fields || []).map(fieldRowHtml).join('')}
    `;
  });
  refreshBlock();
}

function renderSidebar() {
  // Group pages by block so roster pages nest under their block heading.
  let html = '';
  let lastBlock = -1;
  state.pages.forEach((page, i) => {
    const block = state.blocks[page.block];
    if (page.ns) {
      if (page.block !== lastBlock) {
        html += `<div class="nav-group-head">${esc(block.name)}<span class="nav-group-sub">${esc(block.subtitle || '')}</span></div>`;
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
      html += `<button class="block-item ${i === state.current ? 'active' : ''}" data-i="${i}">
        <span class="bi-row"><span class="bi-name">${esc(block.name)}</span>
        <span class="bi-dot" data-dot="${i}"></span></span>
        ${block.subtitle ? `<span class="bi-sub">${esc(block.subtitle)}</span>` : ''}
      </button>`;
    }
    lastBlock = page.block;
  });
  $('#blockNav').innerHTML = html;
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
  $('#prevBtn').hidden = !prev;
  if (prev) $('#prevLabel').textContent = pageNavLabel(prev);
  $('#nextBtn').hidden = !next;
  if (next) $('#nextLabel').textContent = pageNavLabel(next);
}

function goTo(index) {
  if (index < 0 || index >= state.pages.length) return;
  state.current = index;
  renderSidebar();
  renderBlock(state.pages[state.current]);
  renderNav();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function buildBlockPayload(page) {
  const block = state.blocks[page.block];
  const payload = {};
  withPageRow(page, () => {
    for (const field of block.fields) {
      if (!state.engine.isVisible(field)) continue;
      const value = state.engine.rawGet(field.dataKey);
      if (value == null || value === '') continue;
      // Namespace roster fields by row so multiple members don't collide.
      const key = page.ns ? `${field.dataKey}@${page.row + 1}` : field.dataKey;
      payload[key] = value;
    }
  });
  return payload;
}

function nextSequence() {
  state.sequence += 1;
  return state.sequence;
}

async function sendChunk(item) {
  await api('/api/v1/survey/submit-chunk', {
    method: 'POST',
    body: JSON.stringify(item.body),
  });
}

async function saveBlock(pageIndex = state.current, final = false) {
  const page = state.pages[pageIndex];
  // Roster overview pages hold no answers of their own.
  if (page.kind === 'roster') {
    if (!final) setStatus('Halaman daftar tidak menyimpan jawaban. Buka tiap baris untuk mengisi.', 'ok');
    return;
  }
  const block = state.blocks[page.block];
  const blockId = page.ns ? `${block.dataKey}#${page.row + 1}` : block.dataKey;
  const body = {
    assignment_id: state.assignment.id,
    respondent_id: state.assignment.id,
    questionnaire_type: state.assignment.prelist_type,
    timestamp: new Date().toISOString(),
    chunk_info: {
      block_id: blockId,
      action: 'replace',
      sequence_number: nextSequence(),
    },
    payload: buildBlockPayload(page),
    is_final_submission: final,
  };
  try {
    await sendChunk({ body });
    setStatus(final ? 'Submit final berhasil dikirim.' : 'Draft halaman berhasil disimpan.', 'ok');
  } catch (err) {
    const queued = {
      id: `${state.assignment.id}:${blockId}:${body.chunk_info.sequence_number}`,
      assignment_id: state.assignment.id,
      created_at: Date.now(),
      body,
    };
    await queueChunk(queued);
    setStatus('Jaringan terputus. Draft disimpan lokal dan akan dikirim ulang saat online.', 'ok');
  }
}

async function syncPendingChunks() {
  if (!navigator.onLine) return;
  const items = (await readQueuedChunks())
    .filter((item) => item.assignment_id === state.assignment.id)
    .sort((a, b) => a.created_at - b.created_at);
  for (const item of items) {
    try {
      await sendChunk(item);
      await removeQueuedChunk(item.id);
    } catch {
      break;
    }
  }
}

// Whole-form tally across every page (each roster page counted in its row ctx).
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

async function submitFinal() {
  const summary = flowSummary();
  if (summary.errors > 0) {
    setStatus('Masih ada galat pada isian. Perbaiki sebelum submit final.', 'err');
    return;
  }
  for (let i = 0; i < state.pages.length; i++) {
    await saveBlock(i, i === state.pages.length - 1);
  }
  await syncPendingChunks();
  clearLocalDraft();
  setStatus('Submit final berhasil dikirim.', 'ok');
}

function onInput(e) {
  const rosterDraft = e.target.closest('[data-roster-draft]');
  if (rosterDraft) {
    state.rosterDrafts[rosterDraft.dataset.rosterDraft] = rosterDraft.value;
    return;
  }
  const el = e.target.closest('[data-key]');
  if (!el) return;
  const key = el.dataset.key;
  const value = el.type === 'radio' ? (el.checked ? el.value : undefined) : el.value;
  if (value === undefined) return;
  const page = state.pages[state.current];
  withPageRow(page, () => state.engine.setUserValue(key, value));
  // A roster identity field (name) changing should relabel the sidebar/nav.
  const relabel = page.ns && /^(nama_dtsen|nama_ak|nama_usaha_edit|nama_usaha_bang)$/.test(key);
  if (relabel) {
    if (page.ns === 'anggota') state.engine.rosters.anggota[page.row].nama_ak = state.engine.rosters.anggota[page.row].nama_dtsen || '';
    page.label = page.ns === 'usaha'
      ? usahaName(state.engine.rosters.usaha[page.row], page.row)
      : memberName(state.engine.rosters.anggota[page.row], page.row);
    renderSidebar();
    renderNav();
  }
  saveLocalDraft();
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
  const page = state.pages[state.current];
  withPageRow(page, () => state.engine.setUserValue(key, coords));
  saveLocalDraft();
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
  const page = state.pages[state.current];
  withPageRow(page, () => state.engine.setUserValue(input.dataset.photoKey, dataUrl));
  saveLocalDraft();
  refreshBlock();
}

// Handle Tambah / Hapus / Buka clicks inside the form card.
function onRosterAction(e) {
  const deviceTime = e.target.closest('[data-device-time]');
  if (deviceTime) {
    const key = deviceTime.dataset.deviceTime;
    const page = state.pages[state.current];
    const value = deviceTimeValue();
    withPageRow(page, () => state.engine.setUserValue(key, value));
    saveLocalDraft();
    refreshBlock();
    const input = document.querySelector(`[data-key="${cssEsc(key)}"]`);
    if (input) input.focus();
    return;
  }
  const geoBtn = e.target.closest('[data-device-geo]');
  if (geoBtn) {
    handleGeoPick(geoBtn.dataset.deviceGeo).catch((err) => setStatus(err.message || 'Gagal mengambil lokasi.', 'err'));
    return;
  }
  const add = e.target.closest('[data-roster-add]');
  if (add) {
    const ns = add.dataset.rosterAdd;
    const typed = String(state.rosterDrafts[ns] || '').trim();
    if (ns === 'anggota') {
      if (!typed) { setStatus('Isi nama anggota keluarga baru terlebih dahulu.', 'err'); return; }
      if (!/^[A-Za-z ]+$/.test(typed)) { setStatus('Nama anggota keluarga hanya boleh berisi huruf dan spasi.', 'err'); return; }
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
  if (remove) { removeRosterRow(remove.dataset.rosterRemove, Number(remove.dataset.row)); return; }
}

function openSummary() {
  const s = flowSummary();
  $('#summaryCount').textContent = `${s.answered} jawaban`;
  $('#sumError').textContent = String(s.errors);
  $('#sumWarn').textContent = String(s.warnings);
  $('#sumNote').textContent = String(s.notes);
  $('#sumEmpty').textContent = String(s.empty);
  $('#summaryModal').hidden = false;
}

async function startFormSession(sessionPayload) {
  clearGateError();
  setGateOnlyMode(false);
  $('#respondentGate').hidden = true;
  $('#respondentHead').hidden = false;
  $('#respondentLayout').hidden = false;
  $('#respondentBottom').hidden = false;
  $('#clearRespondentSessionBtn').hidden = false;
  state.assignment = sessionPayload.assignment;
  state.submission = sessionPayload.submission;

  state.form = await api('/api/form', {}, '');
  state.blocks = state.form.blocks;
  const assignmentPredefined = Object.assign({}, state.assignment.predefined || {});
  if (!assignmentPredefined.nama_kk && state.assignment.nama) assignmentPredefined.nama_kk = state.assignment.nama;
  if (!assignmentPredefined.nama && state.assignment.nama) assignmentPredefined.nama = state.assignment.nama;
  const seededForm = Object.assign({}, state.form, {
    predefined: assignmentPredefined,
    locked: Object.keys(assignmentPredefined).filter((key) => key !== 'kodepos'),
  });
  state.engine = new FormEngine(seededForm, window.PDF_RULES);
  if (state.submission?.answers) {
    for (const [key, value] of Object.entries(state.submission.answers)) {
      if (key && typeof value !== 'object') state.engine.values[key] = value;
    }
  }
  // Seed family / business rosters: from the assignment predefined first, then
  // any locally saved draft (which wins).
  seedRosters(assignmentPredefined);
  const draft = loadLocalDraft();
  if (draft && draft.values) {
    for (const [key, value] of Object.entries(draft.values)) state.engine.values[key] = value;
  }
  if (draft && draft.rosters) {
    if (Array.isArray(draft.rosters.anggota) && draft.rosters.anggota.length) state.engine.rosters.anggota = draft.rosters.anggota;
    if (Array.isArray(draft.rosters.usaha) && draft.rosters.usaha.length) state.engine.rosters.usaha = draft.rosters.usaha;
  }
  normalizeRosterRows('anggota');
  normalizeRosterRows('usaha');
  state.engine.recomputeHidden();

  document.title = `${state.form.meta.title} - Responden`;
  $('#surveyTitle').textContent = `${state.form.meta.title} - ${state.assignment.nama || 'Responden'}`;
  $('#sidebarTitle').textContent = state.form.meta.title;

  buildPages();
  renderSidebar();
  goTo(0);
  await syncPendingChunks();
}

async function onGateSubmit() {
  clearGateError();
  const pin = String($('#pinInput')?.value || '').trim();
  if (!/^\d{6}$/.test(pin)) {
    gateError('PIN harus terdiri dari 6 digit angka.');
    return;
  }
  try {
    let payload;
    if (state.gateMode === 'setup') {
      const confirm = String($('#pinConfirmInput')?.value || '').trim();
      if (pin !== confirm) {
        gateError('Ulangi PIN harus sama.');
        return;
      }
      payload = await api('/api/respondent/session/init', {
        method: 'POST',
        body: JSON.stringify({ access: state.access, pin }),
      }, '');
    } else {
      payload = await api('/api/respondent/session/login', {
        method: 'POST',
        body: JSON.stringify({ access: state.access, pin }),
      }, '');
    }
    state.token = payload.token;
    setStoredToken(payload.token);
    await startFormSession(payload);
  } catch (err) {
    gateError(err.message || 'Gagal memproses sesi responden.');
  }
}

async function boot() {
  registerServiceWorker();
  setGateOnlyMode(true);
  state.access = new URLSearchParams(location.search).get('access') || '';
  if (!state.access) {
    gateError('Tautan responden tidak valid. Parameter akses tidak ditemukan.');
    $('#gateTitle').textContent = 'Akses tidak ditemukan';
    $('#gateSubtitle').textContent = 'Periksa kembali tautan yang Anda buka.';
    $('#gateForm').innerHTML = '';
    return;
  }

  $('#gateSubmitBtn').addEventListener('click', () => onGateSubmit());
  $('#saveBtn').addEventListener('click', () => saveBlock().catch((err) => setStatus(err.message, 'err')));
  $('#submitBtn').addEventListener('click', () => submitFinal().catch((err) => setStatus(err.message, 'err')));
  $('#summaryBtn').addEventListener('click', openSummary);
  $('#modalClose').addEventListener('click', () => { $('#summaryModal').hidden = true; });
  $('#summaryModal').addEventListener('click', (e) => {
    if (e.target.id === 'summaryModal') $('#summaryModal').hidden = true;
  });
  $('#prevBtn').addEventListener('click', () => goTo(state.current - 1));
  $('#nextBtn').addEventListener('click', () => goTo(state.current + 1));
  $('#formCard').addEventListener('input', onInput);
  $('#formCard').addEventListener('change', onInput);
  $('#formCard').addEventListener('change', (e) => {
    const fileInput = e.target.closest('[data-photo-key]');
    if (fileInput) handlePhotoPick(fileInput).catch((err) => setStatus(err.message || 'Gagal membaca gambar.', 'err'));
  });
  $('#formCard').addEventListener('click', onRosterAction);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-roster-add],[data-roster-remove],[data-roster-open]')) return;
    const item = e.target.closest('.block-item');
    if (item) goTo(Number(item.dataset.i));
  });
  $('#clearRespondentSessionBtn').addEventListener('click', () => {
    clearSession();
    location.reload();
  });
  window.addEventListener('online', () => syncPendingChunks().catch(() => {}));

  await loadGate();
}

boot().catch((err) => {
  gateError(err.message || 'Gagal memuat halaman responden.');
});

// ── Mobile sidebar toggle ─────────────────────────────────────────────────────
(function () {
  const toggle = document.getElementById('sidebarToggle');
  const overlay = document.getElementById('sidebarOverlay');
  function getSidebar() { return document.getElementById('sidebar'); }
  if (!toggle || !overlay) return;
  function openSidebar() {
    const sb = getSidebar(); if (!sb) return;
    sb.classList.add('open'); overlay.classList.add('open');
  }
  function closeSidebar() {
    const sb = getSidebar(); if (!sb) return;
    sb.classList.remove('open'); overlay.classList.remove('open');
  }
  toggle.addEventListener('click', () => {
    const sb = getSidebar();
    sb?.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  overlay.addEventListener('click', closeSidebar);
  document.addEventListener('click', (e) => {
    if (e.target.closest('.block-item') && window.innerWidth <= 900) closeSidebar();
  });
})();
