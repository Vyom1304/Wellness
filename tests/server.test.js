/* Unit + integration tests for build/Code.gs, run in Node against the mock services.
 *   node --test tests/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv } = require('./gas_mock');

const J = x => JSON.parse(JSON.stringify(x)); // what google.script.run would deliver
const ok = r => { assert.equal(r.ok, true, 'server error: ' + r.error); return J(r.data); };

/* ---------- design data, read straight from design/index.html ---------- */
const design = fs.readFileSync(path.join(__dirname, '..', 'design', 'index.html'), 'utf8');
function designLiteral(re) { const m = design.match(re); assert.ok(m, 'pattern not found in design: ' + re); return J(vm.runInNewContext('(' + m[1] + ')')); }
const D = {
  ingredients: designLiteral(/ingredients: (\[[\s\S]*?\n    \]),\n    recipes:/),
  recipes: designLiteral(/recipes: (\[[\s\S]*?\n    \]),\n    \/\/ \[id, name/),
  exercises: designLiteral(/exercises: (\[[\s\S]*?\n    \])\.map/).map(([id, name, prim, sec, eq, mv, type, base]) => ({ id, name, prim, sec, eq, mv, type, base })),
  routines: designLiteral(/routines: (\[[\s\S]*?\n    \]),\n    rotation/),
  targets: designLiteral(/targets: (\{[^}]*\})/),
  apiNames: [...design.match(/return \{\n    getTargets:[\s\S]*?\n  \};/)[0].matchAll(/^\s{4}(\w+):/gm)].map(m => m[1])
};

function freshEnv(opts) { const env = makeEnv(opts); env.ctx.setup(); return env; }

/* ============================== pure helpers ============================== */

test('dates: Date -> YYYY-MM-DD uses the sheet timezone, so the IST day boundary never shifts', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.toIsoDate_(new Date('2024-03-10T18:29:59Z'), 'Asia/Kolkata'), '2024-03-10');
  assert.equal(ctx.toIsoDate_(new Date('2024-03-10T18:30:00Z'), 'Asia/Kolkata'), '2024-03-11'); // 00:00 IST
  assert.equal(ctx.toIsoDate_('2024-3-5', 'Asia/Kolkata'), '2024-03-05');
  assert.equal(ctx.toIsoDate_('05/03/2024', 'Asia/Kolkata'), '2024-03-05'); // dd/mm/yyyy typed by hand
  assert.equal(ctx.toIsoDate_(45357, 'Asia/Kolkata'), '2024-03-06'); // date serial
  assert.equal(ctx.toIsoDate_('', 'Asia/Kolkata'), '');
  assert.equal(ctx.toIsoDate_('hello', 'Asia/Kolkata'), '');
});

test('dates: write/read round trip is exact for every day of a leap year, in several sheet timezones', () => {
  const { ctx } = makeEnv();
  for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'Europe/London', 'Pacific/Kiritimati']) {
    let d = '2024-01-01';
    for (let i = 0; i < 366; i++) {
      assert.equal(ctx.toIsoDate_(ctx.fromIsoDate_(d, tz), tz), d, tz + ' ' + d);
      d = ctx.isoAddDays_(d, 1);
    }
    assert.equal(d, '2025-01-01');
  }
  // midnight IST is 18:30 UTC the previous day
  assert.equal(ctx.fromIsoDate_('2024-06-01', 'Asia/Kolkata').toISOString(), '2024-05-31T18:30:00.000Z');
  assert.throws(() => ctx.fromIsoDate_('2024/06/01', 'Asia/Kolkata'));
});

test('dates: isoAddDays_ across month, year and leap day', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.isoAddDays_('2024-02-28', 1), '2024-02-29');
  assert.equal(ctx.isoAddDays_('2024-02-29', 1), '2024-03-01');
  assert.equal(ctx.isoAddDays_('2025-01-01', -1), '2024-12-31');
  assert.equal(ctx.isoAddDays_('2024-11-05', -63), '2024-09-03');
});

test('times: HH:MM normalisation from text, typed times and time cells', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.toHM_('8:05'), '08:05');
  assert.equal(ctx.toHM_('21.30'), '21:30');
  assert.equal(ctx.toHM_(0.5), '12:00');
  assert.equal(ctx.toHM_(new Date('2024-01-01T03:15:00Z'), 'Asia/Kolkata'), '08:45');
  assert.equal(ctx.toHM_(''), '');
});

test('small helpers: num_, splitList_, bool_, contiguousBlocks_', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.num_('12,5'), 12.5);
  assert.equal(ctx.num_('', 7), 7);
  assert.equal(ctx.num_('abc', null), null);
  assert.deepEqual(J(ctx.splitList_('chest, triceps ;front_delts')), ['chest', 'triceps', 'front_delts']);
  assert.equal(ctx.bool_('TRUE'), true); assert.equal(ctx.bool_(false), false);
  assert.deepEqual(J(ctx.contiguousBlocks_([5, 3, 4, 9, 10, 2, 20])), [[20, 1], [9, 2], [2, 4]]);
  assert.deepEqual(J(ctx.contiguousBlocks_([])), []);
});

test('row mapping: blank rows skipped, buildRow_ keeps columns it was not told about', () => {
  const { ctx } = makeEnv();
  const t = ctx.tableFromValues_([['id', 'name', 'notes'], ['a', 'A', 'keep me'], ['', '', ''], ['b', 'B', '']]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1]._i, 3);
  assert.deepEqual(J(ctx.buildRow_(t.header, { name: 'A2' }, t.values[1])), ['a', 'A2', 'keep me']);
  assert.deepEqual(J(ctx.buildRow_(['id', 'x'], { id: 'z', x: null })), ['z', '']);
});

const CORE = e => ({ id: e.id, name: e.name, prim: e.prim, sec: e.sec, eq: e.eq, mv: e.mv, type: e.type, base: e.base });

test('row mapping: ingredient and exercise round trips match the design shapes', () => {
  const { ctx } = makeEnv();
  for (const ing of D.ingredients) {
    const back = J(ctx.ingredientFromRow_(J(ctx.ingredientToFields_(ing))));
    assert.deepEqual(back, ing);
  }
  for (const ex of D.exercises) {
    const back = J(ctx.exerciseFromRow_(J(ctx.exerciseToFields_(ex))));
    assert.deepEqual(CORE(back), ex);
    assert.deepEqual([back.note, back.how, back.cues, back.mist], ['', [], [], []], 'design exercises have no how-to text');
  }
  // how-to text round trips as one line per step; "|" is accepted when typed into the Sheet
  const full = { ...D.exercises[0], note: 'Mid chest leads', how: ['Set up', 'Lower', 'Press'], cues: ['Chest up'], mist: ['Bouncing'] };
  const f = J(ctx.exerciseToFields_(full));
  assert.equal(f.how_to, 'Set up\nLower\nPress');
  assert.deepEqual(J(ctx.exerciseFromRow_({ ...f, how_to: 'A|B\nC' })).how, ['A', 'B', 'C']);
  // a client that did not send the how-to fields must not blank them in the Sheet
  const partial = J(ctx.exerciseToFields_(D.exercises[0]));
  for (const k of ['muscle_note', 'how_to', 'cues', 'mistakes']) assert.ok(!(k in partial), k + ' should be left alone');
});

test('row mapping: workouts group sets by exercise order, even with the same exercise twice', () => {
  const { ctx } = makeEnv();
  const day = new Date('2024-05-01T00:00:00+05:30');
  const wo = [{ id: 'w2', date: day, routine_id: 'pull', name: 'Pull day', start_time: '18:30', duration_min: 50 },
    { id: 'w1', date: new Date('2024-04-29T00:00:00+05:30'), routine_id: 'push', name: 'Push day', start_time: '07:05', duration_min: 61.4 }];
  const sets = [
    { workout_id: 'w2', exercise_id: 'curl', exercise_order: 3, set_number: 1, reps: 12, weight_kg: 10, rpe: '' },
    { workout_id: 'w2', exercise_id: 'row', exercise_order: 1, set_number: 2, reps: 8, weight_kg: 60, rpe: 8 },
    { workout_id: 'w2', exercise_id: 'row', exercise_order: 1, set_number: 1, reps: 10, weight_kg: 60, rpe: '' },
    { workout_id: 'w2', exercise_id: 'face', exercise_order: 2, set_number: 1, reps: 15, weight_kg: 20, rpe: '' },
    { workout_id: 'w2', exercise_id: 'row', exercise_order: 4, set_number: 1, reps: 6, weight_kg: 65, rpe: 9 },
    { workout_id: 'tmp123', exercise_id: 'row', exercise_order: 1, set_number: 1, reps: 1, weight_kg: 1, rpe: '' }
  ];
  const out = J(ctx.workoutsFromRows_(wo, sets, 'Asia/Kolkata'));
  assert.deepEqual(out.map(w => w.id), ['w1', 'w2']); // sorted by date
  assert.deepEqual(out[0], { id: 'w1', date: '2024-04-29', routine: 'push', name: 'Push day', start: '07:05', dur: 61, ex: [] });
  assert.deepEqual(out[1].ex, [
    { id: 'row', sets: [{ w: 60, r: 10, rpe: '' }, { w: 60, r: 8, rpe: 8 }] },
    { id: 'face', sets: [{ w: 20, r: 15, rpe: '' }] },
    { id: 'curl', sets: [{ w: 10, r: 12, rpe: '' }] },
    { id: 'row', sets: [{ w: 65, r: 6, rpe: 9 }] }]);
  // history = first occurrence per workout, like the design's mock
  assert.deepEqual(J(ctx.exerciseHistory_(out, 'row')), [{ date: '2024-05-01', sets: [{ w: 60, r: 10, rpe: '' }, { w: 60, r: 8, rpe: 8 }] }]);
});

test('row mapping: routines keep order and custom flag; settings -> targets', () => {
  const { ctx } = makeEnv();
  const r = J(ctx.routinesFromRows_([
    { id: 'a', name: 'A', exercise_id: 'x2', order: 2, custom: false },
    { id: 'b', name: 'B', exercise_id: 'y', order: 1, custom: true },
    { id: 'a', name: 'A', exercise_id: 'x1', order: 1, custom: false }]));
  assert.deepEqual(r, [{ id: 'a', name: 'A', ex: ['x1', 'x2'] }, { id: 'b', name: 'B', ex: ['y'], custom: true }]);
  const s = J(ctx.targetsFromSettings_([{ key: 'kcal', value: 2100 }, { key: 'protein_g', value: '150' }, { key: 'rotation', value: 'upper, lower' }]));
  assert.deepEqual(s.targets, { kcal: 2100, p: 150, c: 260, f: 70, water: 10, glassMl: 250 });
  assert.deepEqual(s.rotation, ['upper', 'lower']);
});

/* ============================== seed data ============================== */

test('seed: every design api function exists in Code.gs, plus getBootstrap', () => {
  const env = makeEnv();
  assert.equal(D.apiNames.length, 22);
  for (const n of D.apiNames.concat(['getBootstrap', 'doGet', 'setup', 'exportBackup', 'installWeeklyBackup'])) assert.equal(typeof env.ctx[n], 'function', n);
});

test('seed: 120+ exercises, valid tags, every muscle and equipment covered, design ids reused unchanged', () => {
  const env = makeEnv();
  const ex = J(env.get('SEED_EXERCISES_')).map(a => ({ id: a[0], name: a[1], prim: a[2].split(','), sec: a[3] ? a[3].split(',') : [], eq: a[4], mv: a[5], type: a[6], base: a[7], notes: a[8] }));
  const MUSCLES = J(env.get('MUSCLES_')), EQUIP = J(env.get('EQUIP_'));
  assert.ok(ex.length >= 120, 'only ' + ex.length);
  assert.equal(new Set(ex.map(e => e.id)).size, ex.length, 'duplicate ids');
  assert.equal(new Set(ex.map(e => e.name.toLowerCase())).size, ex.length, 'duplicate names');
  for (const e of ex) {
    for (const m of e.prim.concat(e.sec)) assert.ok(MUSCLES.includes(m), e.id + ' bad muscle ' + m);
    assert.ok(!e.prim.some(m => e.sec.includes(m)), e.id + ' muscle both primary and secondary');
    assert.ok(EQUIP.includes(e.eq), e.id); assert.ok(['push', 'pull', 'legs', 'core'].includes(e.mv), e.id); assert.ok(['compound', 'isolation'].includes(e.type), e.id);
    assert.equal(e.eq === 'bodyweight' && e.id !== 'dips' ? e.base : 0, 0, e.id + ' bodyweight lifts track reps (base 0)');
  }
  for (const m of MUSCLES) assert.ok(ex.filter(e => e.prim.includes(m)).length >= 5, m + ' has fewer than 5 primary exercises');
  for (const q of EQUIP) assert.ok(ex.filter(e => e.eq === q).length >= 10, q);
  // chest regions are in notes, since the design has a single "chest" muscle
  for (const region of ['Upper chest', 'Mid chest', 'Lower chest']) assert.ok(ex.filter(e => e.notes.startsWith(region)).length >= 3, region);
  for (const de of D.exercises) {
    const s = ex.find(e => e.id === de.id); assert.ok(s, 'design exercise missing: ' + de.id);
    assert.deepEqual({ ...s, notes: undefined }, { ...de, notes: undefined }, de.id);
  }
});

test('seed: ingredients are plausible (Atwater check), design ingredients reused unchanged', () => {
  const env = makeEnv();
  const ing = J(env.get('SEED_INGREDIENTS_'));
  assert.ok(ing.length >= 55 && ing.length <= 75, ing.length + ' ingredients');
  assert.equal(new Set(ing.map(i => i[0])).size, ing.length);
  for (const [id, name, kcal, p, c, f, fib, un, ug] of ing) {
    assert.ok(p + c + f <= 100.5, id + ' macros exceed 100 g');
    const atwater = 4 * p + 4 * c + 9 * f;
    assert.ok(Math.abs(atwater - kcal) <= Math.max(30, kcal * 0.13), `${id}: ${kcal} kcal vs Atwater ${atwater.toFixed(0)}`);
    assert.ok(fib <= c + 0.01, id + ' fibre > carbs');
    if (un) assert.ok(ug > 0, id);
  }
  for (const di of D.ingredients) {
    const s = ing.find(i => i[0] === di.id); assert.ok(s, 'design ingredient missing: ' + di.id);
    assert.deepEqual([s[1], s[2], s[3], s[4], s[5], s[6]], [di.name, di.kcal, di.p, di.c, di.f, di.fib], di.id);
    assert.deepEqual(s[7] ? { name: s[7], g: s[8] } : null, di.unit, di.id + ' unit');
  }
  const names = ing.map(i => i[1].toLowerCase()).join('|');
  for (const must of ['rice', 'roti', 'atta', 'dal', 'paneer', 'curd', 'milk', 'egg', 'chicken breast', 'oats', 'banana', 'peanut butter', 'whey']) assert.ok(names.includes(must), must);
});

test('seed: routines and recipes only reference seeded items and match the design', () => {
  const env = freshEnv();
  const b = ok(env.ctx.getBootstrap('2024-11-05'));
  const exIds = new Set(b.exercises.map(e => e.id)), ingIds = new Set(b.ingredients.map(i => i.id));
  assert.deepEqual(b.routines, D.routines);
  for (const r of b.routines) for (const e of r.ex) assert.ok(exIds.has(e), r.id + ' -> ' + e);
  assert.deepEqual(b.recipes, D.recipes.map(r => ({ id: r.id, name: r.name, servings: r.servings, items: r.items })));
  for (const r of b.recipes) for (const it of r.items) assert.ok(ingIds.has(it.ing), r.id + ' -> ' + it.ing);
});

/* ============================== setup ============================== */

test('setup: creates every tab with headers, frozen row, text/number formats and dropdowns; drops empty Sheet1', () => {
  const env = freshEnv();
  const SCHEMA = J(env.get('SCHEMA_'));
  assert.deepEqual(env.ss.getSheets().map(s => s.name).sort(), Object.keys(SCHEMA).sort());
  assert.equal(env.ss.tz, 'Asia/Kolkata');
  for (const [name, cols] of Object.entries(SCHEMA)) {
    const sh = env.ss.getSheetByName(name);
    assert.deepEqual(sh.header(), cols.map(c => c.n), name);
    assert.equal(sh.frozen, 1, name);
    cols.forEach((c, i) => {
      if (c.f) assert.equal(sh.formats[i + 1], c.f, name + '.' + c.n);
      if (c.list || c.v) assert.ok(sh.validation[i + 1], name + '.' + c.n + ' validation');
    });
  }
  for (const [tab, col] of [['FoodLog', 'meal'], ['Exercises', 'equipment'], ['Exercises', 'movement_type'], ['Exercises', 'mechanic'], ['Exercises', 'primary_muscles']]) {
    const sh = env.ss.getSheetByName(tab); assert.ok(sh.validation[sh.header().indexOf(col) + 1], tab + '.' + col);
  }
  assert.equal(env.ss.getSheetByName('Exercises').rows().length, J(env.get('SEED_EXERCISES_')).length);
  assert.ok(env.triggers.some(t => t.getHandlerFunction() === 'onSheetChange'));
  assert.equal(env.props.SPREADSHEET_ID, env.ss.id);
});

test('setup: idempotent, never overwrites data, adds missing columns at the end', () => {
  const env = makeEnv();
  // a pre-existing Weights tab from an older layout, with data
  const w = env.ss.insertSheet('Weights');
  w.data = [['date', 'weight_kg'], [new Date('2024-01-01T00:00:00+05:30'), 80.2]];
  env.ctx.setup();
  assert.deepEqual(w.header(), ['date', 'weight_kg', 'waist_cm']);
  assert.equal(w.rows()[0][1], 80.2);
  // user edits a seeded value and adds a food log row, then setup runs again
  const ex = env.ss.getSheetByName('Exercises');
  ex.data[1][1] = 'My renamed bench';
  ok(env.ctx.addFoodEntry({ id: 'tmp1', date: '2024-01-02', time: '08:00', meal: 'breakfast', kind: 'ing', ref: 'egg', qty: 2, unit: 'pc', name: 'Egg, whole', kcal: 143, p: 12.6, c: 0.7, f: 9.5 }));
  const snap = JSON.stringify(env.ss.getSheets().map(s => [s.name, s.data]));
  const log = env.ctx.setup();
  assert.equal(JSON.stringify(env.ss.getSheets().map(s => [s.name, s.data])), snap, 'second setup changed data');
  assert.ok(!J(log).some(l => /seeded|Created/.test(l)), J(log).join('\n'));
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'onSheetChange').length, 1);
});

/* ============================== exercise guide (how-to) ============================== */

test('guide: every seeded exercise has muscle note, 3-6 steps, 2+ cues, 2+ mistakes; no stray entries', () => {
  const env = makeEnv();
  const ids = J(env.get('SEED_EXERCISES_')).map(a => a[0]), guide = env.get('EXERCISE_GUIDE_');
  assert.deepEqual(Object.keys(guide).sort(), ids.slice().sort());
  for (const id of ids) {
    const g = J(env.ctx.guideFields_(id));
    const n = k => g[k].split('\n').length;
    assert.ok(g.muscle_note.length > 10, id + ' muscle_note');
    assert.ok(n('how_to') >= 3 && n('how_to') <= 6, id + ' steps ' + n('how_to'));
    assert.ok(n('cues') >= 2, id + ' cues'); assert.ok(n('mistakes') >= 2, id + ' mistakes');
    assert.ok(!/[|]/.test(g.how_to + g.cues + g.mistakes), id + ' leftover separator');
  }
  assert.equal(env.ctx.guideFields_('nope'), null);
});

test('setup: fresh sheet is seeded with how-to text, and the new columns exist with wrap', () => {
  const env = makeEnv(); env.ctx.setup();
  const sh = env.ss.getSheetByName('Exercises');
  assert.deepEqual(sh.header().slice(-6), ['muscle_note', 'how_to', 'cues', 'mistakes', 'focus', 'focus_assist']);
  const rows = sh.objects();
  assert.ok(rows.every(r => r.how_to && r.cues && r.mistakes && r.muscle_note && r.focus), 'every seeded row has how-to text and at least one target region');
  assert.equal(rows.find(r => r.id === 'incline_bench').focus, 'upper_chest');
  assert.equal(rows.find(r => r.id === 'preacher').focus, 'biceps_short');
  assert.equal(rows.find(r => r.id === 'incline_curl').focus, 'biceps_long');
});

test('setup: an existing Exercises tab gets the new columns and blank cells are filled, edits are never replaced', () => {
  const env = makeEnv(); env.ctx.setup();
  const sh = env.ss.getSheetByName('Exercises');
  // simulate a sheet from before this version: drop the six new columns, then add my own exercise and edit one
  const keep = sh.header().length - 6;
  sh.data = sh.data.map(r => r.slice(0, keep));
  sh.data.push(['mine1', 'My cable thing', 'chest', '', 'cable', 'push', 'isolation', 10, 'Added from the app']);
  env.ctx.setup();
  assert.deepEqual(sh.header().slice(-6), ['muscle_note', 'how_to', 'cues', 'mistakes', 'focus', 'focus_assist']);
  const byId = id => sh.objects().find(r => r.id === id);
  assert.ok(/Lie on the bench/.test(byId('bench').how_to), 'seeded exercise backfilled');
  assert.equal(byId('mine1').how_to, '', 'my own exercise is left alone');
  assert.equal(byId('mine1').focus, '', 'my own exercise gets no region tags');
  assert.equal(byId('bench').focus, 'mid_chest, lower_chest', 'seeded exercise gets its regions');
  // now edit one cell, blank another, and re-run: only the blank one is refilled
  const hi = sh.header().indexOf('how_to'), ci = sh.header().indexOf('cues');
  const bi = sh.data.findIndex(r => r[0] === 'bench');
  sh.data[bi][hi] = 'My own steps'; sh.data[bi][ci] = '';
  env.ctx.setup();
  assert.equal(byId('bench').how_to, 'My own steps', 'edited text kept');
  assert.ok(byId('bench').cues.length > 5, 'blank cell refilled');
  const snap = JSON.stringify(sh.data); env.ctx.setup();
  assert.equal(JSON.stringify(sh.data), snap, 'idempotent');
});

test('focus: tags cover all 144 seeded exercises with real region ids; round-trip through the Sheet', () => {
  const env = makeEnv(); env.ctx.setup();
  const ids = env.ctx.seedExercises_().map(e => e.id);
  assert.equal(ids.length, 144);
  for (const id of ids) { const f = env.ctx.focusFields_(id); assert.ok(f && f.focus, id); }
  assert.equal(env.ctx.focusFields_('nope'), null);
  const ex = ok(env.ctx.getBootstrap()).exercises.find(e => e.id === 'bench');
  assert.deepEqual(ex.focus, ['mid_chest', 'lower_chest']); assert.ok(ex.fa.includes('upper_chest'));
  const saved = ok(env.ctx.saveExercise(Object.assign({}, ex, { focus: ['upper_chest'], fa: ['front_delt'] })));
  const back = ok(env.ctx.getBootstrap()).exercises.find(e => e.id === saved.id);
  assert.deepEqual([back.focus, back.fa], [['upper_chest'], ['front_delt']]);
  // an older client that does not send focus must not blank it
  const old = Object.assign({}, back); delete old.focus; delete old.fa; ok(env.ctx.saveExercise(old));
  assert.deepEqual(ok(env.ctx.getBootstrap()).exercises.find(e => e.id === saved.id).focus, ['upper_chest']);
});

test('cache: bumped version so cached rows without the new fields are not served', () => {
  const env = makeEnv();
  assert.equal(env.get('CACHE_VERSION'), 'v3');
});

/* ============================== API ============================== */

const ENTRY = { id: 'tmp1700000000abc', date: '2024-11-05', time: '08:20', meal: 'breakfast', kind: 'ing', ref: 'oats', qty: 60, unit: 'g', name: 'Rolled oats', kcal: 233.4, p: 10.14, c: 39.78, f: 4.14 };

test('api: bootstrap returns every slice in the design shapes, with design default targets', () => {
  const env = freshEnv();
  const b = ok(env.ctx.getBootstrap('2024-11-05'));
  assert.deepEqual(Object.keys(b).sort(), ['exercises', 'foodLog', 'foodLogFrom', 'ingredients', 'recipes', 'rotation', 'routines', 'targets', 'water', 'weights', 'wellness', 'workouts'].sort());
  assert.deepEqual(b.targets, D.targets);
  assert.deepEqual(b.rotation, ['push', 'pull', 'legs']);
  assert.deepEqual(CORE(b.exercises.find(e => e.id === 'bench')), D.exercises.find(e => e.id === 'bench'));
  assert.ok(b.exercises.every(e => Array.isArray(e.how) && Array.isArray(e.cues) && Array.isArray(e.mist) && typeof e.note === 'string'), 'every exercise carries the how-to fields');
  assert.deepEqual(b.ingredients.find(i => i.id === 'roti'), D.ingredients.find(i => i.id === 'roti'));
  assert.deepEqual([b.foodLog, b.water, b.weights, b.wellness, b.workouts], [[], {}, [], [], []]);
  assert.equal(b.foodLogFrom, '2024-09-03');
  assert.deepEqual(ok(env.ctx.getTargets()), D.targets);
});

test('api: food log add / retry / update / delete; stored as real dates, history values frozen', () => {
  const env = freshEnv();
  const e = ok(env.ctx.addFoodEntry(ENTRY));
  assert.match(e.id, /^f[0-9a-f]{10}$/);
  assert.deepEqual({ ...e, id: 0 }, { ...ENTRY, id: 0, kcal: 233.4, p: 10.14, c: 39.78, f: 4.14 });
  const row = env.ss.getSheetByName('FoodLog').objects()[0];
  assert.ok(row.date instanceof Date); assert.equal(row.date.toISOString(), '2024-11-04T18:30:00.000Z'); // midnight IST
  assert.equal(row.time, '08:20'); assert.equal(typeof row.time, 'string');
  // a retry of the same save (same tmp id) must not duplicate
  assert.equal(ok(env.ctx.addFoodEntry(ENTRY)).id, e.id);
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 1);
  // editing the ingredient later doesn't change what was logged
  ok(env.ctx.saveIngredient({ ...D.ingredients.find(i => i.id === 'oats'), kcal: 999 }));
  assert.equal(ok(env.ctx.getFoodLog('2024-11-05'))[0].kcal, 233.4);
  // update moves it to another meal and day
  const u = ok(env.ctx.updateFoodEntry(e.id, { qty: 80, unit: 'g', meal: 'snack', time: '16:00', date: '2024-11-04', kcal: 311.2, p: 13.5, c: 53, f: 5.5 }));
  assert.deepEqual([u.meal, u.date, u.qty, u.name], ['snack', '2024-11-04', 80, 'Rolled oats']);
  assert.deepEqual(ok(env.ctx.getFoodLog('2024-11-05')), []);
  assert.equal(ok(env.ctx.getFoodLog()).length, 1);
  assert.equal(ok(env.ctx.deleteFoodEntry(e.id)).ok, true);
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 0);
  assert.equal(ok(env.ctx.deleteFoodEntry(e.id)).ok, true, 'deleting twice is harmless');
  // bad input -> {ok:false}
  const bad = env.ctx.addFoodEntry({ ...ENTRY, id: 'tmpX', meal: 'brunch' });
  assert.equal(bad.ok, false); assert.match(bad.error, /meal/);
  assert.equal(env.ctx.updateFoodEntry('nope', { qty: 1 }).ok, false);
});

test('api: bootstrap sends the last 63 days; older days come from getFoodLog(date)', () => {
  const env = freshEnv();
  ok(env.ctx.addFoodEntry({ ...ENTRY, id: 'tmpA', date: '2024-11-05' }));
  ok(env.ctx.addFoodEntry({ ...ENTRY, id: 'tmpB', date: '2024-09-03' }));
  ok(env.ctx.addFoodEntry({ ...ENTRY, id: 'tmpC', date: '2024-09-02' }));
  const b = ok(env.ctx.getBootstrap('2024-11-05'));
  assert.deepEqual(b.foodLog.map(e => e.date).sort(), ['2024-09-03', '2024-11-05']);
  assert.equal(ok(env.ctx.getFoodLog('2024-09-02')).length, 1);
});

test('api: ingredients — create, update keeps notes, cache is used and refreshed on write', () => {
  const env = freshEnv();
  ok(env.ctx.getIngredients());
  const reads = env.stats.getValues.Ingredients || 0;
  ok(env.ctx.getIngredients()); ok(env.ctx.getBootstrap('2024-11-05'));
  assert.equal(env.stats.getValues.Ingredients || 0, reads, 'second read should come from cache');
  const created = ok(env.ctx.saveIngredient({ id: 'tmp1', name: 'Rajma masala', kcal: 140, p: 6, c: 20, f: 4, fib: null, unit: { name: 'katori', g: 150 } }));
  assert.match(created.id, /^i/);
  assert.deepEqual({ ...created, id: 0 }, { id: 0, name: 'Rajma masala', kcal: 140, p: 6, c: 20, f: 4, fib: null, unit: { name: 'katori', g: 150 } });
  assert.ok(ok(env.ctx.getIngredients()).some(i => i.id === created.id), 'cache refreshed after write');
  const upd = ok(env.ctx.saveIngredient({ ...D.ingredients.find(i => i.id === 'paneer'), name: 'Paneer (Amul)' }));
  assert.equal(upd.name, 'Paneer (Amul)');
  const row = env.ss.getSheetByName('Ingredients').objects().find(r => r.id === 'paneer');
  assert.equal(row.notes, 'Approximate values per 100 g');
  // a food entry that references the just-created tmp id is stored with the real id
  const e = ok(env.ctx.addFoodEntry({ ...ENTRY, id: 'tmp2', ref: 'tmp1', name: 'Rajma masala' }));
  assert.equal(e.ref, created.id);
  // retry of the ingredient create returns the same row
  assert.equal(ok(env.ctx.saveIngredient({ id: 'tmp1', name: 'Rajma masala', kcal: 140, p: 6, c: 20, f: 4 })).id, created.id);
  assert.equal(env.ss.getSheetByName('Ingredients').rows().filter(r => r[1] === 'Rajma masala').length, 1);
  assert.equal(env.ctx.saveIngredient({ id: 'tmp9', name: '', kcal: 1 }).ok, false);
});

test('api: recipes — create, then update replaces only that recipe\'s items', () => {
  const env = freshEnv();
  const r = ok(env.ctx.saveRecipe({ id: 'tmp1', name: 'Rajma', servings: 4, items: [{ ing: 'rajma', g: 250 }, { ing: 'onion', g: 100 }] }));
  assert.match(r.id, /^r/);
  const before = env.ss.getSheetByName('RecipeItems').rows().length;
  const r2 = ok(env.ctx.saveRecipe({ id: 'r_dal', name: 'Dal tadka', servings: 6, items: [{ ing: 'toor', g: 300 }] }));
  assert.equal(r2.id, 'r_dal');
  const recs = ok(env.ctx.getRecipes());
  assert.deepEqual(recs.find(x => x.id === 'r_dal'), { id: 'r_dal', name: 'Dal tadka', servings: 6, items: [{ ing: 'toor', g: 300 }] });
  assert.deepEqual(recs.find(x => x.id === r.id).items, [{ ing: 'rajma', g: 250 }, { ing: 'onion', g: 100 }]);
  assert.deepEqual(recs.find(x => x.id === 'r_curry'), { ...D.recipes.find(x => x.id === 'r_curry') });
  assert.equal(env.ss.getSheetByName('RecipeItems').rows().length, before - 4 + 1);
  assert.equal(env.ctx.saveRecipe({ id: 'tmp2', name: 'Empty', servings: 1, items: [] }).ok, false);
});

test('api: water / weight / wellness keep one row per date; waist is preserved', () => {
  const env = freshEnv();
  assert.deepEqual(ok(env.ctx.setWater('2024-11-05', 3)), { date: '2024-11-05', n: 3 });
  ok(env.ctx.setWater('2024-11-05', 4)); ok(env.ctx.setWater('2024-11-04', 8));
  assert.deepEqual(ok(env.ctx.getWater()), { '2024-11-05': 4, '2024-11-04': 8 });
  assert.equal(env.ss.getSheetByName('Water').rows().length, 2);
  ok(env.ctx.addWeight({ date: '2024-11-05', kg: 78.4 }));
  env.ss.getSheetByName('Weights').data[1][2] = 84; // waist typed into the sheet
  assert.deepEqual(ok(env.ctx.addWeight({ date: '2024-11-05', kg: 78.1 })), { date: '2024-11-05', kg: 78.1 });
  assert.deepEqual(env.ss.getSheetByName('Weights').rows().map(r => [r[1], r[2]]), [[78.1, 84]]);
  ok(env.ctx.addWeight({ date: '2024-11-01', kg: 79 }));
  assert.deepEqual(ok(env.ctx.getWeights()), [{ date: '2024-11-01', kg: 79 }, { date: '2024-11-05', kg: 78.1 }]);
  assert.equal(env.ctx.addWeight({ date: '2024-11-05', kg: 'x' }).ok, false);
  ok(env.ctx.saveWellness({ date: '2024-11-05', sleep: 7.25, energy: 3 }));
  assert.deepEqual(ok(env.ctx.saveWellness({ date: '2024-11-05', sleep: 6.5, energy: 4 })), { date: '2024-11-05', sleep: 6.5, energy: 4 });
  assert.deepEqual(ok(env.ctx.getWellness()), [{ date: '2024-11-05', sleep: 6.5, energy: 4 }]);
  assert.equal(env.ctx.saveWellness({ date: '2024-11-05', sleep: 7, energy: 9 }).ok, false);
});

test('api: exercises — validation, create, edit keeps notes', () => {
  const env = freshEnv();
  const bad = env.ctx.saveExercise({ id: 'tmp1', name: 'X', prim: ['pecs'], sec: [], eq: 'barbell', mv: 'push', type: 'compound', base: 20 });
  assert.equal(bad.ok, false); assert.match(bad.error, /muscle/);
  const e = ok(env.ctx.saveExercise({ id: 'tmp2', name: 'Seal row', prim: ['upper_back'], sec: ['lats'], eq: 'barbell', mv: 'pull', type: 'compound', base: 40 }));
  assert.deepEqual({ ...CORE(e), id: 0 }, { id: 0, name: 'Seal row', prim: ['upper_back'], sec: ['lats'], eq: 'barbell', mv: 'pull', type: 'compound', base: 40 });
  assert.deepEqual([e.note, e.how, e.cues, e.mist], ['', [], [], []]);
  // an exercise you add yourself can carry its own instructions
  const own = ok(env.ctx.saveExercise({ id: 'tmp3', name: 'Cable crossover', prim: ['chest'], sec: [], eq: 'cable', mv: 'push', type: 'isolation', base: 15, note: 'Chest only', how: ['Step in', 'Bring hands together'], cues: ['Slow'], mist: ['Swinging'] }));
  assert.deepEqual([own.note, own.how, own.cues, own.mist], ['Chest only', ['Step in', 'Bring hands together'], ['Slow'], ['Swinging']]);
  assert.deepEqual(ok(env.ctx.getExercises()).find(x => x.id === own.id).how, ['Step in', 'Bring hands together']);
  ok(env.ctx.saveExercise({ ...D.exercises.find(x => x.id === 'bench'), name: 'Bench press (comp grip)' }));
  const row = env.ss.getSheetByName('Exercises').objects().find(r => r.id === 'bench');
  assert.deepEqual([row.name, row.notes, row.primary_muscles], ['Bench press (comp grip)', 'Mid chest', 'chest']);
  assert.ok(/Lie on the bench/.test(row.how_to), 'saving without how-to fields keeps the seeded instructions');
  assert.equal(ok(env.ctx.getExercises()).find(x => x.id === 'bench').name, 'Bench press (comp grip)');
});

test('api: workouts — sets saved as drafts, finish swaps them for the final list; retries are safe', () => {
  const env = freshEnv();
  const wid = 'tmp1730800000000';
  const at = '2024-11-05T12:40:00.000Z';
  ok(env.ctx.addSet({ workoutId: wid, exId: 'bench', exIndex: 0, setIndex: 0, w: 60, r: 8, rpe: null, at }));
  ok(env.ctx.addSet({ workoutId: wid, exId: 'bench', exIndex: 0, setIndex: 1, w: 60, r: 8, rpe: 8, at }));
  ok(env.ctx.addSet({ workoutId: wid, exId: 'bench', exIndex: 0, setIndex: 1, w: 62.5, r: 6, rpe: 9, at })); // re-ticked
  ok(env.ctx.addSet({ workoutId: wid, exId: 'ohp', exIndex: 1, setIndex: 0, w: 40, r: 5, rpe: null, at }));
  const sets = env.ss.getSheetByName('WorkoutSets');
  assert.equal(sets.rows().length, 4);
  assert.deepEqual(ok(env.ctx.getWorkouts()), [], 'drafts are not workouts yet');
  const w = { id: wid, date: '2024-11-05', routine: 'push', name: 'Push day', start: '18:05', dur: 52,
    ex: [{ id: 'bench', sets: [{ w: 60, r: 8, rpe: '' }, { w: 62.5, r: 6, rpe: 9 }] }, { id: 'incline_db', sets: [{ w: 24, r: 10, rpe: '' }] }] };
  const saved = ok(env.ctx.saveWorkout(w));
  assert.match(saved.id, /^w/);
  assert.deepEqual({ ...saved, id: 0 }, { ...w, id: 0 });
  const rows = sets.objects();
  assert.equal(rows.length, 3); assert.ok(rows.every(r => r.workout_id === saved.id));
  assert.equal(rows[0].timestamp.toISOString(), at, 'draft timestamp kept');
  assert.deepEqual(ok(env.ctx.getWorkouts()), [{ ...w, id: saved.id }]);
  assert.deepEqual(ok(env.ctx.getExerciseHistory('bench')), [{ date: '2024-11-05', sets: w.ex[0].sets }]);
  // network retry of the finish -> same workout, no duplicates
  assert.equal(ok(env.ctx.saveWorkout(w)).id, saved.id);
  assert.equal(env.ss.getSheetByName('Workouts').rows().length, 1);
  assert.equal(sets.rows().length, 3);
  // a late retry of an addSet for the finished workout is ignored
  assert.equal(ok(env.ctx.addSet({ workoutId: wid, exId: 'bench', exIndex: 0, setIndex: 0, w: 60, r: 8, at })).ignored, true);
  assert.equal(sets.rows().length, 3);
  const b = ok(env.ctx.getBootstrap('2024-11-05'));
  assert.equal(b.workouts.length, 1);
});

test('api: errors come back as {ok:false} with a readable message', () => {
  const env = freshEnv();
  env.ss.deleteSheet(env.ss.getSheetByName('FoodLog'));
  const r = env.ctx.getFoodLog('2024-11-05');
  assert.equal(r.ok, false); assert.match(r.error, /FoodLog.*setup/);
  const r2 = env.ctx.getBootstrap('2024-11-05');
  assert.equal(r2.ok, false);
  assert.equal(env.lockState.held, 0, 'lock released after errors');
});

test('api: large tabs still cache (chunked > 100 KB)', () => {
  const env = freshEnv();
  const sh = env.ss.getSheetByName('Ingredients');
  for (let i = 0; i < 1500; i++) sh.data.push(['x' + i, 'Some fairly long ingredient name number ' + i, 100, 1, 1, 1, 1, '', '', 'note']);
  sh.maxRows = 2000;
  assert.equal(ok(env.ctx.getIngredients()).length, 1500 + J(env.get('SEED_INGREDIENTS_')).length);
  const reads = env.stats.getValues.Ingredients;
  assert.equal(ok(env.ctx.getIngredients()).length, 1500 + J(env.get('SEED_INGREDIENTS_')).length);
  assert.equal(env.stats.getValues.Ingredients, reads);
  assert.ok([...env.cacheStore.keys()].filter(k => k.includes('Ingredients:')).length >= 2, 'stored in several chunks');
});

test('api: appending past the sheet\'s last row grows it', () => {
  const env = freshEnv();
  const sh = env.ss.getSheetByName('Water');
  sh.maxRows = 3;
  for (let d = 1; d <= 5; d++) ok(env.ctx.setWater('2024-11-0' + d, d));
  assert.equal(sh.rows().length, 5);
});

test('unbound script uses the stored spreadsheet id', () => {
  const env = freshEnv();
  const env2 = makeEnv({ unbound: true });
  env2.ss.id = env.ss.id; // same "file"
  const r = env2.ctx.getTargets();
  assert.equal(r.ok, false); assert.match(r.error, /setup/); // no property yet in this project
});

/* ============================== backups / web app ============================== */

test('backup: copies into one "Backups" folder; weekly trigger installs once', () => {
  const env = freshEnv();
  const b1 = ok(env.ctx.exportBackup()), b2 = ok(env.ctx.exportBackup());
  assert.match(b1.name, /^Logbook backup \d{4}-\d{2}-\d{2} \d{4}$/);
  assert.equal(env.folders.filter(f => f.name === 'Backups').length, 1);
  assert.equal(env.folders[0].files.length, 2); void b2;
  env.ctx.installWeeklyBackup(); env.ctx.installWeeklyBackup();
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'weeklyBackup').length, 1);
  assert.equal(env.ctx.removeWeeklyBackup(), 1);
  assert.equal(env.triggers.filter(t => t.getHandlerFunction() === 'weeklyBackup').length, 0);
});

test('doGet serves Index with a mobile viewport', () => {
  const env = freshEnv();
  env.ctx.doGet();
  assert.equal(env.html.file, 'Index');
  assert.equal(env.html.title, 'Logbook');
  assert.match(env.html.meta.viewport, /width=device-width/);
});
