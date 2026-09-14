# README screenshots — the capture pipeline

The README's feature shots are **animated PNGs at 1600×1100** (hero 1280×400), the same
format as `nubbymong/rune_dsl_studio`'s marketplace shots, served from
`raw.githubusercontent.com/…/docs/screenshots/`. They are captured from the **installed
app on the test VM**, never from a dev build and never on the owner's machine.

## How it works

`shoot.js` runs *on the VM*, inside its interactive desktop session:

1. writes `window-state.json` so the app opens at exactly 1600×1100, unmaximised
   (`set-window.ps1` — UTF-8 **without** a BOM; `JSON.parse` rejects a BOM and the app
   silently falls back to defaults);
2. launches the installed exe with `--remote-debugging-port` and attaches with
   `playwright-core` over CDP (no Playwright browsers, no Electron driver — the frameless
   window *is* the viewport, so a 1600×1100 window is a 1600×1100 capture);
3. for each entry in the shot list: runs the steps (click / hover / key / type / eval),
   waits to settle, records N frames at a fixed interval, and encodes them with `upng-js`
   into one APNG under `C:/Users/user/ccc-cap/out/`.

The whole thing is driven from the host over SSH with a scheduled task created with `/it`,
which is what puts the process on the VM's real desktop (a bare SSH session has none).

## Running it

```
# once: push the runner
scp -i ~/.ssh/ccc_vm_ed25519 scripts/readme-shots/{shoot.js,set-window.ps1,run-shoot.cmd,package.json} user@<vm>:C:/Users/user/ccc-cap/
ssh … 'cd C:\Users\user\ccc-cap && npm install --no-audit --no-fund'
ssh … 'schtasks /create /tn ccc-shoot /tr "C:\Users\user\ccc-cap\run-shoot.cmd C:\Users\user\ccc-cap\shots.json" /sc once /st 23:59 /it /f'

# every capture run
scp … shots.json user@<vm>:C:/Users/user/ccc-cap/
ssh … 'taskkill /im "AI Code Conductor.exe" /f & powershell -File C:\Users\user\ccc-cap\set-window.ps1'
ssh … 'schtasks /run /tn ccc-shoot'
# then pull C:/Users/user/ccc-cap/out/*.png into docs/screenshots/
```

A shot list is JSON: `{ "shots": [ { "name", "steps": [...], "settle", "frames", "interval", "clip"? } ] }`.
Steps target elements by any Playwright selector — prefer `data-testid` and role/text.

## Staging

Good shots need a believable workspace: several sections and groups of configs, live
sessions under more than one account, real tokenomics history, a canvas with a submitted
review. Accounts must be signed in **on the VM through the app's own sign-in** — never by a
script and never with the owner's session on the host. Once signed in, the disconnected
Enhanced Session desktop keeps everything alive between captures.

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
