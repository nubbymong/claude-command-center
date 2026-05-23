# Training-screenshot regeneration runbook

The first-run tour + help walkthrough are powered by the JPEGs in
`src/renderer/assets/training/`. They go stale every time the UI shifts.
This runbook reconciles them on both supported platforms before a stable
release.

## When to refresh

- Any release that changes UI layout (sidebars, panels, dialogs).
- After adding a new tour step in `src/renderer/training-steps.ts` --
  the script's `screenshotFilename` entries drive `npm run capture-training`.
- Missing assets (e.g. `step-codex.jpg` referenced but absent on disk)
  surface as a blank panel in the tour; the component does not crash but
  shows nothing where the screenshot should be.

## Windows host

Run from the repo root on this developer Windows machine
(`F:/CLAUDE_MULTI_APP`):

```powershell
# Quit any running CCC instance first (capture spawns its own Electron via Playwright)
npm run build
npm run capture-training
```

The script writes JPEGs to `src/renderer/assets/training/step-*.jpg`
(generic = win32-targeted variants).

## macOS host

SSH into the Mac build host and run the same commands:

```bash
ssh nicholasmoger@192.168.50.254
cd <repo path>
git fetch && git checkout beta && git pull
npm install
npm run build
npm run capture-training
```

The script writes JPEGs to `src/renderer/assets/training/step-*-mac.jpg`
(suffix added automatically via `PLATFORM_SUFFIX` in the script).

Copy the regenerated `-mac.jpg` files back to Windows and commit alongside
the win32 set so both ship in the same release.

## After capture

```bash
git status -sb
# Expect: only changes under src/renderer/assets/training/
git add src/renderer/assets/training/
git commit -m "chore(p9.4): refresh training screenshots for win32 + macOS"
```

Verify a couple by eye -- the demo data the script seeds should look right
(sanitised paths, sample model names, no real account email surfaced by the
P8.18 redaction).

## Privacy

`scripts/capture-training-screenshots.ts` `redactAccountInStatusline()`
forces `accountEmail = 'you@example.com'` and `accountColour = 'blue'`
before the capture pass, so the new statusline-account slot does NOT leak
the capturing user's real email.
