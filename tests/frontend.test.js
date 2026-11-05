/* Front-end tests: runs the real <script> from build/Index.html in Node with a tiny DOM stub,
 * wired through a google.script.run stand-in to build/Code.gs on the mock spreadsheet.
 *   node --test tests/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv } = require('./gas_mock');

const J = x => JSON.parse(JSON.stringify(x));
const html = fs.readFileSync(path.join(__dirname, '..', 'build', 'Index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/** google.script.run look-alike: async, JSON-serialised both ways, private (_) functions hidden. */
function makeRun(env, ctl) {
  const mk = (ok, fail) => new Proxy({}, {
    get(_, k) {
      if (k === 'withSuccessHandler') return h => mk(h, fail);
      if (k === 'withFailureHandler') return h => mk(ok, h);
      return (...args) => {
        ctl.calls.push(k);
        setImmediate(() => {
          if (ctl.failNext > 0) { ctl.failNext--; if (fail) fail(new Error('NetworkError: Connection failure due to HTTP 0')); return; }
          try {
            const fn = env.ctx[k];
            if (typeof fn !== 'function' || /_$/.test(k)) throw new Error('Script function not found: ' + k);
            const res = JSON.parse(JSON.stringify(fn(...JSON.parse(JSON.stringify(args)))));
            if (ok) ok(res);
          } catch (e) { if (fail) fail(e); }
        });
      };
    }
  });
  return mk(null, null);
}

function el() {
  const e = { _html: '', dataset: {}, style: {}, className: '', textContent: '', scrollTop: 0, value: '',
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get firstChild() { return this._html ? {} : null; },
    querySelector() { return el(); }, querySelectorAll() { return []; }, focus() {}, setSelectionRange() {}, closest() { return null; } };
  return e;
}

async function boot(opts) {
  opts = opts || {};
  const env = opts.env || makeEnv();
  if (!opts.env) env.ctx.setup();
  const ctl = { calls: [], failNext: 0 };
  const els = {};
  const storage = new Map(Object.entries(opts.storage || {}));
  const document = {
    querySelector: s => (els[s] = els[s] || el()), querySelectorAll: () => [],
    addEventListener() {}, activeElement: null, documentElement: { dataset: { theme: 'auto' } }, body: { scrollHeight: 0 }
  };
  const sandbox = {
    document, console, Date, Math, JSON, Promise, Set, Map, Object, Array, String, Number, Intl, Error, setImmediate,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    navigator: {}, confirm: () => (opts.confirm === undefined ? true : opts.confirm), scrollTo() {}
  };
  sandbox.window = sandbox;
  sandbox.google = { script: { run: makeRun(env, ctl) } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx, { filename: 'Index.html' });
  const get = expr => vm.runInContext(expr, ctx);
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  return { env, ctl, ctx, get, settle, els, storage, S: get('S'), A: get('A') };
}
const viewHtml = app => app.els['#view'].innerHTML;
function assertClean(htmlStr, where) {
  for (const bad of ['NaN', 'undefined', '[object Object]', 'Infinity']) assert.ok(!htmlStr.includes(bad), `${where}: rendered "${bad}"\n` + htmlStr.slice(Math.max(0, htmlStr.indexOf(bad) - 200), htmlStr.indexOf(bad) + 80));
}
function renderAll(app, label) {
  const { S, get } = app;
  for (const tab of ['today', 'food', 'workout', 'exercises', 'progress']) {
    S.tab = tab;
    if (tab === 'food') for (const seg of ['log', 'day', 'recipes', 'ingredients']) { S.food.seg = seg; get('render')(); assertClean(viewHtml(app), `${label} food/${seg}`); }
    else { get('render')(); assertClean(viewHtml(app), `${label} ${tab}`); }
  }
  S.tab = 'today'; get('render')();
}

/* ============================== pure logic ============================== */

test('pure: nutrition calc for grams, pieces, servings and recipe grams', async () => {
  const app = await boot();
  const calc = app.get('calc'), recipeTotals = app.get('recipeTotals'), db = app.S.db;
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  let n = calc('ing', 'paneer', 150, 'g', db);
  close(n.kcal, 265 * 1.5, 'paneer kcal'); close(n.p, 18.3 * 1.5, 'paneer p');
  n = calc('ing', 'roti', 2, 'pc', db);
  close(n.kcal, 297 * 0.8, 'roti 2pc'); close(n.f, 7.5 * 0.8, 'roti fat');
  const t = recipeTotals(db.recipes.find(r => r.id === 'r_dal'), db);
  close(t.g, 530, 'dal batch g');
  close(t.kcal, 343 * 2.5 + 40 + 18 * 1.5 + 900 * 0.3, 'dal batch kcal');
  n = calc('rec', 'r_dal', 1, 'srv', db); close(n.kcal, t.kcal / 5, 'per serving');
  n = calc('rec', 'r_dal', 106, 'g', db); close(n.kcal, t.kcal / 5, '106 g = one serving');
  assert.deepEqual(J(calc('ing', 'nope', 1, 'g', db)), { kcal: 0, p: 0, c: 0, f: 0 });
  // design rendering helpers
  const recTable = app.get('recipeTotalsTable')(t, 5);
  assert.match(recTable, /Whole batch · 530 g/);
});

test('pure: Epley 1RM, best-of/PR detection inputs', async () => {
  const app = await boot();
  const e1rm = app.get('e1rm');
  assert.equal(e1rm(100, 1), 100);
  assert.ok(Math.abs(e1rm(100, 5) - 116.6667) < 1e-3);
  assert.equal(e1rm(0, 12), 0);
  app.S.db.workouts = [
    { id: 'a', date: '2024-01-01', ex: [{ id: 'bench', sets: [{ w: 80, r: 5 }, { w: 85, r: 2 }] }] },
    { id: 'b', date: '2024-01-03', ex: [{ id: 'bench', sets: [{ w: 75, r: 10 }] }, { id: 'pullup', sets: [{ w: 0, r: 12 }] }] }];
  const b = J(app.get('bestOf')('bench'));
  assert.deepEqual({ w: b.w, r: b.r, reps: b.reps }, { w: 85, r: 2, reps: 10 });
  assert.ok(Math.abs(b.e1 - 75 * (1 + 10 / 30)) < 1e-9);
  assert.equal(J(app.get('bestOf')('bench', 'b')).e1, 80 * (1 + 5 / 30));
});

test('pure: weekly sets per muscle (primary 1, secondary 0.5) and week stats', async () => {
  const app = await boot();
  const T = app.get('TODAY'), addDays = app.get('addDays');
  app.S.db.workouts = [
    { id: 'a', date: T, ex: [{ id: 'bench', sets: [{ w: 60, r: 8 }, { w: 60, r: 8 }, { w: 60, r: 8 }] }, { id: 'dips', sets: [{ w: 0, r: 10 }, { w: 0, r: 10 }] }] },
    { id: 'old', date: addDays(T, -9), ex: [{ id: 'bench', sets: [{ w: 60, r: 8 }] }] }];
  const ms = J(app.get('muscleSets')(addDays(T, -6), T));
  assert.equal(ms.chest, 3 + 2);           // bench primary + dips primary
  assert.equal(ms.triceps, 1.5 + 2);       // bench secondary + dips primary
  assert.equal(ms.front_delts, 1.5 + 1);   // both secondary
  assert.equal(ms.quads, 0);
  // week stats: averages only over logged days before today
  const ws = app.get('weekStart')(T), d1 = ws < T ? ws : addDays(ws, -7);
  app.S.db.foodLog = [
    { id: 1, date: d1, time: '08:00', meal: 'breakfast', kcal: 2000, p: 150, c: 1, f: 1 },
    { id: 2, date: addDays(d1, 1) < T ? addDays(d1, 1) : d1, time: '09:00', meal: 'lunch', kcal: 1000, p: 10, c: 1, f: 1 }];
  const wk = J(app.get('weekStats')(app.get('weekStart')(d1)));
  assert.ok(wk.logged >= 1 && wk.kcal > 0);
});

test('pure: 7-day rolling average skips gaps; dates and week start', async () => {
  const app = await boot();
  const avg = J(app.get('rollingAvg')([80, null, 82, null, null, null, null, 90, null], 7));
  assert.deepEqual(avg, [80, 80, 81, 81, 81, 81, 81, 86, 86]);
  assert.deepEqual(J(app.get('rollingAvg')([null, null], 7)), [null, null]);
  const addDays = app.get('addDays'), weekStart = app.get('weekStart');
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addDays('2024-03-31', -31), '2024-02-29');
  assert.equal(weekStart('2024-11-05'), '2024-11-04'); // Tuesday -> Monday
  assert.equal(weekStart('2024-11-10'), '2024-11-04'); // Sunday -> Monday
  assert.equal(weekStart('2024-11-04'), '2024-11-04');
});

test('pure: date helpers are timezone-proof (run under TZ=... too)', async () => {
  const app = await boot();
  const iso = app.get('iso'), addDays = app.get('addDays');
  let d = '2024-01-01';
  for (let i = 0; i < 366; i++) d = addDays(d, 1);
  assert.equal(d, '2025-01-01');
  assert.equal(iso(new Date(2024, 0, 31, 23, 59)), '2024-01-31');
});

/* ============================== wiring ============================== */

test('boot: one getBootstrap round trip fills every slice; fresh empty sheet renders without NaN', async () => {
  const app = await boot();
  assert.deepEqual(app.ctl.calls, ['getBootstrap']);
  assert.equal(app.S.loading, false);
  const db = app.S.db;
  assert.deepEqual(J(db.targets), { kcal: 2400, p: 160, c: 260, f: 70, water: 10, glassMl: 250 });
  assert.deepEqual(J(db.rotation), ['push', 'pull', 'legs']);
  assert.ok(db.exercises.length >= 120 && db.ingredients.length >= 55 && db.routines.length === 6);
  renderAll(app, 'empty');
  assert.match(viewHtml(app), /Up next in rotation/);
});

test('boot: server error shows the design\'s "Couldn\'t load" screen', async () => {
  const env = makeEnv(); // no setup() -> tabs missing
  const app = await boot({ env });
  assert.match(viewHtml(app), /Couldn&#39;t load your data|Couldn't load your data/);
  assert.match(viewHtml(app), /setup/);
});

test('flow: water, food, weight, wellness persist; tmp ids replaced; delete confirms', async () => {
  const app = await boot();
  const { A, S, env, settle, get } = app;
  const T = get('TODAY');
  A.water({ dataset: { d: '1' } }); A.water({ dataset: { d: '1' } });
  await settle();
  assert.deepEqual(J(env.ctx.getWater().data), { [T]: 2 });

  A.pickFood({ dataset: { kind: 'ing', ref: 'paneer' } });
  assert.equal(S.sheet.unit, 'g'); assert.equal(S.sheet.qty, 100);
  A.qtySave();
  const tmp = S.db.foodLog[0];
  assert.match(String(tmp.id), /^tmp/); assert.equal(tmp._s, 'saving');
  await settle();
  assert.match(tmp.id, /^f/); assert.equal(tmp._s, null);
  const rows = env.ss.getSheetByName('FoodLog').objects();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].ref_id, rows[0].kcal, rows[0].unit], [tmp.id, 'paneer', 265, 'g']);

  A.quick({ dataset: { kind: 'ing', ref: 'roti', qty: '2', unit: 'pc' } });
  await settle();
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 2);

  // edit then delete (delete asks first)
  A.editEntry({ dataset: { id: tmp.id } });
  S.sheet.qty = 50; A.qtySave(); await settle();
  assert.equal(env.ss.getSheetByName('FoodLog').objects().find(r => r.id === tmp.id).kcal, 132.5);
  A.editEntry({ dataset: { id: tmp.id } }); A.qtyDelete(); await settle();
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 1);

  S.weightDraft = '78.4'; A.weightSave();
  S.well.sleep = 7.5; A.energy({ dataset: { n: '4' } });
  await settle();
  assert.deepEqual(J(env.ctx.getWeights().data), [{ date: T, kg: 78.4 }]);
  assert.deepEqual(J(env.ctx.getWellness().data), [{ date: T, sleep: 7.5, energy: 4 }]);
  renderAll(app, 'after logging');
});

test('flow: declining the delete confirm keeps the entry', async () => {
  const app = await boot({ confirm: false });
  const { A, S, env, settle } = app;
  A.quick({ dataset: { kind: 'ing', ref: 'egg', qty: '2', unit: 'pc' } }); await settle();
  A.editEntry({ dataset: { id: S.db.foodLog[0].id } }); A.qtyDelete(); await settle();
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 1);
  assert.equal(S.db.foodLog.length, 1);
});

test('flow: a failed save shows "not saved", Retry succeeds (no duplicate)', async () => {
  const app = await boot();
  const { A, S, env, settle, ctl, els, get } = app;
  ctl.failNext = 1;
  A.quick({ dataset: { kind: 'ing', ref: 'banana', qty: '1', unit: 'pc' } });
  await settle();
  const e = S.db.foodLog[0];
  assert.equal(e._s, 'error');
  assert.equal(get('failures').size, 1);
  assert.match(els['#status'].innerHTML, /1 not saved · Retry/);
  A.retryAll(); await settle();
  assert.equal(e._s, null); assert.equal(get('failures').size, 0);
  assert.equal(env.ss.getSheetByName('FoodLog').rows().length, 1);
});

test('flow: new ingredient used straight away (before its save returns) ends up with the real id everywhere', async () => {
  const app = await boot();
  const { A, S, env, settle } = app;
  A.newIng({ dataset: { name: 'Sattu' } });
  Object.assign(S.sheet, { kcal: '413', p: '20', c: '65', f: '7', fib: '', unitName: '', unitG: '' });
  A.ingSave();
  const ing = S.db.ingredients.find(i => i.name === 'Sattu'), tmpId = ing.id;
  assert.match(tmpId, /^tmp/);
  A.pickFood({ dataset: { kind: 'ing', ref: tmpId } }); A.qtySave();   // logged while the ingredient is still saving
  A.newRecipe(); Object.assign(S.sheet, { name: 'Sattu drink', servings: 1, items: [{ ing: tmpId, g: 40 }] }); A.rSave();
  await settle();
  assert.match(ing.id, /^i/);
  const realId = ing.id;
  assert.equal(S.db.foodLog[0].ref, realId);
  assert.equal(S.db.recipes.find(r => r.name === 'Sattu drink').items[0].ing, realId);
  assert.equal(env.ss.getSheetByName('FoodLog').objects()[0].ref_id, realId);
  assert.ok(env.ss.getSheetByName('RecipeItems').objects().some(r => r.ingredient_id === realId));
  assert.equal(env.ss.getSheetByName('Ingredients').objects().filter(r => r.name === 'Sattu').length, 1);
});

test('flow: workout — each ticked set is saved immediately; finish writes the workout; history and PRs work', async () => {
  const app = await boot();
  const { A, S, env, settle, get, storage } = app;
  A.startWorkout({ dataset: { r: 'push' } });
  assert.ok(storage.get('logbook_active_workout'), 'active workout kept in localStorage');
  const a = S.wo.active;
  a.exercises[0].sets[0].w = '60'; a.exercises[0].sets[0].r = '8';
  A.setDone({ dataset: { e: '0', s: '0' } }); await settle();
  const sets = env.ss.getSheetByName('WorkoutSets');
  assert.equal(sets.rows().length, 1, 'set persisted immediately');
  assert.equal(sets.objects()[0].workout_id, a.id);
  A.addSet({ dataset: { e: '0' } }); a.exercises[0].sets[1].w = '62.5';
  A.setDone({ dataset: { e: '0', s: '1' } });
  a.exercises[2].sets[0].w = '40'; a.exercises[2].sets[0].r = '6';
  A.setDone({ dataset: { e: '2', s: '0' } });
  await settle();
  assert.equal(sets.rows().length, 3);
  A.finishWorkout(); await settle();
  assert.equal(S.wo.active, null);
  assert.ok(!storage.get('logbook_active_workout'));
  const wos = env.ss.getSheetByName('Workouts').objects();
  assert.equal(wos.length, 1);
  assert.equal(sets.rows().length, 3);
  assert.ok(sets.objects().every(r => r.workout_id === wos[0].id), 'drafts re-filed under the real workout id');
  const w = S.db.workouts[S.db.workouts.length - 1];
  assert.equal(w.id, wos[0].id);
  assert.equal(S.wo.summary.sets, 3);
  get('render')(); assertClean(viewHtml(app), 'summary');
  A.closeSummary();
  // second workout: lifting more is a PR
  A.startWorkout({ dataset: { r: 'push' } });
  const b = S.wo.active;
  assert.equal(b.exercises[0].sets.length, 2, 'prefilled from last time');
  b.exercises[0].sets[0].w = '70'; b.exercises[0].sets[0].r = '8';
  A.setDone({ dataset: { e: '0', s: '0' } }); A.finishWorkout(); await settle();
  assert.equal(S.wo.summary.prs.length, 1);
  assert.equal(S.wo.summary.prs[0].id, 'bench');
  A.closeSummary();
  A.exOpen({ dataset: { id: 'bench' } }); await settle();
  assert.equal(S.ex.hist.length, 2);
  S.tab = 'exercises'; get('render')(); assertClean(viewHtml(app), 'exercise detail');
  assert.match(viewHtml(app), /Est\. 1RM/);
  renderAll(app, 'after workouts');
});

test('flow: crash mid-workout -> reopening restores the active workout from localStorage', async () => {
  const app = await boot();
  app.A.startWorkout({ dataset: { r: 'legs' } });
  app.S.wo.active.exercises[0].sets[0].w = '100'; app.get('saveActive')();
  const saved = app.storage.get('logbook_active_workout');
  const app2 = await boot({ env: app.env, storage: { logbook_active_workout: saved } });
  assert.equal(app2.S.wo.active.name, 'Legs day');
  assert.equal(app2.S.wo.active.exercises[0].sets[0].w, '100');
});

test('flow: new exercise gets a real id; Food > Day loads days older than the startup window', async () => {
  const app = await boot();
  const { A, S, env, settle, get } = app;
  A.exNew(); assert.equal(S.sheet.type, 'exForm');
  Object.assign(S.sheet, { name: 'Zercher squat', prim: ['quads'], sec: ['glutes'], eq: 'barbell', mv: 'legs', mech: 'compound' }); A.exSave();
  await settle();
  const ex = S.db.exercises.find(e => e.name === 'Zercher squat');
  assert.match(ex.id, /^e/);
  assert.ok(env.ss.getSheetByName('Exercises').objects().some(r => r.id === ex.id && r.primary_muscles === 'quads'));
  // edit an existing exercise (design bug fixed: the form used to crash)
  S.ex.detail = 'bench'; A.exEdit();
  assert.equal(S.sheet.type, 'exForm'); assert.equal(S.sheet.mech, 'compound');
  get('renderSheet')(); assertClean(app.els['#sheet'].innerHTML, 'exercise form');
  S.sheet.name = 'Bench press (paused)'; A.exfSet({ dataset: { f: 'mech', v: 'isolation' } }); A.exSave(); await settle();
  const row = env.ss.getSheetByName('Exercises').objects().find(r => r.id === 'bench');
  assert.deepEqual([row.name, row.mechanic, row.notes], ['Bench press (paused)', 'isolation', 'Mid chest']);
  // an entry 80 days ago is outside the bootstrap window
  const addDays = get('addDays'), T = get('TODAY'), old = addDays(T, -80);
  env.ctx.addFoodEntry({ id: 'tmpOld', date: old, time: '13:00', meal: 'lunch', kind: 'ing', ref: 'rice', qty: 200, unit: 'g', name: 'Basmati rice, cooked', kcal: 260, p: 5.4, c: 56.4, f: 0.6 });
  assert.ok(!S.db.foodLog.some(e => e.date === old));
  S.tab = 'food'; S.food.seg = 'day'; S.food.date = addDays(old, 1);
  A.dayNav({ dataset: { d: '-1' } });
  assert.match(viewHtml(app), /skel/, 'shows a loading placeholder');
  await settle();
  assert.ok(S.db.foodLog.some(e => e.date === old));
  assert.match(viewHtml(app), /Basmati rice, cooked/);
  const calls = app.ctl.calls.filter(c => c === 'getFoodLog').length;
  A.dayNav({ dataset: { d: '1' } }); A.dayNav({ dataset: { d: '-1' } }); await settle();
  assert.equal(app.ctl.calls.filter(c => c === 'getFoodLog').length, calls + 1, 'the next (also old) day is fetched once; the loaded day is not fetched again');
});

test('static: no mock data or mock settings left in Index.html', () => {
  for (const bad of ['MOCK', 'CONFIG', 'failRate', 'latency', 'mulberry', 'Simulate failed saves', 'pretend server', 'wait(']) assert.ok(!html.includes(bad), bad);
  const apiBlock = script.match(/const api = \(function \(\) \{[\s\S]*?\n\}\)\(\);/)[0];
  const names = [...apiBlock.matchAll(/^\s{4}(\w+):\s*fn\('(\w+)'\)/gm)];
  assert.equal(names.length, 23);
  for (const [, k, v] of names) assert.equal(k, v);
  assert.ok(html.includes('fonts.googleapis.com/css2?family=IBM+Plex+Mono'));
});
