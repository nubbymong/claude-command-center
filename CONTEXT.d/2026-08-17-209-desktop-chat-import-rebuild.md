## 2026-08-17 -- #209 desktop-chat import rebuilt on beta.15 (reused Ask-Conductor priming)

PR #224 (feat/209) had drifted 316 commits behind beta and could not be rebased as a
conflict resolution: three landed features overlapped its exact surfaces --
#216 (per-account claude.ai web session, same context menu + same onConfirm 4th param),
the SessionDialog rewrite (beta.6), and "Ask Conductor" (an opening-prompt mechanism using
the SAME session-priming path #209 needed, plus a security fix to the launch-command binary
quoting in the exact lines #209 had rewritten).

So it was rebuilt on beta rather than merged. Approach: reset the branch to origin/beta,
bring back only the self-contained feature files, and drop #209's parallel launch plumbing
in favour of beta's existing opening-prompt machinery.

KEPT (new files, unchanged): the transcript parser, brief builder (headless-claude + a
deterministic fallback), brief-file writer (traversal-guarded, writes
.claude/imports/desktop-chat-*.md), share-link fetch, the IPC handlers (every input
zod-validated, result-envelope returns), DesktopImportTab and DesktopImportDialog, and the
shared types.

DROPPED (the "Part C" parallel path): importBriefPath / importBriefRelPath threaded through
spawnOptionsSchema -> pty-manager -> spawn-claude-command as a LITERAL positional prompt on
the launch line, plus its forced --permission-mode plan and the useLaunchConfig / SessionDialog
launchExtras plumbing. This is the security-sensitive surface, and taking beta verbatim there
means the reintegration adds ZERO changes to the shell-command builder -- beta's Ask-Conductor
quoting fix stands untouched.

BRIDGE: priming now rides beta's opening-prompt route. In-session import (the primary path)
writes the brief and types buildInjectPrompt(absolutePath) into the live PTY WITHOUT a
trailing newline -- the operator reads it and presses Enter, which preserves #209's
human-gate intent without needing forced plan mode.

WIRING (additive only, no security-sink touched): ipc-channels DESKTOP_IMPORT_*,
registerDesktopImportHandlers in index.ts, the desktopImport preload bridge + electron.d.ts
types, an "Import Claude Desktop chat..." item in SessionContextMenu, and the
DesktopImportDialog mount + gating in Sidebar (local, non-shell, claude sessions only).

DELIBERATELY NOT DONE: the NEW-SESSION entry point (create a fresh session already primed
with the brief). #209 did this through the old SessionDialog's import tab, which no longer
exists after the rewrite; under the reuse-Ask-Conductor design it becomes a small standalone
addition (open DesktopImportTab, then addSession with askPrompt set) and is left to a scoped
follow-up rather than bolted into the rewritten dialog blind. DesktopImportTab already carries
a target='new-session' mode for it. Tracked for follow-up.

Also dropped the desktop-import-launch-command.test.ts (it tested the removed Part C literal
launch path) and pruned the buildImportPrompt / IMPORT_BRIEF_REL_RE cases from
desktop-import-brief-file.test.ts for the same reason.

Gate: typecheck clean (3 tsconfigs), 6180 unit tests pass (the lone red, conductor-mcp-sse-
timeout, is a load-dependent flake -- passes in isolation in <1s, and #209 does not touch
conductor-mcp), changelog in sync, via a real per-worktree npm ci on beta.15. Not yet
desktop-tested -- that remains the merge gate (now the desktop-tested label, #309).
