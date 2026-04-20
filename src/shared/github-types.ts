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
  /** Pre-scanned issue numbers referenced in the PR body (#N, closes #N,
   * owner/repo#N), deduped. Sized by the source PR's `body` field at
   * sync time so the renderer doesn't re-parse on every context build. */
  bodyRefs?: number[]
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
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null
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
  primaryIssue?: {
    number: number
    repo?: string
    title?: string
    state?: 'open' | 'closed'
    assignee?: string
  }
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
