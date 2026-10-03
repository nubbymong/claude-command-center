## 2026-10-03 -- WP2 PR 4: Codex tools, surfaces and qualification (P4.1 to P4.11)

**What.** PR 4 is the last implementation PR of the 2.1.1 Codex parity
release. It carries the 15 rows left after PR 3 (15, 16, 51 to 60, 66, 67
and 68): the Agent Canvas, browser and vision tools for Codex sessions; Ask
Conductor on Codex, with the "Ask Conductor runs on" Settings row when both
assistants are on; Codex memories and log folders; Cloud Agents and Insights
run with `codex exec`; the Codex web session and the artifacts record; Linux
and real-CLI CI; the end-to-end mode matrix; the qualification and owner-run
gates; and the final user-facing sweep that takes the Codex "Beta" labels off.

**Where the plan is.** `docs/wp2/completion-plan.md`, section 9 (the phase
plan, its probes, lanes, phase entries, owner-gated items and package gates),
with sections 2, 4 and 10 and `docs/wp2/parity-checklist.md` brought current
in the same commit.

**Stacking.** PR 4 is stacked on PR 3 (#626), itself on #625, and targets
beta; #625 and #626 merge first, and PR 4's own commits are those after PR
3's final head.

**Open with the owner.** Section 10's questions 5 (row 51, how the canvas and
vision instructions reach this computer's own Codex sign-in), 6 (row 53,
characters outside the BMP on the npm `.cmd` route and a live Ask tab) and 7
(row 57, what a Codex agent's skip-permissions choice runs as). Each is built
as its default A meanwhile; PR 4 waits on the answers before its merge is
recommended, as PR 3 does for questions 2, 3 and 4. Also to confirm: OR1 runs
rows 4 and 6 on every OS before merge (the owner's request said "on each
system"; plan 9.5 names per OS only for rows 4 and 15).

**First code.** A shared scaffold (S0) lands before any lane starts: the IPC
channel names, preload bridges and their types, a provider on the Cloud Agent
and Insights records, the background lease kind, the `askConductorProvider`
setting field and the Codex web-session id class. Handlers come with the
phases that use them. S0 and the plan were reviewed PASS.

**Built so far** (each phase's record is in the plan's 9.4 entry; rows in the
checklist):

- P4.1 (row 51, PARTIAL: question 5): the Agent Canvas on a Codex session's
  `/mcp` connection, its roots from the configured folder, the three canvas
  skills staged in a managed account's folder on the Built-in Tools master
  switch as Claude's `--plugin-dir` carries them, question 5's default A on
  this computer's sign-in, the per-preset approvals, and markers typed
  through one submit primitive at Codex's ready composer, a marker not sent
  kept on the canvas page until dismissed.
- P4.2 (row 52, VERIFIED): the vision tools and the push to the in-app
  browser for Codex sessions under Claude's switches.
- P4.3 (row 53, PARTIAL: question 6): Ask Conductor on Codex, the "Ask
  Conductor runs on" row with both on, the help folder with `AGENTS.md`
  rebuilt before every Ask start of either assistant and every Ask launch
  run in it, the question on the launch line on the direct route's fresh
  launch and typed through the primitive elsewhere, emoji removed and
  counted, a question not sent kept with Send again; a Codex Ask on Read
  Only. After the resources folder moves, the next Ask start begins a new
  conversation in the new help folder.
- P4.4 (row 55, PARTIAL: the delete check; row 56, VERIFIED, VM pending):
  each account's Codex memories on the Memory page, read only for now
  (delete built, hidden and refused in main until the VM check; frontmatter
  edit does not carry over), and each account's log folders in Settings.
- P4.5 (row 57, PARTIAL: question 7): Cloud Agents on Codex through `codex
  exec` under a background lease, Auto for the skip-permissions tick; at
  quit a running agent's whole tree is ended as a Claude agent's is.
- P4.6, first half (row 58, OWNER): a Codex account's own web partition,
  the orphan warning over both prefixes, Claude's claude.ai items off a Codex
  tab's menu and pane. The sign-in window waits for OR2a, the artifacts
  half for OR3.
- P4.8 and P4.9 (rows 59, 60, 67): Linux in the CI test matrix, the real-CLI
  conformance job per OS with the runner's own Codex home proven untouched,
  and the mode-matrix specs with a pure reader for Codex's first screens.
  They move when their CI and VM runs are recorded.
- P4.10, first part: the traceability binding made decidable on a shallow
  CI checkout and unable to certify itself, and the map of what the 20 DONE
  rows owe (`docs/wp1/evidence/release-qualification.md`).
- Not started: P4.7 (Insights, after OR3's mockup) and P4.11 (the final
  sweep, the Beta labels, the screenshots).

**Why this way.** The parity rule (OD26 P1): Claude's behaviour in the code
is the spec. Where it carries over it decides, as when the re-review sent
the per-tool-group skill staging back to Claude's master-switch rule; where
it cannot, the built default stands and the owner is asked (section 10,
questions 5 to 7).

**Shipping with workarounds (app knowledge, Known issues).** A Codex session
on this computer's own sign-in may get the canvas and vision tools without
their guidance (question 5's default); a canvas verdict line a Codex session
does not take is said on the canvas page; Ask Conductor on Codex cannot pass
on emoji typed into Codex's prompt; Ask Conductor starts nothing when its
help folder cannot be rebuilt.

**Reviews.** Every phase had its spec and code-quality review, a batched
fix pass per lane, and a re-review of those fixes; the re-review's own fix
pass (41638f93, b4413a24) is verified, spec and quality PASS, and the WP1
ledger is current at b4413a24 (0a643a5e). Recorded residuals and follow-ups
are in each phase's record: among them the Past discussions picker when the
resources folder sits inside a git repository (a follow-up proposal) and the
POSIX quit check of a Codex agent's commands (VM).

**Gate status.** ADR-009: pending for P4.1 to P4.6, then the PR-level pass at
the final head. The SSH live matrix at PR 4's final head (OR5: `pty-manager.ts`
changed outside the SSH branch). The VM walks each phase lists, the e2e suite
at the final head, CI with `ci-run` (the first Linux run of the WP2 stack),
the owner's screenshot review, OR1 to OR4, the Desktop test gate, and
questions 5 to 7. Findings about pre-existing behaviour raised by the reviews
were routed privately.
