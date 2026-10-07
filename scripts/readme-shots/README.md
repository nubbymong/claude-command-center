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
   starts nothing itself and refuses without it) and, for each shot, runs the steps (see
   below), waits to settle, records N frames at a fixed interval and encodes them with
   `upng-js` into one APNG under `<root>/out/` (one frame is a plain PNG; `"format": "jpeg"`
   writes one `<name>.jpg` instead). The frameless window *is* the viewport, so a 1600x1100
   window is a 1600x1100 capture. Frames are taken in CSS pixels, so the desktop's scaling
   does not change their size.

## Running it

Everything below runs on the VM: the app is started from the VM user's interactive
session (a scheduled task with `/it` that runs `launch.js start` and `shoot.js`), never on
the operator's machine.

```
# on the VM, in the checkout (<checkout>), with the runner's playwright-core/upng-js installed once
#   (cd <runner> && npm install --no-audit --no-fund)
set CCC_STAGE_ROOT=<root>
set CCC_SHOTS_DENYLIST=<a file outside the checkout>   # see "The anonymisation scan"
node scripts\readme-shots\stage\seed.js --app-version <the build's version>
node scripts\readme-shots\stage\launch.js start          # first start: the app makes its folders
node scripts\readme-shots\stage\launch.js stop
node scripts\readme-shots\stage\seed.js --app-version <version> --reuse-backup
node scripts\readme-shots\stage\launch.js start
set NODE_PATH=<runner>\node_modules
node scripts\readme-shots\shoot.js scripts\readme-shots\stage\shots.json
node scripts\readme-shots\stage\launch.js stop
# the Feature Guide images and the README hero: a fresh re-seed, then a 1280x800 window
node scripts\readme-shots\stage\seed.js --app-version <version> --reuse-backup
node scripts\readme-shots\stage\launch.js start --size 1280x800
node scripts\readme-shots\shoot.js scripts\readme-shots\stage\guide-images.json
node scripts\readme-shots\stage\launch.js stop
node scripts\readme-shots\stage\seed.js --restore        # removes the marked C:\dev project folders
# pull <root>/out/* for the owner's review; delete the root when done
```

The lists:

- `stage/shots.json`: the README feature shots, 1600x1100 APNGs (`shot-sessions`,
  `shot-canvas`, `shot-tokenomics`, `shot-logs`, `shot-insights`, and two alternates).
- `stage/guide-images.json`: the Feature Guide images in `src/renderer/assets/training/`
  (1280x800 JPEG, quality 85) and the README hero (`hero-banner`, the top 1280x400 of the
  same window, one frame).

A shot list is JSON: `{ "shots": [ { "name", "steps": [...], "settle", "frames", "interval", "clip"?, "format"?, "quality"? } ] }`.
Steps target elements by any Playwright selector — prefer `data-testid` and role/text.
The first shot clicks **Resume** (the restored sessions are offered, not opened).
A step's keys run in this order:

| Key | Does |
| --- | --- |
| `click`, `hover` | a selector |
| `move` | `[x, y]`: park the mouse, so no tooltip or hover state stays in a frame |
| `key`, `type` | keyboard |
| `select` | `{ "testid", "match" }`: picks the option of that `<select>` whose value or text contains `match` |
| `editConfig` | a config's label: opens its Edit dialog from its row on the Saved tab |
| `scrollTo` | a label's text: scrolls it to the middle of its scroller |
| `closeDialog` | closes the open dialog with its own Discard, Cancel or Close |
| `waitVisionConnected` | ms: waits for the Conductor MCP page's browser to read Connected |
| `wait`, `eval` | ms; an expression run in the page |
| `evalLog`, `dump` | tools for writing a list: log an expression's result; log the page's buttons, selects and headings |
| `scan` | a label: the anonymisation scan below |

A step that cannot do what it names throws: the shot is logged as `SHOT FAILED` and written
as `<name>.FAILED.png`, never as a normal-looking image.

## The anonymisation scan

Every image leaves the machine, so every shot in the lists ends with a `scan` step: the
page's visible text, its titles, placeholders, aria labels, field values and same-origin
frames are searched, and any hit fails the shot. It cannot read what is drawn rather than
held in the DOM: terminals, other `<canvas>` drawings, and frames of another origin (the
Agent Canvas page). Each scan logs those as NOT SCANNED with a count, so a clean scan never
means they were checked: their text comes from the fictional workspace and the fake CLIs,
and they are checked by eye. The patterns in the repo
(`stage/scan-text.js`) are generic only: a user-folder path on a drive, a `/home/` path, an
IPv4 address, a host on `.internal` / `.local` / `.lan` / `.corp`, and any e-mail address
outside the fictional `example.dev` / `example.io` / `example.co`.

Private names (people, companies, machines) are never written in the repo. They come from
a deny list the operator keeps outside the checkout, named by `CCC_SHOTS_DENYLIST` (there is
no default): one literal term per line, matched case-insensitively, `#` comments allowed,
reported in the log by number only. A list with `scan` steps refuses to start (exit 2) when
the variable is unset or its file is missing, empty or inside the checkout.

## Staging

Good shots need a believable workspace: several sections and groups of configs, live
sessions under more than one account, real tokenomics history, a canvas with a submitted
review. All of it is fictional and written by the seed; no real account is ever signed in,
and the fake `claude`/`codex` draw the terminals with no network.

The app itself is not network-isolated: the dead proxy reaches the processes it starts, but
on Windows its Electron and its Vision browser (started at boot) follow the system's proxy
settings, so their own background requests are not stopped. Nothing shown depends on them.

## Why not the old capture-training script

`scripts/capture-training-screenshots.ts` launches a **dev build** via Playwright's Electron
driver at 1280×800 and writes static JPEGs into the training assets. The images it names are
now also made here, from the *installed* app on the VM (`guide-images.json`, same size and
JPEG quality): a dev build launched by that script runs wherever it is started, and these
images must come from the shipped app and never from the owner's machine. The README wants
the same shipped app, animated, larger.

## Trap: ad-hoc builds and `__APP_VERSION__`

`electron-builder --config.extraMetadata.version=X` rewrites `package.json` inside the asar,
but `__APP_VERSION__` is a **build-time define** baked into the JS by electron-vite from
`package.json` at `electron-vite build` time. Build with `package.json` still at `beta.14`
and the shipped renderer believes it is beta.14 whatever the installer says — the footer,
the tour's version gates, and any app-meta seed keyed on the version all follow the baked
value. Real releases are unaffected (the release workflow bumps `package.json` first);
for a capture build, bump `package.json` before `electron-vite build`, or seed app-meta
with the version the renderer actually reports.
