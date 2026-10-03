# README screenshots — the capture pipeline

The README's feature shots are **animated PNGs at 1600×1100** (hero 1280×400), the same
format as `nubbymong/rune_dsl_studio`'s marketplace shots, served from
`raw.githubusercontent.com/…/docs/screenshots/`. They are captured from the **installed
app on the test VM**, never from a dev build and never on the owner's machine.

## How it works

Everything runs *on the VM*, from a checkout with `node_modules` (`npm ci`), on one
**throwaway staging root** (`CCC_STAGE_ROOT`), never on the VM user's own app data:

1. `stage/seed.js` writes the fictional workspace (`stage/content.js`) into the root. It
   makes the root's marker file only in an absent or empty folder and refuses (exit 2,
   before writing anything) a root that is or holds the real home, sits in the real
   `~/.claude` or `~/.codex`, the app's or npm's app data folders, or the installed app's
   data folder, and any `CCC_STAGE_*` folder outside the root (`stage/stage-root.js`). The
   project folders the configs name, `C:\dev\{web,platform,data,notes}`, are made only
   when absent, marked and recorded; one that exists without its mark stops the run, and
   no file is ever overwritten. The Codex accounts go through the app's own registry code
   (`stage/codex-registry.ts`, bundled with the checkout's pinned esbuild).
2. `stage/launch.js start` starts the **installed** app on the root with the training
   tool's isolated launch environment (`scripts/capture-env.ts`): `CCC_E2E_DATA_DIR`, the
   home, `LOCALAPPDATA`/`APPDATA` and the temp folder inside the root, every PATH folder
   holding a real `claude` or `codex` removed and the fake CLIs first, Electron's
   `--user-data-dir` inside the root, a dead loopback proxy, `--remote-debugging-port`.
   It sizes the window to 1600x1100 from the main process and records the launch.
3. `shoot.js` attaches with `playwright-core` over CDP to the app that record names (it
   starts nothing itself and refuses without it) and, for each shot, runs the steps (click
   / hover / key / type / eval), waits to settle, records N frames at a fixed interval and
   encodes them with `upng-js` into one APNG under `<root>/out/`. The frameless window *is*
   the viewport, so a 1600x1100 window is a 1600x1100 capture.

## Running it

```
# on the VM, in the checkout (C:\Users\user\<build>), with the runner's playwright-core/upng-js installed once
#   (cd C:\Users\user\ccc-cap && npm install --no-audit --no-fund)
set CCC_STAGE_ROOT=C:\Users\user\p32-vm\iso-readme
node scripts\readme-shots\stage\seed.js --app-version <the build's version>
node scripts\readme-shots\stage\launch.js start          # first start: the app makes its folders
node scripts\readme-shots\stage\launch.js stop
node scripts\readme-shots\stage\seed.js --app-version <version> --reuse-backup
node scripts\readme-shots\stage\launch.js start
set NODE_PATH=C:\Users\user\ccc-cap\node_modules
node scripts\readme-shots\shoot.js scripts\readme-shots\stage\shots.json
node scripts\readme-shots\stage\launch.js stop
node scripts\readme-shots\stage\seed.js --restore        # removes the marked C:\dev project folders
# pull <root>/out/*.png for the owner's review; delete the root when done
```

A shot list is JSON: `{ "shots": [ { "name", "steps": [...], "settle", "frames", "interval", "clip"? } ] }`.
Steps target elements by any Playwright selector — prefer `data-testid` and role/text.
The first shot clicks **Resume** (the restored sessions are offered, not opened).

## Staging

Good shots need a believable workspace: several sections and groups of configs, live
sessions under more than one account, real tokenomics history, a canvas with a submitted
review. All of it is fictional and written by the seed; no real account is ever signed in,
and the fake `claude`/`codex` draw the terminals with no network.

## Why not the old capture-training script

`scripts/capture-training-screenshots.ts` launches a **dev build** via Playwright's Electron
driver at 1280×800 and writes static JPEGs into the training assets. It is the right tool for
the tour's own illustrations. The README wants the *shipped* app, animated, larger — and it
must never run on the owner's machine, which the dev-build path invites.

## Trap: ad-hoc builds and `__APP_VERSION__`

`electron-builder --config.extraMetadata.version=X` rewrites `package.json` inside the asar,
but `__APP_VERSION__` is a **build-time define** baked into the JS by electron-vite from
`package.json` at `electron-vite build` time. Build with `package.json` still at `beta.14`
and the shipped renderer believes it is beta.14 whatever the installer says — the footer,
the tour's version gates, and any app-meta seed keyed on the version all follow the baked
value. Real releases are unaffected (the release workflow bumps `package.json` first);
for a capture build, bump `package.json` before `electron-vite build`, or seed app-meta
with the version the renderer actually reports.
