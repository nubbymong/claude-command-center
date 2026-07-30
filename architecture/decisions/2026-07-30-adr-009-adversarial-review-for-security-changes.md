# ADR-009: Security-sensitive changes require an independent adversarial-review pass

- **Status:** Accepted (2026-07-30)
- **Deciders:** @nubbymong (owner)
- **Related:** #150, CONTEXT.d/2026-07-30-150-adversarial-review-skill.md, SECURITY.md, ADR-004 (the same un-ignore reasoning applied to `AGENTS.md`), #116 (contributor/agent workflow)

## Context

`SECURITY.md` names six things as in-scope for this project's threat model:
credential storage and encryption, IPC message handling between main and
renderer, PTY input/command injection, MCP server access control, SSH credential
handling, and local file access outside intended directories. Every one of those
is a **boundary** — code whose entire value is that it holds under hostile input.

The review process that guards them is the same one that guards a Tailwind class
change: the author reads their own diff, CI runs typecheck and tests, an owner
approves. That is self-review of a security boundary, and it fails in a specific,
predictable way — an author cannot find the case they were blind to when they
wrote the code, because the blindness is the bug. Tests have the same problem:
they encode the cases the author thought of.

The evidence is already in the repo's own history. #144 (`--model opus[1m]` is
glob-expanded by zsh) survived review by a Windows author for whom the input was
inert. That is not carelessness; it is the structural limit of single-perspective
review. Nothing in the current process would have caught it.

Meanwhile CodeQL and Dependabot generate alerts (16 open as of this ADR) whose
*dismissal* is also a security decision, taken today with no review at all — a
false-positive call is one keystroke and leaves no cited reasoning behind.

The aai-core framework already solves this with an `adversarial-review` skill,
but it is written against `glab` / `aai mr` / Jira and a GitLab MR lifecycle.

## Decision

**Adopt a repo-owned `adversarial-review` agent skill, and require a passing
adversarial pass before any security-sensitive change is recommended for merge.**

1. **The skill lives in the repo, tracked.** `.claude/skills/adversarial-review/`.
   `.gitignore` changes `.claude/` to `.claude/*` plus `!.claude/skills/` — git
   will not descend into a wholly-excluded directory, so the negation requires
   the `/*` form. Personal `.claude` state (`settings.local.json`, session state,
   caches) stays ignored. This is the same call ADR-004 made for `AGENTS.md`: a
   file that defines shared process belongs to the repo, not to one workstation.

2. **Independent attackers, not a re-read.** The orchestrator dispatches parallel
   sub-agents, each with a distinct lens — injection/evasion, allowlist bypass,
   blast-radius, design+coverage, and **platform parity** (Windows / macOS /
   Linux; added specifically because of #144). Diversity of perspective is the
   mechanism; a single more-careful reader is not a substitute.

3. **The author is never an attacker.** If you wrote it, you orchestrate. This is
   the rule the whole ADR exists to enforce.

4. **Empirical over assertion.** An attacker runs the code and shows a repro.
   "Looks fine" is not a finding and is sent back.

5. **A closed, written classification rule.** The skill carries a path table
   (IPC/preload, the Conductor MCP server, PTY argv construction, credential and
   keychain code, the updater's installer-verification path, path resolution
   across the resources dir, Electron `webPreferences`/CSP, and **runtime**
   dependency major bumps). Docs/styling/changelog-only changes are explicitly
   exempt. Unsure means required — fail closed.

6. **Dismissing a scanner alert is a reviewed security decision.** A CodeQL or
   Dependabot false-positive call goes through the same pass, and the dismissal
   comment cites the repro that failed to work.

7. **The verdict is content-addressed.** `adv-marker.sh` hashes the post-image
   content of every reviewed non-generated changed file, not the diff text. A
   rebase, or a regeneration of `CONTEXT.md` / `CHANGELOG.md`, leaves the address
   unchanged and the PASS carries forward; any real content change to a reviewed
   file forces a fresh pass. This is what makes the requirement affordable —
   re-review is triggered by actual change, not by branch churn.

8. **Bounded when unattended, never lowered.** An interactive caller loops
   fix -> re-attack until clean. An unattended caller is capped at two rounds and
   then *quarantines* — FINDINGS stands, the branch stays unmerged. The bound is
   on the rounds, never on the bar.

9. **The human still approves and merges.** The pass is a first-pass filter, not
   an authority. It composes with — does not replace — owner review and CI.

## Consequences

**Positive.** Security-boundary changes get a perspective the author structurally
cannot supply. Alert dismissals leave cited reasoning behind instead of a
keystroke. The classification rule is written down, so "is this security-
sensitive?" stops being decided ad hoc per PR. The skill is versioned with the
code it guards, so a new contributor or a fresh clone inherits the bar.

**Negative.** A security-sensitive PR costs more wall-clock and more tokens.
There is a real risk the pass degrades into theatre if attackers are allowed to
report impressions instead of repros — rule 4 is the only thing standing against
that, and it has to be enforced by whoever reads the verdict.

**Rejected alternative — rely on CodeQL and Dependabot alone.** Scanners find
pattern-matchable defects. They cannot reason about whether an allowlist is
complete, whether a defense holds on a platform the author does not run, or
whether a change fails open. Alert 6 in the current backlog (SHA-256 of an email
mapped to a UI colour, flagged as insecure password hashing) shows the inverse
failure too: a scanner cannot tell a secret from an email address. Both
directions need judgment applied adversarially.

**Rejected alternative — a review checklist in CONTRIBUTING.md.** A checklist is
read by the same author with the same blind spot. It changes what they look for,
not who is looking.
