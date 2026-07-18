## 2026-07-17 -- Boot/vision/cursor/keychain fixes (PRs #118, #121, #122)

Four field bugs fixed, each on its own branch off `beta`; all open PRs, green CI
(Win + macOS), pending owner review.

- #120 / #115 boot freeze (PR #121, branch fix/120-boot-backfill-perf): first
  paint stalled ~26s in dev. Two independent SYNCHRONOUS main-thread sweeps in
  the whenReady tail were the cause. Fix: make both async + deferred.
  - companion-dir backfill: stat-stormed the projects store -> backfill
    CompanionDirsAsync (yields every ~150 stat ops), deferred ~5s after boot.
  - update-watcher hash sweep: computeHashes() readFileSync+md5'd the whole dev
    src/ tree, twice -> computeHashesAsync (fs.promises + yields every ~50
    files); checkForUpdates now async; initial check deferred ~3s off boot.
  - Also carries the #115 vision boot-resilience commit (stacked base).

- #119 terminal cursor (PR #122, branch fix/119-terminal-cursor-visibility): no
  caret even while a shell terminal was focused/typing, on Win + macOS. Root
  cause is an xterm.js WebGL bug (issues #1194/#891): cursor options passed to
  the Terminal CONSTRUCTOR do not initialize the WebGL cursor layer. Fix:
  RE-APPLY term.options.cursorBlink/cursorStyle/cursorWidth/cursorInactiveStyle
  at runtime after the WebGL addon loads (shell sessions only). Plus cursorWidth
  1->2 (HiDPI hairline) and cursorInactiveStyle none->outline for shells; default
  cursorBlink false->true. Verified: reporter already had cursorBlink:true, so
  the default was never the cause -- it was the constructor no-op.

- #117 macOS keychain (PR #118, branch fix/117-macos-keychain-home-redirect):
  the login keychain resolves via $HOME; redirecting HOME to the fake profile
  home (no ~/Library/Keychains) broke it. Fix: redirect HOME only on Linux, not
  macOS/Windows (macOS multi-account is disabled anyway; Linux keychains are not
  HOME-path-based).

CI note: the `Test` matrix is gated on a `ci-run` PR label (ci.yml). All three
PRs carry it and are green. Merge is blocked purely by the protect-beta ruleset
requiring a @nubbymong code-owner review (self-approval not allowed).
