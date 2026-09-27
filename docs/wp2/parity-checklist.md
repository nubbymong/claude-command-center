# 2.1.1 Codex parity: release checklist

The release-wide list for 2.1.1, the Codex feature-parity release. Its gate is
zero unsupported shared Conductor features for Codex (WP1 design section 19).
**SSH Codex sessions are the only agreed exclusion.** A PR being ready never
means parity is complete. The decisions behind this list are in
`docs/wp1/owner-decisions-2026-09-20.md`,
`docs/wp1/owner-decisions-2026-09-26.md` and
`docs/wp1/owner-decisions-2026-09-27.md`.

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
| C | Resume replaces the whole tab list while its prompt is non-modal: tabs launched meanwhile drop out of the list while still running, and Refresh can bring them back as duplicates | This section |
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
| 7 | Identity rename, recolour, link, unlink, groups after creation | PARTIAL | no | no | no | P3 | Identity editor from every row's chip |
| 8 | One Accounts surface | PARTIAL | no | no | no | P3 | One row component for both providers |
| 9 | Launch and resume in the exact account | VERIFIED | yes, +e2e | partial (Win) | partial (Win) | P4 | A restored tab keeping a managed account; per OS. Windows (AUTHENTICATED managed): a saved config on the managed account launched real Codex 0.157.1 to its idle prompt with no per-launch confirmation, from Create and from its row (Codex's own first-run sandbox question left for the owner). Upgrade walk (AUTHENTICATED, adopted ~/.codex): a new config, and a beta-saved config launched from its row, ran real Codex 0.157.1 after the per-launch confirmation; a restored tab asked for that confirmation, and a cancelled confirmation, or no account, left it Not started with its reason |
| 10 | Lifecycle blockers and archive | PARTIAL | no | no | no | P3 | Blocker names each consumer with Go to; Archived list with Restore |
| 11 | Staged re-authentication (WP1.52) | MISSING | no | no | no | P3 | Build it |
| 12 | Upgrade: "Do you use Codex?", and the Set up Codex page's read-only check of this computer's sign-in | VERIFIED | yes, +e2e | partial (Win) | partial (Win) | P2 | Done: `tests/e2e/codex-reconfirm-upgrade.spec.ts` on the VM (WINDOWS_1), 3/3 at `21fff8bc`, `c6dc4b60` and `95385267` (Claude-only, Codex-only and both upgraders). Upgrade walk from v2.1.1-beta.1: asked once after the release notes, again if quit unanswered, never after an answer; the check of a signed-in ~/.codex and "Use this sign-in" (AUTHENTICATED, 0.157.1); a signed-out `CODEX_HOME` named on the page (SIGNED-OUT); the check alone added no account. Owed: real runs at 0.153.4 and 0.155.1; the CLI's own scratch writes under `tmp/` in that folder were seen on 0.153.4 and 0.157.1 (0.155.1 unverified) |
| 13 | Hello Codex, including after the upgrade Yes | VERIFIED | yes, +VM | partial (Win) | partial (Win) | P2 | Per OS. Windows (AUTHENTICATED managed, 0.157.1): after the upgrade Yes and the owner's managed sign-in, shown right after Set up Codex, marked seen, not shown on relaunch; replayed from Accounts (pages 1 to 5) and the Feature Guide. The MOCKED walk (seeded account, fake CLI) matched. Never due for an adopted ~/.codex, by design |
| 14 | Codex-only mode, no Claude noise | PARTIAL | no | partial (Win) | partial (Win) | P3 | Title-bar Anthropic pills, onboarding steps, showcase, Accounts panel, session dialog. Upgrade walk (Claude Code off, SIGNED-OUT): no Claude install or sign-in demands; still seen: the title-bar Claude.ai pill, the Accounts Claude card's sign-in prompts while Claude Code is off, Ask Conductor saying it runs on Claude Code (row 53), and Hello Codex page 1 saying Codex runs beside Claude |
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
| 17 | All-accounts usage page | VERIFIED | yes | partial (Win) | no | P3 | Usage track MP3, MP4, MP8: a Codex section with the live, fresh-read and last-seen figures, per-token and no-session notes (`tests/unit/renderer/account-usage-panel-streaming.test.tsx`, `tests/unit/main/codex-usage-read.test.ts`). Real CLI: the MP8 VM walk (Windows, unsigned candidates at 81ed64a8 and fa2907e7, AUTHENTICATED managed) read a ChatGPT account on 0.153.4 and 0.155.1 and never read 0.157.1. Screens approved by the owner 2026-09-27. Owed: macOS and Linux, packaged |
| 18 | Session-strip meters | VERIFIED | yes | no | no | P3 | Usage track MP2, MP6: Codex meters labelled from `window_minutes` (5h, Weekly, one per separate limit), the no-reading meter after a reset, and the pending state (`tests/unit/renderer/session-status-strip.test.ts`, `tests/unit/renderer/strip-usage-consistency.test.ts`). Screens approved by the owner 2026-09-27. Owed: a 0.155.1 rollout fixture from a real session, and a real-CLI run |
| 19 | Strip cost wording | VERIFIED | yes | no | no | P3 | Usage track MP6: API-equivalent estimate, or Estimate at API list prices for an API-key account (`tests/unit/renderer/strip-usage-consistency.test.ts`); Tokenomics words each session's cost the same way (MP12, `tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |
| 20 | Account chip (strip and sidebar) | PARTIAL | yes | no | no | P3 | The usage page and the footer carry the account's identity chip (usage track MP4, MP5; `tests/unit/renderer/multi-account-statusline-render.test.tsx`). Screens approved by the owner 2026-09-27. Owed: the chip on the session strip and in the sidebar |
| 21 | Multi-account footer | VERIFIED | yes | no | no | P3 | Usage track MP5, MP6: one pill per identity, grouped by provider, percentages never merged across providers; bars hidden per provider (`tests/unit/renderer/multi-account-statusline-render.test.tsx`). Screens approved by the owner 2026-09-27. Owed: a real-CLI and packaged run |
| 22 | Switch the account of a running session | MISSING | no | no | no | P3 | Keep the conversation, as Claude does |
| 23 | Choose the account at launch | VERIFIED | yes | partial (Win) | partial (Win) | P4 | Per OS. Windows (AUTHENTICATED managed): the new-config picker defaulted to the managed account with no confirmation box, and real Codex 0.157.1 launched. Upgrade walk (AUTHENTICATED, this computer's Codex): Create waited for its launch confirmation, then real Codex 0.157.1 launched |
| 24 | Running sessions per account | PARTIAL | no | no | no | P3 | Shown on the account row |
| 25 | Tokenomics reads managed realms and `~/.codex` | VERIFIED | yes | no | no | P4 | Real rollouts. MP9 round 1: a realm's folder is read only through the canonical-home check, and a folder or rollout reached twice (a junction, a hard link) is read once (`tests/unit/native/tokenomics-reindex-accounts.native.test.ts`). Screens approved by the owner 2026-09-27. |
| 26 | Tokenomics per-account attribution and filters | VERIFIED | yes | no | no | P3 | Usage track MP9, MP10, MP12: Codex by the realm folder (`tests/unit/native/tokenomics-reindex-accounts.native.test.ts`); Claude by the account profile a local session runs under, its transcript in that profile home's `.claude/projects` (from now on; the old layout without `.claude` is refused, MP10 round 1: `tests/unit/main/tokenomics-attribution.test.ts`), recorded in the index as `tests/unit/native/tokenomics-attribution.native.test.ts` shows; Provider and Account filters with Not recorded under both providers and This computer's sign-in (`tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |
| 27 | Subagent collision fix | VERIFIED | yes | no | no | P4 | Screens approved by the owner 2026-09-27. Owed: a real 0.155.1 subagent rollout |
| 28 | Codex pricing | VERIFIED | yes | no | no | P3 | Usage track MP11: a model with no price reads "no price" and is in no total; one cached-input rule for the strip and Tokenomics (`tests/unit/tokenomics/tk-pricing.test.ts`, `tests/unit/native/tk-db-summary.native.test.ts`). Screens approved by the owner 2026-09-27. |
| 29 | Plan type | VERIFIED | yes | partial (Win) | no | P3 | Usage track MP2, MP8: the plan from each reading, recorded on the account (`tests/unit/main/codex-usage-read.test.ts`); the MP8 VM walk showed Pro on 0.153.4 and 0.155.1. Screens approved by the owner 2026-09-27. Owed: macOS and Linux, packaged |
| 30 | Tokenomics totals split by provider | VERIFIED | yes | no | no | P3 | Usage track MP11, MP12: every KPI and the daily series per provider, shown as a two-segment split and two chart lines (`tests/unit/native/tk-db-summary.native.test.ts`, `tests/unit/renderer/tokenomics-mp12.test.tsx`). Screens approved by the owner 2026-09-27. |

## C. Sessions, statusline, model, Sentinel, Watchdog, status

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 31 | Logs history, search and transcript | MISSING | no | no | no | P3 | Index realm rollouts; realms never cross |
| 32 | Resume picker | PARTIAL | no | no | no | P3 | Worktree conversations and names |
| 33 | Resume in the exact realm | VERIFIED | yes | no | no | P4 | Real: realm B never lists realm A |
| 34 | Exact resume on app relaunch | MISSING | no | no | no | P3 | `codex resume <id>` in the same realm |
| 35 | Restart and Switch keep the conversation | PARTIAL | no | no | no | P3 | As Claude |
| 36 | Statusline segments | PARTIAL | no | no | no | P3 | Account chip, lines, duration |
| 37 | Statusline settings | PARTIAL | yes | no | no | P2, P3 | P3: the missing segments. Done in P2 (mocked): the settings say they apply to Codex |
| 38 | Statusline after resuming an old rollout | UNVERIFIED | no | no | no | P3 | Resume a two-day-old conversation on 0.155.1 |
| 39 | Model catalogue | PARTIAL | no | no | no | P3 | From the registry and Sentinel |
| 40 | Effort | PARTIAL | no | no | no | P3 | Per-model levels |
| 41 | Mid-session model and effort | PARTIAL | no | no | no | P3 | Without losing the conversation |
| 42 | Sentinel | PARTIAL | no | no | no | P3 | Version drift, flags and rollout format, with findings |
| 43 | Watchdog | MISSING | no | no | no | P3 | Auto-retry and silence detection |
| 44 | Services (PTY integrity) | UNVERIFIED | no | no | no | P3 | A Codex session in the snapshot |
| 45 | Provider status pill | MISSING | no | no | no | P3 | An OpenAI status pill while Codex is on |
| 46 | Busy sweep and sleep moon | MISSING | no | no | no | P3 | From output and silence |
| 47 | Waiting-for-input and attention dot | MISSING | no | no | no | P3 | From Codex notify and hooks |

## D. MCP, reviews, Canvas, browser, Ask, knowledge, Memory, logs, cloud, web

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 48 | Conductor MCP transport | VERIFIED | yes | no | no | P4 | A live 0.155.1 tool listing |
| 49 | `codex_review` | VERIFIED | yes | no | no | P4 | A real credential run |
| 50 | `claude_review` | VERIFIED | yes | no | no | P4 | A live wait past 300 s |
| 51 | Agent Canvas from Codex | MISSING | no | no | no | P4 | Tools, roots, instruction delivery, the live loop |
| 52 | Browser and vision tools | OWNER | no | no | no | P4 | The July "Claude only for now" call is superseded by the parity rule |
| 53 | Ask Conductor on Codex | MISSING | no | no | no | P4 | Which provider hosts Ask when both are on (owner) |
| 54 | App knowledge, tour, tips | PARTIAL | yes | n/a | no | P2, P4 | P4: the final sweep. Done in P2 (mocked): the false tour, Memory, Status Line and device-code lines fixed. After the upgrade walk: the Codex update wording (app knowledge, User Guide), the Partner Terminal, Command Targeting and Codex accounts tips, and the Feature Guide's Combined Mode card |
| 55 | Memory | MISSING | no | no | no | P4 | Codex memories per realm |
| 56 | Codex logs | MISSING | no | no | no | P4 | Surface `$CODEX_HOME/log` |
| 57 | Cloud Agents | MISSING | no | no | no | P4 | Via `codex exec` |
| 58 | Web sign-in and artifacts | OWNER | no | no | no | P4 | A section 19 record; no artifacts equivalent assumed |

## E. Everything else

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 59 | PR CI on Linux | MISSING | n/a | n/a | n/a | P4 | ubuntu-latest green (D5) |
| 60 | Real-CLI coverage in CI | MISSING | n/a | no | n/a | P4 | Min, pinned and release candidate per OS |
| 61 | Compact | MISSING | no | no | no | P3 | Codex's own command |
| 62 | Extra CLI arguments | MISSING | no | no | no | P3 | With a block-list for authority settings |
| 63 | Hooks gateway and notification rules | MISSING | no | no | no | P3 | Route Codex notify events |
| 64 | Partner terminal wording | VERIFIED | yes | partial (Win) | partial (Win) | P2 | The per-OS runs only. Done in P2: the strip names the tab's assistant (`tests/unit/renderer/session-launch.test.ts`), and the Partner Terminal and Command Targeting tips and the Feature Guide's Combined Mode card say Claude or Codex; seen on a live Codex tab (AUTHENTICATED). At the narrow window the GitHub button overlaps the strip's label on Claude and Codex tabs alike: older than P2, outside it |
| 65 | GitHub session context | PARTIAL | no | no | no | P3 | Read Codex rollouts |
| 66 | Packaged smoke | PARTIAL | n/a | n/a | partial (Win) | P4 | Per OS, on a clean machine, signed. Windows so far: the P2 upgrade walk (an unsigned candidate over the signed beta on a used test VM) |
| 67 | E2E mode matrix | PARTIAL | yes, +e2e | no | no | P2, P4 | P2: VM (WINDOWS_1) run at `21fff8bc`: 77/80; two failures in specs this branch changed (`codex-settings-section` Accounts locator, `session-dialog-permutations` Codex x SSH seed after U1), fixed test-side; re-run after the fix: 80/81, both specs and a new not-set-up guard pass, the upgrade case (`codex-reconfirm-upgrade.spec.ts`) 3/3. After the upgrade-walk fixes: 80/81 at `c6dc4b60` and again at `95385267`. One pre-existing e2e failure, reproduced on beta, is routed privately (not suppressed, not waived). P4: restart, enable/disable, a real launch |
| 68 | Insights | OWNER | no | no | no | P4 | A Conductor-native Codex report, or section 19 |
| 69 | Plan mode | OWNER | no | no | no | P3 | Evidence from the supported CLI versions |
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
