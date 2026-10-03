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
9 (86ae88ac, f83026f8, f86727c5, 12b8049a, aac1b46e and aca63cc7), each
red first with mutation proof; its assessment of gate 6's three
observations changed no code (one goes to P4.11, two are pre-existing on
beta and in the owner's queue). Fixer 9's reviews (spec PASS with fixes,
code quality PASS) and its ADR-009 pass (lenses C and D: round 1 PASS,
round 2 on fixer 10 PASS, no blocker or major) are fixed in fixer 10
(ab1fbcc5: versions installed in turn stay within Sentinel's
three-analysis cap, one start-up rule for both providers; d0caf0bd:
nothing is written in front of a `.bak` a clear could not remove, "has
saved sessions" means at least one session, the extra-arguments label
tied to its field). Fixer 10's reviews (PASS with fixes) and round 2's
minors are fixed by fixer 11 (67b3b9a8: Sentinel goes by the highest
version checked and the panel names the version installed; be6ee406: a
clear drops the cleared set whatever the clear did, and a save removes a
`.bak` it cannot overwrite). Fixer 11's reviews (spec PASS with fixes,
code quality PASS) and ADR-009 round 3 (lenses C and D PASS; lens C also
confirmed P3.8's launched answer on `pty:spawn`, PASS) are answered by
fixer 12 (e6859037: a Re-run makes the installed version the highest
checked, down as well as up, and the user-facing line says "newer than the
newest one it has checked"). Fixer 12's confirmations (spec, code
quality, lenses C and D: all PASS) are answered by fixer 13 (ae05be60: an
unmatched Re-run of a version no start analyses says to use Re-run again;
the Re-run's mark is pinned with both providers on), whose reviews (spec,
code quality, lens D) PASS. The VM at aca63cc7, d0caf0bd and be6ee406:
row 36's Duration after a clear PASS on both versions, nothing coming back
after "Close sessions", the seeded Sentinel panel naming the installed
version with no analysis at start (both providers), the real owner-only
test 6 of 6, the e2e suite 81 of 81 each time, the real home untouched;
fixers 12 and 13 change only Sentinel's Re-run path, its message and its
text, covered by unit tests, so the VM evidence at be6ee406 stands for
them. Recorded limits: one transient read failure of the session file at
start latches saves off for that run (since fixer 9 also after a clear
that kept a running time); a clear whose session file cannot be removed
leaves the set on disk for the next start (pre-existing), and one refused
by the read-failure latch deletes nothing (by design); a version below
the highest checked is never analysed at start (a Re-run analyses it); a
Re-run reads notes from the version the panel names, which after a
downgrade can mean a larger prompt, never an extra analysis; two app
processes sharing one resources folder each keep Sentinel's state in
memory, the last writer winning (pre-existing).

**Gate status**: gate 3 is closed for PR 3 (every commit has its spec and
code-quality pair; the final fixers 9 to 13 are reviewed). Gate 4: the
ADR-009 pass on fixers 9 to 13 (rounds 1 to 3, then the confirmations of
fixers 12 and 13) is PASS at ae05be60, on top of the PR-level pass, PASS
at 525a00ac. Gate 6: the VM evidence at be6ee406 stands; row 38's
midnight UTC check (time-bound) and the VM read of a leftover kill's log
line on the npm route (row 42) are still owed, neither run since gate 6.

**Owed before #626 leaves draft**: CI at the final head, after the push,
with the native SQL tests (they pass on the VM at 525a00ac); the PR body
for the final head; and the owner's items, unchanged: the ADR-009 marker
line regenerated at the final head and posted, and the needs-review label
removed; the SSH live matrix at PR 3's head (pty-manager.ts changed, and
statusline-watcher.ts in P3.2); the screenshot review; the Desktop test
gate (#309); the owner-only checks gate 6 lists (real accounts, a working
model, macOS and Linux); and questions 2 to 4. Findings about
pre-existing behaviour raised by the adversarial passes were routed
privately.
