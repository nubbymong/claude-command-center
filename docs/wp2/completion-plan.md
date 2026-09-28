# 2.1.1 Codex parity: completion plan

Written 2026-09-27 against `e0d4ddbc`, the head of PR #625. It reconciles the
remaining 2.1.1 work with the owner's recorded decisions, row by row over all
75 rows of `docs/wp2/parity-checklist.md`, and sets the order of what is left.
It makes no new decision. Where the draft plan of the same day disagreed with
a record, the record wins (section 3).

The owner's instruction of 2026-09-27, in short: no interim release; finish
the agreed 2.1.1 parity work before any release is cut; do not reopen settled
questions or silently defer features; keep missing implementation apart from
missing verification, and package completion apart from release completion;
bring the owner only genuinely unresolved UX decisions; continue approved work
without asking per phase; keep the remaining PR structure where practical. The
objective is the full agreed Codex parity release, not closing PR #625.

## 1. How to read this

Sources, by short name:

- **OD20, OD26, OD27**: `docs/wp1/owner-decisions-2026-09-20.md`,
  `-2026-09-26.md` and `-2026-09-27.md`, with their decision ids (D8, U1, P1,
  M1 and so on).
- **ADR-022**: `architecture/decisions/2026-09-27-adr-022-codex-app-server-usage-read.md`.
- **PLAN**: `docs/wp2/plan.md`, section named. **HCS**: `docs/wp2/hello-codex-spec.md`.
- **Canvas**: an owner approval of a mockup on the Agent Canvas, recorded on
  the date given. The mockups are local and gitignored, as the checklist says
  of its screenshots.
- **Parity**: the parity rule (OD26 P1): Codex does what Claude does, the same
  way. The entry names the Claude behaviour copied. Section 5 says where these
  resolutions come from.
- **aicc_planning#N**: an issue in the private planning repository.
- **Design**: the approved WP1 design,
  `WORK-PACKAGE-1-PROVIDER-IDENTITY-SETUP-DESIGN.md`, in the private planning
  repository (PLAN names its digest). **Section 19** is its
  unsupported-capability escalation: where a shared feature cannot carry over
  to Codex, the evidence, the user impact, the alternatives and a recommended
  decision go to the owner, and the row stays in scope until the owner signs
  that record.

Status (verified against the code at `e0d4ddbc` where the row was in doubt):

- **DONE**: built, with an automated test on the Codex path. Anything left is
  verification.
- **PARTIAL**: part of it is built, or it is built and nothing proves it for
  Codex yet (the checklist's UNVERIFIED).
- **OPEN**: not built, or waiting on the owner.

Gap, meaning what stands between the row and the release:

- **none**;
- **implementation**: code still to write (its verification follows);
- **verification**: built, proof still owed (real CLI, per OS, packaged, or a
  first test on the Codex path);
- **owner**: an owner decision or action comes first.

PR: **2** is PR #625 (its branch also carries the usage track, MP1 to MP13, of
package P3); **3** is the sessions remainder, stacked on #625; **4** is agent
surfaces and qualification. "2, v4" means built in 2, with the verification it
still owes recorded in 4. "2; 3" means partly built in 2, the rest in 3.

## 2. Summary

- 75 rows: **25 DONE, 27 PARTIAL, 23 OPEN**.
- The 50 rows not DONE, by gap: **implementation 42, verification 6, owner 2**
  (rows 15 and 58). Row 53 moved from owner to implementation when the owner
  decided it (`docs/wp1/owner-decisions-2026-09-27.md`, M4).
- By PR: **35 in PR 3, 15 in PR 4**. No row changes package. The Ask Conductor
  part of row 14 goes with row 53 into PR 4, because it is the same change.
- 20 DONE rows still owe real-CLI, per-OS or packaged verification, recorded
  in PR 4 and closed at release level: rows 1, 2, 3, 4, 6, 9, 12, 13, 18, 21,
  23, 25, 27, 29, 33, 48, 49, 50, 64 and 74. The other 5 DONE rows (5, 19, 26,
  30, 75) owe nothing.
- Two rows the checklist marks VERIFIED are counted PARTIAL here, from the
  code: row 17 (no Codex credits row yet; `src/shared/app-knowledge.ts` says
  so as a known issue) and row 28 (Codex prices are still a static table of
  three models; the agreed source is the live one Claude uses). The checklist
  moves both in the same change as this plan, and moves rows 52, 68 and 69
  from OWNER to MISSING, since parity settles them (section 10).
- Genuinely unresolved UX decisions: **none**. The one there was (row 53,
  both providers on) was decided by the owner on 2026-09-27 (option B; OD27
  M4). Section 10.
- Nothing in PR 3 waits on the owner. PR 3 can start.

## 3. Where the draft plan disagreed with the record

The draft (a local checkpoint, 2026-09-27) is superseded by this file.

| Draft said | The record | Resolution |
|---|---|---|
| Stage A: cut 2.1.1-beta.2 now as an interim beta | Owner instruction, 2026-09-27: no interim release | Dropped. Nothing is released until section 7 holds. |
| #625 has two open owner decisions: the `mcp-config.ts` adaptation, and "Sign in to Codex first" as a code fix or a known issue | Owner decision recorded 2026-09-26: keep the config heal as it is (ledger `retain`). The notice: settled by OD26 U1 (every upgrader answers "Do you use Codex?"; adding an account counts as yes) | Both settled. "Owner decision pending" in `CONTEXT.d/2026-09-25-wp2-accounts-surface-and-guidance.md` is out of date. The notice now shows only when Codex is answered on and has no account, which is the right instruction (`tests/unit/renderer/session-dialog-codex-account.test.tsx`). |
| Owner decisions are needed before code for rows 52, 53, 58, 68 and 69 | Section 10 | Only row 53 (both providers on) is a UX decision. Rows 52, 68 and 69 are decided by parity (row 68 already on 2026-09-26: a Conductor-native Codex report run with `codex exec`); row 58 splits into parity (the web session) and a section 19 record (artifacts). None of them gates PR 3. |
| Row 15 (keyring and sign-in runs) is an owner decision before code | OD20 D8: these resources block merge, not implementation | An owner action (hosts, disposable test identities, timing), owed before PR 4 merges. Not a UX decision. |
| aicc_planning#84 (the beta ruleset) is an owner decision before code | A repository-settings action for the owner | Not a parity row and not a code gate. Section 7 lists it as an owner action only. |
| Not in scope: Dependabot PRs #620 to #624 | Owner decision recorded 2026-09-26: roll them in before the release; #621 (Electron 44) is a runtime major | In the release criteria (section 7). |
| Whether to split package P3 into two PRs, asked 2026-09-26, is unanswered | Owner instruction, 2026-09-27: keep the remaining PR structure where practical | Settled: no split. Four implementation PRs in all (#619, #625, PR 3, PR 4), within the approved delivery shape. |
| 48 rows not done | The code at `e0d4ddbc` | 50: rows 17 and 28 (section 2). |

## 4. Row by row

### A. Accounts, identity, setup, onboarding, upgrade, Codex-only

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 1 | Provider on/off, "not set up", last provider on | DONE | OD26 U1, U3 | verification: real CLI 0.153.4 and 0.155.1; packaged per OS | 2, v4 |
| 2 | CLI detect and version classes | DONE | OD20 D7; PLAN A8 | verification: real minimum, pinned and maximum per OS | 2, v4 |
| 3 | Install and update | DONE | PLAN A9 | verification: one real install per OS (macOS, Linux; Homebrew unrun) | 2, v4 |
| 4 | Sign-in (browser, API key) | DONE | PLAN A6, A7; OD26 U2 | verification: real API-key sign-in and sign-out; macOS, Linux | 2, v4 |
| 5 | Device-code sign-in | DONE (off) | OD26 U3 (stays off, WP1.41) | none | 2 |
| 6 | Multiple isolated accounts | DONE | PLAN A5 | verification: a real two-account run; keyring scoping (WP1.10, WP1.11) | 2, v4 |
| 7 | Identity editing after creation (name, colour, link, unlink, group) | PARTIAL: the IPC exists (`updateIdentity`, `linkIdentity`, `unlinkIdentity`, groups in `src/preload/index.ts`); no editor, and the row's chip is decorative (`ManagedAccountsSection.tsx`) | Canvas 2026-09-26, "Accounts: identities across providers", option B: the editor opens from any row's chip, groups stay (WP1.40) | implementation | 3 |
| 8 | One Accounts surface | PARTIAL: two row components (`AccountsPanel.tsx` for Claude, `ManagedAccountRow` for Codex) | The same canvas; design section 10; WP1.39 | implementation | 3 |
| 9 | Launch and resume in the exact account | DONE | PLAN A10, commit 4 | verification: a restored tab keeps its managed account, per OS | 2, v4 |
| 10 | Lifecycle blockers and archive | PARTIAL: a refusal gives a count only (`providerAccountsStore.ts:427`); archive is one-way (`src/shared/providers/registry.ts:610-625` allows no way out of archived) | The same canvas: blockers name each consumer with Go to; "Archived (N)" with Restore (design 5.3) | implementation | 3 |
| 11 | Staged re-authentication (WP1.52) | OPEN: "Sign in again" is offered only while signed out | Parity: Claude's "Refresh sign-in" works while signed in; WP1.52; PLAN "Out of this PR" | implementation | 3 |
| 12 | Upgrade question and the read-only sign-in check | DONE | OD26 U1, U2 | verification: real 0.153.4 and 0.155.1 | 2, v4 |
| 13 | Hello Codex | DONE | Canvas 2026-09-24 (v1) and the commit 6 canvas; HCS | verification: per OS | 2, v4 |
| 14 | Codex-only mode, no Claude noise | PARTIAL: with Claude Code off the title bar still draws the Code and Claude.ai pills (`TitleBar.tsx:253-272`); the Accounts Claude card still prompts to sign in; Hello Codex page 1 was seen saying Codex runs beside Claude; Ask (row 53) | Design section 2 (Claude is not a prerequisite); OD27 M1 D5 (a provider that is off shows one muted line or nothing); parity | implementation | 3 (Ask part: 4) |
| 15 | Owner-run gates (native keyring, sign-ins with real accounts, packaged smoke) | OPEN | OD20 D8 (blocks merge, not implementation); WP1.11, WP1.64, WP1.72 | owner: hosts, disposable test identities, timing; then verification | 4 |
| 16 | WP1 traceability | PARTIAL: items still `planned` | OD20 D9; WP1.70, WP1.73 | verification: items move to evidenced as the evidence lands | 4 |

### B. Account summary, usage footer, switching, Tokenomics

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 17 | All-accounts usage page | PARTIAL: built and its screens approved; no Codex credits row (known issue in `src/shared/app-knowledge.ts`) | OD27 M1, M2; ADR-022; credits: parity, shown once a real read shows their unit (recorded with the usage plan, 2026-09-27) | implementation (evidence first, P3.1); verification: macOS, Linux, packaged | 2; 3, v4 |
| 18 | Session-strip meters | DONE | OD27 M1 (D2, D3); labels from `window_minutes` (decided by design, 2026-09-26) | verification: a 0.155.1 rollout fixture from a real session; a real-CLI run | 2, v4 |
| 19 | Strip cost wording | DONE | "API-equivalent estimate" wording (decided by design, 2026-09-26) | none | 2 |
| 20 | Account chip on the strip and in the sidebar | PARTIAL: on the usage page and the footer; the strip and the sidebar still key the chip by email (`SessionStatusStrip.tsx`, `sidebar/SessionRow.tsx:101-107`); also here, from row 7: the email-keyed Claude colour overrides migrate into the identity's colour (moved at the P3.2 review) | Canvas 2026-09-26, "Switching a running Codex session's account": the strip's Codex account pill and its Switch account menu; the footer's label rule (a Codex identity shows its name); parity for the sidebar | implementation | 2; 3 |
| 21 | Multi-account footer | DONE | Canvas 2026-09-26 (footer, option B); OD27 M1 | verification: real CLI, packaged | 2, v4 |
| 22 | Switch the account of a running session | OPEN: refused for Codex (`hooks/useSwitchAccount.ts:50`) | Canvas 2026-09-26 (as row 20): keep the conversation; copy its rollout into the new account's folder, then `codex resume` there | implementation (evidence first: a copied rollout resumes on the supported versions; if not, section 19) | 3 |
| 23 | Choose the account at launch | DONE | Commit 6 canvas, 2026-09-24 | verification: per OS | 2, v4 |
| 24 | Running sessions per account | PARTIAL: counted only inside a refusal | Canvas 2026-09-26 ("N running" pill on the row) | implementation | 3 |
| 25 | Tokenomics reads managed realms and `~/.codex` | DONE | OD20 D10; OD26 U3 | verification: real rollouts | 2, v4 |
| 26 | Tokenomics attribution and filters | DONE | Canvas 2026-09-26 (Tokenomics, option A); OD27 M1 | none | 2 |
| 27 | Subagent collision | DONE | The #307 fix (`7fc96639`) | verification: a real 0.155.1 subagent rollout | 2, v4 |
| 28 | Codex pricing | PARTIAL: "no price" and one cached-input rule built (MP11); prices are a static table of three models (`resources/codex-pricing.json`), so four of the six models on offer (`src/renderer/codex-models.ts`) read "no price" | PLAN usage track MP11; parity: Claude's prices come from the live LiteLLM fetch with a fallback, and the same fetch extends to OpenAI models (resolution recorded 2026-09-26) | implementation | 2; 3 |
| 29 | Plan type | DONE | OD27 M1 | verification: macOS, Linux, packaged | 2, v4 |
| 30 | Tokenomics totals split by provider | DONE | Canvas 2026-09-26 (Tokenomics, option A) | none | 2 |

### C. Sessions, statusline, model, Sentinel, Watchdog, status

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 31 | Logs history, search and transcript | OPEN: local Claude only (`src/main/logging/should-register-run.ts:50`; `src/renderer/lib/session-capabilities.ts`) | Parity: index each realm's rollouts; realms never cross. The dimmed Logs tool for Codex (ADR-018 D3) ends when this lands | implementation | 3 |
| 32 | Resume picker | PARTIAL: no worktree conversations, no names | Parity | implementation | 3 |
| 33 | Resume in the exact realm | DONE | PLAN A10 | verification: real, realm B never lists realm A | 2, v4 |
| 34 | Exact resume on app relaunch | OPEN: Codex is skipped (`src/main/session-resume-enrich.ts:68`) | Parity: resume by the claimed session id, `codex resume <id>` in the same realm | implementation | 3 |
| 35 | Restart and Switch keep the conversation | PARTIAL: Restart starts a new conversation or opens the picker (`SessionHeader.tsx:69-90`) | Parity (Claude's Restart resumes); canvas 2026-09-26 for Switch | implementation | 3 |
| 36 | Statusline segments | PARTIAL: no account chip, lines or duration | Parity (line counts: evidence first; section 19 if Codex reports none) | implementation | 3 |
| 37 | Statusline settings | PARTIAL: they apply to Codex (P2); row 36's segments missing | Parity | implementation | 2; 3 |
| 38 | Statusline after resuming an old rollout | PARTIAL: the claim looks only in today's UTC date folder (`src/main/providers/codex/telemetry.ts:341-349`, a documented limitation), so a conversation from an earlier day, or one that crosses midnight UTC, gets no statusline | Parity | implementation (re-read the date folder each poll and find a resumed rollout wherever it is); a known defect until then (section 7) | 3 |
| 39 | Model catalogue | PARTIAL: a static list of six (`src/renderer/codex-models.ts`) | Parity: the model registry plus Sentinel's coverage check. Not app-server `model/list`: OD27 M2 allows usage reads only | implementation | 3 |
| 40 | Effort | PARTIAL: no per-model levels | Parity | implementation | 3 |
| 41 | Mid-session model and effort | PARTIAL: needs a Restart, which starts a new conversation | Parity: applied live, keeping the conversation (evidence first: Codex's own model command on the supported versions) | implementation | 3 |
| 42 | Sentinel | PARTIAL: Claude runs only (`src/main/sentinel/index.ts`) | Parity: version drift, flags and the rollout format checked, with findings; the analysis runs on whichever provider is on | implementation | 3 |
| 43 | Watchdog | OPEN: never armed for Codex (`src/main/pty-manager.ts`, the local arm site) | Parity: auto-retry and silence detection; aicc_planning#72 (a CLI without its own patterns reports Watchdog unavailable, never Claude's) | implementation | 3 |
| 44 | Services (PTY integrity) | PARTIAL: built, unproven (Codex output is fed to the monitor) | Parity | verification | 3 |
| 45 | Provider status pill | OPEN: Anthropic only (`src/main/service-status.ts`) | Parity: an OpenAI status pill beside Anthropic's, each shown only while its provider is on | implementation | 3 |
| 46 | Busy sweep and sleep moon | OPEN: off for Codex | Parity: fed from output and silence | implementation | 3 |
| 47 | Waiting-for-input and attention dot | OPEN: nothing feeds it for Codex | Parity: fed by Codex `notify` and hooks | implementation | 3 |

### D. MCP, reviews, Canvas, browser, Ask, knowledge, Memory, logs, cloud, web

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 48 | Conductor MCP transport | DONE | PLAN commits 4 and 5b | verification: a live 0.155.1 tool listing | 2, v4 |
| 49 | `codex_review` | DONE | PLAN commit 5a (its defaults stand unless the owner overturns them) | verification: a real run on a signed-in account | 2, v4 |
| 50 | `claude_review` | DONE | PLAN commit 5b, owner decisions 1 to 3 (2026-09-24) | verification: a live wait past 300 s | 2, v4 |
| 51 | Agent Canvas from Codex | OPEN: withheld (`src/main/conductor-mcp-server.ts:1106`) because a Codex session had no bound id; `/mcp` binds one since commit 5b | Parity: the tools, roots, instruction delivery and the live loop | implementation | 4 |
| 52 | Browser and vision tools | OPEN: withheld (`conductor-mcp-server.ts:911-913`, `:1042`, a "Claude-only for now" call of 2026-07-02) | Parity; the later owner decisions (the 2.1.1 gate, OD26 P1) end a call worded "for now" (section 10) | implementation | 4 |
| 53 | Ask Conductor on Codex | OPEN: pinned to Claude (`src/renderer/lib/askConductor.ts:255`) and blocked with Claude Code off (`askConductorGate.ts`) | Codex only: design section 2 and parity (Ask runs on the provider that is on). Both on: OD27 M4 (option B, canvas "Ask Conductor provider choice" v1): a Settings, General row "Ask Conductor runs on", shown only while both are on, Claude Code by default | implementation | 4 |
| 54 | App knowledge, tour, tips | PARTIAL: the P2 fixes are done | The AGENTS.md surface sweep; recorded 2026-09-26: the Codex "Beta" labels come off in the release where parity lands | implementation (the final sweep) | 2; 4 |
| 55 | Memory | OPEN: a banner only (`MemoryPage.tsx:204-206`) | Parity: each realm's Codex memories on the Memory page | implementation | 4 |
| 56 | Codex logs | OPEN | Parity: each realm's `log` folder offered where the app offers its own log folder (Settings, Debug Logging) | implementation | 4 |
| 57 | Cloud Agents | OPEN: Claude only (`src/main/cloud-agent-manager.ts:192`) | Parity: background agents run with `codex exec` in the account's realm, as Claude's run its headless CLI; not the experimental `codex cloud` (WP1.41) | implementation | 4 |
| 58 | Web sign-in and artifacts | OPEN | Web session: parity (chatgpt.com is to a Codex account what claude.ai is to a Claude account: the browser pane's account surface). Artifacts: no Codex equivalent is known, so a section 19 record (section 10) | owner (the artifacts record); implementation (the web session) | 4 |

### E. Everything else

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 59 | PR CI on Linux | OPEN: Windows and macOS only (`.github/workflows/ci.yml`) | OD20 D5 | implementation | 4 |
| 60 | Real-CLI coverage in CI | OPEN: no workflow installs Codex | OD20 D7; WP1.71 | implementation | 4 |
| 61 | Compact | OPEN: Claude only (the strip's controls) | Parity: Codex's own compact command (evidence first) | implementation | 3 |
| 62 | Extra CLI arguments | OPEN: Claude only (`extraArgs`, `src/shared/types.ts:126-130`) | Parity: the same field and IPC character guard, plus a block-list of the flags the app manages and of any setting that changes the account, provider or endpoint | implementation | 3 |
| 63 | Hooks gateway and notification rules | OPEN: Claude sessions only (`HooksGatewaySection.tsx:84`) | Parity: route Codex `notify` and hook events | implementation | 3 |
| 64 | Partner terminal wording | DONE | P2 | verification: per OS | 2, v4 |
| 65 | GitHub session context | PARTIAL: reads Claude transcripts only (`src/main/github/session/transcript-loader.ts:59`) | Parity: read the session's realm rollouts | implementation | 3 |
| 66 | Packaged smoke | PARTIAL: Windows only, an unsigned candidate on a used VM | OD20 D8; WP1.63 | verification (release level; owner hosts) | 4 |
| 67 | E2E mode matrix | PARTIAL | WP1.1, WP1.60 | implementation (restart, enable/disable, real launch cases); verification | 2; 4 |
| 68 | Insights | OPEN: Claude only; Claude's Insights types Claude Code's own `/insights` in a terminal (`src/main/insights-runner.ts:234-237`) | Parity, recorded 2026-09-26 (the parity reset's "Resolved by parity" list, sessions batch; not one of that day's open questions): a Conductor-native Codex report, run with `codex exec`. A mockup comes before the build (section 10) | implementation | 4 |
| 69 | Plan mode | OPEN: no Codex option (`SessionDialog/CodexFormFields.tsx:162-170`) | Parity: Claude's Plan mode launch option (`src/renderer/lib/claude-cli-options.ts:85`); Codex documents a plan command; evidence first, section 19 if absent | implementation | 3 |
| 70 | Image paste | PARTIAL: built, unproven; the tip still says "Claude's prompt" (`tips-library.ts:370`) | Parity | verification (and the tip) | 3 |
| 71 | Copy, paste, scrollback, mouse | PARTIAL: built, unproven; the trace is from 0.125 | Parity | verification (re-captured at 0.155.1) | 3 |
| 72 | Multi Spawn and Quick Start with Codex | PARTIAL: one at a time is done (P2) | Parity: N copies with one lease each; Quick Start | implementation | 2; 3 |
| 73 | Channel rules delivery | PARTIAL: built, unproven | Parity | verification | 3 |
| 74 | Command buttons, preset pill, restart menu, theme | DONE | ADR-018 | verification: the real-CLI pass | 2, v4 |
| 75 | Claude-only environment switches | DONE (not a Codex feature) | Labelled Claude only | none | none |

## 5. Where the parity entries come from

Every "Parity" entry in section 4 applies OD26 P1. Most were resolved on
2026-09-26 (the usage ones on 2026-09-27) without a question to the owner, as
the rule directs: the Claude behaviour was named and Codex was given the same.
Until this file they were kept only in local working notes, so this section
and section 4 are their tracked record. Where this plan adds a detail (for
example where the Codex log folder is offered), the detail follows the Claude
code it names. Two carry a fallback that was recorded with them:

- **Switching a running session's account (row 22).** If the supported CLI
  cannot resume a copied rollout, the switch starts a new conversation with an
  honest notice, and the limit goes to the owner under design section 19.
- **Anything a capability lead promised (rows 36, 41, 61, 69).** The
  checklist's rule holds: a lead is checked on 0.153.4 and 0.155.1 before any
  work relies on it (P3.1). A capability absent at those versions goes to the
  owner as a section 19 record for that row; the row stays in scope until the
  owner signs it.

## 6. Package completion (per PR)

A PR is complete as a package when:

1. **Implemented.** Every row it carries is built to its settling record, or
   has a section 19 record the owner signed.
2. **Tested.** Failing tests first; the touched host-safe test files by name,
   `npm run typecheck`, and the WP1 gate (`tests/wp1/legacy-codex-gate.test.ts`,
   `tests/wp1/traceability.test.ts`, the dependency-boundary and provider
   conformance tests). The full suite and every file headed HOST QUARANTINE
   run on CI and the Windows test VM, never on the owner's machine.
3. **Reviewed.** Each phase has an independent spec-compliance review and a
   separate code-quality review; fixes are re-reviewed.
4. **ADR-009.** Each phase marked Y in sections 8 and 9 has an adversarial
   pass (one bounded round, then a confirmation by the same attackers), and the
   PR carries a PASS verdict with the marker line for its exact head.
5. **SSH live matrix.** When any phase edits the AGENTS.md blast radius
   (`pty-manager.ts` and the rest of that list), `npm run test:live:ssh` is run
   and its matrix reported in the PR before merge.
6. **VM verified.** The e2e suite on the Windows test VM at the final head
   (one pre-existing e2e failure, reproduced on beta, routed privately, is not
   waived); the PR's surfaces walked with a real Codex CLI where a row needs
   it; screenshots of new or changed screens reviewed by the owner, image by
   image.
7. **CI green** at the final head on Windows and macOS (and Linux once row 59
   lands), the Desktop test gate aside until the owner attests (#309).
8. **Recorded.** The checklist rows it moves, a `CONTEXT.d/` fragment, the WP1
   ledger and traceability, each in the commit that does the work; the
   user-facing sweep for what the PR changed; a PR body current for its head.

Per PR:

- **PR 2 (#625).** P2 and the usage track are built, reviewed, VM-checked (e2e
  81/81 at `7c2739bf`) and their screens approved. Left for the package: the PR
  body and the ADR-009 verdict comment for the final head, and CI at that head.
  The verification its rows still owe is recorded in PR 4 (section 2).
- **PR 3.** Phases P3.1 to P3.16 (section 8). The SSH live matrix is owed:
  P3.5, P3.10, P3.11 and P3.12 edit `pty-manager.ts`.
- **PR 4.** Phases P4.1 to P4.11 (section 9), including row 15, which OD20 D8
  makes a merge blocker. The SSH live matrix is owed if P4.1 or P4.3 edits
  `pty-manager.ts`.

Package completion is not release completion. A complete PR merges to beta
only on the owner's word, in the order #625, PR 3, PR 4, and nothing is
released from it until section 7 holds.

## 7. Release completion (2.1.1)

2.1.1 is released only when all of these hold:

1. **Every row is DONE with gap "none"**, or carries a section 19 record the
   owner signed. That is 75 rows; row 75 is not a Codex feature.
2. **Verified on the platforms the decisions require:** Windows, macOS and
   Linux (OD20 D2: Codex managed realms must work on macOS; D5: Linux in CI;
   WP1.63: packaged smoke on all three), with the Codex CLI at the minimum
   0.153.4, the pinned 0.155.1 and the release-candidate version, the last
   tested separately (D7, WP1.71). WP1.73: real-CLI qualification is not
   deferred.
3. **Owner-run gates done** (row 15; OD20 D8), on the owner's hosts and
   disposable test identities.
4. **Security alerts:** every open code-scanning or Dependabot alert fixed, or
   dismissed through an ADR-009 pass, and reported to the owner before the cut
   (owner rule recorded 2026-09-26).
5. **Dependabot PRs:** every Dependabot PR open at the cut (today #620 to
   #624) rolled in (owner decision recorded 2026-09-26); #621, the Electron 44
   major, with its own ADR-009 pass and a VM packaging run.
6. **Known defects settled.** The four C items in the checklist's P2
   acceptance section (the narrow-window overlap of the partner label, the
   renderer-only one-at-a-time rule, Resume replacing the tab list while its
   prompt is open, the untracked local Claude spawn) and the Codex statusline's
   midnight-UTC limitation (row 38) are fixed or each given an explicit owner
   disposition; the one pre-existing e2e failure, reproduced on beta, routed
   privately, is settled through that route (owner rule: no release with known
   bugs). Section 8 names the phase that takes each.
7. **The AGENTS.md user-facing surface sweep** over everything since
   2.1.1-beta.1: `src/renderer/changelog.ts` with `CHANGELOG.md`;
   `src/shared/app-knowledge.ts`, with a known-issues entry for anything that
   ships with a workaround; `src/renderer/tips-library.ts`; the guided tour and
   the Feature Guide cards; `README.md` with its screenshots. Also the
   screenshot recapture the owner asked for on 2026-09-26 (the images listed in
   `docs/wp1/evidence/release-qualification.md`), and the Codex "Beta" labels
   removed.
8. **The release evidence record** (WP1.37: the tested commit, CLI versions,
   OS runners, commands, real-smoke scope and known limitations).
9. **The owner's desktop test and attestation** (the Desktop test gate, #309).
10. **A visual sweep per platform** (Windows, macOS, Linux) of the account,
    usage and sign-in surfaces, Claude's included, on the release candidate
    (owner rule on record).
11. **An in/out list by row number**, all 75 rows, put to the owner, and the
    owner's explicit go to cut (owner rule on record: no "done" claim and no
    cut while anything agreed is outstanding).
12. Then, in order: the merges, the version bump on beta (the beta-bump
    model), `release.yml` watched to green; promotion to stable afterwards, as
    AGENTS.md describes. aicc_planning#84 (adding the Desktop test gate to the
    beta ruleset) is an owner action, not a condition of this list.

**Verification that only the release can close** (not inside a PR's own VM
run):

- packaged smoke on a clean machine per OS, on a signed build (row 66): the
  signed build exists only at release;
- the upgrade walk repeated on the signed release candidate (the 2026-09-26
  walk used an unsigned candidate on a used Windows VM);
- the release-candidate Codex CLI version (D7);
- real sign-in, status and sign-out per OS on disposable identities, the
  native keyring smoke and a real two-account run (rows 4, 6 and 15; WP1.10,
  WP1.11, WP1.20, WP1.64, WP1.72);
- the macOS and Linux columns of the 20 DONE rows in section 2;
- the owner's desktop attestation.

## 8. PR 3 phase plan

One phase at a time, each one commit or a few, with the gates of section 6.
P3.1 runs on the VM while P3.2 to P3.4 are built, because those need none of
its answers. P3.5 comes before P3.6. Every phase is **APPROVED** (settled by a
record or by parity). The only way a row here stops is a section 19 finding
from P3.1, and then only that row.

| Phase | Rows | ADR-009 | SSH radius | State |
|---|---|---|---|---|
| P3.1 Capability evidence on the supported CLIs | none closed; feeds 17, 22, 34 to 36, 38, 41, 47, 61, 63, 69 and PR 4's 51, 55 to 58 | N | N | APPROVED |
| P3.2 Accounts: one row, identity editor, running pill, blockers, restore | 7, 8, 10, 24 (and the Accounts part of 14) | Y | N | APPROVED |
| P3.3 Staged re-authentication | 11 | Y | N | APPROVED |
| P3.4 Codex-only mode and provider status | 14, 45 | Y | N | APPROVED |
| P3.5 History and resume | 32, 34, 35, 38 | Y | Y | APPROVED |
| P3.6 Account chip and Switch account | 20, 22 | Y | N | APPROVED |
| P3.7 Statusline segments and settings | 36, 37 | N | N | APPROVED |
| P3.8 Model, effort, pricing, compact, plan mode | 28, 39, 40, 41, 61, 69 | Y | N | APPROVED |
| P3.9 Sentinel for Codex | 42 | Y | N | APPROVED |
| P3.10 Activity, attention, Watchdog and hooks | 43, 46, 47, 63 | Y | Y | APPROVED |
| P3.11 Extra CLI arguments | 62 | Y | Y | APPROVED |
| P3.12 Logs and GitHub context | 31, 65 | Y | Y | APPROVED |
| P3.13 Multi Spawn and Quick Start | 72 | Y | N | APPROVED |
| P3.14 Usage follow-up: Codex credits | 17 | N (Y if the read changes) | N | APPROVED |
| P3.15 Terminal verification | 44, 70, 71, 73 | N | N | APPROVED |
| P3.16 PR 3 records and user-facing sweep | none | N (docs) | N | APPROVED |

The 35 rows: 7, 8, 10, 11, 14, 17, 20, 22, 24, 28, 31, 32, 34, 35, 36, 37,
38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 61, 62, 63, 65, 69, 70, 71, 72, 73.

**P3.1 Capability evidence on the supported CLIs.** On the Windows test VM,
with a managed signed-in account, on 0.153.4 and 0.155.1: whether a rollout
copied into another realm resumes there; Codex's own model, compact and plan
commands; what `notify` and hooks deliver; whether a rollout carries line
counts; a 0.155.1 rollout fixture from a real session (owed since MP8); the
unit of a credits figure, where an account shows one. For PR 4, in the same
visit: how MCP instructions or skills reach a Codex session, `codex exec
--json` for background agents and for the Insights report, the memories
and log folders, and the CLI command list for the artifacts record. Output:
fixtures under `tests/fixtures/codex/` and a short evidence record. ADR-009: no
(evidence only).

**P3.2 Accounts.** One row component for both providers; the identity editor
from any row's chip (name, colour, group, linked accounts; Claude's inline
name and colour fields move into it; the email-keyed colour overrides stay
Claude's colour store, kept in step with the identity's colour, and their
migration into the identity's colour moved to P3.6 with the chips that read
them, recorded at the P3.2 review, 2026-09-27); a "N running" pill; a refused inactivate or
archive names each consumer with Go to; "Archived (N)" with Restore, which
needs a new registry transition out of archived. Likely files:
`src/renderer/components/settings/accounts/*`, `AccountsPanel.tsx`,
`stores/providerAccountsStore.ts`, `src/shared/providers/registry.ts`,
`src/main/providers/core/accounts-service.ts`, the provider-accounts IPC
handlers, `src/preload/index.ts`. ADR-009: yes (IPC, preload, the account
registry).

**P3.3 Staged re-authentication.** Sign in again while still signed in, into a
replacement realm: subject match, a mismatch becomes a separate account, an
unverifiable one asks, the old realm is retired, and an interrupted run
recovers (WP1.52). Likely files: `accounts-service.ts`,
`providers/codex/auth-operations.ts`, `realm-paths.ts`, the registry journal,
the Sign in again dialog, IPC. ADR-009: yes. Built (review round 1,
2026-09-28): the old sign-in is removed only once design 9.2's proof exists;
until then it is kept, visible ("the old sign-in is kept"), and archiving
the account removes it. The proof is owed: a second real sign-in on the test
VM at 0.153.4 and 0.155.1 showing that signing out the old folder never signs
the new one out, for file and keyring stores (an owner action; it would turn
on the Codex capability `auth.retireReplaced`), and each folder's
credential store recorded as its own file. This computer's own sign-in is
signed in again in place, after its warning (design 9.2, last paragraph).
Review round 2: the account's conversation history (its `sessions` folder
and `history.jsonl`) is copied into the new folder before the switch, so
resume, restored tabs and Tokenomics keep earlier conversations (Tokenomics
keys a Codex turn on its session id and turn, so the copy is counted once);
a failed or torn switch is decided by what the registry file says, and a
Discard is written ahead of the sign-out and removal; a sign-out signs the
old sign-in out too. The kept old sign-in keeps the account needing
attention, as design 9.2 requires: "on failure or uncertain provider
semantics, it remains in a visible recoverable cleanup state and the
provider account stays `attention`".
Review round 3: the history is carried over asynchronously, a batch at a
time, each file as a second name of the same file (a hard link; the folders
share a volume and the old one is never written again), else a byte copy;
a file with any name the app did not give it (only the same place in the
account's earlier folders counts) is left behind and logged; the history
has its own bound (200,000 entries; beyond it the sign in again is refused
with nothing changed), and a replacement holding it is removed whole by its
Discard, which reads the registry again between batches. The provider's
on/off is read again inside the switch's lock. A sign-out whose CLI ran
records the account as needing a check whatever its read-back said.
Final review round: Cancel stops the copy at its next batch and nothing is
switched; files left behind are said in the dialog, and the copy step in its
status line; the too-large refusal names the way that keeps the history
(signed out, a sign in again runs in the account's own folder); a new name
is kept only when it landed in the replacement (else unsafe-path) and when
the link added exactly one name (else it goes and the file is left behind).

**P3.4 Codex-only mode and provider status.** Each provider's status pills
only while it is on, with an OpenAI status pill for Codex; no Claude prompts
with Claude Code off (the Accounts Claude card, Hello Codex page 1, the
onboarding and showcase pages), using OD27's D5 line where a Claude section
would be. Likely files: `TitleBar.tsx`, `src/main/service-status.ts`,
`AccountsPanel.tsx`, `onboarding/hello-codex.ts`, the onboarding steps,
`PRIVACY.md` (the new status host). ADR-009: yes (a new main-process fetch and
its IPC payload).
Built (2026-09-28, aa0411b0 and a0c0e9ba): main reads each provider's public
status page only while it is on (OpenAI's `status.openai.com` components list
for Codex: its CLI and Codex API components), drops an off provider's reading,
acts on a switch when the settings are saved, and reads a reply defensively;
the title bar shows Claude's pills only while Claude Code is on and a Codex
pill while Codex is on (the Codex API as its own pill only when not
operational, as Claude's API is); PRIVACY.md, the README and app-knowledge
name the host. With Claude Code off: Built-in Tools asks about your sessions,
blocks Claude review and notes Codex review (and Settings' Code review rows
say the same); the recap's Account row reads the D5 line and no Claude
sign-in is read; What's New and its showcase hide what needs Claude Code in
this release (`needsClaude`; each flag is lifted by the phase that brings its
feature to Codex, recorded in that phase's entry: P3.6, P3.10, P4.1, P4.3 and
P4.7; the remote resume page, and the SSH Persistent and Remote Resumable
lines, keep it, since Codex over SSH is outside this release); the registry callout no longer says the Claude accounts still
work. Hello Codex page 1 already read without Claude (unchanged). The partner
terminal line stays (it works beside a Codex session). Left to their phases:
the Sentinel card (P3.9), the log indexing card (P3.12), Ask (row 53, PR 4).
Fix round 1 (the reviews and the ADR-009 thesis check): the on/off the pages
are read by fails closed on settings that cannot be read; each read has an
overall deadline, each provider's page settles on its own, a switch-off or
stop aborts a read in flight, and a second start is ignored; the renderer's
pull answers the app's own window only; no remote text reaches the renderer
(only the app's ids and labels and a known status). Owed: the ADR-009 attack
pass, and a VM walk in Codex-only mode.
Follow-up (the quality review's minor and the VM walk's M1): a burst of
accounts-service changes is acted on once, after it, so each provider's
on/off is read from the settings once per burst rather than once per change
(a settings save in the same turn is that one refresh); What's New's SSH
Persistent and Remote Resumable lines carry the flag with the remote resume
page, since the persistent remote session wraps the remote claude command
and the only agent an SSH session runs in this release is Claude Code.

**P3.5 History and resume.** The claimed session id kept with the tab; exact
resume on relaunch in the same realm; Restart resumes the same conversation
(picking another stays a choice); the picker lists worktree conversations and
names; the statusline after resuming a conversation from an earlier day or
across midnight UTC (the claim re-reads its date folder and finds a resumed
rollout wherever it is: row 38's defect). A staged Sign in again (P3.3)
copies the old folder's `sessions` and `history.jsonl` into the new folder
before the switch, so a conversation from before is found there by id (P3.1
evidence) and counted once by Tokenomics; P3.5 keeps it covered: a restored
tab's `codex resume <id>` of a pre-switch conversation, and the picker
listing it, in the account's new folder. Likely
files: `src/main/session-resume-enrich.ts`, `src/renderer/session-persistence.ts`,
`providers/codex/spawn.ts`, `providers/codex/resume-picker.ts`,
`scripts/lib/codex-resume-picker-lib.js`, `providers/codex/telemetry.ts`,
`SessionHeader.tsx`, `src/main/pty-manager.ts`. ADR-009: yes (launch argv).
SSH radius: yes. The C item "Resume replaces the tab list" (section 7) fits
here.

**P3.6 Account chip and Switch account** (after P3.5). The strip's Codex
account pill with its Switch account menu (inactive accounts greyed, this
computer's sign-in marked "confirm at launch"); the sidebar chip from the
identity; the email-keyed Claude colour overrides migrate into the identity's
colour, and every chip that read them (header, strip, sidebar, launch gate,
remote list) reads the identity (moved here from P3.2, row 7); a switch pins the new account, copies the conversation's rollout
into its folder while both accounts are held, then resumes there, with the
fallback of section 5. Likely files: `SessionStatusStrip.tsx`,
`sidebar/SessionRow.tsx`, `hooks/useSwitchAccount.ts`, `utils/sessionLaunch.ts`,
`accounts-service.ts`, a main-side rollout copy, IPC. ADR-009: yes (a copy
between realm folders inside the resources directory, leases, IPC). SSH
radius: no, unless `pty-manager.ts` changes. Lifts P3.4's `needsClaude` from
the showcase's accounts page (`showcase-pages.ts`) and What's New's "Switch
mid-session." line (`WhatsNewV2Step.tsx`) once a Codex account switches
mid-session, rewording them for both providers.

**P3.7 Statusline segments and settings.** The account chip, duration, and
line counts if Codex reports them (P3.1); the Status Line settings cover them
and the Codex note there is updated. Likely files: `providers/codex/telemetry.ts`,
`SessionStatusStrip.tsx`, `SettingsPage.tsx`. The C item "narrow-window
overlap" fits here.

**P3.8 Model, effort, pricing, compact and plan mode.** The catalogue from the
model registry with Sentinel's coverage check; per-model effort levels; model
and effort changed live with Codex's own command, keeping the conversation;
Compact; Plan mode as a launch option, as Claude has it; live OpenAI prices from the
LiteLLM source Claude uses, the static table as the fallback, and "no price"
kept for anything unpriced. Likely files: `src/renderer/codex-models.ts`,
`SessionDialog/CodexFormFields.tsx`, the strip's controls, `CommandBar.tsx`,
`providers/codex/spawn.ts`, `providers/codex/pricing.ts`,
`src/main/tokenomics/tk-pricing.ts`, `src/main/sentinel/sentinel-models.ts`.
ADR-009: yes (launch argv; keystrokes written into the terminal).

**P3.9 Sentinel for Codex.** Codex version drift against the supported range
raises a finding; flags and the rollout format are checked; the analysis
(today `claude -p`, `src/main/sentinel/sentinel-analysis.ts:158`) runs on
whichever provider is on. With both on it runs on the provider the "Ask
Conductor runs on" setting names (question 1, decided: OD27 M4).
Likely files: `src/main/sentinel/*`, the Sentinel page and dot,
`providers/codex/discovery.ts`. ADR-009: yes (a new CLI run). The onboarding
Transparency page's Sentinel card still says it watches Claude Code updates
and spends Claude tokens (left by P3.4): it says what Sentinel watches and
runs on once this lands.

**P3.10 Activity, attention, Watchdog and hooks.** Codex `notify` and hook
events feed the attention dot, waiting-for-input, the busy sweep and the sleep
moon; the Hooks gateway and notification rules route them; the Watchdog is
armed for local Codex sessions with Codex's own patterns (still opt-in and off
by default). Likely files: `providers/codex/spawn.ts`, the hooks gateway,
`src/main/watchdog/*`, `src/main/pty-manager.ts`, `stores/activeStore.ts`,
`HooksGatewaySection.tsx`. ADR-009: yes (launch argv, a loopback listener,
automated input). SSH radius: yes. The C item "untracked local Claude spawn"
(section 7) is in the same part of `pty-manager.ts` as the Watchdog's local
arm site, so it is fixed here. Lifts P3.4's `needsClaude` from the showcase's
watchdog page and What's New's "Session Watchdog." line once the Watchdog
arms for Codex.

**P3.11 Extra CLI arguments.** Claude's field and IPC character guard for
Codex, rejecting the flags the app manages (model, effort, permissions, MCP,
resume) and any setting that changes the account, provider or endpoint. Likely
files: `src/shared/types.ts`, `CodexFormFields.tsx`,
`src/main/ipc/pty-handlers.ts`, `providers/codex/spawn.ts`, `pty-manager.ts`.
ADR-009: yes. SSH radius: yes.

**P3.12 Logs and GitHub context.** Each realm's rollouts indexed for Logs
(history, search, transcript), realms never crossing; the Logs tool live on
Codex tabs; the GitHub panel's session context reads the session's realm
rollouts. Likely files: `src/main/logging/*`, `session-capabilities.ts`,
`CommandBar.tsx`, `src/main/github/session/transcript-loader.ts`,
`pty-manager.ts` (run registration). ADR-009: yes (paths inside the resources
directory, IPC). SSH radius: yes. The onboarding Transparency page's "Index
conversation logs" card still names only Claude's transcripts (left by
P3.4): it names what is indexed once Codex's are.

**P3.13 Multi Spawn and Quick Start.** N copies of a Multi Spawn Codex config,
one lease each; Quick Start with Codex; a test on the Codex path. Enforcing the
one-at-a-time rule in main also closes that C item. Likely files:
`sidebar/QuickStartPanel.tsx`, `sidebar/MultiSpawnControl.tsx`, the launch gate
and leases. ADR-009: yes (the launch gate).

**P3.14 Usage follow-up: Codex credits.** A credits row on a Codex card once
P3.1 shows the unit, as Claude's card has one; the known issue removed. Likely
files: `AccountUsagePanel.tsx`, `providers/codex/usage.ts`,
`providers/codex/rate-limits.ts`. ADR-009 only if the read itself changes
(ADR-022's bounds). If no account P3.1 can use shows a credits figure, the row
is built from the credits fields the supported versions' schema declares
(`tests/fixtures/codex/app-server/<version>/usage-schema.json`) and proved at
release on an account with credits the owner provides (as for row 15); if the
schema does not say the unit, the known issue stays and the row goes to the
owner as a section 19 record.

**P3.15 Terminal verification.** On the VM with real Codex 0.155.1: a Codex
session in the Services snapshot; Alt+V image paste reaching Codex (and the tip
fixed); copy, paste, scrollback and mouse re-captured
(`tests/fixtures/codex/tui-trace.txt`); channel rules delivered into the Codex
terminal. On Windows, Codex 0.155.1 under workspace-write with the unelevated
sandbox refused a file edit (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 5): P3.15 checks that the app's
default sandbox settings let a Codex session edit files. A failure becomes a
fix in this phase with its own reviews, and its own ADR-009 pass if it touches
a listed path.

**P3.16 PR 3 records and user-facing sweep.** App knowledge (with known
issues), tips, tour and Feature Guide, the changelog entry, the user guide,
`PRIVACY.md`; the `CONTEXT.d/` fragment; the WP1 ledger and traceability; the
PR body, the ADR-009 verdict and the SSH matrix.

## 9. PR 4 outline

After PR 3, one PR at a time. Less detail here; PR 4 gets its own phase plan
when PR 3 is complete.

| Phase | Rows | ADR-009 | SSH radius | State |
|---|---|---|---|---|
| P4.1 Agent Canvas from Codex: the tools on Codex's bound `/mcp` session, roots, instruction delivery, the live loop | 51 | Y | Y if `pty-manager.ts` changes (the canvas roots and `--plugin-dir` are wired there, `pty-manager.ts:4699-4727` and `:4853`) | APPROVED |
| P4.2 Browser and vision tools for Codex | 52 | Y | N | APPROVED (a one-line notice to the owner, section 10) |
| P4.3 Ask Conductor on Codex: a help workspace Codex reads (`AGENTS.md`), the opening question on a Codex launch; with both on, the Settings, General row "Ask Conductor runs on" (Claude Code by default), the dock row's provider type badge, and the provider read again when a closed Ask tab is revived | 53 (and the Ask part of 14) | Y | Y if `pty-manager.ts` changes | APPROVED (both on: OD27 M4) |
| P4.4 Memory and Codex logs | 55, 56 | Y | N | APPROVED |
| P4.5 Cloud Agents with `codex exec` | 57 | Y | N | APPROVED |
| P4.6 Codex web session; the artifacts record | 58 | Y | N | Web session: APPROVED. Artifacts: the owner signs a section 19 record |
| P4.7 Insights for Codex: a Conductor-native report, run with `codex exec`; a mockup on the Agent Canvas before the build | 68 | Y | N | APPROVED (a one-line notice to the owner, section 10) |
| P4.8 CI: `ubuntu-latest` in the test matrix; real-CLI conformance at the minimum, pinned and release-candidate versions | 59, 60 | N | N | APPROVED |
| P4.9 E2E mode matrix: restart, enable/disable, a real launch | 67 | N | N | APPROVED |
| P4.10 Qualification and owner-run gates; traceability to evidenced; the verification owed by the 20 DONE rows | 15, 16, 66 | N | N | Owner action first (OD20 D8: hosts, disposable identities, timing) |
| P4.11 Final user-facing sweep, the "Beta" labels removed, the screenshot recapture | 54 | N | N | APPROVED |

The 15 rows: 15, 16, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 66, 67, 68.

Notes that bind the build:

- **P4.3.** Ask's opening question rides the Claude launch today
  (`askConductor.ts`); a Codex launch needs its own path, which is launch
  argv, so the ADR-009 pass and, if `pty-manager.ts` changes, the SSH matrix
  apply. With both on (OD27 M4): the Settings, General row "Ask Conductor runs
  on: Claude Code / Codex", shown only while both are on, Claude Code by
  default, never rewritten when a provider is turned off; the dock row wears
  the provider's type badge while both are on; and a closed Ask tab that is
  revived reads the provider again rather than keeping the one it was opened
  with (`askConductor.ts:178-208` keeps it today).
- **P4.1, P4.3, P4.7: P3.4's showcase flags.** Each lifts `needsClaude` from
  what it brings to Codex and rewords it for both providers: P4.1 the Agent
  Canvas page and What's New line; P4.3 the Ask Conductor page and line and
  the 2.0 set's "A guide that answers back." line; P4.7 the "Insights." line.
  The remote resume page and the SSH Persistent and Remote Resumable lines
  keep their flag (Codex over SSH is outside this release).
- **P4.6.** WP1 design principle 4 says the app does not copy credentials.
  Claude's SSO path copies claude.ai cookies from a browser the app launches,
  so P4.6 builds the in-app sign-in window only; the cookie path goes to the
  owner only if a Codex account turns out to need it.

## 10. Unresolved UX decisions

### How each candidate was checked

| Row | Check made | Conclusion |
|---|---|---|
| 52 Browser and vision tools | `conductor-mcp-server.ts:911-913` withholds vision from Codex on a call of 2026-07-02 worded "Claude-only for now"; `:1042` withholds `open_in_app_browser` to match. A Claude session gets both. The later owner decisions (the 2.1.1 gate of zero unsupported shared features; OD26 P1) end a "for now". No record asks to keep them Claude only | **Settled by parity.** A one-line notice to the owner, not a question: Codex sessions get the vision and in-app browser tools in PR 4. |
| 53 Ask Conductor | Ask is a real Claude session (`askConductor.ts:255` pins the provider; `help-workspace.ts` stages a `CLAUDE.md`), blocked with Claude Code off (`askConductorGate.ts`). Design section 2: the app works fully in Codex-only mode | **Codex only: settled** (Ask runs on the one provider that is on). **Both on: decided by the owner** on 2026-09-27 (OD27 M4, option B), below. There was no Claude behaviour to copy (OD26 P1, second case). |
| 58 Web sign-in and artifacts | `src/main/account-web/artifacts.ts` opens claude.ai artifacts as an account; `account-pane.ts` gives the browser pane an account surface on claude.ai; the checklist's limits: nothing assumes a CLI sign-in gives ChatGPT browser cookies or an artifacts equivalent | **Web session: settled by parity** (chatgpt.com in the pane's account surface, signed in per Codex account). **Artifacts: not a UX choice.** No Codex equivalent is known (the checklist assumes none), so this is a section 19 record for the owner to sign, with the command lists of 0.153.4 and 0.155.1 as its evidence (P3.1). Should P3.1 find an equivalent, parity settles it instead. |
| 68 Insights | `insights-runner.ts:234-237` types Claude Code's own `/insights` into a terminal and reads the report it writes; `InsightsPage.tsx:277-296` tells a Codex-only user that Insights come from Claude sessions. The parity reset of 2026-09-26 resolved it in its "Resolved by parity" list (sessions batch): a Conductor-native Codex report, run with `codex exec`; it was not one of that day's open questions | **Settled by parity (2026-09-26).** A one-line notice to the owner, not a question: Insights gets a Codex report the app makes with `codex exec`, shown in the page's existing layout, figures and run history, on the account's own Codex allowance as Claude's report uses Claude's. A mockup goes on the Agent Canvas before the build (P4.7), made from `src/renderer/components/InsightsPage.tsx`, `src/main/insights-runner.ts` and `src/main/insights-cross-account.ts` (ADR-013). |
| 69 Plan mode | Claude's launch options include "Plan mode" (`claude-cli-options.ts:85`), a launch option only; the Codex form offers permission presets only (`CodexFormFields.tsx:162-170`); the capability leads say Codex documents a plan command | **Decidable by parity.** Codex gets Plan mode as a launch option, as Claude has it (P3.8), once P3.1 confirms the command on the supported versions. If it is absent, that is a section 19 record, not a UX question. |

No unresolved UX decisions remain. Question 1 below was decided by the owner
on 2026-09-27: option B, approved as drawn (`docs/wp1/owner-decisions-2026-09-27.md`,
M4; canvas "Ask Conductor provider choice" v1, no notes).

### Question 1 (row 53), resolved: B. Which assistant runs Ask Conductor when both are on?

With Claude Code and Codex both on, should Ask Conductor run on Claude Code,
on Codex, or on the user's choice?

- **A.** Claude Code whenever it is on; Codex only when Claude Code is off. No
  new control. This is what every current user has today.
- **B.** A setting beside "Show Ask Conductor" in Settings: "Ask Conductor runs
  on: Claude Code / Codex", Claude Code by default. A Codex-only install uses
  Codex without asking.
- **C.** A choice in Ask's own header, asked the first time Ask opens with
  both on, then remembered.

**Recommendation: B.** Nothing changes for current users, a user who would
rather spend Codex's allowance on help questions has one quiet setting, and no
prompt stands between a user and their question. A is the fallback if the
owner wants no new control. (The proposal noted on 2026-09-26 was C; this plan
recommends B for the reasons above.) The answer also decides which provider
runs Sentinel's analysis when both are on (P3.9).

**Decided: B** (owner, 2026-09-27; OD27 M4). The row shows only while both
providers are on; while both are on the dock row wears the provider's type
badge; turning a provider off never rewrites the saved choice. Built in PR 4.

Mockup: needed for B or C (a new control); none for A. Mock from the current
code: `src/renderer/components/SettingsPage.tsx:254-272` (the Show tips and
Show Ask Conductor switches), `src/renderer/stores/settingsStore.ts:274, 453`
(`showAskConductor`), `src/renderer/components/sidebar/AskConductorDock.tsx`
(the dock and its title text), `src/renderer/lib/askConductor.ts` and
`askConductorGate.ts` (the launch and the Claude-off block),
`src/main/help-workspace.ts` (the help workspace, which Codex would read
through `AGENTS.md`).

### One-line notices to the owner (not questions)

- Row 52: Codex sessions get the vision and in-app browser tools in PR 4; the
  "Claude-only for now" call of 2026-07-02 ends with the parity release.
- Row 68: Insights gets a Codex report the app makes with `codex exec`
  (resolved by parity 2026-09-26); its mockup comes to the Agent Canvas before
  it is built.

### Owner actions that are not UX decisions

- Row 15: hosts, disposable test identities and timing for the owner-run gates
  (OD20 D8).
- Row 58: sign (or reject) the artifacts section 19 record.
- Any section 19 record P3.1 raises (rows 22, 36, 41, 61, 69), one per row.
- Row 17 (P3.14): a Codex account with credits, for the live credits check;
  without one, the P3.14 fallback applies.
- Section 7: a disposition for each C defect not fixed; the security report;
  the desktop attestation; the word to merge each PR.

## 11. Nothing silently deferred

All 75 rows are in scope for 2.1.1; each ends DONE or with an owner-signed
section 19 record. What is outside 2.1.1, and the record that says so:

- **SSH Codex sessions**: the only agreed exclusion (OD26 P1); refused in main
  and said so in the app (PLAN, "Codex is local-only in 2.1.1", owner
  2026-09-24).
- **Device-code sign-in**: off (OD26 U3, WP1.41). Row 5 is DONE as off.
- **App-server methods beyond the usage read** (`model/list`, `account/read`):
  WP1.41 is unchanged for everything but the usage read (OD27 M2). So the
  setup page shows no email (OD26 U2) and the model catalogue does not use
  `model/list` (row 39).
- **Manual Tokenomics attribution**: none (PLAN, usage track, MP10).
- **Fleet, Orchestrator, Supervisor and Proxy; other providers; destructive
  account-data deletion**: outside 2.1.1 by the owner's WP2 scope (PLAN,
  2026-09-23) and the WP1 design's exclusions (Fleet and Proxy are 2.2
  planning items, aicc_planning#12 and #64).
- **Codex artifacts (row 58)** and **any capability P3.1 finds absent**: not
  deferred. They are in scope; each ends DONE or with an owner-signed section
  19 record.

Recorded elsewhere, and not Codex parity rows: End on a container session
without a saved sudo password (owner decision 2026-09-25, in
`CONTEXT.d/2026-09-25-wp2-accounts-surface-and-guidance.md`); Windows ACL
hardening of the managed folders (PLAN, aicc_planning#103); Ask Conductor's
action surface and data reach, for both providers (aicc_planning#79); the
Watchdog and user-typed banners, for both providers (aicc_planning#72); an
agent-drivable in-app browser (aicc_planning#27, 2.3).
