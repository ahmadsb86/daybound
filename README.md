# Daybound

A keyboard-first planner where every task owns a range of days. You type one line, it figures out the group and the dates, and the task shows up in a grouped list and on a calendar. Tasks never close on their own: when their days run out they roll forward one day at a time, marked in red, until you resolve them.

It runs as a website on Vercel (phone, laptop, anything with a browser), installs to your phone's home screen, works offline, mirrors every task to Google Calendar as an all-day event, and comes with a desktop app that adds a global quick-add hotkey.

## Using it

Everything happens in the input box. Press `?` in the app for the full reference.

| Type | Result |
| --- | --- |
| `essay draft #school fri` | Today through Friday, in the school group |
| `call ammi on sun` | Sunday only |
| `problem set #school mon to fri` or `mon-fri` | A range. If this week's range already ended, it means next week |
| `today`, `tom`, `next mon`, `nov 12`, `11/12`, `12th` | Single dates (month first). A lone date means "from today through then" |
| `in 3d`, `in 2 weeks`, `this week`, `next week`, `weekend` | Relative dates and whole periods |
| `\sat` or `"SAT prep"` | Keep a word as text. ALL CAPS words are never read as dates |

A task without dates is refused. The first `#tag` is the group; extra tags just ride along. The line under the input shows exactly what will be created before you press Enter.

| Command | What it does |
| --- | --- |
| `res` name | Resolve. Matches from the middle of a name and forgives a typo. Stays in resolve mode so you can clear several in a row |
| `del` name | Delete without resolving |
| `mv` name `thu to sat` | Reschedule |
| `ren` name `>` new name `#tag` | Rename and optionally regroup |
| `/`text, `/#school` | Filter the list and calendar |
| `done`, `reopen` name | See resolved tasks, bring one back |
| `u` | Undo the last change |
| `login`, `logout`, `sync`, `pair` | Syncing between devices |

Keys: `↑` `↓` or `Tab` pick a match, `Enter` runs, `Esc` backs out one step at a time, `Tab` completes a tag, `↑` recalls earlier lines, `[` `]` and `PgUp` `PgDn` move the calendar, `Ctrl+Z` undoes when the input is empty. On a phone you can tap a task to jump straight into resolving it.

## Deploying

You need a GitHub account, a Vercel account and a Google account. Budget about 20 minutes, most of it in Google Cloud.

### 1. Put the code on Vercel

1. Push this folder to a new GitHub repository.
2. In Vercel, choose **Add New > Project** and import the repository. It detects Vite on its own. Deploy once; it will work in local-only mode until the next steps are done.
3. Note the address Vercel gives you, like `https://daybound-abc.vercel.app`. That's your `APP_URL`.

### 2. Add the database

In the Vercel project, open **Storage**, add **Upstash for Redis** from the Marketplace (the free plan is plenty), and connect it to the project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.

### 3. Set up Google sign-in and Calendar

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (any name).
2. **APIs & Services > Library**: enable **Google Calendar API**.
3. **Google Auth Platform** (called "OAuth consent screen" in older menus):
   - **Branding**: app name Daybound, your email as support and developer contact.
   - **Audience**: user type **External**. Then click **Publish app** so the status reads **In production**. This matters: while an app is in "Testing", Google expires its refresh tokens every 7 days and the calendar mirror would silently stop. You don't need Google's verification for a personal app; you'll just see an "unverified app" screen once when you sign in.
   - **Data access**: add the scopes `openid`, `.../auth/userinfo.email` and `.../auth/calendar.app.created`. The last one only lets Daybound create its own calendar and manage events on it. It can't see or change your other calendars.
4. **Clients > Create client**: type **Web application**. Under **Authorized redirect URIs** add `https://YOUR-APP.vercel.app/api/callback` (and `http://localhost:3000/api/callback` if you'll use `vercel dev`). Copy the client ID and secret.

### 4. Environment variables

In Vercel, **Settings > Environment Variables**, add these (see `.env.example`):

| Name | Value |
| --- | --- |
| `APP_URL` | Your Vercel address, no trailing slash |
| `ALLOWED_EMAIL` | The one Google account allowed to sign in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From step 3 |
| `SESSION_SECRET` | A long random string, e.g. the output of `openssl rand -base64 48` |
| `CRON_SECRET` | Any random string |

Redeploy (Deployments > ⋯ > Redeploy) so the functions pick them up.

### 5. Sign in

Open the site, type `login`, and pick your account. On the "Google hasn't verified this app" screen choose **Advanced > Go to Daybound**. It's your own app. Allow calendar access. A calendar named **Daybound** appears in Google Calendar within a few seconds of your next change.

On your phone, open the same address and use **Add to Home Screen** (Safari's share menu, or Chrome's menu). Type `login` there too.

## Desktop app

The desktop app is a window onto your deployed site plus things a website can't do:

- **Ctrl+Shift+Space** (Cmd+Shift+Space on a Mac) opens a small quick-add box from anywhere. Type a task and press Enter, and it disappears again. Every command works there too, so `res` from anywhere is two keystrokes away.
- Closing the window hides it in the tray or menu bar. The tray menu has **Launch at login**.

### Building it with GitHub Actions (easiest)

1. In your GitHub repository, **Settings > Secrets and variables > Actions > Variables**, add `DAYBOUND_URL` set to your Vercel address.
2. **Actions > Desktop app > Run workflow**.
3. When it finishes, open **Releases**: there's a draft release with a Windows installer and a macOS `.dmg`.

The installers aren't code-signed, so the first launch needs one extra click. On Windows, SmartScreen shows **More info > Run anyway**. On a Mac, right-click the app and choose **Open**, or run `xattr -cr /Applications/Daybound.app` once.

### Building it yourself

Install [Rust](https://rustup.rs) and Node 20+, plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Then:

```sh
cd desktop
npm install
DAYBOUND_URL=https://your-app.vercel.app npm run build      # macOS / Linux
$env:DAYBOUND_URL="https://your-app.vercel.app"; npm run build   # Windows PowerShell
```

The installer lands in `desktop/src-tauri/target/release/bundle/`.

### Signing in on the desktop

Type `login`. If Google refuses with "This browser or app may not be secure" (it sometimes does inside app windows), use pairing instead: on any signed-in device type `pair`, and you get a code like `KXR4-9QMT`. In the desktop app type `pair KXR4-9QMT` within 10 minutes.

## Local development

```sh
npm install
npm run dev      # the app at http://localhost:5173, local-only (no sync)
npm test         # parser, fuzzy matching, and the API against a fake Redis and Google
```

For the full stack, install the Vercel CLI, run `vercel link` and `vercel env pull .env.local`, then `vercel dev` (serves on port 3000).

`npm run build:demo` makes a sync-free build in `dist-demo/` if you just want to try the interface somewhere.

## How it works

- **Tasks** have a title, tags, a start and an end date. The end date you planned is never changed by the rollover; "overdue" is computed from it every time it's shown, so the list can say "3d over" and the calendar can draw the planned days normally and the overdue days hatched.
- **Each device** keeps everything in local storage and works offline. Changes sync to Redis through `/api/sync`, newest edit wins per task, and deletes travel as tombstones so they reach every device.
- **Google Calendar** is a one-way mirror. Every open task is an all-day event on the Daybound calendar, marked free so it doesn't block your schedule, colored by group, with no notifications. Overdue events stretch to today and get a ⚠ and a "(3d over)" suffix. Resolving or deleting a task removes its event. Edits you make in Google Calendar are overwritten on the task's next change.
- **Rolling overdue events forward** happens in a full pass once a day: from the Vercel cron at 09:00 UTC (early morning in the US), or from the first sync of the day on any device, whichever comes first. If you delete the Daybound calendar in Google, the next full pass recreates it.
- **Sign-in** is a signed, HTTP-only cookie that lasts a year. Only `ALLOWED_EMAIL` can get one.

## Files

```
src/          the web app (TypeScript, no framework)
  lib/        date parsing, fuzzy matching, task rules (shared with the server)
  app/        local store, sync, rendering
api/          Vercel functions: login, callback, logout, sync, pair, cron
server/       Redis client, sessions, Google OAuth, Calendar mirror
public/       service worker, manifest, icons
desktop/      Tauri desktop app
test/         vitest suites
```
