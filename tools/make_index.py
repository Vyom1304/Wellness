"""Builds build/Index.html from design/index.html.

Every change is an exact search/replace that must match exactly once, so the
design stays the source of truth and each deviation is listed here.
Run:  python3 tools/make_index.py
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'design' / 'index.html').read_text(encoding='utf-8')
out = src


def sub(old, new, label, count=1):
    global out
    n = out.count(old)
    if n != count:
        sys.exit(f'[{label}] expected {count} match(es), found {n}')
    out = out.replace(old, new)


def sub_re(pattern, new, label):
    global out
    m = list(re.finditer(pattern, out, flags=re.S))
    if len(m) != 1:
        sys.exit(f'[{label}] expected 1 regex match, found {len(m)}')
    out = out[:m[0].start()] + new + out[m[0].end():]


# 1. Fonts: the design export inlined Google Fonts as local blobs that only exist in the
#    design tool. Load the same families from Google Fonts instead.
sub_re(r'<style>/\* cyrillic-ext \*/.*?</style>\n',
       '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">\n',
       'fonts')

# 2. Remove MOCK data, CONFIG (latency / failRate) and the mock api; add the google.script.run api.
API = r'''/* =========================================================================
   API: every read/write goes to Code.gs through google.script.run.
   Server functions return { ok, data, error }; call() unwraps that so the
   rest of the app sees exactly the data shapes the design expects.
   ========================================================================= */
const api = (function () {
  function call(fn, args) {
    return new Promise((resolve, reject) => {
      const run = window.google && google.script && google.script.run;
      if (!run) { reject(new Error('Open Logbook from its web app link.')); return; }
      while (args.length && args[args.length - 1] === undefined) args.pop();
      const r = run
        .withSuccessHandler(res => res && res.ok ? resolve(res.data) : reject(new Error((res && res.error) || 'Unexpected reply from the server')))
        .withFailureHandler(err => reject(err instanceof Error ? err : new Error((err && err.message) || String(err || 'Network error'))));
      r[fn].apply(r, args);
    });
  }
  const fn = name => (...args) => call(name, args);
  return {
    getBootstrap:      fn('getBootstrap'),       // (today) -> everything the first screen needs, one round trip
    getTargets:        fn('getTargets'),
    getFoodLog:        fn('getFoodLog'),         // (date?) -> that day's entries, or all
    addFoodEntry:      fn('addFoodEntry'),
    updateFoodEntry:   fn('updateFoodEntry'),
    deleteFoodEntry:   fn('deleteFoodEntry'),
    getIngredients:    fn('getIngredients'),
    saveIngredient:    fn('saveIngredient'),
    getRecipes:        fn('getRecipes'),
    saveRecipe:        fn('saveRecipe'),
    getWater:          fn('getWater'),
    setWater:          fn('setWater'),
    getWeights:        fn('getWeights'),
    addWeight:         fn('addWeight'),
    getWellness:       fn('getWellness'),
    saveWellness:      fn('saveWellness'),
    getExercises:      fn('getExercises'),
    saveExercise:      fn('saveExercise'),
    getExerciseHistory:fn('getExerciseHistory'),
    getRoutines:       fn('getRoutines'),
    getWorkouts:       fn('getWorkouts'),
    addSet:            fn('addSet'),             // persist each completed set (crash-safe)
    saveWorkout:       fn('saveWorkout')
  };
})();

'''
sub_re(r'/\* =+\n   MOCK DATA.*?\n\}\)\(\);\n\n/\* ===================== helpers', API + '/* ===================== helpers', 'mock+api')
sub("function mulberry(a) {", "\x00", 'mulberry-mark')
out = re.sub(r'\x00[^\n]*\n', '', out)

# 3. Pure helper for the 7-day average (unit-tested), used by Progress.
sub("const e1rm = (w, r) => r <= 1 ? w : w * (1 + r / 30);",
    "const e1rm = (w, r) => r <= 1 ? w : w * (1 + r / 30);\n"
    "function rollingAvg(vals, n) { return vals.map((_, i) => { const v = vals.slice(Math.max(0, i - n + 1), i + 1).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }); }",
    'rollingAvg')
sub("const daily = wDays.map(d => wmap[d] ?? null), avg7 = wDays.map((d, i) => { const v = daily.slice(Math.max(0, i - 6), i + 1).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });",
    "const daily = wDays.map(d => wmap[d] ?? null), avg7 = rollingAvg(daily, 7);", 'avg7')
# empty-state guards (a fresh sheet has no weights yet; the design assumed demo data)
sub("const wv = daily.filter(x => x != null), wmin = Math.floor(Math.min(...wv) - .3), wmax = Math.ceil(Math.max(...wv) + .3);",
    "const wv = daily.filter(x => x != null), wmin = wv.length ? Math.floor(Math.min(...wv) - .3) : 70, wmax = wv.length ? Math.ceil(Math.max(...wv) + .3) : 80;",
    'weight-empty')
sub('<span class="mid num">${kg(r1(lastAvg))}</span>', '<span class="mid num">${lastAvg != null ? kg(r1(lastAvg)) : \'—\'}</span>', 'lastAvg-empty')
sub("  else wo = `<div class=\"eyebrow\">Up next in rotation</div>",
    "  else if (!nr) wo = `<div class=\"eyebrow\">Workout</div><div class=\"row sb mt8\"><h2>No routine in rotation</h2></div><button class=\"btn primary block lg mt12\" data-a=\"startWorkout\" data-r=\"empty\">Empty workout</button>`;\n"
    "  else wo = `<div class=\"eyebrow\">Up next in rotation</div>", 'no-routine')

# 4. Settings sheet: drop the mock-only "simulate failed saves" toggle and latency note.
sub_re(r"    return `\$\{sheetHead\('Settings', 'Display & testing'\)\}.*?per save\.</div>`;\n",
       "    return `${sheetHead('Settings', 'Display')}\n"
       "    <div class=\"eyebrow\">Theme</div><div class=\"seg mt8\">${['auto','light','dark'].map(t => `<button class=\"${th === t ? 'on' : ''}\" data-a=\"setTheme\" data-t=\"${t}\">${cap(t)}</button>`).join('')}</div>\n"
       "    <div class=\"faint mt12\" style=\"font-size:12px\">Targets, routines and the training rotation live in the Google Sheet (Settings and Routines tabs).</div>`;\n",
       'settings')
sub("  toggleFail: () => { CONFIG.failRate = CONFIG.failRate ? 0 : 0.5; renderSheet(); },\n", "", 'toggleFail')

# 5. Real ids replace tmp ids; also re-point anything on this device that still uses the tmp id.
sub("function goTab(t) {",
    "function remapId(kind, from, to) {\n"
    "  if (!from || !to || from === to) return; const db = S.db, sh = S.sheet;\n"
    "  if (kind === 'ing' || kind === 'rec') {\n"
    "    db.foodLog.forEach(e => { if (e.kind === kind && e.ref === from) e.ref = to; });\n"
    "    if (kind === 'ing') { db.recipes.forEach(r => (r.items || []).forEach(it => { if (it.ing === from) it.ing = to; })); if (sh && sh.items) sh.items.forEach(it => { if (it.ing === from) it.ing = to; }); }\n"
    "    if (sh && sh.kind === kind && sh.ref === from) sh.ref = to;\n"
    "  } else if (kind === 'ex') {\n"
    "    db.routines.forEach(r => { r.ex = r.ex.map(x => x === from ? to : x); });\n"
    "    db.workouts.forEach(w => w.ex.forEach(x => { if (x.id === from) x.id = to; }));\n"
    "    if (S.wo.active) { S.wo.active.exercises.forEach(x => { if (x.exId === from) x.exId = to; }); saveActive(); }\n"
    "    if (S.ex.detail === from) S.ex.detail = to;\n"
    "  }\n"
    "}\n"
    "function goTab(t) {", 'remapId')
sub("closeSheet(); persist('rec:' + r.id, r.name, () => api.saveRecipe(strip(r)), res => { r.id = res.id; }, r);",
    "closeSheet(); persist('rec:' + r.id, r.name, () => api.saveRecipe(strip(r)), res => { const old = r.id; r.id = res.id; remapId('rec', old, res.id); }, r);",
    'recipe-id')
sub("persist('ing:' + i.id, i.name, () => api.saveIngredient(strip(i)), res => { i.id = res.id; }, i);",
    "persist('ing:' + i.id, i.name, () => api.saveIngredient(strip(i)), res => { const old = i.id; i.id = res.id; remapId('ing', old, res.id); }, i);",
    'ing-id')
sub("res => { if (S.ex.detail === e.id) S.ex.detail = res.id; e.id = res.id; }, e);",
    "res => { const old = e.id; if (S.ex.detail === e.id) S.ex.detail = res.id; e.id = res.id; remapId('ex', old, res.id); }, e);",
    'ex-id')

# 6. addSet also sends which exercise the set belongs to, so draft sets can be grouped.
sub("const payload = { workoutId: S.wo.active.id, exId: x.exId, setIndex: +el.dataset.s,",
    "const payload = { workoutId: S.wo.active.id, exId: x.exId, exIndex: +el.dataset.e, setIndex: +el.dataset.s,", 'addSet-payload')

# 7. Deleting a food entry asks first (brief: "Deletes are fine, but the UI confirms").
sub("const s = S.sheet, idx = S.db.foodLog.findIndex(x => x.id === s.id); if (idx < 0) return; const e = S.db.foodLog[idx];\n",
    "const s = S.sheet, idx = S.db.foodLog.findIndex(x => x.id === s.id); if (idx < 0) return; const e = S.db.foodLog[idx];\n"
    "    if (!s._confirmed && !confirm('Delete ' + e.name + '?')) return;\n", 'confirm-delete')
sub("toast(`Couldn't delete ${e.name}`, 'Retry', () => { S.sheet = { id: e.id }; A.qtyDelete(); });",
    "toast(`Couldn't delete ${e.name}`, 'Retry', () => { S.sheet = { id: e.id, _confirmed: true }; A.qtyDelete(); });", 'retry-delete')

# 8. Food > Day: startup loads the last 9 weeks; older days are fetched when you navigate to them.
sub("function goTab(t) {",
    "const loadedDays = new Set();\n"
    "function ensureDay(d) {\n"
    "  if (!S.db || !S.db.foodLogFrom || d >= S.db.foodLogFrom || loadedDays.has(d)) return;\n"
    "  loadedDays.add(d); S.dayLoading = d;\n"
    "  api.getFoodLog(d).then(rows => { const have = new Set(S.db.foodLog.map(e => String(e.id))); rows.forEach(e => { if (!have.has(String(e.id))) S.db.foodLog.push(e); }); })\n"
    "    .catch(() => { loadedDays.delete(d); toast(\"Couldn't load \" + dayLabel(d)); })\n"
    "    .finally(() => { if (S.dayLoading === d) S.dayLoading = null; render(); });\n"
    "}\n"
    "function goTab(t) {", 'ensureDay')
sub("dayNav: el => { const d = addDays(S.food.date, +el.dataset.d); if (d > TODAY) return; S.food.date = d; render(); },",
    "dayNav: el => { const d = addDays(S.food.date, +el.dataset.d); if (d > TODAY) return; S.food.date = d; ensureDay(d); render(); },", 'dayNav')
sub("if (d <= TODAY) { S.food.date = d; render(); } }", "if (d <= TODAY) { S.food.date = d; ensureDay(d); render(); } }", 'swipe')
sub('<section class="card mt12">${groups.length ?',
    '<section class="card mt12">${S.dayLoading === d ? \'<div class="skel" style="height:52px"></div><div class="skel mt8" style="height:52px"></div>\' : groups.length ?',
    'day-loading')

# 9. Boot: one getBootstrap() call instead of ten reads.
sub_re(r"    const \[targets, foodLog, ingredients, recipes, water, weights, wellness, exercises, routines, workouts\] = await Promise\.all\(\[\n.*?rotation: MOCK\.rotation \};\n",
       "    const b = await api.getBootstrap(TODAY);\n"
       "    S.db = { targets: b.targets, foodLog: b.foodLog, ingredients: b.ingredients, recipes: b.recipes, water: b.water, weights: b.weights, wellness: b.wellness,\n"
       "             exercises: b.exercises, routines: b.routines, workouts: b.workouts, rotation: b.rotation, foodLogFrom: b.foodLogFrom };\n",
       'boot')

# 9b. Design bug: the exercise form's state used `type` both for the sheet kind ('exForm') and for
#     compound/isolation, so the second key overwrote the first and "+ New" / "Edit" exercise threw.
#     Store compound/isolation as `mech` inside the form instead.
sub("<div class=\"eyebrow mt16\">Type</div>${one('type', ['compound','isolation'])}",
    "<div class=\"eyebrow mt16\">Type</div>${one('mech', ['compound','isolation'])}", 'exform-mech')
sub("mv: S.ex.mv || 'push', type: S.ex.type || 'compound' })", "mv: S.ex.mv || 'push', mech: S.ex.type || 'compound' })", 'exNew-mech')
sub("eq: e.eq, mv: e.mv, type: e.type, base: e.base });", "eq: e.eq, mv: e.mv, mech: e.type, base: e.base });", 'exEdit-mech')
sub("eq: s.eq, mv: s.mv, type: s.type, base:", "eq: s.eq, mv: s.mv, type: s.mech, base:", 'exSave-mech')

# 10. Remove the design tool's "Made with Claude Design" badge (not part of the app).
sub_re(r'<div id="__claude_design_branding">.*?</div></body>', '</body>', 'branding')

# sanity: nothing mock-related left
for bad in ['MOCK', 'CONFIG', 'failRate', 'latency', 'mulberry', 'toggleFail', 'pretend server', '__claude']:
    if bad in out:
        sys.exit(f'leftover "{bad}" in output')

(ROOT / 'build' / 'Index.html').write_text(out, encoding='utf-8')
print('build/Index.html written,', len(out.splitlines()), 'lines,', len(out), 'bytes')
