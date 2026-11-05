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

const J = x => JSON.parse(JSON.stringify(x));
let RECIPE_ID = '';
function seedHistory(env) {
  const c = env.ctx;
  RECIPE_ID = J(c.saveRecipe({ id: 'tmpR', name: 'Aloo sabji', servings: 1, cooked: 480, items: [{ ing: 'potato', g: 400 }, { ing: 'oil', g: 20 }, { ing: 'onion', g: 80 }] })).data.id;
  for (let d = -45; d <= -1; d++) {
    if (d % 7 !== 3) c.addWeight({ date: day(d), kg: Math.round((79.5 + d * 0.03 + Math.sin(d) * 0.3) * 10) / 10 });
    if (d >= -27) c.saveWellness({ date: day(d), sleep: 6.5 + (d % 3) * 0.5, energy: 3 + (d % 2) });
    if (d >= -27) c.setWater(day(d), 7 + (d % 3));
    if (d >= -20) {
      const big = { ca: 80, fe: 2.1, vitc: 12, b9: 60, k: 310, na: 14 };
      c.addFoodEntry({ id: 'tmpb' + d, date: day(d), time: '08:30', kind: 'ing', ref: 'oats', qty: 70, unit: 'g', name: 'Rolled oats', kcal: 272, p: 11.8, c: 46.4, f: 4.8, n: big });
      c.addFoodEntry({ id: 'tmpl' + d, date: day(d), time: '13:10', kind: 'rec', ref: RECIPE_ID, qty: 250, unit: 'g', name: 'Aloo sabji', kcal: 248, p: 5.7, c: 33.7, f: 9.1, n: big });
      c.addFoodEntry({ id: 'tmpd' + d, date: day(d), time: '21:00', kind: 'ing', ref: 'chicken', qty: 200, unit: 'g', name: 'Chicken breast', kcal: 440 + d * 3, p: 62, c: 0, f: 20, n: big });
      c.addFoodEntry({ id: 'tmps' + d, date: day(d), time: '17:00', kind: 'ing', ref: 'whey', qty: 30, unit: 'g', name: 'Whey protein', kcal: 120, p: 24, c: 2.4, f: 1.8 });
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
  const assertions = {};

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
  await page.waitForSelector('text=Eaten today');
  await shot(page, '01-today-empty');
  await tap(page, 'text=Progress'); await sleep(200);
  await shot(page, '02-progress-empty');

  /* ---- 2. with history ---- */
  seedHistory(env);
  await page.reload(); await page.waitForSelector('text=Eaten today');
  await tap(page, 'text=+1 glass');
  await page.waitForSelector('#status .pill:has-text("Saving")');
  await shot(page, '03-today-saving-pill');
  await idle(page);
  // log food through the FAB
  await tap(page, '.fab'); await page.fill('[data-in=foodQ]', 'paneer');
  await tap(page, '.list-row:has-text("Paneer")');
  await page.fill('[data-in=qty]', '150'); await sleep(100);
  await tap(page, '[data-a=qtyNut]'); await sleep(100);
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
  await tap(page, '[data-a=tab][data-t=food]'); await tap(page, '[data-a=foodSeg][data-s=day]'); await sleep(100);
  await shot(page, '08-food-day');
  await tap(page, '[data-a=toggleNut]'); await sleep(100);
  await shot(page, '08b-food-day-all-nutrients');
  await tap(page, '[data-a=foodSeg][data-s=log]'); await page.fill('[data-in=foodQ]', ''); await sleep(100);
  await shot(page, '07-food-log');
  await tap(page, '[data-a=foodSeg][data-s=ingredients]'); await sleep(100);
  await tap(page, '[data-a=editIng][data-id=paneer]'); await tap(page, '[data-a=ingMore]'); await sleep(150);
  await shot(page, '09b-food-form');
  await tap(page, '.sh-head [data-a=closeSheet]');
  await tap(page, '[data-a=foodSeg][data-s=recipes]'); await sleep(100);
  await shot(page, '09-recipes');
  await tap(page, '[data-a=editRecipe]'); await sleep(150);
  await shot(page, '10-recipe-sheet');
  await tap(page, '.sh-head [data-a=closeSheet]');
  // gym: routines, then the Exercises button at the bottom of the page
  await tap(page, '[data-a=tab][data-t=gym]'); await sleep(100);
  await shot(page, '11-gym-routines');
  await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.className = ''; window.scrollTo(0, document.body.scrollHeight); }); await sleep(250);
  await shot(page, '12-gym-bottom-exercises-button');
  const bankBtn = await page.locator('.bank-btn').boundingBox();
  const navBox = await page.locator('#nav').boundingBox();
  assertions.exercisesButtonClearOfNav = bankBtn.y + bankBtn.height <= navBox.y + 1;
  await page.evaluate(() => window.scrollTo(0, 0));
  // active workout, set by set
  await tap(page, '.tpl button.next');
  await tap(page, '[data-a=setDone][data-e="0"][data-s="0"]');
  await tap(page, '[data-a=setDone][data-e="0"][data-s="1"]');
  await tap(page, '[data-a=addSet][data-e="0"]');
  await sleep(300);
  await shot(page, '13-gym-active-sets');
  await idle(page);
  await tap(page, '[data-a=finishWorkout]'); await idle(page);
  await shot(page, '14-gym-workout-summary');
  await tap(page, '[data-a=closeSummary]');
  // exercise bank: front, back, a muscle selected, detail
  await tap(page, '[data-a=tab][data-t=gym]'); await tap(page, '[data-a=bankOpen]'); await sleep(250);
  await shot(page, '15-bank-front');
  await tap(page, '[data-a=exView][data-v=back]'); await sleep(900);
  await shot(page, '16-bank-back');
  await tap(page, '.mus[data-muscle=lats]'); await sleep(900);
  assertions.mapSelectsLats = await page.evaluate(() => document.querySelector('.mus[data-muscle=lats]').classList.contains('sel') && S.ex.region === 'lats');
  await shot(page, '17-bank-lats-selected');
  await tap(page, '[data-a=exList]'); await sleep(900);
  assertions.pillHidesOnList = await page.evaluate(() => document.querySelector('#bankpill').classList.contains('hide'));
  await shot(page, '18-bank-lats-list');
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(150);
  await tap(page, '[data-a=exView][data-v=front]'); await sleep(900);
  await tap(page, '.mus[data-muscle=mid_chest]'); await sleep(900);
  await tap(page, '[data-a=exList]'); await sleep(700);
  await shot(page, '18b-bank-chest-list');
  await tap(page, '[data-a=exOpen][data-id=bench]'); await page.waitForSelector('text=Recent sessions'); await idle(page); await sleep(900);
  assertions.detailHighlightsBench = await page.evaluate(() => document.querySelector('.mus[data-muscle=mid_chest]').classList.contains('prim') && document.querySelector('.mus[data-muscle=triceps_long]').classList.contains('sec'));
  await shot(page, '19-bank-exercise-detail');
  await page.evaluate(() => window.scrollTo(0, 560)); await sleep(150);
  await shot(page, '20-bank-how-to');
  await page.goBack(); await sleep(500);
  assertions.phoneBackClosesDetail = await page.evaluate(() => S.gym.bank === true && S.ex.detail === null);
  await tap(page, '[data-a=exOpen][data-id=bench]'); await sleep(200);
  await tap(page, '[data-a=exEdit]'); await sleep(150);
  await shot(page, '21-bank-edit-exercise-sheet');
  await tap(page, '.sh-head [data-a=closeSheet]');
  await tap(page, '[data-a=exBack]'); await tap(page, '[data-a=bankClose]'); await sleep(300);
  assertions.backReturnsToGym = await page.evaluate(() => S.tab === 'gym' && !S.gym.bank);
  // tap targets: every button on the Gym and bank pages is at least 44 px tall
  await tap(page, '[data-a=bankOpen]'); await sleep(200);
  assertions.smallTargets = await page.evaluate(() => [...document.querySelectorAll('#view button, #view input')].filter(n => { const r = n.getBoundingClientRect(); return r.width && r.height && r.height < 43.5; }).map(n => (n.className || n.tagName) + ':' + Math.round(n.getBoundingClientRect().height)));
  await tap(page, '[data-a=bankClose]');
  // progress
  await tap(page, '[data-a=tab][data-t=progress]'); await sleep(200);
  await shot(page, '22-progress');
  await page.locator('[data-a=energy][data-n="4"]').dispatchEvent('click'); await idle(page);
  // settings + dark theme
  await tap(page, '[data-a=settings]'); await sleep(150);
  await shot(page, '23-settings');
  await tap(page, '[data-a=setTheme][data-t=dark]'); await tap(page, '.sh-head [data-a=closeSheet]');
  await tap(page, '[data-a=tab][data-t=today]'); await sleep(150);
  await shot(page, '24-today-dark');
  const theme = await page.evaluate(() => localStorage.getItem('logbook_theme'));
  // delete an entry (confirm dialog auto-accepted)
  const before = env.ss.getSheetByName('FoodLog').rows().length;
  await tap(page, '.entry:has-text("Paneer")'); await tap(page, '[data-a=qtyDelete]'); await idle(page);
  const after = env.ss.getSheetByName('FoodLog').rows().length;
  await tap(page, '[data-a=tab][data-t=gym]'); await tap(page, '[data-a=bankOpen]'); await tap(page, '.mus[data-muscle=quad_outer]'); await sleep(900);
  await shot(page, '25-bank-dark');
  await page.context().close();

  /* ---- 3. desktop layout ---- */
  page = await newPage({ viewport: { width: 1280, height: 860 } });
  await page.waitForSelector('text=Eaten today');
  await shot(page, '26-desktop-today');
  await tap(page, '[data-a=tab][data-t=progress]'); await sleep(200);
  await shot(page, '27-desktop-progress');
  await tap(page, '[data-a=tab][data-t=gym]'); await tap(page, '[data-a=bankOpen]'); await tap(page, '.mus[data-muscle=mid_chest]'); await sleep(900);
  await shot(page, '28-desktop-bank');
  await page.context().close();
  await browser.close();

  const report = {
    screenshots: shots.length, errors,
    themePersisted: theme, ...assertions,
    deleteRemovedRow: before - after === 1,
    workoutsInSheet: env.ss.getSheetByName('Workouts').rows().length,
    bootstrapCallsPerLoad: 'getBootstrap',
    distinctCalls: [...new Set(ctl.calls)].sort()
  };
  console.log(JSON.stringify(report, null, 2));
  const failed = ['exercisesButtonClearOfNav', 'mapSelectsLats', 'detailHighlightsBench', 'phoneBackClosesDetail', 'backReturnsToGym'].filter(k => !assertions[k]);
  if (failed.length) console.error('FAILED checks: ' + failed.join(', '));
  if (errors.length || failed.length || !report.deleteRemovedRow || theme !== 'dark') process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
