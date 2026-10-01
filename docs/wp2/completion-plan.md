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

- 75 rows: **52 DONE, 12 PARTIAL, 11 OPEN** (recounted after P3.15, with section 4's P3.2 to P3.15 rows brought current from their phase records;
  they agree with the parity checklist).
- The 23 rows not DONE, by gap: **implementation 12, verification 6, owner 5** (rows 15 and 58, an owner action and a record to sign; rows 22, 41 and 63, each built as a default pending the owner's decision, section 10). Row 53
  moved from owner to implementation when the owner decided it
  (`docs/wp1/owner-decisions-2026-09-27.md`, M4).
- By PR: **8 in PR 3, 15 in PR 4**. No row changes package. The Ask Conductor
  part of row 14 goes with row 53 into PR 4, because it is the same change.
- 47 DONE rows still owe verification. The 27 built or verified in PR 3 (rows 7, 8, 10, 17, 20, 24, 28, 31, 32, 36, 37, 38, 39, 40, 42, 43, 44, 46, 47, 61, 62, 65, 69, 70, 71, 72 and 73) owe their VM checks under
  PR 3's gate 6 (section 6). The other 20 (rows 1, 2, 3, 4, 6, 9, 12, 13, 18, 21, 23, 25,
  27, 29, 33, 48, 49, 50, 64 and 74) owe real-CLI, per-OS or packaged
  verification, recorded in PR 4 and closed at release level. The other 5
  DONE rows (5, 19, 26, 30, 75) owe nothing.
- Row 17 was counted PARTIAL here, from the code, while the checklist marked
  it VERIFIED; the checklist marked it PARTIAL too until P3.14 (c65b359e) built
  the Codex credits row and removed the known issue in
  `src/shared/app-knowledge.ts`, and now marks it VERIFIED (mocked) with its
  verification owed. The checklist
  moved rows 52, 68 and 69 from OWNER to MISSING, since parity settles them
  (section 10); row 69 is now built (P3.8).
- Genuinely unresolved UX decisions: **three**, each built as a default pending the owner's decision: row 41 (P3.8 round 1, caef0d42: Codex has no one-line
  model or effort command; section 10, question 2) and row 22 (P3.6 finding
  V3: a declined confirm after a Switch restores the previous account; question 3) and row 63 (P3.10: Codex asks the user to review the app's hooks once per account; question 4). The one before them (row 53, both providers on) was decided by
  the owner on 2026-09-27 (option B; OD27 M4). Section 10.
- PR 3 waits on the owner for those three decisions and for the owner actions
  in section 10; nothing in it is blocked from being built.

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
| 7 | Identity editing after creation (name, colour, link, unlink, group) | DONE (P3.2, 65612489, b4a5b665; the colour migration in P3.6, 57ce396a; mocked): the identity editor opens from every row's chip (name, colour, group, Link, Unlink); the chips read the identity's colour | Canvas 2026-09-26, "Accounts: identities across providers", option B: the editor opens from any row's chip, groups stay (WP1.40) | verification: an owner screenshot check of the chips' colours | 3 |
| 8 | One Accounts surface | DONE (P3.2, 65612489): one row component for both providers (AccountRow); the VM screenshots approved 2026-09-28 | The same canvas; design section 10; WP1.39 | verification: packaged | 3 |
| 9 | Launch and resume in the exact account | DONE | PLAN A10, commit 4 | verification: a restored tab keeps its managed account, per OS | 2, v4 |
| 10 | Lifecycle blockers and archive | DONE (P3.2): a refused inactivate or archive names each session holding the account, with Go to; Archived (N) with Restore | The same canvas: blockers name each consumer with Go to; "Archived (N)" with Restore (design 5.3) | verification: real CLI; packaged | 3 |
| 11 | Staged re-authentication (WP1.52) | PARTIAL (P3.3): Sign in again is offered while signed in too, staged in a new journalled folder with the conversation history carried over, and the account moves only once the new sign-in is verified | Parity: Claude's "Refresh sign-in" works while signed in; WP1.52; PLAN "Out of this PR" | verification (owner action): a second real sign-in on the VM, file and keyring stores, proving the old folder's sign-out never signs the new one out | 3 |
| 12 | Upgrade question and the read-only sign-in check | DONE | OD26 U1, U2 | verification: real 0.153.4 and 0.155.1 | 2, v4 |
| 13 | Hello Codex | DONE | Canvas 2026-09-24 (v1) and the commit 6 canvas; HCS | verification: per OS | 2, v4 |
| 14 | Codex-only mode, no Claude noise | PARTIAL (P3.2, P3.4; mocked): with Claude Code off no Claude pills, no Claude status reads and no Claude sign-in prompts; the owner approved the P3.4 screens 2026-09-28. Left: Ask (row 53) and the guide cards each later phase unlocks | Design section 2 (Claude is not a prerequisite); OD27 M1 D5 (a provider that is off shows one muted line or nothing); parity | implementation (Ask with row 53; each card with its phase); verification: the cards on the VM | 3 (Ask part: 4) |
| 15 | Owner-run gates (native keyring, sign-ins with real accounts, packaged smoke) | OPEN | OD20 D8 (blocks merge, not implementation); WP1.11, WP1.64, WP1.72 | owner: hosts, disposable test identities, timing; then verification | 4 |
| 16 | WP1 traceability | PARTIAL: items still `planned` | OD20 D9; WP1.70, WP1.73 | verification: items move to evidenced as the evidence lands | 4 |

### B. Account summary, usage footer, switching, Tokenomics

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 17 | All-accounts usage page | DONE (usage track MP3, MP4, MP8, screens approved; P3.14, c65b359e; mocked): a Codex card on paid credits shows a Credits row under its bars, in Codex credits (a count, not money): "N credits" or "Unlimited", placed and styled as Claude's row, from the live, fresh-read and last-seen reading alike; the known issue is removed (`rate-limits.test.ts`, `account-usage-panel.test.tsx`, `provider-account-usage.test.ts`, `codex-usage-read.test.ts`) | OD27 M1, M2; ADR-022 and ADR-023 (the credits count kept from the read, which widens ADR-022 bound 8, and the carry marks file `carry-marks.json`; the owner confirms both on return); credits: parity, the unit from P3.1's evidence (recorded with the usage plan, 2026-09-27) | verification: the VM live credits check (PR 3 gate 6); the owner's screenshot review; the PR-level ADR-009 pass; macOS, Linux, packaged | 2; 3, v4 |
| 18 | Session-strip meters | DONE | OD27 M1 (D2, D3); labels from `window_minutes` (decided by design, 2026-09-26) | verification: a 0.155.1 rollout fixture from a real session; a real-CLI run | 2, v4 |
| 19 | Strip cost wording | DONE | "API-equivalent estimate" wording (decided by design, 2026-09-26) | none | 2 |
| 20 | Account chip on the strip and in the sidebar | DONE (P3.6, 57ce396a, 68d00f62, 4439d7e2; mocked): a Codex session's account chip on the strip and its sidebar card, from the identity; Claude's chips read the identity's colour | Canvas 2026-09-26, "Switching a running Codex session's account": the strip's Codex account pill and its Switch account menu; the footer's label rule (a Codex identity shows its name); parity for the sidebar | verification: the VM check of W1; the owner's screenshot review; the SSH live matrix at PR 3's head | 2; 3 |
| 21 | Multi-account footer | DONE | Canvas 2026-09-26 (footer, option B); OD27 M1 | verification: real CLI, packaged | 2, v4 |
| 22 | Switch the account of a running session | PARTIAL (P3.6, 8274b3d1, 4439d7e2, bb99d2da; mocked): Switch account lists the Codex accounts, and a pick restarts the session on the new account with its conversation carried over. A declined confirm after a Switch restores the previous account, the default pending the owner's decision (section 10, question 3) | Canvas 2026-09-26 (as row 20): keep the conversation; copy its rollout into the new account's folder, then `codex resume` there | owner (question 3); verification: the real-account resume and the real-CLI walk on 0.153.4 and 0.155.1; the SSH live matrix | 3 |
| 23 | Choose the account at launch | DONE | Commit 6 canvas, 2026-09-24 | verification: per OS | 2, v4 |
| 24 | Running sessions per account | DONE (P3.2, 65612489): "N running" on the account row | Canvas 2026-09-26 ("N running" pill on the row) | verification: real CLI | 3 |
| 25 | Tokenomics reads managed realms and `~/.codex` | DONE | OD20 D10; OD26 U3 | verification: real rollouts | 2, v4 |
| 26 | Tokenomics attribution and filters | DONE | Canvas 2026-09-26 (Tokenomics, option A); OD27 M1 | none | 2 |
| 27 | Subagent collision | DONE | The #307 fix (`7fc96639`) | verification: a real 0.155.1 subagent rollout | 2, v4 |
| 28 | Codex pricing | DONE (P3.8, 260d4abc; round 1, caef0d42): live OpenAI prices from the LiteLLM fetch Claude's prices come from, the static table as the fallback, "no price" for anything neither prices; Tokenomics prices a Codex turn by its model's exact id, as the strip does. A real fetch on the VM (3ff8c361) priced all six catalogue models | PLAN usage track MP11; parity: Claude's prices come from the live LiteLLM fetch with a fallback, and the same fetch extends to OpenAI models (resolution recorded 2026-09-26) | verification: round 1 on the VM (an unpriced Codex model reads "no price" in Tokenomics too) | 2; 3 |
| 29 | Plan type | DONE | OD27 M1 | verification: macOS, Linux, packaged | 2, v4 |
| 30 | Tokenomics totals split by provider | DONE | Canvas 2026-09-26 (Tokenomics, option A) | none | 2 |

### C. Sessions, statusline, model, Sentinel, Watchdog, status

| # | Feature | Status | Settled by | Gap | PR |
|---|---|---|---|---|---|
| 31 | Logs history, search and transcript | DONE (P3.12, d86fd80f and its fixes; mocked; VM at ff7be273 (WINDOWS_1, real Codex 0.155.1 and 0.153.4), and its re-check with the fixes: indexing, search, the switches for new sessions and a Claude session unchanged PASS): a local Codex session's run is recorded under the gates a Claude run has; its transcript is the rollout its own watcher claims in its own realm (the Codex log binder: held until the run is recorded, exact or heuristic, let go when the claim is, never a conversation another tab holds), tailed with the Codex normalizer by the binding's stored format; the Logs page, search, the per-session pane and the Logs button (live on a Codex tab: ADR-018 D3's dimmed Codex tool ends); a Codex config's Index conversation logs field; a logging switch turned off stops indexing the running sessions it covers, both assistants, every launch reads the switches as saved, and turning one on applies to sessions started after it; what a Codex session writes while it is not indexed is never indexed, whichever tab later resumes the conversation; a new run continues a conversation the same session indexed before, from where it was read (Codex; Claude's resume indexes its transcript again, recorded for P3.16); a Codex tail reads only the file its watcher claimed; a user_message of another kind than plain is not the user's words; a Codex run is recorded once the indexing notice naming Codex was seen, which a Codex user who saw only the earlier notice is shown once more | Parity: index each realm's rollouts; realms never cross | verification: the VM re-check of the fixes (PR 3 gate 6); the owner's screenshot review; the fresh PR-level ADR-009 pass (P3.12 is quarantined under ADR-009: its bounded rounds are exhausted); the SSH live matrix at PR 3's head (no Codex case: a Codex session over SSH is refused); the native SQL tests in CI (the identity column, and the prior bindings a continuation reads) | 3 |
| 32 | Resume picker | DONE (P3.5, 44729f29 and its fix rounds; mocked; VM c2c42e22; the name file P3.12, d86fd80f and its fixes; mocked; VM at ff7be273 (WINDOWS_1, real Codex 0.155.1 and 0.153.4), and its re-check with the fixes: the name file only at an exact claim, and in the picker after the tab closed, PASS): every git worktree's conversations, named and started in their own worktree; a name given to a Codex session is written next to the rollout it is exactly on (a rename, or a remembered name at the exact claim), inside its realm and never through a link, and Codex's picker leads with it, as Claude's does; the picker titles a conversation by its first user message as the index reads it, never the context Codex injects (AGENTS.md, the environment); the name file is written only into the realm's real day folder (the realm's real path taken before its folders are walked), a new file elsewhere, or one whose write fails, taken back (a path check: see P3.12's limits) | Parity | verification: the VM re-check of the fixes (PR 3 gate 6); the owner's screenshot review; the fresh PR-level ADR-009 pass (P3.12 is quarantined under ADR-009: its bounded rounds are exhausted); the SSH live matrix at PR 3's head (no Codex case: a Codex session over SSH is refused) | 3 |
| 33 | Resume in the exact realm | DONE | PLAN A10 | verification: real, realm B never lists realm A | 2, v4 |
| 34 | Exact resume on app relaunch | PARTIAL (P3.5, 90a717df; mocked; VM c2c42e22): a restored session resumes its own conversation in its own realm, bypassing the picker | Parity: resume by the claimed session id, `codex resume <id>` in the same realm | verification: the SSH live matrix; a conversation carried over by a staged Sign in again on the VM (owner action) | 3 |
| 35 | Restart and Switch keep the conversation | PARTIAL (P3.5, 90a717df, Restart; P3.6, 4439d7e2, Switch; mocked): Restart resumes the conversation the session kept (VM c2c42e22); a Switch carries it into the new account and resumes it | Parity (Claude's Restart resumes); canvas 2026-09-26 for Switch | verification: the Switch half on the VM with a real CLI (row 22) | 3 |
| 36 | Statusline segments | DONE (the account chip in P3.6, 68d00f62; Lines changed and Duration in P3.7, 5de7a4c4, 9f2bd164; mocked) | Parity (line counts: evidence first; section 19 if Codex reports none) | verification: the VM run and the owner's screenshot review; the real-CLI line count and a TUI resume's Duration on 0.153.4 and 0.155.1 | 3 |
| 37 | Statusline settings | DONE (P2; P3.7, 5de7a4c4, 9f2bd164; mocked): the settings apply to Codex, and Lines changed and Duration show for a Codex session | Parity | verification: the VM screenshot of the Status Line tab with Codex on, both themes | 2; 3 |
| 38 | Statusline after resuming an old rollout | DONE (P3.5, 28f42af2, 90a717df; mocked; VM c2c42e22): the claim re-reads its date folders on every poll and finds a resumed conversation wherever it is | Parity | verification: a session crossing midnight UTC on a real CLI | 3 |
| 39 | Model catalogue | DONE: the registry's Codex models, the list the supported CLIs (0.153.4 and 0.155.1) offer in their own picker, Sentinel's check, and the release gate's Codex half (P3.8, 260d4abc; round 1, caef0d42); P3.9 (3a4ed400; mocked): Sentinel's Codex check compares the registry with the list the installed CLI offers, read from it (`codex debug models --bundled` in an empty folder, no sign-in), naming its version, else the shipped list | Parity: the model registry plus Sentinel's coverage check. Not app-server `model/list`: OD27 M2 allows usage reads only | verification: done on the VM at 7678c433 (`--bundled` accepted on 0.153.4 and 0.155.1, the same list as the plain command, no connection); the gpt-5.2 notice to the owner stands (section 10); ADR-009: P3.9 quarantined, a fresh pass owed before #626 leaves draft | 3 |
| 40 | Effort | DONE (P3.8, 260d4abc; round 1, caef0d42): each Codex model's own levels, from the CLI's catalogue (0.155.1's are the same, VM); a launch drops a saved effort its model cannot run. The CLI accepts max and ultra at launch on both versions (VM) | Parity | verification: whether the server takes max and ultra (a real sign-in; the CLI does not check at launch) | 3 |
| 41 | Mid-session model and effort | PARTIAL, built as the default pending the owner's decision (P3.8 round 1, caef0d42): on a live session the command bar's model pill types a bare `/model`, only at Codex's ready prompt, which opens Codex's own model-and-effort picker and keeps the conversation; a stopped session keeps the select, applied at its next start | Parity: applied live, keeping the conversation. Codex has no one-line form (VM: `/model <slug>` is sent as a message; there is no `/effort`), so Claude's one-step switch cannot carry over as it is | owner: the default (section 10, question 2); verification: the pill on the VM | 3 |
| 42 | Sentinel | DONE (P3.9, 3a4ed400; mocked): while Codex is on, its version against the supported range (a finding outside it), the live model list (row 39), and a changed version's release notes analysed against its launch flags, TUI, rollout session files and config and account files; the analysis runs on the provider that is on (both on: the one Ask Conductor runs on, Claude Code until PR 4's row); the same panel, dot, Settings section and Transparency card | Parity: version drift, flags and the rollout format checked, with findings; the analysis runs on whichever provider is on | verification: the VM run at 7678c433 (the findings as specified; a Codex-run analysis left config.toml unchanged; the notes read failed, fixed in round 1, e357fe33, with the ADR-009 pass 1 findings); the VM re-check at 82c78680, five of six passed, its bug and the ADR-009 pass 2 findings fixed in round 2, 1f010667); the VM re-check at 84fd2d03, the suspended git left by a fast failure fixed in round 3, 5fd82db8); ADR-009: FINDINGS after pass 3, P3.9 quarantined, a fresh pass owed before #626 leaves draft; the VM re-check at 2499766e: direct route 10/10 clean, npm route 1/15 left a suspended git (round 4 logs the kill's result; an access-denied result is an upstream residual); owed: a completed real analysis (owner) and the owner's screenshot review | 3 |
| 43 | Watchdog | DONE (P3.10, d8f538b1; mocked): armed for a local Codex session (opt-in, off by default, as for Claude) with Codex's own detectors: its usage-limit and sustained server-error cells above the composer, the reset time, a turn running, Codex's own retry; the retry typed only into its ready, empty composer, Enter 300 ms later only when the pane shows it typed; the safeguard check shown unavailable (Codex has no such message). Round 1 (afae03f7): the session header's Watchdog pill shows on a Codex session and counts only the checks Codex has; the Feature Guide, tip and What's New cover it, under the one switch. VM at 6d576634: armed only when switched on, backoff and retry on a server error. Round 2 (5b178c7a): the header pill follows the watchdog live (it showed only after another change); one overload is retried once (an error above a newer turn is an earlier one's). VM at 6b465aef: the pill live on a Codex and a Claude session (R1); one retry per overload (R2); a persistent overload retried without backing off, fixed in round 3 (18029bb0): an episode lasts until two minutes of quiet after a retry, for Claude and Codex alike, so the backoff grows and the cap trips; VM at the round-3b build: a persistent overload backs off 30, 60, 120, 240 and 300 s and gives up, on a Codex and a Claude session, and an error after two quiet minutes starts afresh. Round 4: an episode whose recovering frame was the session's last output settles two minutes after it, and the backoff a retry logs is the one the episode then waits; VM at the round-4 build: a fresh episode after a last-output recovery, the logged backoff equal to the wait | Parity: auto-retry and silence detection; aicc_planning#72 (a CLI without its own patterns reports Watchdog unavailable, never Claude's) | verification: the Watchdog on an SSH Claude session (a persistent overload backing off, in the owner's live SSH matrix); a real usage limit and overload (a working model, owner); the owner's screenshot review; ADR-009's PR-level pass; the SSH live matrix | 3 |
| 44 | Services (PTY integrity) | DONE (P3.15; the VM at c11fb360, 0.155.1 and 0.153.4, re-checked under the bundled ConPTY at 7c52a432): a Codex tab is in the Services snapshot exactly as the Claude tab (bytes, gap 0, columns) | Parity | verification: macOS, Linux | 3 |
| 45 | Provider status pill | PARTIAL (P3.4, aa0411b0, 87ba9c2d; the VM walk PASS at c7f9a34a and f65de184): an OpenAI status pill beside Anthropic's, each read and shown only while its provider is on | Parity: an OpenAI status pill beside Anthropic's, each shown only while its provider is on | verification: the Desktop test gate (owner); macOS and Linux; packaged | 3 |
| 46 | Busy sweep and sleep moon | DONE (P3.10, d8f538b1; mocked): the sweep and the moon on a Codex card as on a Claude card (the moon, as Claude's, with the Watchdog on); the working pill names Codex. VM at 6d576634: the sweep, the pill and the moon on a Codex card | Parity: fed from output and silence | verification: the owner's screenshot review | 3 |
| 47 | Waiting-for-input and attention dot | DONE (P3.10, d8f538b1; mocked): fed by Codex's hooks (once trusted in Codex's review, row 63): an approval request raises the dot, a turn's end raises it after Claude's 60 s idle wait, a prompt or a tool clears it. Deviation: `notify` is not used (the Stop hook marks a turn's end; setting `notify` would replace the user's own). VM at 6d576634: the dot on an approval and 60 s after a turn's end; its bug (a PreToolUse landing after its approval cleared the dot) fixed in round 1 (afae03f7), passed 12 of 12 on the re-check; round 2 (5b178c7a) pairs an approval with its call's tool_use_id; VM at 6b465aef: 12 of 12 approval rounds pulsed, the bad order included (R3); round 3 (18029bb0) pairs an approval with an open call only when its PreToolUse came within 3 s before it; VM at the round-3b build: 12 of 12 approval rounds with the 3 s window. Round 4: the approval keeps that call as its own, so another call's PostToolUse leaves the dot up; VM at the round-4 build: 12 of 12 approval rounds | Parity: fed by Codex `notify` and hooks | verification: an approval request under a working model (owner); the owner's screenshot review | 3 |

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
| 61 | Compact | DONE (P3.8, 260d4abc; round 1, caef0d42): the strip's Compact on a Codex session types Codex's own /compact only at its ready, empty prompt (otherwise it types nothing and says why) and presses Enter only in the same run; the real TUI submits it that way on 0.153.4 and 0.155.1 (VM) | Parity: Codex's own compact command (evidence first) | verification: round 1 on the VM; what a real /compact does to a conversation (a real sign-in) | 3 |
| 62 | Extra CLI arguments | DONE (P3.11, 28739b19; round 1, 057fa776; mocked): a Codex config has the Extra CLI arguments field (the one field, in the Codex section), saved as `codexOptions.extraArgs`; each word is one launch argument after every flag the app sets; one rule refuses, in any spelling and under every alias the supported CLIs give them, the flags the app sets (the working folder and `--worktree` included), the account, provider and endpoint settings, and a word Codex reads as one of its commands; the dialog says why under the field and Save waits; a saved value that is refused is dropped at launch (logged) and the session starts without it; done: the VM run at 919385af (WINDOWS_1, real Codex 0.153.4 and 0.155.1): all five checks PASS on both versions (extra arguments on the direct and npm `.cmd` routes, through the picker and on a resume by id; a refused value said in the dialog, Save waiting; refused saved values dropped at launch with a log line, the session starting without them; the Claude Code field with the same dialog check and its launch unchanged), e2e 81; the round-1 re-review (spec, code quality) and ADR-009 pass 2 at 919385af PASS, the P3.11 verdict PASS | Parity: the same field and IPC character guard, plus a block-list of the flags the app manages and of any setting that changes the account, provider or endpoint | verification: the owner's screenshot review of the field and its message, both assistants, both themes (gallery `.ccc-canvas/screens/p3.11-919385af/`); the SSH live matrix at PR 3's head (no Codex case: a Codex session over SSH is refused); the PR-level ADR-009 pass on PR 3's final head | 3 |
| 63 | Hooks gateway and notification rules | PARTIAL, built as the default pending the owner's decision (P3.10, d8f538b1; mocked): each local Codex launch gets six command hooks running the app's forwarder, which posts each event to the Hooks gateway as a Claude http hook does (loopback, the session's token, the size cap, redaction); Codex asks the user to review them once per account. Notification rules: the one rule on a hook event (Attention Pulse, Claude's idle Notification, filter-only) gets from a Codex idle mark what Claude's idle_prompt gives it (round 1). Round 1 (afae03f7) fixes ADR-009 pass 1 (the forwarder never through an environment proxy; no PowerShell call of a path it reads as a wildcard or cmd.exe expands; the hook folders in the app's own data folder, owner-only, read only at their real path) and gives an npm-installed Codex its hooks from a resources folder with a space (a checked plain-path copy). VM at 6d576634: all six events at the gateway on both versions and routes, the review once per account; the round 1 re-check passed V3 (the plain-path copy through the npm shim from the default resources folder, reused across starts) and S6 (a user's own hooks still run). Round 2 (5b178c7a): both plain-copy folders owner-only, bigint file ids, the root hardened once a run; VM at 6b465aef: both plain-copy folders and the root owner-only (R4), the picker told only of tabs on the same account (R10). Round 3 (18029bb0): a hook folder the app did not make this run is used only once it belongs to the user, and the root is hardened again when made again in the run. VM at the round-3b build: a hook folder from an earlier run used once it is the user's (an admin account). Rounds 3b and 4: the hook wrapper and the picker resolve their helpers from fixed locations; the hook folders are prepared asynchronously and only while Codex is on, by one call of the owner-only rule (on Windows one PowerShell call), used only when read back as this user's alone, and checked again before first use; VM at the round-4 build: the wrapper, the folders' real rights, the app's start with Codex on and off, an early launch that waited and got its hooks. Round 5: any folder name makes the round trip exactly, a name ending in a dot or a space is refused, a failed preparation waits five minutes before the same folders are tried again, and a launch waits only while the Hooks gateway listens (and for the wiring) | Parity: route Codex `notify` and hook events. Codex reviews hooks given at launch, which Claude does not, so the trust step cannot carry over as it is | owner: the default (section 10, question 4); verification: the VM re-run of the rule's real round trip at the final build; a hook folder from an earlier run on a standard account (VM); ADR-009 on rounds 4 and 5 and the PR-level pass on the final head; the POSIX hook runner; the SSH live matrix | 3 |
| 64 | Partner terminal wording | DONE | P2 | verification: per OS | 2, v4 |
| 65 | GitHub session context | DONE (P3.12, d86fd80f and its fixes; mocked; VM at ff7be273 (WINDOWS_1, real Codex 0.155.1 and 0.153.4), and its re-check with the fixes: a Codex session's commands and edited files, nothing before its first turn, the heading naming Codex, PASS): a Codex session reads the rollout its watcher holds, checked again inside its realm, with Claude's bounded tail, for the unchanged reference scanner and file-signal inspector (`src/main/github/session/codex-rollout-loader.ts`), read only from the realm's real day folder (a path check: see P3.12's limits); both assistants: a recent file shown as plain text, relative to the session's folder when inside it, once per file, under a heading that names the session's assistant; after Switch Account the earlier account's rollout is not read | Parity: read the session's realm rollouts | verification: the VM re-check of the fixes (PR 3 gate 6); the owner's screenshot review; the fresh PR-level ADR-009 pass (P3.12 is quarantined under ADR-009: its bounded rounds are exhausted); the SSH live matrix at PR 3's head (no Codex case: a Codex session over SSH is refused) | 3 |
| 66 | Packaged smoke | PARTIAL: Windows only, an unsigned candidate on a used VM | OD20 D8; WP1.63 | verification (release level; owner hosts) | 4 |
| 67 | E2E mode matrix | PARTIAL | WP1.1, WP1.60 | implementation (restart, enable/disable, real launch cases); verification | 2; 4 |
| 68 | Insights | OPEN: Claude only; Claude's Insights types Claude Code's own `/insights` in a terminal (`src/main/insights-runner.ts:234-237`) | Parity, recorded 2026-09-26 (the parity reset's "Resolved by parity" list, sessions batch; not one of that day's open questions): a Conductor-native Codex report, run with `codex exec`. A mockup comes before the build (section 10) | implementation | 4 |
| 69 | Plan mode | DONE (P3.8 round 1, caef0d42; round 2, f1783110): a "Plan mode" permissions choice, as Claude's launch option: the session starts READ-ONLY and Codex's own `/plan` is typed into its first ready prompt only (never the folder-trust prompt, the user's typing or after a turn), within a bounded wait; otherwise a note says Plan mode is not on and the session is read-only. The pill reads "plan" only while Codex's footer shows its Plan mode | Parity: Claude's Plan mode launch option (`src/renderer/lib/claude-cli-options.ts:85`); Codex has `/plan` on both supported versions and no launch flag for it (VM), so no section 19 record | verification: Plan mode on the VM, 0.153.4's fresh launches included (round 3); the approval flow with a working model (owner-only) | 3 |
| 70 | Image paste | DONE (P3.15, bbcb6ef8; the focused key on the VM at c11fb360, both versions): with the terminal focused Alt+V goes to the CLI and Codex attaches the image itself ("[Image #1]"); with focus elsewhere a Codex session's line is ASCII and typed by the Codex typing rule, its notes in the paste hint (mocked: `codex-image-paste.test.ts`, `alt-v-image-route.test.tsx`); the tip and the Tips and Shortcuts card say both | Parity | verification: the wrapped line on the VM (round 1); real Claude Code's own Alt+V; macOS, Linux | 3 |
| 71 | Copy, paste, scrollback, mouse | DONE (P3.15, bbcb6ef8; the VM at c11fb360): copy, paste (Ctrl+V and right-click, bracketed) and mouse (Codex sets no mouse mode) as Claude's; scrollback: a local Codex session on Windows runs under node-pty's bundled ConPTY, which keeps it (122 lines and the wheel scrolling in the VM's in-app trial, against 38 and an inert wheel under the system ConPTY), with the system ConPTY as the fallback (mocked: `bundled-conpty.test.ts`, `pty-conpty-per-provider.test.ts`) | Parity | verification: re-checked packaged at 7c52a432; round 1's spawn-time fallback, a Codex that quits leaving a process attached, the TUI trace fixture replaced; macOS, Linux | 3 |
| 72 | Multi Spawn and Quick Start with Codex | DONE (P2; P3.13, 3e45825d; round 1, 54422e2a; round 2, b86bed6d; round 2b, 86e3efb9; round 3, f16a756a; mocked): a Codex config that is not Multi Spawn runs one copy at a time in the sidebar (P2) and now in main at `pty:spawn` for NEW copies (a session that already runs, restored at this start or accepted in this run, keeps its right through a Restart, a Switch and a reattach), a new copy refused with the typed `already-running` before an account is prepared or leased; N copies of a Multi Spawn Codex config are N processes, each on its own account lease, a copy ending or closing letting go of its own lease only; Quick Start launches a Codex pin, with its x N control, blocked start and select lock, as a Claude pin's (`pty-spawn-one-at-a-time.test.ts`, `pty-spawn-one-at-a-time-rights.test.ts`, `codex-multi-spawn-leases.test.ts`, `multi-spawn-codex.test.tsx`) | Parity: N copies with one lease each; Quick Start | verification: the VM check (PR 3 gate 6) | 2; 3 |
| 73 | Channel rules delivery | DONE (P3.15; the VM at c11fb360, re-checked under the bundled ConPTY at 7c52a432): a rule's envelope reaches Codex's composer bracketed with no Enter, and its rollout verbatim after Enter; the ledger records it for both sessions | Parity | verification: macOS, Linux | 3 |
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
  P3.5, P3.6, P3.10, P3.11 and P3.12 edit `pty-manager.ts`.
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
6. **Known defects settled.** The six C items in the checklist's P2
   acceptance section (the narrow-window overlap of the partner label, the
   renderer-only one-at-a-time rule, Resume replacing the tab list while its
   prompt is open, a session file written while the resume prompt is
   unanswered, a launch needing a dialog while that prompt is open, the
   untracked local Claude spawn) and the Codex statusline's
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
| P3.6 Account chip and Switch account | 20, 22 | Y | Y | APPROVED |
| P3.7 Statusline segments and settings | 36, 37 | N | N | APPROVED |
| P3.8 Model, effort, pricing, compact, plan mode | 28, 39, 40, 41, 61, 69 | Y | N | APPROVED |
| P3.9 Sentinel for Codex | 42, 39 (live read) | Y | N | APPROVED |
| P3.10 Activity, attention, Watchdog and hooks | 43, 46, 47, 63 | Y | Y | APPROVED |
| P3.11 Extra CLI arguments | 62 | Y | Y | APPROVED |
| P3.12 Logs and GitHub context | 31, 32 (the name file), 65 | Y | Y | APPROVED |
| P3.13 Multi Spawn and Quick Start | 72 | Y | N | APPROVED |
| P3.14 Usage follow-up: Codex credits | 17 | Y (the read keeps three more fields; ADR-023) | N | APPROVED |
| P3.15 Terminal verification | 44, 70, 71, 73 | Y (the scrollback fix builds the Codex PTY with a new option and starts OpenConsole.exe); PASS at pass 2 | Y by file (`pty-manager.ts`; no SSH path changed) | APPROVED |
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
lines, keep it, since Codex over SSH is outside this release); the registry
callout no longer says the Claude accounts still work. Hello Codex page 1
already read without Claude (unchanged). The partner terminal line stays (it
works beside a Codex session). Left to their phases: the Sentinel card
(P3.9), the log indexing card (P3.12), Ask (row 53, PR 4).
Fix round 1 (the reviews and the ADR-009 thesis check): the on/off the pages
are read by fails closed on settings that cannot be read; each read has an
overall deadline, each provider's page settles on its own, a switch-off or
stop aborts a read in flight, and a second start is ignored; the renderer's
pull answers the app's own window only; no remote text reaches the renderer
(only the app's ids and labels and a known status).
Follow-up (87ba9c2d and 9056e021; the quality review's minor and the VM
walk's M1): the accounts-service changes of one turn of the event loop are
acted on once, in the next turn, so each provider's on/off is read from the
settings once per turn rather than once per change (a settings save in the
same turn is that one refresh); What's New's SSH Persistent and Remote
Resumable lines carry the flag with the remote resume page, since the
persistent remote session wraps the remote claude command and the only
agent an SSH session runs in this release is Claude Code. Its fix round: a
synchronous throw in that refresh never escapes, and with Claude Code off
the session dialog's SSH Persistent card is disabled for Terminal only, with
the reason, as it is for Codex (a terminal-only session launches no Claude
then, so nothing would persist).
Done: the ADR-009 pass, lenses N and G PASS at c7f9a34a, lens N
re-confirmed PASS at 87ba9c2d, and ADR-009 lens N re-confirmed PASS at
839ab591 (sync throw in the queued refresh cannot escape; no request to an
off provider); the VM walk in Codex-only mode PASS at c7f9a34a (e2e 81/81;
no request to OpenAI's status page while Codex was off or not answered), its
minor M1 fixed in 9056e021; the owner approved the screenshots (canvas
"P3.4 Codex-only screens" v1, 2026-09-28, the gallery at f65de184); the VM
re-check at f65de184 PASS (e2e 80 passed and 1 flaky, terminal-links.spec.ts
line 110, passed on retry and in 3 more runs of that spec alone; the VM-only
files as at c7f9a34a; What's New, the SSH dialog and the pills PASS). CI at
f65de184 is green but for the Desktop test gate, which the owner attests.
After that re-check, d2ea6e66 and 7811229f made the guided tour's cards 1,
3, 4 and 6 and the Feature Guide's productivity hero name only the
assistants in use (both on unchanged; guided-tour-provider-copy.test.tsx,
claude-off-launch.test.tsx), on the one rule both read
(onlyAssistantInUse). Unit-tested only so far. Owed: a VM screenshot check
of those cards with Codex only, Claude Code only and both on, for the
owner's approval, riding with the next phase's VM gallery; and the Desktop
test gate. The Feature Guide catalogue cards that name both providers are
P3.16's (see there).

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
Built (2026-09-28, 28f42af2, 90a717df, 44729f29, 18f3e3f5; mocked). Row 38:
the status line's claim re-reads its day folders on every poll (today and
yesterday, by UTC and by local date: a rollout's name is local time and which
date its folder follows is unproven) and finds a resumed conversation by its
id anywhere in the account's own folder (the file name and its session_meta
must agree), or the one the resume picker opened, through a pick file the
picker writes (a conversation id, a new file only) once that rollout grows; a
picker launch waits for the user instead of giving up at 30 s. Rows 34 and
35: main keeps the conversation each Codex session is on (the claimed one,
or the one an exact resume starts; bounded); session:save persists it as
Claude's is; a restored session resumes it with `codex resume <id>` before
the flags, bypassing the picker as Claude's exact resume does, only when its
rollout is in the launch's own realm, in the directory the conversation
recorded while that still exists and is not home or above it (else the
configured one; a resume by id is not tied to a directory); the builder checks
the id again before argv. Restart resumes it; "Restart and pick a
conversation" still opens the picker; with no known conversation Restart
starts a new one. After a staged Sign in again the carried-over conversation
resumes in the account's new folder and the picker lists it there
(`spawn-resume.test.ts`, `codex-resume-picker-worktrees.test.ts`). Row 32:
the picker lists every git worktree's conversations (matched however Windows
spells the path, tagged, started in their own worktree), finds today's by the
local date too, leads with a session's name from the app's session state, and
shows names and labels as plain text, built in one place. The C item: Resume
keeps the tabs launched while its prompt was open, and Refresh never offers
them again. SSH radius: only the Codex local branch of `pty-manager.ts`; no
SSH code path changed. Row 38's midnight-UTC limitation (section 7, item 6)
is fixed, verification owed.
Fix round 1 (the reviews and the ADR-009 thesis check; 2026-09-28; 0cb77940,
16091336, 6400f8a8, 42bb5f5c): the
picker records every decision (`{ id }` for a resume; `{ fresh: true }` for a
new conversation, nothing to list, or the fallback after a resume failed),
each written whole (a new owner-only file renamed over the pick file); the
watcher claims nothing before a decision, after `{ id }` only that
conversation, after `{ fresh }` only a rollout created from the decision on;
the pick is read only as a small regular file, never through a link, and dealt
with once. A claimed rollout is read by size first and only what it gained,
at a claim its head and tail; a conversation another session holds is not
walked for again. The walk is bounded and follows no link at any level; of
two rollouts with one id the one recording the kept directory wins, then the
one in its own date folder, and a resume says in the log when none records
the kept directory. The review root stays the configured folder (asserted).
The picker finds git by an absolute path on PATH's absolute entries with a
hardened command line and fails safe. A second C item: a session file
written while the resume prompt is unanswered keeps its offer (every writer
goes through `buildSessionState`).
Fix round 2 (2026-09-28; 1616ff1f, 259847f0, cc4383ff): a resume walks the
realm once, stopping at the conversation's rollout in its own date folder,
and the watcher takes the rollout the launch chose without a second walk; a
claimed rollout's line split across two reads, or inside a character, is
read whole. After a claim the picker's watcher keeps reading the pick file:
a later decision (the fallback after a resume that failed) lets the claim
go, the session stops keeping that conversation, and it claims again by the
same rules. The pick file sits in a folder made for each launch, owner-only
where the platform keeps modes, removed with it. A rename the platform
refuses for a moment is tried again briefly (150 ms in all); a decision
still not recorded is said in the terminal and the launch goes on (the
watcher claims nothing new, never a conversation the picker did not name).
The picker starts a conversation in its worktree only when that is a
directory, as main checks.
Fix round 3 (2026-09-28; 17c6d1ab, 2989d876, 770a4fb6): the walk stops
early only at a rollout in its own date folder that records the directory
the session kept (with none kept, at the end of that rollout's day folder);
a copy recording another directory, dated in a newer folder or listed first
in the same one, no longer hides it. When no rollout records the kept
directory the walk goes on to its bounds (once per lookup). The pick folder's
identity (its device and file id, and its real path) is recorded when it is
made; the watcher reads a pick, removes it and at stop empties and removes
the folder, and the picker writes there, only while it is still that folder,
never a link, a junction or another folder in its place. A claim let go
clears the status line's tokens, cost and context until the next claim
reports; at stop a pick file a picker left half-written is removed before
the folder, never recursively. The tests remove recursively only folders
they made themselves.
Limits and deviations, recorded, none a UX decision: the name file Claude's
picker prefers (written by the logs binder against an exact bind) is written
for Codex too (P3.12), next to the rollout a session is exactly on, so a
renamed Codex conversation keeps its name after its tab closes; before an
exact claim a Codex name comes from the session state while the session is
open or saved (P3.12's limits).
Two NEW sessions of one account in one folder, launched directly or choosing
New conversation in the picker, started within seconds of each other, can
still take each other's rollout until the exact claim from the SessionStart
hook (P3.10); each then keeps the other's conversation, so a Restart or a
relaunch resumes the swapped one. Since P3.10 (d8f538b1; round 1 afae03f7), where the sessions' own Codex hooks run, the first message of the session whose Codex started the conversation corrects it (only a conversation a session's Codex started proves another's inferred claim wrong), and once a session's own hooks are heard a claim still only inferred is never carried by a Switch; before that, and where they do not run, the limit stays (P3.10's limits). A picker session that resumes a
conversation takes only that one, and so does a resume by id. Since P3.6
(VM finding V2), a conversation a picker session resumes while another tab
holds its rollout is kept for the session too (its rollout stays the
holder's to read), so that session's plain Restart and a relaunch resume it,
as they do any conversation the picker decided.
A conversation switched inside the Codex TUI (its own resume or new) was not followed until P3.10; since P3.10 (d8f538b1) it is, where the session's hooks run (its SessionStart names the rollout). A file with a second hard name is accepted (a staged
Sign in again links each carried file, and copies it where linking is
refused) and checked like any other. The pick file is writable by the same
user. Since b969e828 an `{ id }` pick is taken when the decision is read,
not once its rollout grows; it can still only name a conversation in the
session's own account folder, and the resume folder and id are checked again
by main. Its folder is looked at before each use; the check and the read
or removal are separate steps.
Row 35 deviates from Claude by the F7 menu: with no known conversation
Claude's Restart opens the picker, Codex's plain Restart starts a new
conversation ("Restart and pick a conversation" is the picker). Switch
account (row 35's other half) is P3.6.
VM check (2026-09-28, at c2c42e22; real Codex CLI 0.155.1 with both
providers on, and 0.153.4 with Codex only): passed rows 34 (a relaunch
resumes the same conversation), 35 (Restart keeps it), 32 (worktree
conversations listed, named and started in their worktree; names and labels
shown as plain text) and 38 for a conversation from an earlier date folder,
and both C items. Row 38's midnight UTC case is covered by unit tests with
fake timers only, not on the VM. Two findings, fixed after it (mocked; VM
recheck PASS at 33329a78, below): V1, a launch that needs a dialog (the account choice with two
or more accounts, or the confirm for a sign-in already on this computer) made
while the resume offer was up showed nothing and started nothing until the
offer was answered; those dialogs are now held back by every boot gate but
the resume offer, since no restore has started while it is up (2e70e744,
05f1e01a). V2, a conversation resumed from the picker showed its status line
only at its first new turn; it is now claimed at the pick with the checks a
launch's chosen rollout gets, as a resume by id is at its launch (b969e828).
For Claude the app claims no transcript (Claude Code sends its own status
line), so its picker and exact resumes reach the status line the same way.
V1 and V2 reviewed: spec PASS, quality PASS, ADR-009 lens A PASS.
Final round (mocked): a picked conversation that cannot be found (removed
after the picker listed it) is walked for with a growing wait, 1 s doubling
to 30 s, and at most ten times until a new decision or a claim let go; the
tail re-checks it is still reading the claimed file: each read compares the
opened file with the one claimed (device and file id, recorded at the
claim), and another file at that path is not read, the claim is let go as a
new decision would let it go, and claiming goes on by the same rules.
The final round reviewed PASS. VM recheck at 33329a78 (2026-09-28, real Codex 0.155.1 with both providers on): the e2e suite
passed 81/81; V1, the launch dialogs show while the resume offer is up and
stay held back under the Multi Spawn page; V2, a picker resume shows its
status line about 0.3 s after the pick; rows 34, 35 and 32 pass again. The
owner approved the P3.5 screenshots on 2026-09-28 (the canvas "P3.5 History
and resume screens", v1; `.ccc-canvas/screens/p3.5-33329a78/`, local and
gitignored).
33329a78 (the follow-up to ADR-009 lens A's minor) reviewed: quality PASS.
Owed: the SSH live matrix at the final head
(`pty-manager.ts` edited); the carried-over conversation after a staged Sign
in again (P3.3) with a real CLI on the VM, an owner action, since it needs a
second real sign-in; a session crossing midnight UTC on the VM; whether
`codex resume <id>` in the recorded directory asks anything.

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
Built (2026-09-28; 57ce396a, 68d00f62, 8274b3d1, 4439d7e2, bb99d2da; mocked).
Row 7's migration and row 20: the chips that read the email-keyed Claude
colour overrides (the strip, the sidebar card, the session header local and
SSH, the launch picker, the Remote Resumable list) read the identity's colour
when the account list names it, by the one Claude profile with that email
(design 19: an email-keyed value migrates only when it resolves uniquely), or
by the profile id in the launch picker; otherwise the override path is
unchanged (no list yet, a profile not mirrored yet, an email no profile has
or two share). The values were already carried into the identity's colour by
the reconcile (the Claude legacy snapshot); nothing writes or removes an
override, which stays the way back (no list, a downgrade) and is kept in step
by the identity editor. The footer's plain Claude pill keeps its approved
rule (usage track MP5), the same colour while the two are in step
(`utils/accountChip.ts`). A Codex session carries its account chip on the
strip (far left, as Claude's; hidden by the Account item of the Status Line
settings; kept with the master switch off) and on line 3 of its sidebar card:
the account it runs under, else the provider default, named by the footer's
label rule and coloured by its identity. Row 36's account-chip segment is so
built here; the Status Line settings and their Codex note stay P3.7's.
Row 22 (and row 35's Switch half): the strip's pill and the right-click
Switch Account list a Codex session's Codex accounts from one rule for every
provider (`utils/switchAccountItems.ts`: current marked, inactive and
needs-attention greyed, this computer's sign-in marked confirm at launch,
archived left out; Claude's rows unchanged), offered for a local Codex
session with two or more accounts, on every platform. A pick pins the account
and saves it, then restarts the session on it, as Claude's switch does; main's
respawn of that session carries the conversation (fix round 1: kill, carry,
spawn, in `pty:spawn`, once the old process has ended, waiting at most 5 s,
else nothing is carried; a killed run that never reports its end counts as
over once the grace its account lease is released after has passed, so a
later respawn carries, and lines such a run writes after that can be missed;
the conversation and the account it ran under are main's own record of the
session being respawned, pty-manager keeping the launch's account with the
kept conversation, and the destination is the account the launch was prepared
on; no renderer channel names a conversation, so the first build's
`providerAccounts:carryConversation` is gone; ADR-009 round 1: a
conversation another open session is on, as main recorded it, is never
carried, so it is neither forked nor added to under that session, and the
tab says why; a tab that picks a conversation another tab holds is recorded
on it too, VM finding V2), holding an operation lease on both accounts under the
registry lock and both realm locks for the copy (`realm-folders.ts`
copyConversation; a copy the other way at once is waited for, briefly; a
spawn superseded or closed meanwhile carries nothing, and a copy already
running is told so once it holds the realms and before each step, and stops
leaving nothing behind; the copy has 60 s inside the respawn, after which the
session starts without it, in the failed-carry words), the file work in
`conversation-carry.ts` (P3.5's lookup in the source realm only, bounded at
256 MiB, whole lines, no link followed below a realm's home; an exclusive
temporary file in the destination's sessions folder, checked to be there
before anything is written to it; a new copy takes its name with a hard link
from a second name made and checked inside the day folder (ADR-009 round 2),
which replaces nothing, and is checked after it lands, and taken back from
where it landed if that is anywhere else; a temporary file or second name a
stopped carry left is swept by the next one once stale; the same bytes already
there are present; an earlier copy that is exactly the start of the
conversation, and still that size, is replaced under its own name only by the
whole copy (ADR-009 round 1: renamed from a second name made and checked
inside the same day folder, so it can replace no name elsewhere; nothing is
ever written through the earlier copy, and another name of it, as a staged
Sign in again leaves in the kept earlier folder, keeps what it had; a rename
something holds open for a moment is tried again, briefly); anything else is
refused; a folder the copy made through a folder swapped for a link is taken
back while empty, and anything the copy takes back is removed only while the
file at its real path is still the one it made); the launch then resumes it
by id in the new account's folder through P3.5's path and checks.
Recorded as intended (ADR-009 round 1, B3; Claude parity): any respawn onto
another account carries the conversation, a plain Restart of a tab that names
no account after the default account changed included, as any respawn of a
Claude session under another profile resumes the same conversation from the
one shared projects folder (`launch-handoff-pty.test.ts`).
Guard and its limit, recorded (owner decision on ADR-009 round 1, B1, option
2): P3.5's claim and its recorded limit are unchanged, but a claim of a new
conversation is marked not certain when another launch waiting for a new one
in the same realm and folder could have taken the same rollout (a launch that
has claimed nothing waits until its process ends, past its no-claim deadline
too; ADR-009 round 2), when the launch saw more than one it could take, and
for every launch such a claim competed with (`providers/codex/telemetry.ts`). A Switch account never
carries or brings up to date a conversation claimed that way: the respawn
on the new account starts a new conversation and the tab says, in its
own words, that the app could not be sure which conversation was this one; a
Restart on the same account resumes it as P3.5 does. Main keeps these by
conversation id and saves them with the session state, so a relaunch that
resumes one keeps it uncertain (`telemetry-claim-anywhere.test.ts`,
`launch-handoff-pty.test.ts`, `session-resume-enrich.test.ts`,
`session-durability.test.ts`). A conversation another open session is on is
not resumed on the new account either (ADR-009 round 2): a new one starts
there. The limits, until P3.10's exact claim: two new sessions of one account
started together in one folder cannot take their conversation to another
account; and a writer outside the app (the user's own Codex CLI started in
the same folder on this computer's own sign-in, or a second copy of the app)
can still make a claim look certain, so a switch could copy the
conversation that writer is on (owner decision: this computer's sign-in keeps
carrying, rather than every claim there being marked not certain; PR 3 does
not leave draft before P3.10). Also until P3.10's exact claim, and fail-safe:
a new session that never claims its rollout (for example one left more than
30 s at a Codex startup prompt, where the rollout watch stops at its
deadline) counts as a possible holder until its process ends, so a claim of a
new conversation in that account and folder meanwhile is not certain, and a
conversation claimed then stays uncertain across relaunches: a Switch starts
a new conversation on the new account for it. Narrowed by P3.10 (d8f538b1; round 1 afae03f7 keys it to the session, S3 and S4): once a session's own Codex hooks have been heard, a conversation its hook named is certain and carried, one still only inferred is never carried, and a conversation a live launch resumed by id from a record in doubt stays in doubt whoever's hook names it; and a session's own hook confirms its claim whatever launch has not yet claimed, which closes the fail-safe case. Before a session's own hooks are heard (its first message), and for a session whose hooks do not run (Codex's review declined, the gateway off; P3.10's limits), these P3.6 rules still hold, so a writer outside the app can still make a claim look certain there.
Narrowed, not closed (ADR-009 round 2, N5): a day folder swapped for a link in
the moment between a new copy landing and the check of where it landed can
leave the app's own copy at the folder's earlier target. Nothing is deleted,
and only a program running as the same user can make that swap.
Deviation, recorded (fix round 1, accepted in review round 2): the "no link
followed" rule starts at a realm's home. This computer's own home is taken at
its real path, as the CLI takes it and as a Claude account's home is
(`account-profiles.ts`), so a `~/.codex` that is a link is followed to where
it leads; any link below it is refused, and one that leads into the app's own
account folders makes every Codex realm unavailable (overlaps-external). Section 5's fallback: when the conversation did not come along
whole, the spawn answers main's reason and whether the launch resumed it from
a copy already there, and the tab says so once, above its terminal and
outside its buffer, in the app's muted text, until dismissed, in words true
for that (`utils/launchNote.ts`, with the app's spoofing-character rule; VM
findings V1 and V4). Default pending the owner's decision (VM finding V3; a
Claude switch never asks at launch, so parity cannot settle it): a Switch
whose launch then asks for confirmation and is declined takes the tab back
to the account it came from, or to the default account when that one can no
longer launch, and says which.
No usage read is started for the pick (ADR-022). A second pick is ignored
while the first is still being saved; once its restart begins, a pick is a
switch of its own. What's New's line and the accounts page show with Claude Code off,
reworded; the claude.ai sign-in the line also named is its own Claude-only
line; the page's Insights point keeps the flag, per point. SSH radius: yes,
`pty-manager.ts` changed (the Codex local branch, the kept-conversation
map, and the Codex-only branch of killPty that records a run's end).
The two questions the first build stopped on were settled by the owner in the
P3.6 review and built in fix round 1: (1) a switch TO this computer's own
sign-in carries the conversation into its sessions folder under the same rules
as a managed one's, by parity (every Claude profile's projects folder is the
one ~/.claude/projects); (2) a switch BACK to an account whose copy is exactly
the start of the conversation brings that copy up to date; only a copy that
went its own way there is left as it is, the session carrying on from it and
the note saying so.
Done: the ADR-009 pass (the copy, the leases, the respawn's carry in pty:spawn,
the pty-manager record; independent attacker sub-agents, bounded rounds: pass 1 at cf8f42d4 FINDINGS (one major, the cross-tab claim), fixed in 62cf7d8b and 31da7fb1; pass 2 at 31da7fb1 PASS; the cleanup at 78f2fcec confirmed by both lenses); the independent spec and quality reviews,
PASS at 78f2fcec; the VM walk at 1063e3d9 (WINDOWS_1, MOCKED: fake CLI, fictional accounts; e2e 81/81): main's switch logic passed every case, and its findings are fixed: V1, the note was written into the terminal and the new session's first frame on Windows (ConPTY's) cleared it, so it is now shown in the new-account notice's place above the terminal, outside its buffer, until dismissed; V2, a tab that picked a conversation another tab holds on the same account was never recorded on it, so its Switch started a new conversation silently, and it is now recorded (the rollout stays the holder's to read), so its Switch refuses it as in use and says so; V3, Cancel on the confirm-at-launch question after a Switch left the tab on the new account; a Claude switch never asks at launch, so this is the owner's call, and the default pending that decision takes the tab back to the account it came from (or to the default account when that one can no longer launch); V4, the note is the app's muted text, which the token-contrast tests hold in both themes; V5, the claude.ai items in a Codex tab's right-click menu, predates P3.6 (#216) and is P4.6's (row 58, the per-account web session).
Done too: the VM re-check at 2cbf27ac (MOCKED; e2e 81/81) passed V1 to V4,
and its findings are dealt with: W1, the note's dismiss sat under the GitHub
button that floats over the terminal's top-right corner, so the bar now keeps
that corner clear; W2, a declined switch goes back to a signed-out account and
the Switch list gives a signed-out account no state, which parity settles
unchanged (Claude's list shows a signed-out profile with no state, and a
switch to it launches, the sign-in done inside the session); N1, a switch
whose restart is refused now puts the pin back on the account the tab is on;
its limit: a decline that lands during the switch's own pin save
(milliseconds, and the user must act inside them) can still be overwritten
when that switch's restart is refused.
CI at 1063e3d9 (the Windows and macOS test jobs): the two carry test files
failed because a runner's temp folder is not at its canonical path (an 8.3
short name on Windows, /var -> /private/var on macOS) and the carry refuses a
root that is not, by design. Users are not affected: the app derives every
account folder from its roots taken at their real path (realm-folders
resolveCodexRealmRoots) with the carry's own realpath flavour
(realpathSync.native, which also expands a short name). The tests now take
their temp folder at its real path, and pins were added: the carry's input
contract, the app's own path with a resources folder reached through a
junction or typed with an 8.3 short name, and one realpath flavour
(`conversation-carry.test.ts`).
Owed: the owner's decision on V3 (restore the previous account on a declined
confirm, the default until then); the VM check of W1 (to ride on P3.7's VM
run); the owner's review of the screenshots (the strip pill and its menu, the right-click menu,
the sidebar card's Codex line, the chips' colours, the note, a declined
confirm after a Switch, and the reworded What's New and accounts pages, both
themes); the owner's real-account resume (the server half of P3.1 answer
1: whether OpenAI accepts a conversation resumed under another account; a
second signed-in account, row 15's disposable identities) and the real-CLI
walk of the switch with Codex 0.153.4 and 0.155.1 (managed to managed, from
and to this computer's sign-in, back again, a conversation from an earlier
day); the e2e suite at the final head; the SSH live matrix at PR 3's final
head.

**P3.7 Statusline segments and settings.** Duration and line counts if Codex
reports them (P3.1; the account chip landed in P3.6); the Status Line settings cover them
and the Codex note there is updated. Likely files: `providers/codex/telemetry.ts`,
`SessionStatusStrip.tsx`, `SettingsPage.tsx`. The C item "narrow-window
overlap" fits here.
Built (2026-09-29; 5de7a4c4, b1cffc71, 9f2bd164; mocked). Row 36, lines changed: the
strip was already one for every provider, so the work is the figure. It is
counted from the completed FileChange edits a Codex rollout records (P3.1
evidence, answer 5): an update by its unified diff's hunk headers, a new
file's content as added, a deleted one's as removed; a failed, declined or
unfinished edit counts nothing. It covers the whole conversation, as Claude
Code's does: its CLI restores lines and duration from the transcript when it
resumes (the cost ledger of the pinned 2.1.284 build), so a resumed Codex
conversation counts the edits it made before. It is zero until an edit lands,
as Claude reports, and a claim let go clears it with the tokens
(`providers/codex/telemetry.ts`, `telemetry-lines.test.ts`). A large rollout
is read as its head and tail (P3.5); the edits between them are counted once
in the background, a chunk at a time, only while the file is the one claimed,
and it stops, closing the rollout, once the watch ends or the claim is let
go. Its limit: no more than 8 MiB of one
line is held (review fix: one huge line never takes hundreds of MB or stalls
main), so an edit record longer than that (a file of about that size written
in one patch) between the head and the tail is not counted. The add and delete shapes are the Codex protocol's; P3.1 recorded
only an update. Row 36, duration (9f2bd164; settled by parity, the
coordinator's ruling after the first build stopped on it): the same quantity
as Claude Code's, the conversation's wall-clock running time, idle included,
carried on across runs (Claude's CLI restores it from the transcript when it
resumes; the pinned 2.1.284 build's cost ledger). The rollout cannot tell
Codex's runs apart (P3.1: a resume writes no second session_meta; the one mark
seen, thread_settings_applied, was seen only on `codex exec resume`, neither
proven for the TUI's resume nor proven absent mid-run; nothing records a run's
start before its first turn or its exit), so main keeps it. What is counted:
each run of the conversation in the app, from the launch (for the resume
picker, from the choice made in it, as Claude counts from its restore) until
its process ends (the status line watch's end), kept by main by conversation
id as it goes and at the end (`src/main/conversation-running-time.ts`,
provider-neutral, the 1000 most recent), saved with the session state at every
save and read back at load, schema-checked, as the uncertain list is
(`app-session-durability.ts`, `session-resume-enrich.ts`); plus, for time
main did not see (before the app first ran the conversation, and runs outside
the app since its last run), what the rollout proves: the turns it records as
completed in that time (`task_complete.duration_ms`), each only for its part
inside it; a large rollout's turns between its head and tail are added by the
background count. A claim let go settles its time and clears the figure.
Review fixes: two tabs on one conversation count the time they both ran it
once (a run is counted from no earlier than the time main already kept). A
run that ends before a large rollout's background count lands is kept at
once, without the turns that count had yet to confirm; the spans of time
holding them are kept with it as gaps (at most 8 per conversation, the
latest; saved and read back with it, schema-checked), which the next run
counts. So a count never reads on after its watch has ended or its claim was
let go: it starts no further read and closes the rollout when the read in
hand returns (CI at 427807fb: on Windows a rollout still open kept its folder
from being removed; that runner removes a file deleted while open only once
it is closed). A background count also stops after 60 s, as the carry does (a
volume that stops answering), and what it would have found (lines, and turns
between a large rollout's head and tail) is then not counted, the turns' span
kept as a gap; a read held up by such a volume keeps the rollout open until
the system returns it. Parity checked: the Duration moves when the rollout changes,
as Claude's moves when its status line updates on Claude's own events (the
app's Claude status line sets no refresh interval). Every save writes the
kept list: at the 1000-entry limit about 110 KB of the session file,
accepted. Its limits: a conversation's gaps past the latest 8 are dropped and
their turns not counted; of a run outside the app only its completed turns count (its idle
time, an unfinished turn, and the time from its start to its first turn and
from its last event to its exit are not recorded); a run in the app is kept up
to its last status line update when the app itself closes before the watch
ends; time kept for a conversation drops out once 1000 more recent ones are
kept; the pick time of a New conversation is the pick file's time
(`telemetry-duration.test.ts`, `conversation-running-time.test.ts`).
Row 37: the Status Line settings' Codex note says only that they apply to
Codex sessions too, as every item now fills for one, and the Model and
Account items name no provider (the Account item hides a Codex chip since
P3.6). The C item: the
partner terminal strip keeps the floating GitHub button's corner clear
(pr-12, as the switch note since P3.6's W1); its note wraps and its Back
button never shrinks, on Claude and Codex tabs alike (`session-launch.test.ts`).
SSH radius: no (`pty-manager.ts` and the SSH files untouched; the store is
reached from the Codex package and from `app-session-durability.ts`).
Owed: the independent spec and code-quality reviews; the VM run (a Codex
tab's lines changed after a real edit and after a resume; its Duration on a
new conversation, after a Restart, after an app relaunch and on a
conversation started outside the app; the Status Line tab with Codex on; the
partner strip at a narrow window on a Claude and a Codex tab; P3.6's W1) and
the owner's review of its screenshots, both themes; the real-CLI count of a
new and a deleted file, and the Duration of a TUI resume, on 0.153.4 and
0.155.1. The P3.7 VM finding (a second tab on a conversation another tab holds showed an empty status line, where Claude shows figures in both) is addressed in P3.10 (d8f538b1, mocked): both tabs show its figures. The P3.10 VM run showed Codex itself lets one live tab write a conversation (0.155.1 shows its own lock screen; 0.153.4 refuses the resume), so this shows the figures while that refusal is on screen and hands the running time over when the first tab closes; P3.10 round 1 (V2) has the picker say such a conversation is open in another tab (P3.10's entry).

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
Built (2026-09-29; 260d4abc; mocked). Evidence first: the 0.153.4 binary on the
development machine, read as bytes and never run (P3.1 evidence, addendum 12):
its bundled model catalogue (the list `codex debug models` renders) offers
gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 and gpt-5.2, each
with its own reasoning levels (low to ultra at most); gpt-5.4, gpt-5.4-mini,
gpt-5.3-codex and gpt-5.3-codex-spark, four of the six the app offered, are not
offered by it. Row 39: every Codex model list (the session dialog, the command
bar pill) is the model registry's, as Claude's is: the codex family in
`resources/model-registry.json` holds that list, in its order, with Default
(no `-m`, Codex's own choice) first and a saved model the list no longer
offers shown and kept; Claude's pickers never show a Codex row, and the codex
family is Codex's by a rule in code, so an overlay cannot move a Codex model
into a Claude picker (`codex-model-registry.test.ts`, `codex-models.test.ts`,
`commandbar-codex-toolbar.test.ts`). Sentinel checks the registry's Codex
models against that list as shipped with the build
(`resources/codex-model-catalogue.json`), only while Codex is on, as Claude's
half checks the article snapshot (`sentinel-codex-models.test.ts`,
`sentinel-and-cli-setup-provider-off.test.ts`). Row 40: each Codex model offers
its own levels from Codex's level list (low, medium, high, xhigh, max, ultra),
the ones it lacks disabled; a model change, a load and a save drop an effort
the model cannot run, as Claude's are dropped; the launch allowlist adds max
and ultra (the CLI's values) and a restored effort off it is dropped
(`session-dialog-codex-model.test.tsx`, `codex-effort-allowlist.test.ts`); an
edit reopens what is stored rather than rewriting a Default to gpt-5.5 and
medium. Row 28: the LiteLLM fetch that prices Claude takes the OpenAI prices
too, checked (an OpenAI chat or responses model, a plain id, bounded
non-negative prices, a bounded count), saved beside Claude's for a day and read
back checked; a Codex model is priced live, else by the table, else "no price",
by its own id only, and the strip and Tokenomics price a turn alike
(`pricing-live.test.ts`, `tk-pricing-live-codex.test.ts`). Row 61: a Codex
session's strip has the controls cluster (Compact and Restart, kept with the
status line off); Compact types Codex's own `/compact` and, 300 ms later,
Enter, because Codex's composer takes a fast burst ending in Enter as a paste
(its `disable_paste_burst` handling), and only into the same run: a Restart,
the run ending or the strip going cancels the Enter
(`session-status-strip-codex-controls.test.tsx`). SSH radius: `pty-manager.ts`
changes one type only (its compiled output is byte-identical), as does the
preload. Not built in round 0 (round 1, below, builds rows 41 and 69 and the
release gate's Codex half), with the orchestrator for the owner: row 41 (the evidence
shows no argument form for `/model` and no `/effort` command: effort is
`/model`'s second step; whether `/model <slug>` is taken inline is unproven,
so how the strip applies a model and effort live needs a VM probe and a
choice); row 69 (the first screen can be the folder-trust prompt, or a model
notice, where a typed Enter answers it, so `/plan` needs a proven marker that
the composer is ready: a VM capture of the raw output of a new and a resumed
session, in a trusted and an untrusted folder, on both versions); Sentinel's
live read of the Codex list (Claude's half reads the article when online) and
the release gate's Codex half. Owed after round 0 (the VM run was made at
3ff8c361, evidence addendum 13): the independent reviews and the ADR-009
pass; the VM run (0.155.1's catalogue read the same way; the Codex fields and
the command bar pill; Compact on a real 0.153.4 and 0.155.1 TUI; a launch at
max and ultra; a real price fetch) and the owner's review of its screenshots,
both themes.

Round 1 (2026-09-29; caef0d42; mocked), after the VM run at 3ff8c361, the reviews and
the ADR-009 attackers. The VM probe of the real 0.153.4 and 0.155.1 TUIs
(evidence addendum 13) settled rows 41 and 69 and gave the marker every
typed command now waits for: Codex's composer is ready when the screen's last
line is its footer (model, effort and folder) with the composer row above it
and no blocking prompt on screen; the placeholder is drawn before the trust
prompt, so it is no marker. One gate types every Codex command the app sends
(Compact's `/compact`, the model pill's `/model`, Plan mode's `/plan`;
`src/renderer/lib/codexComposer.ts`, over the terminal's live screen,
`terminal/screenRegistry.ts`): only into the ready, empty composer; Enter
300 ms later, only in the same run (the session's start and its PTY) and only
when the composer holds exactly that command; otherwise nothing is typed and
the strip or the pill says why for a moment (`codex-composer.test.ts`,
`screen-registry.test.ts`, `session-status-strip-codex-controls.test.tsx`).
The one strip App renders drops a press's Enter when it is re-pointed at
another tab. Row 41, built as the default pending the owner's decision
(section 10, question 2): Codex has no one-line model or effort command
(`/model <slug>` is sent as a message; there is no `/effort`), so on a live
session the model pill types a bare `/model`, which opens Codex's own
two-step picker and keeps the conversation, and the strip then shows what
Codex reports; a stopped session keeps the select, applied at its next start
(`commandbar-codex-toolbar.test.ts`). Row 69: a "Plan mode" permissions
choice in the dialog and the pill, as Claude's launch option: it launches as
Standard, then `/plan` is typed once the composer is ready, never into the
trust prompt, within two minutes, else a note above the terminal says to type
it (`terminalview-account-launch.test.tsx`, `spawn.test.ts`,
`codex-effort-allowlist.test.ts`). Row 28: Tokenomics prices a Codex turn by
its model's exact id, as the strip does (it took the longest price key the
model started with, so gpt-5.3-codex-spark was priced as gpt-5.3-codex), and
stored Codex rows are re-keyed once (`tk-parse.test.ts`;
`tk-db-codex-exact-price.native.test.ts`, CI and VM); a query binds only the
price keys the stored usage names (`tk-pricing-cte.test.ts`). Both
providers' prices, fetched and saved, are read through the same checks
(`src/main/tokenomics/price-checks.ts`; valid Claude data prices exactly as
before); the list's two halves are read independently; an empty OpenAI result
is saved, so the day's window holds; a copy dated in the future is stale;
calls made together share one request; a Codex price never replaces a Claude
one (`price-checks.test.ts`, `tk-pricing-checks.test.ts`). Row 39: the Codex
picker offers only ids the launch takes, and an overlay cannot move a shipped
model to the other provider (`codex-model-registry.test.ts`). The release gate
has its Codex half (`scripts/release-gate.mjs`, check 3: the registry's
pickable codex-family models against `resources/codex-model-catalogue.json`;
a missing model refuses, an extra one warns, an empty list fails closed;
`model-coverage-parity.test.ts` holds it to Sentinel's verdicts,
`release-gate.test.ts`). The list names both supported CLIs and keeps gpt-5.2,
which 0.153.4 lists and 0.155.1 does not (section 10). Sentinel's Codex check
stays snapshot-only until P3.9's live read (`codex debug models`, which needs
no sign-in or network): both its inputs ship with the build, so at runtime it
reports only an overlay's changes and a stale list. Row 40: a launch drops a
saved effort its model cannot run (a luna config saved at ultra and launched
from the list started at ultra; `pty-spawn-provider-off.test.ts`). A new
Codex config starts as a new Claude one does: on the first model of the list,
at Default effort (it started on gpt-5.5 at Medium). A pill's "Restart
session to apply" goes with the Restart. Unchanged, by parity: the strip shows
no cost for an unpriced Codex model, as it shows none when a Claude session
reports none (`SessionStatusStrip.tsx:436`, the one path); Codex findings
stay after Codex is turned off, as Claude's do. Owed: the reviews and the
ADR-009 re-attack of round 1; the VM run of round 1 (the gate on the real
TUIs, the pill's `/model`, Plan mode, Tokenomics' exact prices, and the
native test there); with a real sign-in, whether the server takes max and
ultra and what a real `/compact` does.

Round 2 (2026-09-29; f1783110; mocked), the last bounded fix round, after the ADR-009
pass 2 (lens A PASS with three minor findings, lens B one major), the spec
and quality reviews and the VM pass. Row 69 (the major): a Plan mode launch
now starts Codex READ-ONLY (the CLI's own sandbox option; it was Standard),
so no turn can write before Plan mode is on, and `/plan` is typed into the
run's first ready prompt only: when that first ready screen already holds
text, or a turn is seen running first, nothing is typed and a note above the
terminal says Plan mode is not on, that the session is read-only, and to type
`/plan` or `/permissions`; the same note when the Enter is withheld or the
prompt never comes (`codex-composer.test.ts`, `spawn.test.ts`,
`terminalview-account-launch.test.tsx`). The permissions pill of a live Plan
mode session reads "plan" only while Codex's own footer shows its Plan mode,
else "read-only (Plan mode off)" (`commandbar-codex-toolbar.test.ts`); the
dialog's Plan mode says it starts read-only. Deviation, recorded: Claude's Plan mode starts in plan
(`--permission-mode plan`) and its accepted plan moves on to the mode the user
picks; Codex's accepted plan leaves Plan mode, not read-only, and the user
widens it with Codex's own `/permissions` (section 10). The composer gate:
the Enter goes only to a screen showing the command typed with nothing in the
way (no prompt, no turn, only its popup or the footer under it); a second
command is refused while one's Enter is pending for the session, app-wide (a
second press, or the pill and Compact, before Codex redraws typed it twice);
the footer is anchored (a model then one of Codex's levels, or "default", and
the model one of the session's or the registry's), so Codex's own hint lines
never read as a ready prompt; only Codex's two dim placeholders read as an
empty composer (a dim paste marker is content); Codex's approval requests, as
its binaries word them, block (defence in depth: the modal is not reachable on
the VM without a working model, so the real check is owner-only); a footer
that is not the last row is said as "could not be read" rather than "not at its
prompt" (`codex-composer.test.ts`, `session-status-strip-codex-controls.test.tsx`).
Row 28: the re-key of stored Codex rows runs on every open (in the Tokenomics
worker, off the main thread), not once behind a marker, so rows an older
build stores later are keyed at the next open; the used price keys are read
again only after a write (a row change, another connection's commit or a
rollup swap) rather than on every query (`tk-db-codex-exact-price.native.test.ts`,
CI and VM). The legacy `tk_daily` table (v1, read by no page) keeps its old
keys. Row 39: the release gate and Sentinel's check refuse a Codex id the
registry lists twice (Sentinel says so as its own finding), count only an id
the Codex picker offers, and read a file whose `models` is not a list as empty
(`model-coverage-parity.test.ts`, `release-gate.test.ts`,
`sentinel-codex-models.test.ts`). Owed: the ADR-009 re-attack and the reviews
of round 2; the VM run of round 2 (Plan mode read-only, its note and the
pill's reading; the composer gate on the real TUIs); the native tests on CI
and the VM.

Round 3 (2026-09-29; e9f2cd51; mocked), after ADR-009 pass 3 (PASS on both
lenses, three minors), the spec and quality reviews, and the VM re-check at
25616c3f. Row 69, the VM finding: 0.153.4 boots its MCP servers after drawing
its prompt, under a status row that reads like a turn ("Booting MCP server:
conductor (0s . esc to interrupt)"); fresh Plan mode launches left `/plan`
typed (6 of 7) or gave up saying something was typed (1 of 7). That row now
reads as "still starting": nothing is typed while it shows (Compact says so),
and Plan mode waits it out. Every typed command whose Enter is withheld is
erased again, only the app's own characters, only in the same run, only while
the composer holds exactly them and never while a prompt is up; Plan mode
then waits for the prompt and types `/plan` again (at most four tries), and
its note names the real reason (`codex-composer.test.ts`, from the VM's raw
screens). The permissions pill compares the choice for the next start with
the preset the run launched with, which main now reports with each Codex
spawn (a Standard run with Plan mode picked for its next start reads "plan"
and keeps "Restart session to apply" across a tab switch), and reads Codex's
Plan mode only from the footer row under the composer, in the right-aligned
segment after the folder (`commandbar-codex-toolbar.test.ts`,
`terminalview-account-launch.test.tsx`, `pty-spawn-provider-off.test.ts`); the
pill is Codex's only (Claude's mode picker is the bottom bar's), so nothing
changes for Claude. A write that throws at the Enter still settles the
typing. Row 28: a re-key that cannot run (a read-only or locked file) is
logged and the open goes on; with nothing to change it only scans (30 ms at
200,000 rows on the VM), so no index is added; an open that fails while it
is set up closes the handle it opened (`tk-db-open-failure.test.ts`,
`tk-db-codex-exact-price.native.test.ts`). Pre-existing, fixed here (VM S5):
the terminal's context reading took Codex's footer "N% context left" as the
share used, so a Codex tab showed a full, red meter; a figure followed by
"left" or "remaining" now reads as the share left
(`terminal/contextPercent.ts`, `context-percent.test.ts`).

ADR-009 for P3.8: pass 1 at 3ff8c361, FINDINGS (one major: Tokenomics
priced a Codex turn by a model-name prefix), fixed in caef0d42; pass 2 at
3f458ac4, FINDINGS (one major: a Plan mode run's first turn could run before
Plan mode was on), fixed in f1783110; pass 3 at 25616c3f, PASS on both lenses
(its minors fixed in round 3). VM: the round 2 re-check at 25616c3f (e2e
81/81; native 11 files, 135 tests; Plan mode read-only launches, 6 of 6 clean
starts on 0.155.1; `/permissions` on both versions; the 0.153.4 start-up
finding above). The reviews of round 3 PASS; lens A's re-attack of round 3
PASS. The VM re-check at c67b1041 PASS: Plan mode on 0.153.4, 5 of 5 fresh
launches, the erase and the retype included; on 0.155.1, 3 of 3; the context
meter fixed; the pill across a tab switch; native 136 passed; e2e 81.

Round 4 (2026-09-29; the commit that records it; mocked), the last edges. The erase waits one poll
and reads again: only when the composer still holds exactly the app's
command is it erased; otherwise nothing is, and Plan mode gives up with the
note (the user's keys echoed late are never erased). Codex's start-up row
counts only in its own place, the status row directly above the composer,
and only during the run's start-up (until a turn is seen or a command sent
in that run), so a "Booting MCP server" line printed in the transcript
never hides a running turn; "before the first ready screen" would undo the
0.153.4 fix, whose first ready screen comes before its start-up row. The
Plan mode reading holds Codex's right segment to where Codex draws it: its
last cell two cells from the right edge (the raw footer bytes: the segment,
then two spaces), so a folder named with spaces and "Plan mode" does not
read as it. A Restart clears the launched preset with the other per-run
fields, and a launch that started nothing records none
(`codex-composer.test.ts`, `screen-registry.test.ts`,
`use-restart-session.test.ts`, `terminalview-account-launch.test.tsx`).
The reviews of round 4 PASS; lens A's confirmation of rounds 3 and 4 PASS
(the launched answer on `pty:spawn` and the typed-input erase included).
Round 5 (the commit that records it; mocked) bounds the record of runs past
their start-up: one run per session (its latest), a session seen with no
live run let go, at most 256 sessions (`codex-composer.test.ts`). Residual
limits, recorded: a folder name with three or more spaces before "Plan
mode", reaching the footer's right edge, can still make the pill read
"plan" (the label only; the read-only launch bounds it); and if Codex's
status header follows the model's reasoning heading (not verified on the
VM), a heading that reads like the MCP start-up row can hide a user-sent
first turn, so `/plan` lands after it (the read-only launch bounds it).
Owed: the native tests on CI and the VM.

**P3.9 Sentinel for Codex.** Codex version drift against the supported range
raises a finding; flags and the rollout format are checked; row 39's live
read of the Codex model list: `codex debug models` (no sign-in, no network,
JSON: slug, levels, visibility and default level; P3.8 evidence addendum 13)
per installed version, so Sentinel's Codex model check compares the registry
with the list the installed CLI offers rather than the shipped snapshot; the analysis
(today `claude -p`, `src/main/sentinel/sentinel-analysis.ts:158`) runs on
whichever provider is on. With both on it runs on the provider the "Ask
Conductor runs on" setting names (question 1, decided: OD27 M4).
Likely files: `src/main/sentinel/*`, the Sentinel page and dot,
`providers/codex/discovery.ts`. ADR-009: yes (a new CLI run). The onboarding
Transparency page's Sentinel card still says it watches Claude Code updates
and spends Claude tokens (left by P3.4): it says what Sentinel watches and
runs on once this lands.

Built (2026-09-29; 3a4ed400; mocked). Row 39, the live read: the Codex package
reads the model list the installed CLI offers in its own picker,
`codex debug models --bundled` (a constant argv; `--bundled` prints the
catalogue shipped in the binary and skips the refresh a signed-in home makes
from the account; 0.153.4's strings), run only on the executable discovery
proved, re-verified before and after the run, never for a version the
managed flows may not use, in a fresh empty Codex home made for the read and
removed after it, under the allowlisted environment, 15 s and 4 Mi
characters, and parsed strictly (`model-catalogue.ts`,
`model-catalogue.test.ts`; the accounts service's `readModelCatalogue` runs
it behind the launch rule, before and after the wait for the CLI's proof).
Deviation, recorded: the read runs in an empty folder, not an account's.
In a signed-in folder Codex refreshes its list from OpenAI with that account's
sign-in and writes its model cache (PRIVACY.md's usage row), so the empty
folder is what keeps this entry's "no sign-in, no network", as discovery's
`--version` already does. Sentinel's Codex check compares both arms with that
list and names the version (live mode), so with 0.155.1 installed gpt-5.2 is
said as a model that version no longer lists (section 10's notice, resolved
per installed version); without a live list the shipped one answers as
before, its stale note only then (`sentinel-codex-models.test.ts`). Row 42:
while Codex is on, the start-up check and a Re-run check the installed Codex
version (a fresh `codex --version` through the accounts service's discovery,
as Claude's check runs `claude --version`) against the supported range: too
old is a severe break (its sessions will not start), newer than tested a
notice (`sentinel-codex.ts`). A changed version (the first check is a
baseline, as Claude's) has its release notes (openai/codex GitHub releases,
published stable ones only, capped, headings demoted, control characters
dropped; `sentinel-codex-changelog.ts`) analysed against the four surfaces
the app relies on in Codex: its launch flags, the TUI, the rollout session
files and CODEX_HOME's config and account files, so the flags and the
rollout format are checked as Claude's statusline contract is
(`sentinel-analysis.ts`). The analysis runs on the provider that is on; with
both on, on the one Ask Conductor runs on (OD27 M4, read from its saved
choice, `src/shared/ask-conductor-provider.ts`; the Settings row is PR 4's,
so Claude Code until then). On Codex it is a prepared reviewer launch (the
account leased, the proven executable, the account's folder with ambient
credentials removed, read-only, the prompt on stdin) in a fresh empty temp
folder, removed after it and after any kill still under way; the account is
Settings' Sentinel choice, else the review default, as Claude's analysis
account falls back to the primary (`sentinel-codex-service.test.ts`). Codex
off or not set up: nothing of it runs or is said; Sentinel's Codex runs count
as Codex in use (`provider-in-use.test.ts`). The same panel, dot and Settings
section, no parallel UI: they name the assistants in use and their versions,
say whose update is analysed and tag a Codex finding, and the Analysis account
select lists the Codex accounts when the analysis runs on Codex
(`sentinel-panel-copy.test.tsx`, `settings-sentinel-codex.test.tsx`); the
Transparency page's Sentinel card says what Sentinel watches and runs on
(`onboarding-transparency-recap.test.tsx`); app knowledge, the Feature Guide's
Sentinel card and PRIVACY.md say the same. SSH radius: none. Mutation: 53
mutants, all red. Owed: the independent reviews and the ADR-009 pass; the VM
run (`codex debug models --bundled` on 0.153.4 and 0.155.1: accepted, the
same list as the plain command, no request, nothing left outside its empty
folder; the start-up check and a Re-run with Codex only and both on, the
newer-than-tested finding on 0.157.1 and the gpt-5.2 notice on 0.155.1; a
Codex analysis with a real sign-in, its folder removed and the account's
config.toml unchanged; the release-notes read from GitHub; the fake-CLI case,
CI and VM only); the owner's review of the screenshots (the panel, the dot's
tooltip while analysing, Settings' Sentinel section and the Transparency
card, with Codex only and both on, both themes).

ADR-009 pass 1 (2026-09-29, at 7678c433): FINDINGS, two major, with minor
items from it and the spec and code-quality reviews; all fixed in round 1
(e357fe33; mocked). The analysis is text only on both providers. Claude Code's
`claude -p` loads no MCP server (`--strict-mcp-config`) and may use no
tool (`--disallowedTools`, each by name). Codex's is the reviewer's own
`analysis` run (`cli-runner.ts`): no user config or rules files
(`--ignore-user-config`, `--ignore-rules`); no tool that runs a command,
browses, connects an app or a plugin, makes or views an image or starts
another agent (`--disable` per feature; every name in both supported CLIs,
and an unknown one fails the run); web search off; no project instructions
(`project_doc_max_bytes=0`); and the working folder is the project root
(`project_root_markers=[]`, and an empty `.git` file in it), so no folder
above it is searched. That folder is made in Sentinel's own runs folder in
the resources folder (a real folder, never a link, this user's), no longer
the shared temp folder, and the Claude reviewer refuses a text-only run
(`cli-discovery.test.ts`, `claude-reviewer.test.ts`,
`sentinel-codex-service.test.ts`). The notes sit between two lines that
carry a fresh random marker, called data and never instructions; a finding
whose evidence is not a quote of the notes is dropped; every finding's text
is made prose-safe and redacted; and a finding's id comes from what it says,
for both providers (`sentinel-analysis.test.ts`). The release notes are
read one version at a time (`/releases/tags/rust-v<version>`, each reply
capped at 2 MiB, at most 16 requests and 45 s): the VM's list reply was
29.6 MB, over the old cap, so every read had failed. The installed
version's own notes come first (none, no analysis), then the stable versions
since the last one seen, newest first; a downgrade, a Re-run, a new major or
a prerelease installed reads the installed version's notes only, so nothing
newer is analysed under its id; each version's notes get their share of
20,000 characters, and notes read only in part are said in the panel
(`sentinel-codex-changelog.test.ts`). The start-up check uses the look the
app took at start (no second `codex --version`; a Re-run still looks
afresh), runs beside Claude Code's, and nothing in the Codex half stops
Claude Code's. Folders a run leaves behind (a crash or a quit) are swept by
the next run: its own prefix, real folders only, an hour old
(`stale-folder-sweep.test.ts`, `models-scratch-home.test.ts`). The Codex
CLI environment keeps only absolute PATH entries, as the reviewer's does
(`env-allowlist.test.ts`). PRIVACY.md says the analysis account falls back
to the review default, the notes are read one version at a time, and the
analysis uses no tools. Mutation: 72 mutants, 71 red and one equivalent red. VM at
7678c433: the bundled read accepted on 0.153.4 and 0.155.1 (the same list as
the plain command, no connection, nothing written); the version and model
findings as specified with Codex only and both on; a Codex-run analysis left
both accounts' config.toml byte-identical and its folder removed; the
release-notes read failed on every run (the oversized list, fixed above).
Owed: the VM re-check of round 1 (both CLIs honour the override keys and
feature names, no AGENTS.md above the run's folder is read, the tools are
off), a completed real analysis (the owner, a real model), the ADR-009
re-attack and the owner's screenshot review.

ADR-009 pass 2 (2026-09-29, at 82c78680): FINDINGS, one major (the same in
both lenses), with minor items from it and the spec and code-quality
reviews; the VM re-check at 82c78680 passed five of six checks and found
one bug. All fixed in round 2, the last bounded fix round (1f010667; mocked).
Claude Code's analysis (its changelog's and, with both on, Codex's notes)
runs with an empty tool list (`--tools=`: the CLI's "" that disables every
tool, written with `=` so the one argument survives the headless
spawner's shell) and no settings sources (`--setting-sources=`: no user,
project or local settings file, so none of their permissions, hooks,
plugins or instructions), the names denied as a second layer, no memory
files, auto memory or git context (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`),
in a fresh empty folder of its own in Sentinel's runs folder, removed
after; the flags and switches were read from the pinned 2.1.284 binary as
bytes (`sentinel-analysis.test.ts`, `claude-headless-run-folder.test.ts`,
and `claude-headless-real-argv.test.ts` through a real shell, CI and VM
only). A finding's evidence must be one passage of the notes, at least 16
characters, after the one normalisation the panel shows; a title or
what-breaks line is capped and keeps nothing shaped like a token; a
finding's id comes from its quote, and one of the same version with the
same quote keeps an earlier finding's status, older ids included
(`sentinel-state.test.ts`). The VM bug: codex exited 0.2 s after a failed
request while a helper it had started (a suspended git) held the output
pipes, and the run waited out its deadline and was reported as a busy
account. An exec run (a review or an analysis) now settles two seconds
after codex exits, with its real error; what is provably left of it is
ended (on POSIX its process group; on Windows the root's children, and its
chain's from the early read of a run past two seconds, started while it
ran, never with its pid in use again); a stop takes the whole tree below
a still-running root; git in the run stops at the runs folder and never
prompts (`cli-discovery.test.ts`; `fake-cli.test.ts`, CI and VM). The
runs folder is checked by real path once the run's folder is made. The
notes' patches are read newest first, an older minor cut short is not
kept, the fence marker is tried eight times at most, the Codex analysis
names no model (Codex runs its default), a Claude Code check that fails no
longer drops a Codex update, and a cut is said whether or not the analysis
completed. PRIVACY.md says what each analysis runs with. Mutation:
55 mutants, all red, every run bounded. Residuals: Codex's request still offers
apply_patch (refused by the read-only sandbox) and request_user_input
(inert in exec); Codex loads the account's own `$CODEX_HOME/AGENTS.md`
(the user's own global instructions); on the npm shim route a helper left
by a run that ends within about two seconds is not ended (nothing then
vouches for its parent), though the run no longer waits for it; Windows
resources-folder ACLs inherit from the drive (#103). If the re-attack is
not a PASS, the verdict stays FINDINGS and P3.9 goes to the owner. Owed:
the independent reviews of round 2, the ADR-009 re-attack, the VM re-check
(the Claude argv and switches through the real CLI, no tool offered, no
settings or CLAUDE.md read; a fast Codex failure settles at once with its
error and leaves no suspended git), a completed real analysis (the owner,
a real model) and the owner's screenshot review.

ADR-009 history: pass 1 (at 7678c433) FINDINGS, two major, fixed in round
1; pass 2 (at 82c78680) FINDINGS, one major, fixed in round 2; pass 3 (at
84fd2d03) lens B PASS with five minor items, lens A FINDINGS with one major
in the round-2 run cleanup. The bounded rounds are then exhausted: the
phase verdict is FINDINGS and P3.9 is quarantined. The fixes were still
made (round 3, 5fd82db8; mocked), and a fresh independent ADR-009 pass
(PR-level) is owed before #626 leaves draft. The VM re-check at 84fd2d03:
Claude Code's analysis offered no tools, read none of the planted
instruction or settings files and ran in the runs folder; the Codex
analysis with no model named reached the model; a fast Codex failure
settled about 2.5 s after it exited with its real error; but in two of six
fast failures a suspended git that Codex had started was left running
(fixed here; the VM re-check is owed). Round 3: after an exec run's root
has exited, a process is ended only when reads of the process table taken
while the run ran prove it the run's (its pid with its start time recorded
under the root, or a child started while a read saw its recorded parent
running); a pid now held by another process is never touched. Those reads
are taken at the run's start, at its first output and on a bounded
schedule (eight at most, two at once), so a run that exits within a
second can still be proved; the process group on POSIX is signalled only
while a recorded member still runs with its recorded start time (macOS's
ps now reports start times). The Windows sandbox appears to start Codex's
own helpers suspended and a helper can be left that way when Codex exits
at once (an upstream behaviour); no setting in the 0.153.4 binary stops
Codex collecting git information in exec. Claude Code's analysis keeps no
transcript (`--no-session-persistence`) and gets the proxy and
certificate settings of its account's settings file, the transport
variables the authority manifest keeps (`transport-settings-env.test.ts`).
The quote check reads past markdown code marks and typographic quotes,
accepts a whole notes line however short and an elided line whose pieces
are in order; findings it cannot match are counted, keep the version
unchecked and are said in the panel. A title or what-breaks line loses
credential shapes, taken apart or not (a defence in depth), and keeps
names (UPPER_SNAKE variables, flags, model names, paths); an old finding
keys by its redacted quote, so a dismissal made before quotes were
redacted holds; a failure reads as one plain line; the Codex analysis
also disables code_mode and code_mode_host (both CLIs list them;
js_repl and apply_patch_freeform are removed, off, in both). Mutation:
52 mutants, all red, every run bounded. Residuals: a sub-second
Codex failure on the npm shim route may still leave a helper if no read
captured it (the VM measures how often); natural-language spellings of a
secret are not caught by the title filter; Codex still offers apply_patch
(refused by the read-only sandbox) and request_user_input (inert in exec)
and loads the account's own `$CODEX_HOME/AGENTS.md`; Windows
resources-folder ACLs inherit from the drive (#103). Owed: the independent
spec and code-quality reviews of round 3, the fresh ADR-009 pass, the VM
re-check (fast failures leave no helper; the Claude run keeps no
transcript and reaches the API through a proxy set only in the account's
settings file), a completed real analysis (the owner, a real model) and
the owner's screenshot review.

The VM re-check at 2499766e: on the direct route 10 of 10 sub-second
Codex failures left nothing behind; on the npm route 1 of 15 left a
suspended git that Codex had started 3 ms before it exited, which the
app's exact-pid taskkill (about 3 s later) did not end; all 75 decoy
processes survived; the Claude analysis kept no transcript and reached the
API through a proxy set only in the account's settings file; the
code_mode disables were accepted by both CLIs; findings that could not be
matched were shown as such; e2e 81, native 136. Round 4 (the last small
round; mocked): an update whose findings cannot be matched is analysed
again at most three times, then recorded as checked with a note; the
scheduled process-table reads stop once two scheduled reads in a row
find the run's chain alone (round 5: the reads at its start and first
output never count toward that; eight at most); and a leftover kill logs taskkill's exit code and message in one
line. The kill is not widened and no privilege is raised: if that log
shows access denied, the helper is held by Codex's own sandbox, an
upstream residual (the VM reads the log).

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
arms for Codex. From P3.5: the exact claim of a NEW Codex conversation from
the SessionStart hook's `transcript_path` (P3.1 evidence, answer 4), as
Claude's exact bind (#480); until then two new sessions of one account in one
folder (launched directly or choosing New conversation), started within
seconds of each other, can take each other's rollout, and each then keeps the
other's conversation for Restart and relaunch (P3.5's pick protocol already
keeps a picker session that resumes a conversation from taking another's,
and a resume by id takes only its own); the exact claim also clears P3.6's
uncertain case (a claim that could have been another session's is never
carried by a Switch account), so a Switch then carries every conversation,
and closes P3.6's other limit (a writer outside the app, such as the user's
own Codex CLI in the same folder on this computer's own sign-in, making a
claim look certain) and its fail-safe case (a new session that never claimed
its rollout counting as a possible holder until its process ends, so claims
in its account and folder meanwhile are not certain);
and following a
conversation switched inside the Codex TUI (its own resume or new: the
SessionStart hook's `source` and `transcript_path`), so the session keeps,
persists and on Restart resumes the conversation it is on.

Built (2026-09-30; d8f538b1; mocked). Row 63, the hooks: Codex has no http
hook, so each local Codex launch gets six command hooks through `-c`
(SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest
and Stop; async, 10 s), all running the app's forwarder
(`scripts/ccc-codex-hook.js`, on Windows through its `.cmd` wrapper), which
the app deploys into its resources folder at boot. The forwarder posts each
event to the Hooks gateway as a Claude http hook does: to 127.0.0.1 only, on
the session's own path with its token, within the gateway's 4 MiB cap, and
the gateway redacts it as it does Claude's. The session and its token come
from the environment Codex passes down and a hook file the app writes for
each launch (owner-only, in a folder of the app's naming, removed with the
session; stale ones swept at boot, never recursively); they are never on a
command line or in Codex's config. The forwarder refuses a malformed file, a
link or another session's, prints nothing and always exits 0
(`providers/codex/hooks.ts`, `hooks.test.ts`, `codex-hook-forwarder.test.ts`,
`spawn-hooks.test.ts`). The gateway only skips its held-open path for a
request marked as the Codex forwarder's (Codex's hooks are async; nothing reads
an answer); the token is checked first and Claude's path is unchanged
(`hooks-gateway-codex.test.ts`). The command is given only in a form its
route cannot reinterpret: the wrapper's plain path, or, on a direct launch,
PowerShell's call of a quoted path (Codex runs hook commands through
PowerShell on Windows; VM); a launch through the npm `.cmd` shim from a
resources folder whose path is not a plain word gets no hooks, and so does one
where the forwarder is not deployed. Codex asks the user to review hooks given
this way, once per account folder ("Hooks need review"); the command is the
same for every launch, so it asks once, and until they are trusted a Codex
session sends no events (section 10, question 4). The app's typed commands and
the Watchdog read that review as blocking and type nothing into it
(`codex-screen-hooks-review.test.ts`). Every event reaches the gateway's
subscribers as Claude's do; a Codex session's transcript path goes to its own
status line watch, never to Claude's binder.
Row 47: a Codex approval request (PermissionRequest) raises the attention dot,
as Claude's permission prompt does; a turn's end (Stop) raises it after the
60 s Claude's idle prompt waits, unless a prompt or a tool event came
meanwhile, and only while the tab is still a Codex session; a prompt or a tool
clears it. Which sessions are Codex's comes from main's own record, never the
payload (`attention-source.ts`, `attention-source-codex.test.ts`).
Row 46: the busy sweep and the sleep moon show on a Codex card as on a Claude
card (a shell card has neither), from output and silence; the moon, as
Claude's, rides the Watchdog's silence watch, so it shows with the Watchdog
on; the working pill names Codex on a Codex card (`SessionRow.tsx`,
`Badges.tsx`, `active-indicator.test.tsx`, `sleep-indicator.test.tsx`).
Row 43: the Watchdog arms for a local Codex session (never an SSH one), still
opt-in and off by default, with Codex's own detectors
(`watchdog/codex-patterns.ts`, `watchdog/detectors.ts`), never Claude's
(aicc_planning#72): a usage-limit error cell in the rows above Codex's
composer ("You've hit your usage limit", "Usage limit reached") and its reset
time (today's "try again at 3:05 PM", a later day's date, or none: the
fallback wait); a sustained server error cell after Codex's own retries (high
demand, at capacity, the retry limit exceeded on 429 or 5xx, a stream
disconnected, server overloaded, internal server error; "Reconnecting...
2/5" is Codex still retrying, not recovery); a turn running ("esc to
interrupt"). Its send gate is the app's own reading of a Codex pane (moved
unchanged to `src/shared/codex-screen.ts`, so main and the renderer read it
the same way): only Codex's ready, empty composer; a draft, a prompt, a turn
or a screen it cannot read defers. The retry is typed, then Enter 300 ms later
only when the pane shows exactly it typed at the composer, in the same watcher
(a respawn or a teardown in between types nothing more); when the composer
still holds exactly it but something else changed, only its own characters are
erased, never under a prompt; anything else is left and logged
(`codex-watchdog.test.ts`, `codex-watchdog-submit.test.ts`). The safeguard
check is unavailable for Codex (it has no flagged-safeguard message a retry
clears): off, not switchable, and the session's menu says why; the Settings
hint says the safeguard check is for Claude Code sessions. P3.4's
`needsClaude` is lifted from the showcase's watchdog page and What's New's
"Session Watchdog." line; with Claude Code off that section reads "Working
with Codex" (`whatsnew-showcase.test.tsx`).
The exact claim (from P3.5 and P3.6): every Codex hook event carries the
conversation's rollout (`transcript_path`; SessionStart comes with the
conversation's first turn, a new one or one resumed inside the TUI). The
session's watch takes it only when it is a rollout of its own realm, in real
day folders (no link), a plain file named `rollout-...-<id>.jsonl` whose
session_meta names that id; anything else changes nothing. It confirms an
inferred claim of the same rollout, or lets a wrong one go and claims the right
one, so two new sessions in one folder that took each other's rollout are
corrected at their first message, and a conversation switched inside the TUI
(its own resume or new) is followed: the session keeps, persists and on Restart
resumes the conversation it is on. A conversation another session's Codex
started (its SessionStart hook with `source: startup`; round 1, B4) proves an
inferred claim of that rollout here wrong: it is let go and never taken by
inference again; one that session only resumed proves nothing, since this tab
may have made it and still be writing it (`telemetry-exact-claim.test.ts`,
`pty-codex-hooks.test.ts`). A conversation the session's own hook named is
certain, so P3.6's doubt is cleared and a Switch carries it; the doubt about a
conversation a live launch resumed by id from a record in doubt stays, whoever's
hook names it (the app's choice, not the user's; round 1, S4), as P3.6 keeps
it. Where the session's own hooks have been heard (round 1, S4: keyed to the
session, not its account, so a tab that declined Codex's review keeps P3.6's
rules whatever another tab of the account chose), a conversation still only
inferred is not carried by a Switch: the session starts a new conversation on
the new account and says so, and nothing said is lost. So once a session's own
Codex has spoken, a conversation is carried only when that Codex named it,
which narrows P3.6's residual of a writer outside the app to the time before a
session's own hooks are heard; and a claim a session's hook named is certain
whatever launch has not yet claimed, which closes its fail-safe case
(`launch-handoff-pty.test.ts`).
The P3.7 VM finding: a tab on a conversation another tab holds showed an empty
status line, where Claude shows figures in both. It is now read beside the
holder, so both tabs show its figures, one tab at a time keeping its running
time, which the other takes over when that one lets go
(`telemetry-claim-anywhere.test.ts`, `telemetry-duration.test.ts`,
`telemetry-bounded-reads.test.ts`). What that buys, re-checked on the P3.10 VM
run: Codex itself lets one live tab write a conversation, on both tested
versions (0.155.1 shows its own "This conversation is open in another app"
screen until the first tab closes and the user presses R; 0.153.4 refuses the
resume, "already has an active writer", and the app's picker starts a new
conversation). So in practice the second tab shows the conversation's figures
while Codex's own refusal is on screen, and on 0.155.1 takes the running time
over as soon as the first tab closes and it retries; two tabs never both write
one conversation. Round 1 (V2) has the picker say plainly that such a
conversation is open in another tab.
The C item "untracked local Claude spawn": a local spawn that throws after its
process started now ends that process, unregisters its gateway token, removes
its per-session files and clears its account capture, then throws to the
caller as before (`pty-codex-hooks.test.ts`).
Round 1 (2026-09-30; afae03f7, f1d608f3; mocked). The ADR-009 pass
1 at 6d576634 returned FINDINGS: lens A, two major (the forwarder's request
honoured an environment proxy -- Node's NODE_USE_ENV_PROXY with HTTP_PROXY
has no loopback exception -- so the token and the event could reach a proxy;
Windows PowerShell 5.1 resolves `[ ]` in `& '<path>'` as a wildcard and could
run a wrapper in a sibling folder) and three minor (cmd.exe expanding `%` in
that path; a transcript path naming a Windows stream, or an id spelled in
capitals, taken apart from the walk's own spelling; where the per-launch hook
folders lived, now the app's own data folder, one per install); lens B PASS, with minor
findings (a killed session's late transcript path reaching the Claude sinks;
a failed or hookless launch keeping its gateway token; the hook of a tab that
resumed another tab's conversation proving that tab's correct claim wrong)
and a coverage gap (a live Claude session's path to the Claude sinks). The
spec review found two major (the Watchdog pill counting the check Codex does
not have as off; the Feature Guide saying the Watchdog is Claude-only) and
three minor; the quality review passed with fixes. The VM run found one bug
(below, V1) and two points to judge (V2, V3). Fixed: the forwarder posts with
no shared agent, so no proxy (A1); PowerShell's call is given only for a path
holding none of `[ ] * ?`, `% ! & ^` or a quote, and otherwise the launch
starts without hooks (A2, A3); a transcript path with a `:` after the drive
is refused, and a rollout is keyed by its day folder's own spelling (A4); the
per-launch hook folders live in the app's own data folder (this install's: a
dev build, the installed app and a test run each have theirs), in a real
`codex-hooks` folder made owner-only by the app's folder rule (every
inherited grant removed on Windows, 0700 elsewhere) and swept only there, and
the forwarder reads a hook file only at its real path below that data folder
(no link or junction the app made), with one name, opened without following
a link and still the file it looked at (A5). V1: Codex fires PreToolUse and
PermissionRequest for one shell command at the same moment, both async, and
when PreToolUse landed second it cleared the dot while the approval waited
(3 of 6 rounds on 0.153.4, seen on 0.155.1 too); a PreToolUse that may be its
approval's own call (the same turn and tool: Codex's PermissionRequest carries
no tool call id) no longer clears it, and a tool that ran, a prompt or a
turn's end ends the approval. A hook's transcript path is Codex's for as long
as the Codex launch's gateway token is registered, killed or not (B1); a
token nothing will use goes at once (no hook file, hooks the route cannot
carry, a failed spawn) (B2); only a conversation a session's Codex started
proves another's inferred claim wrong (B4, above); the route to Claude's sinks
is tested with a live Claude session (B5). A turn's pending idle mark goes
with its run (an exit, a Restart, a Switch) (Q1); a released claim's path is
handed to the watch again (Q3); claiming by inference after a refuted claim
stops at the 30 s no-claim deadline (Q4). A Codex session's header shows its
Watchdog pill (it has no account pill set) and counts only the checks Codex
has, so both on reads green, as three on does for Claude (S1). The Feature
Guide, the Watchdog tip and What's New say the Watchdog covers local Codex
sessions under its one switch (lens B's design note: as the SSH widening
did), and the Feature Guide's known issues explain Codex's one-time "Hooks
need review": what to choose, what declining costs (the attention dot and a
sure carry on that account) and how to trust later (S2). "Unconfirmed" and
the doubt are keyed to the session (S4, above), and the Switch notice says
Codex did not confirm the conversation, which is true in every case it is
shown. A Codex idle mark feeds the notification rules exactly what Claude's
Notification idle_prompt does (S5). V2: the picker, told which conversations
the other open tabs are on (ids only, from main's own record, as the launch
saw them), marks those rows "open in another tab", and when Codex refuses one
says so instead of "Conversation no longer available"; nothing else changes.
V3: the default resources folder has a space in its path, so a Codex
installed with npm (its `.cmd` shim runs under cmd.exe, which can carry the
hook only as a plain word) got no hooks by default. The app now keeps a
plain-path copy of the forwarder and its wrapper under the user's local app
data folder, `ai-code-conductor\codex-hooks-<tag>`, where the tag is a hash of
the install's resources folder, so a dev build and the installed app never
share it and an update keeps the same path (and so the same command, which
Codex keeps trusted); it is made owner-only, staged at boot, and checked again
before each launch uses it (real folders at both levels, plain files with one
name, the bytes of the resources folder's copy); a changed copy is never run.
The shim route alone uses it; a direct launch keeps its PowerShell call of the
resources folder's path. A user name with a space still gets no hooks on the
shim route. Also: the refused-path warning is logged once a launch (N1); the
C item's test checks the session files and the account capture (spec 7); the
P3.9 test's drive path (red on macOS CI at 97f18bca) is replaced
(`hooks.test.ts`, `codex-hook-forwarder.test.ts`, `spawn-hooks.test.ts`,
`telemetry-exact-claim.test.ts`, `attention-source-codex.test.ts`,
`channel-rules-idle-prompt.test.ts`, `pty-codex-hooks.test.ts`,
`launch-handoff-pty.test.ts`, `codex-resume-picker-open-elsewhere.test.ts`,
`session-header.test.tsx`, `app-knowledge.test.ts`). Every fix was red on
6d576634 first; 61 mutants, 55 red, and the six that stay green are
overlapping or equivalent checks and one host-limited case (on Windows a
stream name is refused twice), each recorded with the pair or call site that
is red.
The VM run at 6d576634 (WINDOWS_1, real Codex 0.153.4 and 0.155.1, a local
fake model, no paid model): passed, the review once per account folder and
nothing typed into it (1); all six events at the gateway on both versions and
both routes, the token on no command line, in no config.toml and in no log (2);
the exact claim of a new conversation with a rival tab, and Codex's own
/resume followed (4); a Switch carrying the conversation the session's hook
named (5); hooks through the npm shim from a plain resources path (6); the
P3.10 unit files on Windows (7); the Watchdog armed only when switched on, its
backoff and retry on a server error, the busy sweep, the pill and the moon
(8); e2e 81 of 81 (9). Found: V1 (a bug, fixed above), V2 and V3 (judged,
fixed above).
Round 2 (2026-09-30; 5b178c7a; mocked). The re-review of round 1: the spec and
quality reviews passed with fixes; ADR-009 lens A PASS on A1 to A4 (V3 not
assessed), lens B PASS with one minor finding. The VM re-check at the round 1
head (the same tree as ec16e61c): V1 passed, 12 of 12 approval rounds pulsed
on 0.153.4 and 0.155.1, the 6 that came in the bad order included; V2 on
0.153.4 the picker's row mark and its words, on 0.155.1 the row mark (Codex's
own lock screen never exits, so no picker words there); V3 the plain-path copy
staged at boot on both versions, used through the npm shim from the default
spaced resources folder, and reused under the same path on the next start with
no new review; the hook files in the app's own data folder, owner-only, the
token on no command line, in no config.toml and in no log; a user's own hooks
in the account's config.toml still ran beside the app's (S6); Q1 and the brief
regressions passed; e2e 80 passed and 1 flaky (a terminal-links case,
unrelated). Found: the header's Watchdog pill showed only after some other
change to the session list, and stayed green with a check switched off; and
one overload got two retries a minute apart though the first had worked.
Fixed: the pill reads the session's live watchdog state from the store, for a
Claude and a Codex session alike: the shell hands the header a copy refreshed
only on structural changes, which the watchdog is not (R1). An error or
usage-limit cell above a newer user message in a Codex pane is an earlier
turn's: Codex leaves the cell on screen after the turn that follows succeeds,
so it was read again; now one overload gets one retry, and a new error after a
retry that worked is a new incident (R2). Claude's detector has no such rule
(its twelve-line tail and the exact-render memo only). An approval request
that comes before its own call's PreToolUse takes that call's tool_use_id, and
while it waits only that call's PostToolUse, a prompt, the turn's end or a
newer turn ends it, so a call running beside it clears nothing; one that comes
after its own call's PreToolUse takes nothing, so the model's next call clears
the dot (R3). Both folders of the plain-path copy are made owner-only, and the
copy is used only when staged so in this run (R4); the forwarder compares file
ids as bigints (R5); the hook root is hardened once a run (R6); a copy that
could not be made is logged at boot (R7); a killed Codex session's gateway
token goes at the kill, its hooks staying Codex's until the process exits
(R8); the Feature Guide says the hooks send the app each event's details, on
this computer only, as Claude Code's do (R9); the picker is told only of tabs
on the same account, since Codex's writer lock is per account folder (R10)
(`session-header.test.tsx`, `codex-watchdog.test.ts`,
`attention-source-codex.test.ts`, `hooks.test.ts`, `spawn-hooks.test.ts`,
`codex-hook-forwarder.test.ts`, `pty-codex-hooks.test.ts`,
`app-knowledge.test.ts`). Each fix was red on ec16e61c first; 17 mutants, all
red.
The VM re-check of round 2 at 6b465aef (WINDOWS_1, real Codex 0.153.4 and
0.155.1, a local fake model): R1 passed, the header pill at once and following
a check switched off and on, on a Codex and a Claude session; R3 passed, 12 of
12 approval rounds pulsed, the four in the bad order included; R4 passed, both
plain-copy folders and the hook root with exactly the user's and SYSTEM's
grants and nothing inherited, and hooks on the shim route; R10 passed, a
conversation open on another account not marked as open in another tab; R2
passed for one retry per overload and for a new error after a retry that
worked, and failed for a persistent overload: every retry opened a new episode
at attempt 1 (8 retries in 5 min on 0.155.1, 6 in 3.4 min on 0.153.4), fixed in
round 3 (F2). Also seen: an approval declined with Esc ends Codex's turn with
no further event, so the dot stays up until the next prompt (limits, below);
and the Claude resume picker could not start a Claude CLI whose path has a
space (fixed in round 3, F5). e2e 81 of 81.
Round 3 (2026-09-30; 18029bb0; mocked). The re-review of round 2 and that
re-check. An approval request pairs with an open call only when that call's
PreToolUse reached the gateway within 3 s before it (CODEX_OWN_PRE_WINDOW_MS:
the VM's slowest own pair was an apply_patch, 2156 ms apart, and the model's
next call came about 7 s later), so a previous call's late PostToolUse, or a
stale open call, no longer clears a real raise (F1). The shared Watchdog state
machine keeps an overload episode that ended with the session moving on after a
retry until the session has been quiet for two minutes (OVERLOAD_SETTLE_MS: a
failing retry's error came back within seconds on the VM, and the CLIs' own
retries are not quiet), and an error before then continues it, for Claude and
Codex alike: a persistent overload now backs off 30, 60, 120, 240, then 300 s
and gives up at the two-hour cap (about 26 retries with the default settings),
where it retried about every 35 s (Codex, VM) or 40 s (Claude, lens B) without
end. No incident opens while the session works on, and a screen that moved on
ends the render memo, so a repeated error in a scrolled pane is seen (F2). A
hook folder the app did not make this run is used only once it belongs to the
user; otherwise the launch has no hooks, logged at boot and at the launch (F3).
The hook root is hardened once a run per folder identity, so one made again in
the run is hardened again (F4); a launch runs only the two verified names from
the plain-path copy (tested). The Claude resume picker runs an npm `.cmd` shim
as the Codex picker and the version probe do (`/d /v:off /s /c`, verbatim, the
shim path quoted, each argument as Node writes it), so a Claude CLI in a folder
with a space or brackets starts, as for an npm install under a Windows user
name with a space (F5). The Feature Guide's hooks text says a tool that has run
sends its result too, and that the hooks feed the notification rules (F8);
What's New has the fix lines (F7) (`attention-source-codex.test.ts`,
`overload-episode.test.ts`, `session-watchdog.test.ts`, `hooks.test.ts`,
`spawn-hooks.test.ts`, `harden-take-ownership.test.ts`,
`resume-picker-spawn-target.test.ts`, `app-knowledge.test.ts`). Each fix was
red on 6b465aef first; 39 mutants, 38 red, one equivalent on NTFS (the folder
identity alone catches a root made again).
Rounds 3b and 4 (2026-09-30; mocked; the wrapper and the folders' real rights
also on the VM). The re-reviews of round 3 and the VM re-check of the round-3b build: a
persistent overload backs off 30, 60, 120, 240 and 300 s and gives up, on a
Codex and a Claude session, and an error after two quiet minutes starts afresh
(F2); 12 of 12 approval rounds pulse with the 3 s window (F1); a hook folder
from an earlier run is used once it is the user's (F3, an admin account); the
Claude picker starts a CLI in a folder with a space (F5); V3 verified PASS. The
hook wrapper and the picker resolve their helpers from fixed locations: the
wrapper sets NoDefaultCurrentDirectoryInExePath=1 itself before it names a
program and asks `where` for node on the PATH, so node resolves the same way
from any start folder (VM: `hook-wrapper-start-folder.test.ts`, 2 of 2); the
command Codex trusts is unchanged, and the plain-path copy is staged again from
the resources copy. On macOS and Linux the launch environment keeps only
absolute PATH entries in every case (`codexOperationBaseEnv`). The Claude resume
picker runs a `.cmd` shim through `<SystemRoot>\System32\cmd.exe` by its full
path (ComSpec only when it names that file, C:\Windows only when SystemRoot is
not set, and a SystemRoot that is not a plain absolute folder refuses the
start); the line it runs is as before, and the Codex picker names cmd.exe by an
absolute path already. The hook folders are prepared asynchronously and only
while Codex is on (`codex-hook-folders.ts`): after the app's first paint, again
when Codex is switched on, and before a local Codex launch, which waits for them
at most 5 s and otherwise starts without hooks, logged. One call of the
owner-only rule (`owner-only-folders.ts`; on Windows one Windows PowerShell call,
started asynchronously from the system folder by its full path) makes each
folder, made now or found, this user's alone, a parent before a folder is made
inside it, and reads owner and rights back by SID; a folder is used only when
that read holds exactly the user and SYSTEM (the Administrators group
accepted), owned by the user, nothing inherited, and the two files are written
only after it; each folder is checked again before first use, and a launch
uses only a root this run prepared that is still the same folder (VM:
`owner-only-folders-real.test.ts`, 2 of 2: a folder open to Everyone and a new
one both left owner-only, a link refused with its target unchanged). It takes
the place of round 3's option on the credential-folder rule, which returns to
what it was (its test, `harden-take-ownership.test.ts`, goes with it). At the
app's start the main thread runs no PowerShell or icacls for the hook folders
(the round 3 VM run measured the navigation rail 0.45 to 0.9 s later with
them). An approval request after its own call's PreToolUse keeps that call, so
another call's PostToolUse leaves the dot up (P3); an overload episode whose
recovering frame was the session's last output settles two minutes after it
(P4); the backoff a retry logs is the one the episode then waits (P7); the
Feature Guide gives the overload backoff as the defaults do (P6)
(`hooks.test.ts`, `owner-only-folders.test.ts`, `codex-hook-folders.test.ts`,
`spawn-hooks.test.ts`, `pty-codex-hooks.test.ts`,
`pty-spawn-provider-off.test.ts`, `process-env-path.test.ts`,
`resume-picker-spawn-target.test.ts`, `attention-source-codex.test.ts`,
`overload-episode.test.ts`, `session-watchdog.test.ts`, `app-knowledge.test.ts`;
`hook-wrapper-start-folder.test.ts` and `owner-only-folders-real.test.ts`, CI
and VM only). Each change red first; 31 and 38 mutants (rounds 3b and 4), all red, four of them once a test was added for them; on the VM the wrapper without its variable, and the rule without inheritance off, are red too.
Round 5 (2026-09-30; mocked; the rule's real round trip also on the VM). The VM
confirmation of the round-4 build passed: the app's start against the 6b465aef
baseline with Codex on and off, no PowerShell or icacls with Codex off, one
asynchronous call after first paint with Codex on, an early launch that waited
and got its hooks, the folders' rights, 12 of 12 approval rounds, a fresh
episode after a last-output recovery, the logged backoff equal to the wait, e2e
81, and the VM-only files (`owner-only-folders-real.test.ts`,
`hook-wrapper-start-folder.test.ts`). The owner-only rule makes the round trip
exactly for any folder name: the script writes its answer in ASCII only, every
other character escaped, and each answer is matched to its folder by its place
in the call (G1; the names tested include accented, CJK and emoji names, the
typographic quotes, U+0085 and U+2028). A folder whose path has a name ending
in a dot or a space is refused, since Windows would act on another folder (G2).
A preparation that left no hook root is the answer for the same folders for
five minutes, so launches and the accounts service's changes meanwhile get it
at once; other folders are prepared at once (G3). A launch waits for the folders
only while the Hooks gateway listens (G4), and one that comes before the
preparation is wired waits for the wiring within the same 5 s (G5)
(`owner-only-folders.test.ts`, `hooks.test.ts`, `spawn-hooks.test.ts`,
`codex-hook-folders.test.ts`, `pty-spawn-provider-off.test.ts`; on the VM
`owner-only-folders-real.test.ts` with the round-5 module: 3 of 3, and red with
the round-4 module and with the answer unescaped). Each change red first; 13
mutants, all red.
Deviations, recorded: Codex's `notify` is not used. The Stop hook marks a
turn's end as `notify`'s turn-complete call would, and setting `notify`
through `-c` replaces the user's own notify program rather than adding to it.
Notification rules: the only rule on a hook event is the built-in Attention
Pulse (Claude's idle Notification; filter-only, it counts and sends nothing).
Codex has no Notification event; since round 1 (S5) its 60 s idle mark feeds
the rules the same input Claude's idle_prompt does, so the rule treats both
alike. That rule asks for a wait of at least 120000 ms, and Claude Code's
Notification payload carries no duration (its hook input is the event name,
message, title and notification type), so it matches neither assistant: left
unchanged here, a P3.16 sweep item. A conversation only inferred is not
carried by a Switch once the session's own hooks run, and a conversation
resumed by id from a record in doubt stays in doubt whoever's hook names it
(S3). A turn's end does not clear the dot (as Claude's Stop does not): it ends
a pending approval and arms the idle mark.
Limits, recorded: where Codex's hooks do not run for a session (Codex's review
declined or not yet answered, the Hooks gateway off, a Codex installed with npm
when neither the resources folder's path nor the user's local app data folder's
is a plain word, or no node on the PATH), it has no attention dot and P3.5's
and P3.6's rules and limits hold as before; the sweep, the moon and the
Watchdog read the terminal and still work. SessionStart comes with the first
turn, so until a session's own hooks are heard its claim is inferred and keeps
P3.6's rules (carried when certain), so a writer outside the app can still make
it look certain in that window, as P3.6 recorded. Stop does not fire for a turn
interrupted with Esc or failed (VM), so no idle mark follows one. How a POSIX
Codex runs the command is not yet seen (macOS and Linux). The hook files sit in
the app's own data folder, owner-only. The picker's "open in another tab" is as
the launch saw it: a tab opened on that conversation after the picker started
is not marked; and on 0.155.1 Codex shows its own lock screen and does not
exit, so the picker's words cannot appear there (its row mark does). An
approval request pairs with the open call whose PreToolUse came within 3 s
before it (a PermissionRequest carries no call id): a previous call of the same
tool in that window is taken for its own, and its PostToolUse then clears the
dot (none seen on the VM, where calls came about 7 s apart). The hook folders
are prepared asynchronously: a Codex launch that finds them not ready within
5 s starts without hooks (logged); the next launch has them. After a
preparation that left no hook root, the same folders are tried again after five
minutes (or at the next start). An approval declined with Esc: Codex ends the turn with no further
event (VM, both versions), so the dot stays up until the next prompt; Claude
Code sends none for a decline either (its Stop does not run on an interrupt,
and the app maps no other event), so a Claude session's dot does the same (from
the mapping and Claude Code's hooks reference, not run on the VM). A new error
within two minutes of a retry that worked continues that episode, with the
longer backoff, for Claude and Codex alike (F2). The plain-path copies are one
folder per resources folder path under `ai-code-conductor`; the app never
removes another's (another install or a dev build may use it), so one is left
behind after the resources folder moves. The forwarder's "never reads through a
file link" test skips on a Windows host without the right to make one; it runs
where links can be made (CI on macOS and Linux), and the junction cases run
everywhere.
ADR-009: yes. Pass 1 at 6d576634 FINDINGS (lens A two major, three minor; lens
B PASS with minor findings), all fixed in round 1; the re-attacks of rounds 1
to 4: lens A PASS on A1 to A4, lens B PASS, V3 verified PASS (P1 to P5 at the
round-4 build); their findings are fixed in rounds 2 to 5. SSH radius: yes; `pty-manager.ts` changes the Codex
launch branch, the local branch (the C item), the Claude branch's gateway token
record (one line), the shared exit and resource cleanup (the same token removal
plus that record, and a Codex idle mark dropped), killPty's removal of a Codex
session's token, and the local Watchdog arm site; and the shared Watchdog state
machine (rounds 3 and 4) also runs for Claude sessions over SSH, so the owner's
live SSH matrix includes the Watchdog on an SSH Claude session. Owed: the
independent spec and code-quality reviews of rounds 3b to 5; ADR-009 on rounds
4 and 5 and the PR-level pass on the final head; the VM re-run of the rule's real
round trip at the final build (G1, G2); a hook folder from an earlier run on a
standard account; the Watchdog on an SSH Claude session (a persistent overload backing off), in the
owner's live SSH matrix; a real paid-model turn (owner): an approval request
raising the dot, and the Watchdog on a real usage limit and overload; the POSIX
hook runner on macOS and Linux; the SSH live matrix at PR 3's head; the owner's
review of the P3.10 gallery and screenshots, and the owner's answer to
question 4.

**P3.11 Extra CLI arguments.** Claude's field and IPC character guard for
Codex, rejecting the flags the app manages (model, effort, permissions, MCP,
resume) and any setting that changes the account, provider or endpoint. Likely
files: `src/shared/types.ts`, `CodexFormFields.tsx`,
`src/main/ipc/pty-handlers.ts`, `providers/codex/spawn.ts`, `pty-manager.ts`.
Built (28739b19; round 1, 057fa776; mocked), settled by parity. The session
dialog renders the one Extra CLI arguments field (the same label, help button,
input and hint in both sections) in the Codex section, after the Permissions,
saved as the config's `codexOptions.extraArgs`, trimmed (nothing for a blank),
so it rides every path `codexOptions` takes (the launch, the saved session,
Restart and Switch). The rule (`codexExtraArgsProblem`,
`src/shared/extra-args.ts` since round 1) holds it to the shared guard (512
characters, the charset, no trailing backslash) and refuses, in any spelling
(shortened, extended with a hyphen, another case, with backslashes, a short
option clustered or with an attached value) and under every alias the
supported CLIs give it (their tagged sources, rust-v0.153.4 and rust-v0.155.1;
round 1, B1): the model (`--model`, `-m`); `-c`/`--config` whole, with
`--enable` and `--disable`, since the app delivers its effort, MCP server and
hooks through `-c` and a `-c` key can set any other setting; the permission
flags (`--sandbox`, `-s`, `--ask-for-approval`, `-a`, `--approve-for-me` and
its alias `--not-so-yolo`, `--full-auto`, `--yolo` and every `--dangerously-`
flag, the hook-trust one included); `--last`; the working folder (`--cd`,
`-C`, and `--worktree`, 0.155.1, which starts the session in a new folder;
round 1, B3: the app starts Codex in the configured folder or the resumed
conversation's, and finds a new conversation by that folder); and what changes
the account, provider or endpoint (`--profile`, `-p`, `--oss`,
`--local-provider`, `--remote`, `--remote-auth-token-env`). A plain lowercase
word, or one shaped like a slash command, is refused too: Codex reads the
first such word as one of its commands (`login`, `logout`, `mcp`, `resume`;
the list differs between versions and has names its help does not show) and a
word that is not a flag or a flag's value as its opening prompt. The one rule
serves the dialog, the pty:spawn schema, the restore sanitizer and the launch
builder. In the dialog (round 1, B2), while the value is one the rule refuses,
the field says why under it, the footer names it and Save waits; a Claude Code
config's field does the same by its own rule (the cap, charset and
trailing-backslash checks are one helper both rules call; the Claude Code
launch path is unchanged). At launch, pty:spawn repairs every spawn's
persisted fields before its strict parse, so a refused value that reaches a
launch (a config saved before the dialog checked it, a hand edit, a saved
session) is dropped with one log line and the session starts without it; the
builder checks again and ends a launch that reaches it with one. Each word is
one argument, after every flag the app sets, on the direct, resume-by-id,
picker and npm `.cmd` routes, exactly as typed (every allowed punctuation
character, share paths, doubled backslashes); no shell reads a Codex launch,
and the charset leaves nothing the cmd.exe route refuses
(`codex-extra-args-guard.test.ts`, `codex-extra-args-launch.test.ts`,
`spawn-extra-args.test.ts`, `session-dialog-codex-extra-args.test.tsx`,
`app-knowledge.test.ts`). Each change red first; 25 mutants in the build, 20
in round 1, and the 24 rule mutants re-run on the moved rule, all red.
Deviation, recorded: the field is rendered in `SessionDialog.tsx`, not
`CodexFormFields.tsx`, so that both sections render literally the same field.
Allowed for Codex: `--add-dir`, `--image`/`-i`, `--search`,
`--no-alt-screen`, `--strict-config`, `-h`, `-V` and the rest not named.
Limits, recorded: a folder or file named with a plain lowercase word, or a
one-part absolute path, is given as the value of `--add-dir`, with `=`
(`--add-dir=docs`) or as a path (`--add-dir ./docs`, or with its closing
slash); a Codex setting that rides `-c` cannot be given here; a word that is
not a flag or a flag's value is sent as Codex's opening prompt at every launch
and resume. Not yet seen: whether Codex runs an opening prompt such as
`/logout` as its command (such a word is refused either way).
Round 1 (057fa776, mocked): ADR-009 pass 1 at ed90b24d, lens A PASS (two test
gaps: a resume by id on the cmd.exe route, the exact words) and lens B PASS
(three minor items: the `--not-so-yolo` alias; a launch drops a refused value
and starts, where the text said it did not start; `--worktree`; and a test
gap, `-a x.y`); the spec review's findings (the allowed list on the rule's
own terms, the text) and the quality review's nits (the message, one helper,
the opening-prompt limit): all fixed. Before it, ed90b24d fixed two tests CI
ran red at 4ba85a3a after P3.10: the MP10 wiring scan in
`tokenomics-attribution.test.ts` follows main's route through
`routeHookTranscriptPath`, and `owner-only-folders-real.test.ts` compares the
folders' rights by full SID (SDDL writes the built-in Administrator, the CI
runner's account, as `LA`): 4 of 4 on the VM; the product's read already
compared full SIDs.
ADR-009: yes (the IPC schema, the restore sanitizer, the launch argv, the
dialog's check). SSH radius: yes; `pty-manager.ts` changes its inline
`codexOptions` type only, and no SSH path changes (a Codex session over SSH
is refused before anything is built), so the SSH live matrix at PR 3's head
has no Codex case for it. Done: the VM run at 919385af (WINDOWS_1, real Codex 0.153.4 and 0.155.1): all five checks PASS on both versions (extra arguments on the direct and npm `.cmd` routes, through the picker and on a resume by id; a refused value said in the dialog, Save waiting; refused saved values dropped at launch with a log line, the session starting without them; the Claude Code field with the same dialog check and its launch unchanged), e2e 81; the round-1 re-review at 919385af, spec PASS and code quality PASS (its nits closed in 31387231); ADR-009 pass 2 at 919385af, lens A PASS (no mismatch on any of the 12 routes over 644 values; nothing the first rule refused passes, over 61,998 values; the mutants that survived pass 1, S7, W1 to W4 and the picker pre-check, now red) and lens B PASS (the alias list re-derived from both tagged sources, only `yolo` and `not-so-yolo`, both refused; the schema, the rule, the restore and the builder agree on 6,000 values; the dialog can only hold Save; the Claude Code launch unchanged over 6,009 values); the ADR-009 verdict for P3.11 is PASS (the marker is the owner's to post). Owed: the owner's screenshot review of the field and its message, both assistants, both themes (gallery `.ccc-canvas/screens/p3.11-919385af/`); the SSH live matrix at PR 3's head (no Codex case: a Codex session over SSH is refused); the PR-level ADR-009 pass on PR 3's final head.

**P3.12 Logs and GitHub context.** Each realm's rollouts indexed for Logs
(history, search, transcript), realms never crossing; the Logs tool live on
Codex tabs; the GitHub panel's session context reads the session's realm
rollouts. Likely files: `src/main/logging/*`, `session-capabilities.ts`,
`CommandBar.tsx`, `src/main/github/session/transcript-loader.ts`,
`pty-manager.ts` (run registration). ADR-009: yes (paths inside the resources
directory, IPC). SSH radius: yes. The onboarding Transparency page's "Index
conversation logs" card still names only Claude's transcripts (left by
P3.4): it names what is indexed once Codex's are. From P3.5: the name file
Claude's picker prefers (`<transcript>.ccc-name.json`, written by the logs
binder on a rename and on an exact bind, session-name-sidecar.ts) is written
next to a Codex rollout too, against an exact claim only, so a renamed Codex
conversation keeps its name in the resume picker after its tab is closed
(today the picker names it from the session state while the tab is open or
saved).
Built (d86fd80f; mocked), settled by parity. A local Codex session records a
run under the gates a Claude run has (`shouldRegisterRun`: not a shell, not
SSH, not the Ask pane, the per-config and global switches). Its transcript is
the rollout its own watcher claims: the watcher tells a new `onRollout`
listener the rollout it claimed (the plain rollout file of the session's own
realm its P3.5 and P3.10 checks found; a hook's path only through
`noteExactRollout`), whether it is exact and whether another tab holds it,
and null when it lets the claim go. The Codex log binder
(`src/main/logging/codex-log-binder.ts`) holds a claim until the run is
recorded (a resume claims at once, and a Restart reuses the session id),
binds it exact (a resume by id, a pick, the session's own hook) or heuristic
(folder and time), binds it again as exact when the hook confirms it and
never the other way, retires its tail when the claim is let go (a new worker
message, `transcript-unbind`: drained, marked complete, its rows kept) and
never indexes a conversation another tab holds, as Claude's binder refuses a
conversation another live session holds (#480). It is not Claude's binder,
whose canonicalising, scan of `~/.claude/projects`, resume-bind and durable
resume record are Claude's; none of them is armed for a Codex run. The worker
picks the normalizer by the binding's stored format (the existing
`sourceFormat` column; a worker restart resumes with it): the Codex
normalizer (`src/main/logging/codex-rollout-normalizer.ts`, beside Claude's)
indexes the conversation as Codex shows it (the `event_msg` user and agent
messages of legacy history, the item_completed UserMessage and AgentMessage
of paginated history; a rollout persists one of the two), a tool_call row per
call from the response items both histories persist, with Claude's bounded
preview (the command, the shell's own script when wrapped; the first file an
apply_patch names; a search's query), and never injected context (the
response-item messages), reasoning or tool output; an unknown record type is
kept as an unsupported entry. Each page row carries its run's provider, so a
Codex turn reads codex with the Codex mark. The Memory page's recent-sessions
rail keeps to Claude runs. The Logs tool is live on a local Codex tab (the
'codex' empty reason is gone); a Codex config has the one Index conversation
logs field (the same render in both sections), saved as
`codexOptions.loggingEnabled` and carried at launch and on restore. The
onboarding card names what is indexed by the assistants in use; Settings,
the consent prompt and the Logs page's delete confirms name Codex's folders.
The name file: an exact claim writes the name remembered for the session
next to the rollout (`rollout-....ccc-name.json`) and forgets it, and a
rename writes against the exact claim (else remembers it), as Claude's
binder and rename do; only inside the realm's real YYYY/MM/DD folders, never
through a link (a new file created exclusively, then renamed into place; a
link or folder there is left alone). Codex's picker leads a row with it
before the session-state names. The GitHub Session Context of a Codex
session reads the rollout its watcher holds (kept per session by pty-manager,
bounded, replaced by the next claim, dropped when let go), checked again
inside its realm (a rollout's name in a day folder of real folders, which is
the containment too), with Claude's bounded tail (the last 1 MB and 500
lines), mapped for the unchanged scanner and inspector (a shell command as
`Bash`, a file an edit names as `Edit` or `Write`); nothing when it holds
none.
Limits, recorded, none a UX decision: two new sessions of one account in one
folder started within seconds (P3.5's limit, until the session's own hook
claims exactly) may index each other's conversation until the claim is
corrected, which retires that tail (what was indexed stays, as a Claude
heuristic bind's does); a tab on a conversation another tab holds does not
index it while the holder runs, and indexes it once the holder stops (in its
own slot, from its start: each session's slot holds the conversation it had,
and search lists each of its turns once); the name file is written against an
exact claim
only, so a new conversation in a session whose hooks were declined is named
in the picker only while its tab is open or saved, and after Switch Account
the copy in the other account's folder has no name file until the session is
renamed again (known issue, with that workaround); a Codex tab that has
claimed nothing yet reads no Session Context; what a Codex conversation holds
is left out by record time (a record stamped inside a window when it was
written while not indexed), so a record stamped at a moment a session not
indexed held the conversation is left out whichever session wrote it (two tabs
writing one conversation at once; a conversation another session indexed, taken
up by a session not indexed (Codex's /resume inside it), is left out from the
moment that session became not indexed (a known limit: the turns another
session indexed in between are left out of a later reader's read from the
start, toward not indexing, and stay in the index from the session that
indexed them); a quit or a crash leaves a window open until the next start, so
a record Codex writes in between, in a run outside the app, is left out of a
later read; a killed session's window closes when its process has ended, so a
launch that is indexed straight after a Restart or a Switch has the old
process's wind-down, a few seconds at most, left out too, and if Codex's
exit is reported after that grace, what it writes between the grace and the
exit is in no window, which the VM never saw: Codex wrote nothing after any
kill and its exit was reported 0.13 to 0.38 s after it); a record
of those windows found damaged at start makes every record stamped before then
count as so written, and a full one does the same for the conversations it
drops; the name file and the GitHub loader check paths (the realm's
real path and its real day folder, the file opened the one looked at), so
repeated swaps of a day folder between a junction and the real folder, which
need write access to the account's sessions folder, can still let a name file
be written, or a stray temporary file be left, outside the realm, or another
file be read: inherent to a path check on a folder the user's own processes
can change (Node has no directory-handle-relative open or handle-to-path call
on Windows to do better without a native module); a resumed
Claude transcript is indexed again under the new run (Claude's path,
recorded for P3.16), while a resumed Codex conversation continues from what
was indexed.
Deviations: a separate `onRollout` listener rather than a path on
`onClaim`/`onShared` (whose payloads stay as they are); a worker message
of its own for a claim let go (Claude has no release); the Memory rail kept
to Claude runs; `CommandBar.tsx` needed no change (it reads
`session-capabilities`). Left to P3.16's tour sweep: `training-steps.ts`
lines 595 to 612 describe Logs over Claude's transcripts (incomplete, not
false).
ADR-009: yes (the path the worker tails, the name file written into a
realm's folder, the picker's and the Session Context's reads of a realm's
files; no new IPC channel, and the rename channel routes a Codex session to
its exact claim; every logs2 channel answers only the app's own window, its
main frame, by the account handlers' check, `trusted-sender.ts`).
SSH radius: yes; `pty-manager.ts` changes the Codex
branch (the binder told of each launch and claim), the shared run block (the
Codex run recorded, Claude's discovery kept to Claude runs), the exit (the
binder told) and a bounded record for the Session Context; no SSH path
changes (a Codex session over SSH is refused before anything is built, and
the gate still refuses SSH runs; the shared spawn block reads the config's
switch as saved, marks the conversations a local Codex session not indexed is
on (from the moment it became not indexed, the launch time taken before the
Codex process starts), and ends the
open run of a spawn that is not indexed, which an SSH spawn never has; the
session cleanup clears the Codex log binder's state and re-checks the other
Codex sessions).
Reviews of the build (d86fd80f, docs ff7be273): the ADR-009 pass 1, lens A
PASS (three minor findings and a test gap) and lens B PASS (two minor
behaviour findings, two coverage findings and one on the consent notice); the
spec and code-quality reviews PASS with fixes. Reviews of the first fixes:
code quality PASS (three nits); spec, wording findings; the ADR-009 pass 2,
lens A and lens B one major finding each, with minor ones. Reviews of the
second fixes: the ADR-009 pass 3, the last bounded one, lens A PASS (two minor
findings) and lens B one major finding; spec, one blocker (a changelog
sentence); code quality PASS with fixes (two minor). P3.12 is QUARANTINED under
ADR-009: its bounded rounds are exhausted, the third fix list landed without a
further re-attack, and the fresh PR-level ADR-009 pass covers it. After the
quarantine, the code-quality review and the VM re-check of the third fixes
gave a fourth, small list; it is done too, below, and the same PR-level pass
covers it. The VM re-check of the fourth fixes gave a fifth (the rule by
record time); the independent spec and code-quality reviews of that rule gave
a sixth, small one (a major finding on where a window starts, a minor one on
the quit, two nits); both are done, below. The independent reviews and the VM
re-check of the sixth fixes gave a seventh, also small (a major finding on a
killed session's window, two minor ones, and a limit accepted); it is done too,
below. The independent reviews of the seventh fixes gave an eighth, tiny one (a
merged-away window left open when its session ends, a test that now reads a
Switch's copy, and a limit recorded); it is done as well, below, and the same
PR-level pass covers them all.
The VM check at ff7be273 (WINDOWS_1, real Codex 0.155.1 direct and 0.153.4
through the npm shim): (1) a Codex session's turns and tool calls indexed and
searchable, injected context, reasoning and tool output not: PASS; (2) a
session started with logging off, per config or globally, records nothing,
and the consent notice and the onboarding card name Codex: PASS, with
finding V1 (the switch and running sessions); (3) two tabs, a Switch, Codex's
/new and /resume: each tab's index only its own conversation, the binding
following: PASS, with finding V2 (a resumed conversation in search); (4) the
name file only at an exact claim, and the picker's name after the tab closed:
PASS, with finding V3 (the picker's titles and injected AGENTS.md text); (5)
a Codex session's Session Context, its commands and edited files, nothing
before its first turn: PASS, with two points (its heading, and one file named
two ways); (6) a Claude session's logs and Session Context unchanged: PASS;
(7) e2e 81 passed; the VM-only, P3.10, P3.11 and P3.12 files and the native
files (transcripts-db 46, transcripts-worker 29) exit 0. Its re-check with
the first fixes (the same versions): V1, V2, V3, the notice once more (B5),
the Session Context heading and list (A4) and Switch Account's Session
Context (B2, on 0.153.4) PASS; one finding (turns written while indexing was
off), fixed in the second list (W4); e2e 81 passed; the vitest and native
files exit 0 (transcripts-db 49, transcripts-worker 29). Its re-check with the
second fixes (the same versions): W4, W3, W9, W2 and W7, and the regressions,
PASS on both; Switch Account's not-carried case (B2) last seen at the re-check
before. Its re-check with the third fixes (the same versions): a new tab
resuming a conversation written while not indexed, through the picker and by
id, never indexes what was written then (X1); a conversation begun elsewhere
afterwards is indexed in full (X1); a damaged record is set aside (X2); the
changelog line (T1); and the regressions: PASS. One observation: search listed
a conversation twice when two tabs' sessions had each held it (item 3 of the
fourth list). Its re-check with the fourth fixes (the same versions): search
listing a conversation two tabs had once, the damaged records kept, and a copy
after a Switch carrying a digest (also after an app restart): PASS; three
findings: the first turn after returning from a stretch not indexed was lost
(F1), a Switch after such a stretch read its copy from the start and indexed
the turns written while off (F2a), and a new tab reading the conversation from
its start did the same (F2b); all three came from a rule by position in the
file, replaced by the rule by record time (the fifth list). Its re-check with
the sixth fixes (45dae0db, the same versions): the first turn after returning
kept, A then B then A, a Switch after a stretch not indexed, a new tab through
the picker and by id after an app restart, Settings and a config switched
on, off, on, before the consent notice, an app crash, a damaged record, two
tabs, a session's session_meta and first prompt never indexed (Z1), a resumed
conversation keeping the turns it had indexed, a quit while not indexed, a
tab killed and the conversation read from the start, and the audit of the index
(search once per turn: 47 markers, no mismatch, on both versions): PASS. One
failure, on an upgraded round-4 folder (a record of the version only unpushed
P3.12 builds wrote: a null digest let three turns be indexed on 0.155.1, and
one marker mismatched on both): not user-reachable, because no pushed build or
release ever wrote that record version, so no migration is built. One
observation: on a Save-sessions quit the app exits each session gracefully
first, and each window closes at its session's reported exit (after Codex's
last write); a kill of the app leaves them open for the next start. Its
re-check with the seventh fixes (ff245238, the same versions): a Switch while
not indexed with Codex killed mid-turn, the copy and the original read from the
start; a Restart into an indexed launch, read from the start; a tab closed and
the conversation taken up in a new tab by id through the picker; the window
closing at the process's reported exit (0.13 to 0.38 s after the kill) and
nothing written by Codex after the kill; a session's first prompt never
indexed (Z1) and a resumed conversation keeping its turns; a quit with Save
sessions while not indexed and an app crash; F1, A then B then A, F2a and F2b;
and the audit of the index (search once per turn: 30 turns, no mismatch, on
both versions): all PASS on 0.153.4 and 0.155.1, no mismatch (the one marker
collision was the harness's, checked by exact text). The null-digest case is
not producible on fresh data (only an upgraded record, declared not
user-reachable above).
The fixes (mocked). The logging switches, both assistants (V1, W3): turning
Index conversation logs off, in Settings or in a config, stops indexing the
running sessions it covers at once (their runs end as stopped, their tails
drain and retire, a Codex session's later claims bind nothing); every launch
(a new one, a Restart, a Switch Account, a restore) reads the Settings switch
and the config's own field as saved, so a relaunch while it is off records
nothing and ends any run the session still had open; turning it on applies to
sessions started after it, and every text about the switch says so. What a
Codex session writes while it is not indexed is never indexed (W4, X1-X3,
Y1, Z1-Z4): main keeps, per conversation (its rollout id, so an account copy is
the same conversation), the wall-clock windows during which a local Codex
session not indexed held it (logging off in Settings or in its config, or
before the notice naming Codex was seen): a window opens at the moment the
session became not indexed (its launch, taken before the process starts, or a
switch-off), whichever conversation it goes on to claim, and not at the claim,
because Codex writes a conversation's session_meta and first prompt before the
claim, whatever the rollout's own first record says (main does not read the
rollout). A conversation begun before that moment (a resume) opens at that
moment, so what it had indexed stays indexed. A window closes in these ways,
each exactly: (1) a session that ends on its own, or exits gracefully before a
quit, closes its window when its exit is reported; (2) a session that is killed
(a tab closed, a Restart, a Switch) is released from its window at the kill and
the window is closed when that process's exit is reported, or when the grace
its account lease uses (6 s) has passed with none, by a closer bound to that
exact window (never another session's, never a newer launch's; a window merged
into an older one, past 64 on a conversation, is left open when its session
ends or is killed: toward not indexing), because a
killed Codex goes on writing while it winds down and a Switch's carry copies
what it writes; (3) a claim of another conversation closes the first window at
the claim; (4) a quit (the quit teardown, SIGTERM) flushes the record with a
latch: the windows still open stay open, here and on disk, and nothing closes
them while the app tears down, because Codex's last records land after the
quit; the next start closes them at its time, as after a crash; (5) an OS
shutdown that may be vetoed flushes the record without the latch, so the
windows still close if the app runs on. The record is kept in the app's data
folder whether or not logging is on (a new window written at once, the rest
coalesced, atomically, and what is pending at a flush); nothing clears a
window. The worker starts with every window and is
told of each change, and every read of that conversation, from any tab,
session, copy or offset, leaves out each record stamped inside a window (a
record at a window's start is inside it, one at its end is not; a stamp with
no zone designator is no time, which Date.parse would have read as the
machine's local time; a record with no time of its own takes the time of the
record before it in that read, and with none is left out whenever the
conversation has a window; the conversation's key is worked out once per
tail), with one
divider saying the turns while logging was off are not indexed where a
skipped run of records was. Nothing written while indexed is left out, so the
turn that comes with a resume is kept. A record found damaged at start is kept
aside (the newest three), and every record stamped before then counts as
written while not indexed; a full one merges a conversation's oldest windows,
and drops the least recently changed conversation only after that rule covers
its windows. Otherwise a new run continues a conversation (V2,
W5, W8, X4, Codex) from what the same session's earlier run read of it: the
same file (by its identity), or after a Switch the conversation's copy in the
other account where its own first bytes have the digest of the bytes that
earlier binding read (stored with that binding's cursor, so it holds across
app and worker restarts, and a tail resumed after a restart goes on vouching
for what it read), whatever the earlier file holds now; another file at a path
is read from its start, and a copy that went its own way whole (the digest of
a resumed tail is checked when it next reads, not at the worker's start).
Search lists each turn of a Codex conversation once, whichever sessions
indexed it (a turn is the same when it is of the same conversation, a rollout
id both runs read, and its role, its record time and a hash of its words are);
Claude's hits are listed as before. Claude's resume binds the resumed transcript as
a new transcript of the new run and indexes it from its start, so its earlier
turns are listed twice; recorded for P3.16. A Codex tail reads only the file
its watcher claimed (A1, W6): the file's device and file id ride on the bind
and are kept across a worker restart, another file at the path is not read
(its tail retires), and a bind without that identity binds nothing. The
picker (V3, B6, Q2): a conversation's title is its first user message as the
index reads it (the plain user_message and the item_completed UserMessage
events, never the response items, which carry AGENTS.md and the environment;
a head with no such event falls back to the response items, skipping that
context), and a user_message of another kind than plain (user_instructions,
environment_context) is not the user's words, in the index or the picker; a
test feeds both the same records. The Session Context (A4, W7, B2, both
assistants): a recent file is shown as plain text, relative to the session's
folder when inside it, and once per file (by its path, case-folded for a
Windows folder, and the list keys its rows on that path); the heading names
the session's assistant; after Switch
Account the earlier account's rollout is not read until the new launch
claims one. The name file and the GitHub loader (A2, W2, Q3, A3): the file
written or read must sit in the realm's real day folder (the realm's real
path taken before its folders are walked, compared case-folded on Windows); a
new file elsewhere is taken back, as is one whose write fails (the limits
above say where a path check stops); the picker's and the loader's same-file
checks are tested by a swap. The logs2 channels
answer only the app's own window, its main frame, by the account handlers'
check; a rename takes the Codex binder's path only while the session runs as
Codex, and the binder's state goes with the session's resources (Q1). A
session whose own hook named the conversation is indexed once another tab's
inferred claim on it is refuted, and a session reading a conversation beside
a holder that stops holds it then (B1, Q3). A run that goes back to a
transcript it held (A, B, A) marks it with a divider (Q2). The indexing
notice (B5, W9): shown once more to a Codex user whose seen notice predates
Codex's indexing (a notice version), and before the first-config dialog when
due; a Claude-only user, or one who turned indexing off, sees nothing new;
main records a Codex run only once that notice was seen. Tests only: an
unbind stays within the sending session (B3); the rename asks about the
caller's own session (B4). The sixth list (Z1-Z4), mocked: a window opens
when the session became not indexed (Z1: tests for the launch, a resume
claimed during the launch, a switch-off before any claim, a later claim of
another conversation, a reader from the start leaving the first prompt out, and
a resumed conversation keeping the turns it had indexed); a quit leaves the
windows open and the next start closes them (Z2); a stamp with no zone
designator is no time (Z3); the key is worked out once per tail (Z4). Red on
the fifth list's commit: 14 tests in the 4 touched test files. Its first cut
also bounded a window below by the rollout's own first record, read in main;
the seventh list removed that (below). The seventh list (K1-K6), mocked: a
killed session's window closes when its process's exit is reported, or after
the grace, not at the kill (K1: tests for a tab closed, the grace with no
exit, a Restart whose new launch keeps its own window, a quit during the
wind-down, two sessions on one conversation, a closer after a final flush, a
window merged into an older one, and a reader from the start leaving out what
is written between the kill and the exit; a session that ends normally closes
its own window and not another tab's); the window starts at the moment the
session became not indexed and nothing of the rollout is read in main (K2: the
bound by its first record changed no outcome for a well-ordered rollout, let a
stamp out of order narrow the window, and was a new read surface; its tests
and the two survivors it had go with it); an OS shutdown that may be vetoed
flushes without the latch (K3, tested at the unit and at the call site); the
in-session /resume limit and the quit and kill paths are recorded exactly (K4,
K5, above). Red on the sixth list's commit: 13 tests in 4 of the 5 touched test
files. Counts: the sixth list's fix commit says 392 affected and tree-scanner
files; 391 ran (this corrects that; the history is not rewritten); the seventh
list's run is 391 files, all green on the host. Mutation: every guard broken
alone turns a test red (172 mutants through the fifth list; the one
equivalent is recorded; the sixth list ran 30, 28 red and two equivalent, both
on the first-record read, which the seventh list removed; the seventh list ran
21, all red). The eighth list (L1-L3), mocked: a session that ends while its
window was merged into an older one leaves that window open and closes no other
session's on the conversation (L1: tested with a second open window, red on
the seventh list's commit, 3 mutants all red; the fallback to the latest open
window, and the guard it needed, are gone); the test of a killed session's
records read from the start also reads a Switch's copy in another folder under
the same rollout id (L2); the late-exit limit and the seventh fixes' VM
re-check are recorded above (L3). Run: 391 affected and tree-scanner files, all
green on the host. The eighth list needs no VM re-check: L1 takes more than 64
windows on one conversation, so the unit test covers it.
Owed: the native SQL tests in CI (the identity column
and its migration, the prior bindings by session, the read digest stored with
the cursor, search through the repeat check); the owner's screenshot review (the VM checks' galleries);
the fresh PR-level ADR-009 pass (P3.12 is quarantined under ADR-009: its
bounded rounds are exhausted); the SSH live matrix at PR 3's head (no Codex
case: a Codex session over SSH is refused).

**P3.13 Multi Spawn and Quick Start.** N copies of a Multi Spawn Codex config,
one lease each; Quick Start with Codex; a test on the Codex path. Enforcing the
one-at-a-time rule in main also closes that C item. Likely files:
`sidebar/QuickStartPanel.tsx`, `sidebar/MultiSpawnControl.tsx`, the launch gate
and leases. ADR-009: yes (the launch gate).
Built (3e45825d; round 1, 54422e2a; round 2, b86bed6d; round 2b, 86e3efb9; round 3, f16a756a; mocked), settled by
parity. The sidebar's half was already provider-neutral (its pins, rows, popover and select lock ask
one rule and read each provider's own launch gate), so the work is main's half
and the tests on the Codex path. A saved config that is not Multi Spawn runs one
copy at a time in main, at `pty:spawn`, the one path every launch takes, for
every config: Claude, Codex, terminal-only and SSH. The rule gates NEW copies
only: a session that already has the right to run keeps it (below), so no
Claude behaviour changes except that main now enforces for new copies what the
sidebar already enforced. The rule and its words are one definition
(`src/shared/multi-spawn-rule.ts`), and the sidebar's `isMultiSpawnLaunchBlocked`
and popover copy delegate to it. The gate (`src/main/launch-one-at-a-time.ts`,
called in `pty-handlers.ts` straight after the provider rule) reads whether the
config is Multi Spawn from the saved configs on disk (the first with that id, as
every other reader takes it), never from the request. It asks and claims in one
synchronous step, before the first await and before anything is installed,
prepared, leased or spawned (every path with an await registers its spawn with
pty-manager before it), so a second copy asked for while the first is still
preparing its account finds it. Whether a copy is still live comes from
pty-manager at the moment of asking (`isSessionLiveOrStarting`, the end of
`pty-manager.ts`: a PTY, or a spawn parked or preparing), so nothing is released
and a launch that fails after the gate leaves nothing behind. A refused copy
answers with the typed refusal `already-running`, takes no account lease and
starts nothing. The refusal is its own type (`SpawnRefusal`, in
`shared/providers/launch-refusal.ts`), so the provider gate's refusal type, which
the accounts service and the other entry points branch on, is unchanged. The tab
says it as it says a provider that is off ("Not started. <config> is already
running. It isn't a Multi Spawn config, so it runs one at a time. Close the other
copy, or turn on Allow Multi Spawn for it, then Restart this tab."), is kept, and
a restore's conversation target goes back on its record. The config's name in
the refusal is made safe to show in a terminal (`stripSpoofableText`) and is
never logged; the config's id in the log is made safe too.
Round 1 (the spec and code-quality reviews and two ADR-009 lenses; the rule gates
new copies and a session that already runs keeps its right: the orchestrator's
decision, pending the owner's confirmation, in the owner queue).
Who keeps the right to run, never refused: (a) a session accepted for the config
in this run, through a Restart, a Switch account, a Recover or an SSH reattach,
with another copy live or not, whatever the config says now (Multi Spawn may have
been unticked while the copies ran): the right outlives the process, because a
Restart kills it first, and is bounded (512: a session that has ended goes before
one that is live, the oldest first); (b) a session
restored at this start: main seeds the ids it read from the saved session state
at the first load of the run (the session load's read-back, `app-session-durability.ts`;
never a flag the renderer sends), the saved sessions and the remotes left running,
each for the config it was saved with, until its first accepted spawn. A right is
for one config. A spawn is recorded as a copy only once pty-manager accepted it
(`settleConfigLaunch`, called by `pty:spawn` straight after the spawn call), so a
live session's record is never re-pointed by a spawn that is refused or throws,
and a session later spawned as a non-copy stops counting as one. Not copies: a
spawn that names no saved config; and the renderer's own partner terminal in its
exact shape (shell-only, the session id plus a suffix the renderer and main share,
with a test that the renderer's three files use it, no ssh block, no terminal
options, no elevation), never a copy and never counted, whether or not main holds
its session: round 1 counted the shell of a tab that started nothing (its provider
was off) as a copy, so a plain shell blocked a new tab and the tab itself. The shape
reads no SSH credential and no secret argument, which a test asserts. The first cut
also exempted
an Ask flag and an `ssh.reconnect` flag; both are gone, because a request could
name a config's credentials (an SSH password, a terminal secret argument) and set
either to start a second credentialed copy. Every legitimate reattach is a
session of this run or a restored remote, so the flag was never needed. When main
refuses a copy while the screen shows Multi Spawn on (a save that did not land),
the tab asks main for the saved config and the toggle is made the saved one
(`src/renderer/utils/refusedMultiSpawn.ts`; screen only, nothing is written; it looks
at the toggle again after the read and leaves a change the user made meanwhile alone).
Round 2 (the second ADR-009 pass, lens A passing with two minor findings and lens B
finding the partner major above; the spec and code-quality reviews). Round 2 added a
lapse of rights (a right lapsed when a new copy of its config was accepted while the
holder was not live) and round 2b exempted the restored ones; round 3 removed it
altogether (below). A restored right is one-shot and bounded to the ids saved at the
last quit (round 2b, the orchestrator's decision: the shipped app resumed a restored
remote or tab on its first view even beside a new copy); its first accepted spawn
consumes it, and what is left is a right of this run. `claimConfigLaunch` hands back a ticket per spawn that passes the gate and
`pty:spawn` settles that ticket only: a forged spawn of the same session id that
throws after the gate cannot overwrite a pending spawn and re-label it at settle;
each pending spawn keeps its own ticket (at most 8 per session), a ticket settles
once, and one the gate did not hand out settles nothing. A restored tab spawns on its
first view (settled by the spec review and ADR-009 lens B), so a restored set starts
as its tabs are shown; the rule does not depend on it.
Round 3 (the third and last bounded ADR-009 pass: lens A passed with two minor
findings, lens B and the spec review found the same two cases, the code-quality
review passed with one nit, and the VM check passed at 7c52a432; the orchestrator's
decision). The lapse of rights is removed. It protected nothing against a
compromised renderer, which the rule is not a boundary against (limit 4), and it
refused what the shipped app allowed: Leave running on an SSH Persistent tab, then a
new copy of its config, then Resume was refused with its card dropped and the remote
orphaned, and a Restart of an ended tab after Multi Spawn was turned off was refused.
A session id accepted in this run now keeps its right for the run (the store stays
bounded, an ended session going before a live one), a restored right stays one-shot
and bounded to the saved ids, and only an id that was never accepted and never
restored is gated, so main refuses what the sidebar refuses, a NEW copy. Pending
tickets: `pty:spawn` discards its ticket on every throw and every early return (the
body is `spawnSession`, and the registered handler discards in a `finally`; a ticket
already settled is gone, so it does nothing then), a spawn that is not a copy keeps no
pending ticket, and a session that already has 8 spawns of its id under way is
refused the NEW claim (`already-running`) instead of the oldest being pushed out
(lens A's N4c: nine forged same-id spawns that threw pushed a real launch's ticket
out while it prepared, and a second copy then got through). The toggle's second look
also compares the config object, so a toggle put off and back on during the read is
not overwritten with the stale saved value.
Limits, recorded: (1) rights live in main's memory for this run, bounded (512
accepted, 1024 restored); a tab the user opens while the resume prompt is up is a
new tab, since only the first load of the run seeds, and a session that ended and whose
entry went past the bound is a new copy. (2) A Restart of a tab that
never started (a Not started tab) is a launch of its config: main refuses it
while another copy runs, as the sidebar does (`restartLaunchRefusal`). (3) Main counts only the copies it holds:
a tab whose process has ended still counts in the sidebar and not in main, so the
sidebar is the stricter of the two. (4) Not a boundary against a compromised
renderer, as the rule was not one in the sidebar: it holds the sidebar's rule for honest
launches (a spawn that names no config is not a copy of one). (5) A
parked spawn that main accepted and that then fails after the wait leaves its
right behind; it can only restart that tab. (6) Not new: copies of one config
started together in one folder claim their rollouts by folder and time unless
Codex's hooks are trusted (P3.5's recorded limit, P3.10's exact claim); a x N of
a Codex config is that case. (7) A right of this run is kept for the run, so a
session that was accepted can always come back beside live copies of its config, as
the shipped app let it; main cannot tell an honest Resume from the same id spawned
again (limit 4).
Tests, 10 files, red first. Round 0: `launch-one-at-a-time.test.ts` (the gate on
its own: the rule, the rights, the restored sessions, the partner shape, the
bound), `pty-spawn-one-at-a-time.test.ts` (the real handler: a Codex, Claude,
terminal-only and SSH config, never chosen and declined, each refused on the
second copy before anything is prepared, leased or spawned; the preparation
window; the provider rule first; the saved flag read from disk),
`codex-multi-spawn-leases.test.ts` (the real handler, the real pty-manager and a
real lease registry: three copies are three processes on three leases, one
ending or closing lets go of its own only, a refused copy takes none, a Restart
and a Switch after Multi Spawn is unticked, restored copies),
`multi-spawn-codex.test.tsx` (a Codex config through the launch backstop, a x N
launch, a Restart of a tab that started nothing, a Codex pin's x N control,
blocked start and select lock, and the sidebar's rule, the shared rule and main's
refusal agreeing over every stored value and copy count) and
`shared/multi-spawn-rule.test.ts`. Round 1 adds
`pty-spawn-one-at-a-time-rights.test.ts` (the real handler, the real gate and the
real session load: restored copies of a declined Claude and Codex config start
and a new tab is refused; a Restart and a Switch of a copy beside another;
reattach; no exemption carries credentials; the live session's record is not
re-pointed; the log id), `claude-managed-launch-one-at-a-time.test.ts` (the real
pty-manager: a Claude managed launch parked by the profile wait or the project
gate is held), `refused-multi-spawn.test.ts` and cases in the tab, durability,
lease and shared tests: 82 new tests. Round 2 adds the partner of a tab that started
nothing (lens B's probe, adopted: the provider off, the partner opened, the provider
on), the forged cycle, the lapse rules with their exceptions, a forged same-id spawn
during a Codex preparation (two cases), the eviction order, the ticket rules and the
toggle recheck, and the sleep of the Claude managed-launch test is a zero-delay
flush: 28 more tests net. Red on the first round's code: 22 of the 34 cases of the
rights file, and 2 of the tab cases; on round 1's, 10 of the 47 cases of the rights
file and 3 of the toggle file. Mutation: round 0, 59 mutants;
round 1, 37 mutants of the gate, the seeding, the wiring, the refusal types and
the reconcile, every one red (one of round 0's is killed by the existing
provider-neutral launch test; the lens B mutant that kept a claim only for a
config that is not Multi Spawn is among round 1's); round 2, 20 mutants of the gate,
the lapse, the tickets, the bound, the toggle and the handler wiring, every one red
(two of them after a test was added for a first survivor); round 2b, 4 mutants (restored
rights lapsing again, a restored right not consumed by its first spawn, a lapse for
remotes only, the rights of this run not lapsing), every one red. Round 2b adds the
restored remote that resumes on first view after a new copy started (Claude SSH, and a
Claude and a Codex tab), and only once: 2 more tests net, 3 cases red on b409c8c8. Round 3
replaces the lapse cases with cases that keep the right for the run (lens B's SSH
resume probe adopted; a Restart after Multi Spawn was turned off, for a Claude, Codex,
SSH and terminal-only config; every closed session coming back and a new id still
refused) and adds the discard, the refused overflow, the tickets of a spawn that is not
a copy, a launch closed while it prepared, nine forged spawns while a launch prepares
(two kinds) and the toggle put off and back on: 20 cases red on round 2b's code (of
129 in the three files edited). Round 3 mutation, 13 mutants (the lapse put
back, the rights of this run not honoured, a restored right not consumed, a spawn that
is not a copy among the pending tickets, the cap pushing the oldest out, no cap, a
discard that does nothing, that can still settle, or that takes the accepted right,
pty:spawn never discarding, never handing its ticket over, or discarding only on a
throw, and the toggle's second look without the config object), every one red. On
the host: 168 affected and tree-scanner files pass (3,066 passed, 29 skipped), the WP1
gate, traceability, boundaries and conformance files pass, and `npm run typecheck` and `tsc` of the touched tests are clean.
ADR-009: the gate is a refusal in `pty-handlers.ts`, before any credential read,
lease or spawn; it reads the saved configs and the session state main already
reads, and nothing the request says about itself except the exact partner shape
and its own session id; it is not a way round a credential binding (the first
cut was, and round 1 closed it). SSH radius: `pty-manager.ts` gains one read-only
export and no SSH branch, sentinel parser or statusline route changed, but the
gate does run for an SSH session's spawn, so PR 3's SSH live matrix (owed) is the
check for a second SSH copy and a reattach (no Codex case: a Codex session over
SSH is refused).
Owed on the VM (WINDOWS_1, real Codex 0.155.1 and 0.153.4): three copies of a
Multi Spawn Codex config on one account are three Codex processes and three
sessions on the account, a closed copy letting go of its session once its process
has ended, and with Multi Spawn unticked meanwhile a Restart and a Switch account
of one copy start and a new copy is refused; a second launch of a config that is
not Multi Spawn, from the Saved row and from a Quick Start pin, is refused on
screen, and forced past the sidebar (the screen on, the saved config off) the tab
says so and the toggle shows off (screenshot for the owner); a restart of the app
with two saved copies of a declined config, and of a config never chosen, starts
both, for Claude and for Codex, and a new tab for the config while they run is
refused, and a remote left running reattaches by its own id beside another copy;
the end-to-end suite at PR 3's head, which no spec of the restore path may break;
and a x N of a Codex config in one folder, each copy on its own rollout and a
Restart resuming its own; a tab that started nothing (a provider that was off)
whose partner shell was opened, then the provider turned on: a new tab and the tab
itself start; a remote left running resumes even after a new copy was launched (a
restored one on its first view, one left running in this run from its card), a Restart
of an ended tab after Multi Spawn was turned off starts, and a new tab beside a live
copy is still refused (round 3; the VM check passed at 7c52a432, before the lapse was
removed, so these are owed again). A restored tab spawns on its first view
(a hidden tab does not start until it is shown), so the others of a restored set
start as they are shown; the rule does not depend on it.

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
Built (c65b359e; mocked), settled by parity and by P3.1's evidence of the unit.
The build branch applied, not the fallback: P3.1 ran on a managed account that
has credits (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 7:
the real balance is a decimal string with ten fraction digits, and the CLI's own
status view prints it followed by "credits", so the unit is Codex credits, a
count, not money). The schemas declare the three fields (`hasCredits`,
`unlimited`, `balance`, identical in 0.153.4, 0.155.1 and 0.157.1) and state no
unit, so the unit rests on that evidence, which is a string search of the binary
and not a live read of the screen. A Codex card on paid credits shows a Credits
row under its bars: "N credits" (the balance, two fraction digits, and "<0.01
credits" for a positive balance under 0.005) or "Unlimited". No row when the
account has no credits, when `hasCredits` is false and the credits are not
unlimited (never observed, so nothing is invented for it), or when the balance is
missing or not readable. It is a
count and never formatted as money, so Claude's `CreditsInfo` (an ISO currency)
is not reused: the new type is `AllowanceCredits` (`hasCredits`, `unlimited`,
`balance`). The row is placed and styled as Claude's through one shared
`CreditsRow` in `AccountUsagePanel.tsx` whose markup for Claude is unchanged (the
Codex row alone names a test id, `account-usage-credits`). The footer and the
strip show no credits for Claude and so none for Codex.
The credits come with the reading, so they follow every source: the live figure
of an open session, a fresh read of a closed account, and the last-seen reading,
a signed-out account's too, with its "As of" line below the row. They are read
from a rollout's `token_count` (`credits`, snake_case) or from the answer's own
`rateLimits.credits`, never from an entry of the per-limit map, and never the
reset-credit grants (`rateLimitResetCredits`, a different thing). Untrusted
input, as bound 8 treats the rest: own properties of a plain object only, a flag
that is not a boolean drops the whole credits, a balance must match
`^\d{1,13}(\.\d{1,12})?$` or it is null (the flags kept), no other key is copied,
and credits alone never make a reading. The credits are the newest default-limit
report's, the one the main bars come from (round 1): a null there, which is what
an account without credits writes, is "none now" and clears an older figure; a
report with no credits key, or a sub-limit's, leaves it. The key is omitted from
the merged reading, the port's reading and the page's view when there is no
figure.
The read itself does not change: the three code-built messages, argv, realm,
lease, lifecycle, supported versions, triggers and the client's schema checks
(`snapshotOk` and `readResultOk` do not look at credits, so a malformed credits
object is dropped by the normaliser and can never make a CLI "unsupported"; bound
5 unchanged) are as before, and no IPC channel or preload file is touched (the
page's view gains an optional `credits`). Records: ADR-023 (2026-10-01) widens
ADR-022 bound 8 by exactly the three fields and says the owner confirms it on
return, with a one-line pointer in ADR-022; `PRIVACY.md` names the credits
count beside the allowance figures and the plan; the known issue "no credits row
yet" is removed from `src/shared/app-knowledge.ts` and its Usage page paragraph
gains the clause for the row (the changelog, tips, tour and Feature Guide stay
with P3.16). Files: `src/shared/usage-types.ts`, `src/main/providers/codex/
rate-limits.ts` (`readCredits`, the `NAMES` flag spelling per source, the merge),
`usage.ts` (`toUsageReading`), `core/package.ts` (`UsageReading`),
`core/accounts-service.ts` (the view's copy), `shared/providers/accounts-view.ts`,
`AccountUsagePanel.tsx`, and comments in `app-server-client.ts`.
Limits and deviations, recorded: (1) a fresh read replaces last-seen whole, so a
read whose answer has no credits shows none even where last-seen had them (the
row is of the same reading as the bars, as Claude's is); (2) the unit rests on
P3.1's strings evidence: if a reviewer rejects that, the fallback above applies
(the known issue returns and row 17 goes to the owner as a section 19 record);
(3) `hasCredits` false has never been seen, so it draws no row; (4) a balance
with more than 13 integer or 12 fraction digits is not read and shows no row.
Tests, red first on 624eff9f (57 of the new tests failed in the eight touched
files; all 345 now pass): `rate-limits.test.ts` (the three fields from a rollout
and from the answer's own `rateLimits`; a per-limit entry's credits never kept;
each source's own spelling; 23 hostile balances and 6 hostile flags, credits that
are lists, class instances, inherited, with no prototype or a JSON `__proto__`
key; no other key copied; the merge; both supported CLIs' real rollouts, balance
1250; the schema excerpts declare exactly the three fields and no unit),
`app-server-client.test.ts` (a valid object on the verdict; a malformed one still
an ok verdict, so bound 5 is pinned), `usage-last-seen.test.ts`,
`telemetry.test.ts` (the live record), `provider-account-usage.test.ts` and
`codex-usage-read.test.ts` (the view for the live, read, last-seen and
signed-out sources, and no `credits` key when there are none),
`account-usage-panel.test.tsx` (the row, "Unlimited", no row for no credits, no
balance, no bars or the parked, no-session and per-token cards, the row above
"As of", and the missing parity pin for Claude's own row) and
`app-knowledge.test.ts`. Mutation: 46 mutants, each alone and restored
byte-identically with a sha check, every one red (28 on the parser, the flag and
balance rules, the merge, each source, the map entry, the copies and the client's
validator; 14 on the card and Claude's row; 4 on app knowledge); one survivor, a
redundant guard on the card, was removed from the code and replaced by a mutant
that is red. On the host: 55 affected and 65 tree-scanner and WP1 gate files
pass, `npm run typecheck` and `tsc` of the touched tests are clean, and the
legacy Codex manifest is unchanged (path digest as before; "codex" kept out of
`usage-types.ts`, which the catch-all predicate would otherwise add).
ADR-009: yes. The exact change for the attackers is bound 8's addition and the
one reader that implements it (`readCredits` and its two call sites in
`rate-limits.ts`), the merge, and the copies down to the view; the client's
validators and every other bound are untouched. SSH radius: none.
Owed on the VM (WINDOWS_1, real Codex 0.155.1 and 0.153.4, the managed account
that has credits): a closed account read afresh shows "N credits" under its
bars, N matching the CLI's own status view; an open session shows it live; the
last-seen reading shows it with its "As of" line; an account with no credits and
an API-key account show no row; a screenshot for the owner, both themes. The
owner confirms ADR-023.
Round 1 (897cb345; reviews of c65b359e and f70a57fd: spec PASS-WITH-FIXES, code
quality PASS, ADR-009 lens A PASS and lens B FINDINGS), built on 469e65b9. (C1) The
credits are now the newest default-limit report's, the one the main bars come
from. A real account without credits writes `credits: null` on every event
(`tests/fixtures/codex/rollout-sample.jsonl` line 8), and the first round
kept an older figure through it, so a card could show a balance the account no
longer had. Now a snapshot's credits have three states: a figure; null, "none
now" (the key is null, or present and unusable); and no statement (the key is
absent, or the snapshot is a sub-limit's, whose credits are never read). A later
null clears an earlier figure and no statement leaves it, in a merge and in the
watcher's one-at-a-time fold; a merged reading never carries null. The app
knowledge clause now says the balance is taken from the same report as the main
bars and that a newer report with no credits takes the row away, and drops "so it
carries the same age". (C3) A test pollutes `Object.prototype` and shows only
own properties are read. (C4) A test shows the status line built from a reading
with credits has exactly the keys of one without, and the session's emitted
updates carry no credits key or text. (N1) The `Number.isFinite` that the regex
made unreachable is gone. (N2) A positive balance under 0.005 reads "<0.01
credits", never "0 credits"; ADR-023 now records that a balance with more than 13
integer or 12 fraction digits shows no row. (N3) The telemetry test's folder is
removed in a `finally` after the watcher stops, only if it is named like the
test's own prefix and made directly in the OS temp folder. (N4) ADR-023 item 5
lists every no-row case. Red first on the round 0 source: 24 of the changed and
new tests failed in 5 files; now all 357 tests of the 8 touched files pass.
Mutation: 63 runs, every one red, each alone and restored byte-identically (30
new on the three states, the sub-limit and map-entry rules, own properties, the
status line, the small balance and the clause; the round 0 set re-run on the new
code, 33 red, and 9 of its mutants re-anchored where the code changed). On the
host: 55 affected and 65 tree-scanner files and the WP1 gate files pass,
`npm run typecheck` and `tsc` of the touched tests are clean, and the manifest
check is complete. (C2) Built in the next paragraph, by time and without the
launch files.
Round 1, C2 (the carry marks; 96979a4c and f00540a8). After Switch Account the new
account's folder holds a copy of the conversation's rollout, with the earlier
account's events in it. The carry is marked, and what reads that rollout counts
only the events written after the mark, so the new account's card shows none of
the earlier account's bars, plan or credits until its own session reports. When `copyConversation` lands a
copy under both realm locks (`realm-folders.ts`, `markCarried`), it records
`{destination realm, its sessions folder, the conversation id, the carry's time}`
in a store the Codex package owns (`createCodexCarryMarks` in `usage.ts`): in
memory and in `carry-marks.json` in the app's `providers/` folder next to the
account registry (`src/main/carry-marks-port.ts`, handed to the package by
`compose.ts`; never a file in an account's folder), written atomically, owner-only
where there are modes, read back with every field validated, the newest 256
kept. A copy or an extension is marked now (an extension replaces the older
record: A, B, A); a copy already there keeps the record it has. A realm's records
go when its account is archived (a new optional `forget` on the realm folder
operations, called by the accounts service after the archive lands) and when its
folder is removed. The live watcher asks for the mark at every read
(`claimOpts.allowanceAfter`, set by `CodexProvider` from the store) and the
last-seen reader asks for it per rollout (the file name carries the conversation
id; the marks are part of what a cached reading was read under). In a marked
rollout only a `token_count` dated after the carry counts, and one with no zoned
time counts for nothing (`zonedTimeMs`, the transcript reader's rule); the same
rollout unmarked reads whole. `pty-handlers.ts` and `pty-manager.ts` are not
touched: the hook is in the folder work the service already calls. Records:
ADR-023 ("Carry marks": what, where, how long, what reads it, the limits),
`PRIVACY.md` (what the app stores) and the Usage page clause in app knowledge.
Limits: the folder is recorded as a path, so a moved data folder reads a carried
rollout whole, as before; a conversation coming back to an account (A, B, A)
leaves that account's own earlier events uncounted until its next report; a
carry made before this change has no record. Tests, red first on 897cb345 (36 of
the new tests failed in 5 files): the marks store (what it records and refuses,
the bound, a conversation carried again, dropping a realm, a restart over the
same file, a file that reads back as junk, an unreadable file, a port that
throws), the last-seen reader (nothing of the earlier account before the new
account's own event, then its own with its own plan, bars and no credits; the
carry's own moment is the earlier account's; a zoneless time counts for
nothing; a mark applies to its own conversation and folder only; A, B, A; a
cache is not reused across a carry; the usage port), the live watcher (a real
temp-folder rollout through `CodexProvider`), the realm folders (a copy,
extension, present, failed or cancelled carry; a mark or clock that throws;
forget; a removed folder; the package over a marks file and a restart), the
accounts service end to end (A with Pro and 1250 credits switches to B with Plus
and none: B's card never shows A's bars, plan or credits, last-seen or with a
session open, nor after a restart; B's own event shows; A, B, A; an archive
drops the marks; a throwing forget never fails the archive), the marks file
port and the composition wiring. Mutation: 59 mutants of the reader, the store,
the watcher, the wiring, the folder work, the archive hook and the port, each
alone and restored byte-identically, all red (six survived once: five were
answered by a test, one by removing a redundant check). ADR-009: yes, the carry
hook and the new file (the pass covers them). Owed on the VM: a real Switch
Account between two Codex accounts (one with credits), the new account's card
and strip empty until its first report, then its own; the same after an app
restart.
Round 2 (e050a266; the reviews of the carry marks: spec PASS-WITH-FIXES, code quality
PASS, ADR-009 pass 2 lens A PASS and lens B PASS, each with minor items; VM PASS at
7c52a432). (D1) The mark is the later of the carry's moment and the newest zoned
event time in the copied bytes (`newestCarriedStamp` in `usage.ts`; a stamp over 7
days ahead is ignored), so a machine clock stepped back before the move cannot let
the earlier account's later-dated events count. (D2) The marks file fails closed.
`carry-marks-port.ts` looks before it reads (a plain file within 4 MiB); one that is
not what the app wrote is renamed `carry-marks.json.bad-<ms>` (the newest 3 kept),
never overwritten, and a floor at that moment is kept so nothing dated before it
counts; a file that cannot be read now is asked for again after a wait of 1 to 30
seconds, and until it can be read no Codex rollout counts an event, no mark is
recorded and no carry is made (the Usage page shows no last-seen Codex figure and
the strip no Codex allowance until it reads; this covers every Codex account, because
which rollouts are carried is not known). The file is trimmed oldest first at write
time, a realm dropped while it could not be read is not brought back by it, and only
own properties are read (D8). (D3) Past 256 marks the realm with the most evicts its
own oldest, never another's; recorded as a limit. (D4) Sign in again re-keys the old
folder's marks to the replacement folder, and refuses to go on if they cannot be kept.
(D6) Archiving an account forgets the marks of every realm it has had
(`AccountsService.forgetRealms`). (D7) `copyConversation` marks before it copies and
takes the mark back if the copy fails; a mark that cannot be kept stops the carry
("not carried over"). (D5) Recorded as a limit, not changed: the reports carry no
account identifier, and removing older sub-limit bars on a newer main report would
hide an account's own, so in a rollout with no mark (a carry made before marks
existed) an earlier account's sub-limit bars can still show; after a mark they are
dated like every other event. (D8) The zoneless last-seen test no longer depends on
the machine's time zone (also run under four zones). (D9) The Usage page clause says
the credits come from the newest main report that states them (an absent credits key
keeps the older figure) and what the app does while the marks file cannot be read;
`PRIVACY.md` and ADR-023 say the same. Tests, red first on 1446f237 (67 of the new
and changed tests failed in 5 files): the store and its file (parse, fail closed, wait,
floor, set-aside, trim, dropped realms, eviction, adopt), the newest-stamp read, the
folder work (mark before, undo, finish, adopt), the accounts service end to end (a
clock stepped back; a marks file that cannot be read, then can; a file that is not
what was written; a Sign in again; archive of every realm, signed-out and external),
the port and the app knowledge clause. Mutation: 71 mutants of the store, the reader,
the folder work, the archive hook and the port, each alone and restored
byte-identically, all red (one survived once and was answered by a test). ADR-009:
yes, the same pass as round 1 (a file that is read, set aside and trimmed; the
sign-in-again and archive paths). Owed on the VM: the Switch Account check above; with
the marks file made unreadable, no Codex last-seen figure until it is readable again,
and a corrupt one set aside with its copy beside it. (Round 3 below replaces what
D2 and D4 do while the file cannot be read.)
Round 3 (c61d889e; the reviews of round 2: ADR-009 pass 3 lens A PASS and lens B PASS,
so P3.14's ADR-009 pass stands at e050a266; spec FINDINGS with one major; code quality
PASS-WITH-FIXES). The proportion that rules it: the harm guarded against is a temporary
display of the user's other account's figures on the wrong card, so it is never a reason to
refuse a carry or a Sign in again, and never a reason to blank every card. (H1) Round 2
refused both, and withheld every Codex figure, while `carry-marks.json` could not be read.
Now carries, Sign in again and archives go on and no card shows an error for it: marks,
dropped realms (up to 256) and adoptions (up to 64) are kept in memory and written once the
file reads, beside its own marks, and a mark that cannot be written is kept and tried again
after a wait. The failure fails closed by time: the first failed read is a floor, in memory,
for the folders this run has carried into or adopted a history into (nothing dated at or
before it counts there); every other folder reads whole, so a conversation carried in an
earlier run can show the earlier account's figures for the one to 30 seconds between tries.
`adopt` and `record` never fail for the file; `markOf` says "not known yet" until it is read.
The user-facing sentence in app knowledge, `PRIVACY.md` and ADR-023 say so. (H2) A file that is
not what the app wrote is set aside and, in the same step, replaced by a file holding the floor
and this run's marks (`setAside(replacement)` in `carry-marks-port.ts`); if the replacement
cannot be written the file is put back, so the next start finds it again, never as a missing
file. (H3) The scan of a copy for its newest time reads the last 256 KiB and, when that holds
no time, the last 2 MiB, as the last-seen reader does. (H4) A mark that throws in the live
watcher closes that rollout. (H5) The resources folder not being known yet is "not ready", not
a failed read: no wait. (H6, records) ADR-023 and `PRIVACY.md` now state: a deleted marks file
reads as no marks (a limit); the up to 3 `.bad-<ms>` copies hold the same kind of notes, an
archived account's included, are not edited, and stay until three newer ones replace them;
marks and drops held in memory are lost if the app quits before the file can be read or
written (an archived account's notes then stay in the file); the floor of a set-aside holds in
every folder; a final line over 2 MiB hides a copy's newest time. Tests, red first on the
round 2 sources (40 failed in 6 files, 33 of them for the new behaviour; seven fail only
because the harness no longer has the removed `unavailable()`): the store (carry kept and
written when the file reads, the floor by time and which folders it holds, adoptions in order
and their bound, a realm dropped meanwhile, not-ready without a wait, a write that fails and
is tried again, a set-aside that cannot be done), the port (not-ready, replace and put back),
the stamp scan over a 300 KiB and a 2 MiB final line, the live watcher (unreadable, held, a
throwing mark), the folder work (a carry never stopped, a present or failed copy with the
earlier mark unknown), the accounts service end to end (an unreadable file: no card is an
error, a carry and a Sign in again go on, the marks follow once it reads) and the app
knowledge sentence. Mutation: 48 mutants of the store, the port, the folder work and the
watcher, each alone and restored byte-identically, all red (three survived once and were
answered by tests; one dead line was removed). Host: 143 affected and scanner files, 3237
passed, 12 skipped. ADR-009: the pass stands at e050a266 and was
not re-run for round 3, which changes how the store behaves on a failed read or write and the
order of the set-aside; the orchestrator decides whether to re-attack it. Owed on the VM:
with the marks file made unreadable, a Switch Account and a Sign in again go on and no card
is an error; a corrupt file set aside with its copy beside it, and put back when its
replacement cannot be written.

**P3.15 Terminal verification.** On the VM with real Codex 0.155.1: a Codex
session in the Services snapshot; Alt+V image paste reaching Codex (and the tip
fixed); copy, paste, scrollback and mouse re-captured
(`tests/fixtures/codex/tui-trace.txt`); channel rules delivered into the Codex
terminal. On Windows, Codex 0.155.1 under workspace-write with the unelevated
sandbox refused a file edit (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 5): P3.15 checks that the app's
default sandbox settings let a Codex session edit files. A failure becomes a
fix in this phase with its own reviews, and its own ADR-009 pass if it touches
a listed path.
The VM run (2026-10-01, the unsigned candidate c11fb360, real Codex 0.155.1,
and 0.153.4 for checks 1, 2 and 5; a Claude session on the same build to
compare, a fake Claude because real Claude Code was signed out; evidence
addendum 15 of `docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`):
(1) Services: PASS, a Codex tab in the snapshot exactly as the Claude tab.
(2) Alt+V: PASS with the terminal focused (the key goes to the CLI and Codex
attaches the image itself, "[Image #1]"); the tip FAILED (it said the app
pastes a path into Claude's prompt, which happens only with focus elsewhere,
and there Codex dropped the line's em dash and did not submit it).
(3) Copy, paste and mouse: PASS (Codex sets no mouse mode); scrollback FAILED:
the ConPTY built into Windows repaints Codex in place, 38 lines kept after 16
turns and the wheel inert, with `--no-alt-screen` too. (4) Channel rules:
PASS. (5) The default edit FAILED, upstream: Codex's non-admin Windows sandbox
cannot write the workspace (Standard asks before every edit, Auto fails): in
the app on 0.155.1 at High and Medium integrity and on 0.153.4 at High
(Standard only), and outside it with the app's arguments on 0.155.1 at High and
Medium; after Codex's own administrator setup, run outside the app only and
from an elevated session (so no administrator prompt was seen), a Medium
session's Standard and Auto edit with no prompt and an elevated one stalls (in
the app: owed). The fixes (bbcb6ef8, mocked):
S1 (row 71): a local Codex session on Windows runs under node-pty's bundled
ConPTY (`useConptyDll`: its conpty.dll and the OpenConsole.exe beside it, the
console host Windows Terminal ships; the VM's in-app trial kept 122 lines and
the wheel scrolled), chosen by `src/main/bundled-conpty.ts` only when both
files are beside the native module node-pty will load (found as node-pty's
own loader finds it, under app.asar.unpacked when packaged), else the system
ConPTY, said in the launch line ("conpty=bundled", or "conpty=system" and why)
and logged once (`pty-manager.ts`, the Codex branch's spawn). Claude
sessions, plain terminals of either provider and SSH sessions keep exactly
the options they had. Packaging is unchanged: `asarUnpack` already unpacks all
of node-pty, and the VM install holds both files. S2 (row 70): with focus
outside the terminal, a Codex session's line is ASCII ("I just pasted an
image - please view it." and the path) and goes through the rule the app types
into Codex by (P3.8: the ready, empty composer only, Enter on its own after
the burst, only when the screen shows exactly the line; `sendImagePathToCodex`
in `codexComposer.ts`, routed from `useKeyboardShortcuts.ts`); when it cannot
be sent the paste hint says why. The Alt+V tip and the Tips and Shortcuts
card's line say what happens in each case, for both assistants. S3: a known
issue in app knowledge and a tip (`tip.codex-windows-sandbox`): choose Codex's
"1. Set up default sandbox" once; the non-admin sandbox, or none, asks before
every edit on Standard and fails on Auto; never run the app as administrator.
No preset and no sandbox argument changed. Rows 44, 70, 71 and 73 move to
DONE (verification owed for the fixes). Limits and deviations: (1) a Codex
line goes in only when Codex's composer is ready and empty, where Claude's is
typed into whatever is there, because that is the rule the app types into
Codex by and it keeps the line's letters out of Codex's approval prompts; a
line too long for one composer row is typed but not sent, and the hint says to
check it and press Enter; (2) `tests/fixtures/codex/tui-trace.txt` is not
replaced: the VM's traces were taken under the system ConPTY this phase
replaces for Codex, so the re-capture is owed under the bundled one (and
anonymised); (3) real Claude Code's own Alt+V was not seen (signed out), and
macOS and Linux were not run. Tests, red first on 965c8bb6: the new
`bundled-conpty.test.ts` (11, all red as the module did not exist),
`pty-conpty-per-provider.test.ts` (2 of 5 red; the Claude, plain-terminal and
off-Windows pins green before and after), `codex-image-paste.test.ts` (6 of
6 red; a seventh, the question case, added after), `alt-v-image-route.test.tsx`
(1 of 4 red; the Claude, plain-terminal and no-image pins green) and three new
`app-knowledge.test.ts` cases (red); `ssh-spawn-callsite.test.ts` gains the
SSH options pin. Mutation: 28 mutants, each alone and restored byte-identically
with a sha check, all red (7 on the spawn options and launch line, 9 on the
ConPTY choice, 5 on the Codex line, 3 on the routing, 4 on the texts). On the
host 124 affected and 72 tree-scanner files pass, the WP1 gate, traceability,
boundaries and conformance files pass, `npm run typecheck` and `tsc` of the
touched tests are clean, and `electron-vite build` keeps the choice in
`out/main`. The legacy Codex manifest is rewritten (653 paths): rows for the
three new tests that name Codex, and `useKeyboardShortcuts.ts`
re-dispositioned for its provider conditional (P05). ADR-009: yes (the fix
constructs the Codex PTY with a new option, and a new executable,
OpenConsole.exe, starts for every local Codex session on Windows). The exact
change for the attackers: in the Codex branch of `spawnPtyResolved`, the
spawn options gain `useConptyDll: true` when `bundledConptyChoice()` says
"bundled", and the launch line gains the choice; the choice reads
`require.resolve('node-pty')`, maps an `app.asar` path segment to
`app.asar.unpacked`, and checks that `conpty.node`, `conpty/conpty.dll` and
`conpty/OpenConsole.exe` are files in the first of node-pty's own native
module folders that holds `conpty.node`. node-pty loads that conpty.dll by full
path beside its own module, and conpty.dll starts the OpenConsole.exe beside
it (conpty.dll keeps Microsoft's signature; in a signed release
electron-builder signs OpenConsole.exe again with the app's certificate, as it
signs every executable it packages); argv, environment, working folder, account
realm and lease are untouched. SSH radius: `pty-manager.ts` is in it by file;
no SSH path changed (the options pinned), and the live SSH matrix is owed as
for any change to that file. Owed on the VM (WINDOWS_1, the packaged build of
this commit, 0.155.1 and 0.153.4): the launch line reads "conpty=bundled";
scrollback after a dozen turns and the wheel scrolling it, a resize and a
Restart (resume) without a damaged scrollback; copy, paste, right-click,
mouse, the channel envelope, the Services snapshot, typing, Enter, Esc,
Ctrl+C, arrows, Shift+Tab, Ctrl+T and Codex's own Alt+V under the bundled
ConPTY; the unfocused Alt+V line typed and submitted, and its notes; closing
the tab, Restart, Switch account and quitting Codex leave no codex.exe or
OpenConsole.exe behind and release the account lease; the fallback (the
bundled files renamed in a test install: the system ConPTY, the launch line
and the one log line); a Claude session and a plain terminal unchanged (no
OpenConsole.exe for them); the TUI trace re-captured; the known issue's
administrator setup in the app at Medium integrity.
P3.15 round 1 (the spec review PASS-WITH-FIXES, the code-quality review with
one major finding, the ADR-009 lenses A and B PASS with minor findings, and the
VM re-check of the packaged 7c52a432 on 0.155.1 and 0.153.4: PASS for the
launch line, scrollback and the wheel, resize and Restart, copy, paste, mouse,
keys, both Alt+V paths, channel rules, the Services snapshot, teardown and the
fallback with either file renamed; one finding, "[Process exited with code
undefined]" after Codex's own /quit). Built in 497fddb0 (mocked). F1: a bundled ConPTY that fails as a
session starts (node-pty throws before any process starts: a blocked or
damaged file, OpenConsole.exe unable to start, files gone since) no longer
fails every Codex start for the rest of the run: the session is started again
on the system ConPTY, `bundledConptyFailed` turns the app's choice to the
system one with the reason (logged once), and later sessions go straight to
it; a start that fails on the system ConPTY too (a missing executable) keeps
the first error and the choice. F2: node-pty builds the conpty.dll path in a
wchar_t[MAX_PATH] (`src/win/conpty.cc`, LoadConptyDll: GetModuleFileNameW,
then PathCombineW), so a conpty.dll path of 260 characters or more (a long
install folder) gets the system ConPTY, with the reason (`NODE_PTY_MAX_PATH`).
F3: the exit line names a code only when one is known ("[Process exited]"
otherwise; `processExitLine` in `spawnExitHold.ts`, both TerminalView sites).
Investigated, not built (a limit): under the bundled ConPTY node-pty reports
the end only when OpenConsole closes, which waits for every process attached
to the console, and once Codex's own process has exited node-pty has released
its handle to the pseudo console, so no public node-pty call can close it
(kill() then only closes the input pipe); a watch on Codex's pid could see it
gone, but ending the session from there needs node-pty's internals or the
attached processes' pids, which the app does not have. So a Codex that quits
while a process it started stays attached may leave its tab open (the run
record reading crashed for an unknown code is fixed in round 2, J1). F4: the records now say conpty.dll keeps Microsoft's signature
and a signed release re-signs OpenConsole.exe with the app's certificate; the
signing configuration is unchanged. F5: tests of the app's own lookup with
nothing handed in (node-pty's lib folder pinned, the installed prebuild found,
a folder named conpty.dll refused), and the same launch spawned under both
ConPTYs compared field by field. F6: the launch line names the folder of the
bundled ConPTY; `postinstall` now runs node-pty's own post-install after
electron-rebuild, so a dev install that builds node-pty from source has
conpty.dll and OpenConsole.exe beside the module it loads (CI and release
install with `--ignore-scripts` and package the prebuilds, unchanged). F7: the
SSH options pin offers the bundled ConPTY on every runner. F8: the image line
is read over the composer rows Codex wraps it onto in a narrow pane
(`codexTextTyped` in `codex-screen.ts`, used for that line only; commands keep
their rule). F9: the checklist legend says what "yes (Win)" and a VERIFIED row
with no mocked test mean; the evidence and this entry scope the sandbox claims
to what was run; the known issue and the tip use Codex's own words for the
administrator permission, say that Codex asks only when a new folder is
trusted, and that a way back to option 1 from an earlier choice, or for a
folder trusted before, has not been confirmed (until then: approve each edit,
use Standard); the Alt+V tip and card line are scoped to sessions on this
computer (over SSH, the app's own fetch request). Nits: the ConPTY options
come from the choice only; `onDisk` is `asarUnpackedPath`; the warning lines
are stripped as the launch line is; the Alt+V test waits for the handler; a
tip may name its platforms (`platforms`, filtered in the tip store) and the
sandbox tip is Windows only. Tests, red first on 7c52a432 (17 of 123 in the
eight files: F1, F2, F3, F5, F6, F8, the tip platforms); F7 could not be shown
red on this Windows host, where the real choice is the bundled one, and is
shown by its mutant; `findNodePtyLibDir`'s pin and the direct
`codexTextTyped` cases were added after, each killing a mutant. Mutation: 41
mutants, each alone and restored with a sha check, all red (one, the package
folder taken as the lib folder, survived until the lib folder was pinned).
ADR-009, the change for the attackers: the Codex spawn's options are the
choice's own (`...conptyOptions`); a synchronous throw under the bundled
choice starts the same command, arguments, environment and folder once more
under `SYSTEM_CONPTY_OPTIONS`, and only when that succeeds is the choice
turned to the system one; the choice also refuses a conpty.dll path of 260
characters or more; nothing else in the spawn changed. Owed on the VM
(WINDOWS_1, the packaged build of the round 1 commit, 0.155.1 and 0.153.4):
the launch line names the bundled folder; a narrow pane where the Alt+V line
wraps (sent); "[Process exited]" after /quit; a Codex that quits while a
process it started stays attached (does the tab report the end, and does
closing it end OpenConsole and that process); MCP servers and a running tool
command end with the tab, Restart and Switch account; the spawn-time fallback
(a conpty.dll that cannot load, for example an empty file in a test install:
the session starts, one warning, later sessions on the system ConPTY); the
sandbox tip absent on macOS and Linux; the TUI trace fixture replaced from the
re-capture; the known issue's administrator setup in the app at Medium, and a
way back to option 1 (for example removing the account's `[windows] sandbox`
setting and trusting a new folder).
P3.15 round 2 (the round 1 spec and code-quality reviews, PASS with fixes, and
ADR-009 pass 2: lenses A and B PASS with minor findings, so P3.15's ADR-009 is
PASS). Built in 7296dd43 (mocked). J1: an exit with no known code is logged as
"code unknown" and ends the run as exited (a normal Codex /quit under the
bundled ConPTY); a known non-zero code still ends it as crashed. J2: the
real-tree tests compare real paths and expect the first folder node-pty's
loader would load from (a tree built from source, a junctioned node_modules).
J3: every node-pty attempt is recorded, and the retry must equal the first
attempt but for `useConptyDll` (lens A's retry mutants with another
environment, folder or arguments survived round 1's test). J4: Node loads a
.node file through its \\?\ namespaced path, so the module name node-pty
reads back is 4 characters longer than the path measured (lens A's probe of the
loaded conpty.node): the conpty.dll path may be 255 characters at most
(`LOADED_MODULE_PREFIX`). J5: a Codex PTY under the bundled ConPTY that ends
within 5 s having drawn nothing (its console host's setup sequences aside),
and that the app did not end itself (a close, a Restart, a Switch account), is
taken as the bundled ConPTY failing after node-pty started it (OpenConsole.exe
ended at once, or unable to create Codex): the next launch uses the system
ConPTY, said once; nothing is relaunched. A real Codex draws at once, even to
say it cannot start, so a real quick exit is not mistaken for it. J6: the known
issue and the tip name /setup-default-sandbox, which both supported CLIs list
in their slash popup (the CLI fixtures), as not yet confirmed. J7: the fallback
assigns the started PTY before reporting; the comment says a throw after
node-pty's startProcess could leave its connect pending (not handled); a
withheld wrapped image line is never taken back and its hint says it was not
sent. Tests, red first on bbaf05d2: J1 (2), J4 (2) and J5 (1); J3's three
retry mutants survived round 1's test and are red now. Mutation: 14 round 2
mutants and 6 round 1 mutants re-run, all red, restored with a sha check. On
the host 161 affected files (160 pass, 1 skipped) and 71 tree-scanner files
pass, the WP1 gate passes, `npm run typecheck` and `tsc` of the touched tests
are clean. ADR-009 delta: the run-end status for an unknown code; the early
end watch (it reads the PTY's output only to tell whether anything was drawn,
and only turns the choice to the system one); the path bound 4 characters
tighter; the start order in the fallback. Owed on the VM (the packaged build of
this round, 0.155.1 and 0.153.4), beyond round 1's list: /setup-default-sandbox
tried first, in a session at Medium integrity after option 2 and in a folder
trusted before (then the known issue and the tip name it, or drop it); the
early end (OpenConsole.exe ended right after a launch in a test install: the
next launch on the system ConPTY, one warning; a normal /quit, and a Codex
that quits at once with an error, change nothing); the Logs record of a /quit
reads exited; if a Codex that quits leaving a process attached keeps its tab
open, a known issue (close the tab).

**P3.16 PR 3 records and user-facing sweep.** App knowledge (with known
issues), tips, tour and Feature Guide, the changelog entry, the user guide,
`PRIVACY.md`; the `CONTEXT.d/` fragment; the WP1 ledger and traceability; the
PR body, the ADR-009 verdict and the SSH matrix. Left to this sweep by
P3.4: the Feature Guide catalogue cards that name both providers,
`training-steps.ts` lines 90 (the Usage page), 132 (the Accounts section)
and 748 (the usage meter). From P3.12: a resumed Claude transcript is
indexed again under the new run (search lists its earlier turns twice), where
a resumed Codex conversation continues from what was indexed; Claude's resume
to be settled the same way, or recorded as a limit.

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
  with (`askConductor.ts:178-208` keeps it today). The row writes the saved
  choice `askConductorProvider` that P3.9 already reads for Sentinel's
  analysis (`src/shared/ask-conductor-provider.ts`), and P4.3 updates the
  sentences that say the analysis runs on Claude Code while both are on:
  PRIVACY.md's Sentinel row and app knowledge's Sentinel card.
- **P4.1, P4.3, P4.7: P3.4's showcase flags.** Each lifts `needsClaude` from
  what it brings to Codex and rewords it for both providers: P4.1 the Agent
  Canvas page and What's New line; P4.3 the Ask Conductor page and line and
  the 2.0 set's "A guide that answers back." line; P4.7 the "Insights." line.
  The remote resume page and the SSH Persistent and Remote Resumable lines
  keep their flag (Codex over SSH is outside this release).
- **P4.6.** WP1 design principle 4 says the app does not copy credentials.
  Claude's SSO path copies claude.ai cookies from a browser the app launches,
  so P4.6 builds the in-app sign-in window only; the cookie path goes to the
  owner only if a Codex account turns out to need it. A Codex tab's
  right-click menu still offers Claude's "Authenticate claude.ai..." and
  "Open artifacts" (they predate P3.6, #216: the menu falls back to the
  primary Claude profile; P3.6 VM finding V5): P4.6 gives a Codex tab its
  own web-session item, and the artifacts record decides the other.

## 10. Unresolved UX decisions

### How each candidate was checked

| Row | Check made | Conclusion |
|---|---|---|
| 52 Browser and vision tools | `conductor-mcp-server.ts:911-913` withholds vision from Codex on a call of 2026-07-02 worded "Claude-only for now"; `:1042` withholds `open_in_app_browser` to match. A Claude session gets both. The later owner decisions (the 2.1.1 gate of zero unsupported shared features; OD26 P1) end a "for now". No record asks to keep them Claude only | **Settled by parity.** A one-line notice to the owner, not a question: Codex sessions get the vision and in-app browser tools in PR 4. |
| 53 Ask Conductor | Ask is a real Claude session (`askConductor.ts:255` pins the provider; `help-workspace.ts` stages a `CLAUDE.md`), blocked with Claude Code off (`askConductorGate.ts`). Design section 2: the app works fully in Codex-only mode | **Codex only: settled** (Ask runs on the one provider that is on). **Both on: decided by the owner** on 2026-09-27 (OD27 M4, option B), below. There was no Claude behaviour to copy (OD26 P1, second case). |
| 58 Web sign-in and artifacts | `src/main/account-web/artifacts.ts` opens claude.ai artifacts as an account; `account-pane.ts` gives the browser pane an account surface on claude.ai; the checklist's limits: nothing assumes a CLI sign-in gives ChatGPT browser cookies or an artifacts equivalent | **Web session: settled by parity** (chatgpt.com in the pane's account surface, signed in per Codex account). **Artifacts: not a UX choice.** No Codex equivalent is known (the checklist assumes none), so this is a section 19 record for the owner to sign, with the command lists of 0.153.4 and 0.155.1 as its evidence (P3.1). Should P3.1 find an equivalent, parity settles it instead. |
| 68 Insights | `insights-runner.ts:234-237` types Claude Code's own `/insights` into a terminal and reads the report it writes; `InsightsPage.tsx:277-296` tells a Codex-only user that Insights come from Claude sessions. The parity reset of 2026-09-26 resolved it in its "Resolved by parity" list (sessions batch): a Conductor-native Codex report, run with `codex exec`; it was not one of that day's open questions | **Settled by parity (2026-09-26).** A one-line notice to the owner, not a question: Insights gets a Codex report the app makes with `codex exec`, shown in the page's existing layout, figures and run history, on the account's own Codex allowance as Claude's report uses Claude's. A mockup goes on the Agent Canvas before the build (P4.7), made from `src/renderer/components/InsightsPage.tsx`, `src/main/insights-runner.ts` and `src/main/insights-cross-account.ts` (ADR-013). |
| 69 Plan mode | Claude's launch options include "Plan mode" (`claude-cli-options.ts:85`), a launch option only; the Codex form offers permission presets only (`CodexFormFields.tsx:162-170`); the capability leads say Codex documents a plan command | **Decidable by parity.** Codex gets Plan mode as a launch option, as Claude has it (P3.8), once P3.1 confirms the command on the supported versions. If it is absent, that is a section 19 record, not a UX question. **Settled and built (P3.8 round 1, caef0d42; round 2, f1783110):** the VM probe found `/plan` on both versions and no launch flag, so the choice launches READ-ONLY and types `/plan` into Codex's first ready prompt only. **Deviation, recorded** (as P3.5's F7 menu): Claude's Plan mode starts in plan (`--permission-mode plan`) and its accepted plan moves on to the mode the user picks; Codex's accepted plan leaves Plan mode but not read-only, and the user widens what Codex may do with its own `/permissions` ("choose what Codex is allowed to do"; on the VM it opens "Update Model Permissions": Read Only, Ask for approval, Approve for me, Full Access, on both versions). |
| 22 Switch account: a declined confirm | P3.6 VM finding V3: Cancel on Codex's confirm-at-launch question after a Switch left the tab on the new account. A Claude switch never asks at launch, so there is no Claude behaviour to copy | **Parity cannot settle it.** Built as the default pending the owner's decision: question 3 below. |
| 63 Codex hook trust | Claude Code runs the app's hooks with no prompt: the app writes them into the per-session settings Claude reads. Codex asks the user to review hooks given at launch, once per account folder, and runs none until they are trusted (VM, evidence addendum 14) | **Parity cannot carry over as it is.** Built as the default pending the owner's decision: question 4 below. |
| 41 Mid-session model and effort | Claude's pill switches model and effort in one step, live. The VM probe (evidence addendum 13): Codex has no one-line form (`/model <slug>` and `/model <slug> <effort>` are sent as a message; `/effort` is unrecognised); its own route is a two-step picker opened by a bare `/model`, which keeps the conversation | **Parity cannot carry over as it is.** Built as the default pending the owner's decision: question 2 below. |

Three decisions are open: question 2 (row 41), question 3 (row 22) and question 4 (row 63), each built as a default pending the owner's decision. Question 1 below was decided by the owner
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

### Question 2 (row 41), open: built as the default, pending the owner's decision. How does a live Codex session change model and effort?

Claude's pill switches model and effort in one step and keeps the
conversation. Codex offers no one-line form on 0.153.4 or 0.155.1 (evidence
addendum 13), so the one-step switch cannot carry over as it is.

- **A (built, the default).** On a live session the command bar's model pill
  types a bare `/model`, only at Codex's ready prompt, which opens Codex's own
  picker (model, then reasoning level); the choice keeps the conversation and
  the strip then shows what Codex reports. A stopped session keeps the app's
  select, applied at its next start.
- **B.** The app's select on a live session too, applied by a Restart that
  resumes the conversation (what P3.5 built; one step, but the session
  restarts).
- **C.** The app picks the row in Codex's picker by sending keys (one step, no
  restart, but it depends on the picker's layout in each CLI version).

**Recommendation: A.** It is Codex's own route, it keeps the conversation with
no restart, and it depends on no picker layout. B is the fallback if the owner
wants the app's own list on a live session. The owner reviews A in the VM
gallery of round 1.

### Question 3 (row 22), open: built as the default, pending the owner's decision. A Switch whose launch asks for confirmation, declined

A Switch restarts a Codex session on the new account. When that launch asks
Codex's confirm-at-launch question (the account signed in on this computer)
and the user declines, what should the tab do? A Claude switch never asks at
launch, so parity cannot settle it (P3.6 VM finding V3).

- **A (built, the default).** The tab goes back to the account it came from
  (or to the default account when that one can no longer launch), and says
  which, above its terminal.
- **B.** The tab stays on the new account, not started, and says so; the user
  restarts it or switches again.

**Recommendation: A.** A declined confirm reads as "not this account", and A
leaves the session running where it was. The owner reviews it in the P3.6 VM
gallery (a declined confirm after a Switch).

### Question 4 (row 63), open: built as the default, pending the owner's decision. How do the app's Codex hooks come to be trusted?

Claude Code runs the app's hooks with no prompt. Codex asks the user to review
hooks given at launch, once per account folder ("Hooks need review": review
them, trust all and continue, or continue without trusting), and runs none
until they are trusted. Until then a Codex session on that account has no
attention dot and no exact claim (P3.10's limits).

- **A (built, the default).** Codex's own review: the first Codex launch on
  each account shows it, and the user trusts once. The app's hooks are the
  same for every launch, so Codex does not ask again until the app changes
  them. The Hooks gateway's settings text says so.
- **B.** The app records the trust for its own six hooks in the account's
  Codex settings itself, so no review shows. One step fewer, but it writes
  Codex's own trust record in a format Codex does not document, which a Codex
  update can change, and it needs its own ADR-009 pass.
- **C.** Launch with Codex's flag that runs hooks without review. No screen,
  but it lifts the review for every hook in that session, a repository's own
  included, and Codex prints a warning at every launch.

**Recommendation: A.** It keeps Codex's own check, asks once per account, and
depends on no undocumented format. B is the fallback if the owner wants no
screen at all. The owner reviews the review screen in the P3.10 VM gallery.

### One-line notices to the owner (not questions)

- Row 52: Codex sessions get the vision and in-app browser tools in PR 4; the
  "Claude-only for now" call of 2026-07-02 ends with the parity release.
- Row 68: Insights gets a Codex report the app makes with `codex exec`
  (resolved by parity 2026-09-26); its mockup comes to the Agent Canvas before
  it is built.
- Row 39: gpt-5.2 stays in the Codex model list while a supported CLI version
  lists it: 0.153.4 does, 0.155.1 no longer does (it still starts with
  `-m gpt-5.2`). The owner may judge otherwise. P3.9's live read
  (`codex debug models`, built in 3a4ed400) resolves it per installed version:
  with 0.155.1 installed, Sentinel says gpt-5.2 is a model that version no
  longer lists.

### Owner actions that are not UX decisions

- Row 15: hosts, disposable test identities and timing for the owner-run gates
  (OD20 D8).
- Row 58: sign (or reject) the artifacts section 19 record.
- Any section 19 record P3.1 raises (rows 22, 36, 41, 61, 69), one per row.
- Row 17 (P3.14): confirm ADR-023, which keeps a Codex account's credits count
  (three validated fields) from the usage read and so widens ADR-022 bound 8,
  and keeps the carry marks file (`carry-marks.json` in the app's providers
  folder: realm id, sessions folder, conversation id and a time; no text, no
  figure; it fails closed by time and never stops a carry or a Sign in again, is
  set aside and not overwritten when it is not what the app wrote, and is deleted
  per account on archive). The live credits check runs on the VM's managed account, which shows a
  balance (P3.1 evidence, answer 7); the P3.14 fallback does not apply.
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
