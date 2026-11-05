/* Browser check: real Chromium renders build/Index.html; google.script.run calls are routed to
 * build/Code.gs running in Node on the mock spreadsheet (with ~0.6 s latency, like Apps Script).
 *   node tests/e2e.js          -> screenshots in tests/screenshots/
 */
'use strict';
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const { makeEnv } = require('./gas_mock');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

function seedHistory(env) {
  const c = env.ctx;
  for (let d = -45; d <= -1; d++) {
    if (d % 7 !== 3) c.addWeight({ date: day(d), kg: Math.round((79.5 + d * 0.03 + Math.sin(d) * 0.3) * 10) / 10 });
    if (d >= -27) c.saveWellness({ date: day(d), sleep: 6.5 + (d % 3) * 0.5, energy: 3 + (d % 2) });
    if (d >= -27) c.setWater(day(d), 7 + (d % 3));
    if (d >= -20) {
      c.addFoodEntry({ id: 'tmpb' + d, date: day(d), time: '08:30', meal: 'breakfast', kind: 'ing', ref: 'oats', qty: 70, unit: 'g', name: 'Rolled oats', kcal: 272, p: 11.8, c: 46.4, f: 4.8 });
      c.addFoodEntry({ id: 'tmpl' + d, date: day(d), time: '13:10', meal: 'lunch', kind: 'rec', ref: 'r_dal', qty: 1, unit: 'srv', name: 'Dal tadka', kcal: 248, p: 11.7, c: 33.7, f: 7.1 });
      c.addFoodEntry({ id: 'tmpd' + d, date: day(d), time: '21:00', meal: 'dinner', kind: 'rec', ref: 'r_curry', qty: 1.5, unit: 'srv', name: 'Chicken curry', kcal: 640 + d * 3, p: 70, c: 14, f: 30 });
      c.addFoodEntry({ id: 'tmps' + d, date: day(d), time: '17:00', meal: 'snack', kind: 'ing', ref: 'whey', qty: 1, unit: 'pc', name: 'Whey protein', kcal: 120, p: 24, c: 2.4, f: 1.8 });
    }
    const rot = ['push', 'pull', 'legs'], k = (-d) % 4;
    if (k !== 1 && d >= -30) {
      const rid = rot[k === 0 ? 0 : k === 3 ? 1 : 2];
      const ex = { push: ['bench', 'incline_db', 'ohp', 'lat_raise', 'pushdown', 'oh_ext'], pull: ['lat_pd', 'bb_row', 'cable_row', 'face_pull', 'bb_curl', 'hammer'], legs: ['squat', 'rdl', 'leg_press', 'leg_curl', 'leg_ext', 'calf'] }[rid];
      c.saveWorkout({ id: 'tmpw' + d, date: day(d), routine: rid, name: rid[0].toUpperCase() + rid.slice(1) + ' day', start: '18:30', dur: 55,
        ex: ex.map((id, i) => ({ id, sets: [0, 1, 2].map(() => ({ w: Math.round((i === 0 ? 60 : 20) * (1 + (d + 30) / 120) / 2.5) * 2.5, r: 8, rpe: '' })) })) });
    }
  }
}

(async () => {
  const env = makeEnv(); env.ctx.setup();
  const ctl = { failNext: 0, latency: 600, calls: [] };
  const errors = [];
  const browser = await chromium.launch();
  const shots = [];

  async function newPage(opts) {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text())) errors.push('console: ' + m.text()); });
    page.on('dialog', d => d.accept());
    await page.exposeFunction('__gas', async (fn, argsJson) => {
      ctl.calls.push(fn);
      await sleep(ctl.latency);
      if (ctl.failNext > 0) { ctl.failNext--; return JSON.stringify({ fail: 'NetworkError: Connection failure due to HTTP 0' }); }
      const f = env.ctx[fn];
      if (typeof f !== 'function' || /_$/.test(fn)) return JSON.stringify({ fail: 'Script function not found: ' + fn });
      return JSON.stringify({ res: f(...JSON.parse(argsJson)) });
    });
    await page.addInitScript(() => {
      const mk = (ok, fail) => new Proxy({}, {
        get(_, k) {
          if (k === 'withSuccessHandler') return h => mk(h, fail);
          if (k === 'withFailureHandler') return h => mk(ok, h);
          return (...args) => { window.__gas(k, JSON.stringify(args)).then(r => { const o = JSON.parse(r); if (o.fail) { if (fail) fail(new Error(o.fail)); } else if (ok) ok(o.res); }); };
        }
      });
      window.google = { script: { run: mk(null, null) } };
    });
    await page.goto('file://' + path.join(__dirname, '..', 'build', 'Index.html'));
    return page;
  }
  const tap = async (page, sel) => { const l = page.locator(sel).first(); await l.waitFor(); await l.dispatchEvent('click'); };
  const shot = async (page, name) => { const f = path.join(OUT, name + '.png'); await page.screenshot({ path: f }); shots.push(name); };
  const idle = async page => { await page.waitForFunction(() => S.saving === 0 && !S.loading, null, { timeout: 15000 }); await sleep(100); };

  /* ---- 1. fresh, empty database ---- */
  let page = await newPage({ ...devices['iPhone 13'] });
  await page.waitForSelector('.skel');
  await shot(page, '00-loading-skeleton');
  await page.waitForSelector('text=kcal left');
  await shot(page, '01-today-empty');
  await tap(page, 'text=Progress'); await sleep(200);
  await shot(page, '02-progress-empty');

  /* ---- 2. with history ---- */
  seedHistory(env);
  await page.reload(); await page.waitForSelector('text=kcal left');
  await tap(page, 'text=+1 glass');
  await page.waitForSelector('#status .pill:has-text("Saving")');
  await shot(page, '03-today-saving-pill');
  await idle(page);
  // log food through the FAB
  await tap(page, '.fab'); await page.fill('[data-in=foodQ]', 'paneer');
  await tap(page, '.list-row:has-text("Paneer")');
  await shot(page, '04-qty-sheet');
  await tap(page, '#qsave'); await idle(page);
  await tap(page, '[data-a=tab][data-t=today]'); await sleep(100);
  await page.fill('[data-in=weight]', '78.6'); await tap(page, '[data-a=weightSave]'); await idle(page);
  await shot(page, '05-today-logged');
  // failure + retry
  ctl.failNext = 1;
  await tap(page, 'text=+1 glass'); await page.waitForSelector('#status .pill.err'); await sleep(150);
  await shot(page, '06-save-failed-retry');
  await tap(page, '#status .pill.err'); await idle(page);
  // food views
  await tap(page, '[data-a=tab][data-t=food]'); await page.fill('[data-in=foodQ]', ''); await sleep(100);
  await shot(page, '07-food-log');
  await tap(page, '[data-a=foodSeg][data-s=day]'); await sleep(100);
  await shot(page, '08-food-day');
  await tap(page, '[data-a=foodSeg][data-s=recipes]'); await sleep(100);
  await shot(page, '09-recipes');
  await tap(page, '[data-a=editRecipe][data-id=r_dal]'); await sleep(150);
  await shot(page, '10-recipe-sheet');
  await tap(page, '.sh-head [data-a=closeSheet]');
  // workout
  await tap(page, '[data-a=tab][data-t=workout]'); await sleep(100);
  await shot(page, '11-workout-routines');
  await tap(page, '.tpl button.next');
  await tap(page, '[data-a=setDone][data-e="0"][data-s="0"]');
  await tap(page, '[data-a=setDone][data-e="0"][data-s="1"]');
  await sleep(300);
  await shot(page, '12-workout-active-rest');
  await idle(page);
  await tap(page, '[data-a=finishWorkout]'); await idle(page);
  await shot(page, '13-workout-summary');
  await tap(page, '[data-a=closeSummary]');
  // exercises
  await tap(page, '[data-a=tab][data-t=exercises]'); await tap(page, '[data-a=exFilter][data-f=group][data-v=back]'); await sleep(100);
  await shot(page, '14-exercises-back');
  await tap(page, '[data-a=exFilter][data-f=group][data-v=back]');
  await tap(page, '[data-a=exOpen][data-id=bench]'); await page.waitForSelector('text=Recent sessions'); await idle(page); await sleep(200);
  await shot(page, '15-exercise-detail');
  await tap(page, '[data-a=exEdit]'); await sleep(150);
  await shot(page, '16-exercise-edit-sheet');
  await tap(page, '.sh-head [data-a=closeSheet]');
  // progress
  await tap(page, '[data-a=tab][data-t=progress]'); await sleep(200);
  await shot(page, '17-progress');
  await page.locator('[data-a=energy][data-n="4"]').dispatchEvent('click'); await idle(page);
  // settings + dark theme
  await tap(page, '[data-a=settings]'); await sleep(150);
  await shot(page, '18-settings');
  await tap(page, '[data-a=setTheme][data-t=dark]'); await tap(page, '.sh-head [data-a=closeSheet]');
  await tap(page, '[data-a=tab][data-t=today]'); await sleep(150);
  await shot(page, '19-today-dark');
  const theme = await page.evaluate(() => localStorage.getItem('logbook_theme'));
  // delete an entry (confirm dialog auto-accepted)
  const before = env.ss.getSheetByName('FoodLog').rows().length;
  await tap(page, '.entry:has-text("Paneer")'); await tap(page, '[data-a=qtyDelete]'); await idle(page);
  const after = env.ss.getSheetByName('FoodLog').rows().length;
  await page.context().close();

  /* ---- 3. desktop layout ---- */
  page = await newPage({ viewport: { width: 1280, height: 860 } });
  await page.waitForSelector('text=kcal left');
  await shot(page, '20-desktop-today');
  await tap(page, '[data-a=tab][data-t=progress]'); await sleep(200);
  await shot(page, '21-desktop-progress');
  await page.context().close();
  await browser.close();

  const report = {
    screenshots: shots.length, errors,
    themePersisted: theme,
    deleteRemovedRow: before - after === 1,
    workoutsInSheet: env.ss.getSheetByName('Workouts').rows().length,
    bootstrapCallsPerLoad: 'getBootstrap',
    distinctCalls: [...new Set(ctl.calls)].sort()
  };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || !report.deleteRemovedRow || theme !== 'dark') process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
