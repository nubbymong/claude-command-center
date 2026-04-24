# Account Rework + Pre-Launch Picker — Design Spec

**Status:** Draft · 2026-04-23
**Author:** nubbymong (co-authored with Claude)
**Supersedes:** current `src/main/account-manager.ts` behaviour documented inline below.
**Related:**
- `docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md` (reverse-tunnel model reused for push-to-remote)
- `docs/superpowers/specs/2026-04-23-ssh-session-redesign.md` (depends on the per-host account tracking fields added here)

## Summary

Replace the `"Pro 8a2f3b1c"` fingerprint label on the account chip with real human metadata (`displayName`, `emailAddress`, `organizationName`) sourced from `~/.claude.json`'s `oauthAccount` object. Add a **pre-launch account picker** that appears before launching any session, so every session is tied to an explicit account choice. When the picker's choice differs from the currently-active account, **save every running session's state, swap credentials globally, then restore the sessions** so no work is lost. For SSH hosts, **track which local account was last used per host** and surface a one-click **"Push these credentials to the remote"** action — never silent, always user-confirmed per host.

The MVP ships a real account vocabulary and an honest pre-launch story. It does NOT automate credential propagation across machines; the push-to-remote action is opt-in and explicit for every host, every time the user wants it to happen.

## Why

- The current chip says `Pro 8a2f3b1c`. Users can't tell their two Max accounts apart without clicking. The hash fingerprint exists because we never read the authoritative metadata.
- `~/.claude.json` has had a fully-populated `oauthAccount` key for months: `emailAddress`, `displayName`, `organizationName`, `organizationRole`, `accountUuid`, `billingType`, `subscriptionCreatedAt`. This is the authoritative source.
- Account switching today is a bulk kill — `gracefulExitAllPty(5000)` ends every running session, dropping the user's in-progress work. For a multi-session orchestrator this is a violation of the product's core promise.
- SSH hosts have their own credentials (a remote `~/.claude/.credentials.json` installed by the user in some prior session). We have no record of which *local* account that remote belonged to, so a local swap silently mismatches when you next open that SSH config.
- Opening a session without a picker means the user doesn't find out about an account mismatch until Claude Code prompts for login inside the terminal, which is bad UX and sometimes corrupts transcripts.

## Non-goals

- **Not synchronising credentials across machines.** We do not build a credential sync service. Every machine's account state is local, and crossing the boundary (SSH) is always user-initiated.
- **Not managing more than a handful of accounts.** The app is designed for 1–4 local Max accounts, not enterprise identity federation. Support up to 8 before surfacing a UI guard rail; beyond that the picker needs pagination, which is out of scope.
- **Not enforcing account policy per workspace.** We surface the user's chosen account per session, but we don't enforce that a given repo is "always Account X".
- **Not removing the primary/secondary slot model** outright. It stays as a convenience shortcut in the TitleBar. The new model adds more accounts; it doesn't break the two-slot concept.
- **Not auditing historical sessions for mismatches.** Existing `savedSessions` don't carry an `accountId` retroactively; we infer "current account" on load for them and move on.

## User experience

### The account chip today and after

**Before**

```
┌─ Title bar ───────────────────────────────────────────────┐
│ Claude Command Center            [ Pro 8a2f3b1c ▾ ]   − ▢ × │
└──────────────────────────────────────────────────────────────┘
```

Clicking opens a small menu with "Primary" and "Secondary" text rows. No email. No plan detail.

**After**

```
┌─ Title bar ───────────────────────────────────────────────────────────────┐
│ Claude Command Center       [ Nicholas Moger · nicholas.moger@me.com ▾ ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Primary label: `displayName` (fallback `emailAddress`, fallback `savedLabel`, fallback slot id).
- Secondary line inside the dropdown: `emailAddress` + `organizationName` + `billingType` + a small fingerprint pill (last-4 of `accountUuid`) for disambiguation.
- Each row shows a "Last active" relative time on the right.

Dropdown rows:

```
● Nicholas Moger
  nicholas.moger@me.com · Max · Personal        active · now
  [ Rename ] [ Save credentials here as… ]

○ Work account
  nick@company.com · Pro · Acme                  7d ago
  [ Rename ] [ Switch to this account ]

＋  Save current credentials as a new account…
⚙  Manage hosts (SSH accounts per host)
```

### Pre-launch account picker

A new modal appears **before** a session spawns. It's shown even for single-account users (they get a one-row picker with a "don't ask again for this config" checkbox, which opts this session config into the silent-default flow on future launches).

Mockup:

```
┌─ Launch "docs repo on Asustor" with… ──────────────────────────────────────┐
│                                                                             │
│  Local account for this session                                             │
│  ● Nicholas Moger — Personal (active)                       [ default ✓ ]   │
│  ○ Work — Acme                                              [ last: 7d ]    │
│                                                                             │
│  Remote target (SSH)                                                        │
│  Last opened with: Work — Acme  (3d ago)                                    │
│  ⚠ Mismatch: your local active account would be used on the remote unless    │
│     you push these credentials first.                                       │
│    [ Push "Nicholas Moger" credentials to Asustor ]                         │
│    [ Continue anyway ]                                                      │
│                                                                             │
│  Resume                                                                     │
│  ● Resume "refactor-auth" (started 14:02 today)                             │
│  ○ Fresh start                                                              │
│                                                                             │
│  [ Don't ask again for this config ]  [ Cancel ]       [ Launch session ]   │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Local account row**: shows what's active. If the user picks a different account, the launch button's label changes to `Swap + Launch session` and a caption explains the save-and-restore flow that will kick off.
- **Remote target row** (SSH only): reads `hostLastAccountIdUsed[hostSlug]` from `accounts.json`. Shows one of three states:
  - **match**: silent, no warning.
  - **mismatch known**: warns + offers push action.
  - **first time**: silent, shows "This remote has no record yet." Opens anyway; first success-response from the SSH session stamps `hostLastAccountIdUsed`.
- **Resume row**: mirrors the existing in-terminal resume-picker options so users can complete all the pre-launch decisions in one modal.
- **Don't ask again**: writes `sessionConfig.accountPicker.skipUntilNextMismatch = true`. The modal skips on subsequent launches of this exact session config, UNTIL the config's last-used account no longer matches the currently-active account — at which point the modal re-surfaces once to confirm.

### Save-and-restore flow around a swap

Triggered when the picker (or the TitleBar chip) selects an account different from `lastActiveId`. The executor holds a module-level `inFlight: Promise<SwapResult> | null`; a second call while one is active returns the same promise (the renderer is then driven by `ACCOUNT_SWAP_PROGRESS` events regardless of who initiated). `accountStore.swapState: 'idle' | 'snapshotting' | 'soft-stopping' | 'writing-creds' | 'restoring' | 'error'` is exposed so the TitleBar chip disables itself during non-idle phases.

Fixes B3 (concurrent swaps), B4 (new-launch race), B5 (renderer flush), B1 (credential-file race):

1. **Snapshot request (two-phase with renderer ACK)**:
   - Main emits `ACCOUNT_SWAP_PROGRESS { phase: 'snapshotRequested' }`.
   - Renderer flushes any pending debounced writes, serialises open-session state (including transcript-watcher offsets), writes `session-state.json`, then emits `ACCOUNT_SWAP_SNAPSHOT_READY`.
   - Main waits up to 2s for the ACK. On timeout, proceeds with the on-disk state and logs a `swap.snapshot.stale` warning.
   - Persist `pendingAccountSwap = { fromId, toId, startedAt }` in `accounts.json`.
2. **Pre-swap soft-stop**:
   - For each running PTY: send `\x03` + wait 500ms; escalate to SIGTERM; final fallback `gracefulExitAllPty(5000)`.
3. **Credential overwrite (exclusive lock)**:
   - Acquire `~/.claude/.claude-swap.lock` via `fs.openSync(..., 'wx')` retry-once-with-200ms-backoff. Lock is on a CCC-owned path, not `~/.claude.json` itself — external `claude` processes don't know about the lock and can still rewrite the file; we accept that as out-of-scope (any `oauthAccount` they wrote is picked up on next read).
   - Write `~/.claude/.credentials.json` atomically: `fs.writeFileSync(tmp, creds, { mode: 0o600 })` + `fs.renameSync(tmp, target)`.
   - Merge `oauthAccount` into `~/.claude.json` via the same tmp+rename dance. Preserve unknown keys.
   - Clear `<tmpdir>/claude-command-center-usage-cache.json`.
   - Release the lock.
   - If lock acquisition fails both attempts: abort, preserve `pendingAccountSwap`, surface error — user retries.
4. **Restore (single-writer)**:
   - Main re-hydrates from `session-state.json`, re-spawns PTYs through the usual path. SSH sessions reconnect with the same `sshConfig`; if `hostAccountHistory[hostSlug]` now differs from the active account, the in-session header shows a small banner offering the push-credentials action.
   - Renderer tracks `sessionStore.restorePhase` and blocks any new-launch IPC until it resolves. The `AccountPicker` launch button shows "Restoring sessions..." while this runs.
   - Clear `pendingAccountSwap`.
5. **Crash recovery (auto-resume, no blocking modal)**:
   - On boot, if `pendingAccountSwap` is set AND `session-state.json` exists, we automatically resume the swap and surface a non-blocking toast ("Resumed interrupted account swap to <Name>"). If resume itself fails, restore the pre-swap credentials (we still have them in `accounts.json`) and surface an error toast. The previous design proposed a blocking modal; cut in favour of auto-resume to reduce boot-time UX surface.

### SSH host account tracking

Stored in `accounts.json` under a new `hostAccountHistory` map:

```ts
interface HostAccountRecord {
  hostSlug: string               // stable key: `${username}@${host}:${port}`
  lastAccountIdUsed: string      // account.profile.id
  firstSeenAt: number
  lastSeenAt: number
  firstSeenWithAccountId?: string // for audit/debug only
}

// accounts.json schema additions:
interface AccountsData {
  accounts: StoredAccount[]
  lastActiveId?: string
  hostAccountHistory?: Record<string, HostAccountRecord>  // NEW
  pendingAccountSwap?: {                                   // NEW
    fromId: string
    toId: string
    startedAt: number
  }
}
```

The map is stamped on two events:
- **Successful SSH connect**: pty-manager's SSH flow, after the first OSC sentinel arrives from the statusline shim (proof that the remote Claude Code is reachable under the current credentials), calls `accountManager.recordHostAccount(hostSlug, activeAccountId)`.
- **Explicit push-credentials action**: stamps the mapping to the account the user just pushed.

`hostSlug` is derived from the `SshConfig` by `${username}@${host}:${port}`, lowercased. Collisions with whitespace or case variants are handled by normalising at write time.

### Push credentials to remote (opt-in)

Accessible from two places:

1. **Pre-launch picker** when a mismatch is detected (see UX mockup above).
2. **TitleBar → Manage hosts** submenu, which lists every known `hostAccountHistory` entry with a kebab menu: rename slug, reset mapping, push current account now, open last-used session.

Flow when the user clicks **"Push … credentials to Asustor"**:

1. Confirmation dialog explicitly names:
   - The source account (displayName + emailAddress).
   - The destination host (hostSlug, SSH alias if any).
   - A bullet list of what gets written remotely:
     - `~/.claude/.credentials.json` replaced with the source account's credentials.
     - `~/.claude.json` `oauthAccount` slice merged in (keeping other keys intact).
   - A checkbox: `[ ] Also stamp this host as belonging to "Nicholas Moger" so we don't ask again.` Default ON.
2. If confirmed, a short-lived SSH connection (no PTY, just `ssh user@host -- <remote-cmd>`) runs a one-shot script that:
   - Writes `~/.claude/.credentials.json` from stdin (we pipe the decrypted JSON over stdin; never on the command line).
   - Reads `~/.claude.json`, merges `oauthAccount`, writes back.
   - Emits a marker sentinel on success (`CCC_PUSH_OK`) so we can verify.
3. The script runs with `umask 077` first so the resulting files are `0600`.
4. We do NOT store the source credentials anywhere on the remote beyond those two files.
5. On success, `recordHostAccount(hostSlug, sourceAccountId)` stamps the mapping.
6. On failure, surface stderr inline in the push dialog. Do not retry automatically; the user decides.

**Security posture**: the user explicitly clicks on a per-host basis. We reuse the confirmed-dialog-per-destination pattern already established by the vision MCP reverse-tunnel. No silent propagation ever. We do not cache "remote thinks it has these credentials" client-side — every push is authoritative overwrite.

### TitleBar chip refresh

The chip is now a two-state button:

- Collapsed (default): shows `displayName`.
- Opened (dropdown): shows the rich row format above.

If `oauthAccount` is missing (credentials don't have it populated yet — possible for older installs or a partial login), the chip falls back to `emailAddress`, then `savedLabel`, then the legacy `"${sub} ${fp}"` format. We never show the fingerprint alone; it's only ever a disambiguation pill inside the dropdown.

### Rename + profile edit

The rename path is unchanged mechanically (in-memory label edit via `renameAccount`). Visually the affordance is clearer: a pencil icon on each dropdown row. We also surface an "Always ignore `oauthAccount.displayName` and use my custom label" toggle per account — default off. If on, future auto-refreshes of the label don't overwrite the user's choice.

## Architecture

### Data model

```ts
// src/shared/types.ts — AccountProfile grows

export interface OAuthAccountSnapshot {
  emailAddress?: string
  displayName?: string
  organizationName?: string
  organizationRole?: string
  accountUuid?: string
  billingType?: string
  subscriptionCreatedAt?: string
  hasExtraUsageEnabled?: boolean
}

export interface AccountProfile {
  id: string                          // was 'primary' | 'secondary' — now opaque string ID (keep 'primary' / 'secondary' as reserved slot names)
  label: string                       // user-editable display label (overrides if useCustomLabel is true)
  savedAt: number
  lastUsedAt?: number                 // bumped every time this account is set as active
  oauthAccount?: OAuthAccountSnapshot // NEW — cached from the credentials write
  subscriptionType?: string           // 'pro' | 'max' | 'enterprise' | string  — from claudeAiOauth.subscriptionType
  rateLimitTier?: string              // from claudeAiOauth.rateLimitTier
  fingerprintShort?: string           // NEW — short SHA-256 slug of accountUuid (for disambiguation)
  useCustomLabel?: boolean            // NEW — if true, don't overwrite label from oauthAccount on refresh
}
```

`id` becomes an opaque string, not a discriminated union. We'll keep the two-slot TitleBar behaviour by reserving `primary` and `secondary` names for the slot-swap path. New accounts get an id of the form `acct-<uuid>` to make collisions impossible.

### Main-side additions

| File | Purpose | Change |
|------|---------|--------|
| `src/main/account-manager.ts` | Credential + label store | Extend: `OAuthAccountSnapshot` capture at `initAccounts` / `saveCurrentAs` / `switchAccount`; `recordHostAccount`; `getHostAccountHistory`; `pushCredentialsToRemote`; `runSaveRestoreSwap`. |
| `src/main/account-oauth-reader.ts` (new) | Read `~/.claude.json` and extract `oauthAccount` | Pure function `readOauthAccount(): OAuthAccountSnapshot \| null` with file-missing handling. |
| `src/main/account-swap-executor.ts` (new) | Orchestrate save-and-restore around switch | `runSaveRestoreSwap(targetId): Promise<SwapResult>` — handles pending-swap state, saveSessionState, soft-kill, write-credentials, restore. |
| `src/main/account-remote-push.ts` (new) | SSH push-credentials executor | `pushCredentialsToHost(accountId, sshConfig): Promise<PushResult>` — spawns a short-lived SSH command with remote one-shot script, pipes credentials over stdin, verifies marker. |
| `src/main/account-json-merger.ts` (new) | Merge `oauthAccount` into `~/.claude.json` safely | Pure function, idempotent, preserves unknown keys; used both locally (switch) and remotely (via the push script). |
| `src/main/ipc/account-handlers.ts` | IPC surface | Add handlers for host history, remote push, save-restore swap, oauthAccount refresh. |

### Renderer additions

| File | Purpose |
|------|---------|
| `src/renderer/components/account/AccountPicker.tsx` (new) | The pre-launch modal. |
| `src/renderer/components/account/ManageHosts.tsx` (new) | Host history list + per-host kebab actions. |
| `src/renderer/components/TitleBar.tsx` (modify) | New chip label + dropdown content. |
| `src/renderer/stores/accountStore.ts` (new, small) | Hydrates from IPC, exposes active / list / host history / swap progress / push progress. |
| `src/renderer/lib/session-launch-flow.ts` (new) | Orchestrates "open picker, handle resolved config, call sessionStore.launch" — single entry point all launch surfaces use. |

### IPC additions

```ts
// src/shared/ipc-channels.ts — under ACCOUNT section
ACCOUNT_GET_OAUTH_SNAPSHOT: 'account:getOauthSnapshot',           // refresh from ~/.claude.json
ACCOUNT_HOST_HISTORY_GET: 'account:host:get',                     // Record<hostSlug, HostAccountRecord>
ACCOUNT_HOST_HISTORY_RESET: 'account:host:reset',                 // clear one slug
ACCOUNT_HOST_HISTORY_DELETE: 'account:host:delete',               // forget a slug entirely
ACCOUNT_SWAP_RESTORE: 'account:swap:run',                         // save+swap+restore flow
ACCOUNT_SWAP_PROGRESS: 'account:swap:progress',                   // renderer listens for phase updates
ACCOUNT_PUSH_REMOTE: 'account:remote:push',                       // { accountId, sshConfig, stampHost? }
ACCOUNT_PUSH_PROGRESS: 'account:remote:push:progress',            // streamed phases
```

### Session config changes

`SavedSession` (in `src/shared/types.ts`) grows:

```ts
export interface SavedSession {
  // …existing fields…
  accountPreference?: {
    accountId?: string                 // chosen in picker, or undefined = "use active at launch"
    skipPickerUntilNextMismatch?: boolean
  }
  lastLaunchedWithAccountId?: string   // stamped at each successful launch (used for "mismatch detected" warnings)
}
```

The picker honours `accountPreference.skipPickerUntilNextMismatch` if set AND the current active account ID matches `lastLaunchedWithAccountId`. Any change triggers a one-shot re-prompt.

### config-manager.ts impact

We already use `saveConfigDebounced(key, data)` for writes. `accounts.json` is written via `writeConfig('accounts', data)` synchronously, which stays the same. Host history writes piggy-back on the same file (single schema). No new top-level config file.

## Data flow walkthroughs

### Booting with an existing install

1. App launches → `initAccounts()` runs as today.
2. **Extended step**: if credentials exist, also call `readOauthAccount()`. Merge the result into the auto-saved account's `oauthAccount` snapshot.
3. If `pendingAccountSwap` is present, trigger the crash-recovery modal (described earlier) before rendering the normal UI.

### User clicks "New session" (or "Duplicate session")

1. Session launch surface calls `sessionLaunchFlow.requestLaunch(sessionConfig)`.
2. Flow decides: do we need the picker?
   - If `sessionConfig.accountPreference.skipPickerUntilNextMismatch` AND current active account matches `launchedWithAccountId` → skip picker, proceed with current active account. (renamed from `lastLaunchedWithAccountId` per reviewer N7 — avoids confusion with `lastUsedAt`)
   - **Single-account install** (len(accounts) === 1) → skip picker entirely. The picker re-surfaces the first time a second account is added.
   - Otherwise → open `AccountPicker` modal.
3. Picker resolves to `{ targetAccountId, pushCredentialsFirst?, resumeChoice, dontAskAgain }`.
4. If `targetAccountId !== activeAccountId` → `runSaveRestoreSwap(targetAccountId)`. **Block here (await) until the swap executor reports `phase: 'restored'` AND the renderer has finished re-spawning the restored PTYs (B4 fix).** During this window the picker's launch button shows "Restoring sessions..." and the fresh-launch request is queued but not fired.
5. If `pushCredentialsFirst` → `pushCredentialsToHost(activeAccountId, sshConfig)`. Await success; block launch on failure and surface error.
6. Stamp `launchedWithAccountId = activeAccountId` on the session config.
7. **Append** the new session's `SavedSession` entry to `session-state.json` AFTER the restored set is persisted (never mixed into the pre-swap snapshot). Then call the existing sessionStore launch path with the `resumeChoice`.

`sessionStore.restorePhase` drives this gate: values `'idle' | 'restoring' | 'done'`. The picker's launch IPC refuses to fire while it's `'restoring'` and waits on a promise.

### User clicks the TitleBar chip → picks a different account

1. `accountStore.switchTo(accountId)` → main via `ACCOUNT_SWAP_RESTORE`.
2. `runSaveRestoreSwap` executes as above.
3. On completion, renderer receives progress events (`saving`, `swapping`, `restoring`, `done` / `error`) and shows a small toast in the TitleBar chip area.

### User clicks "Push credentials to Asustor" from Manage Hosts

1. Renderer calls `ACCOUNT_PUSH_REMOTE` with `{ accountId, sshConfig, stampHost: true }`.
2. Main reads credentials (decrypted), spawns `ssh ${user}@${host} -p ${port} -o StrictHostKeyChecking=accept-new -- 'bash -s'`.
3. On the remote, the script reads stdin, writes credentials + merges `oauthAccount`, emits `CCC_PUSH_OK` or `CCC_PUSH_ERR <msg>`.
4. Main parses output, resolves the promise.
5. If `stampHost`, record the mapping.
6. Progress events: `connecting`, `writing`, `verifying`, `done` / `error` are streamed via `ACCOUNT_PUSH_PROGRESS`.

### SSH session first-ever connect with new tracking

1. Session launches. PTY streams data.
2. First OSC sentinel from `SSH_STATUSLINE_SHIM` arrives. Main's SSH sentinel parser calls `accountManager.recordHostAccount(hostSlug, activeAccountId)`.
3. If mapping existed before and differs from active, emit `accountStore.hostMismatchDetected(sessionId, hostSlug, previous, current)` so the renderer can show the in-session banner.

### Account deleted / legacy behaviour (B7 fix)

To resolve the conflict between "`primary` is a reserved slot" and "auto-save re-captures the current credentials":

- On account delete, we capture the deleted `profile.oauthAccount.accountUuid` (or `fingerprintShort` if accountUuid absent) into a new top-level `retiredAccountIds: string[]` in `accounts.json`.
- On next boot, if `~/.claude/.credentials.json` matches a retired uuid/fingerprint, we do NOT auto-save that account. The user explicitly re-saves via "Save current credentials as a new account…" if desired.
- `primary` / `secondary` stay as reserved slot names for the existing two-slot model. Deleting either removes the row and adds its identity to `retiredAccountIds`. On next boot, the slot stays empty; if the user logs into a different account, the auto-save uses a new opaque `acct-<uuid>` id instead of re-filling the reserved slot.
- `acct-<uuid>` rows are user-managed; delete clears the row + adds to `retiredAccountIds`.
- No silent identity replacement on a reserved slot — this preserves `hostAccountHistory` mappings.

## Schemas

### Extended `AccountsData`

```json
{
  "accounts": [
    {
      "profile": {
        "id": "primary",
        "label": "Nicholas Moger",
        "savedAt": 1761222300000,
        "lastUsedAt": 1761222900000,
        "oauthAccount": {
          "emailAddress": "nicholas.moger@me.com",
          "displayName": "Nicholas Moger",
          "organizationName": "Personal",
          "organizationRole": "owner",
          "accountUuid": "8a2f3b1c-0000-4000-8000-000000000000",
          "billingType": "individual",
          "subscriptionCreatedAt": "2025-09-01T12:00:00Z",
          "hasExtraUsageEnabled": true
        },
        "subscriptionType": "max",
        "rateLimitTier": "max_5x",
        "fingerprintShort": "8a2f3b1c",
        "useCustomLabel": false
      },
      "credentials": "<encrypted credentials object>"
    }
  ],
  "lastActiveId": "primary",
  "hostAccountHistory": {
    "nicholas@asustor:22": {
      "hostSlug": "nicholas@asustor:22",
      "lastAccountIdUsed": "primary",
      "firstSeenAt": 1761100000000,
      "lastSeenAt": 1761222900000,
      "firstSeenWithAccountId": "secondary"
    }
  },
  "pendingAccountSwap": null
}
```

### Remote push wire format (B2, B6 fixes)

Run via `ssh user@host -p <port> -o StrictHostKeyChecking=accept-new -o BatchMode=yes -- bash -s`. Stdin payload uses a freshly-generated 24-char hex delimiter per push (prevents heredoc sentinel collision with credential contents) and guards against pipeline errors:

```
set -euo pipefail
umask 077
trap 'printf "CCC_PUSH_ERR:%s\n" "$BASH_COMMAND" >&2; exit 1' ERR
DELIM=__CCC_PAYLOAD_<24-hex-randomness>__
mkdir -p ~/.claude
tmp_payload=$(mktemp)
cat <<"$DELIM" > "$tmp_payload"
<base64 of a single JSON document: { creds: <credentialsObject>, oauthAccount: <oauthAccountPatch> }>
$DELIM
node --check - <<'__CCC_NODE__' <<-'__DONE__' >/dev/null
<inline merge script — see below>
__CCC_NODE__
node -e '<inline merge script>' "$tmp_payload" ~/.claude.json ~/.claude/.credentials.json
rm -f "$tmp_payload"
printf "CCC_PUSH_OK\n"
```

Key properties:

- **All payload bytes are base64-encoded** before being placed in the heredoc. The heredoc itself uses a per-push random 24-hex-char delimiter (generated client-side via `crypto.randomBytes(12).toString('hex')`). This rules out accidental sentinel collision — raw credentials never appear in the heredoc.
- **`set -euo pipefail`** means any command failure aborts the script; `CCC_PUSH_OK` only prints after the merge node program exits 0.
- **The merge script** is a small inline Node.js program that: base64-decodes the payload; shallow-merges `oauthAccount` into the target `~/.claude.json` (preserving unknown keys); writes both targets via `writeFileSync(tmp, data, { mode: 0o600 })` + `renameSync(tmp, target)` for atomicity; rejects a decoded payload larger than 64 KB (combined) as a crafted-JSON defence.
- **Temp files are explicitly cleaned** in the success path. On failure (trap), the temp file is left for user inspection at the documented `mktemp` location; we surface the path in the error response so the user can retrieve manually. We do NOT schedule backgrounded cleanup (per reviewer S9 — backgrounded `rm` dies when SSH session closes on a one-shot connection).
- We use `-o BatchMode=yes` so a wrong cached key doesn't silently hang on an interactive prompt.

### Pre-launch picker resolution

```ts
interface PickerResolution {
  targetAccountId: string
  swapRequired: boolean            // targetAccountId !== activeAccountId
  pushCredentialsFirst?: {
    sshConfigDigest: string        // hashed sshConfig to correlate with host history
    sourceAccountId: string
  }
  resumeChoice: 'resume' | 'fresh' | { resumeId: string }
  skipPickerUntilNextMismatch: boolean
}
```

## Disable / safety story

The feature is always on (no master toggle) but degrades cleanly:

| Failure | Mitigation |
|---------|-----------|
| `~/.claude.json` missing or unreadable | Label falls back to `savedLabel` → `${sub} ${fp}` legacy. No crash. |
| `oauthAccount` key missing (very old install) | Same fallback chain. Chip never shows a fingerprint-only label. |
| `runSaveRestoreSwap` mid-flight and app killed | `pendingAccountSwap` persists. Boot offers recovery modal. If user declines, we restore the source account and clear. |
| Soft-stop ptys don't terminate in 500ms | Escalate to SIGTERM. If still alive after 2s, escalate to `gracefulExitAllPty(5000)`. Log which sessions required escalation. |
| Remote push SSH connect fails | Surface stderr in dialog. No state written. User can retry. |
| Remote script error after partial write | We keep a remote tmp file copy of the previous `~/.claude/.credentials.json` for 5 minutes via `mktemp` so the user can SSH in and restore manually. Document in the error surface. |
| Picker cancelled after swap already ran | Swap is committed; session doesn't launch; user can re-launch at their leisure. We don't "un-swap". |
| Very large number of accounts | Picker shows first 8 with a search box; `acct-*` ids beyond that require typing to reveal. |

## Security

### Threat model

Same as today's account-manager: we trust the OS user. Credentials at rest use `safeStorage` (OS keychain / Keychain / libsecret) where available. The new concerns are about propagation:

- **Remote push** is always user-initiated. No renderer JavaScript path can trigger it without the explicit confirmation dialog returning `confirmed: true`.
- **Remote host authentication** still uses whatever the SSH config defined (key-based or user-typed password). We don't escalate to stored passwords via `sshpass` or similar.
- **Remote credentials in transit** ride the SSH tunnel's encryption. We never transmit them via a side channel.
- **Credentials on the remote filesystem** are written with `umask 077` → `0o600`. We do not touch remote permissions otherwise.
- **Remote tmp files** clean up on success. On failure, the script leaves them behind for 5min via `mktemp` + `setTimeout`-style deletion — actually a simple sleeping backgrounded `rm` call scheduled on the remote. This is documented in the error surface so the user can check manually.

### Concrete controls

- All credential bytes in memory are `Buffer`s that we zero out after use.
- `ACCOUNT_PUSH_REMOTE` IPC handler requires a Boolean `confirmed` field in the request body; the renderer sends it only after the dialog resolves positively. A pathway that skips the dialog will fail with `confirmation_missing`.
- Never log credential contents. Log the slug and source account ID only.
- The one-shot script does NOT write env vars; nothing leaks into the remote `history`.
- We do NOT execute arbitrary SSH commands; the remote script is hard-coded and piped via stdin.
- The merge script on the remote rejects a payload larger than 64 KB for defence against crafted JSON bombs.

### Renderer → Main boundary

- The renderer can request credential metadata (`getAccounts()`), but never the decrypted credential blob. Remote push IPC receives `accountId` + `sshConfig`; main resolves the credentials from the in-process store.
- TitleBar hostmismatch banners receive `hostSlug` + `accountId` only, never credentials.

## Testing

### Unit
- **account-manager.ts**
  - `initAccounts()` populates `oauthAccount` snapshot when `~/.claude.json` has `oauthAccount`.
  - Fallback chain: `displayName` → `emailAddress` → `savedLabel` → `subscription + fingerprint`.
  - `useCustomLabel: true` preserves label across a credentials refresh.
  - `recordHostAccount` stamps `firstSeenAt` on first write, bumps `lastSeenAt` on subsequent.
  - `hostSlug` normalisation: `USER@Host:22` and `user@host:22` collapse to one slug.
- **account-oauth-reader.ts** — returns null for missing file, returns partial snapshot when only some keys are present.
- **account-json-merger.ts** — idempotent merge; unknown keys preserved; writes mode 0o600; uses atomic rename.
- **account-swap-executor.ts** — runs phases in order; soft-stop timeout escalation; `pendingAccountSwap` cleared on success; left intact on failure.
- **account-remote-push.ts** — spawns ssh with correct args; writes stdin; parses `CCC_PUSH_OK` / `CCC_PUSH_ERR` sentinel; hostSlug stamped when flagged.

### Integration
- **Synthetic swap** — start two mock sessions, swap, assert both restarted with their cwd/model/configId intact; assert `saveSessionState` wrote exactly the right snapshot.
- **Synthetic remote push** — a local sshd container / fake remote (mock) that echoes stdin; assert the merge script produces the expected `~/.claude.json` content.
- **Picker flow** — open picker with mismatch, pick swap, assert `ACCOUNT_SWAP_RESTORE` called with the chosen id and `runSaveRestoreSwap` resolved.
- **Crash recovery** — write `pendingAccountSwap` to fixture `accounts.json`, boot the app, assert recovery modal surfaces.

### Manual smoke
1. Launch app on a machine with both `primary` and `secondary` defined. Verify chip shows `displayName` (not fingerprint). Dropdown shows emailAddress + org + billing.
2. Open a local session, open an SSH session to Asustor. Swap to the other account via TitleBar. Verify both sessions shut down gracefully, both restart, and the renderer tab state preserves cwd / resume / scroll buffer (scroll buffer may not — document).
3. New-session flow: the picker appears. Pick a different account than active. Observe swap-and-launch message.
4. Mismatched SSH: with account A active, open the session last used with account B. Verify the mismatch warning + push action.
5. Push credentials: confirm dialog, confirm, watch progress, verify on the remote that `~/.claude/.credentials.json` now contains account A's token.
6. Kill the app mid-swap (deliberate). Restart. Confirm crash-recovery modal.

### Accessibility
- Picker reachable via keyboard tab order. Escape closes. Enter commits.
- Dropdown rows have role=menuitem with ARIA label combining displayName + email.
- Swap progress toast uses `aria-live="polite"`.

## Migration

- Existing `accounts.json` has `accounts[*].profile.id in {'primary', 'secondary'}` and no `oauthAccount` field. On first load after upgrade:
  - Call `readOauthAccount()` with the machine's current `~/.claude.json`. If the value matches the account's credentials (refresh token check), stamp `oauthAccount` on that profile.
  - If two accounts exist and only one matches, stamp the match; leave the other without `oauthAccount` (it'll backfill when the user next switches to it, because switching writes credentials and then reads `~/.claude.json` for the snapshot).
- Existing `SavedSession` rows have no `accountPreference`. Treat as "use active at launch + show picker" on next launch. After the first picker resolution they stamp the field.
- `hostAccountHistory` starts empty. First successful SSH OSC sentinel on each host back-stamps.
- No schema version bump. The additive fields are safe for older clients to ignore (old builds wouldn't read them anyway).

## Performance

- The picker adds one modal before every launch. Measure: ~100ms to render on the user's machine. Acceptable — launch is already ~2s.
- `runSaveRestoreSwap` adds ~1.5s over the existing kill-on-switch flow. Worth it for the data preservation.
- `readOauthAccount` is a single synchronous file read on launch + whenever we refresh the chip. `<5ms`.
- `recordHostAccount` is a no-op after first write (compares `lastSeenAt`). Writes debounced through `writeConfig`.
- Remote push is network-bound; 1–3 seconds typical. Progress events keep the UI responsive.

## Phasing (trimmed per reviewer)

One PR (`feat/account-rework`) stacked on `feat/hooks-gateway`. Internal phases:

1. **A · Data model + oauthAccount snapshot**. Type changes, `readOauthAccount`, capture during `initAccounts`/`saveCurrentAs`/`switchAccount`, chip label fallback chain. No user-visible new features yet.
2. **B · Save-and-restore swap executor**. Replace `gracefulExitAllPty(5000)` with `runSaveRestoreSwap` (includes two-phase renderer flush, atomic credential writes, `pendingAccountSwap` crash-recovery as auto-resume toast — no blocking modal).
3. **C · TitleBar chip redesign**. New labels, dropdown layout, rename affordance.
4. **D · Push credentials to remote** (moved earlier — reviewer S7 flagged ordering). `account-remote-push.ts`, per-host confirmation dialog (listing the two files overwritten + stamp-host checkbox), progress events. Ships before the picker so the picker's inline "Push credentials first" button is functional on day one.
5. **E · Pre-launch picker**. `AccountPicker.tsx`, `session-launch-flow.ts`, wire every launch surface through it. Single-account installs skip the picker entirely.
6. **F · Host account tracking**. `recordHostAccount` on SSH OSC sentinel. In-session mismatch banner.

**Cut from MVP** (deferred to a v1.3.3 follow-up PR):
- "Manage hosts" submenu UI — the picker + in-session banner cover the common case. The `hostAccountHistory` data capture stays; the dedicated UI doesn't ship now.
- Per-account `useCustomLabel` toggle — default behaviour (label stays until user renames) is sufficient.
- "First-push-to-any-host extra warning checkbox" — per-host confirmation with file list is enough.

Each sub-phase commits atomically; the PR rolls them together.

## Risks

- **`gracefulExitAllPty` replacement risks orphaning** if the soft-stop escalation logic has a bug. Mitigation: keep `gracefulExitAllPty(5000)` as the final fallback; unit-test the escalation chain exhaustively.
- **`oauthAccount` schema drift**. If Anthropic renames keys, our reader returns an empty snapshot and the chip falls back. We never hard-fail.
- **Remote push script compatibility**. Bash, Node, and `base64 -d` must exist on the remote. Same assumption we already make for the SSH setup script; no regression.
- **SSH host key warnings on push** — `StrictHostKeyChecking=accept-new` applies (same as the session flow). If the remote's host key changed, push fails with a clear error; user must SSH in manually once.
- **Docker-entry SSH configs** (postCommand runs a container shell). Remote push runs **before** any postCommand — it writes to the actual SSH user's `~/.claude`, not the container's. Document this: if the user wants credentials inside the container, they push into a *different* SSH config targeting the container directly, or scp manually.
- **hostSlug collisions** when user opens a config via IP and an alias to the same host. Both get independent records. Acceptable; user can consolidate via Manage Hosts if it bothers them.
- **Picker fatigue**. Single-account users don't want a modal every launch. Default-first-pick + "don't ask again" checkbox mitigates. Re-prompt only on mismatch keeps it honest.
- **Concurrent swaps** (B3). The swap executor holds a module-level `inFlight: Promise<SwapResult> | null`. A second `runSaveRestoreSwap` call while one is in flight **returns the same promise** (not a rejection). Both callers observe the same resolution. `accountStore.swapState` ('idle' | 'snapshotting' | 'soft-stopping' | 'writing-creds' | 'restoring' | 'error') is exposed so the chip/picker disable themselves during non-idle phases. Cancel is not supported once `writing-creds` begins — the only exit is completion + crash-recovery on next boot.
- **`accountUuid` absence** for older OAuth flows → `fingerprintShort` fallback derives from `refreshToken` (same as today) with a prefix char to differentiate.
- **Renderer-side cached `oauthAccount` going stale** after an OAuth refresh that rotated the token. Refresh by reading the file on every credentials read-from-disk event — cheap.
- **Decrypted credentials in renderer memory**: they never enter the renderer. IPC returns profile metadata only.
- **SSH sentinel parser race** when two concurrent SSH sessions stamp conflicting hostSlugs at the same time: the writer serialises `writeConfig` calls already; no race.

## Open questions

- **Should `primary` / `secondary` slot names stay, or migrate everyone to `acct-<uuid>`?** The slot model is familiar and the TitleBar shortcut benefits from it. Recommendation: keep as reserved names; new accounts get opaque ids. The migration preserves existing identifiers.
- **Should the push action prompt on first-ever use with a bigger warning?** Leaning yes — the first push to any remote includes an additional "I understand this replaces the remote's credentials file" checkbox. After the first push to a given host, subsequent pushes use the simpler confirm dialog.
- **Should the picker also include the resume-picker UX as one modal or two?** Proposed: one modal (higher-information-density, one confirmation). Open to splitting if UX review finds the combined modal cramped at <1280px widths.
- **Should we cross-validate `oauthAccount.accountUuid` vs the credentials' decoded JWT?** The refresh token is opaque to us; the access token could be decoded (it's a JWT). Skipping for MVP — `accountUuid` from `oauthAccount` is authoritative because Claude Code itself wrote it after OAuth.
- **Should we expose a CLI / import path for bulk account export?** Out of scope for MVP. Accounts live in `CONFIG/accounts.json` and the user can copy that file between machines themselves.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
