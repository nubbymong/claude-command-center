## 2026-08-22 -- GPU rendering default-on + in-app glyph-corruption capture (#374)

Owner decision (2026-08-22): GPU (WebGL) terminal rendering ships **default-on**
in beta.17, and both the owner and SSBN need a way to capture the shared-atlas
glyph fault the moment it appears, for a proper debug.

### Default-on
- `DEFAULT_TERMINAL_SETTINGS.gpuRendering` is now `true`, and
  `gpuRenderingEnabled` reads `ts?.gpuRendering !== false` (on unless the user
  explicitly turned it off; absent / a corrupt non-boolean fall to ON). The
  earlier opt-in reasoning (kept off because #312's refresh-the-others repair did
  not hold) is superseded: the repair that works is already in
  (`createAtlasResync` + `atlasCoordinator`, #311 -- a victim drops its OWN
  render model first, the way a resize does, then repaints; and only the visible
  terminal holds a WebGL context, 749d78dc). Settings copy rewritten.
- The old `gpu-rendering-default` test pinned the opposite contract; rewritten to
  pin default-on and `!== false`, and proven by revert (flipping the default back
  and/or the predicate to `=== true` fails the unset/corrupt cases).

### Capture
- `atlasCoordinator` now keeps an always-on, bounded (300) event ring: every
  `clear` (a terminal rebuilt the shared atlas), `resync` (frame-pass repair),
  `catchup` (`resyncIfBehind` late repair), `miss` (a resync threw), and
  register/unregister, each stamped with the terminal's session-id label and the
  generation. `snapshot()` returns generation + per-terminal behind-ness + the
  ring. Terminals register with their session id as the label
  (`TerminalView.register(resync, sessionId)`). The source terminal is marked
  current inside `notifyCleared` so a snapshot between the clear and the frame
  does not misreport it as behind.
- `Ctrl+Alt+G` (`captureGlyphDiagnostic` shortcut) assembles the ring + app
  version + gpuRendering + GPU adapter (UNMASKED_RENDERER, best-effort) + active
  session and sends it over `diagnostics:captureGlyph`. Main writes
  `{resources}/glyph-diagnostics/glyph-<ts>.json` next to a full-window
  `.png` (via `webContents.capturePage()`), then `shell.showItemInFolder` so the
  files are ready to share. No network, no telemetry.

### Security (IPC surface -- ADR-009)
- New IPC `diagnostics:captureGlyph` (renderer -> main). The renderer is
  untrusted: the payload is size-capped (`GLYPH_DIAGNOSTIC_MAX_BYTES` = 256 KB)
  and shape-checked (`isGlyphDiagnosticPayload`) before any write, and the output
  path is built ENTIRELY in main (fixed `glyph-diagnostics` dir + timestamp
  name) -- nothing from the renderer reaches the filesystem path. Read-nothing,
  write-only to a fixed location; the handler returns `{ok:false,error}` instead
  of throwing. Adversarial pass run for this change (ADR-009).

### Verification
- `npm run typecheck` clean; full `npx vitest run` 7036 passed / 0 failed.
- New tests: `gpu-rendering-default` (rewritten), `terminal-atlas-coordinator`
  (event ring + snapshot), `glyph-diagnostic` (renderer assembly + capture),
  `shared/glyph-diagnostic` (validator), `main/diagnostics-handlers` (writes
  JSON+PNG to the fixed dir, downgrades to json-only on screenshot failure,
  rejects bad shape / oversized without writing). Verify-by-revert done on the
  default flip.
- VM proof: pending the conductor's integration pass (real WebGL, 2+ sessions).
