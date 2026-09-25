# Release qualification record

This file collects the release evidence the WP1 ledger and traceability items
cite. Section 1 is the **documentation sweep** (WP1.35, WP1.36), written with
the WP2 guidance commit (commit 7, on top of `accec3c2`,
branch `session/beta/c4d568ce-wp2-codex`, 2026-09-25). Section 3 is the
release-run record (WP1.37, WP1.73), which is **not recorded yet**: those items
stay `planned` in `tests/wp1/traceability.json` until the qualification run
fills it in.

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

No images were added. Images that show a surface this release retired, all due a recapture:

| Image | Shows | Decision |
| --- | --- | --- |
| `src/renderer/assets/training/step-security.jpg`, `step-security-mac.jpg` | The Settings rail with the retired Codex tab | No longer used: the Multiple Accounts, Settings and Sentinel cards now show the neutral `v2-shell-hero.jpg`, as the two new cards do. Needs a recapture of the current Settings, Accounts page. |
| `src/renderer/assets/training/step-vision.jpg` | The Conductor MCP page, whose Codex review card still points at "Settings -> Codex" | Kept on the Conductor MCP, Agent Canvas and Canvas Explained cards (a card must name an existing asset). Needs a recapture. |
| `docs/screenshots/settings.jpg`, `settings-mac.jpg` | A 1.5.x Settings page with the Codex tab | Referenced by nothing; nothing to remove. |

None of the seven README images (`hero-banner.png`, `shot-sessions.png`,
`shot-canvas.png`, `shot-tokenomics.png`, `shot-logs.png`, `shot-memory.png`,
`shot-insights.png`) shows a surface WP2 changed, so all references stay.

## 2. Code evidence for the privacy claims

| Claim (`PRIVACY.md`) | Code |
| --- | --- |
| A managed Codex home is `<resources>/codex-realms/<realmId>` | `src/main/providers/codex/realm-paths.ts:5`, `:19` |
| The folder is created before any sign-in | `src/main/providers/core/accounts-service.ts:604` (setup prepares the folder first); `src/main/providers/codex/realm-folders.ts:408-429` |
| The app never opens the sign-in file; it only checks whether it exists before removing an abandoned setup's folder | `src/main/providers/codex/auth-operations.ts:5-6`; `src/main/providers/codex/realm-folders.ts:311`, `:375-376`, `:503-505`; enforced by `tests/wp1/legacy-codex-retired.test.ts` |
| Sign-in state comes from `codex login status`: signed in with ChatGPT or an API key, no email or token | `src/main/providers/codex/cli-contract.ts:51-66` |
| The API key reaches Codex only on stdin, from a single-use handle; never logged; dropped after 120 s | `src/main/providers/codex/cli-runner.ts:38-39`, `:583-585`; `src/main/providers/codex/auth-operations.ts:367-381`, `:405`; `src/main/providers/core/secret-handles.ts:1-19`, `:24`, `:97` |
| `~/.codex` is checked only after the user says they use Codex | `src/main/providers/core/external-default-migration.ts:18-19`, `:200-206` |
| A launch on `~/.codex` needs that launch's confirmation | `src/main/providers/core/accounts-service.ts:1628-1631` |
| `~/.codex` never runs a review | `src/main/providers/core/accounts-service.ts:1552` |
| The app never signs in to `~/.codex`; signing out of it needs a confirmation | `src/main/providers/codex/auth-operations.ts:388`; `src/main/providers/core/accounts-service.ts:1099` |
| Codex transcripts in `~/.codex` and in each account's folder feed Tokenomics | `src/main/tokenomics/tokenomics-service.ts:31`, `:88`, `:97` |
| The app removes an entry older versions added to Codex's `config.toml`, at tool-server start and stop | `src/main/providers/codex/mcp-config.ts:25-27`, `:85-105`; `src/main/conductor-mcp-server.ts:1612`, `:1627` |
| Version discovery runs in a throwaway home, never `~/.codex` | `src/main/providers/codex/discovery.ts:12-15` |
| An environment API key is left out of every Codex launch (known issue) | `src/main/providers/codex/index.ts:168-172` |
| The transcript switch stops the Logs index only | `src/main/logging/logging-service.ts:52-53`; `src/main/index.ts:826` (Tokenomics starts unconditionally) |
| Needs attention (S8) is a change in the kind of sign-in (ChatGPT or device code vs API key), not a different person: a check passes no subject, and Codex status reports none; Claude has no status check in this build | `src/main/providers/core/accounts-service.ts:1064-1066`; `src/shared/providers/registry.ts:267-271`, `:730`; `src/main/providers/codex/index.ts:123`; `src/main/providers/claude/index.ts:132` |

## 3. Release-run record (WP1.37, WP1.73)

Not recorded yet. The qualification run records here the tested commit, the
Claude Code and Codex CLI versions, the OS runners, the commands, the scope of
the real-CLI smoke and the known limitations. Until then WP1.37 and WP1.73
stay `planned`, and the e2e mode matrix lives in its own record
(`docs/wp1/evidence/mode-matrix.md`, from the VM run).
