# Review 2 — code step 4

**Verdict:** PASS

All checks complete. Here's my review summary:

## Review of WEB-004 step 4 (code)

**Verdict: PASS**

### Findings

**Scope & compliance** — Only two new files exist in the worktree (`dashboard/history.mjs`, `dashboard/history.spec.mjs`); no `server.mjs`, `app.js`, or side-effect `batch-history.json` touched. All Do-Not clauses respected. `registerExtra(router, ctx)` matches the WEB-003 router contract (`router.on(method, path, handler)`, `handle(req, res, ctx)`), with handlers as ctx-capturing closures.

**Step 1 (history)** — `listHistory` scans `<stateRoot>/batches/*.json` via `readBatchState` (corrupt files → null → skipped, never throws), emits exactly the mandated compact shape (`batchId, status, startedAt, endedAt, durationMs, totalWaves, totalTasks, succeededTasks, failedTasks, tokens:0`), sorted newest-first with batchId tiebreak. `getHistoryEntry` returns full BatchState + summary superset; id validated against `/^[\w-]+$/` (traversal-blocked).

**Step 2 (STATUS.md)** — `GET /api/status-md/:taskId`: lane.worktree/STATUS.md preferred (via `ctx.loadBatch`, tolerant of both raw BatchState and `{batch:{lanes}}` shapes), `<tasksRoot>/<taskId>-*/STATUS.md` fallback, 400 on invalid id, 404 otherwise. Matches the `<taskId>-*` task-packet convention in the repo.

**Step 3 (preferences + degraded routes)** — GET/POST `/api/preferences` with default `{theme:"dark"}`, merge-persist to `<stateRoot>/dashboard-preferences.json`, corrupt/absent file → default, 400 on malformed body, 500 wrapped. `/api/conversation/:prefix` → 200 empty `application/x-ndjson`; `/api/agent-events/:agentId` → 200 `[]`. All deps via ctx; no CLI parsing. CORS + proper content-types on every response.

**Step 4 (tests)** — All 12 `node --test dashboard/history.spec.mjs` tests pass (pure-function + route-contract integration). The four mandated integration assertions (history 200, status-md known→原文/unknown→404, preferences POST→GET round-trip) are covered against a router double faithful to the
