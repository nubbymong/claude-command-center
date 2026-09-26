# 2.1.1 Codex parity: release checklist

The release-wide list for 2.1.1, the Codex feature-parity release. Its gate is
zero unsupported shared Conductor features for Codex (WP1 design section 19).
**SSH Codex sessions are the only agreed exclusion.** A PR being ready never
means parity is complete. The decisions behind this list are in
`docs/wp1/owner-decisions-2026-09-20.md` and
`docs/wp1/owner-decisions-2026-09-26.md`.

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

Packages: **P2** finishes PR #625; **P3** is sessions and usage; **P4** is
agent surfaces and qualification.

## A. Accounts, identity, setup, onboarding, upgrade, Codex-only

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 1 | Provider on/off, "not set up" (no launch, review or Codex CLI run until answered), last provider on | VERIFIED | yes, +e2e | no | no | P2 | Real-CLI and packaged runs. E2E on the VM (WINDOWS_1) after the spec fixes: the not-set-up Codex card guard and Codex x SSH pass |
| 2 | CLI detect and version classes | VERIFIED | yes | no | no | P4 | Real min, pinned and max per OS (the VM has 0.142.4, below the minimum) |
| 3 | Install and update | VERIFIED | yes | no | no | P4 | One real install per OS |
| 4 | Sign-in (browser, API key) | VERIFIED | yes | no | no | P4 | Real login, status and logout per OS |
| 5 | Device-code sign-in | VERIFIED off | yes | n/a | no | P2 | None while it is off. Off in the shipped wiring (pinned: `tests/unit/main/codex-unanswered-service.test.ts`, `tests/unit/main/provider-startup-no-adoption.test.ts`); no longer advertised |
| 6 | Multiple isolated accounts | VERIFIED | yes, +VM | no | no | P4 | Real two-account run; keyring scoping |
| 7 | Identity rename, recolour, link, unlink, groups after creation | PARTIAL | no | no | no | P3 | Identity editor from every row's chip |
| 8 | One Accounts surface | PARTIAL | no | no | no | P3 | One row component for both providers |
| 9 | Launch and resume in the exact account | VERIFIED | yes, +e2e | no | no | P4 | Real launch in the realm; a restored tab keeps its account |
| 10 | Lifecycle blockers and archive | PARTIAL | no | no | no | P3 | Blocker names each consumer with Go to; Archived list with Restore |
| 11 | Staged re-authentication (WP1.52) | MISSING | no | no | no | P3 | Build it |
| 12 | Upgrade: "Do you use Codex?", and the Set up Codex page's read-only check of this computer's sign-in | VERIFIED | yes, +e2e | no | no | P2 | Done: `tests/e2e/codex-reconfirm-upgrade.spec.ts` on the VM (WINDOWS_1) at `21fff8bc`, 3/3 pass (Claude-only, Codex-only and both upgraders). Owed: a real `codex login status` run of the check and of "Use this sign-in"; the CLI's own scratch writes under `tmp/` in that folder were seen on codex 0.153.4 only (0.155.1 unverified) |
| 13 | Hello Codex, including after the upgrade Yes | VERIFIED | yes | no | no | P2 | Walk after Yes on the VM |
| 14 | Codex-only mode, no Claude noise | PARTIAL | no | no | no | P3 | Title-bar Anthropic pills, onboarding steps, showcase, Accounts panel, session dialog |
| 15 | Owner-run gates (native keyring, credential logins, packaged smoke) | MISSING | no | no | no | P4 | Hosts and timing from the owner |
| 16 | WP1 traceability | PARTIAL | n/a | n/a | n/a | P4 | Items move from planned to evidenced |

## B. Account summary, usage footer, switching, Tokenomics

Rows 17, 21 and 26 depend on UX the owner reviews before anything that
depends on it is built (the account summary, the usage footer and
Tokenomics).

| # | Feature | Status | Mocked | Real CLI | Packaged | Pkg | Still owed |
|---|---|---|---|---|---|---|---|
| 17 | All-accounts usage page | MISSING | no | no | no | P3 | Owner review of the layout first |
| 18 | Session-strip meters | PARTIAL | no | no | no | P3 | Labels from `window_minutes`; a 0.155.1 fixture |
| 19 | Strip cost wording | PARTIAL | no | no | no | P3 | Wording per provider and sign-in method |
| 20 | Account chip (strip and sidebar) | MISSING | no | no | no | P3 | Chip from the account's identity |
| 21 | Multi-account footer | MISSING | no | no | no | P3 | Owner review first; percentages never merged across providers |
| 22 | Switch the account of a running session | MISSING | no | no | no | P3 | Keep the conversation, as Claude does |
| 23 | Choose the account at launch | VERIFIED | yes | no | no | P4 | Real launch |
| 24 | Running sessions per account | PARTIAL | no | no | no | P3 | Shown on the account row |
| 25 | Tokenomics reads managed realms and `~/.codex` | VERIFIED | yes | no | no | P4 | Real rollouts |
| 26 | Tokenomics per-account attribution and filters | MISSING | no | no | no | P3 | Owner review first |
| 27 | Subagent collision fix | VERIFIED | yes | no | no | P4 | A real 0.155.1 subagent rollout |
| 28 | Codex pricing | PARTIAL | no | no | no | P3 | Every pickable model priced or shown as unknown; one price source |
| 29 | Plan type | MISSING | no | no | no | P3 | Fill the plan label |
| 30 | Tokenomics totals split by provider | PARTIAL | no | no | no | P3 | With row 26 |

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
| 54 | App knowledge, tour, tips | PARTIAL | yes | n/a | no | P2, P4 | P4: the final sweep. Done in P2 (mocked): the false tour, Memory, Status Line and device-code lines fixed |
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
| 64 | Partner terminal wording | PARTIAL | no | no | no | P3 | Use the agent's name |
| 65 | GitHub session context | PARTIAL | no | no | no | P3 | Read Codex rollouts |
| 66 | Packaged smoke | PARTIAL | n/a | n/a | no | P4 | Per OS |
| 67 | E2E mode matrix | PARTIAL | yes, +e2e | no | no | P2, P4 | P2: VM (WINDOWS_1) run at `21fff8bc`: 77/80; two failures in specs this branch changed (`codex-settings-section` Accounts locator, `session-dialog-permutations` Codex x SSH seed after U1), fixed test-side; re-run after the fix: 80/81, both specs and a new not-set-up guard pass, the upgrade case (`codex-reconfirm-upgrade.spec.ts`) 3/3. One pre-existing e2e failure, reproduced on beta, is routed privately (not suppressed, not waived). P4: restart, enable/disable, a real launch |
| 68 | Insights | OWNER | no | no | no | P4 | A Conductor-native Codex report, or section 19 |
| 69 | Plan mode | OWNER | no | no | no | P3 | Evidence from the supported CLI versions |
| 70 | Image paste | UNVERIFIED | no | no | no | P3 | Codex sees the image |
| 71 | Copy, paste, scrollback, mouse | UNVERIFIED | no | no | no | P3 | Re-captured at 0.155.1 |
| 72 | Multi Spawn and Quick Start with Codex | UNVERIFIED | no | no | no | P3 | N copies, one lease each |
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
- Codex supports STDIO and Streamable HTTP MCP servers. The Canvas and
  browser tools are to be validated through the existing Conductor MCP
  integration (rows 51, 52).
- `codex cloud exec/status/list/apply/diff` appear in the 0.153.4 help. They
  are experimental: availability and suitability still need testing (row
  57).

Limits that stay in force: the terminal-wrapper architecture is kept; this
app never parses Codex's credential files; and nothing assumes a CLI sign-in
gives ChatGPT browser cookies or an artifacts equivalent.
