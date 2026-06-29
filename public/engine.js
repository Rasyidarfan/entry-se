'use strict';

// FormGear browser engine (roster-aware).
//
// Holds the answer store and evaluates raw FormGear expressions
// (enableCondition / readOnlyCondition / validation `test`) live, with shims for
// the FASIH runtime helpers. The store has two layers:
//
//   • global values  — keyed by plain dataKey (e.g. `is_keluarga`, `ada_keluarga`)
//   • roster rows     — a named list (`anggota`, `usaha`) where each row carries its
//                       own dataKey→value map. Fields whose template dataKey ends in
//                       `@$ROW$` read/write the *active* row.
//
// While rendering a roster page the engine is put into a "row context" via
// withRow(); expressions referencing `getValue('x@$ROW$')` then resolve against
// that row. Hidden vars (ec_art_dtsen, ec_anggota_keluarga, …) recompute per row.
//
// Expressions that throw are treated as "no opinion" so a missing runtime API
// never blocks the form.

(function (global) {
  function FormEngine(form, pdfRules) {
    this.form = form;
    this.pdfRules = pdfRules || {};
    this.values = {};       // dataKey -> value (global scope)
    this.computed = {};     // hidden-var dataKey -> last computed value (global)
    this.fieldIndex = {};   // dataKey -> field meta
    this.alerts = [];

    // Roster state: namespace -> array of { dataKey: value } row objects.
    this.rosters = { anggota: [], usaha: [] };
    // Active row context while rendering/validating a roster page.
    this.rowCtx = null;     // { ns, index }

    for (const block of form.blocks) {
      for (const f of block.fields) {
        if (f.dataKey) this.fieldIndex[f.dataKey] = f;
      }
    }
    for (const [k, v] of Object.entries(form.predefined || {})) {
      this.values[k] = v;
    }
    this.locked = new Set(form.locked || []);
    this.hiddenVars = form.hiddenVars || [];
    this.recomputeHidden();
  }

  // ---- roster helpers -------------------------------------------------------

  // Which roster namespace owns a given member-scoped dataKey. Anggota-keluarga
  // fields live in Blok I & III; usaha fields in Blok II.
  FormEngine.prototype.namespaceOf = function (baseKey) {
    const f = this.fieldIndex[baseKey];
    return (f && f.rowNamespace) || null;
  };

  FormEngine.prototype.rowsOf = function (ns) {
    return this.rosters[ns] || (this.rosters[ns] = []);
  };

  FormEngine.prototype.rosterItem = function (ns, row, index) {
    if (ns === 'usaha') {
      const label = row?.nama_usaha_edit || row?.nama_usaha_bang || `Usaha ${index + 1}`;
      return {
        value: index + 1,
        label,
        is_prelist: row?.__isPrelist ? '1' : '0',
        nousaha: index + 1,
      };
    }
    const label = row?.nama_dtsen || row?.nama_ak || `Anggota ${index + 1}`;
    return {
      value: index + 1,
      label,
      nama_ak: label,
      is_prelist: row?.__isPrelist ? '1' : '0',
      no_urut: index + 1,
    };
  };

  FormEngine.prototype.rosterItems = function (ns, mode) {
    return this.rowsOf(ns).flatMap((row, index) => {
      if (mode === 'prelist' && !row?.__isPrelist) return [];
      if (mode === 'added' && (row?.__isPrelist || row?.__seededHead)) return [];
      return [this.rosterItem(ns, row, index)];
    });
  };

  FormEngine.prototype.withRow = function (ns, index, fn) {
    const prev = this.rowCtx;
    this.rowCtx = { ns, index };
    try { return fn(); } finally { this.rowCtx = prev; }
  };

  // ---- value access ---------------------------------------------------------

  FormEngine.prototype.rawGet = function (key) {
    // Used by the renderer to seed inputs. Honour the active row context.
    if (this.rowCtx) {
      const f = this.fieldIndex[key];
      if (f && f.rowNamespace === this.rowCtx.ns) {
        const row = this.rowsOf(this.rowCtx.ns)[this.rowCtx.index] || {};
        if (key in row) return row[key];
        return this.computeRowHidden(key, this.rowCtx.ns, this.rowCtx.index);
      }
    }
    return this.values[key];
  };

  // Parse a getValue() key into { base, rowRef } where rowRef can be:
  //   '$ROW$'  → active row,  '#<n>' / '@<n>' → explicit row index/value.
  function splitKey(key) {
    const s = String(key);
    let m = s.match(/^(.*?)@\$ROW\$$/);
    if (m) return { base: m[1], rowRef: '$ROW$' };
    m = s.match(/^(.*?)[@#](.+)$/);
    if (m) return { base: m[1], rowRef: m[2] };
    return { base: s, rowRef: null };
  }

  FormEngine.prototype.choiceShape = function (base, v) {
    if (v === undefined || v === null || v === '') return v;
    const field = this.fieldIndex[base];
    if (field && (field.type === 26 || field.type === 27)) {
      const opt = (field.options || []).find((o) => String(o.value) === String(v));
      return [{ value: String(v), label: opt ? opt.label : String(v) }];
    }
    return v;
  };

  FormEngine.prototype.getValueShim = function (key) {
    const { base, rowRef } = splitKey(key);

    if (base === 'gabung_dtsen') return this.rosterItems('anggota', 'all');
    if (base === 'tambah_dtsen') return this.rosterItems('anggota', 'added');
    if (base === 'list_individu_dtsen_prelist') return this.rosterItems('anggota', 'prelist');
    if (base === 'usaha_gabung') return this.rosterItems('usaha', 'all');
    if (base === 'nested_dtsen') {
      const items = this.rosterItems('anggota', 'all');
      if (rowRef === '$ROW$') return items[this.rowCtx ? this.rowCtx.index : 0];
      if (rowRef != null) return items[Number(rowRef) - 1];
      return items;
    }

    let value;
    if (rowRef != null) {
      const ns = this.namespaceOf(base) || (this.rowCtx && this.rowCtx.ns) || 'anggota';
      let idx;
      if (rowRef === '$ROW$') idx = this.rowCtx ? this.rowCtx.index : 0;
      else idx = Number(rowRef) - 1; // explicit refs are 1-based in templates
      // Per-row hidden var?
      const row = this.rowsOf(ns)[idx];
      if (row && base in row) value = row[base];
      else value = this.computeRowHidden(base, ns, idx);
    } else if (this.rowCtx && this.fieldIndex[base] && this.fieldIndex[base].rowNamespace === this.rowCtx.ns) {
      // Bare member-scoped key while inside a row context.
      const row = this.rowsOf(this.rowCtx.ns)[this.rowCtx.index] || {};
      value = (base in row) ? row[base] : this.computeRowHidden(base, this.rowCtx.ns, this.rowCtx.index);
    } else {
      value = this.values[base];
      if ((value === undefined || value === null || value === '') && base in this.computed) {
        return this.computed[base];
      }
    }

    return this.choiceShape(base, value);
  };

  // Compute a per-row hidden var (ec_art_dtsen, ec_anggota_keluarga, …) inside
  // the given row context. Returns undefined when there is no such hidden var.
  FormEngine.prototype.computeRowHidden = function (base, ns, idx) {
    const hv = this.hiddenVars.find((h) => h.dataKey === base);
    if (!hv) return undefined;
    return this.withRow(ns, idx, () => this.evalExpr(hv.expression));
  };

  FormEngine.prototype.setValueShim = function (key, val) {
    const { base } = splitKey(key);
    const v = (Array.isArray(val) && val[0] && 'value' in val[0]) ? String(val[0].value) : val;
    this.values[base] = v;
  };

  FormEngine.prototype.setUserValue = function (key, val) {
    if (this.locked.has(key)) return;
    const empty = (val === '' || val === null || val === undefined);
    // Roster-scoped write?
    if (this.rowCtx) {
      const f = this.fieldIndex[key];
      if (f && f.rowNamespace === this.rowCtx.ns) {
        const row = this.rowsOf(this.rowCtx.ns)[this.rowCtx.index] || (this.rowsOf(this.rowCtx.ns)[this.rowCtx.index] = {});
        if (empty) delete row[key]; else row[key] = val;
        this.recomputeHidden();
        return;
      }
    }
    if (empty) delete this.values[key]; else this.values[key] = val;
    this.recomputeHidden();
  };

  FormEngine.prototype.recomputeHidden = function () {
    for (let pass = 0; pass < 3; pass++) {
      for (const hv of this.hiddenVars) {
        if (hv.dataKey in (this.form.predefined || {})) continue;
        // Skip clearly per-row hidden vars in the global pass.
        if (/@\$ROW\$/.test(hv.expression)) continue;
        const r = this.evalExpr(hv.expression);
        if (r !== undefined) this.computed[hv.dataKey] = r;
      }
    }
  };

  // ---- expression evaluation ------------------------------------------------

  FormEngine.prototype.makeScope = function () {
    const self = this;
    return {
      getValue: (k) => self.getValueShim(k),
      setValue: (k, v) => self.setValueShim(k, v),
      getConfig: (k) => {
        const cfg = { mode: self.values.mode || 'CAPI', isCawi: (self.values.mode === 'CAWI') };
        return k == null ? cfg : cfg[k];
      },
      getRowIndex: () => (self.rowCtx ? self.rowCtx.index + 1 : 0),
      createAlert: (msg) => { self.alerts.push(msg); },
      log: () => {},
      console: { log: () => {} },
    };
  };

  FormEngine.prototype.evalExpr = function (expr) {
    if (!expr || !String(expr).trim()) return undefined;
    const scope = this.makeScope();
    const names = Object.keys(scope);
    const args = names.map((n) => scope[n]);
    let body = String(expr)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;+\s*$/, '');

    const candidates = [];
    candidates.push(`return ( ${body} \n );`);
    const lastSemi = lastTopLevelSemicolon(body);
    if (lastSemi >= 0) {
      const head = body.slice(0, lastSemi + 1);
      const tail = body.slice(lastSemi + 1).trim();
      if (tail) candidates.push(`${head}\nreturn ( ${tail} );`);
    }
    candidates.push(body);

    for (const src of candidates) {
      try {
        const fn = new Function(...names, src);
        const r = fn(...args);
        if (r !== undefined) return r;
      } catch (_) { /* try next strategy */ }
    }
    return undefined;
  };

  function lastTopLevelSemicolon(s) {
    let depth = 0, str = null, idx = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (str) { if (c === str && s[i - 1] !== '\\') str = null; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) idx = i;
    }
    return idx;
  }

  // ---- visibility -----------------------------------------------------------

  FormEngine.prototype.isVisible = function (field) {
    const pdf = this.pdfRules[field.dataKey];
    if (typeof pdf === 'function') {
      let v;
      try { v = pdf(this); } catch (_) { v = undefined; }
      if (v === false) return false;
      if (v === true) return true;
    }
    if (field.enableCondition) {
      const r = this.evalExpr(field.enableCondition);
      if (r === undefined) return true;
      return !!r;
    }
    return true;
  };

  FormEngine.prototype.isReadOnly = function (field) {
    if (this.locked.has(field.dataKey)) return true;
    if (field.readOnlyCondition) {
      const r = this.evalExpr(field.readOnlyCondition);
      if (r === true) return true;
    }
    return false;
  };

  // ---- validation -----------------------------------------------------------

  FormEngine.prototype.validateField = function (field) {
    const out = { errors: [], warnings: [] };
    if (!field.rules || !field.rules.length) return out;
    if (!this.isVisible(field)) return out;
    for (const rule of field.rules) {
      if (!rule.test) continue;
      let bad;
      try { bad = this.evalExpr(rule.test); } catch (_) { bad = false; }
      if (bad) {
        if (rule.type === 1) out.warnings.push(rule.message);
        else out.errors.push(rule.message);
      }
    }
    return out;
  };

  global.FormEngine = FormEngine;
})(window);
