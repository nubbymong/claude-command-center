# 2.1.1 Codex parity: release checklist

The release-wide list for 2.1.1, the Codex feature-parity release. Its gate is
zero unsupported shared Conductor features for Codex (WP1 design section 19).
**SSH Codex sessions are the only agreed exclusion.** A PR being ready never
means parity is complete. The decisions behind this list are in
`docs/wp1/owner-decisions-2026-09-20.md`,
`docs/wp1/owner-decisions-2026-09-26.md` and
`docs/wp1/owner-decisions-2026-09-27.md`. The plan that finishes it (each
row's settling record, its gap, the PR it lands in, the package and release
completion criteria and the phases of PR 3 and PR 4) is
`docs/wp2/completion-plan.md`.

Update this file in the same commit as the work that moves a row.

## How to read it

Status:

- **VERIFIED**: an automated test exercises the Codex path.
- **UNVERIFIED**: built, but nothing proves it for Codex yet.
- **PARTIAL**: some of it works for Codex; the gap is named.
- **MISSING**: Codex does not have it.
- **OWNER**: waits on an owner decision.
- **N/A**: not a Codex feature by design.

Evidence, kept apart on purpose:

- **Mocked**: unit tests, the fake Codex CLI, or mocked IPC. `+e2e` adds a
  Playwright run of the built app (fake Codex) on the test VM.
- **Real CLI**: a run against a real Codex CLI at a supported version: the
  minimum 0.153.4 and the pinned 0.155.1 (WP1.71), per OS.
- **Packaged**: the installed, packaged app on a clean machine, per OS.

"no" in an evidence column is work still owed, not a failure.

"partial (Win)" in Real CLI or Packaged is the P2 upgrade walk of 2026-09-26
(`CONTEXT.d/2026-09-26-wp2-upgrade-walk.md`): unsigned 2.1.1-beta.2
candidates, each installed in place over the signed v2.1.1-beta.1 and the data
it wrote, on the used Windows 11 test VM (WINDOWS_1), with real Codex CLIs
0.142.4 and 0.150.0 (too old) and 0.157.1 (newer than tested). The evidence
came in three passes: the walk at `c3569b3d` (including the new-config Codex
launch), the re-verification at `c6dc4b60` (including the standalone Codex
update) and the final pass at `95385267`, followed by the owner's managed
Codex sign-in on the same build. Windows only, not a clean machine, not a
signed build and not the supported versions, so it never counts as full. Each
result names its auth class: AUTHENTICATED (real CLI, signed in: this
computer's `~/.codex`, or "managed" for a Codex account the app added through
its own sign-in, in its own folder), SIGNED-OUT (real CLI, a signed-out
`CODEX_HOME`), NOT-INSTALLED, or MOCKED (seeded state or the fake CLI). Its
screenshots are local and gitignored: `.ccc-canvas/screens/p2-upgrade-95385267/`,
approved by the owner 2026-09-26, and the managed sign-in set
`.ccc-canvas/screens/p2-managed-95385267/` (16 images), also approved
2026-09-26; none are in the repo.

Packages: **P2** finishes PR #625; **P3** is sessions and usage; **P4** is
agent surfaces and qualification.

## P2 acceptance status (2026-09-26)

Every open item is in exactly one group: **A** affects P2 acceptance (owner
action owed); **B** affects 2.1.1 release parity, not P2; **C** is an unrelated
baseline defect (pre-existing on beta, reproduced, not fixed in P2, not
waived). Evidence revision `95385267`; later commits up to `96c0af50` change
only help copy no screenshot shows, so none was refreshed. Galleries, both local, in
`.ccc-canvas/screens/p2-upgrade-95385267/`: `acceptance.html` (13 screens, 52
images, mocked ones stamped) and `gallery.html` (37 screens, 145 images).
Checks run during the VM wipe window of fixture preparation (from 05:44 VM
time) were superseded and re-run on fixtures re-prepared with the proven
junction-safe cleanup (13:40 to 13:57), which gave identical config data,
apart from the per-install random value, and identical results.

After `96c0af50` (2026-09-27). `808a23ee`: sign-in and sign-in-again re-check
the Codex answer before discovery, after it, and right before the status check
and `codex login` start (a new optional `mayStart` hook); an answer lost in
that window starts nothing and releases the lease. It came from an ADR-009
delta review of `21fff8bc`; the ADR-009 attacker lens passed it, confirmed
twice, and the spec and code-quality reviews passed it. On the host its
touched tests pass 38/38, `npm run typecheck` is clean and the WP1 gate passes
16/16. `89a743d6`: the Memory page Codex banner test pins the copy reworded in
`21fff8bc`, the only test that failed in CI on `96c0af50`; spec and
code-quality reviewed. CI at `89a743d6` (run 36278616165): Test
(windows-2025), Test (macos-latest), Changelog in sync, SSH multi-session
smoke (#24) and lint-pr-title pass; the Desktop test gate stays red until the
owner attests (#309). Neither the VM e2e nor the upgrade walk has re-run at
`808a23ee` or `89a743d6`: `808a23ee` changes main-process sign-in code,
`89a743d6` only a unit test.

After `14ad7475` (2026-09-27). Windows CI at `14ad7475` failed the fake-CLI
deadline test once in 40 Windows runs since `60ea77be`: the sleeping fake
outlived the kill. The early process-table read outlasted the kill's 10 s wait,
so only the root (cmd.exe) was killed and the Codex process below it kept
running. `8a6b83d5` waits for that read up to its own 30 s timeout with the
root left running, and a kill made before the early read whose own read fails
reads once more with that budget; the run still settles at its 15 s bound, and
the chain is still never killed with `/T`. On the host its unit file passed
92/92 (4 red before the fix, 5 mutants red). Its spec, code-quality and
ADR-009 reviews asked for fixes, made in `040ad456`: a table answering more
than 8 s after its read began kills only the wrapper line; a failed early read
gets one retry; every reader answer is checked; the run's result says when a
kill still under way at the settle bound has finished (`killSettled`), and the
realm lock, browser slot, review lease, Claude profile hold and discovery's
throwaway home are held until then; kills still reading are flushed at app
quit. On the host its four touched unit files passed 239/239 (17 red before,
23 mutants red). Its ADR-009 confirmation passed; the spec and code-quality
reviews asked for minor fixes, made in the commit after `040ad456`: the same
8 s age rule for every read, retries included; a 1 s margin on the kill's
worst case (now 44 s after the stop); the quit flush is one synchronous
taskkill bounded at 5 s, and a kill whose read lands after it kills nothing
more; a throwing lease or hold release never replaces a review's result. On
the host the four touched unit files pass 244/244 (10 red before, 11 mutants
red), `npm run typecheck` is clean and the WP1 gate passes 16/16. The fake-CLI
file is CI and VM only. CI at `040ad456` and `1dbd39f3` passed on Windows and
macOS (the Desktop test gate aside). The spec, code-quality and ADR-009
confirmation reviews passed at `1dbd39f3`.

Usage track (P3, 2026-09-27). CI at `67b7aa90` passes on Windows and macOS;
the Desktop test gate stays red until the owner attests (#309). The VM e2e
passed 81/81 at `8e41444f` and at `7c2739bf`. The owner approved the usage
screenshots on 2026-09-27 (the canvas "Usage screens for approval", v2): 125
images in `.ccc-canvas/screens/usage-final-8e41444f/`, local and gitignored, 124 mocked and
1 real (redacted), including the copy the approved mockup does not draw, as
recorded in `docs/wp2/plan.md`.

| Group | Open item | Tracked in |
|---|---|---|
| A | A managed Codex account added through the supported sign-in flow on WINDOWS_1, and Hello Codex seen on it: DONE 2026-09-26 (the owner's ChatGPT sign-in at `95385267`, AUTHENTICATED managed). By design Hello Codex is not shown after adopting this computer's sign-in (`src/renderer/onboarding/hello-codex.ts`, `docs/wp2/hello-codex-spec.md`) | Rows 4, 9, 13, 23 |
| A | The owner's approval of the managed sign-in screenshots (`.ccc-canvas/screens/p2-managed-95385267/`, 16 images, local): DONE, approved 2026-09-26 | This section |
| A | The owner's acceptance of the evidence gallery: DONE, approved 2026-09-26 | This section |
| B | macOS and Linux packaged runs | Row 66 |
| B | A signed Windows packaged run (the walk used an unsigned candidate) | Row 66 |
| B | Real CLI on codex 0.153.4 and 0.155.1 | Rows 1, 2, 12 |
| B | Claude-only UI for Codex-only users: the title-bar Claude.ai pill, Ask Conductor saying it runs on Claude Code, the Accounts Claude card's sign-in prompts while Claude Code is off, Hello Codex page 1 saying Codex runs beside Claude | Row 14 (P3) |
| B | Account summary, usage footer and Tokenomics UX, held for the owner's UX review (the next step after P2 acceptance): DONE, the UX approved 2026-09-27 (`docs/wp1/owner-decisions-2026-09-27.md`), built by the usage track, and its screenshots approved 2026-09-27 | Rows 17, 21, 26 |
| C | At the narrow window the GitHub button overlaps the partner strip label, on Claude and Codex tabs | Row 64 |
| C | The one-at-a-time Multi Spawn rule is enforced only in the renderer (a UX rule, not a security boundary) | Row 72 |
| C | Resume replaces the whole tab list while its prompt is non-modal: tabs launched meanwhile drop out of the list while still running, and Refresh can bring them back as duplicates. Fixed in P3.5 (18f3e3f5, mocked): the restore keeps the tabs already open, never adds a second copy of one, and Refresh never offers an open tab again (`sessionStore.test.ts`, `resume-refresh-offer.test.ts`, `app-lifecycle-wiring.test.ts`). Passed on the VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows). VM finding V1 in the same prompt, fixed (2e70e744, 05f1e01a, mocked): a launch made while the prompt was up that needs a dialog first (the account choice with two or more accounts, or the confirm for a sign-in already on this computer) showed nothing and started nothing until it was answered; those dialogs are now held back by every boot gate but the resume offer (`launch-dialogs-during-resume-offer.test.tsx`, `boot-overlay-wiring.test.ts`). Owed: the V1 review and its VM recheck | This section |
| C | A session file written while the resume prompt is unanswered (the autosave when a tab is added, the account and GitHub flushes) kept only the open tabs, overwriting on disk the saved set the prompt still offered. Fixed in P3.5 fix round 1 (42bb5f5c, mocked): every write keeps the offer until the prompt is answered (`session-save-unanswered-restore.test.ts`, `app-lifecycle-wiring.test.ts`). Passed on the VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows) | This section |
| C | A local Claude spawn that throws after its process starts can leave that process untracked | This section (Claude path) |
| C | One pre-existing e2e failure, reproduced on beta, routed privately | Row 67 |

## A. Accounts, identity, setup, onboarding, upgrade, Codex-only

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 1 | Provider on/off, "not set up" (no launch, review or Codex CLI run until answered), last provider on | VERIFIED | yes, +e2e | partial (Win) | partial (Win) | P2 | E2E on the VM (WINDOWS_1) after the spec fixes: the not-set-up Codex card guard and Codex x SSH pass. Upgrade walk: with a real CLI present an unanswered Codex started nothing; after No, Codex configs and restored tabs were refused with the off wording (AUTHENTICATED); Claude Code off in the Codex-only upgrade (SIGNED-OUT); "not set up" and last provider on MOCKED (seeded; the beta cannot write them). Owed: Real CLI at 0.153.4 and 0.155.1; packaged on a clean machine per OS |
| 2 | CLI detect and version classes | VERIFIED | yes | partial (Win) | partial (Win) | P4 | Real min, pinned and max per OS. Upgrade walk (Windows): too old at 0.142.4 and 0.150.0, newer than tested at 0.157.1, and not installed; 0.153.4 and 0.155.1 not run |
| 3 | Install and update | VERIFIED | yes | partial (Win) | partial (Win) | P2, P4 | P4: one real install per OS (macOS, Linux; Homebrew unrun). Done in P2: the update offered follows how the found Codex was installed. Upgrade walk: from the page, the npm install (NOT-INSTALLED) and the npm update from 0.150.0 reached 0.157.1; the standalone 0.142.4 was updated by its own installer line, run by hand as the page says, and Check again found 0.157.1 (AUTHENTICATED) |
| 4 | Sign-in (browser, API key) | VERIFIED | yes | partial (Win) | partial (Win) | P4 | Real API-key sign-in and logout; macOS and Linux. Windows (AUTHENTICATED managed, 0.157.1): the owner's browser sign-in from Set up Codex, Add a new Codex account, made a managed account in its own folder, signed in and default; Check sign-in reports signed in |
| 5 | Device-code sign-in | VERIFIED off | yes | n/a | no | P2 | None while it is off. Off in the shipped wiring (pinned: `tests/unit/main/codex-unanswered-service.test.ts`, `tests/unit/main/provider-startup-no-adoption.test.ts`); no longer advertised |
| 6 | Multiple isolated accounts | VERIFIED | yes, +VM | no | no | P4 | Real two-account run; keyring scoping |
| 7 | Identity rename, recolour, link, unlink, groups after creation | PARTIAL | yes | n/a | no | P3, P3.6 | Built in P3.2 (65612489, b4a5b665): the identity editor from every row's chip (name, colour, group, Unlink, Link another account; a mirrored Claude account's colour is kept in step in its email-keyed setting). Owed: the migration of those email-keyed overrides into the identity's colour, moved to P3.6 with row 20; the ADR-009 pass. VM visual check done: the owner approved the P3.2 Accounts screenshots 2026-09-28 (the canvas "Accounts screens for approval (P3.2)", v1): 148 images of build `e62409e6` on WINDOWS_1, MOCKED (fake CLI, fictional accounts), both themes, 1600x1000 and 1280x720, local and gitignored in `.ccc-canvas/screens/p3.2-e62409e6/`; visual evidence only, never Real CLI or Packaged. P3.3 (8c371ac7, corrected in review rounds 2 and 3, 01d2fd6b): after Link then Unlink the account takes the name it had before the link (kept at the link), else the identity's name, else its own label; never another account's address, and with none of these it is unnamed |
| 8 | One Accounts surface | VERIFIED | yes | n/a | no | P3 | Built in P3.2 (65612489): one row component for both providers (AccountRow). Owed: the P3.2 reviews. VM visual check done: the P3.2 Accounts screenshots the owner approved 2026-09-28 (row 7), with Claude only, Codex only and both on |
| 9 | Launch and resume in the exact account | VERIFIED | yes, +e2e | partial (Win) | partial (Win) | P4 | A restored tab keeping a managed account; per OS. Windows (AUTHENTICATED managed): a saved config on the managed account launched real Codex 0.157.1 to its idle prompt with no per-launch confirmation, from Create and from its row (Codex's own first-run sandbox question left for the owner). Upgrade walk (AUTHENTICATED, adopted ~/.codex): a new config, and a beta-saved config launched from its row, ran real Codex 0.157.1 after the per-launch confirmation; a restored tab asked for that confirmation, and a cancelled confirmation, or no account, left it Not started with its reason |
| 10 | Lifecycle blockers and archive | VERIFIED | yes | no | no | P3 | Built in P3.2 (fd8e01c9, 65612489, b4a5b665, 5f97217d, and the third review round's fixes): a refused inactivate or archive names each session holding the account that this window has open, with Go to, and "and N more" for the holders main cannot attribute to a named session plus the named sessions not open here; Claude's Make inactive is refused while a live session runs on the profile (sessions only, through either channel) and Remove while anything holds it (the sign-in status probe too), and both name the sessions the same way, a removal after its claude.ai sign-in was cleared keeping main's words beside them; Archived (N) with the date and Restore, back to inactive. Seen on the VM in the P3.2 Accounts screenshots the owner approved 2026-09-28 (row 7): the refusals naming their sessions with Go to, and Archive and Restore (MOCKED). Owed: the ADR-009 pass; a real restore on the VM |
| 11 | Staged re-authentication (WP1.52) | PARTIAL | yes | no | no | P3 | Built in P3.3 and its review rounds (20456359 to the final round commits). Sign in again is offered while signed in too. With "the same account as before" ticked (required at the IPC boundary), a signed-in account signs in to a new, journalled folder; the new sign-in is verified there, the account's conversation history (sessions and history.jsonl) is carried over (each file a second name of the same file, else a copy; in batches, never holding the app; at most 200,000 files and folders, else refused with nothing changed and the way to keep them (sign out, then sign in again in place); a file with a name the app did not give it is left behind, and the dialog says how many; the dialog's status line says while it runs; Cancel stops it before the switch), and only then does the account move, in one registry transition, with the provider's on/off read again inside it. Its old sign-in is kept, visible and needing attention (design 9.2: "uncertain provider semantics"), until removing it is proven safe; a sign-out or archive of the account signs it out. Not ticked, the sign-in is added as a new account. Codex exposes no reliable subject (P3.1 evidence; design 5.5), so the answer decides; subject match, mismatch and conflict are provider-neutral and pinned with a provider that reports one. A run cut short is listed under Unfinished setups; its Discard is written ahead, removes a replacement whatever history it holds, and a switch reported as not saved is decided by the registry file. A sign-out whose CLI ran but could not be read back leaves the account needing a check. This computer's own sign-in is signed in again in place after its warning. Claude's re-sign-in is unchanged (design 9.1). The ADR-009 (L1, L2), spec and code-quality reviews passed at `15f622eb`. The VM run at `15f622eb` (WINDOWS_1, MOCKED: fictional accounts, fake CLI; both themes and sizes; 78 images, local) passed every check; its three minor defects (a Discard in progress listed as unfinished, this computer's name capitalised mid-sentence, the terminal hint during its in-place sign-in) are fixed in `71f91c46`. VM visual check done: the owner approved the P3.3 screenshots 2026-09-28 (the canvas "Sign in again screens for approval (P3.3)", v1): 80 images of build `f1ccb5f2` on WINDOWS_1, MOCKED (fake CLI, fictional accounts), both themes, 1600x1000 and 1280x720, local and gitignored in `.ccc-canvas/screens/p3.3-f1ccb5f2/`; visual evidence only, never Real CLI or Packaged. Owed: the proof that signing out the old folder never signs the new one out (a second real sign-in on the VM at 0.153.4 and 0.155.1, file and keyring stores; owner action; it turns on auth.retireReplaced) and each folder's credential store recorded; a real replacement revalidation after that sign-out; the user-facing sweep (P3.16) |
| 12 | Upgrade: "Do you use Codex?", and the Set up Codex page's read-only check of this computer's sign-in | VERIFIED | yes, +e2e | partial (Win) | partial (Win) | P2 | Done: `tests/e2e/codex-reconfirm-upgrade.spec.ts` on the VM (WINDOWS_1), 3/3 at `21fff8bc`, `c6dc4b60` and `95385267` (Claude-only, Codex-only and both upgraders). Upgrade walk from v2.1.1-beta.1: asked once after the release notes, again if quit unanswered, never after an answer; the check of a signed-in ~/.codex and "Use this sign-in" (AUTHENTICATED, 0.157.1); a signed-out `CODEX_HOME` named on the page (SIGNED-OUT); the check alone added no account. Owed: real runs at 0.153.4 and 0.155.1; the CLI's own scratch writes under `tmp/` in that folder were seen on 0.153.4 and 0.157.1 (0.155.1 unverified) |
| 13 | Hello Codex, including after the upgrade Yes | VERIFIED | yes, +VM | partial (Win) | partial (Win) | P2 | Per OS. Windows (AUTHENTICATED managed, 0.157.1): after the upgrade Yes and the owner's managed sign-in, shown right after Set up Codex, marked seen, not shown on relaunch; replayed from Accounts (pages 1 to 5) and the Feature Guide. The MOCKED walk (seeded account, fake CLI) matched. Never due for an adopted ~/.codex, by design |
| 14 | Codex-only mode, no Claude noise | PARTIAL | yes | partial (Win) | partial (Win) | P3 | Title-bar Anthropic pills, onboarding steps, showcase, Accounts panel, session dialog. Upgrade walk (Claude Code off, SIGNED-OUT): no Claude install or sign-in demands; still seen: the title-bar Claude.ai pill, the Accounts Claude card's sign-in prompts while Claude Code is off (built in P3.2, 65612489: the card lists its accounts with no actions or sign-in prompts; seen on the VM with Claude Code off in the P3.2 Accounts screenshots the owner approved 2026-09-28, row 7, MOCKED), Ask Conductor saying it runs on Claude Code (row 53), and Hello Codex page 1 saying Codex runs beside Claude. Built in P3.4 (aa0411b0, a0c0e9ba), mocked: the title bar's Claude pills only while Claude Code is on (and no call to its status page while off; row 45); with Claude Code off, Built-in Tools asks about your sessions, blocks Claude review and notes Codex review (Settings' Code review rows too), the recap's Account row reads OD27's D5 line with no Claude sign-in read, What's New and its showcase hide what needs Claude Code in this release, and the Accounts registry callout drops "Your Claude accounts below still work"; Hello Codex page 1 already reads "Codex now runs in this window" with Claude Code off (`hello-codex.acceptance.test.ts`, review round 1). P3.4 follow-up (9056e021 and its fix round): with Claude Code off What's New also hides its SSH Persistent and Remote Resumable lines (`whatsnew-showcase.test.tsx`), and the session dialog disables the SSH Persistent card for Terminal only, with the reason, as it does for Codex (`claude-off-launch.test.tsx`). Done: the ADR-009 pass (lenses N and G PASS at c7f9a34a, lens N re-confirmed PASS at 87ba9c2d; ADR-009 lens N re-confirmed PASS at 839ab591 (sync throw in the queued refresh cannot escape; no request to an off provider)); the VM walk PASS at c7f9a34a (e2e 81/81; no request to OpenAI's status page while Codex was off or not answered), in Codex-only mode, its minor M1 fixed in 9056e021; the owner approved the VM screenshots (canvas "P3.4 Codex-only screens" v1, 2026-09-28, the gallery at f65de184); the VM re-check at f65de184 PASS (e2e 80 passed and 1 flaky, terminal-links.spec.ts line 110, passed on retry and in 3 more runs of that spec alone; the VM-only files as at c7f9a34a; What's New, the SSH dialog and the pills PASS); CI at f65de184 green but for the Desktop test gate (owner). After it, d2ea6e66 and 7811229f made the guided tour's cards 1, 3, 4 and 6 and the Feature Guide's productivity hero name only the assistants in use (both on unchanged; `guided-tour-provider-copy.test.tsx`, `claude-off-launch.test.tsx`), unit-tested only so far. Owed: a VM screenshot check of those cards (Codex only, Claude Code only, both on) for the owner's approval, with the next phase's VM gallery; the Feature Guide catalogue cards naming both providers (`training-steps.ts` lines 90, 132, 748) in P3.16's sweep; Ask (row 53, PR 4); the Sentinel card (P3.9) and the log indexing card (P3.12); lifting each `needsClaude` flag in the phase that brings its feature to Codex (P3.6, P3.10, P4.1, P4.3, P4.7; the remote resume page and What's New's SSH Persistent and Remote Resumable lines keep their flag: Codex over SSH is outside this release); the Desktop test gate (owner) |
| 15 | Owner-run gates (native keyring, credential logins, packaged smoke) | MISSING | no | no | no | P4 | Hosts and timing from the owner |
| 16 | WP1 traceability | PARTIAL | n/a | n/a | n/a | P4 | Items move from planned to evidenced |

## B. Account summary, usage footer, switching, Tokenomics

The owner approved the usage UX on 2026-09-27 (the account summary, the
usage footer and Tokenomics; `docs/wp1/owner-decisions-2026-09-27.md`).
Rows 17 to 21, 26 and 28 to 30 are built by the multi-provider usage track
of P3, phases MP1 to MP13; a closed Codex account's reading comes from the
scoped app-server read of ADR-022. The owner approved the usage screenshots
on 2026-09-27: 125 images in `.ccc-canvas/screens/usage-final-8e41444f/` (local,
gitignored), 124 mocked and 1 real (redacted).

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 17 | All-accounts usage page | PARTIAL | yes | partial (Win) | no | P3 | Usage track MP3, MP4, MP8: a Codex section with the live, fresh-read and last-seen figures, per-token and no-session notes (`tests/unit/renderer/account-usage-panel-streaming.test.tsx`, `tests/unit/main/codex-usage-read.test.ts`). Real CLI: the MP8 VM walk (Windows, unsigned candidates at 81ed64a8 and fa2907e7, AUTHENTICATED managed) read a ChatGPT account on 0.153.4 and 0.155.1 and never read 0.157.1. Screens approved by the owner 2026-09-27. Owed: the Codex credits row that Claude's cards have (a known issue in app-knowledge until a real read shows the unit; completion plan P3.1, P3.14); macOS and Linux, packaged. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 7). |
| 18 | Session-strip meters | VERIFIED | yes | no | no | P3 | Usage track MP2, MP6: Codex meters labelled from `window_minutes` (5h, Weekly, one per separate limit), the no-reading meter after a reset, and the pending state (`tests/unit/renderer/session-status-strip.test.ts`, `tests/unit/renderer/strip-usage-consistency.test.ts`). Screens approved by the owner 2026-09-27. Owed: a 0.155.1 rollout fixture from a real session, and a real-CLI run. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 6). |
| 19 | Strip cost wording | VERIFIED | yes | no | no | P3 | Usage track MP6: API-equivalent estimate, or Estimate at API list prices for an API-key account (`tests/unit/renderer/strip-usage-consistency.test.ts`); Tokenomics words each session's cost the same way (MP12, `tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |
| 20 | Account chip (strip and sidebar) | PARTIAL | yes | no | no | P3 | The usage page and the footer carry the account's identity chip (usage track MP4, MP5; `tests/unit/renderer/multi-account-statusline-render.test.tsx`). Screens approved by the owner 2026-09-27. Owed: the chip on the session strip and in the sidebar; the migration of Claude's email-keyed colour overrides into the identity's colour, moved here from row 7 at the P3.2 review |
| 21 | Multi-account footer | VERIFIED | yes | no | no | P3 | Usage track MP5, MP6: one pill per identity, grouped by provider, percentages never merged across providers; bars hidden per provider (`tests/unit/renderer/multi-account-statusline-render.test.tsx`). Screens approved by the owner 2026-09-27. Owed: a real-CLI and packaged run |
| 22 | Switch the account of a running session | MISSING | no | no | no | P3 | Keep the conversation, as Claude does. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 1). |
| 23 | Choose the account at launch | VERIFIED | yes | partial (Win) | partial (Win) | P4 | Per OS. Windows (AUTHENTICATED managed): the new-config picker defaulted to the managed account with no confirmation box, and real Codex 0.157.1 launched. Upgrade walk (AUTHENTICATED, this computer's Codex): Create waited for its launch confirmation, then real Codex 0.157.1 launched |
| 24 | Running sessions per account | VERIFIED | yes | no | no | P3 | Built in P3.2 (65612489): "N running" on the account row. Owed: the P3.2 reviews. VM check done: "N running" with sessions running on the VM (fake CLI, MOCKED) in the P3.2 Accounts screenshots the owner approved 2026-09-28 (row 7) |
| 25 | Tokenomics reads managed realms and `~/.codex` | VERIFIED | yes | no | no | P4 | Real rollouts. MP9 round 1: a realm's folder is read only through the canonical-home check, and a folder or rollout reached twice (a junction, a hard link) is read once (`tests/unit/native/tokenomics-reindex-accounts.native.test.ts`). Screens approved by the owner 2026-09-27. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 6). |
| 26 | Tokenomics per-account attribution and filters | VERIFIED | yes | no | no | P3 | Usage track MP9, MP10, MP12: Codex by the realm folder (`tests/unit/native/tokenomics-reindex-accounts.native.test.ts`); Claude by the account profile a local session runs under, its transcript in that profile home's `.claude/projects` (from now on; the old layout without `.claude` is refused, MP10 round 1: `tests/unit/main/tokenomics-attribution.test.ts`), recorded in the index as `tests/unit/native/tokenomics-attribution.native.test.ts` shows; Provider and Account filters with Not recorded under both providers and This computer's sign-in (`tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |
| 27 | Subagent collision fix | VERIFIED | yes | no | no | P4 | Screens approved by the owner 2026-09-27. Owed: a real 0.155.1 subagent rollout |
| 28 | Codex pricing | PARTIAL | yes | no | no | P3 | Usage track MP11: a model with no price reads "no price" and is in no total; one cached-input rule for the strip and Tokenomics (`tests/unit/tokenomics/tk-pricing.test.ts`, `tests/unit/native/tk-db-summary.native.test.ts`). Screens approved by the owner 2026-09-27. Owed: live OpenAI prices from the LiteLLM fetch Claude's prices come from (parity, resolved 2026-09-26); today a static table of three models (`resources/codex-pricing.json`), so four of the six models on offer read "no price" (completion plan P3.8) |
| 29 | Plan type | VERIFIED | yes | partial (Win) | no | P3 | Usage track MP2, MP8: the plan from each reading, recorded on the account (`tests/unit/main/codex-usage-read.test.ts`); the MP8 VM walk showed Pro on 0.153.4 and 0.155.1. Screens approved by the owner 2026-09-27. Owed: macOS and Linux, packaged |
| 30 | Tokenomics totals split by provider | VERIFIED | yes | no | no | P3 | Usage track MP11, MP12: every KPI and the daily series per provider, shown as a two-segment split and two chart lines (`tests/unit/native/tk-db-summary.native.test.ts`, `tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |

## C. Sessions, statusline, model, Sentinel, Watchdog, status

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 31 | Logs history, search and transcript | MISSING | no | no | no | P3 | Index realm rollouts; realms never cross |
| 32 | Resume picker | PARTIAL | yes | yes (Win) | no | P3 | Worktree conversations and names. Built in P3.5 (44729f29, mocked): every git worktree's conversations, tagged and started in their own worktree; today's found by the local date too; a session's name from the app's session state; names and labels shown as plain text, built in one place; the conversation picked recorded for the app (`codex-resume-picker-worktrees.test.ts`). Fix round 1 (0cb77940, 16091336, 6400f8a8): every decision the picker makes is recorded, its walk follows no link, and it finds git by an absolute path and fails safe. Fix round 2 (259847f0, cc4383ff): the pick file sits in a folder made for each launch; a refused write is tried again briefly, and one still not recorded is said in the terminal while the launch goes on; a worktree is started in only when it is a directory. Fix round 3 (770a4fb6): the picker writes its pick only into the folder the app made for the launch, by the identity the app recorded. VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows): worktree conversations listed, named and started in their worktree; names and labels shown as plain text. VM finding V2, fixed (b969e828, mocked): a conversation resumed from the picker is claimed at the pick, so its status line shows at once, as a resume by id does. Owed: the review and ADR-009 pass of V2 and its VM recheck; the owner's review of the VM screenshots; the name file Claude's picker prefers, with the exact bind of a new Codex conversation (P3.10, P3.12; completion plan P3.5) |
| 33 | Resume in the exact realm | VERIFIED | yes | no | no | P4 | Real: realm B never lists realm A |
| 34 | Exact resume on app relaunch | UNVERIFIED | yes | yes (Win) | no | P3 | `codex resume <id>` in the same realm. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 2). Built in P3.5 (90a717df, mocked): main keeps the conversation each Codex session is on and session:save persists it; a restored session resumes it before the flags, bypassing the picker, only when its rollout is in the launch's own realm (a conversation carried over by a staged Sign in again resumes in the account's new folder), in the directory it recorded while that holds, the id checked again before argv (`spawn-resume.test.ts`, `codex-resume-launch.test.ts`, `session-resume-enrich.test.ts`). Fix round 1 (16091336): of two rollouts with one id the one recording the kept directory wins, then the one in its own date folder; a resume that finds none recording it says so in the log. Fix round 2 (1616ff1f): a resume walks the realm once and the watcher takes the rollout it chose. Fix round 3 (2989d876): the walk stops early only at the rollout in its own date folder that records the kept directory, so a copy recording another one never hides it. Limit, recorded (completion plan P3.5): two new sessions in one folder (launched directly or choosing New conversation) started within seconds of each other can take each other's rollout, and each then keeps the other's conversation for Restart and relaunch, until the exact claim (P3.10). VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows): a relaunch resumes the same conversation. Owed: the SSH live matrix; a conversation carried over by a staged Sign in again (P3.3) on the VM, an owner action (it needs a second real sign-in) |
| 35 | Restart and Switch keep the conversation | PARTIAL | yes | partial (Win) | no | P3 | As Claude. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 1). Restart built in P3.5 (90a717df, mocked): Restart resumes the conversation the session kept (a new one when it had none), and Restart and pick a conversation still opens the picker (`codex-resume-launch.test.ts`). Deviation, recorded (completion plan P3.5): with no known conversation Claude's Restart opens the picker, Codex's plain Restart starts a new one, by the F7 menu. Fix round 1 (0cb77940): a picker session keeps only the conversation the picker decided, so a picker session that resumes a conversation never resumes another session's on Restart (a new conversation, from the picker or a direct launch, has row 34's limit). Fix round 2 (259847f0): a later decision (the fallback after a resume that failed) lets the kept conversation go. VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows): Restart keeps the conversation. Owed: Switch account is P3.6 |
| 36 | Statusline segments | PARTIAL | no | no | no | P3 | Account chip, lines, duration. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 5). |
| 37 | Statusline settings | PARTIAL | yes | no | no | P2, P3 | P3: the missing segments. Done in P2 (mocked): the settings say they apply to Codex |
| 38 | Statusline after resuming an old rollout | UNVERIFIED | yes | partial (Win) | no | P3 | Resume a two-day-old conversation on 0.155.1. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 2). Built in P3.5 (28f42af2, 90a717df, mocked): the claim re-reads its day folders on every poll (by UTC and by local date) and finds a resumed conversation by its id, or the one the picker opened, wherever it is in the account's folder; a picker launch waits for the user (`telemetry-claim-anywhere.test.ts`). Fix round 1 (0cb77940, 16091336): a picker launch claims only what the picker decided; a claimed rollout is read by size first and only what it gained, at a claim its head and tail (`telemetry-bounded-reads.test.ts`). Fix round 2 (1616ff1f, 259847f0): the walk stops at the conversation's rollout in its own date folder; a later picker decision lets the claim go and claims again (`rollout-lookup.test.ts`, `telemetry-claim-anywhere.test.ts`). Fix round 3 (2989d876, 770a4fb6): the walk stops early only there when that rollout records the kept directory; a claim let go clears the status line; the pick folder is used only while it is the one made for the launch. VM (2026-09-28, c2c42e22; real Codex 0.155.1 with both providers on, and 0.153.4 with Codex only, Windows): the status line of a conversation from an earlier date folder, resumed from the picker and on relaunch. The midnight UTC case is covered by unit tests with fake timers only, not on the VM. VM finding V2, fixed (b969e828, mocked): a picker resume shows its status line at the pick, not at its first new turn. Owed: the review and ADR-009 pass of V2 and its VM recheck; a session crossing midnight UTC on a real CLI |
| 39 | Model catalogue | PARTIAL | no | no | no | P3 | From the registry and Sentinel |
| 40 | Effort | PARTIAL | no | no | no | P3 | Per-model levels |
| 41 | Mid-session model and effort | PARTIAL | no | no | no | P3 | Without losing the conversation. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 3). |
| 42 | Sentinel | PARTIAL | no | no | no | P3 | Version drift, flags and rollout format, with findings |
| 43 | Watchdog | MISSING | no | no | no | P3 | Auto-retry and silence detection. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 4). |
| 44 | Services (PTY integrity) | UNVERIFIED | no | no | no | P3 | A Codex session in the snapshot |
| 45 | Provider status pill | PARTIAL | yes | n/a | no | P3 | Built in P3.4 (aa0411b0): a Codex pill from OpenAI's public status page (`status.openai.com`, its CLI and Codex API components; the Codex API as its own pill only when not operational, as Claude's API is), read only while Codex is on, and Claude's pills only while Claude Code is on; a switch is acted on when the settings are saved (`service-status-providers.test.ts`, `titlebar-provider-status.test.tsx`). P3.4 follow-up (87ba9c2d and its fix round): the accounts-service changes of one turn of the event loop are one status refresh, in the next turn, and a synchronous throw in it never escapes. Done: the ADR-009 pass (lenses N and G PASS at c7f9a34a, lens N re-confirmed PASS at 87ba9c2d; ADR-009 lens N re-confirmed PASS at 839ab591 (sync throw in the queued refresh cannot escape; no request to an off provider)); the VM walk PASS at c7f9a34a (e2e 81/81; no request to OpenAI's status page while Codex was off or not answered), the pills with both on, Claude Code off, Codex off and Codex not answered; the owner approved the VM screenshots (canvas "P3.4 Codex-only screens" v1, 2026-09-28, the gallery at f65de184); the VM re-check at f65de184 PASS (e2e 80 passed and 1 flaky, terminal-links.spec.ts line 110, passed on retry and in 3 more runs of that spec alone; the VM-only files as at c7f9a34a; What's New, the SSH dialog and the pills PASS); CI at f65de184 green but for the Desktop test gate (owner). Row 45's P3.4 work is complete bar that gate. Owed: the Desktop test gate (owner); macOS and Linux; packaged |
| 46 | Busy sweep and sleep moon | MISSING | no | no | no | P3 | From output and silence. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 4). |
| 47 | Waiting-for-input and attention dot | MISSING | no | no | no | P3 | From Codex notify and hooks. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 4). |

## D. MCP, reviews, Canvas, browser, Ask, knowledge, Memory, logs, cloud, web

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 48 | Conductor MCP transport | VERIFIED | yes | no | no | P4 | A live 0.155.1 tool listing |
| 49 | `codex_review` | VERIFIED | yes | no | no | P4 | A real credential run |
| 50 | `claude_review` | VERIFIED | yes | no | no | P4 | A live wait past 300 s |
| 51 | Agent Canvas from Codex | MISSING | no | no | no | P4 | Tools, roots, instruction delivery, the live loop. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 8). |
| 52 | Browser and vision tools | MISSING | no | no | no | P4 | Settled by parity (completion plan, section 10): the July "Claude only for now" call is superseded by the parity rule; Codex sessions get the vision tools and `open_in_app_browser` (completion plan P4.2) |
| 53 | Ask Conductor on Codex | MISSING | no | no | no | P4 | Decision recorded 2026-09-27 (owner-decisions-2026-09-27.md M4, option B): with both on, a Settings, General row "Ask Conductor runs on: Claude Code / Codex", Claude Code by default; Codex-only uses Codex. Not built yet (PR 4) |
| 54 | App knowledge, tour, tips | PARTIAL | yes | n/a | no | P2, P4 | P4: the final sweep. Done in P2 (mocked): the false tour, Memory, Status Line and device-code lines fixed. After the upgrade walk: the Codex update wording (app knowledge, User Guide), the Partner Terminal, Command Targeting and Codex accounts tips, and the Feature Guide's Combined Mode card |
| 55 | Memory | MISSING | no | no | no | P4 | Codex memories per realm. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 10). |
| 56 | Codex logs | MISSING | no | no | no | P4 | Surface `$CODEX_HOME/log`. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 10). |
| 57 | Cloud Agents | MISSING | no | no | no | P4 | Via `codex exec`. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 9). |
| 58 | Web sign-in and artifacts | OWNER | no | no | no | P4 | A section 19 record; no artifacts equivalent assumed. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 11). |

## E. Everything else

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 59 | PR CI on Linux | MISSING | n/a | n/a | n/a | P4 | ubuntu-latest green (D5) |
| 60 | Real-CLI coverage in CI | MISSING | n/a | no | n/a | P4 | Min, pinned and release candidate per OS |
| 61 | Compact | MISSING | no | no | no | P3 | Codex's own command. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 3). |
| 62 | Extra CLI arguments | MISSING | no | no | no | P3 | With a block-list for authority settings |
| 63 | Hooks gateway and notification rules | MISSING | no | no | no | P3 | Route Codex notify events. P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 4). |
| 64 | Partner terminal wording | VERIFIED | yes | partial (Win) | partial (Win) | P2 | The per-OS runs only. Done in P2: the strip names the tab's assistant (`tests/unit/renderer/session-launch.test.ts`), and the Partner Terminal and Command Targeting tips and the Feature Guide's Combined Mode card say Claude or Codex; seen on a live Codex tab (AUTHENTICATED). At the narrow window the GitHub button overlaps the strip's label on Claude and Codex tabs alike: older than P2, outside it |
| 65 | GitHub session context | PARTIAL | no | no | no | P3 | Read Codex rollouts |
| 66 | Packaged smoke | PARTIAL | n/a | n/a | partial (Win) | P4 | Per OS, on a clean machine, signed. Windows so far: the P2 upgrade walk (an unsigned candidate over the signed beta on a used test VM) |
| 67 | E2E mode matrix | PARTIAL | yes, +e2e | no | no | P2, P4 | P2: VM (WINDOWS_1) run at `21fff8bc`: 77/80; two failures in specs this branch changed (`codex-settings-section` Accounts locator, `session-dialog-permutations` Codex x SSH seed after U1), fixed test-side; re-run after the fix: 80/81, both specs and a new not-set-up guard pass, the upgrade case (`codex-reconfirm-upgrade.spec.ts`) 3/3. After the upgrade-walk fixes: 80/81 at `c6dc4b60` and again at `95385267`. One pre-existing e2e failure, reproduced on beta, is routed privately (not suppressed, not waived). P4: restart, enable/disable, a real launch |
| 68 | Insights | MISSING | no | no | no | P4 | Settled by parity (resolved 2026-09-26; completion plan, section 10): a Conductor-native Codex report, run with `codex exec`; a mockup before the build (completion plan P4.7). P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 9). |
| 69 | Plan mode | MISSING | no | no | no | P3 | Settled by parity (completion plan, section 10): Plan mode as a launch option, as Claude's (completion plan P3.8). P3.1 evidence recorded (`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 3): neither supported version has a launch flag for it; both have the mid-session `/plan` command, so parity carries over by sending `/plan` once the session has started, and no section 19 record is needed. |
| 70 | Image paste | UNVERIFIED | no | no | no | P3 | Codex sees the image |
| 71 | Copy, paste, scrollback, mouse | UNVERIFIED | no | no | no | P3 | Re-captured at 0.155.1 |
| 72 | Multi Spawn and Quick Start with Codex | PARTIAL | no | partial (Win) | partial (Win) | P2, P3 | P3: N copies, one lease each; Quick Start; a Codex-path test (the rule's tests use Claude configs). Done in P2, seen on the upgrade walk (AUTHENTICATED): a Codex config that is not Multi Spawn runs one at a time (a Not started tab's Restart is refused while a live copy runs; one Codex process), and a restored Not started copy plus a fresh launch no longer turns it into Multi Spawn |
| 73 | Channel rules delivery | UNVERIFIED | no | no | no | P3 | Delivered in the Codex terminal |
| 74 | Command buttons, preset pill, restart menu, theme | VERIFIED | yes | no | no | P4 | None beyond the real-CLI pass |
| 75 | Claude-only environment switches | N/A | n/a | n/a | n/a | n/a | The label says Claude only |

## Capability leads for later packages (not built in P2)

Supplied by the review lead on 2026-09-26. Each must be checked on the
supported CLI versions (0.153.4 minimum, 0.155.1 pinned) before any work
relies on it; current online documentation can describe a newer CLI.

- The Codex CLI documents `/plan`, `/model`, `/compact` and `/statusline`.
  Native support still needs Conductor integration (rows 35, 39 to 41, 61,
  69).
- The Codex app-server documents `account/read` (ChatGPT email and plan),
  `account/rateLimits/read` (allowances and reset times) and `model/list`
  (models and reasoning efforts). Missing fields in `codex login status` do
  not prove these are unavailable; account types differ in what they return
  (rows 17 to 21, 29, 39, 40; the email on the Set up Codex page).
  `account/rateLimits/read` was checked offline on 0.153.4, 0.155.1 and
  0.157.1 (MP1: what the read uses is identical on all three) and is the
  only method the scoped exception of ADR-022 allows.
- Codex supports STDIO and Streamable HTTP MCP servers. The Canvas and
  browser tools are to be validated through the existing Conductor MCP
  integration (rows 51, 52).
- `codex cloud exec/status/list/apply/diff` appear in the 0.153.4 help. They
  are experimental: availability and suitability still need testing (row
  57).

Limits that stay in force: the terminal-wrapper architecture is kept; this
app never parses Codex's credential files; and nothing assumes a CLI sign-in
gives ChatGPT browser cookies or an artifacts equivalent.
