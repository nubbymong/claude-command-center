## 2026-08-14 -- 261: dev's claude.ai web sessions no longer land in prod's store

Electron keeps `persist:` partitions under `sessionData`, which defaults to
`userData`, and nothing here redirected either. So a DEV instance wrote the
per-account claude.ai web sessions from #216 -- real `sessionKey` cookies -- into
the same `%APPDATA%\claude-conductor\Partitions` a PROD install uses. Dev and prod
shared them: signing out in dev revoked prod's session for that account, and
`ccc --clean` wiped the dev data dir while leaving a live session on disk, because
the partition was never under it. The startup sweep could not help either -- it
only walks `<dataDir>/account-web`.

`app.setPath('sessionData', <devRoot>/session)` now runs at module scope in
index.ts, next to the existing DEV data-dir block, behind a pure
`devSessionDataDir()` in data-paths.ts.

### Dev only, and that is the whole design

`userData` is Electron's own default for session data and is not wrong for prod.
Relocating prod would force a re-login for anyone who had already signed in on a
build that created a partition there. Packaged builds get null and are untouched.

That also retires the urgency this issue was filed with. The ticket argued the fix
had to land before the next beta release or users would be logged out by a later
path move -- true only if prod were relocated. It is not, so there is no migration
cliff and no deadline.

### Verified, not assumed

An attacker sub-agent probed a standalone Electron 43.2.0 rather than trusting the
premise: `session.fromPartition('persist:...').getStoragePath()` resolves under
`<sessionData>/Partitions`, and `sessionData` defaults to `userData`. The same
probe established the ordering hazard is IMPOSSIBLE rather than merely avoided --
creating a session before app-ready throws ("Session can only be received when app
is ready"), so no module-scope import can materialise the default session ahead of
the redirect.

Confirmed live: after launching from this branch, the two partitions appeared under
`dev\session\Partitions` and the shared location had zero directories touched.

### What the adversarial pass found, and what changed because of it

- A RELATIVE `CCC_DEV_DATA_DIR` half-applied the fix. `mkdirSync` created
  `<cwd>/<root>/session` -- inside the repo working tree in one observed run --
  then `app.setPath` threw into a catch and boot continued, leaving dev writing to
  prod's location exactly as before. `devSessionDataDir` now refuses a
  non-absolute root, which turns a swallowed throw into a tested branch.
- The guard was stricter than the data-dir logic it mirrors: `getDataDirectory`
  honours `CCC_E2E_DATA_DIR` unconditionally, while this returned null whenever
  packaged. An E2E run against an installed exe would have sent data to a
  disposable root while leaving the claude.ai partition in prod's `%APPDATA%`,
  surviving teardown. E2E is now honoured regardless of packaging.
- The log line used `console.log`, and the comment claimed it made isolation
  "answerable from the log". It did not: debug-logger neither patches console nor
  hooks stdout, so it never reached the debug log an operator reads, and was absent
  entirely under a bare `npm run dev`. Now `logInfo`/`logError`.
- Partitions created BEFORE this change are orphaned in the shared location and
  nothing will ever remove them. Dev now logs a one-time warning naming the path.
  Deliberately a warning and not a deletion: `ccc --seed-accounts` copies prod's
  account profiles into dev, so a partition named for a dev profile id can BE
  prod's live session, and tidying up a dev artifact must not sign the user out of
  their real account. Documented in `docs/dev-alongside-prod.md`.

### Left open, deliberately

- A dev instance that had signed in keeps its session RECORD (under the dev data
  root) while its cookies stayed behind, so the panel reads "signed in" against an
  empty partition until the next sign-in. `statusOf` derives status from the stored
  `expiresAt` alone; the store's own comment says a 401 is what should correct it.
  Dev-only, self-limiting, one re-sign-in fixes it.
- `ccc --clean` can now partially delete a live Chromium storage tree, because the
  wipe happens before the process kill and swallows errors. Narrow -- the launcher
  refuses a second dev instance on the port check -- but new exposure created by
  moving session data under the dev root.
- The `ccc.cmd` header still overstates isolation. `~/.claude` remains shared and
  `account-profiles.ts` never consults `CCC_DEV_DATA_DIR`, so dev can still contend
  with prod over OAuth refresh-token rotation. Already a documented caveat, now
  sharpened with what was actually observed on 2026-08-12, and filed separately.

### State

Gate: typecheck clean, build clean, unit suite 4162 passed across 474 files.
Verified in the desktop app.
