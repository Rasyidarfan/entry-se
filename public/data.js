'use strict';

// Data screen controller (§9.1/§9.2): assignment listing + cascading region
// filter + paging, talking to the REST API via SE.api(). Mitra is auto-limited
// server-side; here we only hide admin-only affordances.

if (!SE.requireAuth()) { /* redirected */ }

const $ = (s) => document.querySelector(s);

const state = {
  page: 1,
  limit: 25,
  filters: {},     // applied (region + petugas + mode)
  status: '',
  type: '',
  q: '',
  total: 0,
  regionTree: [],
  activeAccessAssignmentId: null,
};

const REGION_LEVEL_DEPTH = {
  prov: 0,
  kab: 1,
  kec: 2,
  desa: 3,
  sls: 4,
  subsls: 5,
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function assignmentNameMeta(type) {
  return type === 'usaha'
    ? {
      label: 'Nama Bangunan/Usaha',
      placeholder: 'Tuliskan nama bangunan atau usaha',
    }
    : {
      label: 'Nama Kepala Keluarga',
      placeholder: 'Tuliskan nama kepala keluarga',
    };
}

function syncAssignmentNameField() {
  const meta = assignmentNameMeta($('#aPrelistType').value);
  $('#aNamaLabel').childNodes[0].textContent = meta.label;
  $('#aNama').placeholder = meta.placeholder;
}

// ---- header ----------------------------------------------------------------

(function initHeader() {
  const u = SE.getUser();
  $('#userBadge').textContent = u ? `${u.fullname || u.username} · ${u.role}` : '';
  $('#logoutBtn').addEventListener('click', () => SE.logout());
})();

// ---- listing ---------------------------------------------------------------

function buildQuery() {
  const p = new URLSearchParams();
  p.set('page', state.page);
  p.set('limit', state.limit);
  if (state.status) p.set('status', state.status);
  if (state.type) p.set('prelist_type', state.type);
  if (state.q) p.set('q', state.q);
  for (const [k, v] of Object.entries(state.filters)) {
    if (v) p.set(k, v);
  }
  return p.toString();
}

async function loadList() {
  $('#dataRows').innerHTML = '<tr><td colspan="8" class="dt-loading">Memuat…</td></tr>';
  try {
    const res = await SE.api('/api/assignments?' + buildQuery());
    state.total = res.total;
    renderRows(res.data);
    renderCounts(res.counts, res.total);
    renderPager(res.page, res.limit, res.total);
  } catch (err) {
    $('#dataRows').innerHTML = `<tr><td colspan="8" class="dt-error">Gagal memuat: ${esc(err.message)}</td></tr>`;
  }
}

const STATUS_LABELS = {
  open: 'Open', progress: 'Progress', done: 'Done', clean: 'Clean', error: 'Error',
};

function renderRows(rows) {
  if (!rows.length) {
    $('#dataRows').innerHTML = '<tr><td colspan="8" class="dt-loading">Tidak ada data.</td></tr>';
    $('#mobileCards').innerHTML = '<div class="mc-empty">Tidak ada data.</div>';
    return;
  }
  const adminActionsBtns = (id) => isAdmin ? `
    <button class="row-open" data-id="${esc(id)}">Buka</button>
    <button class="row-access" data-id="${esc(id)}">Akses</button>
    <button class="row-edit" data-id="${esc(id)}">Edit</button>
    <button class="row-delete" data-id="${esc(id)}">Hapus</button>` :
    `<button class="row-open" data-id="${esc(id)}">Buka ›</button>`;

  $('#dataRows').innerHTML = rows.map((r) => {
    const sub = r.submission_status ? `<span class="sub-tag ${r.submission_status}">${r.submission_status}</span>` : '';
    return `<tr class="tr-main" data-id="${esc(r.id)}">
      <td class="mono">${esc(r.kode_identitas || '—')}</td>
      <td>${esc(r.nama || '—')}</td>
      <td>${esc(r.alamat_prelist || '—')}</td>
      <td>${esc(r.nomor_urut_bangunan || r.idsbr || '—')}</td>
      <td>${esc(r.nib || '—')}</td>
      <td>${esc(r.email || '—')}</td>
      <td><span class="status-pill ${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span> ${sub}</td>
      <td class="tr-chevron-cell"><span class="tr-chevron">›</span></td>
    </tr>
    <tr class="tr-actions-row" data-id="${esc(r.id)}" hidden>
      <td colspan="8">
        <div class="row-actions">${adminActionsBtns(r.id)}</div>
      </td>
    </tr>`;
  }).join('');

  $('#mobileCards').innerHTML = rows.map((r) => {
    const sub = r.submission_status ? `<span class="sub-tag ${r.submission_status}">${r.submission_status}</span>` : '';
    return `<div class="mc-card" data-id="${esc(r.id)}">
      <div class="mc-main">
        <div class="mc-name">${esc(r.nama || '—')}</div>
        <div class="mc-meta">
          <span class="mono mc-kode">${esc(r.kode_identitas || '—')}</span>
          <span class="status-pill ${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
          ${sub}
        </div>
        <div class="mc-addr">${esc(r.alamat_prelist || '—')}</div>
      </div>
      <div class="mc-chevron">›</div>
      <div class="mc-actions" hidden>
        ${adminActionsBtns(r.id)}
      </div>
    </div>`;
  }).join('');
}

function renderCounts(counts, total) {
  $('#totalChip').textContent = `${(total || 0).toLocaleString('id-ID')} SEMUA`;
  const order = ['open', 'progress', 'done', 'clean', 'error'];
  $('#countChips').innerHTML = order
    .filter((k) => counts && counts[k])
    .map((k) => `<span class="count-chip ${k}">${STATUS_LABELS[k]}: ${counts[k]}</span>`)
    .join('');
}

function renderPager(page, limit, total) {
  const pages = Math.max(1, Math.ceil(total / limit));
  $('#pageInfo').textContent = `Halaman ${page} / ${pages} · ${total.toLocaleString('id-ID')} baris`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= pages;
}

document.addEventListener('click', (e) => {
  const access = e.target.closest('.row-access');
  if (access && access.dataset.id) {
    e.stopPropagation();
    openAccessModal(access.dataset.id);
    return;
  }
  const edit = e.target.closest('.row-edit');
  if (edit && edit.dataset.id) {
    e.stopPropagation();
    openAssignmentEditor(edit.dataset.id).catch((err) => alert('Gagal: ' + err.message));
    return;
  }
  const del = e.target.closest('.row-delete');
  if (del && del.dataset.id) {
    e.stopPropagation();
    deleteAssignment(del.dataset.id).catch((err) => alert('Gagal: ' + err.message));
    return;
  }
  const open = e.target.closest('.row-open');
  if (open && open.dataset.id) {
    location.href = '/index.html?assignment=' + encodeURIComponent(open.dataset.id);
    return;
  }
  // Desktop table row click — expand action row
  const tr = e.target.closest('tr.tr-main');
  if (tr && !e.target.closest('button')) {
    const id = tr.dataset.id;
    const actionsRow = document.querySelector(`tr.tr-actions-row[data-id="${CSS.escape(id)}"]`);
    if (!actionsRow) return;
    const expanding = actionsRow.hidden;
    // Collapse all
    document.querySelectorAll('tr.tr-main').forEach(r => r.classList.remove('tr-expanded'));
    document.querySelectorAll('tr.tr-actions-row').forEach(r => { r.hidden = true; });
    document.querySelectorAll('.tr-chevron').forEach(c => { c.textContent = '›'; });
    if (expanding) {
      actionsRow.hidden = false;
      tr.classList.add('tr-expanded');
      tr.querySelector('.tr-chevron').textContent = '⌄';
    }
    return;
  }
  // Mobile card expand/collapse
  const card = e.target.closest('.mc-card');
  if (card && !e.target.closest('button')) {
    const actions = card.querySelector('.mc-actions');
    const chevron = card.querySelector('.mc-chevron');
    const expanded = !actions.hidden;
    // Collapse all other cards first
    document.querySelectorAll('.mc-card').forEach(c => {
      c.querySelector('.mc-actions').hidden = true;
      c.querySelector('.mc-chevron').textContent = '›';
      c.classList.remove('expanded');
    });
    if (!expanded) {
      actions.hidden = false;
      chevron.textContent = '⌄';
      card.classList.add('expanded');
    }
  }
});

// ---- toolbar ---------------------------------------------------------------

$('#statusFilter').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; loadList(); });
$('#typeFilter').addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; loadList(); });
$('#refreshBtn').addEventListener('click', loadList);
function openFilterPanel() {
  $('#filterPanel').classList.add('open');
  $('#filterOverlay').classList.add('open');
}
function closeFilterPanel() {
  $('#filterPanel').classList.remove('open');
  $('#filterOverlay').classList.remove('open');
}
$('#filterToggle').addEventListener('click', () => {
  $('#filterPanel').classList.contains('open') ? closeFilterPanel() : openFilterPanel();
});
$('#fpClose').addEventListener('click', closeFilterPanel);
$('#filterOverlay').addEventListener('click', closeFilterPanel);
// Close on Terapkan/Reset on mobile
$('#fpApply').addEventListener('click', () => { if (window.innerWidth <= 900) closeFilterPanel(); });
$('#fpReset').addEventListener('click', () => { if (window.innerWidth <= 900) closeFilterPanel(); });

let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; loadList(); }, 300);
});

$('#prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
$('#nextPage').addEventListener('click', () => { state.page++; loadList(); });

// ---- Filter Wilayah cascade ------------------------------------------------

const CASCADE = [
  { id: 'fwProv', level: 'prov', param: 'prov' },
  { id: 'fwKab', level: 'kab', param: 'kab' },
  { id: 'fwKec', level: 'kec', param: 'kec' },
  { id: 'fwDesa', level: 'desa', param: 'desa' },
  { id: 'fwSls', level: 'sls', param: 'sls' },
  { id: 'fwSubsls', level: 'subsls', param: 'subsls' },
];

function placeholder(sel, text) {
  sel.innerHTML = `<option value="">${text}</option>`;
}

async function loadLevel(idx, parentFullcode) {
  const def = CASCADE[idx];
  const sel = document.getElementById(def.id);
  placeholder(sel, '— pilih —');
  sel.disabled = true;
  const qs = new URLSearchParams({ level: def.level });
  if (parentFullcode) qs.set('parent', parentFullcode);
  try {
    const res = await SE.api('/api/regions?' + qs.toString());
    for (const r of res.data) {
      const o = document.createElement('option');
      o.value = r.fullcode;     // submit fullcode; param derives the code below
      o.dataset.code = r.code;
      o.textContent = `[${r.code}] ${r.name || ''}`.trim();
      sel.appendChild(o);
    }
    sel.disabled = res.data.length === 0;
  } catch { sel.disabled = true; }
}

// When a level changes, reset deeper levels and load the next one.
CASCADE.forEach((def, idx) => {
  const sel = document.getElementById(def.id);
  sel.addEventListener('change', () => {
    // clear deeper selects
    for (let j = idx + 1; j < CASCADE.length; j++) {
      const s = document.getElementById(CASCADE[j].id);
      placeholder(s, '— pilih —'); s.disabled = true;
    }
    const opt = sel.selectedOptions[0];
    const fullcode = sel.value;
    if (fullcode && idx + 1 < CASCADE.length) loadLevel(idx + 1, fullcode);
  });
});

// Apply: collect selected region codes (not fullcodes) into filters.
$('#fpApply').addEventListener('click', () => {
  const f = {};
  for (const def of CASCADE) {
    const sel = document.getElementById(def.id);
    const opt = sel.selectedOptions[0];
    if (sel.value && opt) f[def.param] = opt.dataset.code;
  }
  state.filters = f;
  state.page = 1;
  loadList();
});

$('#fpReset').addEventListener('click', () => {
  for (let i = 0; i < CASCADE.length; i++) {
    const s = document.getElementById(CASCADE[i].id);
    placeholder(s, '— pilih —');
    if (i > 0) s.disabled = true;
  }
  state.filters = {};
  state.page = 1;
  loadLevel(0, null);
  loadList();
});

// ============================================================================
// Admin features: Tambah Assignment + Kelola User
// ============================================================================

const isAdmin = SE.isAdmin();

// Reveal admin-only controls.
if (isAdmin) {
  document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = false; });
}

// Generic modal helpers (reuse existing .modal-backdrop styling).
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-close]');
  if (t) closeModal(t.dataset.close);
  // click on backdrop closes
  if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
    e.target.hidden = true;
  }
});

// ---- Tambah Assignment (wilayah berjenjang) ---------------------------------

const AR_CASCADE = [
  { id: 'arProv', level: 'prov' },
  { id: 'arKab', level: 'kab' },
  { id: 'arKec', level: 'kec' },
  { id: 'arDesa', level: 'desa' },
  { id: 'arSls', level: 'sls' },
  { id: 'arSubsls', level: 'subsls' },
];

async function arLoadLevel(idx, parentFullcode) {
  const def = AR_CASCADE[idx];
  const sel = document.getElementById(def.id);
  sel.innerHTML = '<option value="">— pilih —</option>';
  sel.disabled = true;
  try {
    const rows = await getAssignmentRegions(def.level, parentFullcode);
    for (const r of rows) {
      const o = document.createElement('option');
      o.value = r.fullcode;
      o.textContent = `[${r.code}] ${r.name || ''}`.trim();
      sel.appendChild(o);
    }
    sel.disabled = rows.length === 0;
  } catch (err) {
    const msg = err && err.message ? err.message : 'Gagal memuat wilayah dari tabel regions.';
    const box = $('#assignError');
    if (box) {
      box.textContent = msg;
      box.hidden = false;
    }
    sel.disabled = true;
  }
}

// Deepest non-empty region selection → fullcode used as region_fullcode.
function arDeepestFullcode() {
  for (let i = AR_CASCADE.length - 1; i >= 0; i--) {
    const v = document.getElementById(AR_CASCADE[i].id).value;
    if (v) return v;
  }
  return '';
}

// Wire the in-modal region cascade once.
AR_CASCADE.forEach((def, idx) => {
  const sel = document.getElementById(def.id);
  if (!sel) return;
  sel.addEventListener('change', () => {
    for (let j = idx + 1; j < AR_CASCADE.length; j++) {
      const s = document.getElementById(AR_CASCADE[j].id);
      s.innerHTML = '<option value="">— pilih —</option>'; s.disabled = true;
    }
    if (sel.value && idx + 1 < AR_CASCADE.length) arLoadLevel(idx + 1, sel.value);
  });
});

if (isAdmin) {
  function resetAssignmentForm() {
    $('#assignForm').reset();
    $('#aId').value = '';
    $('#assignModalTitle').textContent = 'Tambah Assignment';
    $('#aPrelistType').value = 'keluarga';
    syncAssignmentNameField();
  }

  $('#aPrelistType').addEventListener('change', syncAssignmentNameField);

  $('#addAssignmentBtn').addEventListener('click', () => {
    resetAssignmentForm();
    $('#assignError').hidden = true;
    // reset cascade
    for (let i = 1; i < AR_CASCADE.length; i++) {
      const s = document.getElementById(AR_CASCADE[i].id);
      s.innerHTML = '<option value="">— pilih —</option>'; s.disabled = true;
    }
    ensureRegionTree()
      .catch(() => {})
      .then(() => arLoadLevel(0, null)); // provinces from regions table cache/API
    openModal('assignModal');
  });

  $('#assignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#assignError'); err.hidden = true;
    const id = $('#aId').value;
    const region_fullcode = arDeepestFullcode();
    if (!region_fullcode) {
      err.textContent = 'Pilih wilayah minimal sampai SLS.';
      err.hidden = false; return;
    }
    const body = {
      prelist_type: $('#aPrelistType').value,
      nama: $('#aNama').value.trim(),
      nomor_urut_bangunan: $('#aNomor').value.trim() || null,
      region_fullcode,
    };
    try {
      if (id) {
        await SE.api('/api/assignments/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await SE.api('/api/assignments', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal('assignModal');
      state.page = 1;
      loadList();
    } catch (ex) {
      err.textContent = ex.message || 'Gagal menyimpan';
      err.hidden = false;
    }
  });
}

async function openAssignmentEditor(id) {
  const res = await SE.api('/api/assignments/' + encodeURIComponent(id));
  const assignment = res.assignment;
  $('#assignError').hidden = true;
  $('#assignModalTitle').textContent = 'Edit Assignment';
  $('#aId').value = assignment.id;
  $('#aPrelistType').value = assignment.prelist_type;
  syncAssignmentNameField();
  $('#aNama').value = assignment.nama || '';
  $('#aNomor').value = assignment.nomor_urut_bangunan || '';
  for (let i = 0; i < AR_CASCADE.length; i++) {
    const s = document.getElementById(AR_CASCADE[i].id);
    s.innerHTML = '<option value="">— pilih —</option>';
    s.disabled = i > 0;
  }
  await arLoadLevel(0, null);
  const path = [
    assignment.prov_code ? String(assignment.prov_code) : null,
    assignment.kab_code ? String(assignment.kab_code) : null,
    assignment.kec_code ? String(assignment.kec_code) : null,
    assignment.desa_code ? String(assignment.desa_code) : null,
    assignment.sls_code ? String(assignment.sls_code) : null,
    assignment.subsls_code ? String(assignment.subsls_code) : null,
  ];
  let prefix = '';
  for (let i = 0; i < path.length; i++) {
    const code = path[i];
    if (!code) break;
    prefix += code;
    const sel = document.getElementById(AR_CASCADE[i].id);
    sel.value = prefix;
    if (i + 1 < AR_CASCADE.length) await arLoadLevel(i + 1, prefix);
  }
  openModal('assignModal');
}

async function deleteAssignment(id) {
  if (!confirm('Hapus assignment ini?')) return;
  await SE.api('/api/assignments/' + encodeURIComponent(id), { method: 'DELETE' });
  loadList();
}

// ---- Kelola User ------------------------------------------------------------

async function loadUsers() {
  const tbody = $('#usersRows');
  tbody.innerHTML = '<tr><td colspan="5" class="dt-loading">Memuat…</td></tr>';
  try {
    const res = await SE.api('/api/users');
    const users = res.data || [];
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="5" class="dt-loading">Belum ada user.</td></tr>'; return; }
    tbody.innerHTML = users.map((u) => `
      <tr data-uid="${esc(u.id)}">
        <td>${esc(u.username)}</td>
        <td>${esc(u.fullname || '—')}</td>
        <td><span class="role-tag ${esc(u.role)}">${esc(u.role)}</span></td>
        <td>${u.is_active ? '✓' : '—'}</td>
        <td class="u-actions">
          <button class="u-edit" data-uid="${esc(u.id)}">Edit</button>
          <button class="u-del" data-uid="${esc(u.id)}">Hapus</button>
        </td>
      </tr>`).join('');
    window.__users = users;
  } catch (ex) {
    tbody.innerHTML = `<tr><td colspan="5" class="dt-error">Gagal: ${esc(ex.message)}</td></tr>`;
  }
}

function resetUserForm() {
  $('#userForm').reset();
  $('#uId').value = '';
  $('#uActive').checked = true;
  $('#userFormTitle').textContent = 'Buat User Baru';
  $('#uPwLabel').textContent = 'Password';
  $('#uUsername').disabled = false;
  $('#userError').hidden = true;
  clearRegionChecks();
}

function fillUserForm(u) {
  $('#uId').value = u.id;
  $('#uUsername').value = u.username;
  $('#uUsername').disabled = true; // username tidak diubah saat edit
  $('#uFullname').value = u.fullname || '';
  $('#uEmail').value = u.email || '';
  $('#uRole').value = u.role;
  $('#uActive').checked = !!u.is_active;
  $('#uPassword').value = '';
  $('#uPwLabel').textContent = 'Password (kosongkan = tetap)';
  $('#userFormTitle').textContent = 'Edit: ' + u.username;
  $('#userError').hidden = true;
  loadAssignedRegions(u.id);
}

function renderRegionTreeNode(node) {
  return `<div class="region-branch">
    <label class="region-node">
      <input type="checkbox" class="region-check" value="${esc(node.id)}" data-fullcode="${esc(node.fullcode)}" />
      <span>${esc(node.code)} · ${esc(node.name || node.fullcode)}</span>
    </label>
    ${(node.children || []).length ? `<div class="region-children">${node.children.map(renderRegionTreeNode).join('')}</div>` : ''}
  </div>`;
}

function renderRegionTree(tree) {
  const root = $('#userRegionTree');
  root.innerHTML = tree.map(renderRegionTreeNode).join('') || '<div class="dt-loading">Belum ada master wilayah.</div>';
}

async function ensureRegionTree() {
  if (!isAdmin) return;
  if (state.regionTree.length) return;
  const res = await SE.api('/api/regions/tree');
  state.regionTree = res.data || [];
  renderRegionTree(state.regionTree);
}

function regionsAtDepth(nodes, depth, out = []) {
  for (const node of nodes || []) {
    if ((REGION_LEVEL_DEPTH[node.level] ?? -1) === depth) out.push(node);
    if (node.children && node.children.length) regionsAtDepth(node.children, depth, out);
  }
  return out;
}

function findRegionByFullcode(nodes, fullcode) {
  for (const node of nodes || []) {
    if (node.fullcode === fullcode) return node;
    if (node.children && node.children.length) {
      const found = findRegionByFullcode(node.children, fullcode);
      if (found) return found;
    }
  }
  return null;
}

async function getAssignmentRegions(level, parentFullcode) {
  if (isAdmin) {
    await ensureRegionTree();
    const depth = REGION_LEVEL_DEPTH[level];
    if (depth != null && state.regionTree.length) {
      if (!parentFullcode) {
        return regionsAtDepth(state.regionTree, depth).sort((a, b) => String(a.code).localeCompare(String(b.code), 'id'));
      }
      const parent = findRegionByFullcode(state.regionTree, parentFullcode);
      if (!parent) return [];
      return (parent.children || [])
        .filter((node) => node.level === level)
        .sort((a, b) => String(a.code).localeCompare(String(b.code), 'id'));
    }
  }
  const qs = new URLSearchParams({ level });
  if (parentFullcode) qs.set('parent', parentFullcode);
  const res = await SE.api('/api/regions?' + qs.toString());
  return res.data || [];
}

function clearRegionChecks() {
  document.querySelectorAll('.region-check').forEach((el) => { el.checked = false; });
}

function cascadeRegionCheck(input) {
  const wrapper = input.closest('.region-branch');
  if (!wrapper) return;
  const childChecks = wrapper.querySelectorAll('.region-children .region-check');
  childChecks.forEach((el) => { el.checked = input.checked; });
}

document.addEventListener('change', (e) => {
  const input = e.target.closest('.region-check');
  if (input) cascadeRegionCheck(input);
});

async function loadAssignedRegions(userId) {
  clearRegionChecks();
  if (!userId) return;
  const res = await SE.api('/api/users/' + encodeURIComponent(userId) + '/regions');
  const ids = new Set((res.data || []).map((row) => row.id));
  document.querySelectorAll('.region-check').forEach((el) => { el.checked = ids.has(el.value); });
}

function selectedRegionIds() {
  return Array.from(document.querySelectorAll('.region-check:checked')).map((el) => el.value);
}

async function openAccessModal(assignmentId) {
  state.activeAccessAssignmentId = assignmentId;
  const res = await SE.api('/api/assignments/' + encodeURIComponent(assignmentId) + '/access');
  const { assignment, print } = res;
  $('#accessLink').value = assignment.respondent_link;
  $('#accessQr').src = assignment.qr_url;
  $('#accessInfo').textContent = `${assignment.nama || 'Responden'} · cetak ${print.width_mm} mm · PIN saat ini ${assignment.pin_is_set ? 'sudah aktif' : 'belum dibuat / baru di-reset'}.`;
  openModal('accessModal');
}

async function copyAccessLink() {
  const value = $('#accessLink').value.trim();
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

function printAccessSlip() {
  const link = $('#accessLink').value.trim();
  const qr = $('#accessQr').src;
  const name = $('#accessInfo').textContent;
  const win = window.open('', '_blank', 'width=420,height=720');
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><title>Struk Responden</title><style>
    body{font-family:Arial,sans-serif;margin:0;padding:8px;width:50mm}
    .wrap{display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center}
    .title{font-weight:700;font-size:13px}
    .meta{font-size:11px}
    .link{font-size:10px;word-break:break-all}
    img{width:42mm;height:42mm;object-fit:contain}
    @media print{body{width:50mm}}
  </style></head><body><div class="wrap">
    <div class="title">SENSUS EKONOMI 2026</div>
    <div class="meta">${esc(name)}</div>
    <img src="${qr}" alt="QR" />
    <div class="link">${esc(link)}</div>
    <div class="meta">Buat PIN 6 digit saat pertama kali membuka tautan.</div>
  </div></body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

async function resetRespondentPin() {
  if (!state.activeAccessAssignmentId) return;
  if (!confirm('Reset PIN responden untuk assignment ini?')) return;
  await SE.api('/api/assignments/' + encodeURIComponent(state.activeAccessAssignmentId) + '/reset-pin', { method: 'POST' });
  await openAccessModal(state.activeAccessAssignmentId);
  loadList();
}

if (isAdmin) {
  $('#usersBtn').addEventListener('click', () => {
    resetUserForm();
    ensureRegionTree().then(() => clearRegionChecks()).catch(() => {});
    loadUsers();
    openModal('usersModal');
  });

  $('#userResetBtn').addEventListener('click', resetUserForm);

  // Edit / Delete buttons in the user list (delegated).
  $('#usersRows').addEventListener('click', async (e) => {
    const edit = e.target.closest('.u-edit');
    const del = e.target.closest('.u-del');
    if (edit) {
      const u = (window.__users || []).find((x) => x.id === edit.dataset.uid);
      if (u) fillUserForm(u);
    } else if (del) {
      if (!confirm('Nonaktifkan user ini?')) return;
      try { await SE.api('/api/users/' + del.dataset.uid, { method: 'DELETE' }); loadUsers(); }
      catch (ex) { alert('Gagal: ' + ex.message); }
    }
  });

  // Create or update user.
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#userError'); err.hidden = true;
    const id = $('#uId').value;
    const pw = $('#uPassword').value;
    try {
      let targetUserId = id;
      if (id) {
        const body = {
          fullname: $('#uFullname').value.trim() || null,
          email: $('#uEmail').value.trim() || null,
          role: $('#uRole').value,
          is_active: $('#uActive').checked,
        };
        if (pw) body.password = pw;
        await SE.api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        if (!pw) { err.textContent = 'Password wajib untuk user baru.'; err.hidden = false; return; }
        const created = await SE.api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: $('#uUsername').value.trim(),
            password: pw,
            fullname: $('#uFullname').value.trim() || null,
            email: $('#uEmail').value.trim() || null,
            role: $('#uRole').value,
          }),
        });
        targetUserId = created.user.id;
      }
      if (targetUserId) {
        await SE.api('/api/users/' + targetUserId + '/regions', {
          method: 'PUT',
          body: JSON.stringify({ region_ids: selectedRegionIds() }),
        });
      }
      resetUserForm();
      loadUsers();
    } catch (ex) {
      err.textContent = ex.message || 'Gagal menyimpan';
      err.hidden = false;
    }
  });
}

if (isAdmin) {
  $('#copyAccessBtn').addEventListener('click', () => copyAccessLink().catch(() => {}));
  $('#printAccessBtn').addEventListener('click', printAccessSlip);
  $('#resetPinBtn').addEventListener('click', () => resetRespondentPin().catch((err) => alert('Gagal: ' + err.message)));
}

// ---- boot ------------------------------------------------------------------

loadLevel(0, null);     // provinces
loadList();
