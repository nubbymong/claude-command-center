# 2026-08-21 — The browser as its own pane, and the "Open a page" button

Backlog item 26. Design: canvas `Commands uplift and partner browser` v3,
"A browser pane, beside the partner terminal" — approved; built against it
without a re-mock. Owner's scope call: per session, with saved favourites.

## What was wrong

The Web button did not exist until some command happened to carry a URL
(`CommandBar.hasWebviewCommand` gated it), and then sat disabled until a watch
fired. The pane had no address bar, no typed navigation, no favourites, no way
out to the real browser, and a read-only URL. And `WebviewPane` tore the
`WebContentsView` down and rebuilt it on every URL change (the lifecycle effect
was keyed on `currentUrl`), so Back never had anywhere to go.

A second, quieter fault: `probeWebviewUrls` runs on ANY command-button press and
its `markAvailable` rewrote `currentUrl` — so pressing any button while reading
a page yanked the pane back to the watched URL. With a real browser that becomes
visible immediately.

## What shipped

- **Always there.** `WebviewButton` renders for every session, reads "Browser"
  (open: "Terminal", destination naming like Canvas/Partner), is never disabled,
  and shows a status dot ONLY while a watch has something to say.
- **A start page** when nothing is loaded: address input (focused), home, the
  favourites, and a line on the other doors in. No native view is created for
  it.
- **Address bar** — `normaliseBrowserInput` in `src/shared/browser-url.ts`:
  scheme-less local/private hosts get `http://` (`localhost:5173` works),
  anything else `https://`; every other scheme refused BY NAME inline. Escape
  reverts the edit and stops at the input (the app-level Esc closes the pane).
- **History that works** — one view per pane mount; navigation goes through a
  new `webview:navigate` IPC; main reports `webview:navigated` (real URL after
  redirects, title, canGoBack/Forward, loading) from `did-navigate`,
  `did-navigate-in-page`, `did-start/stop-loading`, `page-title-updated`. The
  address bar shows where the page IS, never what was asked for.
- **Home per config** (`browser.json` → `homeByConfig`), session-scoped home in
  `webviewStore` for config-less sessions; a session with a home goes there on
  open. **Favourites** app-wide behind a star; a favourites BAR (a row that
  pushes the native view down — a dropdown would have been painted over by it).
- **Open in your real browser** — `webview:openExternal`, separate from the
  https-only `shell:openExternal` because dev servers are http; main hands the
  OS the normalised href only.
- **"Open a page"** — third command kind, stored as `kind: 'page'` + `pageUrl`
  (the two typing kinds stay derived from `target`; a page button has no
  target). Types nothing; filed in the main row with a globe glyph; no args,
  secret, watch or "where it runs". `CommandBar.handleClick` navigates and
  returns before any PTY write.
- **The watch** is now `watchUrl` + status; `markAvailable` only sets
  `currentUrl` when the pane shows nothing (`prev.currentUrl ?? url`).

## Hardening (ADR-009 pass at end of run; surfaces listed for it)

- One rule, shared: `isAllowedBrowserUrl` (http/https, ≤4096) is the zod
  refinement in `webview-handlers.ts`, the `will-navigate` AND new
  `will-redirect` guards, the window-open handler, `navigateWebview`'s last
  check, `browserStore`'s hydrate (a planted `file://` favourite or home is
  dropped), the dialog, and the bar's own gate on a hand-edited `commands.json`.
- The pane's partition session: `setPermissionRequestHandler` → deny,
  `setPermissionCheckHandler` → false, `setDevicePermissionHandler` → false.
- The renderer never hands main a raw string it did not normalise; main never
  trusts that and re-parses; the OS gets `new URL(url).href`.

## Verification

`npm run typecheck` clean. New suites: `shared/browser-url`, `stores/browserStore`,
`stores/webviewStore-browser`, `main/webview-handlers` (drives the real handlers
through a fake ipcMain), `renderer/webview-button-always-there`,
`renderer/command-dialog-page-kind`, `renderer/commandbar-page-command`,
`renderer/webview-pane-browser`. **Mutation pass 16/16**: every guard above was
broken in turn and its test went red (scratchpad `mutate.py`).

Two test expectations were wrong about the WHATWG parser, not the code, and are
recorded in the test rather than fought: a leading space is stripped (Chromium
trims the same way, so it cannot smuggle a scheme), and `https:///path` is not
host-less (special schemes collapse the slashes).

## Open / calls made

- Page buttons are FILED in the main row (`target: 'claude'`), drawn with a
  globe. A third "Browser" row for one kind felt heavier than the small lie; the
  owner can overrule.
- `webview:goHome` IPC is kept (validated, harmless) but the pane no longer uses
  it — home is resolved in the renderer.
- No per-session "history list" UI; Back/Forward carry it.
