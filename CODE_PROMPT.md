Build a personal health and fitness tracker ("Logbook"), backed by Google Sheets and hosted as a Google Apps Script web app. The UI design is already done: it is design/index.html in this folder. Treat it as the source of truth for look, layout and behaviour. Do not redesign it. Your job is to build the backend, wire the UI to it, and give me a final build I can deploy.

START BY READING design/index.html. Its `api` object (22 functions) and its MOCK data shapes are the contract: keep the same function names, arguments and return shapes, and map them onto the sheet tabs. Where the schema below and the design disagree, the design wins and the schema changes. List every such change in your final summary.

ARCHITECTURE
- Google Sheet = database. Apps Script (server-side .gs) = API. The design HTML becomes Index.html, served with HtmlService.
- The front end calls the backend with google.script.run, wrapped in a promise-based `api` object. Replace the mock `api.*` bodies in the design with real calls. Remove the mock latency and CONFIG.failRate, but keep the optimistic-save, "saving..." indicator and retry behaviour exactly as designed.
- Single-user app: deploy as "Execute as: Me", "Who has access: Only myself".
- It must work well on a phone and be addable to the home screen.
- The design loads Google Fonts and uses localStorage (theme, active workout) inside try/catch. Keep that; confirm both behave inside the Apps Script iframe.

DELIVERABLES (put in /build)
1. Code.gs: doGet(), setup(), and all API functions
2. Index.html: the design wired to the backend. Inline CSS/JS is fine, or split via HtmlService include() helpers if cleaner.
3. appsscript.json: manifest with timezone Asia/Kolkata, webapp settings, V8 runtime
4. README.md: exact step-by-step deployment for a non-developer, in two paths: (a) manual copy-paste into the Apps Script editor, (b) clasp. Include how to run setup(), how to deploy as a web app, how to update the deployment later, and how to add it to a phone home screen.

SHEET SCHEMA
setup() must be idempotent. It creates any missing tab with a bold, frozen header row, sensible column widths, data validation (dropdowns for meal type, muscle group, equipment, movement type), and number formats. It must never overwrite existing data.

Tabs and columns (adjust to match the design's data shapes):
- Ingredients: id, name, kcal_100g, protein_100g, carbs_100g, fat_100g, fibre_100g, unit_name, unit_g, notes   (unit_name/unit_g = a countable portion, e.g. "roti", 40)
- Recipes: id, name, servings, notes
- RecipeItems: recipe_id, ingredient_id, grams
- FoodLog: id, date, time, meal, kind (ing|rec), ref_id, name, qty, unit (g|pc|srv), kcal, protein, carbs, fat   (store computed values at log time so history doesn't change when an ingredient is later edited)
- Exercises: id, name, primary_muscle, secondary_muscles, equipment, movement_type (push|pull|legs), mechanic (compound|isolation), notes
- Routines: id, name, exercise_id, order, target_sets, target_reps
- Workouts: id, date, routine_id, name, start_time, duration_min, notes
- WorkoutSets: id, workout_id, exercise_id, set_number, reps, weight_kg, rpe, is_warmup, timestamp   (addSet persists each completed set immediately, so a crash mid-workout loses nothing)
- Weights: date, weight_kg, waist_cm   (one row per date; saving again overwrites)
- Wellness: date, sleep_hours, energy (1-5)   (one row per date; saving again overwrites)
- Water: date, glasses
- Settings: key, value (kcal, protein_g, carbs_g, fat_g, water_glasses, glass_ml, weight_unit). getTargets() reads these.

SEED DATA (run in setup() only if the tab is empty)
- Exercises: at least 120 exercises covering every muscle group and sub-group the design's filters use: chest (upper/mid/lower), back (lats, upper back/traps/rhomboids, lower back), shoulders (front/side/rear), biceps, triceps, forearms, abs/core, quads, hamstrings, glutes, calves. Mix of barbell, dumbbell, cable, machine and bodyweight. Tag each properly. Reuse the design's exercise ids where they exist.
- Ingredients: ~60 common Indian and gym staple foods with accurate per-100g values (rice, roti/atta, dal varieties, paneer, curd, milk, eggs, chicken breast, oats, banana, peanut butter, whey, etc.), including piece units where natural (roti, egg, banana, scoop). Mark values as approximate in notes.
- Routines: a Push / Pull / Legs split and an Upper / Lower split using the seeded exercises.
- Settings: use the design's defaults unless I give targets below.

MY PERSONAL SETTINGS (edit before sending)
- Daily targets: ___ kcal, ___ g protein, ___ g carbs, ___ g fat
- Training split I follow: ___
- Foods I eat most often (seed these as ingredients/recipes): ___

API
All server functions return plain JSON-serialisable objects and handle errors with try/catch, returning {ok, data, error} (unwrap this inside the front-end `api` wrapper so the rest of the UI keeps the shapes the design expects).
- Keep every function the design's `api` already has: getTargets, getFoodLog, addFoodEntry, updateFoodEntry, deleteFoodEntry, getIngredients, saveIngredient, getRecipes, saveRecipe, getWater, setWater, getWeights, addWeight, getWellness, saveWellness, getExercises, saveExercise, getExerciseHistory, getRoutines, getWorkouts, addSet, saveWorkout.
- Add getBootstrap(): one call returning everything the first screen needs (targets, ingredients, recipes, exercises, routines, recent foodLog, water, weights, wellness, workouts), because each Apps Script round-trip costs 1-3 seconds. Make the front end call it once at startup instead of many separate reads, without changing what the UI renders.
- Recipe nutrition (per serving and per batch), 1RM (Epley), PRs, weekly sets per muscle (primary = 1 set, secondary = 0.5), the 7-day weight average and weekly averages may stay computed in the front end as the design does today. Only move logic server-side if the design requires it.

PERFORMANCE (this matters)
- Read whole ranges with a single getValues() call per tab, never cell-by-cell. Write with appendRow or one setValues per operation.
- Use CacheService for read-heavy, rarely-changing tabs (Ingredients, Exercises) and invalidate on write.
- Use LockService around writes to prevent duplicate IDs. Generate IDs with Utilities.getUuid() or a short random id. Replace the design's temporary "tmp..." ids with the real id returned by the server, as the design already does.
- Dates: store as real Date values in the Asia/Kolkata timezone, and make sure the day boundary doesn't shift because of timezone conversion. The design uses 'YYYY-MM-DD' strings; keep that format over the wire.

DATA SAFETY
- No destructive operations on existing data in setup().
- Deletes are fine, but the UI confirms.
- Add exportBackup() that copies the spreadsheet into a "Backups" folder in Drive, and an optional weekly time-driven trigger installer for it.

QUALITY BAR
- Write the pure logic (nutrition calculation, 1RM, weekly volume, 7-day average, date handling, row-to-object mapping) as plain functions and unit-test them under Node. Report what you tested and what you could not test (anything needing a live Google account).
- Review Index.html for every use of MOCK data and confirm none remain.
- Don't invent features beyond the design. If the design shows something the schema can't support, tell me and propose the smallest schema change instead of silently dropping it.

At the end, give me a short summary: what's built, how to deploy it in under 10 minutes, schema changes you made to fit the design, and any known gaps.
