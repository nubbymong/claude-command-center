## 2026-08-26 -- #535 resume orphan recovery for pruned worktree cwds

Sessions that ran in a git worktree lost their conversation on resume once the worktree was
pruned. The durable session->conversation map (#480/#488) records the worktree path as the
resume cwd; after the worktree is removed (session-guard / loop lifecycle, ADR-012 / #522)
resolveResumeLaunch stats the dead cwd, returns null (correct fail-open, added by #397/#413's
Fix 1 -- never retargets HOME), and CCC opens a fresh session. The transcript survives, orphaned
in the worktree's mangled ~/.claude/projects folder (that tree is separate from the git worktree
on disk), unreachable because no surviving cwd mangles to that folder.

Confirmed against live data: session `aai-core | INSIGHTS FU` (uuid 6070b52c...) present in the
morning session-state backup, gone after restart; its 2.9 MB transcript intact under
`...projects\C--Users-severson-aai-core--claude-worktrees-session-2026-08-26-retrofix\`; the
worktree absent from `git worktree list`. The fallback surfaced the worktree name
(`session-2026-08-26-retrofix`) as the session label.

Fix: new pure `recoverOrphanResumeLaunch(target, survivingCwd, deps)` in spawn-claude-command.ts,
wired into pty-manager's resume else-branch. When (and only when) the target cwd is MISSING, the
surviving configured cwd exists + is a dir + is not home/ancestor, and the orphan transcript
exists inside projectsRoot, it relocates `<uuid>.jsonl` into the surviving cwd's mangled folder
(keep-larger on collision, per #131/#132; rename with copy+unlink cross-device fallback) and
resumes there. Fails CLOSED to null (existing fresh fallback) on any other condition. Guards:
UUID_RE re-validation, projectsRoot containment (defense-in-depth vs a bad mangle), isHomeOrAncestor
refusal, orphan-only gate (target cwd must be gone). New per-reason drop log at the null branch.

Gate: 44/44 in tests/unit/main/spawn-resume-command.test.ts (12 new), typecheck clean (3 tsconfigs),
full unit suite 8330 pass (9 unrelated vitest worker-pool startup timeouts under local resource
contention -- flakes; the named file passes 32/32 in isolation; CI is the real gate).

Related still-open follow-ups: #536 (sync CCC session name into the JSONL/session), and #397
Phases 4-5. Refs #480 #397 #131 #522.
