/*
 * In-memory stand-ins for the Apps Script services Code.gs uses
 * (SpreadsheetApp, Utilities, CacheService, LockService, PropertiesService,
 * ScriptApp, DriveApp, HtmlService). Good enough to run Code.gs end to end in Node.
 *
 * Mimics the Sheets behaviours that matter for correctness:
 *  - getValues() returns '' for empty cells and Date objects for dates
 *  - strings written to non-text ('@') columns get auto-parsed like typed input
 *    (numbers, YYYY-MM-DD dates, HH:MM times), which is what real Sheets does
 *  - setValues() must match the range size exactly; ranges can't exceed max rows
 *  - CacheService values are capped at 100 KB, keys at 250 chars
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function partsIn(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  dtf.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  return p;
}
function offsetMin(date, tz) {
  const p = partsIn(date, tz);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
// wall-clock time in tz -> Date
function wallToDate(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetMin(new Date(guess), tz) * 60000;
  t = guess - offsetMin(new Date(t), tz) * 60000;
  return new Date(t);
}

function makeEnv(opts) {
  opts = opts || {};
  const stats = { getValues: {}, setValues: {}, deleteRows: 0, insertRows: 0 };

  const Utilities = {
    formatDate(d, tz, fmt) {
      if (!(d instanceof Date)) throw new Error('formatDate needs a Date');
      const p = partsIn(d, tz);
      return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
    },
    parseDate(s, tz, fmt) {
      if (fmt !== 'yyyy-MM-dd') throw new Error('mock parseDate only supports yyyy-MM-dd');
      const [y, m, d] = s.split('-').map(Number);
      return wallToDate(y, m, d, 0, 0, 0, tz);
    },
    getUuid: () => crypto.randomUUID()
  };

  /* ---------- sheets ---------- */
  class Range {
    constructor(sh, r, c, nr, nc) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`Bad range ${r},${c},${nr},${nc}`);
      if (r + nr - 1 > sh.maxRows) throw new Error(`Range rows ${r}..${r + nr - 1} exceed max rows ${sh.maxRows} on ${sh.name}`);
      Object.assign(this, { sh, r, c, nr, nc });
    }
    getValues() {
      stats.getValues[this.sh.name] = (stats.getValues[this.sh.name] || 0) + 1;
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.data[this.r - 1 + i] || [], o = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v instanceof Date ? new Date(v) : v); }
        out.push(o);
      }
      return out;
    }
    setValues(vals) {
      stats.setValues[this.sh.name] = (stats.setValues[this.sh.name] || 0) + 1;
      if (vals.length !== this.nr) throw new Error(`setValues rows ${vals.length} != range ${this.nr}`);
      vals.forEach((row, i) => {
        if (row.length !== this.nc) throw new Error(`setValues cols ${row.length} != range ${this.nc}`);
        const rr = this.r - 1 + i;
        while (this.sh.data.length <= rr) this.sh.data.push([]);
        row.forEach((v, j) => {
          if (v === undefined) throw new Error('setValues got undefined at ' + (rr + 1) + ',' + (this.c + j));
          this.sh.data[rr][this.c - 1 + j] = this.sh.coerce(v, this.c + j, rr + 1);
        });
      });
      return this;
    }
    getValue() { return this.getValues()[0][0]; }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat(f) { if (this.r >= 2) for (let j = 0; j < this.nc; j++) this.sh.formats[this.c + j] = f; return this; }
    setDataValidation(dv) { for (let j = 0; j < this.nc; j++) this.sh.validation[this.c + j] = dv; return this; }
    getSheet() { return this.sh; }
  }
  ['setFontWeight', 'setBackground', 'setNote', 'setHorizontalAlignment', 'setWrap', 'setWrapStrategy', 'setVerticalAlignment'].forEach(m => { Range.prototype[m] = function () { return this; }; });

  class Sheet {
    constructor(ss, name) { Object.assign(this, { ss, name, data: [], maxRows: 1000, formats: {}, validation: {}, frozen: 0 }); }
    getName() { return this.name; }
    getLastRow() { for (let r = this.data.length - 1; r >= 0; r--) if ((this.data[r] || []).some(c => c !== '' && c != null)) return r + 1; return 0; }
    getLastColumn() { let m = 0; this.data.forEach(row => (row || []).forEach((c, j) => { if (c !== '' && c != null) m = Math.max(m, j + 1); })); return m; }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(after, n) {
      stats.insertRows++;
      if (after < this.data.length) this.data.splice(after, 0, ...Array.from({ length: n }, () => []));
      this.maxRows += n;
    }
    deleteRows(start, n) { stats.deleteRows++; if (start + n - 1 > this.maxRows) throw new Error('deleteRows out of range'); this.data.splice(start - 1, n); this.maxRows -= n; }
    deleteRow(r) { this.deleteRows(r, 1); }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    setFrozenRows(n) { this.frozen = n; }
    setColumnWidth() {}
    coerce(v, col, row) {
      if (typeof v !== 'string' || row < 2 || this.formats[col] === '@') return v;
      // Sheets parses strings written by setValues like typed input
      if (/^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
      let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return wallToDate(+m[1], +m[2], +m[3], 0, 0, 0, this.ss.tz);
      m = v.match(/^(\d{1,2}):(\d{2})$/);
      if (m) return wallToDate(1899, 12, 30, +m[1], +m[2], 0, this.ss.tz);
      return v;
    }
    // test helpers
    rows() { return this.data.slice(1, this.getLastRow()).map(r => r.slice()); }
    header() { return (this.data[0] || []).slice(0, this.getLastColumn()); }
    objects() { const h = this.header(); return this.rows().map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); }
  }

  class Spreadsheet {
    constructor() { this.tz = opts.sheetTz || 'Etc/GMT'; this.sheets = [new Sheet(this, 'Sheet1')]; this.id = 'ss_' + crypto.randomUUID().slice(0, 8); this.toasts = []; }
    getId() { return this.id; }
    getName() { return 'Logbook'; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) { if (this.getSheetByName(n)) throw new Error('exists'); const s = new Sheet(this, n); this.sheets.push(s); return s; }
    deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
    getSpreadsheetTimeZone() { return this.tz; }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
    toast(m) { this.toasts.push(m); }
  }
  const ss = new Spreadsheet();

  const chain = (target, onBuild) => new Proxy(target || {}, {
    get(t, k) { if (k === 'build' || k === 'create') return () => onBuild(t); if (k in t) return t[k]; return (...a) => { (t._calls = t._calls || []).push([k, a]); return chain(t, onBuild); }; }
  });
  const SpreadsheetApp = {
    WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' },
    getActiveSpreadsheet: () => (opts.unbound ? null : ss),
    openById: id => { if (id !== ss.id) throw new Error('not found'); return ss; },
    newDataValidation: () => chain({}, t => ({ kind: 'dv', calls: t._calls })),
    getUi: () => ({ createMenu: () => chain({}, () => ({})), alert: () => {}, ButtonSet: { OK: 'OK' } })
  };

  /* ---------- cache / lock / properties ---------- */
  const cacheStore = new Map();
  const cache = {
    get(k) { if (k.length > 250) throw new Error('key too long'); return cacheStore.has(k) ? cacheStore.get(k) : null; },
    put(k, v) { if (k.length > 250) throw new Error('key too long'); if (String(v).length > 100 * 1024) throw new Error('value too large'); cacheStore.set(k, String(v)); },
    getAll(keys) { const o = {}; keys.forEach(k => { if (cacheStore.has(k)) o[k] = cacheStore.get(k); }); return o; },
    putAll(map) { Object.keys(map).forEach(k => cache.put(k, map[k])); },
    remove(k) { cacheStore.delete(k); },
    removeAll(keys) { keys.forEach(k => cacheStore.delete(k)); }
  };
  const CacheService = { getScriptCache: () => cache };
  const lockState = { held: 0, max: 0 };
  const LockService = { getScriptLock: () => ({
    tryLock() { lockState.held++; lockState.max = Math.max(lockState.max, lockState.held); return true; },
    waitLock() { this.tryLock(); },
    releaseLock() { lockState.held = Math.max(0, lockState.held - 1); }
  }) };
  const props = {};
  const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) };

  /* ---------- triggers / drive / html ---------- */
  const triggers = [];
  const ScriptApp = {
    WeekDay: { SUNDAY: 'SUNDAY' },
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: t => { const i = triggers.indexOf(t); if (i > -1) triggers.splice(i, 1); },
    newTrigger: fn => chain({}, t => { const tr = { fn, calls: t._calls, getHandlerFunction: () => fn }; triggers.push(tr); return tr; })
  };
  const folders = [];
  const mkFolder = name => { const f = { id: 'fo' + folders.length, name, files: [], getId() { return this.id; }, getUrl() { return 'https://drive/' + this.id; }, isTrashed: () => false }; folders.push(f); return f; };
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const root = { getFoldersByName: n => iter(folders.filter(f => f.name === n)), createFolder: n => mkFolder(n) };
  const DriveApp = {
    getRootFolder: () => root,
    getFolderById: id => { const f = folders.find(x => x.id === id); if (!f) throw new Error('no folder'); return f; },
    getFileById: id => ({ makeCopy: (name, folder) => { const file = { name, getUrl: () => 'https://drive/file/' + encodeURIComponent(name) }; folder.files.push(file); return file; } })
  };
  const html = { meta: {}, file: null, title: null, favicon: null };
  const HtmlService = {
    createHtmlOutputFromFile(f) {
      html.file = f;
      const o = { setTitle(t) { html.title = t; return o; }, addMetaTag(n, c) { html.meta[n] = c; return o; }, setFaviconUrl(u) { html.favicon = u; return o; }, setXFrameOptionsMode() { return o; } };
      return o;
    },
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' }
  };

  const quiet = { log() {}, error: opts.verbose ? console.error : () => {}, warn() {}, info() {} };
  const context = vm.createContext({ SpreadsheetApp, Utilities, CacheService, LockService, PropertiesService, ScriptApp, DriveApp, HtmlService, console: opts.console || quiet, Date, Math, JSON });
  // Apps Script shares one global scope across all .gs files, so load them all into one context
  fs.readdirSync(path.join(__dirname, '..', 'build')).filter(f => f.endsWith('.gs')).sort().forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'build', f), 'utf8'), context, { filename: f });
  });
  const get = expr => vm.runInContext(expr, context);
  return { ctx: context, get, ss, stats, cacheStore, triggers, folders, html, props, lockState };
}

module.exports = { makeEnv, wallToDate, partsIn };
