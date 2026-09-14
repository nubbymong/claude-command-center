## 2026-08-15 -- Agent Canvas P2 + P3 land on beta, and the two tests that were quietly not checking anything

The canvas work had been sitting unmerged on `session/feat/agent-canvas-p3/69ff86ca`
for two days while beta moved on underneath it (54 ahead, 20 behind by the time it
was picked up). This lands it: P2 (the security-hardening pass, the
`canvas_snapshot` / `canvas_render` MCP tools, and the bundled read-only in-page
bridge) plus P3 (the review loop -- empty state, notes panel, review store,
focus / marquee / annotation UI, the `canvas_review` tool, and the mode strip).

The merge itself was mechanical: zero conflicts, and the resulting tree matched the
`merge-tree --write-tree` prediction exactly (`d975c822`). Everything below is what
the *verification* turned up, which is the part worth recording.

### The install is load-bearing, not a formality

P2 added a vitest plugin (`vitest.config.ts` -> `canvasBridgePlugin()`) that
esbuild-bundles the in-page bridge -- axe-core included -- on every vitest run, and
resolves `virtual:canvas-bridge` for the real build too. Against a stale
`node_modules` the whole suite fails, not just the canvas files. A fresh
`npm ci --ignore-scripts` plus `node node_modules/electron/install.js` is the
recipe; the postinstall `electron-rebuild` is not needed, since node-pty and
better-sqlite3 both ship loadable N-API prebuilds.

Confirmed the plugin actually resolved rather than silently emitting an empty
string: the built `out/main/index.js` carries the axe-core marker and all three
canvas tool names.

### `conductor-mcp-page.test.ts` asserted three cards while the page rendered four

P3 added the Agent Canvas card to `ConductorMcpPage`, and shipped
`conductor-mcp-canvas-card.test.tsx` alongside it -- but that test renders
`AgentCanvasSubTool` in isolation. Nothing checked that the page *mounts* it. The
page test still said "renders all three sub-tool cards" and listed Vision, Codex
review, Host transfer; because it uses `toContain` rather than a count, it stayed
green with a fourth card present and would have stayed green with the card removed.

Corrected to four, with the Agent Canvas assertion added. Proved it can fail:
replacing `<AgentCanvasSubTool />` with a comment turns it red on that exact line.
The comment now says why this file, not the isolated one, is where the card is
pinned to the page.

### The canvas frame-security e2e gate had never once passed

`tests/e2e/agent-canvas-frame-security.spec.ts` is the live half of the P1
acceptance gate (spec 3.2) -- no Node, no IPC, no preload globals in the content
frame, serve-time bridge present, `connect-src` confinement, cross-origin
isolation. It has been red since it was written, on beta as well as here, and the
reason is a harness bug rather than anything about the product: `page.frame()` is a
snapshot lookup, not a waiter, so asking for the child frame in the same tick the
`<iframe>` is appended always returns `null`. The first test failed on that, and
because Playwright restarts the worker after a failure, the shared `frameUrl` reset
to `''` and the remaining four died on "Either name or url matcher should be
specified" -- four security assertions that had never executed at all.

Replaced with a `canvasFrame()` helper that polls until the frame has attached
*and* navigated. All five now pass against a real build of the merged code.

They are not vacuous: adding `https://example.com` to the served `connect-src` and
rebuilding turns the confinement test red, so the assertion is genuinely
attributable to the CSP header the protocol handler emits and not to a dead
network. (The spec already guarded against that second failure mode by capturing
the actual `securitypolicyviolation` events.)

### Verification

- `npm run typecheck` clean -- all three projects, including the `tsconfig.bridge.json`
  pass P2 added. Note `npx tsc --noEmit` still checks nothing here (root tsconfig is
  `{"files": []}`).
- Full `npx vitest run`: **4752 passed / 13 skipped**, 515 files. Measured beta at the
  same commit for comparison rather than trusting a remembered number: **4220 passed /
  13 skipped**, 479 files. The +532 accounts exactly -- 523 from the 36 new canvas test
  files, and +9 net from the four canvas test files P3 modified. No test was deleted and
  the skip count is unchanged.
- `npm run build` clean (only the pre-existing `"use client"` directive warnings).
- Playwright: **42 passed / 12 failed / 3 skipped**. Beta at the same commit is
  **37 passed / 17 failed / 3 skipped** with a byte-identical failure set, so the merge
  introduces no e2e regression; the delta is the five canvas tests above going green.
  The remaining 12 (cloud-agents, github-oauth-ui, github-panel, navigation, views,
  session-dialog) fail identically on beta and are untouched here -- pre-existing, and
  deliberately out of scope for a merge branch.

### Not ready for a public beta

This is landed on beta as a branch/PR, not released. Two gates are outstanding.

ADR-009 applies -- the change touches the Conductor MCP server, IPC, and PTY spawn --
so an adversarial-review pass is owed before merge is recommended. Separately, the
deferred security batch agreed for the canvas phases has not run yet, and one item in
it is a scope question rather than a defect: `pty:spawn` now registers a local
session's working directory as a canvas UAT root, which widens what the canvas will
serve. That is deliberate, but it has not been signed off, and it should be before any
of this reaches a public channel.

Four UX items also remain open on the branch and are being handled separately: the
content iframe is `bg-white` inside a dark app, the version label reads
`v3 - design`, the version picker lists raw ids, and a failed render or a dead bridge
shows "Loading content..." forever instead of an error state.
