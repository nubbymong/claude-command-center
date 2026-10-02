## 2026-10-02 -- WP2 PR 3 (#626): the Codex sessions remainder (P3.1 to P3.16)

**What.** PR 3, stacked on #625, builds the 35 rows of the 2.1.1 parity plan
that make a Codex session work as a Claude session does
(`docs/wp2/completion-plan.md`, section 8; rows in section 4):

- P3.1: capability evidence on the supported CLIs (0.153.4 and 0.155.1) in
  `docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`.
- P3.2, P3.3: one account row for both providers with the identity editor
  behind its chip (name, colour, group, Link and Unlink), a running count,
  refusals that name each session with Go to, Archived with Restore; Sign in
  again on a signed-in Codex account, staged in a new folder with its
  conversations carried over, the old sign-in kept until removing it is proven
  safe.
- P3.4: each provider's status pills only while it is on (an OpenAI pill for
  Codex) and no Claude prompts with Claude Code off.
- P3.5, P3.6: a Codex session keeps its conversation (exact resume on
  relaunch, Restart resumes, the picker across worktrees with names) and
  Switch Account carries it into another Codex account.
- P3.7 to P3.9: Lines changed and Duration on the strip; models and efforts
  from the supported CLIs' catalogue in the model registry, prices from the
  LiteLLM fetch, Compact, Plan mode and the live model pill typed only at
  Codex's ready prompt; Sentinel for Codex.
- P3.10, P3.11: Codex hooks to the Hooks gateway (attention dot, rules), the
  busy sweep and moon, the Watchdog for Codex; Extra CLI arguments with a
  refusal rule.
- P3.12 to P3.15: Logs, search and GitHub context for Codex; Multi Spawn and
  Quick Start held in main; the Codex credits row (ADR-023); the terminal
  checks (the bundled ConPTY for scrollback, Alt+V, channel rules).
- P3.16a: pre-existing bugs queued during the PR (U1 to U7, M1 to M9 and
  their rounds), each fix red first with mutation proof, including Claude's
  resume continuing from what was indexed (M1) and the projects folder named
  as Claude Code names it (Q1, F6); M6 was already fixed by P3.10, and M9
  waits on an owner decision.
- P3.16b: the user-facing sweep (What's New and CHANGELOG.md, app knowledge
  with three new known issues, tips, the guide cards, Hello Codex's table, the
  user guide, PRIVACY.md, one README line), pinned by
  `tests/unit/shared/app-knowledge.test.ts` ("the PR 3 user-facing sweep").

**Why this way.** The parity rule (OD26 P1): where Claude's behaviour carries
over, it is the spec. Where it cannot, the built default stands and the owner
is asked (section 10: rows 22, 41 and 63).

**Shipping with workarounds (app knowledge, Known issues).** Codex's own lock
screen on a second tab of a conversation (0.155.1); a Windows Claude config
whose working folder is not spelled as on disk; vision in one copy run from
source at a time; a Codex tab kept open by a background command; Codex's Windows
sandbox setup; a Codex name dropping out of the picker; Codex's one-time
hooks review.

**Owed before #626 leaves draft** (section 6): the VM run at the final head
(gate 6), the owner's screenshot review, the PR-level ADR-009 pass, the SSH
live matrix (pty-manager.ts changed), CI. Findings about pre-existing
behaviour raised by the adversarial passes were routed privately.
