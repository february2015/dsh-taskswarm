# Review 1 — code step 4

**Verdict:** REVISE

## Review — WEB-001 step 4 (code)

**Verdict: REVISE**

### Findings summary

**What passes:**
- `dashboard/public/` has 4 files (meets "4+" criterion): `index.html`, `app.js`, `style.css`, `buju-word.svg`.
- `app.js` and `style.css` are **byte-identical** to upstream (`/tmp/taskplane/dashboard/public/`, commit `504ee688` recorded in STATUS.md) — `diff` clean, no logic changes.
- `index.html` rebrand is minimal and correct: only 3 lines differ from upstream — `<title>Buju Dashboard</title>`, header logo → `buju-word.svg` (alt "Buju"), footer → "Buju Dashboard". All other DOM id/class/structure untouched (139 lines preserved).
- Step 3 id cross-check passes: all 44 ids referenced via `$("…")`/`getElementById` in app.js exist in index.html (supervisor/agents/messages/terminal panels all present). The only unmatched id, `last-checked`, is injected dynamically at runtime (app.js:2403), same as upstream.
- `node --check dashboard/public/app.js` passes.

**Blocker — broken header logo / 404s on theme apply:**
`app.js` lines 2751–2758 reference two assets at runtime that are absent from the port:
- `DARK_LOGO = "taskplane-word-white.svg"` (applied on **every** page load — `loadThemePreference()` falls back to `applyTheme("dark")` when `/api/preferences` is unavailable, app.js:2766)
- `LIGHT_LOGO = "taskplane-word-color.svg"` (applied on light-mode toggle)

Both were deleted from `dashboard/public/`, so the header logo gets swapped to a 404 on load and the image breaks — defeating the "品牌替换" mission in practice. Verified with a static server: `index.html`/`style.css`/`app.js`/`buju-word.svg` → 200, both `taskplane-word-*.svg` → **404**. This also fails the Step 4 smoke criterion ("确认无 404").

**Suggested fix (spec-compatible, no app.js changes):** per the file scope, `taskplane-word-color.svg` may be "保留为占位" — keep (or add) both `taskplane-word-white.svg` and `taskplane-word-color.svg` as Buju-branded placeholder SVGs so `applyTheme()` never 404s and the Buju logo persists 
