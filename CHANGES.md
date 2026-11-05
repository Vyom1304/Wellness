# Logbook build notes

## Schema changes (the design wins)
| Tab | Brief said | Built | Why |
|---|---|---|---|
| Exercises | `primary_muscle` (one) | `primary_muscles` (comma list) | Design allows several primaries (e.g. Dips = chest + triceps; Deadlift = 3). |
| Exercises | movement push / pull / legs | adds `core` | Design's exercise form and abs exercises use `core`. |
| Exercises | n/a | `base_kg` | Design uses it to decide "kg" vs "reps" display (0 = bodyweight, tracked by reps). |
| Exercises | muscle dropdown | formula validation + header note | Multi-value cells can't be a dropdown via Apps Script. |
| Exercises | chest upper/mid/lower; back traps/rhomboids | kept in `notes` | Design has one `chest` and one `upper_back` muscle, with no chest sub-filter. Proposed smallest change if wanted: split `chest` into `upper_chest/mid_chest/lower_chest` in MUSCLES/GROUPS (design change). |
| WorkoutSets | n/a | `exercise_order` | Rebuilds exercise order, and keeps the same exercise appearing twice in a workout separate. |
| Routines | n/a | `custom` (checkbox) | Design shows a CUSTOM tag. `target_sets/target_reps` kept but unused by the UI. |
| Settings | n/a | `rotation` key, `notes` column | Design's "Up next" needs a rotation (was hard-coded in the mock). |
| FoodLog | meal values | breakfast, lunch, snack, dinner, pre, post | Design's six meals. |
| Weights | waist_cm | kept, not shown in UI | Design has no waist input; preserved on overwrite. |
| Settings | weight_unit | kept, not used | Design shows kg only. |

## Front-end changes vs design/index.html (now made directly in build/Index.html)
1. Mock data, mock api, CONFIG latency/failRate and the "Simulate failed saves" toggle removed; real google.script.run api added.
2. Startup: one `getBootstrap()` call instead of 10 reads.
3. Fonts: design export had local font blobs; now loads the same IBM Plex families from Google Fonts.
4. Design bug fixed: "+ New exercise" / "Edit exercise" crashed (`type` key used twice). Form now stores compound/isolation as `mech`.
5. Delete food entry asks for confirmation (brief requirement).
6. Food > Day fetches days older than 9 weeks on demand (brief: "recent" food log in bootstrap).
7. Real ids also replace temporary ids in references on the phone (food log, recipe items, routines, active workout).
8. `addSet` payload also sends `exIndex`.
9. Empty-state guards: no weights yet (Progress showed NaN) and no routine in rotation.
10. 7-day average extracted into `rollingAvg()` (unit-tested). "Made with Claude Design" badge removed.

## v2: Gym tab and exercise bank
- Workout and Exercises tabs merged into one **Gym** tab (nav: Today / Food / Gym / Progress). Old tab names still route to Gym.
- Gym logs set by set (exercise, weight, reps), with "- Set", move up/down, PR tag, and a "How to do it" link per exercise.
- **Exercises** button at the bottom of Gym opens the exercise bank: animated front/back body map (original artwork), tap a muscle to filter, plus search and filters for push/pull/legs/core, equipment, compound/isolation, sorted A-Z, recently trained or best lift. Filters combine with AND across groups, OR within one. Muscle filter lists primary movers first, then "Also works" assisting exercises.
- Exercise detail: highlighted muscles, "What it hits" bars, how-to steps, form cues, common mistakes, PR and history. Add to workout straight from the bank.
- Exercises sheet gains `muscle_note`, `how_to`, `cues`, `mistakes` columns (new file `ExerciseGuide.gs` holds the text for all 142 seeded exercises). `setup()` adds the columns and fills only blank cells, so your edits are never overwritten.
- `CACHE_VERSION` bumped to v2. No columns renamed or removed; Today, Food and Progress unchanged apart from nav.
- `tools/make_index.py` retired: `build/Index.html` is now the source.
- Known: chest sub-regions (upper/mid/lower) stay in notes; the stale browser-history entry after closing the bank is harmless.

## v3: minimal exercise bank with finer muscle regions
- The Exercises page is now just the body map. Chips, search and sorting are gone; tap a muscle and a list of exercises appears below it.
- The map fills the screen width (scroll down for the legs) and has 29 tappable regions: chest upper/mid/lower, biceps long/short head, triceps long/lateral/medial head, upper/lower abs and obliques, outer/inner quads and rectus femoris, outer/inner hamstrings, glute max/med, calf gastrocnemius/soleus, upper traps / mid back / lower traps, three delt heads, forearm flexors/extensors, lats, lower back.
- List rows show only the exercise name and the region it trains. Equipment, type, history and best lift are on the exercise's own page.
- Exercises sheet gains `focus` and `focus_assist` columns (region ids). `setup()` fills them for the seeded exercises (blank cells only). Exercises you add yourself work too: they show under every region of their muscle until you pick specific regions in the edit form.
- Two exercises added so every region has something that trains it: Incline prone Y raise and Scapular pull-up (lower traps). 144 seeded exercises now.
- `CACHE_VERSION` bumped to v3.

## v4: simple food log (no meals, no goals), real nutrition data
- **No meals.** Foods are logged by day only: pick a food, type the grams you ate, done. Food opens on **Day**; tabs are Day, Add, Recipes, Foods. The FoodLog `meal` column is gone for new sheets; on an existing sheet the old column stays untouched and is simply no longer used.
- **No calorie or macro goals** for now (the Settings keys are gone from new sheets; old ones are ignored). Today shows what you ate with plain labels: Calories (kcal), Protein, Carbs (includes fibre), Fat, in grams. Progress shows averages without target comparisons. Water goal stays.
- **All nutrients.** Each food carries 30 extra values per 100 g: fibre, sugar, saturated / mono / poly fat, cholesterol, sodium, potassium, calcium, iron, magnesium, phosphorus, zinc, copper, manganese, selenium, vitamins A, C, D, E, K, B1, B2, B3, B5, B6, B7, B9 (folate), B12 and choline. They are scaled by the grams you eat, stored with each log entry (new `nutrients` column) and summed under **Show all nutrients** on Today and Day. A dash means no food that day has a value for it, and it counts as 0.
- **Data source.** About 200 foods, 143 of them new (fruits, vegetables, greens, pulses, nuts, seeds, fish, oils, dairy), from the Indian Food Composition Tables 2017 (ICMR-NIN), per 100 g edible part. Vitamin A is retinol + beta-carotene/12. B12 and choline are blank because those tables do not list them. Cooked or processed foods that the tables list only raw (roti, cooked rice, curd, boiled rajma…) use the raw entry scaled by calories, so treat their vitamins as estimates. Packaged and mixed foods without a table match (oats, whey, bread, tofu, honey, butter…) have macros only until you add values.
- **Recipes** start empty (the five examples are removed on update if you never edited them). A recipe takes the grams of each ingredient and the **weight of the finished dish**, and every number scales by the grams you eat ("aloo sabji 250 g"). Without a finished weight, the raw total is used. Servings are optional.
- **Clearer numbers:** every figure now has its unit; ingredient rows say "per 100 g"; recipe totals show per 100 g, per serving and whole dish.
- Starting weight is 50 kg (first row of a new Weights tab and the default in the weight box).
- New file `FoodData.gs` holds the nutrient data. `setup()` removes untouched example recipes, adds the missing foods by id and fills blank nutrient cells only. `CACHE_VERSION` is now v4.
