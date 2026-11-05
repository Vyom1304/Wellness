/**
 * Logbook: personal health & fitness tracker.
 * Google Sheet = database, this file = API, Index.html = UI.
 *
 * Public functions (no trailing underscore) can be called from the web app
 * through google.script.run. Every API function returns
 *   { ok: true, data: ..., error: null }   or   { ok: false, data: null, error: 'message' }
 * Functions ending in "_" are private helpers (Apps Script hides them from the client).
 */

/* ============================== config ============================== */

const TZ_DEFAULT = 'Asia/Kolkata';
const START_WEIGHT_KG_ = 50;         // first weight entry on a brand new Weights tab
const FOOD_WINDOW_DAYS = 63;          // getBootstrap sends this many days of food log (covers the 8-week charts)
const CACHE_TTL_S = 6 * 60 * 60;      // CacheService maximum
const CACHE_VERSION = 'v4';
const LOCK_WAIT_MS = 20000;
const BACKUP_FOLDER_NAME = 'Backups';
// Icon shown in the browser tab and on a phone home screen. Any public .png URL works.
const FAVICON_URL = 'https://www.gstatic.com/images/icons/material/system/2x/fitness_center_black_48dp.png';

const MUSCLES_ = ['chest', 'lats', 'upper_back', 'lower_back', 'front_delts', 'side_delts', 'rear_delts',
  'biceps', 'triceps', 'forearms', 'abs', 'quads', 'hamstrings', 'glutes', 'calves'];
const EQUIP_ = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];
const MOVES_ = ['push', 'pull', 'legs', 'core'];
const MECH_ = ['compound', 'isolation'];

const SETTINGS_DEFAULTS_ = [
  ['water_glasses', 10, 'Daily water target (glasses)'],
  ['glass_ml', 250, 'Size of one glass (ml)'],
  ['weight_unit', 'kg', 'Display unit. The app currently shows kg only.'],
  ['rotation', 'push,pull,legs', 'Routine ids in your training rotation, comma separated (see the Routines tab). Drives "Up next".']
];

/* Extra nutrients on an ingredient, per 100 g: [key used by the app, column in the Ingredients tab]. Blank cell = unknown. */
const NUTRIENTS_ = [
  ['fib', 'fibre_100g'], ['sugar', 'sugar_100g'], ['satfat', 'sat_fat_100g'], ['monofat', 'mono_fat_100g'], ['polyfat', 'poly_fat_100g'],
  ['chol', 'cholesterol_mg_100g'], ['na', 'sodium_mg_100g'], ['k', 'potassium_mg_100g'], ['ca', 'calcium_mg_100g'], ['fe', 'iron_mg_100g'],
  ['mg', 'magnesium_mg_100g'], ['phos', 'phosphorus_mg_100g'], ['zn', 'zinc_mg_100g'], ['cu', 'copper_mg_100g'], ['mn', 'manganese_mg_100g'],
  ['se', 'selenium_mcg_100g'], ['vita', 'vitamin_a_mcg_100g'], ['vitc', 'vitamin_c_mg_100g'], ['vitd', 'vitamin_d_mcg_100g'],
  ['vite', 'vitamin_e_mg_100g'], ['vitk', 'vitamin_k_mcg_100g'], ['b1', 'thiamin_b1_mg_100g'], ['b2', 'riboflavin_b2_mg_100g'],
  ['b3', 'niacin_b3_mg_100g'], ['b5', 'pantothenic_b5_mg_100g'], ['b6', 'vitamin_b6_mg_100g'], ['b7', 'biotin_b7_mcg_100g'],
  ['b9', 'folate_b9_mcg_100g'], ['b12', 'vitamin_b12_mcg_100g'], ['choline', 'choline_mg_100g']
];

/*
 * Tab layout. Each column: n = header, w = width px, f = number format,
 * list = dropdown values, v = special validation.
 * '@' = plain text (stops Sheets turning ids, names and "08:30" into numbers or times).
 */
const SCHEMA_ = {
  Settings: [
    { n: 'key', w: 140, f: '@' }, { n: 'value', w: 160 }, { n: 'notes', w: 420, f: '@' }],
  FoodLog: [
    { n: 'id', w: 110, f: '@' }, { n: 'date', w: 100, f: 'yyyy-mm-dd' }, { n: 'time', w: 60, f: '@' },
    { n: 'kind', w: 55, list: ['ing', 'rec'] }, { n: 'ref_id', w: 110, f: '@' },
    { n: 'name', w: 220, f: '@' }, { n: 'qty', w: 60, f: '0.##' }, { n: 'unit', w: 55, list: ['g', 'pc', 'srv'] },
    { n: 'kcal', w: 65, f: '0' }, { n: 'protein', w: 65, f: '0.0' }, { n: 'carbs', w: 65, f: '0.0' }, { n: 'fat', w: 65, f: '0.0' },
    { n: 'nutrients', w: 260, f: '@' }],
  Ingredients: [
    { n: 'id', w: 110, f: '@' }, { n: 'name', w: 230, f: '@' }, { n: 'kcal_100g', w: 80, f: '0' },
    { n: 'protein_100g', w: 95, f: '0.0' }, { n: 'carbs_100g', w: 85, f: '0.0' }, { n: 'fat_100g', w: 75, f: '0.0' },
    { n: 'fibre_100g', w: 80, f: '0.0' }, { n: 'unit_name', w: 85, f: '@' }, { n: 'unit_g', w: 65, f: '0.##' },
    { n: 'notes', w: 300, f: '@' }].concat(NUTRIENTS_.filter(function (n) { return n[0] !== 'fib'; }).map(function (n) { return { n: n[1], w: 100, f: '0.###' }; })),
  Recipes: [
    { n: 'id', w: 110, f: '@' }, { n: 'name', w: 220, f: '@' }, { n: 'servings', w: 75, f: '0' }, { n: 'notes', w: 300, f: '@' },
    { n: 'cooked_g', w: 95, f: '0.#' }],
  RecipeItems: [
    { n: 'recipe_id', w: 110, f: '@' }, { n: 'ingredient_id', w: 120, f: '@' }, { n: 'grams', w: 75, f: '0.##' }],
  Exercises: [
    { n: 'id', w: 120, f: '@' }, { n: 'name', w: 230, f: '@' },
    { n: 'primary_muscles', w: 170, f: '@', v: 'muscles' }, { n: 'secondary_muscles', w: 200, f: '@', v: 'muscles?' },
    { n: 'equipment', w: 95, list: EQUIP_ }, { n: 'movement_type', w: 100, list: MOVES_ },
    { n: 'mechanic', w: 90, list: MECH_ }, { n: 'base_kg', w: 70, f: '0.##' }, { n: 'notes', w: 260, f: '@' },
    { n: 'muscle_note', w: 260, f: '@', wrap: true }, { n: 'how_to', w: 420, f: '@', wrap: true },
    { n: 'cues', w: 300, f: '@', wrap: true }, { n: 'mistakes', w: 300, f: '@', wrap: true },
    { n: 'focus', w: 220, f: '@' }, { n: 'focus_assist', w: 220, f: '@' }],
  Routines: [
    { n: 'id', w: 90, f: '@' }, { n: 'name', w: 120, f: '@' }, { n: 'exercise_id', w: 120, f: '@' },
    { n: 'order', w: 55, f: '0' }, { n: 'target_sets', w: 80, f: '0' }, { n: 'target_reps', w: 85, f: '@' },
    { n: 'custom', w: 65, v: 'checkbox' }],
  Workouts: [
    { n: 'id', w: 110, f: '@' }, { n: 'date', w: 100, f: 'yyyy-mm-dd' }, { n: 'routine_id', w: 90, f: '@' },
    { n: 'name', w: 160, f: '@' }, { n: 'start_time', w: 75, f: '@' }, { n: 'duration_min', w: 95, f: '0' },
    { n: 'notes', w: 260, f: '@' }],
  WorkoutSets: [
    { n: 'id', w: 110, f: '@' }, { n: 'workout_id', w: 150, f: '@' }, { n: 'exercise_id', w: 120, f: '@' },
    { n: 'exercise_order', w: 105, f: '0' }, { n: 'set_number', w: 80, f: '0' }, { n: 'reps', w: 55, f: '0' },
    { n: 'weight_kg', w: 75, f: '0.##' }, { n: 'rpe', w: 50, f: '0.#' }, { n: 'is_warmup', w: 75, v: 'checkbox' },
    { n: 'timestamp', w: 150, f: 'yyyy-mm-dd hh:mm:ss' }],
  Weights: [
    { n: 'date', w: 100, f: 'yyyy-mm-dd' }, { n: 'weight_kg', w: 85, f: '0.0' }, { n: 'waist_cm', w: 80, f: '0.0' }],
  Wellness: [
    { n: 'date', w: 100, f: 'yyyy-mm-dd' }, { n: 'sleep_hours', w: 90, f: '0.##' }, { n: 'energy', w: 65, f: '0', v: '1-5' }],
  Water: [
    { n: 'date', w: 100, f: 'yyyy-mm-dd' }, { n: 'glasses', w: 70, f: '0', v: '>=0' }]
};
const CACHED_TABS_ = ['Ingredients', 'Exercises', 'Recipes', 'RecipeItems', 'Routines', 'Settings'];

/* ============================== web app ============================== */

function doGet() {
  const out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Logbook')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  try { if (FAVICON_URL) out.setFaviconUrl(FAVICON_URL); } catch (e) { /* icon is optional */ }
  return out;
}

/** Adds a "Logbook" menu to the spreadsheet so setup and backups can be run without the code editor. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Logbook')
    .addItem('Set up / repair tabs', 'setupFromMenu')
    .addItem('Back up now', 'backupFromMenu')
    .addSeparator()
    .addItem('Turn on weekly backup', 'installWeeklyBackup')
    .addItem('Turn off weekly backup', 'removeWeeklyBackup')
    .addItem('Refresh app cache', 'clearCache')
    .addToUi();
}

/* ============================== pure helpers (unit-tested in Node) ============================== */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function round_(n, dp) { const k = Math.pow(10, dp == null ? 2 : dp); return Math.round((+n || 0) * k) / k; }
function isBlank_(v) { return v === '' || v === null || v === undefined; }
function num_(v, def) {
  if (isBlank_(v)) return def === undefined ? 0 : def;
  const x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(x) ? (def === undefined ? 0 : def) : x;
}
function str_(v) { return isBlank_(v) ? '' : String(v).trim(); }
function bool_(v) { return v === true || /^(true|yes|y|1)$/i.test(String(v).trim()); }
/** Multi-line cells (one step / cue / mistake per line). Accepts "|" too, so the Sheet is easy to edit. */
function splitLines_(v) { return str_(v).split(/\r?\n|\|/).map(function (s) { return s.trim(); }).filter(Boolean); }
function joinLines_(a) { return (Array.isArray(a) ? a : splitLines_(a)).map(function (s) { return str_(s); }).filter(Boolean).join('\n'); }
function splitList_(v) { return str_(v).split(/[,;|]/).map(function (s) { return s.trim(); }).filter(Boolean); }
function isTmpId_(id) { return /^tmp/.test(String(id || '')); }
function isIsoDate_(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** Calendar maths on 'YYYY-MM-DD' strings, done in UTC so no timezone can shift the day. */
function isoAddDays_(s, n) {
  const p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** Any cell value -> 'YYYY-MM-DD' in the spreadsheet's timezone (or '' if it isn't a date). */
function toIsoDate_(v, tz) {
  if (isBlank_(v)) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz || TZ_DEFAULT, 'yyyy-MM-dd');
  }
  if (typeof v === 'number') { // a date serial typed into a number-formatted cell
    const d = new Date(Math.round((v - 25569) * 864e5));
    return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/); // dd/mm/yyyy (Indian locale)
  if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
  return '';
}

/** 'YYYY-MM-DD' -> Date at local midnight in tz, so the sheet shows exactly that day. */
function fromIsoDate_(s, tz) {
  if (!isIsoDate_(s)) throw new Error('Bad date "' + s + '", expected YYYY-MM-DD');
  return Utilities.parseDate(s, tz || TZ_DEFAULT, 'yyyy-MM-dd');
}

/** Any cell value -> 'HH:MM'. Time cells are stored as text, but cope with real time values too. */
function toHM_(v, tz) {
  if (isBlank_(v)) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz || TZ_DEFAULT, 'HH:mm');
  if (typeof v === 'number' && v >= 0 && v < 1) { const mins = Math.round(v * 1440); return pad2_(Math.floor(mins / 60) % 24) + ':' + pad2_(mins % 60); }
  const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? pad2_(+m[1]) + ':' + m[2] : '';
}

/** 2-D sheet values (header row first) -> { header, idx, rows: [{ _i, ...cells by header }] }. Skips empty rows. */
function tableFromValues_(values) {
  const header = (values[0] || []).map(function (h) { return str_(h); });
  const idx = {};
  header.forEach(function (h, i) { if (h && !(h in idx)) idx[h] = i; });
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row.some(function (c) { return !isBlank_(c); })) continue;
    const o = { _i: r };
    header.forEach(function (h, i) { if (h && !(h in o)) o[h] = row[i]; });
    rows.push(o);
  }
  return { header: header, idx: idx, rows: rows, values: values };
}

/** Builds a sheet row in header order. Cells not named in `fields` keep their `base` value (preserves notes/extra columns). */
function buildRow_(header, fields, base, width) {
  const out = [];
  const w = Math.max(width || 0, header.length, base ? base.length : 0);
  for (let i = 0; i < w; i++) {
    const h = header[i];
    if (h && Object.prototype.hasOwnProperty.call(fields, h)) out.push(fields[h] === undefined || fields[h] === null ? '' : fields[h]);
    else out.push(base && i < base.length ? base[i] : '');
  }
  return out;
}

/** Sorted row numbers -> [[start, count], ...] descending, for deleting bottom-up in as few calls as possible. */
function contiguousBlocks_(rowNums) {
  const s = rowNums.slice().sort(function (a, b) { return a - b; });
  const blocks = [];
  s.forEach(function (r) {
    const last = blocks[blocks.length - 1];
    if (last && r === last[0] + last[1]) last[1]++;
    else if (!last || r >= last[0] + last[1]) blocks.push([r, 1]);
  });
  return blocks.reverse();
}

/* ---------- row <-> object mapping (shapes match the design's data) ---------- */

function ingredientFromRow_(r) {
  const un = str_(r.unit_name), ug = num_(r.unit_g, 0), n = {};
  NUTRIENTS_.forEach(function (d) { const v = r[d[1]]; if (!isBlank_(v) && !isNaN(num_(v, NaN))) n[d[0]] = num_(v); });
  return {
    id: str_(r.id), name: str_(r.name),
    kcal: num_(r.kcal_100g), p: num_(r.protein_100g), c: num_(r.carbs_100g), f: num_(r.fat_100g), n: n,
    unit: un && ug > 0 ? { name: un, g: ug } : null
  };
}
function ingredientToFields_(i) {
  const f = {
    id: i.id, name: str_(i.name), kcal_100g: num_(i.kcal), protein_100g: num_(i.p), carbs_100g: num_(i.c), fat_100g: num_(i.f),
    unit_name: i.unit && i.unit.name ? str_(i.unit.name) : '', unit_g: i.unit && i.unit.g ? num_(i.unit.g) : ''
  };
  const n = i.n || {};
  NUTRIENTS_.forEach(function (d) { f[d[1]] = isBlank_(n[d[0]]) || isNaN(num_(n[d[0]], NaN)) ? '' : num_(n[d[0]]); });
  return f;
}

function recipesFromRows_(recRows, itemRows) {
  const items = {};
  itemRows.forEach(function (r) {
    const id = str_(r.recipe_id); if (!id) return;
    (items[id] = items[id] || []).push({ ing: str_(r.ingredient_id), g: num_(r.grams) });
  });
  return recRows.filter(function (r) { return str_(r.id); }).map(function (r) {
    return { id: str_(r.id), name: str_(r.name), servings: Math.max(1, num_(r.servings, 1)), cooked: num_(r.cooked_g, 0) > 0 ? num_(r.cooked_g) : null, items: items[str_(r.id)] || [] };
  });
}

function exerciseFromRow_(r) {
  return {
    id: str_(r.id), name: str_(r.name),
    prim: splitList_(r.primary_muscles), sec: splitList_(r.secondary_muscles),
    eq: str_(r.equipment) || 'barbell', mv: str_(r.movement_type) || 'push', type: str_(r.mechanic) || 'compound',
    base: num_(r.base_kg, 0),
    focus: splitList_(r.focus), fa: splitList_(r.focus_assist),
    note: str_(r.muscle_note), how: splitLines_(r.how_to), cues: splitLines_(r.cues), mist: splitLines_(r.mistakes)
  };
}
function exerciseToFields_(e) {
  const f = {
    id: e.id, name: str_(e.name), primary_muscles: (e.prim || []).join(', '), secondary_muscles: (e.sec || []).join(', '),
    equipment: e.eq, movement_type: e.mv, mechanic: e.type, base_kg: num_(e.base, 0)
  };
  if (e.focus !== undefined) f.focus = (e.focus || []).join(', ');
  if (e.fa !== undefined) f.focus_assist = (e.fa || []).join(', ');
  // only touch the how-to columns when the client sent them (an older cached page must not blank them)
  if (e.note !== undefined) f.muscle_note = str_(e.note);
  if (e.how !== undefined) f.how_to = joinLines_(e.how);
  if (e.cues !== undefined) f.cues = joinLines_(e.cues);
  if (e.mist !== undefined) f.mistakes = joinLines_(e.mist);
  return f;
}
function validateExercise_(e) {
  if (!str_(e.name)) throw new Error('Exercise needs a name');
  if (!e.prim || !e.prim.length) throw new Error('Exercise needs at least one primary muscle');
  (e.prim || []).concat(e.sec || []).forEach(function (m) { if (MUSCLES_.indexOf(m) < 0) throw new Error('Unknown muscle "' + m + '"'); });
  if (EQUIP_.indexOf(e.eq) < 0) throw new Error('Unknown equipment "' + e.eq + '"');
  if (MOVES_.indexOf(e.mv) < 0) throw new Error('Unknown movement "' + e.mv + '"');
  if (MECH_.indexOf(e.type) < 0) throw new Error('Unknown type "' + e.type + '"');
}

function routinesFromRows_(rows) {
  const by = {}, order = [];
  rows.forEach(function (r, i) {
    const id = str_(r.id); if (!id) return;
    if (!by[id]) { by[id] = { id: id, name: str_(r.name) || id, ex: [], custom: false, _items: [] }; order.push(id); }
    const R = by[id];
    if (!R.name && str_(r.name)) R.name = str_(r.name);
    if (bool_(r.custom)) R.custom = true;
    if (str_(r.exercise_id)) R._items.push({ ex: str_(r.exercise_id), o: num_(r.order, 1e6 + i), i: i });
  });
  return order.map(function (id) {
    const R = by[id];
    R.ex = R._items.sort(function (a, b) { return a.o - b.o || a.i - b.i; }).map(function (x) { return x.ex; });
    const out = { id: R.id, name: R.name, ex: R.ex };
    if (R.custom) out.custom = true;
    return out;
  });
}

function foodFromRow_(r, tz) {
  let n = {};
  try { const raw = str_(r.nutrients); if (raw) n = JSON.parse(raw) || {}; } catch (e) { n = {}; }
  return {
    id: str_(r.id), date: toIsoDate_(r.date, tz), time: toHM_(r.time, tz) || '12:00',
    kind: str_(r.kind) === 'rec' ? 'rec' : 'ing', ref: str_(r.ref_id), qty: num_(r.qty), unit: str_(r.unit) || 'g',
    name: str_(r.name), kcal: num_(r.kcal), p: num_(r.protein), c: num_(r.carbs), f: num_(r.fat), n: n
  };
}
/** Client entry/patch -> sheet fields. Only keys present in `e` are returned, so a patch only touches what it changes. */
function foodToFields_(e, tz) {
  const f = {};
  if ('id' in e) f.id = e.id;
  if ('date' in e) f.date = fromIsoDate_(e.date, tz);
  if ('time' in e) f.time = toHM_(e.time) || '12:00';
  if ('kind' in e) { if (e.kind !== 'ing' && e.kind !== 'rec') throw new Error('Unknown kind "' + e.kind + '"'); f.kind = e.kind; }
  if ('ref' in e) f.ref_id = str_(e.ref);
  if ('name' in e) f.name = str_(e.name);
  if ('qty' in e) f.qty = num_(e.qty);
  if ('unit' in e) { if (['g', 'pc', 'srv'].indexOf(e.unit) < 0) throw new Error('Unknown unit "' + e.unit + '"'); f.unit = e.unit; }
  if ('kcal' in e) f.kcal = round_(e.kcal, 1);
  if ('p' in e) f.protein = round_(e.p, 2);
  if ('c' in e) f.carbs = round_(e.c, 2);
  if ('f' in e) f.fat = round_(e.f, 2);
  if ('n' in e) {
    const n = {};
    NUTRIENTS_.forEach(function (d) { const v = e.n && e.n[d[0]]; if (!isBlank_(v) && !isNaN(num_(v, NaN))) n[d[0]] = round_(v, 4); });
    f.nutrients = Object.keys(n).length ? JSON.stringify(n) : '';
  }
  return f;
}

function targetsFromSettings_(rows) {
  const s = {};
  rows.forEach(function (r) { if (str_(r.key)) s[str_(r.key)] = r.value; });
  return {
    targets: { water: Math.max(1, Math.round(num_(s.water_glasses, 10))), glassMl: num_(s.glass_ml, 250) },
    rotation: isBlank_(s.rotation) ? ['push', 'pull', 'legs'] : splitList_(s.rotation),
    weightUnit: str_(s.weight_unit) || 'kg'
  };
}

/** Workouts + WorkoutSets rows -> design workout objects { id, date, routine, name, start, dur, ex: [{ id, sets: [{ w, r, rpe }] }] }. */
function workoutsFromRows_(woRows, setRows, tz) {
  const sets = {};
  setRows.forEach(function (r, i) {
    const wid = str_(r.workout_id); if (!wid) return;
    (sets[wid] = sets[wid] || []).push({ ex: str_(r.exercise_id), eo: num_(r.exercise_order, 0), n: num_(r.set_number, 0), i: i,
      w: num_(r.weight_kg), r: num_(r.reps), rpe: isBlank_(r.rpe) ? '' : num_(r.rpe) });
  });
  const out = woRows.filter(function (r) { return str_(r.id) && toIsoDate_(r.date, tz); }).map(function (r) {
    const id = str_(r.id), ss = (sets[id] || []).sort(function (a, b) { return a.eo - b.eo || a.n - b.n || a.i - b.i; });
    const ex = [];
    ss.forEach(function (s) {
      let last = ex[ex.length - 1];
      if (!last || last._eo !== s.eo || last.id !== s.ex) { last = { id: s.ex, sets: [], _eo: s.eo }; ex.push(last); }
      last.sets.push({ w: s.w, r: s.r, rpe: s.rpe });
    });
    return {
      id: id, date: toIsoDate_(r.date, tz), routine: str_(r.routine_id) || 'empty', name: str_(r.name) || 'Workout',
      start: toHM_(r.start_time, tz) || '', dur: Math.round(num_(r.duration_min)),
      ex: ex.map(function (x) { return { id: x.id, sets: x.sets }; })
    };
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start < b.start ? -1 : a.start > b.start ? 1 : 0); });
}

/** Same result as the design's mock getExerciseHistory. */
function exerciseHistory_(workouts, exId) {
  return workouts.filter(function (w) { return w.ex.some(function (x) { return x.id === exId; }); })
    .map(function (w) { return { date: w.date, sets: w.ex.filter(function (x) { return x.id === exId; })[0].sets }; });
}

/** Final workout object -> WorkoutSets field objects. Keeps draft timestamps where a draft row matches. */
function workoutSetFields_(w, realId, resolve, draftTimes, now) {
  const out = [];
  (w.ex || []).forEach(function (x, i) {
    const exId = resolve ? resolve(x.id) : x.id;
    (x.sets || []).forEach(function (s, j) {
      out.push({
        id: newId_('s'), workout_id: realId, exercise_id: exId, exercise_order: i + 1, set_number: j + 1,
        reps: num_(s.r), weight_kg: num_(s.w), rpe: isBlank_(s.rpe) ? '' : num_(s.rpe), is_warmup: false,
        timestamp: (draftTimes && draftTimes[(i + 1) + ':' + (j + 1)]) || draftTimes && draftTimes[exId + '#' + (j + 1)] || now
      });
    });
  });
  return out;
}

function newId_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

/* ============================== spreadsheet plumbing ============================== */

let CTX_ = null;
function ss_() {
  if (CTX_ && CTX_.ss) return CTX_.ss;
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* not bound */ }
  if (!ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('No spreadsheet found. Open the Sheet, then Extensions → Apps Script, and run setup().');
    ss = SpreadsheetApp.openById(id);
  }
  CTX_ = { ss: ss, tz: ss.getSpreadsheetTimeZone() || TZ_DEFAULT, tables: {} };
  return ss;
}
function tz_() { ss_(); return CTX_.tz; }

/** Reads a whole tab with one getValues() call (memoised for the rest of this request). */
function table_(name) {
  ss_();
  if (CTX_.tables[name]) return CTX_.tables[name];
  const sh = CTX_.ss.getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Run setup() (menu: Logbook → Set up / repair tabs).');
  const lr = sh.getLastRow(), lc = Math.max(sh.getLastColumn(), 1);
  const values = lr ? sh.getRange(1, 1, lr, lc).getValues() : [[]];
  const t = tableFromValues_(values);
  t.sh = sh; t.name = name; t.width = lc;
  (SCHEMA_[name] || []).forEach(function (c) { if (!(c.n in t.idx)) throw new Error('Column "' + c.n + '" is missing in the ' + name + ' tab. Run setup() to add it.'); });
  CTX_.tables[name] = t;
  return t;
}

function appendObjects_(t, objs) {
  if (!objs.length) return;
  const rows = objs.map(function (o) { return buildRow_(t.header, o, null, t.width); });
  const start = t.sh.getLastRow() + 1, need = start + rows.length - 1, max = t.sh.getMaxRows();
  if (need > max) t.sh.insertRowsAfter(max, need - max); // new rows inherit the formats/validation of the row above
  t.sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  rows.forEach(function (row, k) {
    const o = { _i: start - 1 + k };
    t.header.forEach(function (h, i) { if (h) o[h] = row[i]; });
    t.rows.push(o); t.values[start - 1 + k] = row;
  });
}

function updateRow_(t, rowObj, fields) {
  const base = t.values[rowObj._i];
  const row = buildRow_(t.header, fields, base, t.width);
  t.sh.getRange(rowObj._i + 1, 1, 1, row.length).setValues([row]);
  t.values[rowObj._i] = row;
  t.header.forEach(function (h, i) { if (h) rowObj[h] = row[i]; });
}

/** Deletes the given row objects (bottom-up, contiguous blocks in one call each). The memoised table is dropped afterwards. */
function deleteRows_(t, rowObjs) {
  if (!rowObjs.length) return;
  contiguousBlocks_(rowObjs.map(function (r) { return r._i + 1; })).forEach(function (b) { t.sh.deleteRows(b[0], b[1]); });
  delete CTX_.tables[t.name];
}

function findBy_(t, col, val) {
  for (let i = 0; i < t.rows.length; i++) if (str_(t.rows[i][col]) === val) return t.rows[i];
  return null;
}
function findByDate_(t, iso) {
  const tz = tz_();
  for (let i = 0; i < t.rows.length; i++) if (toIsoDate_(t.rows[i].date, tz) === iso) return t.rows[i];
  return null;
}

/* ---------- cache (chunked, so large tabs still fit the 100 KB per-key limit) ---------- */

function cacheKey_(k) { return 'logbook:' + CACHE_VERSION + ':' + k; }
function cacheGet_(k) {
  try {
    const c = CacheService.getScriptCache(), head = c.get(cacheKey_(k));
    if (!head) return null;
    const n = +head;
    const keys = []; for (let i = 0; i < n; i++) keys.push(cacheKey_(k) + ':' + i);
    const parts = c.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) { if (parts[keys[i]] == null) return null; s += parts[keys[i]]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}
function cachePut_(k, obj) {
  try {
    const s = JSON.stringify(obj), size = 90000, map = {};
    let n = 0;
    for (let i = 0; i < s.length; i += size) map[cacheKey_(k) + ':' + (n++)] = s.slice(i, i + size);
    map[cacheKey_(k)] = String(n);
    CacheService.getScriptCache().putAll(map, CACHE_TTL_S);
  } catch (e) { /* cache is best-effort */ }
}
function cacheBust_(names) {
  try { CacheService.getScriptCache().removeAll(names.map(function (n) { return cacheKey_(n); })); } catch (e) { /* ignore */ }
}
function cached_(k, fn) {
  const hit = cacheGet_(k);
  if (hit) return hit;
  const v = fn(); cachePut_(k, v); return v;
}

/* ---------- temporary id -> real id map (lets retries and references to just-created items resolve) ---------- */

function rememberId_(tmp, real) { if (isTmpId_(tmp)) try { CacheService.getScriptCache().put(cacheKey_('id:' + tmp), real, CACHE_TTL_S); } catch (e) { /* ignore */ } }
function resolveId_(id) {
  id = str_(id);
  if (!isTmpId_(id)) return id;
  try { return CacheService.getScriptCache().get(cacheKey_('id:' + id)) || id; } catch (e) { return id; }
}

/* ---------- request wrappers ---------- */

function respond_(fn) {
  try {
    CTX_ = null;
    return { ok: true, data: fn(), error: null };
  } catch (e) {
    console.error(e && e.stack || e);
    return { ok: false, data: null, error: String(e && e.message || e) };
  } finally { CTX_ = null; }
}
function write_(fn) {
  return respond_(function () {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error('Busy, please retry');
    try { return fn(); } finally { lock.releaseLock(); }
  });
}

/* ============================== readers ============================== */

function readTargets_() { return cached_('Settings', function () { return targetsFromSettings_(table_('Settings').rows); }); }
function readIngredients_() {
  return cached_('Ingredients', function () {
    return table_('Ingredients').rows.filter(function (r) { return str_(r.id) && str_(r.name); }).map(ingredientFromRow_);
  });
}
function readRecipes_() {
  return cached_('Recipes', function () { return recipesFromRows_(table_('Recipes').rows, table_('RecipeItems').rows); });
}
function readExercises_() {
  return cached_('Exercises', function () {
    return table_('Exercises').rows.filter(function (r) { return str_(r.id) && str_(r.name); }).map(exerciseFromRow_);
  });
}
function readRoutines_() { return cached_('Routines', function () { return routinesFromRows_(table_('Routines').rows); }); }
function readFoodLog_(date, from) {
  const tz = tz_();
  return table_('FoodLog').rows.map(function (r) { return foodFromRow_(r, tz); })
    .filter(function (e) { return e.id && e.date && (!date || e.date === date) && (!from || e.date >= from); });
}
function readWater_(from) {
  const tz = tz_(), out = {};
  table_('Water').rows.forEach(function (r) { const d = toIsoDate_(r.date, tz); if (d && (!from || d >= from)) out[d] = Math.max(0, Math.round(num_(r.glasses))); });
  return out;
}
function readWeights_() {
  const tz = tz_();
  return table_('Weights').rows.map(function (r) { return { date: toIsoDate_(r.date, tz), kg: num_(r.weight_kg, NaN) }; })
    .filter(function (w) { return w.date && !isNaN(w.kg) && w.kg > 0; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}
function readWellness_() {
  const tz = tz_();
  return table_('Wellness').rows.map(function (r) { return { date: toIsoDate_(r.date, tz), sleep: num_(r.sleep_hours), energy: Math.round(num_(r.energy, 3)) }; })
    .filter(function (w) { return w.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}
function readWorkouts_() { return workoutsFromRows_(table_('Workouts').rows, table_('WorkoutSets').rows, tz_()); }

/* ============================== API (called by Index.html) ============================== */

/** Everything the first screen needs, in one round trip. `today` = the phone's 'YYYY-MM-DD'. */
function getBootstrap(today) {
  return respond_(function () {
    const tz = tz_();
    const t = isIsoDate_(today) ? today : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const from = isoAddDays_(t, -FOOD_WINDOW_DAYS);
    const s = readTargets_(), routines = readRoutines_();
    const ids = routines.map(function (r) { return r.id; });
    return {
      targets: s.targets,
      rotation: s.rotation.filter(function (id) { return ids.indexOf(id) > -1; }),
      ingredients: readIngredients_(), recipes: readRecipes_(), exercises: readExercises_(), routines: routines,
      foodLog: readFoodLog_(null, from), foodLogFrom: from, water: readWater_(from),
      weights: readWeights_(), wellness: readWellness_(), workouts: readWorkouts_()
    };
  });
}

function getTargets() { return respond_(function () { return readTargets_().targets; }); }

/** With a date: that day's entries. Without: the whole log. */
function getFoodLog(date) { return respond_(function () { return readFoodLog_(isIsoDate_(date) ? date : null, null); }); }

function addFoodEntry(entry) {
  return write_(function () {
    const tz = tz_(), t = table_('FoodLog');
    if (!entry || !isIsoDate_(entry.date)) throw new Error('Entry needs a date');
    let id = str_(entry.id);
    if (isTmpId_(id)) {
      const known = resolveId_(id);
      if (known !== id) { const r = findBy_(t, 'id', known); if (r) return foodFromRow_(r, tz); } // retry of a save that already landed
    } else if (id) {
      const r = findBy_(t, 'id', id);
      if (r) { updateRow_(t, r, foodToFields_(stripId_(entry), tz)); return foodFromRow_(r, tz); }
    }
    const realId = id && !isTmpId_(id) ? id : newId_('f');
    const e = Object.assign({}, entry, { id: realId, ref: resolveId_(entry.ref) });
    ['qty', 'kcal', 'p', 'c', 'f'].forEach(function (k) { if (!(k in e)) e[k] = 0; });
    if (!('unit' in e)) e.unit = 'g';
    if (!('kind' in e)) e.kind = 'ing';
    if (!('time' in e)) e.time = '12:00';
    appendObjects_(t, [foodToFields_(e, tz)]);
    rememberId_(id, realId);
    return foodFromRow_(t.rows[t.rows.length - 1], tz);
  });
}
function stripId_(o) { const c = Object.assign({}, o); delete c.id; return c; }

function updateFoodEntry(id, patch) {
  return write_(function () {
    const tz = tz_(), t = table_('FoodLog'), r = findBy_(t, 'id', resolveId_(id));
    if (!r) throw new Error('That entry no longer exists');
    const p = stripId_(patch || {});
    if ('ref' in p) p.ref = resolveId_(p.ref);
    updateRow_(t, r, foodToFields_(p, tz));
    return foodFromRow_(r, tz);
  });
}

function deleteFoodEntry(id) {
  return write_(function () {
    const t = table_('FoodLog'), r = findBy_(t, 'id', resolveId_(id));
    if (r) deleteRows_(t, [r]);
    return { ok: true };
  });
}

function getIngredients() { return respond_(readIngredients_); }

function saveIngredient(ing) {
  return write_(function () {
    if (!ing || !str_(ing.name)) throw new Error('Ingredient needs a name');
    if (isBlank_(ing.kcal) || isNaN(num_(ing.kcal, NaN))) throw new Error('Ingredient needs calories');
    const t = table_('Ingredients');
    const id = resolveId_(ing.id), existing = id && !isTmpId_(id) ? findBy_(t, 'id', id) : null;
    const realId = existing ? id : (id && !isTmpId_(id) ? id : newId_('i'));
    const fields = ingredientToFields_(Object.assign({}, ing, { id: realId }));
    if (existing) updateRow_(t, existing, fields);
    else { fields.notes = 'Added from the app'; appendObjects_(t, [fields]); }
    rememberId_(ing.id, realId);
    cacheBust_(['Ingredients']);
    return ingredientFromRow_(existing || t.rows[t.rows.length - 1]);
  });
}

function getRecipes() { return respond_(readRecipes_); }

function saveRecipe(rec) {
  return write_(function () {
    if (!rec || !str_(rec.name)) throw new Error('Recipe needs a name');
    if (!rec.items || !rec.items.length) throw new Error('Recipe needs at least one ingredient');
    const t = table_('Recipes');
    const id = resolveId_(rec.id), existing = id && !isTmpId_(id) ? findBy_(t, 'id', id) : null;
    const realId = existing ? id : (id && !isTmpId_(id) ? id : newId_('r'));
    const fields = { id: realId, name: str_(rec.name), servings: Math.max(1, Math.round(num_(rec.servings, 1))), cooked_g: num_(rec.cooked, 0) > 0 ? num_(rec.cooked) : '' };
    if (existing) updateRow_(t, existing, fields); else appendObjects_(t, [fields]);
    const items = table_('RecipeItems');
    deleteRows_(items, items.rows.filter(function (r) { return str_(r.recipe_id) === realId; }));
    const fresh = table_('RecipeItems');
    const list = rec.items.map(function (it) { return { recipe_id: realId, ingredient_id: resolveId_(it.ing), grams: num_(it.g) }; });
    appendObjects_(fresh, list);
    rememberId_(rec.id, realId);
    cacheBust_(['Recipes']);
    return { id: realId, name: fields.name, servings: fields.servings, cooked: fields.cooked_g === '' ? null : fields.cooked_g, items: list.map(function (x) { return { ing: x.ingredient_id, g: x.grams }; }) };
  });
}

function getWater() { return respond_(function () { return readWater_(null); }); }

function setWater(date, n) {
  return write_(function () {
    const tz = tz_(), t = table_('Water'), glasses = Math.max(0, Math.round(num_(n)));
    const r = findByDate_(t, date), fields = { date: fromIsoDate_(date, tz), glasses: glasses };
    if (r) updateRow_(t, r, fields); else appendObjects_(t, [fields]);
    return { date: date, n: glasses };
  });
}

function getWeights() { return respond_(readWeights_); }

/** One row per date; saving again overwrites the weight (waist_cm is kept). */
function addWeight(w) {
  return write_(function () {
    const kg = num_(w && w.kg, NaN);
    if (!(kg > 0 && kg < 500)) throw new Error('Weight must be a number of kg');
    const tz = tz_(), t = table_('Weights'), r = findByDate_(t, w.date);
    const fields = { date: fromIsoDate_(w.date, tz), weight_kg: round_(kg, 2) };
    if (r) updateRow_(t, r, fields); else appendObjects_(t, [fields]);
    return { date: w.date, kg: round_(kg, 2) };
  });
}

function getWellness() { return respond_(readWellness_); }

function saveWellness(w) {
  return write_(function () {
    const tz = tz_(), t = table_('Wellness'), r = findByDate_(t, w.date);
    const energy = Math.round(num_(w.energy, 3));
    if (energy < 1 || energy > 5) throw new Error('Energy must be 1–5');
    const fields = { date: fromIsoDate_(w.date, tz), sleep_hours: Math.max(0, Math.min(24, num_(w.sleep))), energy: energy };
    if (r) updateRow_(t, r, fields); else appendObjects_(t, [fields]);
    return { date: w.date, sleep: fields.sleep_hours, energy: energy };
  });
}

function getExercises() { return respond_(readExercises_); }

function saveExercise(ex) {
  return write_(function () {
    validateExercise_(ex || {});
    const t = table_('Exercises');
    const id = resolveId_(ex.id), existing = id && !isTmpId_(id) ? findBy_(t, 'id', id) : null;
    const realId = existing ? id : (id && !isTmpId_(id) ? id : newId_('e'));
    const fields = exerciseToFields_(Object.assign({}, ex, { id: realId }));
    if (existing) updateRow_(t, existing, fields);
    else { fields.notes = 'Added from the app'; appendObjects_(t, [fields]); }
    rememberId_(ex.id, realId);
    cacheBust_(['Exercises']);
    return exerciseFromRow_(existing || t.rows[t.rows.length - 1]);
  });
}

function getExerciseHistory(exId) { return respond_(function () { return exerciseHistory_(readWorkouts_(), resolveId_(exId)); }); }

function getRoutines() { return respond_(readRoutines_); }

function getWorkouts() { return respond_(readWorkouts_); }

/**
 * Saves one completed set the moment it is ticked, so a crash mid-workout loses nothing.
 * The workout row doesn't exist yet, so the set is filed under the app's temporary workout id (a "draft").
 * saveWorkout() later swaps the drafts for the final, checked sets.
 */
function addSet(set) {
  return write_(function () {
    if (!set || !str_(set.workoutId) || !str_(set.exId)) throw new Error('Set needs a workout and an exercise');
    if (resolveId_(set.workoutId) !== str_(set.workoutId)) return Object.assign({}, set, { id: null, ignored: true }); // workout already finished
    const t = table_('WorkoutSets'), id = newId_('s');
    appendObjects_(t, [{
      id: id, workout_id: str_(set.workoutId), exercise_id: resolveId_(set.exId),
      exercise_order: Math.round(num_(set.exIndex, -1)) + 1 || '', set_number: Math.round(num_(set.setIndex)) + 1,
      reps: num_(set.r), weight_kg: num_(set.w), rpe: isBlank_(set.rpe) ? '' : num_(set.rpe), is_warmup: false,
      timestamp: set.at ? new Date(set.at) : new Date()
    }]);
    return Object.assign({}, set, { id: id });
  });
}

function saveWorkout(w) {
  return write_(function () {
    if (!w || !isIsoDate_(w.date)) throw new Error('Workout needs a date');
    const tz = tz_(), wt = table_('Workouts');
    const clientId = str_(w.id), mapped = resolveId_(clientId);
    let realId = !isTmpId_(mapped) && mapped ? mapped : newId_('w');
    const existing = findBy_(wt, 'id', realId);
    const fields = {
      id: realId, date: fromIsoDate_(w.date, tz), routine_id: str_(w.routine) || 'empty', name: str_(w.name) || 'Workout',
      start_time: toHM_(w.start) || '', duration_min: Math.round(num_(w.dur))
    };
    // swap draft sets (filed under the temporary id) and any earlier copy for the final list
    const st = table_('WorkoutSets'), old = st.rows.filter(function (r) { const k = str_(r.workout_id); return k && (k === clientId || k === realId); });
    const times = {};
    old.forEach(function (r) {
      if (!r.timestamp) return;
      times[r.exercise_id + '#' + num_(r.set_number)] = r.timestamp;
      if (num_(r.exercise_order)) times[num_(r.exercise_order) + ':' + num_(r.set_number)] = r.timestamp;
    });
    const setFields = workoutSetFields_(w, realId, resolveId_, times, new Date());
    if (existing) updateRow_(wt, existing, fields); else appendObjects_(wt, [fields]);
    deleteRows_(st, old);
    appendObjects_(table_('WorkoutSets'), setFields);
    rememberId_(clientId, realId);
    return workoutsFromRows_([existing || wt.rows[wt.rows.length - 1]], setFields, tz)[0];
  });
}

/* ============================== setup (idempotent, never overwrites data) ============================== */

function setup() {
  const ss = ss_(), log = [];
  if (ss.getSpreadsheetTimeZone() !== TZ_DEFAULT) { ss.setSpreadsheetTimeZone(TZ_DEFAULT); log.push('Spreadsheet timezone set to ' + TZ_DEFAULT); }
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  CTX_ = null;
  const seeds = {
    Settings: function () { return SETTINGS_DEFAULTS_.map(function (s) { return { key: s[0], value: s[1], notes: s[2] }; }); },
    Ingredients: seedIngredients_, Exercises: seedExercises_, Routines: seedRoutines_,
    Weights: function () { const tz = tz_(); return [{ date: fromIsoDate_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), tz), weight_kg: START_WEIGHT_KG_ }]; }
  };
  const created = [];
  Object.keys(SCHEMA_).forEach(function (name) {
    const cols = SCHEMA_[name];
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); created.push(name); log.push('Created tab ' + name); }
    // header: write if empty, otherwise only append missing columns at the end
    const lc = sh.getLastColumn();
    const header = lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(str_) : [];
    if (!header.some(Boolean)) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c.n; })]);
    } else {
      const missing = cols.filter(function (c) { return header.indexOf(c.n) < 0; });
      if (missing.length) {
        sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing.map(function (c) { return c.n; })]);
        log.push(name + ': added columns ' + missing.map(function (c) { return c.n; }).join(', '));
      }
    }
    formatTab_(sh, cols);
    // seed only an empty tab
    if (seeds[name] && sh.getLastRow() <= 1) {
      CTX_ = null;
      const objs = seeds[name]();
      appendObjects_(table_(name), objs);
      log.push(name + ': seeded ' + objs.length + ' rows');
    }
  });
  backfillGuide_(log);
  migrateFood_(log);
  // remove the blank default tab if this run created the database
  const first = ss.getSheetByName('Sheet1');
  if (created.length && first && first.getLastRow() === 0 && first.getLastColumn() === 0 && ss.getSheets().length > 1) { ss.deleteSheet(first); log.push('Removed empty Sheet1'); }
  installChangeTrigger_(ss, log);
  cacheBust_(CACHED_TABS_);
  CTX_ = null;
  log.push('Setup complete.');
  console.log(log.join('\n'));
  return log;
}

/**
 * Fills the how-to columns for the seeded exercises, only into cells that are blank, so anything
 * edited in the Sheet (or written for your own exercises) is never replaced. Safe to run repeatedly.
 */
function backfillGuide_(log) {
  CTX_ = null;
  const t = table_('Exercises');
  const cols = ['muscle_note', 'how_to', 'cues', 'mistakes', 'focus', 'focus_assist'];
  if (cols.some(function (c) { return t.header.indexOf(c) < 0; })) return;
  let filled = 0;
  t.rows.forEach(function (r) {
    const g = Object.assign({}, guideFields_(str_(r.id)) || {}, focusFields_(str_(r.id)) || {});
    if (!Object.keys(g).length) return;
    const patch = {};
    cols.forEach(function (c) { if (isBlank_(r[c]) && g[c]) patch[c] = g[c]; });
    if (Object.keys(patch).length) { updateRow_(t, r, patch); filled++; }
  });
  if (filled) log.push('Exercises: added how-to and region details for ' + filled + ' exercises');
  CTX_ = null;
}

/**
 * Brings an existing sheet up to date without touching what you entered:
 *  - removes the five example recipes if they are still unchanged,
 *  - adds the new foods that are missing (matched by id),
 *  - fills blank vitamin / mineral cells of the original foods.
 */
function migrateFood_(log) {
  CTX_ = null;
  const rt = table_('Recipes'), it = table_('RecipeItems');
  const gone = rt.rows.filter(function (r) { return DUMMY_RECIPES_[str_(r.id)] === str_(r.name); });
  if (gone.length) {
    const ids = gone.map(function (r) { return str_(r.id); });
    deleteRows_(it, it.rows.filter(function (r) { return ids.indexOf(str_(r.recipe_id)) > -1; }));
    deleteRows_(table_('Recipes'), table_('Recipes').rows.filter(function (r) { return ids.indexOf(str_(r.id)) > -1; }));
    log.push('Recipes: removed ' + gone.length + ' example recipes');
  }
  CTX_ = null;
  const t = table_('Ingredients'), have = {};
  t.rows.forEach(function (r) { have[str_(r.id)] = true; });
  const fresh = seedNewFoods_().filter(function (o) { return !have[o.id]; });
  if (fresh.length) { appendObjects_(t, fresh); log.push('Ingredients: added ' + fresh.length + ' foods (fruits, vegetables, pulses, nuts, fish and more)'); }
  CTX_ = null;
  const t2 = table_('Ingredients');
  if (NUTRIENTS_.some(function (d) { return t2.header.indexOf(d[1]) < 0; })) return;
  let filled = 0;
  t2.rows.forEach(function (r) {
    const arr = FOOD_MICROS_[str_(r.id)];
    if (!arr) return;
    const patch = {}, all = microFields_(arr);
    Object.keys(all).forEach(function (c) { if (isBlank_(r[c])) patch[c] = all[c]; });
    if (Object.keys(patch).length) { updateRow_(t2, r, patch); filled++; }
  });
  if (filled) log.push('Ingredients: added vitamins and minerals for ' + filled + ' foods');
  CTX_ = null;
}

function formatTab_(sh, cols) {
  const lc = sh.getLastColumn(), header = sh.getRange(1, 1, 1, lc).getValues()[0].map(str_);
  if (sh.getMaxRows() < 2) sh.insertRowsAfter(1, 999);
  const rows = sh.getMaxRows() - 1;
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, lc).setFontWeight('bold').setBackground('#f1efe8');
  cols.forEach(function (c) {
    const col = header.indexOf(c.n) + 1; if (!col) return;
    sh.setColumnWidth(col, c.w);
    const rg = sh.getRange(2, col, rows, 1);
    if (c.f) rg.setNumberFormat(c.f);
    if (c.wrap) rg.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setVerticalAlignment('top');
    let dv = null;
    if (c.list) dv = SpreadsheetApp.newDataValidation().requireValueInList(c.list, true).setAllowInvalid(false).build();
    else if (c.v === 'checkbox') dv = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    else if (c.v === '1-5') dv = SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(false).setHelpText('Energy 1–5').build();
    else if (c.v === '>=0') dv = SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build();
    else if (c.v === 'muscles' || c.v === 'muscles?') {
      const a = colLetter_(col) + '2', alt = MUSCLES_.join('|');
      const re = '"^(' + alt + ')( *, *(' + alt + '))*$"';
      const f = c.v === 'muscles' ? '=REGEXMATCH(TO_TEXT(' + a + '),' + re + ')' : '=OR(' + a + '="",REGEXMATCH(TO_TEXT(' + a + '),' + re + '))';
      dv = SpreadsheetApp.newDataValidation().requireFormulaSatisfied(f).setAllowInvalid(false)
        .setHelpText('Comma-separated muscles from: ' + MUSCLES_.join(', ')).build();
      sh.getRange(1, col).setNote('Comma-separated. Valid values: ' + MUSCLES_.join(', '));
    }
    if (dv) rg.setDataValidation(dv);
  });
}
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function installChangeTrigger_(ss, log) {
  try {
    const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'onSheetChange'; });
    if (!has) { ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create(); log.push('Installed cache-refresh trigger'); }
  } catch (e) { log.push('Could not install the cache-refresh trigger (' + e.message + '). Use Logbook → Refresh app cache after editing tabs by hand.'); }
}

/** Installable onChange trigger: hand edits to the cached tabs (incl. row deletes) refresh the app's cache. */
function onSheetChange() { cacheBust_(CACHED_TABS_); }
/** Simple trigger fallback for edits. */
function onEdit(e) {
  try { const n = e && e.range ? e.range.getSheet().getName() : ''; if (!n || CACHED_TABS_.indexOf(n) > -1) cacheBust_(CACHED_TABS_); } catch (err) { /* ignore */ }
}
function clearCache() { cacheBust_(CACHED_TABS_); try { SpreadsheetApp.getActiveSpreadsheet().toast('App cache cleared'); } catch (e) { /* no UI */ } }

function setupFromMenu() {
  const log = setup();
  SpreadsheetApp.getUi().alert('Logbook setup', log.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ============================== backups ============================== */

/** Copies the whole spreadsheet into a "Backups" folder in your Drive. */
function exportBackup() {
  return respond_(function () {
    const ss = ss_(), tz = tz_(), props = PropertiesService.getScriptProperties();
    let folder = null;
    const fid = props.getProperty('BACKUP_FOLDER_ID');
    if (fid) try { folder = DriveApp.getFolderById(fid); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; }
    if (!folder) {
      const it = DriveApp.getRootFolder().getFoldersByName(BACKUP_FOLDER_NAME);
      folder = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(BACKUP_FOLDER_NAME);
      props.setProperty('BACKUP_FOLDER_ID', folder.getId());
    }
    const name = ss.getName() + ' backup ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HHmm');
    const file = DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
    return { name: name, url: file.getUrl(), folder: folder.getUrl() };
  });
}
/** Handler for the weekly trigger: throws on failure so Google emails you about it. */
function weeklyBackup() { const r = exportBackup(); if (!r.ok) throw new Error('Backup failed: ' + r.error); }
function backupFromMenu() {
  const r = exportBackup();
  SpreadsheetApp.getUi().alert(r.ok ? 'Backup saved: ' + r.data.name + '\n(in the "' + BACKUP_FOLDER_NAME + '" folder of your Drive)' : 'Backup failed: ' + r.error);
}
/** Optional: back up every Sunday around 3 am. Safe to run more than once. */
function installWeeklyBackup() {
  removeWeeklyBackup_(); ScriptApp.newTrigger('weeklyBackup').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  try { SpreadsheetApp.getActiveSpreadsheet().toast('Weekly backup is on (Sundays ~3 am)'); } catch (e) { /* no UI */ }
  return 'Weekly backup installed';
}
function removeWeeklyBackup() {
  const n = removeWeeklyBackup_();
  try { SpreadsheetApp.getActiveSpreadsheet().toast(n ? 'Weekly backup turned off' : 'Weekly backup was not on'); } catch (e) { /* no UI */ }
  return n;
}
function removeWeeklyBackup_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'weeklyBackup') { ScriptApp.deleteTrigger(t); n++; } });
  return n;
}

/* ============================== seed data ============================== */

/*
 * Ingredients, per 100 g. Values are approximate (USDA FoodData Central / IFCT 2017 / typical labels).
 * Carbs include fibre. Dry pulses and grains are raw weight; "cooked" says so.
 * [id, name, kcal, protein, carbs, fat, fibre, unit_name, unit_g]
 */
const SEED_INGREDIENTS_ = [
  // from the design (ids kept)
  ['roti', 'Roti (whole wheat)', 297, 9.6, 50, 7.5, 8.2, 'roti', 40],
  ['rice', 'Basmati rice, cooked', 130, 2.7, 28.2, 0.3, 0.4],
  ['toor', 'Toor dal, dry', 343, 22.3, 62.8, 1.5, 15],
  ['moong', 'Moong dal, dry', 347, 24, 63, 1.2, 16.3],
  ['chana', 'Chickpeas, boiled', 164, 8.9, 27.4, 2.6, 7.6],
  ['paneer', 'Paneer', 265, 18.3, 1.2, 20.8, 0],
  ['chicken', 'Chicken breast, raw', 120, 22.5, 0, 2.6, 0],
  ['egg', 'Egg, whole', 143, 12.6, 0.7, 9.5, 0, 'egg', 50],
  ['curd', 'Curd (dahi)', 61, 3.5, 4.7, 3.3, 0, 'katori', 150],
  ['milk', 'Milk, toned', 58, 3.1, 4.7, 3, 0, 'glass', 200],
  ['oats', 'Rolled oats', 389, 16.9, 66.3, 6.9, 10.6],
  ['poha', 'Poha, dry', 350, 6.6, 77, 1.2, 2],
  ['banana', 'Banana', 89, 1.1, 22.8, 0.3, 2.6, 'banana', 118],
  ['whey', 'Whey protein', 400, 80, 8, 6, 0, 'scoop', 30],
  ['almond', 'Almonds', 579, 21.2, 21.6, 49.9, 12.5],
  ['pb', 'Peanut butter', 588, 25, 20, 50, 6, 'tbsp', 16],
  ['onion', 'Onion', 40, 1.1, 9.3, 0.1, 1.7],
  ['tomato', 'Tomato', 18, 0.9, 3.9, 0.2, 1.2],
  ['spinach', 'Spinach', 23, 2.9, 3.6, 0.4, 2.2],
  ['ghee', 'Ghee', 900, 0, 0, 100, 0, 'tsp', 5],
  ['oil', 'Sunflower oil', 884, 0, 0, 100, 0, 'tbsp', 14],
  // grains & flours
  ['atta', 'Whole wheat flour (atta)', 340, 13.2, 72, 2.5, 10.7],
  ['rice_raw', 'Basmati rice, raw', 360, 7.1, 79, 0.7, 1.3],
  ['brown_rice', 'Brown rice, cooked', 123, 2.7, 25.6, 1, 1.6],
  ['dalia', 'Dalia (broken wheat), dry', 342, 12.3, 75.9, 1.3, 12.5],
  ['suji', 'Suji (semolina), dry', 360, 12.7, 72.8, 1.1, 3.9],
  ['besan', 'Besan (gram flour)', 387, 22.4, 57.8, 6.7, 10.8],
  ['bread_ww', 'Bread, whole wheat', 247, 13, 41.3, 3.4, 6.8, 'slice', 30],
  ['bread_white', 'Bread, white', 266, 7.6, 50.6, 3.3, 2.4, 'slice', 25],
  ['idli', 'Idli', 130, 4.5, 27, 0.4, 1.5, 'idli', 40],
  ['dosa', 'Dosa, plain', 165, 3.9, 29, 3.7, 1.2, 'dosa', 80],
  ['makhana', 'Makhana (fox nut)', 347, 9.7, 76.9, 0.1, 14.5],
  // pulses & soy
  ['masoor', 'Masoor dal, dry', 352, 24.6, 63, 1.1, 10.7],
  ['urad', 'Urad dal, dry', 341, 25.2, 59, 1.6, 18.3],
  ['chana_dal', 'Chana dal, dry', 360, 20.5, 60, 5.3, 17],
  ['rajma', 'Rajma (kidney beans), dry', 333, 23.6, 60, 0.8, 15.2],
  ['rajma_boiled', 'Rajma, boiled', 127, 8.7, 22.8, 0.5, 6.4],
  ['kabuli', 'Kabuli chana, dry', 364, 19.3, 60.7, 6, 17.4],
  ['sprouts', 'Moong sprouts', 30, 3, 5.9, 0.2, 1.8],
  ['soya', 'Soya chunks, dry', 345, 52, 33, 0.5, 13],
  ['tofu', 'Tofu, firm', 144, 17.3, 2.8, 8.7, 2.3],
  // meat, fish, eggs
  ['chicken_cooked', 'Chicken breast, cooked', 165, 31, 0, 3.6, 0],
  ['mutton', 'Mutton (goat), raw', 109, 20.6, 0, 2.3, 0],
  ['tuna', 'Tuna, canned in water, drained', 116, 25.5, 0, 0.8, 0, 'can', 120],
  ['egg_white', 'Egg white', 52, 10.9, 0.7, 0.2, 0, 'white', 33],
  // dairy
  ['milk_full', 'Milk, whole (3.5% fat)', 62, 3.2, 4.8, 3.3, 0, 'glass', 200],
  ['milk_skim', 'Milk, skimmed', 34, 3.4, 5, 0.1, 0, 'glass', 200],
  ['greek_yogurt', 'Greek yogurt, plain non-fat', 59, 10.2, 3.6, 0.4, 0],
  ['chaas', 'Buttermilk (chaas)', 40, 3.3, 4.8, 0.9, 0, 'glass', 200],
  ['butter', 'Butter', 717, 0.9, 0.1, 81.1, 0, 'tsp', 5],
  // fats & sweeteners
  ['mustard_oil', 'Mustard oil', 884, 0, 0, 100, 0, 'tbsp', 14],
  ['sugar', 'Sugar', 387, 0, 100, 0, 0, 'tsp', 4],
  ['honey', 'Honey', 304, 0.3, 82.4, 0, 0.2, 'tbsp', 21],
  // nuts & seeds
  ['peanuts', 'Peanuts, raw', 567, 25.8, 16.1, 49.2, 8.5],
  ['cashew', 'Cashews', 553, 18.2, 30.2, 43.8, 3.3],
  ['chia', 'Chia seeds', 486, 16.5, 42.1, 30.7, 34.4, 'tbsp', 12],
  ['flax', 'Flax seeds', 534, 18.3, 28.9, 42.2, 27.3, 'tbsp', 10],
  // fruit
  ['apple', 'Apple', 52, 0.3, 13.8, 0.2, 2.4, 'apple', 180],
  ['orange', 'Orange', 47, 0.9, 11.8, 0.1, 2.4, 'orange', 130],
  ['dates', 'Dates, dried', 282, 2.5, 75, 0.4, 8, 'date', 8],
  // vegetables
  ['potato', 'Potato, raw', 77, 2, 17.5, 0.1, 2.2],
  ['sweet_potato', 'Sweet potato, raw', 86, 1.6, 20.1, 0.1, 3],
  ['cucumber', 'Cucumber', 15, 0.7, 3.6, 0.1, 0.5],
  ['carrot', 'Carrot', 41, 0.9, 9.6, 0.2, 2.8],
  ['cauliflower', 'Cauliflower', 25, 1.9, 5, 0.3, 2],
  ['broccoli', 'Broccoli', 34, 2.8, 6.6, 0.4, 2.6],
  ['peas', 'Green peas', 81, 5.4, 14.5, 0.4, 5.7],
  ['bhindi', 'Bhindi (okra)', 33, 1.9, 7.5, 0.2, 3.2]
];
function seedIngredients_() {
  const base = SEED_INGREDIENTS_.map(function (a) {
    return Object.assign({ id: a[0], name: a[1], kcal_100g: a[2], protein_100g: a[3], carbs_100g: a[4], fat_100g: a[5], fibre_100g: a[6],
      unit_name: a[7] || '', unit_g: a[8] || '', notes: 'Approximate values per 100 g' }, microFields_(FOOD_MICROS_[a[0]]));
  });
  return base.concat(seedNewFoods_());
}

/** Recipes the first version shipped as examples. Removed from sheets that still have them untouched. */
const DUMMY_RECIPES_ = { r_curry: 'Chicken curry', r_dal: 'Dal tadka', r_bhurji: 'Paneer bhurji', r_palak: 'Palak paneer', r_chana: 'Chana masala' };

/*
 * Exercises. [id, name, primary, secondary, equipment, movement, mechanic, base_kg, notes]
 * base_kg = a typical working weight. 0 means the lift is tracked by reps (bodyweight); the app uses this.
 * The design has one "chest" muscle and one "upper_back" muscle, so chest region and traps/rhomboids go in notes.
 */
const SEED_EXERCISES_ = [
  // chest
  ['bench', 'Barbell bench press', 'chest', 'front_delts,triceps', 'barbell', 'push', 'compound', 62.5, 'Mid chest'],
  ['incline_db', 'Incline dumbbell press', 'chest', 'front_delts,triceps', 'dumbbell', 'push', 'compound', 24, 'Upper chest'],
  ['pec_deck', 'Pec deck', 'chest', '', 'machine', 'push', 'isolation', 50, 'Mid chest'],
  ['dips', 'Dips', 'chest,triceps', 'front_delts', 'bodyweight', 'push', 'compound', 0, 'Lower chest'],
  ['incline_bench', 'Incline barbell bench press', 'chest', 'front_delts,triceps', 'barbell', 'push', 'compound', 50, 'Upper chest'],
  ['decline_bench', 'Decline barbell bench press', 'chest', 'triceps', 'barbell', 'push', 'compound', 60, 'Lower chest'],
  ['db_bench', 'Dumbbell bench press', 'chest', 'front_delts,triceps', 'dumbbell', 'push', 'compound', 26, 'Mid chest'],
  ['decline_db', 'Decline dumbbell press', 'chest', 'triceps', 'dumbbell', 'push', 'compound', 24, 'Lower chest'],
  ['chest_press', 'Machine chest press', 'chest', 'front_delts,triceps', 'machine', 'push', 'compound', 50, 'Mid chest'],
  ['smith_incline', 'Smith machine incline press', 'chest', 'front_delts,triceps', 'machine', 'push', 'compound', 40, 'Upper chest'],
  ['cable_fly', 'Cable fly', 'chest', '', 'cable', 'push', 'isolation', 15, 'Mid chest'],
  ['low_high_fly', 'Low-to-high cable fly', 'chest', 'front_delts', 'cable', 'push', 'isolation', 10, 'Upper chest'],
  ['high_low_fly', 'High-to-low cable fly', 'chest', '', 'cable', 'push', 'isolation', 12.5, 'Lower chest'],
  ['db_fly', 'Dumbbell fly', 'chest', '', 'dumbbell', 'push', 'isolation', 12, 'Mid chest'],
  ['incline_db_fly', 'Incline dumbbell fly', 'chest', 'front_delts', 'dumbbell', 'push', 'isolation', 10, 'Upper chest'],
  ['pushup', 'Push-up', 'chest', 'front_delts,triceps', 'bodyweight', 'push', 'compound', 0, 'Mid chest'],
  ['decline_pushup', 'Decline push-up', 'chest', 'front_delts,triceps', 'bodyweight', 'push', 'compound', 0, 'Upper chest (feet raised)'],
  ['incline_pushup', 'Incline push-up', 'chest', 'triceps', 'bodyweight', 'push', 'compound', 0, 'Lower chest (hands raised)'],
  // back: lats
  ['lat_pd', 'Lat pulldown', 'lats', 'biceps,upper_back', 'cable', 'pull', 'compound', 57.5, 'Lats'],
  ['pullup', 'Pull-up', 'lats', 'biceps,upper_back', 'bodyweight', 'pull', 'compound', 0, 'Lats'],
  ['chinup', 'Chin-up', 'lats', 'biceps,upper_back', 'bodyweight', 'pull', 'compound', 0, 'Lats'],
  ['close_pd', 'Close-grip lat pulldown', 'lats', 'biceps', 'cable', 'pull', 'compound', 55, 'Lats'],
  ['single_pd', 'Single-arm lat pulldown', 'lats', 'biceps', 'cable', 'pull', 'compound', 25, 'Lats'],
  ['straight_pd', 'Straight-arm pulldown', 'lats', '', 'cable', 'pull', 'isolation', 25, 'Lats'],
  ['db_row', 'One-arm dumbbell row', 'lats,upper_back', 'biceps', 'dumbbell', 'pull', 'compound', 30, 'Lats, rhomboids'],
  ['pullover', 'Dumbbell pullover', 'lats', 'chest', 'dumbbell', 'pull', 'isolation', 20, 'Lats'],
  ['assisted_pullup', 'Assisted pull-up machine', 'lats', 'biceps', 'machine', 'pull', 'compound', 30, 'Lats. Log assistance as weight.'],
  // back: upper back / traps / rhomboids
  ['bb_row', 'Barbell row', 'upper_back,lats', 'biceps,lower_back', 'barbell', 'pull', 'compound', 62.5, 'Rhomboids, mid traps, lats'],
  ['cable_row', 'Seated cable row', 'upper_back', 'lats,biceps', 'cable', 'pull', 'compound', 52.5, 'Rhomboids, mid traps'],
  ['tbar_row', 'T-bar row', 'upper_back,lats', 'biceps,lower_back', 'barbell', 'pull', 'compound', 40, 'Rhomboids, mid traps'],
  ['pendlay', 'Pendlay row', 'upper_back,lats', 'biceps,lower_back', 'barbell', 'pull', 'compound', 60, 'Rhomboids, mid traps'],
  ['chest_sup_row', 'Chest-supported dumbbell row', 'upper_back', 'lats,biceps,rear_delts', 'dumbbell', 'pull', 'compound', 20, 'Rhomboids, mid traps'],
  ['machine_row', 'Seated machine row', 'upper_back', 'lats,biceps', 'machine', 'pull', 'compound', 50, 'Rhomboids, mid traps'],
  ['inverted_row', 'Inverted row', 'upper_back', 'lats,biceps', 'bodyweight', 'pull', 'compound', 0, 'Rhomboids'],
  ['bb_shrug', 'Barbell shrug', 'upper_back', 'forearms', 'barbell', 'pull', 'isolation', 80, 'Upper traps'],
  ['db_shrug', 'Dumbbell shrug', 'upper_back', 'forearms', 'dumbbell', 'pull', 'isolation', 30, 'Upper traps'],
  ['rack_pull', 'Rack pull', 'upper_back,lower_back', 'glutes,forearms', 'barbell', 'pull', 'compound', 140, 'Traps, spinal erectors'],
  ['y_raise', 'Incline prone Y raise', 'upper_back', 'rear_delts', 'dumbbell', 'pull', 'isolation', 4, 'Lower traps'],
  ['scap_pullup', 'Scapular pull-up', 'upper_back', 'lats', 'bodyweight', 'pull', 'isolation', 0, 'Lower traps, scapular control'],
  // back: lower back
  ['deadlift', 'Deadlift', 'lower_back,glutes,hamstrings', 'quads,upper_back,forearms', 'barbell', 'pull', 'compound', 125, 'Spinal erectors'],
  ['back_ext', 'Back extension', 'lower_back', 'glutes,hamstrings', 'bodyweight', 'pull', 'isolation', 0, 'Spinal erectors'],
  ['good_morning', 'Good morning', 'lower_back,hamstrings', 'glutes', 'barbell', 'pull', 'compound', 40, 'Spinal erectors'],
  ['reverse_hyper', 'Reverse hyperextension', 'lower_back,glutes', 'hamstrings', 'machine', 'pull', 'isolation', 20, 'Spinal erectors'],
  ['superman', 'Superman hold (seconds as reps)', 'lower_back', 'glutes', 'bodyweight', 'core', 'isolation', 0, 'Spinal erectors'],
  // shoulders
  ['ohp', 'Overhead press', 'front_delts', 'side_delts,triceps', 'barbell', 'push', 'compound', 40, 'Front delts'],
  ['db_ohp', 'Seated dumbbell shoulder press', 'front_delts', 'side_delts,triceps', 'dumbbell', 'push', 'compound', 20, 'Front delts'],
  ['arnold', 'Arnold press', 'front_delts', 'side_delts,triceps', 'dumbbell', 'push', 'compound', 16, 'Front delts'],
  ['machine_sp', 'Machine shoulder press', 'front_delts', 'side_delts,triceps', 'machine', 'push', 'compound', 40, 'Front delts'],
  ['landmine_press', 'Landmine press', 'front_delts', 'chest,triceps', 'barbell', 'push', 'compound', 20, 'Front delts'],
  ['pike_pushup', 'Pike push-up', 'front_delts', 'triceps', 'bodyweight', 'push', 'compound', 0, 'Front delts'],
  ['front_raise', 'Dumbbell front raise', 'front_delts', '', 'dumbbell', 'push', 'isolation', 10, 'Front delts'],
  ['cable_front', 'Cable front raise', 'front_delts', '', 'cable', 'push', 'isolation', 10, 'Front delts'],
  ['lat_raise', 'Cable lateral raise', 'side_delts', '', 'cable', 'push', 'isolation', 7.5, 'Side delts'],
  ['db_lat', 'Dumbbell lateral raise', 'side_delts', '', 'dumbbell', 'push', 'isolation', 10, 'Side delts'],
  ['machine_lat', 'Machine lateral raise', 'side_delts', '', 'machine', 'push', 'isolation', 20, 'Side delts'],
  ['lean_lat', 'Lean-away lateral raise', 'side_delts', '', 'dumbbell', 'push', 'isolation', 8, 'Side delts'],
  ['upright_row', 'Cable upright row', 'side_delts', 'upper_back', 'cable', 'pull', 'compound', 25, 'Side delts, traps'],
  ['face_pull', 'Face pull', 'rear_delts', 'upper_back', 'cable', 'pull', 'isolation', 20, 'Rear delts'],
  ['rev_fly', 'Reverse pec deck', 'rear_delts', '', 'machine', 'pull', 'isolation', 35, 'Rear delts'],
  ['rear_db_fly', 'Bent-over dumbbell reverse fly', 'rear_delts', 'upper_back', 'dumbbell', 'pull', 'isolation', 8, 'Rear delts'],
  ['cable_rear', 'Cable rear delt fly', 'rear_delts', 'upper_back', 'cable', 'pull', 'isolation', 7.5, 'Rear delts'],
  ['rear_row', 'Rear delt dumbbell row', 'rear_delts', 'upper_back', 'dumbbell', 'pull', 'compound', 14, 'Rear delts'],
  // biceps
  ['bb_curl', 'Barbell curl', 'biceps', 'forearms', 'barbell', 'pull', 'isolation', 32.5, ''],
  ['hammer', 'Hammer curl', 'biceps,forearms', '', 'dumbbell', 'pull', 'isolation', 14, ''],
  ['db_curl', 'Dumbbell curl', 'biceps', 'forearms', 'dumbbell', 'pull', 'isolation', 12, ''],
  ['incline_curl', 'Incline dumbbell curl', 'biceps', '', 'dumbbell', 'pull', 'isolation', 10, ''],
  ['preacher', 'EZ-bar preacher curl', 'biceps', '', 'barbell', 'pull', 'isolation', 25, ''],
  ['ez_curl', 'EZ-bar curl', 'biceps', 'forearms', 'barbell', 'pull', 'isolation', 27.5, ''],
  ['cable_curl', 'Cable curl', 'biceps', 'forearms', 'cable', 'pull', 'isolation', 25, ''],
  ['bayesian', 'Bayesian cable curl', 'biceps', '', 'cable', 'pull', 'isolation', 10, ''],
  ['conc_curl', 'Concentration curl', 'biceps', '', 'dumbbell', 'pull', 'isolation', 10, ''],
  ['spider_curl', 'Spider curl', 'biceps', '', 'dumbbell', 'pull', 'isolation', 8, ''],
  ['machine_curl', 'Machine preacher curl', 'biceps', '', 'machine', 'pull', 'isolation', 25, ''],
  // triceps
  ['pushdown', 'Triceps pushdown', 'triceps', '', 'cable', 'push', 'isolation', 27.5, ''],
  ['oh_ext', 'Overhead cable extension', 'triceps', '', 'cable', 'push', 'isolation', 22.5, ''],
  ['skull', 'EZ-bar skull crusher', 'triceps', '', 'barbell', 'push', 'isolation', 27.5, ''],
  ['cgbp', 'Close-grip bench press', 'triceps,chest', 'front_delts', 'barbell', 'push', 'compound', 50, ''],
  ['rope_pd', 'Rope pushdown', 'triceps', '', 'cable', 'push', 'isolation', 22.5, ''],
  ['db_oh_ext', 'Dumbbell overhead extension', 'triceps', '', 'dumbbell', 'push', 'isolation', 20, ''],
  ['kickback', 'Dumbbell kickback', 'triceps', '', 'dumbbell', 'push', 'isolation', 8, ''],
  ['rev_pd', 'Single-arm reverse-grip pushdown', 'triceps', '', 'cable', 'push', 'isolation', 10, ''],
  ['machine_dip', 'Machine triceps dip', 'triceps', 'chest', 'machine', 'push', 'compound', 60, ''],
  ['bench_dip', 'Bench dip', 'triceps', 'front_delts', 'bodyweight', 'push', 'compound', 0, ''],
  ['diamond_pu', 'Diamond push-up', 'triceps', 'chest', 'bodyweight', 'push', 'compound', 0, ''],
  // forearms
  ['wrist_curl', 'Wrist curl', 'forearms', '', 'dumbbell', 'pull', 'isolation', 10, 'Flexors'],
  ['rev_wrist', 'Reverse wrist curl', 'forearms', '', 'dumbbell', 'pull', 'isolation', 6, 'Extensors'],
  ['btb_wrist', 'Behind-the-back barbell wrist curl', 'forearms', '', 'barbell', 'pull', 'isolation', 30, 'Flexors'],
  ['rev_curl', 'Reverse barbell curl', 'forearms,biceps', '', 'barbell', 'pull', 'isolation', 20, 'Brachioradialis'],
  ['farmer', "Farmer's carry (seconds as reps)", 'forearms', 'upper_back', 'dumbbell', 'pull', 'compound', 30, 'Grip'],
  ['dead_hang', 'Dead hang (seconds as reps)', 'forearms', 'lats', 'bodyweight', 'pull', 'isolation', 0, 'Grip'],
  // abs / core
  ['leg_raise', 'Hanging leg raise', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['crunch', 'Cable crunch', 'abs', '', 'cable', 'core', 'isolation', 40, ''],
  ['plank', 'Plank (seconds as reps)', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['ab_wheel', 'Ab wheel rollout', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['crunch_bw', 'Crunch', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['bicycle', 'Bicycle crunch', 'abs', '', 'bodyweight', 'core', 'isolation', 0, 'Obliques'],
  ['rev_crunch', 'Reverse crunch', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['side_plank', 'Side plank (seconds as reps)', 'abs', '', 'bodyweight', 'core', 'isolation', 0, 'Obliques'],
  ['russian', 'Russian twist', 'abs', '', 'bodyweight', 'core', 'isolation', 0, 'Obliques'],
  ['knee_raise', "Captain's chair knee raise", 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['dead_bug', 'Dead bug', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['decline_situp', 'Decline sit-up', 'abs', '', 'bodyweight', 'core', 'isolation', 0, ''],
  ['pallof', 'Pallof press', 'abs', '', 'cable', 'core', 'isolation', 10, 'Anti-rotation'],
  ['woodchop', 'Cable woodchopper', 'abs', '', 'cable', 'core', 'isolation', 15, 'Obliques'],
  ['machine_crunch', 'Machine crunch', 'abs', '', 'machine', 'core', 'isolation', 30, ''],
  // quads
  ['squat', 'Back squat', 'quads,glutes', 'lower_back', 'barbell', 'legs', 'compound', 92.5, ''],
  ['leg_press', 'Leg press', 'quads', 'glutes', 'machine', 'legs', 'compound', 170, ''],
  ['leg_ext', 'Leg extension', 'quads', '', 'machine', 'legs', 'isolation', 47.5, ''],
  ['bss', 'Bulgarian split squat', 'quads,glutes', '', 'dumbbell', 'legs', 'compound', 16, ''],
  ['front_squat', 'Front squat', 'quads', 'glutes,upper_back', 'barbell', 'legs', 'compound', 70, ''],
  ['goblet', 'Goblet squat', 'quads', 'glutes', 'dumbbell', 'legs', 'compound', 24, ''],
  ['hack', 'Hack squat', 'quads', 'glutes', 'machine', 'legs', 'compound', 80, ''],
  ['smith_squat', 'Smith machine squat', 'quads', 'glutes', 'machine', 'legs', 'compound', 60, ''],
  ['pendulum', 'Pendulum squat', 'quads', 'glutes', 'machine', 'legs', 'compound', 60, ''],
  ['walking_lunge', 'Walking lunge', 'quads,glutes', 'hamstrings', 'dumbbell', 'legs', 'compound', 14, ''],
  ['rev_lunge', 'Barbell reverse lunge', 'quads,glutes', 'hamstrings', 'barbell', 'legs', 'compound', 40, ''],
  ['stepup', 'Dumbbell step-up', 'quads,glutes', '', 'dumbbell', 'legs', 'compound', 14, ''],
  ['sissy', 'Sissy squat', 'quads', '', 'bodyweight', 'legs', 'isolation', 0, ''],
  ['bw_squat', 'Bodyweight squat', 'quads', 'glutes', 'bodyweight', 'legs', 'compound', 0, ''],
  // hamstrings
  ['rdl', 'Romanian deadlift', 'hamstrings,glutes', 'lower_back', 'barbell', 'legs', 'compound', 85, ''],
  ['leg_curl', 'Lying leg curl', 'hamstrings', '', 'machine', 'legs', 'isolation', 37.5, ''],
  ['seated_curl', 'Seated leg curl', 'hamstrings', '', 'machine', 'legs', 'isolation', 45, ''],
  ['standing_curl', 'Standing single-leg curl', 'hamstrings', '', 'machine', 'legs', 'isolation', 20, ''],
  ['db_rdl', 'Dumbbell Romanian deadlift', 'hamstrings,glutes', 'lower_back', 'dumbbell', 'legs', 'compound', 26, ''],
  ['sl_rdl', 'Single-leg Romanian deadlift', 'hamstrings,glutes', '', 'dumbbell', 'legs', 'compound', 14, ''],
  ['stiff_dl', 'Stiff-leg deadlift', 'hamstrings', 'glutes,lower_back', 'barbell', 'legs', 'compound', 80, ''],
  ['nordic', 'Nordic hamstring curl', 'hamstrings', '', 'bodyweight', 'legs', 'isolation', 0, ''],
  ['glute_ham', 'Glute-ham raise', 'hamstrings', 'glutes', 'bodyweight', 'legs', 'isolation', 0, ''],
  // glutes
  ['hip_thrust', 'Barbell hip thrust', 'glutes', 'hamstrings', 'barbell', 'legs', 'compound', 105, ''],
  ['machine_thrust', 'Machine hip thrust', 'glutes', 'hamstrings', 'machine', 'legs', 'compound', 80, ''],
  ['glute_bridge', 'Glute bridge', 'glutes', 'hamstrings', 'bodyweight', 'legs', 'isolation', 0, ''],
  ['sl_hip_thrust', 'Single-leg hip thrust', 'glutes', 'hamstrings', 'bodyweight', 'legs', 'isolation', 0, ''],
  ['cable_kickback', 'Cable glute kickback', 'glutes', '', 'cable', 'legs', 'isolation', 15, ''],
  ['hip_abd', 'Hip abduction machine', 'glutes', '', 'machine', 'legs', 'isolation', 50, 'Glute medius'],
  ['pull_through', 'Cable pull-through', 'glutes', 'hamstrings', 'cable', 'legs', 'compound', 30, ''],
  ['sumo_squat', 'Dumbbell sumo squat', 'glutes,quads', 'hamstrings', 'dumbbell', 'legs', 'compound', 28, ''],
  ['sumo_dl', 'Sumo deadlift', 'glutes,quads,hamstrings', 'lower_back,upper_back,forearms', 'barbell', 'pull', 'compound', 120, ''],
  // calves
  ['calf', 'Standing calf raise', 'calves', '', 'machine', 'legs', 'isolation', 85, 'Gastrocnemius'],
  ['seated_calf', 'Seated calf raise', 'calves', '', 'machine', 'legs', 'isolation', 40, 'Soleus'],
  ['lp_calf', 'Leg press calf raise', 'calves', '', 'machine', 'legs', 'isolation', 100, ''],
  ['smith_calf', 'Smith machine calf raise', 'calves', '', 'machine', 'legs', 'isolation', 60, ''],
  ['donkey_calf', 'Donkey calf raise', 'calves', '', 'machine', 'legs', 'isolation', 60, ''],
  ['db_calf', 'Single-leg dumbbell calf raise', 'calves', '', 'dumbbell', 'legs', 'isolation', 16, ''],
  ['bw_calf', 'Bodyweight calf raise', 'calves', '', 'bodyweight', 'legs', 'isolation', 0, '']
];
function seedExercises_() {
  return SEED_EXERCISES_.map(function (a) {
    return Object.assign({ id: a[0], name: a[1], primary_muscles: a[2].split(',').join(', '), secondary_muscles: a[3] ? a[3].split(',').join(', ') : '',
      equipment: a[4], movement_type: a[5], mechanic: a[6], base_kg: a[7], notes: a[8] }, guideFields_(a[0]) || {}, focusFields_(a[0]) || {});
  });
}

/* Routines from the design: Push / Pull / Legs, Upper / Lower, and a custom Arms & Abs day. */
const SEED_ROUTINES_ = [
  ['push', 'Push', false, ['bench', 'incline_db', 'ohp', 'lat_raise', 'pushdown', 'oh_ext']],
  ['pull', 'Pull', false, ['lat_pd', 'bb_row', 'cable_row', 'face_pull', 'bb_curl', 'hammer']],
  ['legs', 'Legs', false, ['squat', 'rdl', 'leg_press', 'leg_curl', 'leg_ext', 'calf']],
  ['upper', 'Upper', false, ['bench', 'pullup', 'ohp', 'cable_row', 'bb_curl', 'skull']],
  ['lower', 'Lower', false, ['deadlift', 'bss', 'hip_thrust', 'leg_curl', 'seated_calf', 'leg_raise']],
  ['arms', 'Arms & Abs', true, ['bb_curl', 'skull', 'hammer', 'pushdown', 'crunch', 'leg_raise']]
];
function seedRoutines_() {
  const mech = {};
  SEED_EXERCISES_.forEach(function (a) { mech[a[0]] = a[6]; });
  const out = [];
  SEED_ROUTINES_.forEach(function (r) {
    r[3].forEach(function (ex, i) {
      out.push({ id: r[0], name: r[1], exercise_id: ex, order: i + 1, target_sets: 3, target_reps: mech[ex] === 'compound' ? '6-10' : '10-15', custom: r[2] });
    });
  });
  return out;
}
