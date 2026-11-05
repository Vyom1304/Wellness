# Wellness: Logbook

A personal health and fitness tracker. A Google Sheet stores the data, Google Apps Script serves the backend, and a mobile-first web app is the UI.

- **`build/`**: the files you deploy (`Code.gs`, `Index.html`, `appsscript.json`). **Start with [`build/README.md`](build/README.md)** for step-by-step deployment.
- `design/index.html`: the original UI design (source of truth for look and behaviour).
- `tools/make_index.py`: rebuilds `build/Index.html` from the design.
- `tests/`: Node unit/integration tests against a simulated Google Sheet, plus a Playwright browser check (`npm test`, `npm run e2e`). Screenshots from the last browser run are in `tests/screenshots/`.
- `CHANGES.md`: schema and UI changes made to fit the design.
- `CODE_PROMPT.md`: the original brief.
