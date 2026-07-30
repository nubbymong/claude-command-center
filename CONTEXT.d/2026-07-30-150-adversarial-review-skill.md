## 2026-07-30 -- Adopt the adversarial-review skill as a repo-owned asset (#150)

Ported the aai-core `adversarial-review` skill into this repo and made it tracked, so
security-sensitive changes stop being self-reviewed. Decision + rationale in ADR-009.

- `.claude/skills/adversarial-review/SKILL.md` -- retargeted from the aai-core original:
  `gh` / GitHub PRs replace `glab` + `aai mr` + Jira; `beta` replaces `dev` as the base
  branch; the security-sensitive path table is rebuilt from THIS repo's `SECURITY.md`
  scope (IPC/preload, conductor-mcp-server, PTY argv, credential/keychain, updater
  verification, resources-dir path resolution, Electron webPreferences, runtime-dep
  majors) rather than the generic aai one.
- Added a **platform-parity lens** that the original does not have. #144 (zsh
  glob-expands an unquoted `--model opus[1m]`) is exactly that bug class and got through
  review because the reviewer ran Windows. A lens that asks "does this hold on the other
  two platforms" is cheap and would have caught it.
- Added the rule that **dismissing a scanner alert is itself a security decision** --
  it goes through the same attacker pass, and the dismissal cites the repro that failed.
  Prompted by CodeQL alert 6, which is a genuine false positive but was one keystroke
  away from being dismissed with no record of why.
- `adv-marker.sh` replaces `aai mr adv-marker` (no `aai` CLI here). It content-addresses
  the verdict to the post-image CONTENT of the reviewed files, not the diff text, so a
  rebase or a `CHANGELOG.md` regen carries a PASS forward while a real code change forces
  a fresh pass. Generated-file registry is deliberately CLOSED (`CONTEXT.md`,
  `CHANGELOG.md`) -- not a `docs/*.md` glob, which would let a hand-written doc slip past
  the address.
- `.gitignore`: `.claude/` -> `.claude/*` + `!.claude/skills/`. The `/*` form is required
  because git will not descend into a wholly-excluded directory, so `!.claude/skills/`
  alone would not work. Verified with `git check-ignore -v`. Personal `.claude` state
  stays ignored. Same reasoning as ADR-004 un-ignoring `AGENTS.md`.
- Phase 3.5 (embargo triage) and two Rules bullets added after the skill's FIRST run
  (#151) taught two lessons the hard way. (a) An adversarial pass is the process most
  likely to surface a PRE-EXISTING live vulnerability, and the natural place to write it
  down -- the CONTEXT.d fragment -- is a tracked file in a public repo. That near-miss
  happened and was caught only before a push; see #159 / ADR-010. (b) Two separate
  regression guards passed against the very code they were written to catch, so "revert
  the fix and watch the test fail" is now a stated rule, not an assumption.
- `AGENTS.md`: added the review-bar line under Release Process and a "Deeper references"
  pointer. Structural (a new review convention), so it qualifies under the
  README/AGENTS-on-structural-change-only rule.

Process note, recorded because it cost time: this work started in the primary
`claude-command-center` worktree while a CONCURRENT session was committing #148 there.
HEAD moved under it (fix/145 -> beta -> docs/148-changelog-beta3) and the in-flight skill
files were swept into that session's changelog commit before being reset out. Moved to a
dedicated `git worktree` (`../ccc-security`) off `beta`. Takeaway: security work gets its
own worktree, not the shared tree.

Companion tickets opened from the same review: #151 (4 open CodeQL alerts) and #152 (12
open Dependabot alerts, all transitive, 11 closable via the existing `overrides` block).
Both will be worked THROUGH this skill -- it is the first real exercise of it.
