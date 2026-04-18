// src/shared/github-constants.ts
import type { Capability, GitHubFeatureKey } from './github-types'

// PUBLIC OAuth Client ID — safe to commit. RFC 8628 device flow = public client,
// no client secret needed. Do NOT add a client secret here.
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liOJO5KaUDD9D1bY'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device'

// GitHub's real owner/repo naming rules.
export const GITHUB_OWNER_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
export const GITHUB_REPO_NAME_REGEX = /^[A-Za-z0-9._-]+$/

// Session Context: branch name → issue number detection.
export const BRANCH_ISSUE_REGEXES: RegExp[] = [
  /^(?:fix|feat|feature|issue|chore|bug)[-_/](\d+)/,
  /^(\d+)[-_]/,
]

// Transcript scanner patterns (used with String.matchAll).
export const TRANSCRIPT_ISSUE_REGEX = /#(\d+)\b/g
export const TRANSCRIPT_GH_REGEX = /\bGH-(\d+)\b/g
export const TRANSCRIPT_URL_REGEX =
  /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)/g

// Token redactor patterns applied before any log write.
// Deliberately does NOT include the public OAuth Client ID (`Ov23li...`) —
// that is a public identifier and redacting it harms debuggability.
//
// Each pattern uses (?<![A-Za-z0-9]) / (?![A-Za-z0-9]) instead of \b, because
// \b does NOT fire between two word chars. Real-world log lines like
// `FOO_ghp_abc` or `MY_TOKEN=ghp_abc` must redact — `\b` fails the first.
//
// Minimum length {20,} prevents stray short test fixtures (e.g. 'ghp_X') from
// being redacted while matching every real GitHub token (all real tokens
// are 36+ chars after the prefix).
export const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])gho_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])ghu_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])ghs_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])ghr_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])ghi_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
  /access_token=[^&\s]+/g,
]

// Default sync intervals (seconds).
export const DEFAULT_SYNC_INTERVALS = {
  activeSessionSec: 60,
  backgroundSec: 300,
  notificationsSec: 180,
}

export const DEFAULT_FEATURE_TOGGLES: Record<GitHubFeatureKey, boolean> = {
  activePR: true,
  ci: true,
  reviews: true,
  linkedIssues: true,
  notifications: false, // requires notifications-capable auth
  localGit: true,
  sessionContext: true,
}

// OAuth scopes per repo-visibility mode.
export const OAUTH_SCOPES_PUBLIC = 'public_repo read:org notifications workflow'
export const OAUTH_SCOPES_PRIVATE = 'repo read:org notifications workflow'

// Scope → Capability mapping for classic PATs + OAuth tokens.
export const CLASSIC_PAT_SCOPE_CAPABILITIES: Record<string, Capability[]> = {
  repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  public_repo: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions'],
  workflow: ['actions'],
  notifications: ['notifications'],
}

// Fine-grained PAT permission → Capability mapping.
// 'checks' intentionally NOT present — GitHub removed the permission.
// 'notifications' intentionally NOT present — no such scope for fine-grained.
export const FINEGRAINED_PERMISSION_CAPABILITIES: Record<string, Capability[]> = {
  pull_requests: ['pulls'],
  issues: ['issues'],
  contents: ['contents'],
  statuses: ['statuses'],
  actions: ['actions'],
}

export const GITHUB_CONFIG_SCHEMA_VERSION = 1
export const GITHUB_CACHE_SCHEMA_VERSION = 1

export const CACHE_MAX_REPOS = 50
export const CACHE_MAX_BYTES = 10 * 1024 * 1024
export const CACHE_CORRUPT_BACKUPS_KEEP = 3
