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
recommended, as PR 3 does for questions 2, 3 and 4.

**First code.** A shared scaffold (S0) lands before any lane starts: the IPC
channel names, preload bridges and their types, a provider on the Cloud Agent
and Insights records, the background lease kind, the `askConductorProvider`
setting field and the Codex web-session id class. Handlers come with the
phases that use them.
