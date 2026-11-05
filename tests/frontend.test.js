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
    classList: { toggle() {}, add() {}, remove() {} }, offsetWidth: 0, inert: false, replaceWith() {}, setAttribute() {},
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
  const pops = [];
  const document = {
    querySelector: s => s === '#mapslot' ? (String((els['#view'] || el())._html).includes('id="mapslot"') ? el() : null) : (els[s] = els[s] || el()), querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, activeElement: null, documentElement: { dataset: { theme: 'auto' } }, body: { scrollHeight: 0 }
  };
  const sandbox = {
    document, console, Date, Math, JSON, Promise, Set, Map, Object, Array, String, Number, Intl, Error, setImmediate,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    addEventListener: (t, f) => { if (t === 'popstate') pops.push(f); },
    history: { pushState() { if (opts.noHistory) throw new Error('SecurityError'); }, back() { if (!opts.noHistory) pops.forEach(f => f()); } },
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
  for (const tab of ['today', 'food', 'gym', 'progress']) {
    S.tab = tab;
    if (tab === 'gym') {
      S.gym.bank = false; S.ex.detail = null; get('render')(); assertClean(viewHtml(app), `${label} gym`);
      S.gym.bank = true; get('render')(); assertClean(viewHtml(app), `${label} gym/bank`);
      S.ex.detail = 'bench'; get('render')(); assertClean(viewHtml(app), `${label} gym/bank/detail`);
      S.gym.bank = false; S.ex.detail = null;
    } else if (tab === 'food') for (const seg of ['log', 'day', 'recipes', 'ingredients']) { S.food.seg = seg; get('render')(); assertClean(viewHtml(app), `${label} food/${seg}`); }
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
  S.tab = 'gym'; S.gym.bank = true; get('render')(); assertClean(viewHtml(app), 'exercise detail');
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

/* ============================== Gym tab + exercise bank ============================== */

test('gym: old Workout/Exercises tabs are gone; their names route to Gym; the nav has four tabs', async () => {
  const app = await boot(); const { S, get, A } = app;
  S.tab = 'today'; get('render')();
  const nav = app.els['#nav'].innerHTML;
  assert.deepEqual([...nav.matchAll(/data-t="(\w+)"/g)].map(m => m[1]), ['today', 'food', 'gym', 'progress']);
  assert.ok(!/>\s*Workout\s*</.test(nav) && !/>\s*Exercises\s*</.test(nav));
  for (const old of ['workout', 'exercises']) { S.tab = 'today'; get('goTab')(old); assert.equal(S.tab, 'gym', old + ' -> gym'); }
  // starting a workout from anywhere lands on Gym
  S.tab = 'today'; A.startWorkout({ dataset: { r: 'push' } }); assert.equal(S.tab, 'gym');
  assert.match(viewHtml(app), /Push day/);
});

test('gym: the Exercises button sits at the bottom of the Gym page, idle and mid-workout', async () => {
  const app = await boot(); const { S, get, A } = app;
  S.tab = 'gym'; get('render')();
  let v = viewHtml(app);
  assert.match(v, /data-a="bankOpen"/); assert.match(v, />Exercises</);
  assert.ok(v.lastIndexOf('bankOpen') > v.indexOf('Empty workout'), 'button comes after the routines');
  A.startWorkout({ dataset: { r: 'push' } }); v = viewHtml(app);
  assert.ok(v.lastIndexOf('bankOpen') > v.lastIndexOf('addExercise'), 'button comes after Add exercise');
  assert.match(v, /How to do it/); assert.match(v, /data-a="moveEx"/);
  assertClean(v, 'active gym');
});

test('gym: set-by-set logging — ticking saves the set, add/remove set, reorder, PR tag, add from the bank', async () => {
  const app = await boot(); const { S, get, A, settle, env } = app;
  A.startWorkout({ dataset: { r: 'push' } });
  const a = S.wo.active; assert.equal(a.exercises[0].exId, 'bench');
  a.exercises[0].sets[0].w = '60'; a.exercises[0].sets[0].r = '8';
  A.setDone({ dataset: { e: '0', s: '0' } }); await settle();
  assert.equal(env.ss.getSheetByName('WorkoutSets').rows().length, 1, 'tick saved immediately');
  A.addSet({ dataset: { e: '0' } }); assert.equal(a.exercises[0].sets.length, 2);
  assert.deepEqual([a.exercises[0].sets[1].w, a.exercises[0].sets[1].r], ['60', '8'], 'add set copies the previous set');
  A.delSet({ dataset: { e: '0' } }); assert.equal(a.exercises[0].sets.length, 1);
  A.delSet({ dataset: { e: '0' } }); assert.equal(a.exercises[0].sets.length, 1, 'never below one set');
  A.moveEx({ dataset: { e: '0', d: '1' } }); assert.equal(a.exercises[1].exId, 'bench'); A.moveEx({ dataset: { e: '1', d: '-1' } }); assert.equal(a.exercises[0].exId, 'bench');
  const n = a.exercises.length; A.exUse({ dataset: { id: 'squat' } }); assert.equal(a.exercises.length, n + 1); assert.equal(a.exercises[n].exId, 'squat');
  assert.equal(S.tab, 'gym'); assert.equal(S.gym.bank, false);
  A.finishWorkout(); await settle();
  // second session: beating the best shows a PR tag on the set
  A.closeSummary(); A.startWorkout({ dataset: { r: 'push' } });
  const b = S.wo.active.exercises[0]; b.sets[0].w = '65'; b.sets[0].r = '8'; A.setDone({ dataset: { e: '0', s: '0' } });
  S.tab = 'gym'; get('render')(); assert.match(viewHtml(app), /class="n pr">PR</);
});

test('bank: filters are AND across categories and OR within one; muscle matches primary first, then assists', async () => {
  const app = await boot(); const { S, get } = app;
  const all = S.db.exercises, filter = (f) => J(get('filterExercises')(all, { q: '', group: null, sub: null, eq: [], mv: [], type: [], ...f }));
  assert.equal(filter({}).length, all.length);
  const chest = filter({ group: 'chest' });
  assert.ok(chest.length > 15);
  const firstSec = chest.findIndex(r => r.role === 'secondary'), lastPrim = chest.map(r => r.role).lastIndexOf('primary');
  assert.ok(firstSec === -1 || chest.filter(r => r.role === 'primary').every(r => r.e.prim.includes('chest')));
  assert.ok(chest.filter(r => r.role === 'secondary').every(r => r.e.sec.includes('chest') && !r.e.prim.includes('chest')));
  // OR within a category
  const bd = filter({ eq: ['barbell', 'dumbbell'] }); assert.ok(bd.every(r => ['barbell', 'dumbbell'].includes(r.e.eq)));
  assert.equal(bd.length, filter({ eq: ['barbell'] }).length + filter({ eq: ['dumbbell'] }).length);
  // AND across categories
  const both = filter({ group: 'back', sub: 'lats', eq: ['cable'], mv: ['pull'], type: ['compound'] });
  assert.ok(both.length > 0 && both.every(r => r.e.eq === 'cable' && r.e.mv === 'pull' && r.e.type === 'compound' && (r.e.prim.includes('lats') || r.e.sec.includes('lats'))));
  assert.equal(filter({ group: 'chest', eq: ['machine'] }).length, chest.filter(r => r.e.eq === 'machine').length);
  // search
  assert.ok(filter({ q: 'curl' }).every(r => /curl/i.test(r.e.name)));
  assert.equal(filter({ q: 'zzzz' }).length, 0);
  // a sub-muscle narrows the group
  const lats = filter({ group: 'back', sub: 'lats' }); assert.ok(lats.length < filter({ group: 'back' }).length);
});

test('bank: tapping a muscle on the map sets the filter, flips to the right side, and tapping again clears it', async () => {
  const app = await boot(); const { S, A, get } = app;
  A.bankOpen(); assert.equal(S.gym.bank, true);
  A.muscle({ dataset: { muscle: 'lats' } });
  assert.deepEqual([S.ex.group, S.ex.sub, S.ex.view], ['back', 'lats', 'back'], 'lats live on the back, within the Back group');
  assert.deepEqual(J(get('exFilterMuscles')(S.ex)), ['lats']);
  A.muscle({ dataset: { muscle: 'lats' } }); assert.deepEqual([S.ex.group, S.ex.sub], [null, null]);
  A.muscle({ dataset: { muscle: 'biceps' } }); assert.deepEqual([S.ex.group, S.ex.sub, S.ex.view], ['biceps', null, 'front'], 'single-muscle groups use the group');
  A.muscle({ dataset: { muscle: 'hamstrings' } }); assert.equal(S.ex.view, 'back');
  // chips and diagram share the same state
  A.exClear(); A.exFilter({ dataset: { f: 'group', v: 'back' } }); A.exFilter({ dataset: { f: 'sub', v: 'rear_delts' } });
  assert.equal(S.ex.sub, 'rear_delts');
  A.exFilter({ dataset: { f: 'eq', v: 'cable' } }); A.exFilter({ dataset: { f: 'eq', v: 'dumbbell' } }); assert.deepEqual(J(S.ex.eq), ['cable', 'dumbbell']);
  A.exFilter({ dataset: { f: 'eq', v: 'cable' } }); assert.deepEqual(J(S.ex.eq), ['dumbbell']);
  get('render')(); assertClean(viewHtml(app), 'filtered bank');
  A.exClear(); assert.deepEqual([S.ex.group, S.ex.sub, S.ex.eq.length, S.ex.mv.length, S.ex.type.length, S.ex.q], [null, null, 0, 0, 0, '']);
});

test('bank: every muscle used by any exercise has a region on the diagram, and every region is a real muscle', async () => {
  const app = await boot(); const { S, get } = app;
  const BODY = J(get('BODY')), VIEWS = J(get('MUSCLE_VIEWS')), MUSCLES = Object.keys(J(get('MUSCLES')));
  const front = BODY.front.map(r => r[0]), back = BODY.back.map(r => r[0]);
  const used = new Set(S.db.exercises.flatMap(e => e.prim.concat(e.sec)));
  for (const m of used) assert.ok(front.includes(m) || back.includes(m), 'no diagram region for ' + m);
  for (const m of MUSCLES) assert.ok(front.includes(m) || back.includes(m), 'muscle without a region: ' + m);
  for (const m of front.concat(back)) assert.ok(MUSCLES.includes(m), 'region for unknown muscle ' + m);
  // the view table agrees with the artwork
  for (const m of MUSCLES) assert.deepEqual(VIEWS[m].slice().sort(), [front.includes(m) ? 'front' : null, back.includes(m) ? 'back' : null].filter(Boolean).sort(), 'MUSCLE_VIEWS mismatch for ' + m);
  // the SVG itself: one tappable group per region, mirrored for the other side, labelled for screen readers
  const svg = get('bodySVG')('back');
  assert.equal((svg.match(/class="mus"/g) || []).length, back.length);
  assert.ok(/role="button" tabindex="0"/.test(svg) && /aria-label="Lats"/.test(svg));
  assert.ok(svg.includes('scale(-1 1)'));
  // groups cover exactly the muscles
  assert.deepEqual(Object.keys(J(get('GROUP_OF'))).sort(), MUSCLES.slice().sort());
});

test('bank: detail shows how-to steps, cues, mistakes, what it hits; opens from a workout and goes back', async () => {
  const app = await boot(); const { S, A, get, settle } = app;
  A.startWorkout({ dataset: { r: 'push' } });
  A.howTo({ dataset: { id: 'bench' } }); await settle();
  assert.equal(S.gym.bank, true); assert.equal(S.ex.detail, 'bench'); assert.equal(S.ex.from, 'gym');
  const v = viewHtml(app);
  for (const t of ['How to do it', 'Form cues', 'Common mistakes', 'What it hits', 'Add to workout', 'Primary', 'Assists']) assert.ok(v.includes(t), t);
  assert.match(v, /<ol><li>/); assertClean(v, 'detail');
  assert.match(v, /id="mapslot"/);
  // back goes straight to the Gym page (the bank list was never opened)
  get('navBack')(); assert.deepEqual([S.gym.bank, S.ex.detail], [false, null]);
  // from the bank list, back goes to the list first, then to Gym
  A.bankOpen(); A.exOpen({ dataset: { id: 'squat' } }); get('navBack')(); assert.deepEqual([S.gym.bank, S.ex.detail], [true, null]); get('navBack')(); assert.equal(S.gym.bank, false);
  // an exercise with no instructions invites you to add some
  S.db.exercises.push({ id: 'mine', name: 'Mine', prim: ['chest'], sec: [], eq: 'cable', mv: 'push', type: 'isolation', base: 10, note: '', how: [], cues: [], mist: [] });
  A.bankOpen(); A.exOpen({ dataset: { id: 'mine' } }); assert.match(viewHtml(app), /No instructions yet/); assert.match(viewHtml(app), /Add instructions/);
});

test('bank: editing instructions in the form saves them to the Sheet; new exercise form has the how-to fields', async () => {
  const app = await boot(); const { S, A, get, settle, env } = app;
  A.bankOpen(); A.exNew(); get('renderSheet')();
  const f = app.els['#sheet'].innerHTML; for (const t of ['How to do it', 'Form cues', 'Common mistakes', 'What it hits most']) assert.ok(f.includes(t), t);
  Object.assign(S.sheet, { name: 'Landmine row', prim: ['upper_back'], sec: ['lats'], eq: 'barbell', mv: 'pull', mech: 'compound', note: 'Mid back', howText: 'Straddle the bar\nRow to the chest\n\n', cuesText: 'Chest up', mistText: 'Jerking' });
  A.exSave(); await settle();
  const row = env.ss.getSheetByName('Exercises').objects().find(r => r.name === 'Landmine row');
  assert.deepEqual([row.how_to, row.cues, row.mistakes, row.muscle_note], ['Straddle the bar\nRow to the chest', 'Chest up', 'Jerking', 'Mid back']);
  const e = S.db.exercises.find(x => x.name === 'Landmine row'); assert.ok(!String(e.id).startsWith('tmp'));
  assert.deepEqual(J(e.how), ['Straddle the bar', 'Row to the chest']);
  // editing a seeded exercise pre-fills the form with its text
  S.ex.detail = 'bench'; A.exEdit(); assert.match(S.sheet.howText, /Lie on the bench/);
});

test('bank: sort by recently trained and best lift; secondary results follow primary', async () => {
  const app = await boot(); const { S, get } = app;
  S.db.workouts = [{ id: 'a', date: '2024-01-01', ex: [{ id: 'bench', sets: [{ w: 60, r: 8 }] }] }, { id: 'b', date: '2024-02-01', ex: [{ id: 'cable_fly', sets: [{ w: 20, r: 12 }] }, { id: 'pec_deck', sets: [{ w: 90, r: 10 }] }] }];
  const run = mode => J(get('sortResults')(get('filterExercises')(S.db.exercises, { q: '', group: 'chest', sub: null, eq: [], mv: [], type: [] }), mode)).map(r => r.e.id);
  assert.deepEqual(run('recent').slice(0, 3).sort(), ['bench', 'cable_fly', 'pec_deck'].sort());
  assert.equal(run('recent')[2], 'bench', 'oldest of the three trained comes last among them');
  assert.equal(run('best')[0], 'pec_deck');
  const az = run('az'); const roles = J(get('sortResults')(get('filterExercises')(S.db.exercises, { q: '', group: 'chest', sub: null, eq: [], mv: [], type: [] }), 'az')).map(r => r.role);
  assert.ok(roles.indexOf('secondary') === -1 || roles.slice(roles.indexOf('secondary')).every(r => r === 'secondary'), 'secondary after primary');
  assert.ok(az.length > 15);
});

test('static: build has no leftover tabs/functions from the old layout, and no external libraries', () => {
  assert.ok(!/data-t="workout"|data-t="exercises"/.test(html));
  assert.ok(!/function vWorkout|function vExercises|function filteredExercises/.test(html));
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  assert.ok(!/\beval\(|new Function\(|\sonclick=|\sonerror=/.test(script.replace('onclick="location.reload()"', '')), 'no eval or inline handlers (HtmlService)');
  assert.ok(html.includes('prefers-reduced-motion'), 'reduced-motion handled');
});

test('bank: back works with browser history, and still works where history.pushState is blocked (sandboxed iframe)', async () => {
  for (const noHistory of [false, true]) {
    const app = await boot({ noHistory }); const { S, A, get } = app; S.tab = 'gym';
    A.bankOpen(); A.exOpen({ dataset: { id: 'squat' } });
    assert.equal(get('NAV').depth, noHistory ? 0 : 2, 'history entries pushed only when allowed');
    A.exBack(); assert.deepEqual([S.gym.bank, S.ex.detail], [true, null], 'noHistory=' + noHistory);
    A.bankClose(); assert.deepEqual([S.gym.bank, S.ex.detail], [false, null], 'noHistory=' + noHistory);
    // the phone's own back button (popstate) closes the detail, then the list
    A.bankOpen(); A.exOpen({ dataset: { id: 'squat' } });
    if (!noHistory) { app.ctx.history.back(); assert.deepEqual([S.gym.bank, S.ex.detail], [true, null]); app.ctx.history.back(); assert.equal(S.gym.bank, false); }
  }
});
