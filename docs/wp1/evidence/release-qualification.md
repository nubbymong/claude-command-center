# Release qualification record

This file collects the release evidence the WP1 ledger and traceability items
cite. Section 1 is the **documentation sweep** (WP1.35, WP1.36), written with
the WP2 guidance commit (commit 7, on top of `accec3c2`,
branch `session/beta/c4d568ce-wp2-codex`, 2026-09-25). Section 3 is the
release-run record (WP1.37, WP1.73), which is **not recorded yet**: those items
stay `planned` in `tests/wp1/traceability.json` until the qualification run
fills it in. Section 4 maps the verification the 20 DONE parity rows still owe
to the check that gives it and the file it is recorded in (PR 4, P4.10).

Every statement below was checked against the code of this build before it was
written; section 2 gives the code evidence for the privacy claims.

## 1. Documentation sweep (WP1.35, WP1.36)

### What the ledger and traceability items require

| Source | Required statement |
| --- | --- |
| Ledger `README.md` (replace, WP1.35) | Stop claiming unsupported Codex account behaviour; describe provider selection. |
| Ledger `docs/USER_GUIDE.md` (replace, WP1.36) | Provider selection, account vs identity, managed vs external Codex homes, recovery. |
| Ledger `PRIVACY.md` (replace, WP1.36) | Describe managed Codex homes under the app data root. |
| Traceability WP1.35 | README, feature guide and troubleshooting stop claiming unsupported Codex account/history behaviour (evidence: `README.md`, `src/shared/app-knowledge.ts`, `docs/USER_GUIDE.md`, `PRIVACY.md`, `src/renderer/tips-library.ts`). |
| Traceability WP1.36 | User documentation explains provider selection, account vs identity, managed vs external Codex homes and recovery (evidence: `docs/USER_GUIDE.md`, `src/shared/app-knowledge.ts`, `PRIVACY.md`). |

### Where each statement is now made

| # | Statement | Where the documentation says it |
| --- | --- | --- |
| S1 | Provider selection: Claude Code and Codex are providers, turned on or off on the Providers card in Settings, Accounts, with install status, version and the install or update commands | `docs/USER_GUIDE.md` "Choosing your assistants (Claude Code and Codex)"; `src/shared/app-knowledge.ts` section `providers`; `README.md` bullet "Two assistants, one Accounts page", Getting started step 3, Requirements rows Claude Code and Codex |
| S2 | Choosing assistants at setup: "Which assistants will you use?" on a fresh install, "Use Codex only" when Claude Code is not installed, the Set up Codex page | `docs/USER_GUIDE.md` Getting started steps 1-2 and "Installing or updating Codex"; app-knowledge `providers` and `troubleshooting`; `README.md` Getting started step 3 |
| S3 | Turning a provider off and what happens to its sessions (at least one stays on; refused while in use; nothing starts; "Not started ... then Restart this tab"; the tab and conversation are kept) | `docs/USER_GUIDE.md` "Turning a provider off"; app-knowledge `providers` and `troubleshooting`; tip `tip.provider-switch`; Feature Guide card `provider-accounts` |
| S4 | Account vs identity (an account is one sign-in with one provider; an identity is the name and colour; "The same person as an existing account"; this computer's sign-in keeps its own identity; name/colour conflicts) | `docs/USER_GUIDE.md` "Codex accounts", "Account and identity"; app-knowledge `codex` (name and colour, or the same person) |
| S5 | Managed Codex homes: each Codex account's own sign-in folder, created by the app under its resources folder (`codex-realms/`); the app never reads the sign-in there | `PRIVACY.md` "What the app stores, and where" and "Codex accounts and sign-ins"; `docs/USER_GUIDE.md` "Managed Codex accounts and this computer's own sign-in"; app-knowledge `codex` and `privacy`; tip `tip.transparency.resources-folder`; `README.md` bullet "Codex accounts, each with its own sign-in" and the Account isolation row |
| S6 | External Codex home (`~/.codex`, or `CODEX_HOME` at start): checked only after the user says they use Codex, confirmed at each launch, never used for reviews, never signed in to by the app | `PRIVACY.md` "Codex accounts and sign-ins" (last bullet); `docs/USER_GUIDE.md` "Managed Codex accounts and this computer's own sign-in"; app-knowledge `codex`, `code-review` and `known-issues`; tip `tip.codex-accounts-reviewer`; Feature Guide cards `codex-provider` and `code-review`; `README.md` bullet "Codex accounts, each with its own sign-in" |
| S7 | API key: goes to Codex on stdin, never stored by the app | `PRIVACY.md` "Codex accounts and sign-ins"; `docs/USER_GUIDE.md` managed accounts; app-knowledge `codex` and `privacy`; `README.md`; Feature Guide card `codex-provider` |
| S8 | Recovery: Sign in again (same account confirmed), Check sign-in, "Needs attention: signed in a different way than before" (a change of sign-in kind, such as an API key where there was a ChatGPT sign-in) and This is still my account, `codex login` for this computer's sign-in | `docs/USER_GUIDE.md` "Sign-in recovery"; app-knowledge `codex` and `troubleshooting`; tip `tip.codex-check-sign-in`; Feature Guide card `provider-accounts` |
| S9 | Reviewer default (reviews use the reviewer default, or the default if none is set) and review in both directions | app-knowledge `codex` and `code-review`; `docs/USER_GUIDE.md` "Code review between Claude and Codex"; Feature Guide cards `codex-provider` and `code-review`; tips `tip.codex-accounts-reviewer` and `tip.review-switches`; `README.md` Conductor MCP bullet |
| S10 | Local only: Codex sessions and Codex reviews run on this computer only in this release | app-knowledge `codex`, `code-review` and `known-issues`; `docs/USER_GUIDE.md` "Choosing your assistants" and "Known issues with Codex"; Feature Guide card `codex-provider`; `README.md` remote sessions paragraph, Codex bullet and Requirements |
| S11 | No unsupported history claim: the Logs page does not index Codex conversations | app-knowledge `codex` and `pages` (replacing "history all work"); tip `tip.codex-sessions` (replacing "tabs, notes, commands, logs"); Feature Guide card `codex-provider`; `docs/USER_GUIDE.md` "Logs & transcript viewer"; `README.md` Codex bullet |
| S12 | No unsupported account claims: the retired Settings Codex tab and single-account sign-in are described nowhere; "every session the app launches is a Claude Code process" and "behind a master switch" are gone | `README.md` Getting started step 3 and Codex bullet; app-knowledge `troubleshooting`; `tests/unit/renderer/settings-codex-tab-retired.test.tsx` sweeps `src/` for the old pointer |
| S13 | Known issues with a live workaround: no Codex review while the only Codex sign-in is `~/.codex` (add a Codex account, Make reviewer); an environment API key is not used (add an account with Use an API key); no Codex over SSH | app-knowledge `known-issues`; `docs/USER_GUIDE.md` "Known issues with Codex" |

The Hello Codex statements (local only; the reviewer default; confirming an
existing sign-in at each launch) are pinned against app-knowledge and the
Feature Guide card by AC14 in `tests/unit/renderer/hello-codex.acceptance.test.ts`.

### Corrections made on the way

Two claims older than WP2 were found not to hold and were corrected where the
sweep touched them: the transcript-indexing switch in Settings, General stops
the Logs index only, not the Tokenomics index (`PRIVACY.md`, app-knowledge
`privacy`); and Codex conversations are not in Logs (S11).

### Screenshots

No images were added. Images that showed a surface this release retired, and what became of each:

| Image | Showed | Decision |
| --- | --- | --- |
| `src/renderer/assets/training/step-security.jpg`, `step-security-mac.jpg` | The Settings rail with the retired Codex tab | No longer used: the Multiple Accounts, Settings and Sentinel cards now show the neutral `v2-shell-hero.jpg`, as the two new cards do. Needs a recapture of the current Settings, Accounts page. |
| `src/renderer/assets/training/step-vision.jpg` | The Conductor MCP page, whose Codex review card still points at "Settings -> Codex" | Kept on the Conductor MCP, Agent Canvas and Canvas Explained cards. Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the page without that pointer. Its macOS variant `step-vision-mac.jpg` is not yet recaptured. |
| `docs/screenshots/settings.jpg`, `settings-mac.jpg` | A 1.5.x Settings page with the Codex tab | Referenced by nothing; nothing to remove. |
| `docs/screenshots/shot-memory.png` | The Memory page with the banner WP2 removed, and no Codex account's memories (P4.4 lists them) | Not recaptured: the README shows no Memory image, since a superseded shot beside text that contradicts it is worse than none (P4.11 review), and nothing references the file. |
| `docs/screenshots/shot-tokenomics.png` | Tokenomics without the provider and account filters and the split KPIs (the WP2 usage track) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the provider and account filters. |
| `docs/screenshots/shot-sessions.png` | The stacked sidebar and separate tools row the 2.1 two-mode panel and one-row bar replaced (superseded before WP2) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the current sidebar, with a Codex account beside the Claude accounts. |
| `docs/screenshots/shot-canvas.png` | The canvas before its review rework, with per-note Approve and Re-annotate (superseded before WP2) | Recaptured on the 2.1.1-beta.2 candidate and approved by the owner on 2026-10-07: it shows the current review. |

Corrected in P4.11: an earlier version of this record said none of the seven
README images showed a surface WP2 changed. Four do, listed above. The other
three (`hero-banner.png`, `shot-logs.png`, `shot-insights.png`) show the
stacked sidebar the 2.1 two-mode panel replaced, and the Insights account picker now
lists Codex accounts too (P4.7), so they were due a recapture as well. Corrected
again before the 2.1.1-beta.2 cut: the four rows above said the images had
been recaptured at the final head; they had not. The six README images and
the four Feature Guide images (`v2-shell-hero.jpg`, `step-session-options.jpg`,
`step-tokenomics.jpg`, `step-vision.jpg`) were then recaptured on the
2.1.1-beta.2 candidate and approved by the owner on 2026-10-07. Their macOS
variants `step-session-options-mac.jpg`, `step-tokenomics-mac.jpg` and
`step-vision-mac.jpg` are not yet recaptured and remain owed, on a Mac.

For the recapture (the VM for Windows and the Mac for macOS, never the owner's
machine): the capture tool runs the app on a home of its own inside its
throwaway data root (P4.11). It still has to seed Codex on with fictional
Claude and Codex accounts and open the Accounts tab for the Settings shot, and
its host safety is checked again with Codex on, a resources path with a space
on Windows included.

## 2. Code evidence for the privacy claims

| Claim (`PRIVACY.md`) | Code |
| --- | --- |
| A managed Codex home is `<resources>/codex-realms/<realmId>` | `src/main/providers/codex/realm-paths.ts:5`, `:19` |
| The folder is created before any sign-in | `src/main/providers/core/accounts-service.ts:705` (setup prepares the folder first); `src/main/providers/codex/realm-folders.ts:408-429` |
| The app never opens the sign-in file; it only checks whether it exists before removing an abandoned setup's folder | `src/main/providers/codex/auth-operations.ts:5-6`; `src/main/providers/codex/realm-folders.ts:311`, `:375-376`, `:503-505`; enforced by `tests/wp1/legacy-codex-retired.test.ts` |
| Sign-in state comes from `codex login status`: signed in with ChatGPT or an API key, no email or token | `src/main/providers/codex/cli-contract.ts:51-66` |
| The API key reaches Codex only on stdin, from a single-use handle; never logged; dropped after 120 s | `src/main/providers/codex/cli-runner.ts:38-39`, `:583-585`; `src/main/providers/codex/auth-operations.ts:371-385`, `:409`; `src/main/providers/core/secret-handles.ts:1-19`, `:24`, `:97` |
| `~/.codex` is checked only after the user says they use Codex | `src/main/providers/core/accounts-service.ts:1542-1543` (the check and the adoption are refused, before anything is reserved, until Codex is answered on), `:1625-1630` (the check keeps nothing: the app writes no record, and nothing in that folder; the Codex CLI keeps its own scratch files there, under `tmp/`, as it does on every run), `:1676-1684` with `src/main/provider-accounts.ts:113` (nothing is taken in at start; a check an earlier run left is dropped); `src/renderer/onboarding/CodexSetupStep.tsx:336-337` (the Set up Codex page asks only once Codex is answered on) |
| A launch on `~/.codex` needs that launch's confirmation | `src/main/providers/core/accounts-service.ts:1854-1857` |
| `~/.codex` never runs a review | `src/main/providers/core/accounts-service.ts:1774` |
| The app never signs in to `~/.codex`; signing out of it needs a confirmation | `src/main/providers/codex/auth-operations.ts:392`; `src/main/providers/core/accounts-service.ts:1219` |
| Codex transcripts in `~/.codex` and in each account's folder feed Tokenomics | `src/main/tokenomics/tokenomics-service.ts:31`, `:88`, `:97` |
| The app removes an entry older versions added to Codex's `config.toml`, at tool-server start and stop | `src/main/providers/codex/mcp-config.ts:25-27`, `:85-105`; `src/main/conductor-mcp-server.ts:1615`, `:1630` |
| Version discovery runs in a throwaway home, never `~/.codex` | `src/main/providers/codex/discovery.ts:12-15` |
| An environment API key is left out of every Codex launch (known issue) | `src/main/providers/codex/index.ts:177-181` |
| The transcript switch stops the Logs index only | `src/main/logging/logging-service.ts:52-53`; `src/main/index.ts:828` (Tokenomics starts unconditionally) |
| Needs attention (S8) is a change in the kind of sign-in (ChatGPT or device code vs API key), not a different person: a check passes no subject, and Codex status reports none; Claude has no status check in this build | `src/main/providers/core/accounts-service.ts:1183-1186`; `src/shared/providers/registry.ts:267-271`, `:730`; `src/main/providers/codex/index.ts:132`; `src/main/providers/claude/index.ts:132` |

## 3. Release-run record (WP1.37, WP1.73)

Not recorded yet. The qualification run records here the tested commit, the
Claude Code and Codex CLI versions, the OS runners, the commands, the scope of
the real-CLI smoke and the known limitations. Until then WP1.37 and WP1.73
stay `planned`, and the e2e mode matrix lives in its own record
(`docs/wp1/evidence/mode-matrix.md`, from the VM run).

Before the run is planned (completion plan section 7, "The WP1 candidate at a
stable release"): only a stable release that is not a dry run declares the
WP1 candidate from the workflow, so the beta-channel cut runs at the
manifest's phase; and since `package.json` and `changelog.ts` are not
neutral paths, the final `2.1.1` version and changelog entry land before the
signed cut whose build carries the WP1.63 smoke, the evidence is taken at that
head, a manifest-only commit declares the candidate, and the same tree is
promoted. A bump after the signed cut can never pass the binding.

## 4. Verification owed by the 20 DONE rows (PR 4, P4.10)

20 of the 52 DONE parity rows (75 rows in all; of the other DONE rows, 27 owe
PR 3's VM checks and 5 owe nothing) have an automated test on the Codex path
and owe only real-CLI, per-OS or packaged verification
(`docs/wp2/completion-plan.md` section 2): rows 1, 2, 3, 4, 6, 9, 12, 13, 18,
21, 23, 25, 27, 29, 33, 48, 49, 50, 64 and 74. PR 4 records their Windows
column, and OR1 records rows 4 and 6 on macOS and Linux as well; the other
rows' macOS and Linux columns and the signed packaged build close at release.
This section is the map, not the evidence: every check below is still owed,
and each is run on PR 4's final head (P4.10 runs last) and recorded in the file
named.

Who runs each check:

- **VM agent**: the Windows test VM, no real sign-in: throwaway Codex homes
  signed in with a fake key behind a dead proxy, the loopback fake model or
  the stand-in Claude, the real Codex 0.153.4 and 0.155.1, under the VM rules
  of plan 9.2 (nothing typed into a composer that is not ready; the sandbox
  menu answered only on a verified "2." row; `config.toml` hashed before and
  after every writable step; the VM user's own `~/.codex` never started or
  written).
- **OR1**: the owner, on real accounts on the owner's hosts, one per OS
  (Windows, macOS, and Linux Ubuntu 24.04 or newer), with two disposable
  ChatGPT identities and a throwaway OpenAI API key, on PR 4's final build.
  These checks block merging PR 4, not building it (OD20 D8; plan 9.5).
- **OR4**: the owner, with a working model.
- **Release**: nothing owed on Windows; the row closes at release.

Where each check is recorded:

- `docs/wp1/evidence/real-cli-matrix.md` (P4.10 writes it; cited by WP1.2,
  WP1.10, WP1.20, WP1.32, WP1.64, WP1.71), in two parts: the item part, for
  the checks a citing item claims (rows 2, 3, 4, 6, 9, 25, 33 and 49), and the
  no-item part, for the checks no citing item claims (rows 1, 12, 13, 18, 21,
  23, 27, 29, 48, 50, 64 and 74). Each entry gives the CLI version and route,
  the actor and the commands.
  The WP1 items column below names the items a row relates to; an item's
  evidence record covers a check only where the item cites the file.
- `docs/wp1/evidence/keyring-smoke.md` (P4.10, OR1; WP1.11, WP1.72).
- `docs/wp1/evidence/packaged-smoke.md` (P4.10, from the owner's packaged smoke
  of the PR 4 build; WP1.63 stays `planned` until the signed release run).
- `docs/wp1/evidence/ci-matrix.md` and `mode-matrix.md` (lane E, P4.8 and
  P4.9).
- Every evidence file names the full 40-hex head its checks ran on, and its
  record in `tests/wp1/traceability.json` gives the same head, which must be
  the binding's `boundHead` (`tests/wp1/traceability.test.ts`).
- The result also goes on the row itself, in `docs/wp2/parity-checklist.md`
  and section 4 of the completion plan (the integration owner).

| Row | Feature | Check owed in PR 4 (Windows unless an OS is named) | Who | Recorded in | WP1 items | Left for release |
|---|---|---|---|---|---|---|
| 1 | Provider on/off, "not set up", last provider on | With the real CLI at 0.153.4 and 0.155.1: an unanswered Codex starts nothing; Codex off refuses its configs and restored tabs with the off wording; the last provider on cannot be turned off | VM agent | `real-cli-matrix.md` (no-item part); the fake-CLI e2e side in `mode-matrix.md` (P4.9) | WP1.1, WP1.3, WP1.6, WP1.7, WP1.60 | Packaged on a clean machine per OS (`packaged-smoke.md`, WP1.63); macOS, Linux |
| 2 | CLI detect and version classes | The minimum 0.153.4 and the pinned 0.155.1 detected and classed on both install routes (the `codex.exe` each npm install ships, and its `.cmd` shim); per OS also from P4.8's real-CLI job | VM agent; CI (P4.8) | `real-cli-matrix.md`; `ci-matrix.md` | WP1.17, WP1.44, WP1.49, WP1.71 (minimum and pinned) | The release-candidate CLI (WP1.71); macOS, Linux |
| 3 | Install and update | None on Windows (the 2026-09-26 upgrade walk ran the npm install and the npm update there) | Release | `real-cli-matrix.md`, at release | WP1.18, WP1.19, WP1.32 | One real install per OS on macOS and Linux; Homebrew unrun |
| 4 | Sign-in (browser, API key) | On Windows, macOS and Linux: a real sign-in with a disposable ChatGPT identity and with the API key, status and sign-out, on a managed account (the owner's browser sign-in on Windows, 0.157.1, predates the final build) | OR1 | `real-cli-matrix.md` | WP1.20, WP1.22, WP1.23, WP1.64 | None: OR1 closes every OS before merge |
| 6 | Multiple isolated accounts | On Windows, macOS and Linux: a real two-account run (each disposable identity signs in to its own folder, and status and sign-out of one leave the other untouched) and the native keyring smoke on that OS's own credential store | OR1 | `real-cli-matrix.md` (WP1.10); `keyring-smoke.md` (WP1.11, WP1.72) | WP1.10, WP1.11, WP1.72 | None: OR1 closes every OS before merge |
| 9 | Launch and resume in the exact account | A tab restored after a relaunch keeps its managed account and resumes in that account's folder, on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` | WP1.2, WP1.38, WP1.42 | macOS, Linux |
| 12 | Upgrade question and the read-only sign-in check | The check of this computer's sign-in (a throwaway `CODEX_HOME` standing in for `~/.codex`) and "Use this sign-in" on 0.153.4 and 0.155.1, with the CLI's own scratch writes under `tmp/` recorded on 0.155.1 | VM agent | `real-cli-matrix.md` (no-item part) | WP1.5, WP1.43 | macOS, Linux; the upgrade walk again on the signed release candidate |
| 13 | Hello Codex | On the final build (P4.1 and P4.2 change its copy): shown after Set up Codex once a managed account is signed in, marked seen, not shown on relaunch, replayed from Accounts and from the Feature Guide | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none (HCS; `hello-codex.acceptance.test.ts`) | macOS, Linux |
| 18 | Session-strip meters | A 0.155.1 rollout fixture taken from a real session (OD27 M3), and a real-CLI run with a working model | OR4 | `real-cli-matrix.md` (no-item part); the fixture beside the strip's tests | none | macOS, Linux |
| 21 | Multi-account footer | Two managed accounts live at once on the packaged PR 4 build with the real CLI, the fake model sending usage headers: one pill per identity, grouped by provider | VM agent | `real-cli-matrix.md` (no-item part) | none | Packaged on macOS and Linux |
| 23 | Choose the account at launch | The new-config picker on a managed account (no confirmation) and on this computer's sign-in (a throwaway `CODEX_HOME`; the per-launch confirmation), on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` (no-item part) | WP1.38, WP1.42 | macOS, Linux |
| 25 | Tokenomics reads managed realms and `~/.codex` | Real rollouts copied read-only from the VM user's `~/.codex/sessions` into a throwaway home (no Codex started there), indexed beside a managed realm's fake-model rollouts, each turn priced once | VM agent | `real-cli-matrix.md` | WP1.2 (`tokenomics-realm-discovery.test.ts`) | macOS, Linux |
| 27 | Subagent collision | A 0.155.1 subagent rollout indexed without a collision (the #307 fix, `7fc96639`), if the fake model can drive a subagent; otherwise from a real session | VM agent, else OR4 | `real-cli-matrix.md` (no-item part) | none | macOS, Linux |
| 29 | Plan type | None on Windows (the MP8 VM walk showed the plan on 0.153.4 and 0.155.1) | Release | `real-cli-matrix.md` (no-item part), at release | none | macOS, Linux, packaged |
| 33 | Resume in the exact realm | Two managed accounts with a conversation each: the second account's picker never lists the first's, on 0.153.4 and 0.155.1 | VM agent | `real-cli-matrix.md` | WP1.2, WP1.38 | macOS, Linux |
| 48 | Conductor MCP transport | A live 0.155.1 tool listing of the Conductor MCP server through Codex's tool search, on the final build (P4.1 and P4.2 add tools) | VM agent | `real-cli-matrix.md` (no-item part) | none (WP1.68's per-spawn MCP outcome is evidenced by the ledger) | macOS, Linux |
| 49 | `codex_review` | A real run on a signed-in account with a working model | OR4 | `real-cli-matrix.md` (WP1.64) | WP1.64 | macOS, Linux |
| 50 | `claude_review` | A live wait past 300 s, with the stand-in Claude if it can hold a review that long; otherwise a real one | VM agent, else OR4 | `real-cli-matrix.md` (no-item part) | none | macOS, Linux |
| 64 | Partner terminal wording | On a live Codex tab (real CLI) and a Claude tab (the stand-in Claude), the strip names the tab's assistant; at a narrow window the label clears the floating GitHub button (P3.7's fix, `b1cffc71`) | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none | macOS, Linux |
| 74 | Command buttons, preset pill, restart menu, theme | The real-CLI pass on 0.153.4 and 0.155.1: a command button's text reaches Codex, the preset pill, Restart and Restart and pick a conversation, light and dark themes | VM agent | `real-cli-matrix.md` (no-item part); the owner's screenshot review | none | macOS, Linux |

Counts: VM agent 12 rows (1, 2, 9, 12, 13, 21, 23, 25, 33, 48, 64, 74), and
rows 27 and 50 when the fake model can make their evidence; OR1 2 rows (4, 6),
on every OS; OR4 2 rows (18, 49), and rows 27 and 50 otherwise; nothing on
Windows for 2 rows (3, 29). The items only the release can evidence stay
`planned` with that reason: the signed packaged smoke (row 66, WP1.63), the
release-candidate CLI (WP1.71) and this file's section 3 (WP1.37).
