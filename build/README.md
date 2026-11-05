# Logbook: deployment guide

Logbook is a personal food, training and body-weight tracker. Your data lives in a Google Sheet you own. A small Google Apps Script program serves the app and reads and writes the Sheet. Only you can open it.

This folder holds 4 files:

| File | What it is |
|---|---|
| `Code.gs` | The backend: reads and writes the Sheet, sets it up, makes backups |
| `ExerciseGuide.gs` | How-to text for the built-in exercises (a second script file) |
| `Index.html` | The app you see on your phone |
| `appsscript.json` | Settings: India timezone, "only me" access |
| `README.md` | This guide |

Pick **one** path: **A** (copy and paste in the browser, about 10 minutes, nothing to install) or **B** (`clasp`, the command line tool). Most people should use A.

---

## Path A: copy and paste (recommended)

### 1. Create the Sheet and open its script editor
1. On a computer, go to **https://sheets.new** while signed in to your Google account. A blank spreadsheet opens.
2. Click the title "Untitled spreadsheet" (top left) and rename it **Logbook**.
3. In the menu, click **Extensions → Apps Script**. A new tab opens with the code editor.
4. Click "Untitled project" at the top and rename it **Logbook**.

### 2. Paste the four files
1. **Code.gs**: the editor already shows a file called `Code.gs` with a few lines in it. Select everything in it (Ctrl+A, or Cmd+A on Mac), delete it, then paste the full contents of this folder's `Code.gs`.
2. **ExerciseGuide.gs**: click **+** next to "Files", choose **Script**, type `ExerciseGuide` as the name, and paste the full contents of `ExerciseGuide.gs`.
3. **Index.html**: in the left sidebar, click **+** next to "Files", choose **HTML**, and type `Index` as the name. Type only `Index`, because the editor adds `.html` itself, and use a capital I. Delete the sample content and paste the full contents of `Index.html`.
4. **appsscript.json**: click the **gear icon (Project Settings)** in the far-left bar. Tick **"Show 'appsscript.json' manifest file in editor"**. Go back to the **Editor** (the `< >` icon), open `appsscript.json`, replace everything in it with this folder's `appsscript.json`.
4. Click the **Save** icon (or press Ctrl+S / Cmd+S).

### 3. Run `setup()` once
This creates all the tabs in your Sheet and fills them with about 140 exercises, about 70 foods, 5 recipes and 6 routines.

1. In the toolbar above the code there is a dropdown of function names. Pick **setup**.
2. Click **Run**.
3. Google asks for permission the first time:
   - Click **Review permissions** and choose your account.
   - You'll see **"Google hasn't verified this app"**. This is normal for your own scripts. Click **Advanced → Go to Logbook (unsafe) → Allow**.
   - Logbook asks for these permissions: your spreadsheets (to store data), Drive (only to copy the Sheet into a "Backups" folder), "run when you're not present" (for the optional weekly backup), and showing a menu inside the Sheet.
4. The **Execution log** at the bottom should end with `Setup complete.` Go back to the Sheet tab: you'll see tabs named Settings, FoodLog, Ingredients, Exercises and so on.

`setup()` is safe to run again at any time. It only creates missing tabs and columns and never changes or deletes your data. After you reload the Sheet, it also adds a **Logbook** menu with the same actions (*Set up / repair tabs*, *Back up now*, weekly backup on/off).

### 4. Deploy it as a web app
1. In the Apps Script editor, click **Deploy → New deployment** (top right).
2. Click the gear next to "Select type" and choose **Web app**.
3. Fill in:
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Only myself**
4. Click **Deploy**, then **Copy** the **Web app URL**. It ends in `/exec`. This is your app.
5. Open that URL in your browser. You should see the Today screen. The first load takes 2–4 seconds.

### 5. Updating later (keeps the same URL)
When you get a new version of the files:
1. Paste the new `Code.gs` / `Index.html` over the old ones. If `ExerciseGuide.gs` is new to you, click **+** next to "Files", choose **Script**, name it `ExerciseGuide`, and paste it in. Then **Save**.
2. Click **Deploy → Manage deployments**, select your deployment, click the **pencil (Edit)** icon.
3. Under **Version**, choose **New version**, then click **Deploy**.

The URL stays the same, so your home-screen icon keeps working. If the new version mentions new columns or tabs, run **setup** again (or use **Logbook → Set up / repair tabs** in the Sheet).

> Tip: **Deploy → Test deployments** gives a `/dev` URL that always runs your latest *saved* code. It's handy for trying a change before you publish it with "New version".

---

## Path B: clasp (command line)

You need Node.js 20 or newer. These steps use clasp 3.x, whose command names differ from the older 2.x.

1. Install and sign in:
   ```bash
   npm install -g @google/clasp
   ```
   ```bash
   clasp login
   ```
2. Turn on the Apps Script API for your account: open https://script.google.com/home/usersettings and switch **Google Apps Script API** to **On**.
3. Create a new Sheet with an attached script, in an **empty** folder:
   ```bash
   mkdir logbook-deploy && cd logbook-deploy
   ```
   ```bash
   clasp create-script --type sheets --title "Logbook"
   ```
   This prints the new Sheet's URL and downloads a default `appsscript.json` (and possibly a `Code.js`).
4. Replace the downloaded files with ours. Delete everything in the folder **except `.clasp.json`**, then copy in `Code.gs`, `ExerciseGuide.gs`, `Index.html` and `appsscript.json` from this folder.
5. Upload them (`--force` lets our `appsscript.json` replace the default one):
   ```bash
   clasp push --force
   ```
6. Run `setup()` once. Open the editor, then follow **Path A, step 3** (choose `setup`, Run, allow permissions):
   ```bash
   clasp open-script
   ```
7. Deploy:
   ```bash
   clasp create-deployment --description "v1"
   ```
   It prints a deployment ID. Your app URL is `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`. You can also open it from the editor via **Deploy → Manage deployments**.
8. Update later (same URL). Push the new files, then point the existing deployment at a new version:
   ```bash
   clasp push --force
   ```
   ```bash
   clasp update-deployment <DEPLOYMENT_ID> --description "v2"
   ```
   `clasp list-deployments` shows your deployment IDs. Ignore the one marked `@HEAD`, which is the `/dev` test URL.

---

## Add it to your phone's home screen

Sign in to the **same Google account** in your phone's browser first. Then open the `/exec` URL.

- **iPhone (Safari)**: tap the **Share** button → **Add to Home Screen** → name it **Logbook** → **Add**.
- **Android (Chrome)**: tap **⋮** → **Add to Home screen** (or **Install app**) → **Add**.

The icon opens the app in your browser. It is not a full-screen app, so Google's sign-in keeps working. If you ever see a Google sign-in page or "Sorry, unable to open the file", sign in to the same account in that browser.

---

## Personalise

All of these are edited in the Sheet. The app picks up changes the next time it loads, usually right away. If something looks stale, use **Logbook → Refresh app cache**.

- **Daily targets**: `Settings` tab. Change `kcal`, `protein_g`, `carbs_g`, `fat_g`, `water_glasses`.
- **Training rotation** ("Up next" on Today): `Settings` → `rotation`, routine ids separated by commas, e.g. `upper,lower` or `push,pull,legs`.
- **Routines**: `Routines` tab, one row per exercise: `id` (e.g. `push`), `name`, `exercise_id` (from the Exercises tab), `order`. Tick `custom` to show the CUSTOM tag. `target_sets` / `target_reps` are for your reference only; the app pre-fills sets from your last session, as designed.
- **Foods, recipes, exercises**: add them in the app, or type rows into the tabs.

Columns with dropdowns (meal, equipment, movement, mechanic) and muscle lists only accept valid values. Muscles are comma-separated keys: `chest, lats, upper_back, lower_back, front_delts, side_delts, rear_delts, biceps, triceps, forearms, abs, quads, hamstrings, glutes, calves`.

---

## Backups

- **Back up now**: in the Sheet, **Logbook → Back up now**. It copies the whole spreadsheet into a Drive folder named **Backups**. From the editor, you can run `exportBackup` instead.
- **Weekly backup**: **Logbook → Turn on weekly backup** (or run `installWeeklyBackup`). It runs every Sunday around 3 am IST, and Google emails you if a backup fails. Turn it off with **Turn off weekly backup**.
- Old backups are never deleted automatically. Clear out the Backups folder now and then.

---

## Good to know

- **Speed**: each save takes 1–3 seconds on Google's side. The app shows your change instantly with a small "Saving…" pill, then "✓ Saved". If a save fails you'll see **"Not saved · Retry"**. Tap Retry, and nothing is lost or duplicated.
- **During a workout**, every ticked set is written to the `WorkoutSets` tab immediately. The workout in progress is also kept on the phone, so closing the browser mid-workout loses nothing. When you tap Finish, the sets are filed under the finished workout. If you **discard** a workout, its already-saved sets stay in `WorkoutSets` with a `workout_id` starting with `tmp`. They are ignored by the app and safe to delete by hand.
- **Dates** are stored as real dates in India time (Asia/Kolkata). The app uses your phone's date for "today".
- **Food › Day** shows the last 9 weeks instantly. Older days load when you swipe to them.
- **Don't rename tabs or header cells.** You may reorder columns, or add your own columns to the right; the app keeps them.

### Troubleshooting
| Problem | Fix |
|---|---|
| "Couldn't load your data … tab is missing" | Run **setup** again (or Logbook → Set up / repair tabs). |
| "Script function not found: doGet" | `Code.gs` wasn't saved, or the HTML file isn't named exactly `Index`. Save, then deploy a **New version**. |
| App shows old code after an update | You saved but didn't deploy: Manage deployments → Edit → **New version**. |
| Changes typed into the Sheet don't show | Logbook → **Refresh app cache**, then reload the app. |
| "You need access" / "Sorry, unable to open the file" | Open the link while signed in to the account that deployed it (access is "Only myself"). |
