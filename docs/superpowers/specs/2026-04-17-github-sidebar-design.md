# GitHub Sidebar — Design Spec

Date: 2026-04-17 (rev 6)
Branch: beta
Status: Under review — iterating on PR #13. Implementation begins after PR #13 merges to main and beta is synced.

Rev history:
- rev 1 (initial) — internal review pass.
- rev 2 — addressed reviewer findings: removed DiffViewerPane dependency, dropped PTY push-trigger, notifications per-profile, gh CLI concurrency, factual rate-limit corrections, expanded security coverage, added Session Context section.
- rev 3 — second independent review pass: tightened tool-call inspection field allowlist, disambiguated Session Context vs Issues sections, expanded Session Context priority rules + SSH behavior + empty-session behavior, dropped Discussions from v1 scope, renamed `neverExpires` → `expiryObservable`, cache-corruption backup retention, `gh auth status` parsing approach documented.
- rev 4 — Copilot re-review pass: dropped `<img>` from markdown allowlist to match app CSP, added `seenOnboardingVersion` to the `GitHubConfig` data model, reconciled the "Master enable toggle" copy with `enabledByDefault`-only semantics, corrected GraphQL rate-limit budget (point/cost based, not requests/hour) and per-bucket shield math, removed a leftover `neverExpires` reference.
- rev 5 — Copilot 3rd pass (CSP ripple effects): explicit `dangerouslySetInnerHTML` carve-out for a single audited `SanitizedMarkdown` render site; sanitizer URL scheme policy narrowed to `https:` only; delegated anchor-click routing through `window.electronAPI.shell.openExternal`; avatar strategy standardized on initials monograms (no remote `<img>`, no CSP loosening); dedicated `GITHUB_SYNC_FOCUSED_NOW` IPC replaces the ambiguous empty-string sentinel; onboarding logic explicitly treats `'permanent'` as terminal opt-out.
- rev 6 — Copilot 4th pass: aligned status header with PR-review posture; narrowed `SessionGitHubIntegration.authProfileId` sentinel to `undefined` only (dropped `null` from spec prose); PR 3 rate-limit-aware `scheduleNext` race fixed (backoff timer no longer clobbered by outer `finally`); PR 2 feature toggle forced to `false` when capability becomes unavailable so config and UI stay consistent; PR 3 SSH repo detector contract documents `cwd` as shell-escape-required for any downstream use in `sendOneShot`.

## 1. Goal & user value

Add a collapsible right-side panel that surfaces GitHub context for the active terminal session. The panel brings PR, CI, review, issue, and local-git signals into the app so users stop context-switching to the browser.

The panel is session-scoped — it follows the active session's working directory and its bound GitHub repo. A future enhancement adds a multi-session overview toolbar button (deferred to v1.x).

**The differentiator** is session-aware interpretation: the panel reads the active session's Claude transcript (opt-in), git state, and Claude's tool calls to show "what is this session actually working on right now" — issue detected, files being edited, related PR — correlated with live GitHub state. This is explicitly surfaced as a **Session Context** section at the top of the panel.

Design principle: the panel must be useful in increasing tiers of auth. With no auth it shows local git state and (opt-in) session context. With GitHub auth it adds the full PR/CI/review cockpit. Features unlock progressively, never failing silently.

## 2. Auth — three-tier model

Each tier produces the same `AuthProfile` abstraction. The rest of the system is auth-kind-agnostic.

### Tier 1 — `gh` CLI delegation (zero setup)

- On startup, main runs `gh auth status 2>&1` (gh writes status to stderr) and parses lines matching `/Logged in to github\.com account (\S+)/` to enumerate authed accounts. The app **never uses `--show-token`** — tokens stay in gh's keychain, fetched per-call as below.
- For each detected account, an `AuthProfile` with `kind: 'gh-cli'` is created automatically.
- Tokens fetched fresh per API call via `gh auth token --user <username>` — `--user` is **mandatory**; the app never calls `gh auth switch` itself and never relies on the active-user state. This prevents races if the user runs `gh auth switch` in another terminal.
- Multi-account comes free — user runs `gh auth login --user <other>` once, the app picks it up on next detection.

Fail mode: if `gh` binary is missing, or no accounts are authed, the UI shows an inline hint pointing to Tier 2/3.

### Tier 2 — OAuth device flow

- One OAuth App registered under the Conductor distributor's GitHub account. Client ID shipped in the bundle as a public constant (RFC 8628 public client). No client secret anywhere.
- Client ID: `Ov23liOJO5KaUDD9D1bY`
- User clicks **Sign in with GitHub** → device flow. Scopes requested:
  - Public-repo default: `public_repo read:org notifications workflow`
  - Private-repo mode (when user toggles "I work on private repos"): `repo read:org notifications workflow`
  - `workflow` included because re-running Actions requires it. Discussions feature is deferred to v1.x — no `read:discussion` scope requested in v1 to avoid asking for permissions the panel doesn't use.
- Device code displayed with a one-click **Open GitHub** button opening `https://github.com/login/device`.
- On approval, main stores the token via `safeStorage` (OS keychain) keyed by profile id.

### Tier 3 — PAT (advanced)

For users whose orgs block OAuth apps, or who want per-repo fine-grained scoping.

Supported:
- Fine-grained PAT — user provides the `owner/repo` set it covers via the UI; verified by calling `/repos/{owner}/{repo}` with the token. 200 = covered; 401 = bad token; 403 or 404 = not covered. Results populate `allowedRepos`.
- Classic PAT — used for Checks API read (fine-grained cannot currently access Checks) and for Notifications (fine-grained has no notifications scope).

User flow: paste token → main verifies against `/user` and `/rate_limit` → stores via `safeStorage`.

### Capability routing

Each `AuthProfile` carries a derived `capabilities` array (`pulls`, `issues`, `contents`, `statuses`, `checks`, `actions`, `notifications`, `discussions`). When the app calls a GitHub endpoint, it picks the first profile whose capabilities cover the endpoint, in this order:

1. Session's preferred profile (from per-session config)
2. Global default profile (from global config)
3. Any profile covering the endpoint, preferring profiles already bound to the session's repo (owner match, or the repo present in `allowedRepos`)

If no profile can cover an endpoint, the relevant panel section shows a "Add a token with X capability" CTA referencing the Config page.

## 3. Data model

New file `github-config.json` (under the active resources directory, alongside `tokenomics.json`):

```ts
GitHubConfig {
  schemaVersion: number                   // bump on breaking changes; loader migrates or resets
  authProfiles: Record<string, AuthProfile>
  defaultAuthProfileId?: string
  featureToggles: Record<GitHubFeatureKey, boolean>
  syncIntervals: {
    activeSessionSec: number              // default 60, min 30
    backgroundSec: number                 // default 300
    notificationsSec: number              // default 180
  }
  enabledByDefault: boolean               // applied to new sessions
  transcriptScanningOptIn: boolean        // default false; see Section 10
  seenOnboardingVersion?: string          // app version at last onboarding dismissal,
                                          //   or 'permanent' for "Don't show again";
                                          //   unset means modal has never been shown.
                                          //   See Section 8 for trigger logic.
}

AuthProfile {
  id: string
  kind: 'gh-cli' | 'oauth' | 'pat-classic' | 'pat-fine-grained'
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: Capability[]
  allowedRepos?: string[]                 // fine-grained PAT only; owner/repo slugs
  tokenCiphertext?: string                // safeStorage output; absent for kind=gh-cli
  ghCliUsername?: string                  // only for kind=gh-cli
  createdAt: number
  lastVerifiedAt: number
  lastAuthErrorAt?: number
  expiresAt?: number                      // present only for fine-grained PAT & tokens returning the header
  expiryObservable: boolean               // true if we can observe expiry (fine-grained PAT); false otherwise.
                                          // OAuth/gh-cli/classic-no-expiry set this false; UI hides expiry field and
                                          // shows rate-limit + last-verified instead. Revocation still detected via 401.
  rateLimits?: {
    core?: RateLimitSnapshot
    search?: RateLimitSnapshot
    graphql?: RateLimitSnapshot
  }
}

RateLimitSnapshot { limit: number; remaining: number; resetAt: number; capturedAt: number }

Capability = 'pulls' | 'issues' | 'contents' | 'statuses' |
             'checks' | 'actions' | 'notifications' | 'discussions'
```

**Semantics of `SessionConfig.githubIntegration.authProfileId`:** `undefined` (the field is absent, or cleared to `undefined`) means "use capability routing fallback" — the session still gets auth if a profile can serve it. `null` is not a valid value; code must treat an unset preference as `undefined` only. `enabled: false` is the explicit opt-out.

Per-session extension in `SessionConfig`:

```ts
session.githubIntegration?: {
  enabled: boolean
  repoUrl?: string
  repoSlug?: string                       // derived, normalized owner/repo
  authProfileId?: string                  // explicit preference; absent/undefined = use fallback (null is not a valid value)
  autoDetected: boolean
  panelWidth?: number
  collapsedSections?: Record<string, boolean>
  dismissedAutoDetect?: boolean           // once dismissed, never re-prompt
}
```

Cache at `github-cache.json`:

```ts
GitHubCache {
  schemaVersion: number
  repos: Record<string /* owner/repo */, RepoCache>
  notificationsByProfile: Record<string /* profileId */, NotificationsCache>
  lru: string[]                           // owner/repo in access order; oldest first
}

RepoCache {
  etags: Record<string /* endpoint key */, string>
  lastSynced: number
  pr?: PRSnapshot
  actions?: WorkflowRunSnapshot[]
  reviews?: ReviewSnapshot[]
  issues?: IssueSnapshot[]
  statuses?: StatusSnapshot[]
  checks?: CheckRunSnapshot[]             // only populated when a profile with 'checks' capability served the call
  accessedAt: number                      // for LRU
}

NotificationsCache {
  etag?: string
  lastFetched: number
  items: NotificationSummary[]
}
```

**Cache size + corruption policy:**
- Soft cap: 50 repos in `repos` map. On exceed, LRU eviction runs at save time.
- Hard cap: 10 MB JSON size. On exceed, prune aggressively (evict half LRU) and log.
- Load failure (JSON parse error / schema version unknown): back up broken file to `github-cache.corrupt-<timestamp>.json`, start fresh, log once. Never throw — cache is a performance optimization, the panel runs without it.
- **Backup retention:** keep at most the **3 most recent** `.corrupt-*.json` files per cache kind. On each corruption event, after writing the new backup, delete older ones beyond that limit. Prevents disk bloat from repeated corruption (e.g., disk-full scenarios).

Cache survives app restarts. Panel renders instantly on app open from last known data; refresh runs in background.

## 4. Config page — GitHub tab

New tab in the existing Settings/Config UI.

**Default enabled for new sessions** — toggle at top. Controls `GitHubConfig.enabledByDefault` only.
- When on: newly created sessions start with GitHub features enabled.
- When off: newly created sessions start with GitHub disabled until explicitly enabled for that session.
- Existing sessions keep their current per-session `enabled` state — changing this setting does not retroactively hide the panel or stop activity for already-created sessions. Panel visibility, API calls, and scanning are driven by the per-session `SessionGitHubIntegration.enabled` flag.
- To fully disable GitHub activity globally, the user removes all auth profiles (no profile → no calls) and disables the feature toggles — there is no separate global kill-switch in v1.

**Auth profiles list**
- Per profile: avatar (initials badge per §9 avatar strategy — no remote `<img>`), username, label, kind badge, scopes summary, expiry (shown only when `expiryObservable` is true on the profile), rate-limit gauge (core bucket).
- Per-profile actions: Test (hits `/user` + `/rate_limit`), Rename, Remove.
- Primary CTA: **Sign in with GitHub** → Tier 2 device flow.
- Secondary: `▸ Advanced auth options` expands to show detected gh CLI accounts (auto-listed, one-click "Use this") and PAT paste forms (fine-grained + classic).

**Feature toggles (educational)**
Each toggle shows:
- Feature name + one-line description.
- Required permissions ("Pull requests (R), Actions (R)").
- **Availability state per profile**: green check if at least one profile has the capability; greyed with disabled toggle + tooltip "*Add a token with X capability (e.g., classic PAT with `notifications` scope)*" otherwise.
- Toggles whose required capability is unreachable are disabled; never enabled-with-silent-fallback.

**Permissions summary (live)**
As toggles change, a panel below updates:
- "Fine-grained PAT needs: Pull requests (R), Issues (R), ..."
- "Classic PAT needs: `notifications`, `public_repo`, ..."
- "OAuth scopes needed: `public_repo`, `notifications`, `workflow`, ..."

**Privacy & scanning**
- **Transcript scanning toggle** (default **off**). Copy: *"Scan this session's Claude conversation for GitHub issue/PR references. Local only — never sent to GitHub. Detection helps the Session Context section match what you're working on."* Links to the detection regex documentation.
- With toggle off: Session Context section uses only git state (branch, files Claude edited via tool-call inspection).
- With toggle on: also scans recent user+assistant messages for `#NNN`, `GH-NNN`, and GitHub URL patterns. All detected references rendered as plain text.

**Sync settings**
- Active session poll (dropdown: 30s / 1m / 2m / 5m)
- Background poll (dropdown: 2m / 5m / 10m / 15m)
- Notifications poll (dropdown: 1m / 3m / 5m / 10m)
- **Pause syncs** (temporarily halt across sessions)
- **Sync active session now** — debounced (min 5s between clicks), only refreshes the currently active session's repo. Explicitly *not* "sync every session" to avoid rate-limit burn.

**No telemetry** — explicit note at the bottom of the page: *"This feature does not send any usage data to Anthropic or third parties. All requests go to github.com using your configured auth."*

Per-session GitHub settings live in the existing session config drawer (Section 5), not here.

## 5. Per-session integration config

New section/tab in the existing session config drawer:

- Enable integration toggle (defaults to global `enabledByDefault`).
- Repo URL input
  - Auto-populated from `git -C <cwd> remote get-url origin` on session creation/first config open.
  - Parser accepts HTTPS, SSH, `git@...`, `.git` suffix. Hostname must be `github.com` (or enterprise configured — out of scope v1). Output normalized to `owner/repo`.
  - Validation: `owner` matches `^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$`; `repo` matches `^[A-Za-z0-9._-]+$` and is not `.` or `..`. Invalid input rejected with inline error.
  - "Not a GitHub repo" option to explicitly disable.
- Auth profile dropdown — auto-selected by matching the session's `repoSlug` against each profile's `allowedRepos` (for fine-grained) or `username` (for others). User can override.
- Preferred panel width.
- "Test connection" — hits `/repos/{owner}/{repo}` with chosen auth, reports success/error inline.
- SSH sessions: repo URL detection runs over the SSH pty (`git -C <remoteCwd> remote get-url origin`). Same parser and validation.

## 6. Right panel — UI

### Panel shell

- Default width 340px; user-draggable (min 280, max 520).
- Collapse toggle → 28px rail with GitHub mark + unread/problem badge.
- Per-session width memory; collapsed section state persists per session.
- Keyboard shortcut `Ctrl+/` (Windows/Linux) / `⌘+/` (macOS) toggles panel visibility globally.

### Header strip (always visible)

- Branch chip (click → local branch list popover, allows switch).
- Ahead/behind counts vs origin.
- Dirty-file dot count.
- Sync state indicator: `● syncing`, `🟢 synced Xs ago`, `🟡 rate limited`, `🔴 error`.
- Manual refresh button.
- Overflow menu: collapse/expand all, open Config page.

### Sections (top to bottom)

Each has `▼ Name [summary] [primary action]`. Click header toggles collapse. Empty sections collapse to `—` indicator by default.

**Section 1 — Session Context** (session-aware interpretation)

The "what is this session working on right now" view. **Single primary item per category** — the Issues section handles exhaustive lists (see Section 5 below for the disambiguation).

Content:

- **Primary detected issue** — *one* issue chosen by priority:
  1. Branch name matches `^(?:fix|feat|feature|issue|chore|bug)[-_/](\d+)` or bare `^(\d+)[-_]` patterns.
  2. Most recently mentioned issue in transcript (only if transcript-scanning toggle is ON).
  3. Issue referenced by `closes|fixes|resolves #NNN` in the linked PR body.
  Title/state/assignee rendered when OAuth is available; text-only `#NNN` fallback otherwise. If signals disagree, the priority above wins; a small `▸ Other signals (N)` expander lists the non-winning ones.

- **Files Claude recently edited** — derived from session tool-call inspection. **Exact field allowlist (no other tool-call fields are read):**
  - `Read`, `Write`, `Edit`, `NotebookEdit`, `MultiEdit`: `file_path` argument
  - `Bash`: the **first token** of the `command` argument only (to categorize), plus extracted path-like arguments when the first token is `git`, `gh`, `cat`, `rm`, `mv`, `cp`, `ls`, `mkdir` (path-arg regex: `^(?:/|~|\./|\.\./|[A-Za-z]:|\w+/)`)
  - Nothing else is inspected. `old_string`, `new_string`, command bodies beyond the first token, tool-call *results*, assistant message text — never read by this path.
  - **Cap:** last 20 *distinct* file paths within the last 100 tool calls or last 30 minutes, whichever cap hits first.

- **Active PR for this branch** — derived from session's branch + repo; OAuth-gated. Shows the number + state only (not full CI; that's Section 2).

- **Brand-new session behavior** — if no transcript events exist yet, render whatever local-git + OAuth-enrichment signals are available (branch name, PR for branch). The section is never blank unless the session has no git repo AND no auth.

- **When nothing detectable** — collapses to "No session context yet" placeholder (keeps the section visible so users know the detection is running).

- **SSH session behavior** — tool-call inspection works identically (tool calls live in the local JSONL transcript regardless of where the pty runs). Local git state comes from the same SSH mechanism as repo-URL detection (Section 5).

**Section 2 — Active PR**
- Title, author, draft state, age.
- CI summary inline (pass/fail icons + counts).
- Review state (approvals count, open-threads count).
- Mergeable state (clean/conflict/blocked/unknown).
- Actions: Open in GitHub, Ready for Review (if draft), Merge dropdown. Merge methods filtered to those the repo allows (fetched from `/repos/{owner}/{repo}` settings). If no method is allowed or user lacks RW, dropdown hidden.

**Section 3 — CI / Actions**
- Workflow runs grouped by latest attempt per workflow.
- Per job: status icon, duration.
- Failed jobs expose inline one-line failure summary extracted from logs (Actions API `jobs/{id}/logs` endpoint, tail-scanned). **All log content treated as untrusted** and sanitized before render.
- Click row → inline log tail (100 lines) with copy button.
- Re-run button on failed runs (requires `workflow` OAuth scope / `Actions: RW` fine-grained / `repo`+`workflow` classic).

**Section 4 — Reviews & Comments**
- Unresolved threads grouped by file.
- Avatar stack of approvers at top.
- Per thread: commenter, file:line anchor, comment body rendered as **sanitized markdown → HTML** (allowlist: links, code, lists, emphasis; image tags are stripped and rendered as link text per §9; no raw HTML), `[Reply]` inline composer (requires RW), `[View in GitHub]` link-out.
- No inline diff viewer in v1. Click-through to GitHub for full context.

**Section 5 — Issues**

**Exhaustive list** of all issues linked to the active PR or the current branch. Contrast with Session Context (Section 1), which shows only the *single primary* issue the session is working on.

- Linked issues detected from:
  - PR body (`closes #N`, `fixes #N`, `resolves #N`).
  - Branch name (e.g. `fix-247-login` → #247).
  - (Opt-in) recent Claude transcript in the session — **all** matched references, not just the primary.
- Per issue: number, title, state, assignee.
- Click → Open in GitHub.
- **Deduplication with Session Context:** if an issue appears as primary in Section 1, it also appears here (for completeness) but with a small `primary` badge so the user knows the two sections agree.

**Section 6 — Local git** (works without auth)
- File-level breakdown: staged / unstaged / untracked (three expandable lists).
- Click file → no inline diff in v1 (open in OS default git UI via `shell.openExternal` to a local file-diff URL is not a thing; v1 just shows the file path; optional copy-path action).
- Recent commits list (up to 5 ahead of origin); click commit → inline message + stats.
- Stash count + Apply latest stash action.

**Section 7 — Notifications** (requires `notifications` capability)
- Unread count in section header.
- Items: type (review request / mention / assignment), repo, title, time.
- Actions: Mark read, Open in GitHub.
- Cache and render are keyed by the profile that served the call (`NotificationsCache` per-profile). When multiple profiles have `notifications` capability, the section shows a profile selector at the top; default is the session's preferred profile.

**Section 8 — Agent Intent** (reserved; deferred)
- Layout slot created in v1; collapsed with "Deferred — activates with HTTP Hooks Gateway".
- Full behavior depends on HTTP Hooks Gateway (separate feature track).

### Error / edge states

| State | Behavior |
|---|---|
| No GitHub integration enabled for session | Empty panel with "Enable GitHub integration" CTA |
| No auth configured | Sections 2–5, 7 show "Sign in to unlock"; sections 1, 6 work (1 partial, 6 full) |
| Auth expired/revoked | Red banner with "[Sign in again]"; stale data greyed |
| Rate limited (<10% core bucket) | Yellow banner, stale visible, next-reset countdown |
| Private repo, only public-scope auth | Inline warning "[Upgrade auth]" |
| Not a git repo | Hide sections; header prompts "Set repo URL" |
| Network error | Inline retry; cached data shown greyed |
| Cache corrupt on load | Silent fallback (see Section 3 cache corruption policy); panel shows fresh-fetch state |

## 7. Rate-limit & sync strategy

Budgets (REST and GraphQL are separate buckets with different accounting models):
- **REST (core) primary limit:** Classic PAT / OAuth / Fine-grained PAT use the authenticated REST request budget, typically **5000 requests/hour** per user. This budget is request-count based. Secondary/abuse limits still apply per resource owner and burst pattern.
- **GraphQL primary limit:** budget separately from REST. GitHub's GraphQL API is **point/cost based per hour** (typically 5000 points/hr for authenticated use), not "requests/hour". One query may consume more than one point depending on query shape. Remaining budget must be tracked using the `rateLimit { cost, remaining, resetAt }` fields returned in the GraphQL response, not a request count.
- **Unauthenticated:** 60 REST req/hr for public endpoints only (we never rely on this — panel stays in auth-free local mode if no auth).

Techniques:

1. **ETag caching on every REST call.** Each response's `ETag` header is persisted per-endpoint in `RepoCache.etags`. Next request sends `If-None-Match`. **Conditional requests (304s) still count against the primary REST rate limit** — correction from rev 1. The real wins are bandwidth, latency, and secondary-limit avoidance. The REST shield math counts every outbound REST call regardless of status.

2. **GraphQL for PR card.** One GraphQL query covers PR + workflow runs + reviews + comments for a branch. REST used for log content, rerun actions, notifications (no GraphQL equivalent). **Budgeting note:** GraphQL throttling is per-query cost against the hourly point budget — one GraphQL operation must NOT be treated as equivalent to one REST request in implementation or tests. The shield for GraphQL reads `cost` + `remaining` from each query's `rateLimit` selection and pauses on that bucket independently of the REST core bucket. **Fallback:** if a GraphQL query returns permission errors for the configured auth, the panel falls back to equivalent REST calls automatically and logs once.

3. **Tiered sync intervals (user-configurable):**
   - Active session (panel visible + session focused): default 60s
   - Inactive session: default 5 min
   - Notifications: default 3 min
   - Manual refresh: immediate, debounced 5s

4. **Push-triggered sync — dropped from v1.** PTY buffer scanning is unreliable (false positives, same anti-pattern as the SSH paste-leak regex already tracked in the repo). Intervals + manual refresh cover v1. When HTTP Hooks Gateway ships, it becomes the correct mechanism for "Claude did a thing → app reacts"; the sync loop will expose a `refreshSession(sessionId)` hook for that integration.

5. **Per-bucket rate-limit shield.** Each profile's `rateLimits.{core,search,graphql}` tracked separately with the correct unit per bucket: `core`/`search` count **requests remaining**, `graphql` counts **points remaining** (sourced from the `rateLimit { remaining }` field in each GraphQL response). When any bucket used by the next request is < 10% of its own limit, pause syncs using that profile on that bucket only (REST and GraphQL budgets are independent; exhausting one does not pause the other). Yellow banner with reset time. Resume automatically at reset.

6. **Cache-first render.** Panel always renders from cached data instantly on session switch/app start; refresh fires in background. Stale indicator shown if cache older than 2× applicable sync interval.

7. **Exponential backoff on errors.** Transient errors → per-endpoint per-profile backoff up to 5 min. 401 → mark `lastAuthErrorAt`, pause syncs, prompt re-auth.

## 8. Onboarding

**Post-update modal.**

Trigger: on app launch, compare `GitHubConfig.schemaVersion === undefined OR seenOnboardingVersion !== currentAppVersion`. If either condition is true and the app is running the first version that ships this feature, show the modal. After dismissal, set `seenOnboardingVersion = currentAppVersion`. Fresh installs hit this too (unseen) and get onboarded.

Content:
- Screenshot of populated panel in use.
- Three-step guide:
  1. *"Auto-detect your repos per session — accept or edit."*
  2. *"Sign in with GitHub (or use `gh` CLI if authed) to unlock PR/CI/review data."*
  3. *"Enable per session at your own pace — nothing runs until you opt in."*
- Primary CTA: "Set up now" → opens Config page → GitHub tab.
- Secondary: "Later".
- "Don't show again" checkbox — sets `seenOnboardingVersion` to `'permanent'`.

**Auto-detect on session creation.** On new session (or existing session without `githubIntegration`), main runs git-remote detection. Non-modal banner in session header: *"Detected `owner/repo`. [Use this] [Edit] [Not a GitHub repo]"*. Once user interacts or dismisses, `dismissedAutoDetect = true` and we don't ask again for that session.

**Expiry warning** (fine-grained PATs and other tokens returning the `github-authentication-token-expiration` header):

| Time to expiry | Treatment |
|---|---|
| > 14 days | Muted expiry date in profile card |
| 7–14 days | Yellow warning badge on profile card |
| 2–7 days | Orange banner atop panel: "[Renew]" |
| < 2 days | Red persistent banner; also on app launch |
| Expired | Panel sections tied to profile show empty state; "Token expired — [Replace]" |

For profiles with `expiryObservable: false` (OAuth, gh CLI, classic without expiry), the expiry UI is hidden entirely — the profile shows its rate-limit gauge and last-verified date instead. Revocation is still detected at runtime via 401 responses; the "Sign in again" banner appears the same way.

Expiry data captured from the response header on every authenticated call — no extra API calls.

## 9. Feature → permissions matrix

Single source of truth for Config page educational text and capability routing.

| Feature | Fine-grained PAT | Classic PAT | OAuth scopes | `gh` CLI? |
|---|---|---|---|---|
| Active PR card | Pull requests (R) | `public_repo` or `repo` | `public_repo` or `repo` | Yes |
| CI — Actions status | Actions (R) | `public_repo` / `repo` | `public_repo` or `repo` | Yes |
| CI — Re-run workflow | Actions (RW) | `repo` + `workflow` | `workflow` (+ `public_repo`/`repo`) | Yes |
| CI — Commit statuses | Commit statuses (R) | `public_repo` / `repo` | `public_repo` or `repo` | Yes |
| CI — Checks (third-party) | **unavailable** | `public_repo` / `repo` | `public_repo` or `repo` | Yes |
| Reviews & comments | Pull requests (R / RW) | `public_repo` / `repo` | `public_repo` / `repo` | Yes |
| Linked issues | Issues (R) | `public_repo` / `repo` | `public_repo` / `repo` | Yes |
| Local git | n/a | n/a | n/a | Always |
| Session Context | n/a (detection) + any `pulls`+`issues` capable profile for enrichment | same | same | Yes |
| Notifications | **unavailable** | `notifications` | `notifications` | Yes (if login included) |
| Merge / close PR | Pull requests (RW) | `repo` | `repo` | Yes |
| Reply / resolve threads | Pull requests (RW) | `repo` | `repo` | Yes |

Known fine-grained PAT gaps (feature toggles disabled + tooltip when only fine-grained available):
- Checks API
- Notifications API

## 10. Open-source security

Repo is public. This section defines the trust boundary.

### Token handling

- All tokens persist via Electron `safeStorage` (OS keychain). Never written unencrypted to disk.
- IPC returns `AuthProfile` metadata only (username, avatarUrl, scopes, expiry, rate-limit gauges). Never a raw token.
- All GitHub HTTP happens in main. Renderer has no fetch path to github.com.
- gh CLI tokens fetched fresh per-call via `gh auth token --user X`, never cached to disk or memory beyond the outbound request.

### Logging redactor

A redaction wrapper sits in front of the existing logger. Any log line containing a token-shaped string is masked before write/display. Patterns:
- `ghp_[A-Za-z0-9]+` — classic PAT prefix
- `github_pat_[A-Za-z0-9_]+` — fine-grained PAT prefix
- `gho_[A-Za-z0-9]+` — OAuth user token prefix
- `ghu_[A-Za-z0-9]+` — OAuth user-to-server
- `ghs_[A-Za-z0-9]+` — GitHub App installation access token
- `ghr_[A-Za-z0-9]+` — refresh token
- `ghi_[A-Za-z0-9]+` — installation token (alternate prefix used by some flows)
- `access_token=[^&\s]+` — URL query parameter form

**Not redacted:** the public Client ID (`Ov23liOJO5KaUDD9D1bY`). It's a public identifier, redaction would harm debuggability.

### XSS & untrusted content

All GitHub-sourced content is treated as untrusted.

- Comment bodies: rendered as markdown via a sanitized pipeline (`marked` + `isomorphic-dompurify`). Tag allowlist: `<a>`, `<code>`, `<pre>`, `<ul>`, `<ol>`, `<li>`, `<em>`, `<strong>`, `<blockquote>`. Do **not** allow `<img>` — the app CSP restricts `img-src 'self' data: file:` (no `https:`), so remote images would not render and loosening CSP would expose a remote-image attack surface from untrusted comment content. Images in markdown source are rendered as their source-URL link text instead. No `<script>`, no inline event handlers, no `javascript:` href.
- Sanitizer URL scheme policy: allow `https:` only on `<a href>`. Strip `http:`, `mailto:`, `javascript:`, bare fragment `#`, and all other schemes — the renderer blocks `will-navigate` and `window.open`, so the only navigation that actually works is main-process `shell.openExternal(https://...)`.
- Anchor click routing: the single sanitized-HTML render site wraps its output in a container with a delegated `onClick` handler that intercepts `<a>` clicks, calls `event.preventDefault()`, validates the href is `https://`, and routes through `window.electronAPI.shell.openExternal(href)`. Non-https anchors are inert by design.
- Usernames, branch names, PR titles, issue titles, repo names, file paths: rendered as text, never `dangerouslySetInnerHTML`.
- Workflow log tails: rendered as plain text in a `<pre>` block; ANSI codes stripped.
- `dangerouslySetInnerHTML` policy: **forbidden everywhere in the feature's React tree except one audited render site** used to display already-sanitized markdown HTML from the approved sanitizer pipeline above. That render site must only accept sanitizer output (never caller-provided HTML) and must implement the anchor click routing described above. No other component in this feature may use `dangerouslySetInnerHTML`.
- Avatar strategy (applies everywhere avatars are shown: Config auth list, Reviews, PR author chip): the renderer must **not** load remote `https:` avatar URLs directly — CSP `img-src 'self' data: file:` blocks them and loosening CSP is out of scope. v1 uses a CSP-safe non-image fallback: a deterministic initials/monogram badge generated from the profile's `label`/`username` (2-char uppercase, Catppuccin-mantle background, centered text). A future enhancement may add main-process avatar proxying that converts remote avatars to `data:` URLs and caches them under the resources directory, but PR2/PR3 ship initials-only — no broken `<img>` placeholders, no silent CSP exceptions.

### SSRF / URL handling

- GitHub API base URL is a constant (`https://api.github.com`). User-supplied URLs are never used as API base.
- `shell.openExternal` remains restricted to `https://` (existing invariant).
- Owner/repo slugs validated with the regex in Section 5. Reject `.` and `..` as full names.

### Transcript scanning — privacy

- Default **off**. Opt-in via explicit toggle in Config page.
- When on: scans **last 50 user and assistant messages** of the active session's Claude transcript. **Only plain message text is read.** Tool call arguments (`old_string`, `new_string`, command bodies) and tool call results are never read by this scanner. (Note: the Session Context section inspects a narrow allowlist of tool-call *fields* — only `file_path` and first-token-of-command — via a separate code path. That is not transcript scanning; see Section 6 Section 1.)
- Detection regexes: `#(\d+)\b`, `\bGH-(\d+)\b`, `https?://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/(?:issues|pull)/(\d+)`.
- Matched references are rendered as `#N` or `owner/repo#N` text only — no message content excerpt is ever displayed in the panel.
- Scanning runs in main, results passed to renderer as normalized reference objects. Raw transcript content never crosses IPC for this feature.
- Scanning pauses automatically when the transcript-scanning toggle is off.

### Rate-limit shield

- See Section 7. No render-loop GitHub calls.
- All calls debounced and batched.
- Shield prevents runaway usage even on bugs in the sync loop.

### Dependency hygiene

- Node built-in `fetch` for HTTP. No `axios`, no wrapper libs.
- Markdown + sanitizer: `marked` + `DOMPurify` (audited, maintained).
- No new full-framework deps.

### Tests

- Unit: token redaction coverage, URL/slug validator, owner/repo parser edge cases, capability routing, ETag cache, rate-limit shield, cache corruption fallback, transcript scanner regex set.
- Contract: mock GitHub responses for PR/CI/Review/Issue rendering.
- E2E: OAuth device flow (stubbed endpoint), auth profile CRUD, expiry warning tiers, panel empty states, sanitization of a comment containing `<script>` and `javascript:` href.

### Accessibility

Panel is a secondary navigation surface. Commits:
- All interactive elements have keyboard focus and reachable tab order.
- Collapsible section headers use `<button>` with `aria-expanded`.
- Loading and error states are announced via `aria-live="polite"` regions.
- Avatar images have `alt` equal to username.
- Color is never the sole signal for state — pair with icon + text (e.g., CI fail = red `✗` plus "failed" text).

### No telemetry

This feature sends no usage data to Anthropic or third parties. Only destination is `github.com` using the user's configured auth. Explicit note shown in Config page footer.

## 11. Deferred to v1.x

- **Multi-session overview toolbar button** — scans every session at once.
- **Agent Intent section wiring** — slot reserved; behavior depends on HTTP Hooks Gateway.
- **PTY push-trigger sync** — replaced by HTTP Hooks integration when that ships.
- **Drag-reorder sections.**
- **Projects v2 linked items.**
- **Cherry-pick / branch-compare UI.**
- **Inline diff viewer** — gets its own spec when we decide to build it. Would serve multiple surfaces (local git, PR review, agent-intent previews) and deserves independent scoping.
- **GitHub App installation** — for users who want Checks via properly-scoped app permissions.
- **Discussions support** — removed from v1 after review (no panel section consumed the `read:discussion`/`write:discussion` OAuth scopes). Add later with a dedicated panel section if user demand materializes.

## 12. Verification checklist (pre-PR)

- `npm run build` passes
- `npm run typecheck` clean
- `npx vitest run` all pass
- Panel renders empty-state correctly with: no auth, no integration, no git repo
- Panel renders populated with dev OAuth against `nubbymong/claude-command-center`
- Session Context surfaces issue from branch name; with transcript-opt-in enabled, also from `#N` in messages
- Expiry banner appears on mock-clocked fine-grained token (unit-tested)
- Rate-limit shield kicks in on simulated low quota (per-bucket)
- Session switch re-renders panel within 100ms (cache-first)
- No token strings in log output across full exercise (redactor coverage test)
- OAuth device flow completes against real GitHub (manual test)
- gh CLI delegation detects authed accounts on startup; `gh auth switch` in another terminal doesn't poison the app (explicit test)
- Sanitization test: malicious comment body `<script>alert(1)</script>` + `<a href="javascript:...">` renders safely
- Cache corruption test: manually break `github-cache.json` → app starts cleanly, logs once, backs file up, cache starts fresh
- Cache backup retention: simulate 5 corruption events → only 3 most recent `.corrupt-*.json` remain
- Transcript scanning disabled by default; enabling toggle + resyncing surfaces detected issues
- Feature toggles for Checks/Notifications on fine-grained-only: disabled with tooltip; adding a classic PAT enables them

## 13. Work plan handoff

Next step: invoke `writing-plans` skill to produce the step-by-step plan anchored to this spec.

Branch strategy:
- Work lands on `feature/github-sidebar` branched off current `beta` tip.
- PR target: `beta` (not `main` directly). Scoped PR = reviewable diff for Copilot and human reviewers.
- After merge to `beta`, a separate beta → main PR cuts the release when the line is ready.

Rough plan sequencing (the plan will refine with granular steps and tests):

1. Shared types + IPC channels.
2. AuthProfile storage + `safeStorage` wiring + logging redactor + redaction tests.
3. `gh` CLI delegation (detection + `--user`-only token fetching + race tests).
4. OAuth device flow.
5. PAT flow (fine-grained + classic).
6. Config page (auth profiles + feature toggles + permissions summary + privacy toggles + sync settings).
7. Per-session integration config (repo URL auto-detect, parser, validator, auth dropdown).
8. GitHub client layer (fetch + ETag + GraphQL+REST fallback + per-bucket rate-limit shield + cache with LRU/corruption policy).
9. Panel shell + section framework (keyboard shortcut, width memory, collapse state).
10. Sections: Local git → Session Context → Active PR → CI/Actions → Reviews → Issues → Notifications.
11. Sanitization pipeline (marked + DOMPurify + allowlist + sanitize-on-input tests).
12. Onboarding modal + auto-detect banners + trigger state tracking.
13. Expiry warnings + error states + rate-limit banners.
14. Accessibility pass (focus, ARIA, color pairing).
15. Tests at every step, not at the end. Final contract + E2E pass.
16. PR → beta (Copilot review + code-reviewer agent pass before open).
