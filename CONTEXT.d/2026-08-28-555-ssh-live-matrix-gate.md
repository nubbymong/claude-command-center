## 2026-08-28 -- #555: SSH statusline live matrix codified as a standing path-triggered gate

Owner instruction after the RC9 SSH statusline work (#550): the live SSH matrix testing "needs to
be part of testing on a regular basis going forward if code blast radius touches that area."

Decision: codify it exactly like the ADR-009 adversarial gate -- path-triggered, manual, pre-merge.
It cannot be CI because it drives real SSH hosts with real credentials (`tests/live/hosts.local.json`
is gitignored for that reason).

- AGENTS.md (Release Process) gains the gate bullet: touching the blast radius
  (`pty-manager.ts` SSH branch/sentinel parsers/statusline routing, `providers/claude/ssh-shim.ts`,
  `providers/claude/ui-detection.ts`, `ssh-tmux.ts`, `ssh-tmux-stage.ts`, `ssh-tmux-push.ts`,
  `ansi-strip.ts`, `statusline-watcher.ts`) requires `npm run test:live:ssh` against real hosts,
  matrix reported in the PR before merge.
- `.claude/skills/adversarial-review/SKILL.md` gains a sibling note next to the Phase 0 path table
  (NOT a new table row -- the live matrix is not an adversarial lens; some paths trigger both gates,
  and Phase 4 verdicts now flag that).

Rationale for the gate: the RC9 root cause (ConPTY gluing escape sequences before `\r\n`, breaking
all four end-anchored sentinel parsers) shipped through a fully green unit suite -- the failure
class only reproduces against real ssh client binaries and real hosts. T7 (Windows remote) stays a
known upstream `claude` gap, reported as such, not a failure.
