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

## 2026-08-22 -- adversarial-review fixes (ADR-009) + moved to the 2.2 line

The ADR-009 pass on the rebuilt feature returned FINDINGS; all fixed here, each guard
mutation-verified (revert the mechanism -> the named test goes red):

- HIGH (main-process OOM): buildBrief took a structured transcript OBJECT straight from the
  renderer with no cumulative size bound (per-message text was unbounded), so one shape-valid
  IPC call could OOM main and kill every session. Added per-field `.max()` + an object-level
  `superRefine` capping cumulative size to MAX_TRANSCRIPT_CHARS, evaluated before generateBrief
  allocates. Schemas were extracted to `src/main/ipc/desktop-import-schemas.ts` (electron-free)
  so the boundary is unit-testable without the handler's subprocess import graph -- that
  untested seam was the root cause every attacker lens converged on.
- MAJOR (prompt-injection): the summariser prompt fenced the untrusted transcript with a FIXED
  delimiter disclosed in the prompt itself, so a hostile transcript could forge the close marker
  and break out. Now a per-invocation 128-bit random nonce in the fence; a forged static marker
  cannot match. (A live 4/4 run showed the current model already refuses the injection, but the
  boundary is now code-enforced, not model-judgment.)
- MEDIUM: the summariser denylist covered only mutating/network tools; Read/Glob/Grep and all
  MCP tools relied on plan mode alone. Added Read/Glob/Grep to the denylist and
  `--strict-mcp-config` so the operator's MCP tools never load. (An empty --allowedTools would be
  the clean deny-all but assertSafeArgv rejects an empty argv element.)
- MEDIUM: writeBrief accepted a relative workingDirectory that resolveCwd would resolve against
  the MAIN-PROCESS cwd, not the session's. Now requires absolute (or ~-anchored) at the boundary.
- LOW: no concurrency cap on the headless summariser -> a looping renderer spawns an unbounded
  claude fleet. Capped at 2 in flight.
- MINOR: buildInjectPrompt's control-char guard was ASCII C0/DEL only; extended to Unicode
  Cc/Cf/Zl/Zp (U+2028/2029/0085 line separators, U+202E bidi override). And share-link fetch now
  fails closed on a redirect (`redirect:'error'`) rather than following one with the member's
  cookies attached.

Gate: typecheck clean (3 tsconfigs), 6190 unit tests pass (the lone red, conductor-mcp-sse-
timeout, is the known load-dependent flake -- #209 does not touch conductor-mcp), changelog in
sync. A fresh re-attack against the patched code is still owed before merge.

Moved from release-2.1 to release-2.2 (#224/#209): the feature is being extended for 2.2 to reuse
#216's per-account claude.ai web session for org-scoped share import (see the follow-up below).

## 2026-08-22 -- leverage #216: org-scoped share import on the authenticated session

The share-link import fetched on a FIXED partition `persist:claude-web-import` that nothing
ever signs into -- a dead partition -- so it could only ever pull PUBLIC shares, and the UI
told users org shares were impossible ("tracked in #216"). #216 landed a per-account claude.ai
web session in `persist:claude-web-<profileId>`. This rewires the import onto it.

- `fetchText(url, partition, timeoutMs)` now takes the partition explicitly (was hardcoded).
- `importFromShareLink(url, profileId?)` runs on `webPartitionForProfile(profileId)` when an
  account is given (org-scoped share resolves as that member), else the neutral public
  partition. `partitionForImport` is the exported chooser; webPartitionForProfile's
  `^profile-[a-z0-9-]{1,64}$` guard is the sink against partition-name injection.
- IPC: `DESKTOP_IMPORT_FROM_SHARE` now takes `{url, profileId?}`, validated by
  `fromShareArgsSchema` (profileId is charset-gated). preload `fromShare(url, profileId?)`.
- Renderer: the in-session DesktopImportDialog passes `session.profileId` to DesktopImportTab,
  which forwards it to the fetch and tailors the share-tab copy (org shares now work when the
  account is signed in; the default account stays public-only). The sign-in hint now points at
  the real #216 sign-in (right-click session -> Authenticate claude.ai) instead of "not yet
  possible".

Security note: the fetch now carries the member's REAL claude.ai cookies, so the `redirect:'error'`
guard added earlier is load-bearing (tested) and profileId is strictly validated before it can
reach a partition name (tested). This grew the attack surface -> the owed re-attack MUST cover it.

DELIBERATELY NOT DONE (own follow-up ticket): a "fetch a conversation by id" capture mode via
claude.ai's private API. That is net-new, undocumented-API, ToS-adjacent surface -- not a
rewiring -- and "artifacts" support is only a viewer window (openArtifacts opens a claude.ai
tab; there is no fetch/list primitive to reuse). So the leverage here is the authenticated
PARTITION, not any artifact-fetch code.

Gate: typecheck clean (3 tsconfigs), 6196 unit tests pass, changelog in sync.
