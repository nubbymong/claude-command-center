# 2026-08-04 — App icon + animated boot splash (brand asset integration)

The owner supplied a brand asset package (app icon at 7 sizes + an animated
three.js splash authored as a 7 s web preview). Integrated on
`session/beta/fce45881-splash`, stacked on the #199 rename branch because the
splash carries the AI Code Conductor lockup.

## Icon

`build/icon.png` (1024 px). The repo shipped **no icon at all** — electron-builder
now derives the Windows .ico, mac .icns and Linux icons from buildResources
automatically. If small-size crispness disappoints, the asset package has
pre-rendered 32/48/64/128/256 px renders to hand-build a .ico from later.

## Splash — what the web preview needed to become app-shippable

The static `splash.png` (+ its extraResources entry + base64-temp-file loader in
index.ts) is replaced by `resources/splash/` packaged in the asar. Every change
traces to a real constraint:

- **No network at boot**: the preview pulled three.js from unpkg and Montserrat
  from Google Fonts. Both vendored (`three.module.min.js` r160 MIT;
  `montserrat-italic-600-latin.woff2` OFL — italic-600 is the only face used).
- **CSP has no `'unsafe-inline'` for scripts**: all logic moved to `splash.js`
  loaded as `<script type="module" src>`; three is imported by **relative path**
  because importmaps are inline-only.
- **`fetch()` does not exist on `file://` pages**: the brand SVG the animation
  parses is inlined in an inert `<script type="text/x-logo-src">` block.
- **Pace**: authored 7 s timeline plays at `SPEED = 2.4` (~2.9 s) per owner
  feedback ("7 seconds is quite a lot"). `SPLASH_MIN_MS = 3100` (was 2000), and
  the hold clock starts at the splash's *ready-to-show* (the animation starts
  ~0.3–0.9 s after window creation; stamping at create time cut the lockup on
  slow machines).
- **Fallbacks**: `<body class="nojs">` until the module runs; `.nofx` on any
  init throw (e.g. WebGL unavailable). Both show the static mark and drive the
  loading bar from CSS. Non-affiliation disclaimer preserved.
- **Window**: 720×430, opaque `#0b0e15` (Win11 native rounded corners come back
  when not `transparent`), alwaysOnTop/skipTaskbar/sandbox/contextIsolation as
  before, still no preload.

## The resolution trap (why the first VM probe saw no splash)

`app.getAppPath()` is the **js file's directory** when Electron is handed
`out/main/index.js` directly — which is how Playwright launches. An
appPath-based lookup silently missed → no splash in any Playwright run (this is
also why the old static splash never interfered with e2e). Now resolved via
`__dirname/../../resources/splash`, identical in dev, packaged asar, and direct
launches — and because that would put a splash window *first* in Playwright
runs (e2e helpers and the capture script assume first window = main), the
splash **skips when `CCC_E2E_DATA_DIR` is set**, with `CCC_FORCE_SPLASH=1` as
the probe override.

## Verified on the Hyper-V VM (never the host)

Playwright probe (`CCC_FORCE_SPLASH=1`, throwaway `CCC_E2E_DATA_DIR`):
splash window up at +319 ms with the right URL; screenshots show the AI
particle formation (+1.3 s) and the swept C-ring monogram (+2.9 s); main
closed it at +3.7 s and the fade was caught mid-flight. SwiftShader (no GPU on
the VM) renders it fine.

## Adversarial review (ADR-009 — new BrowserWindow + file:// + CSP)

Ran on PR #210 (two rounds, independent attackers; author orchestrated only).
Supply chain verified byte-identical to upstream (three.js r160, Montserrat
subset); offline claim and sandbox held. Findings fixed then re-attacked to a
clean PASS: added a strict `<meta>` CSP to the splash page (the app's
onHeadersReceived CSP does not reach a file:// document), an orphan backstop so
the splash can never hang unclosable, a `CCC_FORCE_SPLASH='0'` pin across the
Playwright launchers, a tripwire test, and third-party attribution. The pass
also surfaced one unrelated, pre-existing finding outside this change's scope;
it was routed to the maintainer privately and is deliberately recorded nowhere
public — component, mechanism and repro are embargoed until any fix ships.

## Follow-ups

- macOS: `hiddenInset` main window unaffected, but the splash is frameless
  there too — visually fine, untested on real hardware until the next Mac run.
- The changelog entry for the next beta should mention the icon + splash
  (added at release-cut time per the changelog workflow).
