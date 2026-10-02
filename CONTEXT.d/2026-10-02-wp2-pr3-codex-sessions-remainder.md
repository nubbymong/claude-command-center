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

**Done for the package** (section 6): the PR-level ADR-009 pass, PASS at
525a00ac (its round 1 major fixed; P3.9 and P3.12, quarantined after their
own bounded rounds, covered); the VM checks at PR 3's earlier heads
b3937173 and 1e14b611, where the listed checks (section 8, P3.16) PASS at
b3937173 and the run found D1 to D3, re-checked PASS at 1e14b611 (fixer 8;
fixer 8b unit-tested there); gate 6 on the VM (WINDOWS_1) at 525a00ac on
2026-10-02 (P3.16): the e2e suite, 81 of 81 tests in 22 spec files, the
real home's assistant folders untouched, and the row checks on a packaged
build with the real CLIs 0.155.1 and 0.153.4 (a loopback fake model,
fictional accounts, nothing signed in), every one PASS but row 36's
Duration after a cleared session file (FAIL: the running time kept in the
app lived only in that file; a parity gap, fixed in fixer 9), with row
38's midnight UTC check not run (time-bound), the popover's left-edge
clamp not reachable there, and the checks only the owner can run listed
there; and gate 3's owed reviews: every PR 3 commit swept
against the review records, and each missing spec or code-quality review
run (2026-10-02, independent, read-only; P3.16 lists each commit, its
range and verdict). Their records findings are answered in the plan and
the checklist; their code findings and the gate-6 FAIL are fixed in fixer
9 (`<fixer-9>`), each red first.

**Owed before #626 leaves draft**: gate 3, fixer 9's own spec and
code-quality reviews (the gate closes when they pass); gate 4, the ADR-009
re-attack of fixer 9's changes, the attackers' confirmation of P3.8's
launched answer on `pty:spawn` (never probed), and the verdict comment
with its marker line regenerated for the final head; gate 6, the VM
re-check of row 36's Duration after a cleared session file, row 38's
midnight UTC check, the VM read of a leftover kill's log line on the npm
route (row 42), and the e2e suite again at the final head (fixer 9 changes
code); the SSH live matrix at PR 3's head (pty-manager.ts changed, and
statusline-watcher.ts in P3.2), the owner's screenshot review and the
Desktop test gate (owner-owed); CI at the final head with the native SQL
tests (they pass on the VM at 525a00ac); the owner-only checks gate 6
lists (real accounts, a working model, macOS and Linux); and the PR body
for the final head. Findings about pre-existing behaviour raised by the
adversarial passes were routed privately.
