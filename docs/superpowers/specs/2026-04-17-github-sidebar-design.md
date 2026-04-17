# GitHub Sidebar — Design Spec

Date: 2026-04-17
Branch: beta
Status: Approved design, ready for implementation plan

## 1. Goal & user value

Add a collapsible right-side panel that surfaces GitHub context for the active terminal session. The panel brings PR, CI, review, issue, and local-git signals into the app so users stop context-switching to the browser.

The panel is session-scoped — it follows the active session's working directory and its bound GitHub repo. A future enhancement adds a multi-session overview toolbar button (deferred to v1.x).

Design principle: the panel must be useful in increasing tiers of auth. With no auth it shows local git state and agent-intent preview. With GitHub auth it adds the full PR/CI/review cockpit. Features unlock progressively, never failing silently.

## 2. Auth — three-tier model

Each tier produces the same `AuthProfile` abstraction. The rest of the system is auth-kind-agnostic.

### Tier 1 — `gh` CLI delegation (zero setup)

- On startup, main runs `gh auth status` to enumerate authed accounts.
- For each detected account, an `AuthProfile` with `kind: 'gh-cli'` is created automatically.
- Tokens are fetched fresh per API call via `gh auth token --user <username>`; never cached to disk.
- Multi-account comes free — gh CLI supports `gh auth login --user <other>` and `gh auth switch`.

Fail mode: if `gh` binary is missing, or no accounts are authed, the UI shows an inline hint pointing to Tier 2/3.

### Tier 2 — OAuth device flow

- One OAuth App registered under the Conductor distributor's GitHub account. Client ID shipped in the bundle as a public constant (RFC 8628 public client). No client secret anywhere.
- Client ID: `Ov23liOJO5KaUDD9D1bY`
- User clicks **Sign in with GitHub** → device flow → scoped `public_repo read:org notifications` (public-repo default) or `repo read:org notifications` (when user toggles "I work on private repos").
- Device code displayed with a one-click **Open GitHub** button → default browser opens `https://github.com/login/device` with the code pre-filled where possible.
- On approval, main stores the token via `safeStorage` (OS keychain) keyed by profile id.

### Tier 3 — PAT (advanced)

For users whose orgs block OAuth apps, or who want per-repo fine-grained scoping.

Supported:
- Fine-grained PAT — user provides the `owner/repo` set it covers; verified via probe calls.
- Classic PAT — used for Checks API read (fine-grained cannot currently access Checks) and for Notifications (fine-grained has no notifications scope).

User flow: paste token → main verifies against `/user` and `/rate_limit` → stores via `safeStorage`.

### Capability routing

Each `AuthProfile` carries a derived `capabilities` array (`pulls`, `issues`, `contents`, `statuses`, `checks`, `actions`, `notifications`, `discussions`). When the app calls a GitHub endpoint, it picks the first profile bound to the session whose capabilities cover the endpoint. Fallback ordering:

1. Session's preferred profile (from per-session config)
2. Global default profile
3. Any profile that can cover the endpoint

If no profile can cover an endpoint, the relevant panel section shows an "Add a token with X capability" CTA.

## 3. Data model

New file `github-config.json` (under the active resources directory, alongside `tokenomics.json`).

```ts
GitHubConfig {
  authProfiles: Record<string, AuthProfile>
  defaultAuthProfileId?: string
  featureToggles: Record<GitHubFeatureKey, boolean>
  syncIntervals: {
    activeSessionSec: number   // default 60
    backgroundSec: number      // default 300
    notificationsSec: number   // default 180
  }
  enabledByDefault: boolean    // applied to new sessions
  lastSeenExpiry?: Record<string, number>  // per-profile expiry tracking
}

AuthProfile {
  id: string                             // uuid
  kind: 'gh-cli' | 'oauth' | 'pat-classic' | 'pat-fine-grained'
  label: string                          // user-editable
  username: string                       // from /user
  avatarUrl?: string
  scopes: string[]                       // granted scopes/permissions
  capabilities: Capability[]             // derived (see above)
  allowedRepos?: string[]                // fine-grained PATs only; owner/repo slugs
  tokenCiphertext?: string               // safeStorage output — NOT present for gh-cli
  ghCliUsername?: string                 // only for kind=gh-cli
  createdAt: number
  lastVerifiedAt: number
  lastAuthErrorAt?: number
  expiresAt?: number                     // from github-authentication-token-expiration header
  lastRateLimit?: { limit: number; remaining: number; resetAt: number }
}

Capability = 'pulls' | 'issues' | 'contents' | 'statuses' |
             'checks' | 'actions' | 'notifications' | 'discussions'
```

Per-session extension in `SessionConfig`:

```ts
session.githubIntegration?: {
  enabled: boolean
  repoUrl?: string                       // e.g. "https://github.com/nubbymong/claude-command-center"
  repoSlug?: string                      // derived "nubbymong/claude-command-center"
  authProfileId?: string                 // override; null = use default
  autoDetected: boolean                  // true if we filled repoUrl from git remote
  panelWidth?: number                    // per-session panel width memory
  collapsedSections?: Record<string, boolean>
}
```

New file `github-cache.json` for persistent cache:

```ts
GitHubCache {
  repos: Record<string /* owner/repo */, RepoCache>
  notifications?: {
    etag?: string
    lastFetched: number
    items: NotificationSummary[]
  }
}

RepoCache {
  etags: Record<string /* endpoint key */, string>
  lastSynced: number
  pr?: PRSnapshot              // active PR for current branch
  checks?: CheckRunSnapshot[]
  actions?: WorkflowRunSnapshot[]
  reviews?: ReviewSnapshot[]
  issues?: IssueSnapshot[]
  // sparse — only populated sections included
}
```

Cache survives app restarts. Panel renders instantly on app open from last known data; refresh runs in background.

## 4. Config page — GitHub tab

New tab in the existing Settings/Config UI. Layout (top to bottom):

**Master enable toggle**
- Big switch at top. When off, no GitHub API calls. Panel hidden.

**Auth profiles**
- List of existing profiles with avatar, username, label, kind badge, scopes summary, expiry (if any), rate-limit gauge.
- Actions per profile: Test (hits `/user` + `/rate_limit`), Rename, Remove.
- Primary CTA: **Sign in with GitHub** → Tier 2 device flow.
- Secondary: `▸ Advanced auth options` expands to Tier 1 (detected gh CLI accounts auto-listed) and Tier 3 (PAT paste forms for classic and fine-grained).

**Feature toggles (the educational piece)**
Each toggle shows:
- Feature name and one-line description
- Permissions required ("Needs: Pull requests (R), Actions (R)")
- Status: green if any auth profile covers it; grey with "Add auth to enable" if not

**Permissions summary (live)**
As toggles change, this summary updates — "Fine-grained PAT needs X/Y/Z" + "Classic PAT needs A/B/C" + "OAuth scopes needed: D/E/F". Helps users decide which auth path to take.

**Sync settings**
- Active session poll interval (dropdown: 30s / 1m / 2m / 5m)
- Background poll interval (dropdown: 2m / 5m / 10m / 15m)
- Notifications poll interval (dropdown: 1m / 3m / 5m / 10m)
- Pause syncs button (temporarily halt)
- Sync all now button (manual refresh across sessions)

Per-session GitHub settings do *not* live on this global page — they're in the existing session config drawer (a new GitHub tab/section there).

## 5. Session config (per-session GitHub settings)

New section/tab in the existing session config drawer:

- Enable integration toggle (defaults to global `enabledByDefault`)
- Repo URL input
  - Auto-populated from `git -C <cwd> remote get-url origin` on session creation/first config open
  - Editable; "Not a GitHub repo" option to explicitly disable
  - Validation: parses GitHub URLs including SSH, HTTPS, with/without `.git`
- Auth profile dropdown (auto-selected by repo owner match; user can override)
- Preferred panel width
- "Test connection" button — hits `/repos/{owner}/{repo}` with chosen auth, reports success/error inline

For SSH sessions: repo URL detection runs `ssh <host> git -C <remoteCwd> remote get-url origin`. Same UI flow.

## 6. Right panel — UI

### Panel shell

- Default width 340px; user-draggable (min 280, max 520)
- Collapse toggle → narrow 28px rail with GitHub mark + unread/problem badge
- Per-session width memory; collapsed section state persists per session
- `⌘/` or settings: toggle panel visibility globally

### Header strip (always visible)

Content:
- Branch chip (click → local branch list popover, allows switch)
- Ahead/behind counts vs origin
- Dirty-file dot count
- Sync state indicator: `● syncing`, `🟢 synced Xs ago`, `🟡 rate limited`, `🔴 error`
- Manual refresh button
- Overflow menu: collapse/expand all, open panel settings

### Sections (top to bottom)

Each section has a header `▼ Name [summary] [primary action]`. Click header toggles collapse. Empty sections collapse with `—` indicator so the user can see "nothing here" explicitly.

**Section 1 — Active PR**
- Auto-expanded when PR exists for current branch
- Title, author, draft state, age
- CI summary inline (pass/fail icons, total counts)
- Review state (approvals count, open threads count)
- Mergeable state (clean/conflict/blocked/unknown)
- Actions: Open in GitHub, Ready for Review (if draft), Merge dropdown (disabled if not mergeable with tooltip explaining why)

**Section 2 — CI / Actions**
- Workflow runs grouped by latest attempt per workflow
- Status icons per job
- Failed jobs expose inline one-line failure summary extracted from logs (Actions API `jobs/{id}/logs` endpoint tail-scanned)
- Click row → expand to show log tail (100 lines) with copy button
- Re-run button on failed runs (requires Actions: Read and write)

**Section 3 — Reviews & Comments**
- Unresolved threads grouped by file
- Avatar stack of approvers at top
- Click thread → opens DiffViewerPane (cherry-picked from beta's existing component) with comment anchored to the exact line
- Inline Reply composer (requires Pull requests: Read and write)
- Resolve button per thread (requires RW)

**Section 4 — Linked issues**
- Auto-detected from:
  - PR body `closes #N`, `fixes #N`, `resolves #N` patterns
  - Current branch name (e.g. `fix-247-login`)
  - Recent conversation in the active session's Claude transcript (regex scan of last 50 messages)
- For each: number, title, state, assignee
- Click → Open in GitHub

**Section 5 — Local git**
- Works without auth — always populated
- File-level breakdown: staged / unstaged / untracked (3 expandable lists)
- Click file → open local diff in DiffViewerPane
- Recent commits list (up to 5 ahead of origin); click commit → inline stats
- Stash count + Apply latest stash action

**Section 6 — Agent Intent** (reserved; full wiring deferred)
- Layout slot created in v1
- Full implementation depends on HTTP Hooks Gateway (separate feature)
- When active: previews Claude's pending git/gh tool call with Approve/Edit/Deny
- v1 renders this section only when a stub hook event is received; otherwise collapsed with "—"

**Section 7 — Notifications** (requires classic PAT with `notifications` scope OR OAuth flow)
- Unread count on section header
- Items: type (review request, mention, assignment), repo, title, time
- Actions: Mark read, Open in GitHub
- Hidden entirely if no auth profile provides `notifications` capability

### Error / edge states

| State | Panel behavior |
|---|---|
| No GitHub integration enabled for session | Empty state with "Enable GitHub integration" button |
| No auth configured | Sections 1–4, 7 show "Sign in to unlock" CTA; sections 5, 6 still work |
| Auth expired/revoked | Red banner: "sign-in for X expired — [Sign in again]"; stale data shown greyed |
| Rate limited (< 10% remaining) | Yellow banner, stale data visible, next-reset countdown |
| Private repo but auth only covers public | Inline warning: "This repo is private; auth doesn't cover it. [Upgrade auth]" |
| Not a git repo | Hide all sections; header shows "No git repo detected — [Set repo URL]" |
| Network error | Inline retry; cached data shown greyed with "last synced Xm ago" |

## 7. Rate-limit & sync strategy

Budgets:
- Classic PAT: 5000 req/hr per token
- Fine-grained PAT: 5000 req/hr per token per resource
- OAuth: 5000 req/hr per token
- Unauthenticated: 60 req/hr (we never hit this — panel stays in PAT-free local mode if no auth)

Techniques:

1. **ETag caching on every REST call.** Each response's `ETag` header is persisted per-endpoint in `github-cache.json`. Next request sends `If-None-Match: <etag>`. A 304 does not count against rate limit and returns no body — biggest single optimization.

2. **GraphQL for PR card.** One GraphQL query replaces ~4 REST calls (PR + checks + reviews + comments) per active session. Reduces rate-limit burn and latency. REST kept for operations GraphQL doesn't cover (log content, rerun actions).

3. **Tiered sync intervals (user-configurable):**
   - Active session (panel visible, session focused): default 60s
   - Inactive session (panel hidden or session unfocused): default 5 min
   - Notifications: default 3 min
   - Manual refresh: immediate

4. **Push-triggered sync.** Main watches session PTY buffers for patterns matching `git push` invocations. When detected, the relevant session's PR data resyncs immediately (bypasses interval). Same for `gh pr merge`, `gh pr create`.

5. **Rate-limit shield.** At < 10% remaining on any profile, pause all syncs using that profile. UI shows yellow banner with reset-time countdown. Resume automatically at reset.

6. **Cache-first render.** Panel always renders from cached data instantly on session switch/app start; refresh fires in background. Stale indicator shown if cache older than 2× the applicable sync interval.

7. **Exponential backoff on errors.** 5xx and transient 4xx → backoff up to 5 minutes per endpoint per profile. 401 → profile marked `lastAuthErrorAt`, syncs paused, user prompted to re-auth.

## 8. Onboarding

**Post-update modal (one-time)** — triggered when a user updates to the version that ships this feature.

Content:
- Screenshot showing the populated panel in use
- Three-step guide:
  1. "We auto-detect your repos per session — accept or edit."
  2. "Sign in with GitHub (or use `gh` CLI if you already have it) to unlock PR/CI/review data."
  3. "Enable per session at your own pace — nothing runs until you opt in."
- Primary CTA: "Set up now" → opens the new Config page → GitHub tab
- Secondary: "Later" → dismiss; setting accessible from toolbar any time
- "Don't show again" checkbox — one-shot unless explicitly toggled back on

**Auto-detect on session creation.** On new session (or existing session without `githubIntegration` set), main runs git-remote detection. Small non-modal banner in the session header offers: "Detected `owner/repo`. [Use this] [Edit] [Not a GitHub repo]". Detection runs once; dismissing is durable.

**Expiry warning (for expiring tokens).**

| Time to expiry | UI treatment |
|---|---|
| > 14 days | Muted expiry date in profile card |
| 7–14 days | Yellow warning badge on profile card |
| 2–7 days | Orange banner at top of panel: "X PAT expires in Y days — [Renew]" |
| < 2 days | Red persistent banner; also on app launch |
| Expired | Panel sections dependent on that profile show empty state; "Token expired — [Replace]" |

Expiry captured from `github-authentication-token-expiration` response header on every authenticated call — no extra API calls needed.

## 9. Feature → permissions matrix

Single source of truth for the Config page's educational text and for capability routing.

| Feature | Fine-grained PAT | Classic PAT | OAuth scopes | Available via gh CLI? |
|---|---|---|---|---|
| Active PR card | Pull requests (R) | `public_repo` or `repo` | `public_repo` or `repo` | Yes |
| CI — Actions | Actions (R), Actions (RW) for rerun | `public_repo` / `repo` + `workflow` for rerun | same | Yes |
| CI — Commit statuses | Commit statuses (R) | `public_repo` / `repo` | same | Yes |
| CI — Checks (third-party) | **unavailable** (fine-grained can't) | `public_repo` or `repo` | `public_repo` or `repo` | Yes |
| Reviews & comments | Pull requests (R) / (RW) | `public_repo` / `repo` | same | Yes |
| Linked issues | Issues (R) | `public_repo` / `repo` | same | Yes |
| Local git | n/a (no network) | n/a | n/a | Always |
| Notifications | **unavailable** (no scope exists) | `notifications` | `notifications` | Yes (if gh login included it) |
| Merge / close PR | Pull requests (RW) | `repo` | `repo` | Yes |
| Reply / resolve threads | Pull requests (RW) | `repo` | `repo` | Yes |
| Discussions | Discussions (R/RW) | `repo` | `repo` | Yes |

Known gaps:
- **Fine-grained + Checks** — GitHub removed this; feature falls back to classic PAT or OAuth or gh CLI. Panel shows hint when only fine-grained is available.
- **Fine-grained + Notifications** — no such scope exists. Same fallback.

## 10. Open-source security

Because the repo is public:

**Tokens never committed, never logged, never exposed to renderer.**
- All persistence via Electron `safeStorage` (OS keychain).
- IPC channels return `AuthProfile` metadata only (username, avatarUrl, scopes, expiry, rate-limit gauge). Never a raw token.
- A new logging redactor wraps the existing logger — any line containing a token-shaped string (`ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `Iv1.`, `Ov23li`) is masked before write/display.

**Public OAuth client ID is safe.**
- `GITHUB_OAUTH_CLIENT_ID` committed as a public constant in `src/shared/github-config.ts`.
- No client secret anywhere.
- Documented inline with a comment explaining RFC 8628 public-client pattern.

**URL allowlist.**
- `shell.openExternal` already restricted to `https://`. GitHub URLs only for this feature's external-open actions.
- All GitHub API base URLs constants, no user-controlled base URL input.

**Input validation.**
- Repo URLs parsed with a dedicated parser (handles HTTPS, SSH, `.git` suffix, `github.com` hostname only) → normalized `owner/repo` slug. Anything else rejected.
- Owner/repo slugs validated against `^[A-Za-z0-9-_.]+$` before being interpolated into URLs. Prevents SSRF via malformed input.

**Rate-limit shield.**
- See Section 7. No render-loop GitHub calls. All calls debounced and batched.

**gh CLI delegation safety.**
- Tokens fetched fresh per call via `gh auth token`, never cached to disk or memory beyond the outbound HTTP call.
- `gh` binary path discovered via `where gh` / `which gh`; no user-provided paths accepted.

**Dependency hygiene.**
- Use Node built-in `fetch` for all GitHub calls. No new runtime dep unless strictly necessary.
- If GraphQL client is needed, pick the smallest audited option (e.g., handwritten POST with fetch; no `@apollo/client` / `graphql-request` unless justified).

**Test coverage.**
- Unit: token redaction, URL parser, slug validator, capability routing, ETag cache, rate-limit shield.
- E2E: OAuth device flow (with stubbed GitHub endpoint), auth profile CRUD, expiry warning tiers, panel empty states.

## 11. Deferred to v1.x

These are deliberate scope cuts to keep v1 focused:

- **Multi-session overview** — toolbar button that shows every session's git state at once. Panel data already feeds this; only UI needed.
- **Agent Intent section wiring** — layout reserved; full behavior depends on HTTP Hooks Gateway feature (separate track).
- **Drag-reorder sections** — settles state model is already per-session; just needs DnD UI.
- **Projects v2 linked items** — low frequency of use; can ship later.
- **Cherry-pick / branch-compare UI** — advanced git operations.
- **Preview-pane, side-chat** (from abandoned v2 beta) — not part of this feature; out of scope.
- **In-app GitHub App installation flow** — v2 path for users who want Checks via fine-grained-equivalent scoping.

## 12. Verification checklist (pre-PR)

- `npm run build` passes
- `npm run typecheck` clean
- `npx vitest run` all pass
- Panel renders empty-state correctly with no auth, no integration, no git repo
- Panel renders populated sections with dev PAT/OAuth against `nubbymong/claude-command-center`
- Expiry banner appears on mock-clocked token (unit-tested)
- Rate-limit shield kicks in on simulated low quota
- Session switch re-renders panel within 100ms (cache-first)
- No token strings in log output across full exercise
- OAuth device flow completes against real GitHub (manual test)
- gh CLI delegation detects authed accounts on startup
- DiffViewerPane cherry-pick integrates without breaking local diff view

## 13. Work plan handoff

Next step: invoke `writing-plans` skill to produce a step-by-step implementation plan anchored to this spec. The plan will sequence:

1. Shared types + IPC channels
2. AuthProfile storage + safeStorage wiring + logging redactor
3. gh CLI delegation detection
4. OAuth device flow
5. PAT flow (fine-grained + classic)
6. Config page (auth profiles + feature toggles + permissions summary)
7. Per-session integration config (repo URL auto-detect + auth selector)
8. GitHub client layer (fetch + ETag + GraphQL + rate-limit shield)
9. Panel shell + section framework
10. Sections: Local git → Active PR → CI/Actions → Reviews → Linked issues → Notifications
11. DiffViewerPane cherry-pick
12. Onboarding modal + auto-detect banners
13. Expiry warnings + error states
14. Tests throughout, not at the end
15. PR to beta
