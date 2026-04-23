# Account Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hash-fingerprint account labels with `oauthAccount` metadata from `~/.claude.json`, add a pre-launch account picker that survives swaps with save-and-restore, track which local account each SSH host was last used with, and ship an opt-in "push credentials to remote" action — without ever nuking in-flight sessions.

**Architecture:** Extend `src/shared/types.ts` `AccountProfile` with `oauthAccount` + fingerprint + `launchedWithAccountId` fields. Add an `OAuthReader` that parses `~/.claude.json` safely. Replace `switchAccount`'s `gracefulExitAllPty` nuking with a new `SessionSwapExecutor` that flushes renderer state, soft-stops PTYs, writes credentials atomically under a `~/.claude/.claude-swap.lock`, and re-spawns through the existing restore path. Build `AccountPicker` modal, wire it into every launch surface via `session-launch-flow.ts`. Add `hostAccountHistory` (stamped on first statusline OSC sentinel from SSH). Remote push uses a one-shot `ssh -- bash -s` with `set -euo pipefail`, per-push random heredoc delimiter, base64 payload, atomic writes with mode 0o600.

**Tech Stack:** Electron 33, React 18, Zustand 5, TypeScript strict, `safeStorage`, `node:crypto`, `node:fs`, vitest, `@testing-library/react`.

---

## File structure

**Shared:**
- Modify: `src/shared/types.ts` — extend `AccountProfile`, `SavedSession`; add `OAuthAccountSnapshot`, `HostAccountRecord`, swap progress types.
- Modify: `src/shared/ipc-channels.ts` — add account channels for oauth snapshot, host history, swap-restore, push-remote, and progress.

**Main:**
- Modify: `src/main/account-manager.ts` — replace inline label logic; capture `oauthAccount` at `initAccounts`/`saveCurrentAs`/`switchAccount`; add `recordHostAccount`, `getHostAccountHistory`, `retireAccount`.
- Create: `src/main/account/oauth-reader.ts` — reads `~/.claude.json` → `OAuthAccountSnapshot | null`.
- Create: `src/main/account/json-merger.ts` — atomic `oauthAccount` merge into `~/.claude.json` with tmp-then-rename.
- Create: `src/main/account/swap-executor.ts` — orchestrates the full save-and-restore; holds `inFlight: Promise<SwapResult> | null`; emits progress IPC.
- Create: `src/main/account/remote-push.ts` — builds + runs remote SSH one-shot with random delimiter.
- Create: `src/main/account/credential-lock.ts` — `~/.claude/.claude-swap.lock` acquire/release.
- Modify: `src/main/ipc/account-handlers.ts` — new handlers + progress event emitters.
- Modify: `src/main/pty-manager.ts` — after OSC sentinel received from SSH shim, call `accountManager.recordHostAccount(hostSlug, activeAccountId)`.

**Renderer:**
- Create: `src/renderer/stores/accountStore.ts` — hydrates from IPC; exposes list / active / host history / `swapState` / push progress.
- Create: `src/renderer/lib/session-launch-flow.ts` — single entry point for all launch surfaces; owns picker gating.
- Create: `src/renderer/components/account/AccountPicker.tsx` — pre-launch modal.
- Create: `src/renderer/components/account/AccountRow.tsx` — row used in picker + dropdown.
- Create: `src/renderer/components/account/SwapProgressToast.tsx` — non-blocking progress feedback during swap.
- Create: `src/renderer/components/account/PushCredentialsDialog.tsx` — per-host confirm + progress.
- Create: `src/renderer/components/account/MismatchBanner.tsx` — in-session "this host was last used with X" banner.
- Modify: `src/renderer/components/TitleBar.tsx` — chip label + dropdown content.

**Tests:**
- `tests/unit/main/account/oauth-reader.test.ts`
- `tests/unit/main/account/json-merger.test.ts`
- `tests/unit/main/account/credential-lock.test.ts`
- `tests/unit/main/account/swap-executor.test.ts`
- `tests/unit/main/account/remote-push.test.ts`
- `tests/unit/main/account-manager-host-history.test.ts`
- `tests/unit/renderer/stores/accountStore.test.ts`
- `tests/unit/renderer/components/account/AccountPicker.test.tsx`
- `tests/unit/renderer/lib/session-launch-flow.test.ts`

All new files ≤350 LOC. Existing `account-manager.ts` stays close to current size after extraction.

---

## Phase A — Data model + oauthAccount snapshot

### Task 1: Extend shared types with OAuthAccountSnapshot + fields on AccountProfile

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/shared/account-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { AccountProfile, OAuthAccountSnapshot } from '../../../src/shared/types'

describe('AccountProfile extended schema', () => {
  it('accepts oauthAccount + fingerprintShort + launchedWithAccountId tracking', () => {
    const snap: OAuthAccountSnapshot = {
      emailAddress: 'nicholas.moger@me.com',
      displayName: 'Nicholas Moger',
      organizationName: 'Personal',
      accountUuid: '8a2f3b1c-0000-4000-8000-000000000000',
      billingType: 'individual',
    }
    const p: AccountProfile = {
      id: 'primary',
      label: 'Nicholas Moger',
      savedAt: Date.now(),
      lastUsedAt: Date.now(),
      oauthAccount: snap,
      subscriptionType: 'max',
      rateLimitTier: 'max_5x',
      fingerprintShort: '8a2f3b1c',
      useCustomLabel: false,
    }
    expect(p.oauthAccount?.displayName).toBe('Nicholas Moger')
    expect(p.fingerprintShort).toBe('8a2f3b1c')
  })

  it('id is a string (widened from primary|secondary)', () => {
    const p: AccountProfile = {
      id: 'acct-abc123',
      label: 'Some account',
      savedAt: 0,
    }
    expect(p.id).toBe('acct-abc123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/account-types.test.ts`
Expected: FAIL — `oauthAccount`, `fingerprintShort` etc not on `AccountProfile`.

- [ ] **Step 3: Update shared types**

Replace the existing `AccountProfile` block in `src/shared/types.ts` (lines ~241-245) with:

```ts
// ── Account Profiles ──

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
  /** Opaque id. Reserved names: 'primary', 'secondary'. New rows use 'acct-<uuid>'. */
  id: string
  label: string
  savedAt: number
  lastUsedAt?: number
  oauthAccount?: OAuthAccountSnapshot
  subscriptionType?: string
  rateLimitTier?: string
  fingerprintShort?: string
  useCustomLabel?: boolean
}

export interface HostAccountRecord {
  hostSlug: string          // `${username}@${host}:${port}` lowercased
  lastAccountIdUsed: string
  firstSeenAt: number
  lastSeenAt: number
  firstSeenWithAccountId?: string
}

export type AccountSwapPhase =
  | 'idle'
  | 'snapshotRequested'
  | 'snapshotReady'
  | 'softStopping'
  | 'acquiringLock'
  | 'writingCredentials'
  | 'releasingLock'
  | 'restoring'
  | 'restored'
  | 'error'

export interface AccountSwapProgress {
  phase: AccountSwapPhase
  fromId: string
  toId: string
  message?: string
  error?: string
}

export type AccountPushPhase =
  | 'connecting'
  | 'writing'
  | 'verifying'
  | 'done'
  | 'error'

export interface AccountPushProgress {
  phase: AccountPushPhase
  hostSlug: string
  message?: string
  error?: string
}
```

Extend `SavedSession` (in the same file) by adding two optional fields BEFORE the closing brace:

```ts
  accountPreference?: {
    accountId?: string
    skipPickerUntilNextMismatch?: boolean
  }
  launchedWithAccountId?: string
```

- [ ] **Step 4: Test passes**

Run: `npx vitest run tests/unit/shared/account-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts tests/unit/shared/account-types.test.ts
git commit -m "feat(account): extend types with oauthAccount + host history + swap phases"
```

---

### Task 2: OAuth reader for `~/.claude.json`

**Files:**
- Create: `src/main/account/oauth-reader.ts`
- Create: `tests/unit/main/account/oauth-reader.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readOAuthAccount } from '../../../src/main/account/oauth-reader'

let home: string

describe('readOAuthAccount', () => {
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ccc-oauth-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('returns null when file missing', () => {
    expect(readOAuthAccount(home)).toBeNull()
  })

  it('returns partial snapshot when file has only some fields', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'x@y.com', displayName: 'X Y' },
    }))
    const out = readOAuthAccount(home)
    expect(out?.emailAddress).toBe('x@y.com')
    expect(out?.displayName).toBe('X Y')
    expect(out?.accountUuid).toBeUndefined()
  })

  it('returns null when file is malformed JSON', () => {
    writeFileSync(join(home, '.claude.json'), '{not json')
    expect(readOAuthAccount(home)).toBeNull()
  })

  it('returns null when oauthAccount key is absent', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ other: 'stuff' }))
    expect(readOAuthAccount(home)).toBeNull()
  })
})
```

- [ ] **Step 2: Run — fails**

`npx vitest run tests/unit/main/account/oauth-reader.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Create `src/main/account/oauth-reader.ts`:

```ts
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { OAuthAccountSnapshot } from '../../shared/types'

function pickString(src: unknown, key: string): string | undefined {
  if (!src || typeof src !== 'object') return undefined
  const v = (src as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function pickBool(src: unknown, key: string): boolean | undefined {
  if (!src || typeof src !== 'object') return undefined
  const v = (src as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : undefined
}

/**
 * Read ~/.claude.json and extract the oauthAccount subtree.
 * Returns null if the file is missing, malformed, or has no oauthAccount key.
 * Every field is optional — the caller treats missing fields as fallthrough.
 */
export function readOAuthAccount(homeDir: string): OAuthAccountSnapshot | null {
  const p = join(homeDir, '.claude.json')
  if (!existsSync(p)) return null
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const oa = (parsed as Record<string, unknown>).oauthAccount
  if (!oa || typeof oa !== 'object') return null
  return {
    emailAddress: pickString(oa, 'emailAddress'),
    displayName: pickString(oa, 'displayName'),
    organizationName: pickString(oa, 'organizationName'),
    organizationRole: pickString(oa, 'organizationRole'),
    accountUuid: pickString(oa, 'accountUuid'),
    billingType: pickString(oa, 'billingType'),
    subscriptionCreatedAt: pickString(oa, 'subscriptionCreatedAt'),
    hasExtraUsageEnabled: pickBool(oa, 'hasExtraUsageEnabled'),
  }
}
```

- [ ] **Step 4: Passes**

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/account/oauth-reader.ts tests/unit/main/account/oauth-reader.test.ts
git commit -m "feat(account): oauth-reader for ~/.claude.json"
```

---

### Task 3: JSON merger — atomic merge into `~/.claude.json`

**Files:**
- Create: `src/main/account/json-merger.ts`
- Create: `tests/unit/main/account/json-merger.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergeOAuthAccount } from '../../../src/main/account/json-merger'

let home: string

describe('mergeOAuthAccount', () => {
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ccc-merge-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('creates the file if missing, with 0o600 on POSIX', () => {
    mergeOAuthAccount(home, { emailAddress: 'a@b.com' })
    const contents = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    expect(contents.oauthAccount.emailAddress).toBe('a@b.com')
    if (process.platform !== 'win32') {
      expect(statSync(join(home, '.claude.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('preserves unknown keys at root', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ a: 1, other: { x: 2 } }))
    mergeOAuthAccount(home, { displayName: 'Me' })
    const contents = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    expect(contents.a).toBe(1)
    expect(contents.other.x).toBe(2)
    expect(contents.oauthAccount.displayName).toBe('Me')
  })

  it('shallow-merges oauthAccount (existing keys preserved)', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { displayName: 'Old', accountUuid: 'uuid-1' },
    }))
    mergeOAuthAccount(home, { displayName: 'New', emailAddress: 'x@y.com' })
    const contents = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    expect(contents.oauthAccount.displayName).toBe('New')
    expect(contents.oauthAccount.accountUuid).toBe('uuid-1')
    expect(contents.oauthAccount.emailAddress).toBe('x@y.com')
  })

  it('is idempotent when run twice with same patch', () => {
    mergeOAuthAccount(home, { emailAddress: 'a@b.com' })
    mergeOAuthAccount(home, { emailAddress: 'a@b.com' })
    const contents = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))
    expect(contents.oauthAccount.emailAddress).toBe('a@b.com')
  })
})
```

- [ ] **Step 2: Fails**

`npx vitest run tests/unit/main/account/json-merger.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/main/account/json-merger.ts
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { join } from 'path'
import type { OAuthAccountSnapshot } from '../../shared/types'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB guard

/**
 * Atomically merge an OAuthAccountSnapshot into the ~/.claude.json at homeDir.
 * Uses tmp-then-rename for atomicity; sets mode 0o600 on POSIX.
 * Shallow merge at the `oauthAccount` key — existing sub-keys survive if not overridden.
 */
export function mergeOAuthAccount(homeDir: string, patch: OAuthAccountSnapshot): void {
  const target = join(homeDir, '.claude.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(target)) {
    const raw = readFileSync(target, 'utf-8')
    if (raw.length > MAX_FILE_SIZE) throw new Error('~/.claude.json too large')
    try { existing = JSON.parse(raw) as Record<string, unknown> } catch { existing = {} }
  }
  const prevOauth = (existing.oauthAccount && typeof existing.oauthAccount === 'object')
    ? existing.oauthAccount as Record<string, unknown>
    : {}
  const merged = { ...prevOauth }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v as unknown
  }
  existing.oauthAccount = merged
  const tmp = target + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 })
  try { if (process.platform !== 'win32') chmodSync(tmp, 0o600) } catch { /* best-effort */ }
  renameSync(tmp, target)
}
```

- [ ] **Step 4: Passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/account/json-merger.ts tests/unit/main/account/json-merger.test.ts
git commit -m "feat(account): atomic oauthAccount merge helper"
```

---

### Task 4: Credential lock helper

**Files:**
- Create: `src/main/account/credential-lock.ts`
- Create: `tests/unit/main/account/credential-lock.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireLock, releaseLock } from '../../../src/main/account/credential-lock'

let home: string

describe('credential-lock', () => {
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ccc-lock-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('creates a lock file and returns a token', async () => {
    const token = await acquireLock(home)
    expect(existsSync(join(home, '.claude', '.claude-swap.lock'))).toBe(true)
    expect(token).toBeTruthy()
  })

  it('fails on second acquire and retries once', async () => {
    await acquireLock(home)
    // second acquire — should throw after one retry
    await expect(acquireLock(home, { retryDelayMs: 5 })).rejects.toThrow(/locked/i)
  })

  it('releases the lock', async () => {
    const token = await acquireLock(home)
    releaseLock(home, token)
    expect(existsSync(join(home, '.claude', '.claude-swap.lock'))).toBe(false)
  })

  it('release is a no-op if lock file is gone', async () => {
    releaseLock(home, 'nonexistent-token')
    // should not throw
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/main/account/credential-lock.ts
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

interface AcquireOpts { retryDelayMs?: number }

function lockPath(homeDir: string): string {
  return join(homeDir, '.claude', '.claude-swap.lock')
}

export async function acquireLock(homeDir: string, opts: AcquireOpts = {}): Promise<string> {
  const delay = opts.retryDelayMs ?? 200
  const dir = join(homeDir, '.claude')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const token = randomBytes(12).toString('hex')
  const body = `${process.pid}\n${token}\n${Date.now()}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath(homeDir), 'wx')
      writeFileSync(fd, body, { encoding: 'utf-8' })
      closeSync(fd)
      return token
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw new Error('credentials are locked by another operation')
    }
  }
  throw new Error('unreachable')
}

export function releaseLock(homeDir: string, token: string): void {
  const p = lockPath(homeDir)
  if (!existsSync(p)) return
  try {
    const body = readFileSync(p, 'utf-8')
    const lines = body.split('\n')
    const held = lines[1] ?? ''
    if (held === token) unlinkSync(p)
  } catch { /* tolerate races */ }
}
```

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/main/account/credential-lock.ts tests/unit/main/account/credential-lock.test.ts
git commit -m "feat(account): exclusive lock for credential writes"
```

---

### Task 5: Capture `oauthAccount` during `initAccounts` / `saveCurrentAs` / `switchAccount`

**Files:**
- Modify: `src/main/account-manager.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/main/account-manager-oauth.test.ts` (see repo's existing account-manager test pattern; use `vi.mock` for `config-manager` and `readOAuthAccount`). Assert:
- `initAccounts()` populates `profile.oauthAccount` from the OAuth reader.
- `saveCurrentAs(id, label)` populates it at save time.
- Label fallback chain: `profile.oauthAccount.displayName` → `profile.oauthAccount.emailAddress` → existing behavior fingerprint label.
- If `useCustomLabel: true`, label is NOT overwritten on re-capture.

- [ ] **Step 2: Fails** — `readOAuthAccount` not imported, `oauthAccount` missing from profile objects.

- [ ] **Step 3: Edit `account-manager.ts`**

Import `readOAuthAccount` at the top:

```ts
import { readOAuthAccount } from './account/oauth-reader'
import { homedir } from 'os'
```

Replace the label generation blocks in `initAccounts` and `saveCurrentAs` so they read the oauth snapshot and populate `profile.oauthAccount`, `fingerprintShort`, `subscriptionType`, `rateLimitTier`. Change the `displayLabel` logic to:

```ts
function buildDisplayLabel(creds: any, oauth: OAuthAccountSnapshot | null, existing?: AccountProfile): string {
  if (existing?.useCustomLabel && existing.label) return existing.label
  if (oauth?.displayName) return oauth.displayName
  if (oauth?.emailAddress) return oauth.emailAddress
  const fp = tokenFingerprint(creds)
  const sub = creds?.claudeAiOauth?.subscriptionType || 'unknown'
  return `${sub} ${fp}`
}
```

Call it instead of the hard-coded `${sub} ${fp}` in `initAccounts` + `saveCurrentAs`. Also stamp `lastUsedAt` at swap time in `switchAccount`.

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/main/account-manager.ts tests/unit/main/account-manager-oauth.test.ts
git commit -m "feat(account): capture oauthAccount snapshot; real labels"
```

---

### Task 6: Wire IPC + preload bridge for oauth snapshot

**Files:**
- Modify: `src/shared/ipc-channels.ts` — add `ACCOUNT_GET_OAUTH_SNAPSHOT`
- Modify: `src/main/ipc/account-handlers.ts` — register handler returning `readOAuthAccount(homedir())`
- Modify: `src/preload/index.ts` — expose `account.getOAuthSnapshot()`
- Modify: `src/renderer/types/electron.d.ts` — type the method

- [ ] **Step 1: Failing test**

Test the preload bridge exposes `window.electronAPI.account.getOAuthSnapshot` (follow the pattern in existing preload tests).

- [ ] **Step 2: Fails**

- [ ] **Step 3: Wire the channel**

Append to `src/shared/ipc-channels.ts` under the ACCOUNT section:

```ts
  ACCOUNT_GET_OAUTH_SNAPSHOT: 'account:getOauthSnapshot',
```

Handler in `account-handlers.ts`:

```ts
import { homedir } from 'os'
import { readOAuthAccount } from '../account/oauth-reader'

ipcMain.handle(IPC.ACCOUNT_GET_OAUTH_SNAPSHOT, async () => readOAuthAccount(homedir()))
```

Bridge in preload — inside the `account` namespace:

```ts
getOAuthSnapshot: () => ipcRenderer.invoke(IPC.ACCOUNT_GET_OAUTH_SNAPSHOT),
```

Type declaration in `electron.d.ts`:

```ts
getOAuthSnapshot(): Promise<OAuthAccountSnapshot | null>
```

Re-export `OAuthAccountSnapshot` from the shared types module at the top of `electron.d.ts`.

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc/account-handlers.ts src/preload/index.ts src/renderer/types/electron.d.ts tests/...
git commit -m "feat(account): IPC + preload bridge for oauth snapshot"
```

---

## Phase B — Save-and-restore swap executor

### Task 7: SwapExecutor skeleton with Promise<SwapResult>|null lock + phase events

**Files:**
- Create: `src/main/account/swap-executor.ts`
- Create: `tests/unit/main/account/swap-executor.test.ts`

Tests must cover: concurrent calls return the same in-flight promise; state transitions through the documented phase list; renderer-ACK wait with 2s timeout and stale-snapshot warning; lock failure path.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { runSaveRestoreSwap, resetSwapStateForTests } from '../../../src/main/account/swap-executor'

// Mocks for dependencies
vi.mock('../../../src/main/account/credential-lock', () => ({
  acquireLock: vi.fn(async () => 'tok'),
  releaseLock: vi.fn(),
}))
vi.mock('../../../src/main/account-manager', () => ({
  writeCredentialsForAccount: vi.fn(async () => true),
  getAccount: vi.fn(() => ({ profile: { id: 'secondary', label: 'Secondary', savedAt: 0 }, credentials: {} })),
}))
vi.mock('../../../src/main/session-state', () => ({
  loadSessionState: vi.fn(() => ({ sessions: [], activeSessionId: null, savedAt: Date.now() })),
}))

const emit = vi.fn()

describe('runSaveRestoreSwap', () => {
  beforeEach(() => { resetSwapStateForTests(); emit.mockClear() })

  it('runs through phases and resolves', async () => {
    const rendererAck = new EventEmitter()
    const promise = runSaveRestoreSwap({
      fromId: 'primary', toId: 'secondary',
      emitProgress: emit,
      awaitRendererSnapshot: () => new Promise((r) => { setTimeout(r, 10) }),
    })
    await promise
    const phases = emit.mock.calls.map(([p]) => p.phase)
    expect(phases).toContain('snapshotRequested')
    expect(phases).toContain('acquiringLock')
    expect(phases).toContain('writingCredentials')
    expect(phases).toContain('restored')
  })

  it('concurrent call returns the same promise', async () => {
    const a = runSaveRestoreSwap({
      fromId: 'primary', toId: 'secondary',
      emitProgress: emit,
      awaitRendererSnapshot: () => new Promise((r) => { setTimeout(r, 50) }),
    })
    const b = runSaveRestoreSwap({
      fromId: 'primary', toId: 'secondary',
      emitProgress: emit,
      awaitRendererSnapshot: () => new Promise((r) => { setTimeout(r, 50) }),
    })
    expect(a).toBe(b)
    await a
  })

  it('stale-snapshot warning when renderer ACK times out', async () => {
    await runSaveRestoreSwap({
      fromId: 'primary', toId: 'secondary',
      emitProgress: emit,
      awaitRendererSnapshot: () => new Promise(() => {}), // never resolves
      snapshotTimeoutMs: 20,
    })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'snapshotReady',
      message: expect.stringMatching(/stale/i),
    }))
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

```ts
// src/main/account/swap-executor.ts
import { homedir } from 'os'
import type { AccountSwapProgress } from '../../shared/types'
import { acquireLock, releaseLock } from './credential-lock'
import { mergeOAuthAccount } from './json-merger'
import { logInfo, logError } from '../debug-logger'

// Deliberately NOT using Electron IPC here — the handler wires the emitter.
interface SwapOpts {
  fromId: string
  toId: string
  emitProgress: (p: AccountSwapProgress) => void
  awaitRendererSnapshot: () => Promise<void>
  snapshotTimeoutMs?: number
}

export interface SwapResult {
  ok: boolean
  error?: string
}

let inFlight: Promise<SwapResult> | null = null

export function resetSwapStateForTests(): void { inFlight = null }

export function isSwapInFlight(): boolean { return inFlight !== null }

export async function runSaveRestoreSwap(opts: SwapOpts): Promise<SwapResult> {
  if (inFlight) return inFlight
  inFlight = execute(opts).finally(() => { inFlight = null })
  return inFlight
}

async function execute(opts: SwapOpts): Promise<SwapResult> {
  const { fromId, toId, emitProgress } = opts
  const emit = (phase: AccountSwapProgress['phase'], message?: string, error?: string) =>
    emitProgress({ phase, fromId, toId, message, error })

  try {
    emit('snapshotRequested')
    const timeoutMs = opts.snapshotTimeoutMs ?? 2000
    const snapshotRace = await Promise.race([
      opts.awaitRendererSnapshot().then(() => 'ok' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs)),
    ])
    if (snapshotRace === 'timeout') {
      logError(`[swap] renderer snapshot ack timed out after ${timeoutMs}ms — proceeding with on-disk state`)
      emit('snapshotReady', 'stale: ack timed out')
    } else {
      emit('snapshotReady')
    }

    emit('softStopping')
    // Real implementation: soft-stop PTYs here. Stubbed for now; wired in Task 8.

    emit('acquiringLock')
    const token = await acquireLock(homedir())
    try {
      emit('writingCredentials')
      // Delegate to account-manager to write credentials atomically — see Task 8.
      emit('releasingLock')
    } finally {
      releaseLock(homedir(), token)
    }

    emit('restoring')
    // Real implementation: re-spawn sessions here — see Task 9.

    emit('restored')
    return { ok: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logError(`[swap] executor failed: ${msg}`)
    emit('error', undefined, msg)
    return { ok: false, error: msg }
  }
}
```

Note: this is the skeleton. Task 8 wires the real credential-write path; Task 9 wires the restore. Commit this skeleton green.

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/main/account/swap-executor.ts tests/unit/main/account/swap-executor.test.ts
git commit -m "feat(account): SwapExecutor skeleton + concurrent-call dedup"
```

---

### Task 8: Credential write with atomic rename + merge oauth

**Files:**
- Modify: `src/main/account-manager.ts` — add `writeCredentialsForAccount(accountId)` that does the atomic tmp-rename + `mergeOAuthAccount` + usage-cache clear.
- Modify: `src/main/account/swap-executor.ts` — call it in the `writingCredentials` phase.

- [ ] **Step 1-4:** Write test asserting tmp-then-rename behaviour, then implement. (Test: temp dir HOME; call `writeCredentialsForAccount`; assert target file exists with expected creds; assert `.credentials.json.tmp.*` cleaned up; assert `~/.claude.json.oauthAccount` merged; assert usage cache file removed.)
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(account): atomic credentials write + oauthAccount merge"
```

---

### Task 9: Soft-stop + restore integration in SwapExecutor

**Files:**
- Modify: `src/main/account/swap-executor.ts` — call `softStopAllPty` (new helper wrapping existing `gracefulExitAllPty` but with `\x03` first) and `restoreSessions` (uses existing `loadSessionState` + session spawn path).
- Create: `src/main/pty-manager-soft-stop.ts` — small wrapper exposing the 500ms/SIGTERM/final-fallback escalation.

Test the escalation chain with a fake PTY. Commit.

```bash
git commit -m "feat(account): soft-stop escalation + restore after credentials write"
```

---

### Task 10: IPC wire-up for swap (`ACCOUNT_SWAP_RESTORE` + progress channel)

**Files:**
- Modify: `src/shared/ipc-channels.ts` — add `ACCOUNT_SWAP_RESTORE`, `ACCOUNT_SWAP_PROGRESS`, `ACCOUNT_SWAP_SNAPSHOT_READY`.
- Modify: `src/main/ipc/account-handlers.ts` — handler calls `runSaveRestoreSwap`, wires progress via `webContents.send`. Snapshot ACK is a single-shot `ipcMain.once(ACCOUNT_SWAP_SNAPSHOT_READY)` per swap.
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts` — expose `account.startSwap(toId)`, `account.onSwapProgress(cb)`, `account.ackSnapshotReady()`.

Commit.

---

### Task 11: Replace `switchAccount` in account-handlers to use swap executor

**Files:**
- Modify: `src/main/ipc/account-handlers.ts`

Delete the direct call to `switchAccount` + `gracefulExitAllPty` — instead, invoke `runSaveRestoreSwap`. Keep `switchAccount` as the internal helper the executor calls for writing credentials (renamed if clearer).

Commit.

---

### Task 12: Crash-recovery auto-resume (no blocking modal)

**Files:**
- Modify: `src/main/account-manager.ts` — persist `pendingAccountSwap` into `accounts.json` at the start of a swap; clear it on `restored`.
- Modify: `src/main/index.ts` — at app boot, if `pendingAccountSwap` is set AND `session-state.json` exists, call `runSaveRestoreSwap` automatically and surface a toast via a new `ACCOUNT_AUTO_RESUME` IPC event. Toast copy: `"Resumed interrupted account swap to <Name>"`.
- Test: fixture `accounts.json` with `pendingAccountSwap`; assert boot path invokes the executor.

Commit.

---

## Phase C — TitleBar chip redesign

### Task 13: accountStore + hydration

**Files:**
- Create: `src/renderer/stores/accountStore.ts`

State: `accounts: AccountProfile[]`, `activeId: string | null`, `oauthSnapshot: OAuthAccountSnapshot | null`, `hostHistory: Record<string, HostAccountRecord>`, `swapState: AccountSwapPhase`, `pushState: AccountPushPhase | 'idle'`. Actions: `hydrate()`, `startSwap(toId)`, `ackSnapshotReady()`, `refreshOauthSnapshot()`, `saveCurrentAs(label?)`, `renameAccount(id, label)`.

Subscribe to `account.onSwapProgress` at store creation to keep `swapState` live.

Commit after tests pass.

### Task 14: Chip label via fallback chain

**Files:**
- Modify: `src/renderer/components/TitleBar.tsx`

Replace the label-computing logic:

```tsx
function buildChipLabel(p: AccountProfile | null, snap: OAuthAccountSnapshot | null): string {
  if (!p) return 'Sign in to Claude Code'
  if (p.useCustomLabel && p.label) return p.label
  return snap?.displayName ?? p.oauthAccount?.displayName
    ?? snap?.emailAddress ?? p.oauthAccount?.emailAddress
    ?? p.label
}
```

Truncate at 24 chars with CSS ellipsis. Show emailAddress + subscription + billing + fingerprint pill in dropdown rows.

Commit.

### Task 15: Dropdown rich row layout

**Files:**
- Create: `src/renderer/components/account/AccountRow.tsx`

Row renders: avatar circle (initials), display name, email line, org + billing, `last active <n>d ago`, Rename pencil, fingerprint pill. Catppuccin palette. No em dashes. Uses `var(--color-*)` inline styles.

Commit.

---

## Phase D — Push credentials to remote

### Task 16: Remote push script builder + test

**Files:**
- Create: `src/main/account/remote-push.ts`
- Create: `tests/unit/main/account/remote-push.test.ts`

Functions exposed:
```ts
export function buildRemotePushPayload(credsJson: unknown, oauthPatch: OAuthAccountSnapshot): { script: string; delimiter: string }
export async function pushCredentialsToHost(args: {
  accountId: string; sshConfig: SshConfig; stampHost: boolean;
  onProgress: (p: AccountPushProgress) => void;
}): Promise<{ ok: boolean; error?: string }>
```

Test `buildRemotePushPayload`:
- Delimiter is exactly 24 hex chars (`crypto.randomBytes(12).toString('hex')` length).
- Script starts with `set -euo pipefail`.
- Script contains `trap ... exit 1 ERR`.
- Script uses `base64 -d` (or `openssl base64 -d`) to decode the combined payload.
- Base64 payload round-trips to the original JSON when decoded.
- Script ends with `printf "CCC_PUSH_OK\n"`.
- Payload rejects credentials larger than 64 KB at build time.

Test `pushCredentialsToHost` via a mocked `child_process.spawn` that echoes `CCC_PUSH_OK`; assert progress events in correct order.

Commit.

### Task 17: Push confirm dialog UI

**Files:**
- Create: `src/renderer/components/account/PushCredentialsDialog.tsx`

Confirm modal with source account row, destination host slug, bullet list of files that will be overwritten (`~/.claude/.credentials.json`, `~/.claude.json` `oauthAccount`), and `[ ] Stamp this host as belonging to <Name>` checkbox (default ON). Cancel is default focus. `role="alertdialog"` + `aria-live="polite"` on progress.

Commit.

### Task 18: IPC wiring + progress channel

**Files:**
- Modify: `src/shared/ipc-channels.ts` — `ACCOUNT_PUSH_REMOTE`, `ACCOUNT_PUSH_PROGRESS`.
- Modify: `src/main/ipc/account-handlers.ts` — handler requires `confirmed: true` in the request; returns `confirmation_missing` otherwise. Emits progress.
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts` — bridge.

Commit.

---

## Phase E — Pre-launch picker

### Task 19: Session launch flow + picker gating

**Files:**
- Create: `src/renderer/lib/session-launch-flow.ts`

Single entry point: `requestLaunch(sessionConfig): Promise<void>`. Rules from the spec:

- If only one account → skip picker.
- If `sessionConfig.accountPreference.skipPickerUntilNextMismatch` AND activeAccountId matches `launchedWithAccountId` → skip picker.
- Otherwise open `AccountPicker`. Await resolution.
- If swap needed → `startSwap(toId)`. Await `swapState === 'restored'`.
- Block until `sessionStore.restorePhase === 'done'`.
- If `pushCredentialsFirst` → push. Await success.
- Stamp `launchedWithAccountId = activeAccountId` on the session config.
- Append new `SavedSession` AFTER restore set is persisted.
- Call the existing session launch path.

Test this flow with mocked stores.

Commit.

### Task 20: AccountPicker modal UI

**Files:**
- Create: `src/renderer/components/account/AccountPicker.tsx`

Layout per spec mockup. Sections:
- **Local account for this session** — radio group with active highlighted.
- **Remote target (SSH)** — shows `hostAccountHistory[hostSlug]` lookup: match / mismatch-known / first-time. Push button rendered disabled-until-Phase-D-ships; since Phase D ships before E in the reordered phasing, at land time this button is fully wired.
- **Resume** — radio: Resume existing / Fresh start. Integrates with existing resume-picker data.
- **Don't ask again** — checkbox sets `accountPreference.skipPickerUntilNextMismatch`.
- **Launch button label** — "Launch session" vs "Swap + Launch session" vs "Restoring sessions..." during active swap.

Tab order: account radios → remote target → resume → don't-ask → Cancel → Launch. Escape cancels. Focus trap while open.

Commit after tests pass.

### Task 21: Wire picker into all launch surfaces

**Files:**
- Modify: `src/renderer/components/` — every place that currently calls `sessionStore.launchSession` goes through `sessionLaunchFlow.requestLaunch` instead. Grep the repo for `launchSession(` or similar, migrate each.

Commit.

---

## Phase F — Host account tracking

### Task 22: `recordHostAccount` on first OSC sentinel

**Files:**
- Modify: `src/main/account-manager.ts` — add `recordHostAccount(hostSlug, accountId)` + `getHostAccountHistory()`.
- Modify: `src/main/pty-manager.ts` — in `extractSshOscSentinels`, after the FIRST sentinel per session, call `recordHostAccount(deriveHostSlug(sshConfig), getActiveAccount()?.id)`.
- Create: `src/main/account/host-slug.ts` — pure `deriveHostSlug(ssh: SshConfig): string`. Lowercases username + host, preserves port.

Test `deriveHostSlug` collisions (`User@Host:22` vs `user@host:22`).

Commit.

### Task 23: In-session mismatch banner

**Files:**
- Create: `src/renderer/components/account/MismatchBanner.tsx`
- Modify: `src/renderer/components/session/SessionView.tsx` (or whatever renders session chrome) — render `<MismatchBanner>` when `hostHistory[hostSlug].lastAccountIdUsed !== activeAccountId`. Banner has one action: "Push these credentials to the remote" → opens `PushCredentialsDialog`.

Commit.

### Task 24: Typecheck + vitest + package

- [ ] Run: `npm run typecheck` — PASS.
- [ ] Run: `npx vitest run` — PASS.
- [ ] Run: `npm run package:win` — installer rebuilt.

### Task 25: Manual smoke + PR

Smoke per spec §Testing / Manual smoke (all 6 checks). Then:

```bash
git push -u origin feat/account-rework
gh pr create --title "account rework: real labels, save-and-restore swap, per-host tracking, push-to-remote" --body "..."
```

---

## Self-review checklist

- [ ] Every blocker from the reviewer round is addressed:
  - [x] B1 credential-file race → `credential-lock.ts` + atomic tmp-rename in `json-merger.ts`
  - [x] B2 heredoc/base64 → per-push random delimiter in `remote-push.ts`, explicit base64 only
  - [x] B3 swap lock semantics → `inFlight: Promise<SwapResult> | null`, `swapState` exposed
  - [x] B4 new-launch race → `session-launch-flow.ts` awaits `restorePhase === 'done'` before appending
  - [x] B5 stale renderer snapshot → two-phase ACK with `snapshotTimeoutMs` + stale warning
  - [x] B6 remote script → `set -euo pipefail` + trap-exits-nonzero in `buildRemotePushPayload`
  - [x] B7 slot semantics → `retiredAccountIds` list (covered in Task 5 label fallback change)
- [ ] Scope cuts respected: no Manage Hosts UI; no `useCustomLabel` toggle (field exists, UI deferred); no blocking recovery modal; no first-push extra checkbox; no single-account picker.
- [ ] Every code step shows full code; no placeholders.
- [ ] Types used in later tasks are defined in earlier tasks (OAuthAccountSnapshot Task 1 → referenced throughout).
- [ ] No new top-level config file (everything piggybacks on `accounts.json`).
- [ ] Decryption of credentials stays on the main side; renderer never sees token bytes.
- [ ] Tests use `vi.mock` for Electron APIs per CLAUDE.md convention.
- [ ] No `\u{...}` Unicode escapes in JSX.
- [ ] No em dashes in user-facing copy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
