# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev          # Vite dev server on :5173 — local-only, no /api (sync is unavailable)
npm test             # vitest run (test/parse.test.ts, test/server.test.ts)
npm run typecheck    # BOTH tsconfigs — the only way to typecheck api/ and server/
npm run build        # tsc -p tsconfig.json && vite build  (does NOT check api/ or server/)
npm run build:demo   # sync-free single-file build in dist-demo/
```

- One test file: `npx vitest run test/parse.test.ts`. One test: `npx vitest run -t 'weekday range'`.
- Full stack locally needs the Vercel CLI: `vercel link`, `vercel env pull .env.local`, `vercel dev` (:3000). The Google OAuth redirect URI must include `http://localhost:3000/api/callback`.
- Desktop app: `cd desktop && DAYBOUND_URL=https://your-app.vercel.app npm run build` (needs Rust + Tauri prerequisites). `DAYBOUND_URL` is baked in at compile time via `option_env!`.
- There is no linter and no formatter config. Style is enforced only by `strict` + `noUnusedLocals` TypeScript.

## Two TypeScript worlds

The repo compiles under two separate tsconfigs, and the difference matters on every edit:

| | `tsconfig.json` | `tsconfig.server.json` |
|---|---|---|
| covers | `src`, `test` | `api`, `server` |
| module resolution | `bundler` | `NodeNext` |
| import specifiers | **no extension** (`'./lib/dates'`) | **`.js` extension required** (`'./dates.js'`) |

`src/lib/*` is shared by both sides, so `api/`/`server/` files import it as `'../src/lib/dates.js'`. When adding an import inside `src/lib`, it must use `.js` (NodeNext needs it; the bundler tolerates it) — that's why `src/lib/*.ts` files import each other with `.js` but `src/app/*` and `src/main.ts` do not. Keep that convention; mixing it breaks `npm run typecheck`.

## Architecture

**No framework.** The web app is hand-written TypeScript rendering HTML strings into fixed container elements declared in `index.html`.

### Layers

- `src/lib/` — pure, dependency-free, shared with the server. `dates.ts` (ISO `YYYY-MM-DD` string arithmetic, no Date objects in the hot paths), `parse.ts` (the natural-language date/tag grammar — its header comment is the spec), `fuzzy.ts` (approximate substring matching for the command picker), `tasks.ts` (overdue/rollover rules, group colors, urgency ordering), `types.ts` (`Task` + `sanitizeTask`).
- `src/app/` — browser-only. `store.ts` (localStorage persistence, dirty set, undo stack, cross-tab `storage` events), `sync.ts` (the `/api/sync` loop and status), `ui.ts` (transient UI state: mode, picker selection, filter), `render.ts` (list, calendar, footer, help HTML).
- `src/main.ts` — the single controller: keyboard handling, modes, command dispatch, the live preview line. Everything the user types flows through `runCommand` → `submitAdd`/`submitPicker`.
- `api/` — Vercel functions exporting Web-standard `GET`/`POST` handlers taking `Request` and returning `Response` (no Node req/res, no framework).
- `server/` — shared backend modules: `redis.ts` (dependency-free Upstash REST client + the `K` key map), `session.ts` (HMAC-signed cookies), `google.ts` (OAuth + access-token caching), `gcal.ts` (the Calendar mirror), `http.ts` (`json`/`redirect`/`env`).

### Invariants worth knowing before changing behavior

- **`task.end` is never mutated by the rollover.** "Overdue" is derived at render time from `end < today` (`effectiveEnd`, `overdueDays` in `src/lib/tasks.ts`). Anything that persists a shifted end date is a bug.
- **Long-term (`lt`) tasks are untimed but still carry dates.** `start`/`end` hold the day they were added so the stored shape never varies and `sanitizeTask` stays strict; `isLongTerm()` is what gates behavior. Every date-derived path must check it — `effectiveEnd`, `overdueDays`, `dueLabel`, the list row, the calendar (`calendarTasks()`), and `desiredEvent()` in `server/gcal.ts` all do. Adding a new date-derived feature means adding that check.
- **Group order is fixed, not alphabetical.** `GROUP_ORDER` (aca, eca, msc, prs) comes first, then unknown groups ranked by urgency, then `lt` last; `compareGroups()` returns 0 for two unknown groups so the caller falls back to urgency. `AUTO_TAGS` is the set recognized as bare words by `tagOf()` in `parse.ts`. Those four groups also own fixed colors (`FIXED_RGB` in `tasks.ts`, mirrored to Google's palette by `GCAL_COLOR` in `gcal.ts`) instead of being hashed into `PALETTE`.
- **`groupOf()` is not just `tags[0]`.** A long-term task reports group `lt` wherever the `lt` tag sits in its list, which keeps "untimed" and "in the lt section" the same condition. Bucket and sort by `groupOf()`, never by `tags[0]`.
- **`sanitizeTask` is the only trust boundary.** Call it on every value crossing storage or the network (both directions, client and server). It returns `null` for anything invalid rather than throwing.
- **Sync is last-write-wins per task id**, keyed on the client clock `updatedAt`; `store.nextVersion()` guarantees monotonicity. Deletes are tombstones (`deleted: true`), never removals. The server cursor is a timestamp with a deliberate 30s overlap (`CURSOR_OVERLAP_MS`) so out-of-order writes are not missed.
- **The Google Calendar mirror is one-way and hash-gated.** `K.map` stores `{e: eventId, h: hash}` of what was last pushed; a pass only calls Google for tasks whose hash changed. `K.pending` holds ids awaiting a push; a Redis `SET NX` lock (`K.lock`) prevents concurrent passes, and anything skipped stays pending. A full pass runs once per day, triggered by whichever comes first: `/api/cron` (09:00 UTC, see `vercel.json`) or the first `/api/sync` of the day. Deleting the calendar in Google raises `CalendarGone`, which clears `K.cal`/`K.map` and re-pushes everything once.
- **Single-user by design.** Only `ALLOWED_EMAIL` can obtain a session; all Redis keys are global (no per-user namespacing). Pairing codes (`/api/pair`) are 8 chars from an ambiguity-free alphabet, 10-minute TTL, redeemed with `GETDEL`.
- **Dates are computed in the user's timezone**, which the client sends on every sync and the server stores at `K.tz`; the server uses `todayInTz` for the mirror.

### Desktop app

`desktop/src-tauri/src/main.rs` is a Tauri 2 shell around the deployed site with two windows: `main` (hides to tray on close) and `quick` (always-on-top, toggled by `Ctrl/Cmd+Shift+Space`, hides on blur). The quick window loads the same site with `?quick=1&shell=tauri`; `src/main.ts`'s `boot()` reads those params into `ui.quick`/`ui.shell` and adds a `quick` body class.

## Testing

`test/server.test.ts` exercises the real `api/` handlers end to end by monkey-patching `globalThis.fetch` with an in-memory Redis command interpreter and a fake Google Calendar, with env vars set at the top of the file. Adding a Redis command to `server/` means adding a case to that fake. `test/parse.test.ts` pins the date grammar against a fixed Wednesday — add cases there for any parser change.

## Notes

The README documents a GitHub Actions "Desktop app" workflow and a `.env.example`; neither exists in the repo yet. Environment variables are listed in the README's deploy section and read via `env()` in `server/http.ts`.
