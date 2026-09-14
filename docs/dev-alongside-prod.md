# Running DEV alongside PROD

You can run the installed **production** build and a **development** build at the
same time. Dev is fully isolated from prod — separate data directory and separate
ports — and its window is labeled so you never confuse the two.

> Rationale and the full decision record: `architecture/decisions/2026-07-17-adr-001-multi-instance-dev-prod-isolation.md`.

## TL;DR

```bat
ccc            :: launch dev (reuse existing dev data), vision on
ccc --seed     :: copy PROD's config into the dev data dir, then launch
ccc --clean    :: wipe the dev data dir first (fresh; setup wizard skipped)
ccc -nv        :: launch with the vision browser auto-launch off
```

Flags combine, e.g. `ccc --clean --seed -nv`. Keep prod running; `ccc` opens a
separate, amber-labeled **DEV** window beside it.

## The `ccc` launcher

`ccc` is on your PATH as a thin shim (`%APPDATA%\npm\ccc.cmd`) that forwards to
the versioned launcher in the repo, **`scripts/ccc.cmd`** — so the isolation /
seed / cleanup logic updates with the code.

What it does:

- Sets `CCC_DEV_DATA_DIR` so the dev build uses its own data root.
- Refuses to start a **second** dev instance (checks port 5173).
- Tees all output to a timestamped log under
  `<dev-data-dir>\dev-logs\ccc-dev-<timestamp>.log` (latest path in
  `ccc-dev-latest.txt`).
- On exit, **auto-closes the window and kills the whole dev process set** so
  nothing leaks between runs: dev electron, vite (5173), the update-server
  (9847), the MCP server (19433), the hooks gateway (19434), and the headless
  vision Chrome (matched by its `chrome-debug-9322` profile — your normal Chrome
  is never touched).

> Close the app (or Ctrl+C the window) so cleanup runs. Closing the window with
> the **X** button hard-kills the shell before cleanup can run.

## Seeding dev config

The dev data dir starts empty. To work with your real configs:

- `ccc --seed` copies prod's `CONFIG` (configs + settings) into the dev data dir.
  Sessions and transcripts stay fresh. Safe to re-run; it overwrites the dev
  `CONFIG` from prod.
- `ccc --clean` deletes the dev data dir first (a true reset), then launches into
  a wizard-skipped empty state. Combine with `--seed` for "reset, then reseed".

`--seed` reads prod's resources dir from `HKCU\Software\Claude Command Center`
(`ResourcesDirectory`), falling back to
`%LOCALAPPDATA%\Claude Command Center\resources`.

> The registry key keeps its original name on purpose — it is the pointer every
> existing install already writes to, so renaming it would orphan their data.
> Note the *default* differs by install age: a new install picks
> `%LOCALAPPDATA%\AI Code Conductor\resources`, while an upgraded one keeps the
> legacy path. Either way `--seed` reads the real value from the registry first.

## What's isolated (dev vs prod)

| Resource | Prod | Dev |
|---|---|---|
| Data root | `…\Claude Command Center\` (or registry) | `…\Claude Command Center\dev\` |
| CONFIG / sessions / transcripts / logs / profiles | under the data root | under the dev data root |
| Electron session data (cookies, localStorage, caches) and the per-account **claude.ai web session** partitions | `userData` (Electron's default) | `…\dev\session\` (#261) |
| MCP server port | 19333 | 19433 |
| Vision CDP port | 9222 | 9322 |
| Hooks gateway port | 19334 | 19434 |
| Update-server / Vite | (prod doesn't run them) | 9847 / 5173 |
| Single-instance lock | held (2nd prod focuses the 1st) | skipped (coexists with prod); 2nd dev refused by the launcher |

The dev switch activates whenever the build is **unpackaged** (`app.isPackaged
=== false`). A packaged prod build never takes the dev path.

## DEV labeling

- OS window / taskbar title: **"AI Code Conductor — DEV"**.
- Title bar: an amber **DEV** pill and an amber underline accent.

## Caveats

- CCC's own state is isolated, but the underlying **Claude CLI global home
  (`~/.claude`) is shared** between dev and prod. Avoid running the *same
  account's* Claude session in both instances at the same time — OAuth refresh
  tokens ROTATE, and this is not theoretical: observed on 2026-08-12, two profile
  homes had ended up resolving to one account, a refresh in one invalidated the
  copies in the others, and two of four accounts were left with blank
  `accessToken`/`refreshToken` values reporting `loggedIn=False`. Recovering meant
  copying prod's credentials back in (`ccc --seed-accounts`).
- First isolated dev launch is empty unless you `--seed`.
- **claude.ai web session partitions created before #261** live in the SHARED
  location (`<userData>\Partitions\claude-web-*`) and are no longer used by dev
  after the redirect. They hold live session cookies, and nothing will ever remove
  them — `ccc --clean` cannot reach them (wrong root) and the startup sweep only
  walks `<dataDir>\account-web`. Dev logs a one-time warning naming the path at
  boot. **Delete them by hand only if you are sure they are not your production
  install's**: `ccc --seed-accounts` copies prod's account profiles into dev, so a
  partition named for a dev profile id can be prod's live session. That is why the
  app warns instead of tidying up for you.
