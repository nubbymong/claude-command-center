import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { GitHubConfig, RepoCache, SessionGitHubIntegration } from '../../shared/github-types'
import type { SavedSession } from '../session-state'
import { GitHubConfigStore } from '../github/github-config-store'
import { AuthProfileStore } from '../github/auth/auth-profile-store'
import { ghAuthStatus, ghAuthToken, defaultGhRun } from '../github/auth/gh-cli-delegate'
import { requestDeviceCode, pollForAccessToken } from '../github/auth/oauth-device-flow'
import { verifyToken, probeRepoAccess } from '../github/auth/pat-verifier'
import { scopesToCapabilities } from '../github/auth/capability-mapper'
import { detectRepoFromCwd, defaultGitRun } from '../github/session/repo-detector'
import { readLocalGitState } from '../github/session/local-git-reader'
import { validateSlug } from '../github/security/slug-validator'
import { CacheStore } from '../github/cache/cache-store'
import { EtagCache } from '../github/client/etag-cache'
import { RateLimitShield } from '../github/client/rate-limit-shield'
import { githubFetch } from '../github/client/github-fetch'
import {
  fetchPRByBranch,
  fetchPRReviews,
  fetchWorkflowRuns,
} from '../github/client/rest-fallback'
import {
  SyncOrchestrator,
  type SyncStateEvent,
} from '../github/session/sync-orchestrator'
import { buildSessionContext } from '../github/session/session-context-service'
import { extractFileSignals } from '../github/session/tool-call-inspector'
import { scanTranscriptMessages } from '../github/session/transcript-scanner'
import { loadTranscriptEvents } from '../github/session/transcript-loader'
import {
  DEFAULT_FEATURE_TOGGLES,
  DEFAULT_SYNC_INTERVALS,
  GITHUB_CONFIG_SCHEMA_VERSION,
  OAUTH_SCOPES_PRIVATE,
  OAUTH_SCOPES_PUBLIC,
} from '../../shared/github-constants'

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

// Lightweight branch-only read for orchestrator registration. readLocalGitState
// runs status + stash + log + ahead/behind — far more than we need when we
// only want the current branch. A single `git rev-parse` is ~10x faster and
// keeps enable / startup / sync-now paths snappy.
async function readCurrentBranch(cwd: string | undefined): Promise<string> {
  if (!cwd) return 'main'
  try {
    const run = defaultGitRun()
    const out = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // Detached HEAD returns literal 'HEAD' — fall back to 'main' rather
    // than passing a non-branch name to the sync fetchers.
    return out && out !== 'HEAD' ? out : 'main'
  } catch {
    return 'main'
  }
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

/**
 * Registers IPC handlers for all GitHub-sidebar channels. The handlers are
 * the glue between renderer calls and the main-process modules in
 * src/main/github/**.
 *
 * Data-path handlers (GITHUB_DATA_GET, GITHUB_SYNC_*) now drive a live
 * SyncOrchestrator. The remaining stubs (SESSION_CONTEXT_GET, PR_MERGE,
 * ACTIONS_RERUN, REVIEW_REPLY, NOTIF_MARK_READ) depend on section-side
 * machinery that lands in PR 3b alongside the populated panel sections.
 */
export interface GitHubHandlersHandle {
  orchestrator: SyncOrchestrator
  resolveSessionIdFromWindow: () => string | null
  setFocusedSessionResolver: (fn: () => string | null) => void
}

export function registerGitHubHandlers(deps: RegisterDeps): GitHubHandlersHandle {
  const configStore = new GitHubConfigStore(deps.resourcesDir)
  const profileStore = new AuthProfileStore({
    readConfig: () => configStore.read(),
    writeConfig: (c) => configStore.write(c),
  })
  const activeFlows = new Map<string, OAuthFlow>()

  // Orchestrator dependencies. The RateLimitShield and EtagCache are shared
  // across all syncs — the shield tracks per-bucket reset times regardless
  // of slug, and the etag store is keyed by `METHOD path` which is already
  // unique per endpoint/slug. Persistence of etags across restarts can come
  // later; in-memory is fine for a running session.
  const cacheStore = new CacheStore(deps.resourcesDir)
  const shield = new RateLimitShield()
  const etagStore: Record<string, string> = {}
  const etags = new EtagCache(etagStore)

  let focusedSessionResolver: () => string | null = () => null

  // Authored-profile-id by sessionId. Populated at register-time (from
  // SavedSession) so fetchers don't need to re-read session-state.json on
  // every request. Previously the fetcher path did a full disk load for
  // every GitHub API call — at 3 requests per session per sync, that was
  // 3N reads per cycle.
  const profileIdBySession = new Map<string, string>()

  async function getTokenForSession(sessionId: string): Promise<string | null> {
    const profileId = profileIdBySession.get(sessionId)
    if (!profileId) return null
    return profileStore.getToken(profileId)
  }

  // tokenFn closes over a specific sessionId — orchestrator's catch turns a
  // throw into an 'error' sync state, which is the right UX when the user
  // hasn't selected an auth profile yet for this session.
  function makeTokenFn(sessionId: string) {
    return async () => {
      const t = await getTokenForSession(sessionId)
      if (!t) throw new Error('no-token')
      return t
    }
  }

  // Cache session cwds so getBranch doesn't hit disk on every sync tick.
  // Populated at register time alongside the profile id cache.
  const cwdBySession = new Map<string, string>()

  // In-memory config cache. scheduleNext() calls getConfig before every
  // timer arm — doing a disk-read + JSON parse each time was adding
  // filesystem I/O proportional to (sessions × tick rate). Invalidated
  // from the CONFIG_UPDATE handler below on every write.
  let cachedConfig: GitHubConfig | null | undefined
  async function getCachedConfig(): Promise<GitHubConfig | null> {
    if (cachedConfig !== undefined) return cachedConfig
    cachedConfig = (await configStore.read()) ?? null
    return cachedConfig
  }

  const orchestrator = new SyncOrchestrator({
    cacheStore,
    getConfig: getCachedConfig,
    emitData: (p) => deps.getWindow()?.webContents.send(IPC.GITHUB_DATA_UPDATE, p),
    emitSyncState: (p: SyncStateEvent) =>
      deps.getWindow()?.webContents.send(IPC.GITHUB_SYNC_STATE_UPDATE, p),
    getBranch: async (sessionId) => {
      const cwd = cwdBySession.get(sessionId)
      if (!cwd) return null
      try {
        const run = defaultGitRun()
        const out = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        return out && out !== 'HEAD' ? out : null
      } catch {
        return null
      }
    },
    fetchers: {
      pr: async (ctx) =>
        fetchPRByBranch(ctx.slug, ctx.branch, {
          tokenFn: makeTokenFn(ctx.sessionId),
          shield,
          etags,
        }),
      runs: async (ctx) =>
        fetchWorkflowRuns(ctx.slug, ctx.branch, {
          tokenFn: makeTokenFn(ctx.sessionId),
          shield,
          etags,
        }),
      reviews: async (ctx, prNumber) =>
        fetchPRReviews(ctx.slug, prNumber, {
          tokenFn: makeTokenFn(ctx.sessionId),
          shield,
          etags,
        }),
    },
  })

  ipcMain.handle(IPC.GITHUB_CONFIG_GET, async () => {
    return (await configStore.read()) ?? null
  })

  ipcMain.handle(IPC.GITHUB_CONFIG_UPDATE, async (_e, patch: Partial<GitHubConfig>) => {
    const cur = (await configStore.read()) ?? emptyConfig()
    const next = { ...cur, ...patch }
    await configStore.write(next)
    cachedConfig = next
    return next
  })

  ipcMain.handle(
    IPC.GITHUB_PROFILE_ADD_PAT,
    async (
      _e,
      input: {
        kind: 'pat-classic' | 'pat-fine-grained'
        label: string
        rawToken: string
        allowedRepos?: string[]
      },
    ) => {
      const v = await verifyToken(input.rawToken).catch(() => null)
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
    },
  )

  ipcMain.handle(IPC.GITHUB_PROFILE_ADOPT_GHCLI, async (_e, username: string) => {
    try {
      await ghAuthToken(username, defaultGhRun())
    } catch {
      return { ok: false, error: 'gh auth token failed' }
    }
    const id = await profileStore.addProfile({
      kind: 'gh-cli',
      label: username,
      username,
      scopes: [],
      capabilities: [
        'pulls',
        'issues',
        'contents',
        'statuses',
        'checks',
        'actions',
        'notifications',
      ],
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
    try {
      const v = await verifyToken(token)
      return v ? { ok: true, ...v } : { ok: false, error: 'invalid' }
    } catch {
      return { ok: false, error: 'transient' }
    }
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
        const v = await verifyToken(r.access_token).catch(() => null)
        if (!v) {
          activeFlows.delete(flowId)
          return { ok: false, error: 'verify-failed' }
        }
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
    } catch (err) {
      return { ok: false, error: String(err) }
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

  ipcMain.handle(
    IPC.GITHUB_SESSION_CONFIG_UPDATE,
    async (_e, sessionId: string, patch: Partial<SessionGitHubIntegration>) => {
      const sessions = await deps.loadSessions()
      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx < 0) return { ok: false, error: 'not-found' }
      const current: SessionGitHubIntegration = sessions[idx].githubIntegration ?? {
        enabled: false,
        autoDetected: false,
      }
      const merged: SessionGitHubIntegration = { ...current, ...patch }
      sessions[idx] = { ...sessions[idx], githubIntegration: merged }
      await deps.saveSessions(sessions)
      // Register or refresh the orchestrator's view of this session. On
      // disable/slug-clear, unregister so its timer doesn't keep firing.
      // registerSession already clears any prior timer for this id, so no
      // explicit unregister-then-register dance.
      if (merged.enabled && merged.repoSlug) {
        const branch = await readCurrentBranch(sessions[idx].workingDirectory)
        if (merged.authProfileId) profileIdBySession.set(sessionId, merged.authProfileId)
        else profileIdBySession.delete(sessionId)
        if (sessions[idx].workingDirectory) {
          cwdBySession.set(sessionId, sessions[idx].workingDirectory)
        }
        orchestrator.registerSession({
          sessionId,
          slug: merged.repoSlug,
          branch,
          integration: merged,
        })
        // If the user had this session focused before enabling integration,
        // setFocus was a no-op because the session wasn't registered yet.
        // Replay pending focus now so interval tiering (active vs bg) kicks
        // in without needing another tab switch.
        if (focusedSessionResolver() === sessionId) {
          orchestrator.setFocus(sessionId, true)
        }
      } else {
        profileIdBySession.delete(sessionId)
        cwdBySession.delete(sessionId)
        orchestrator.unregisterSession(sessionId)
      }
      return { ok: true }
    },
  )

  ipcMain.handle(IPC.GITHUB_LOCALGIT_GET, async (_e, cwd: string) => {
    const state = await readLocalGitState(cwd, defaultGitRun())
    return { ok: true, state }
  })

  ipcMain.handle(IPC.GITHUB_DATA_GET, async (_e, slug: string) => {
    const c = await cacheStore.load()
    const data: RepoCache | null = c.repos[slug] ?? null
    return { ok: true, data }
  })

  ipcMain.handle(IPC.GITHUB_SYNC_NOW, async (_e, sessionId: string) => {
    // Renderer may hit this before the orchestrator saw the session (e.g.
    // restart before restore completes, or renderer-first enable). Look up
    // the current integration and auto-register so manual refresh always
    // works rather than silently no-op'ing.
    const sessions = await deps.loadSessions()
    const session = sessions.find((s) => s.id === sessionId)
    const integration = session?.githubIntegration
    if (integration?.enabled && integration.repoSlug) {
      const branch = await readCurrentBranch(session?.workingDirectory)
      if (integration.authProfileId) profileIdBySession.set(sessionId, integration.authProfileId)
      if (session?.workingDirectory) cwdBySession.set(sessionId, session.workingDirectory)
      orchestrator.registerSession({
        sessionId,
        slug: integration.repoSlug,
        branch,
        integration,
      })
      if (focusedSessionResolver() === sessionId) {
        orchestrator.setFocus(sessionId, true)
      }
    }
    await orchestrator.syncNow(sessionId)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_SYNC_FOCUSED_NOW, async () => {
    const id = focusedSessionResolver()
    if (!id) return { ok: false, error: 'no-focused-session' }
    // Mirror SYNC_NOW: auto-register if the session has integration but
    // isn't tracked yet. Without this, the Settings > Sync button would
    // silently no-op when the focused session hadn't been sync-ed yet.
    const sessions = await deps.loadSessions()
    const session = sessions.find((s) => s.id === id)
    const integration = session?.githubIntegration
    if (!integration?.enabled || !integration.repoSlug) {
      return { ok: false, error: 'not-enabled' }
    }
    const branch = await readCurrentBranch(session?.workingDirectory)
    if (integration.authProfileId) profileIdBySession.set(id, integration.authProfileId)
    if (session?.workingDirectory) cwdBySession.set(id, session.workingDirectory)
    orchestrator.registerSession({
      sessionId: id,
      slug: integration.repoSlug,
      branch,
      integration,
    })
    orchestrator.setFocus(id, true)
    await orchestrator.syncNow(id)
    return { ok: true }
  })

  // Renderer pushes the active session id on every tab switch. We also use
  // this value as the focused-session resolver so SYNC_FOCUSED_NOW resolves
  // correctly without needing a separate session-state round-trip.
  ipcMain.on(IPC.GITHUB_FOCUS_CHANGED, (_e, sessionId: string | null) => {
    const prev = focusedSessionResolver()
    focusedSessionResolver = () => sessionId
    if (prev && prev !== sessionId) orchestrator.setFocus(prev, false)
    if (sessionId) orchestrator.setFocus(sessionId, true)
  })

  ipcMain.handle(IPC.GITHUB_SYNC_PAUSE, async () => {
    orchestrator.pause()
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_SYNC_RESUME, async () => {
    orchestrator.resume()
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_SESSION_CONTEXT_GET, async (_e, sessionId: string) => {
    const sessions = await deps.loadSessions()
    const session = sessions.find((s) => s.id === sessionId)
    const integration = session?.githubIntegration
    // Validate slug shape before interpolating into REST paths (enrichIssue,
    // below). session-state.json is author-trusted but has been machine-
    // round-tripped; a corrupted or hand-edited slug could otherwise build
    // an arbitrary API URL.
    if (!integration?.repoSlug || !validateSlug(integration.repoSlug)) {
      return { ok: true, data: null }
    }

    // Transcript scanning is opt-in per spec §10 — default off. Tool-call
    // signals (recent files edited via Read/Edit/Bash) come from a
    // separate, narrower inspector that never reads message bodies.
    const cfg = await getCachedConfig()
    const events = await loadTranscriptEvents(session?.workingDirectory)
    const recentFiles = extractFileSignals(events.toolCalls)
    const transcriptRefs = cfg?.transcriptScanningOptIn
      ? scanTranscriptMessages(events.messages)
      : []
    const branchName = await readCurrentBranch(session?.workingDirectory)
    const repoSlug = integration.repoSlug

    // PR bodyRefs are pre-scanned by the orchestrator at sync time (see
    // mapPR in sync-orchestrator.ts) so reading them here is a one-off
    // cache load. An empty or missing cache entry yields [] which keeps
    // the Session Context priority algorithm well-defined.
    const cacheSnap = await cacheStore.load()
    const prBodyRefs = cacheSnap.repos[repoSlug]?.pr?.bodyRefs ?? []

    const ctx = await buildSessionContext({
      branchName,
      transcriptRefs,
      prBodyRefs,
      recentFiles,
      sessionRepo: repoSlug,
      enrichIssue: async (repo, n) => {
        try {
          const r = await githubFetch(`/repos/${repo}/issues/${n}`, {
            tokenFn: makeTokenFn(sessionId),
            shield,
            etags,
          })
          if (!r.ok) return null
          const j = (await r.json()) as {
            title?: string
            state?: 'open' | 'closed'
            assignee?: { login?: string } | null
          }
          return {
            title: j.title,
            state: j.state,
            assignee: j.assignee?.login,
          }
        } catch {
          return null
        }
      },
    })
    return { ok: true, data: ctx }
  })

  // Helper: resolve a token for an action IPC. Every action needs a token
  // scoped to SOMETHING — the focused session for merge / rerun / reply, or
  // a specific profile id for notification mark-read. Missing token falls
  // back to error:'no-token' so the renderer surfaces the auth gap.
  function tokenFnForSession(sessionId: string) {
    return async () => {
      const t = await getTokenForSession(sessionId)
      if (!t) throw new Error('no-token')
      return t
    }
  }

  function tokenFnForProfile(profileId: string) {
    return async () => {
      const t = await profileStore.getToken(profileId)
      if (!t) throw new Error('no-token')
      return t
    }
  }

  ipcMain.handle(
    IPC.GITHUB_ACTIONS_RERUN,
    async (_e, slug: string, runId: number) => {
      if (!validateSlug(slug)) return { ok: false, error: 'invalid-slug' }
      // Fail fast on non-finite IDs — GitHub returns HTML error pages for
      // malformed paths which the shield-aware fetch would then parse as
      // a generic HTTP failure. Validating here gives a clearer error.
      if (!Number.isFinite(runId) || runId <= 0) {
        return { ok: false, error: 'invalid-run-id' }
      }
      const id = focusedSessionResolver()
      if (!id) return { ok: false, error: 'no-focused-session' }
      try {
        // rerun-failed-jobs re-runs only the failed jobs from the run, which
        // is the action users click 'Re-run' for 99% of the time. Use /rerun
        // (full re-run) instead if we later want a separate control.
        const r = await githubFetch(
          `/repos/${slug}/actions/runs/${runId}/rerun-failed-jobs`,
          { tokenFn: tokenFnForSession(id), shield, etags, method: 'POST' },
        )
        return r.ok
          ? { ok: true }
          : { ok: false, error: `http-${r.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    IPC.GITHUB_PR_MERGE,
    async (
      _e,
      slug: string,
      prNumber: number,
      method: 'merge' | 'squash' | 'rebase',
    ) => {
      if (!validateSlug(slug)) return { ok: false, error: 'invalid-slug' }
      if (!['merge', 'squash', 'rebase'].includes(method)) {
        return { ok: false, error: 'invalid-method' }
      }
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return { ok: false, error: 'invalid-pr-number' }
      }
      const id = focusedSessionResolver()
      if (!id) return { ok: false, error: 'no-focused-session' }
      try {
        const r = await githubFetch(`/repos/${slug}/pulls/${prNumber}/merge`, {
          tokenFn: tokenFnForSession(id),
          shield,
          etags,
          method: 'PUT',
          body: { merge_method: method },
        })
        return r.ok
          ? { ok: true }
          : { ok: false, error: `http-${r.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    IPC.GITHUB_PR_READY,
    async (_e, slug: string, prNumber: number) => {
      if (!validateSlug(slug)) return { ok: false, error: 'invalid-slug' }
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        return { ok: false, error: 'invalid-pr-number' }
      }
      const id = focusedSessionResolver()
      if (!id) return { ok: false, error: 'no-focused-session' }
      try {
        // Draft→ready canonically lives behind the GraphQL mutation
        // markPullRequestReadyForReview. First resolve the PR's GraphQL
        // node id via REST, then run the mutation.
        const prGet = await githubFetch(`/repos/${slug}/pulls/${prNumber}`, {
          tokenFn: tokenFnForSession(id),
          shield,
          etags,
        })
        if (!prGet.ok) return { ok: false, error: `http-${prGet.status}` }
        const prJson = (await prGet.json()) as { node_id?: string }
        if (!prJson.node_id) return { ok: false, error: 'no-node-id' }
        const gql = await githubFetch('/graphql', {
          tokenFn: tokenFnForSession(id),
          shield,
          etags,
          method: 'POST',
          bucket: 'graphql',
          baseUrl: 'https://api.github.com',
          body: {
            query: `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`,
            variables: { id: prJson.node_id },
          },
        })
        return gql.ok
          ? { ok: true }
          : { ok: false, error: `http-${gql.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    IPC.GITHUB_REVIEW_REPLY,
    async (_e, slug: string, threadId: string, body: string) => {
      if (!validateSlug(slug)) return { ok: false, error: 'invalid-slug' }
      if (!body || typeof body !== 'string') return { ok: false, error: 'empty-body' }
      const id = focusedSessionResolver()
      if (!id) return { ok: false, error: 'no-focused-session' }
      // threadId here is the root-comment id of the review thread (the shape
      // populated by PR 3c when fetchPRReviewComments is wired in). The
      // /comments/{id}/replies endpoint posts under the same thread.
      const commentId = Number(threadId)
      if (!Number.isFinite(commentId)) return { ok: false, error: 'invalid-thread-id' }
      try {
        const r = await githubFetch(
          `/repos/${slug}/pulls/comments/${commentId}/replies`,
          {
            tokenFn: tokenFnForSession(id),
            shield,
            etags,
            method: 'POST',
            body: { body },
          },
        )
        return r.ok
          ? { ok: true }
          : { ok: false, error: `http-${r.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    IPC.GITHUB_NOTIF_MARK_READ,
    async (_e, profileId: string, threadId: string) => {
      if (!profileId || !threadId) return { ok: false, error: 'missing-args' }
      // threadId is string-typed on the wire; reject anything other than a
      // strict positive integer to avoid path-traversal into unintended
      // endpoints. GitHub's notification thread ids are numeric.
      if (!/^[1-9]\d*$/.test(threadId)) return { ok: false, error: 'invalid-thread-id' }
      try {
        const r = await githubFetch(`/notifications/threads/${threadId}`, {
          tokenFn: tokenFnForProfile(profileId),
          shield,
          etags,
          method: 'PATCH',
        })
        return r.ok
          ? { ok: true }
          : { ok: false, error: `http-${r.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Kick off background registration for any session that already had
  // integration enabled when the app was closed. Fire-and-forget because
  // loadSessions hits disk and we don't want to block handler registration.
  void (async () => {
    try {
      const sessions = await deps.loadSessions()
      for (const s of sessions) {
        const integ = s.githubIntegration
        if (integ?.enabled && integ.repoSlug) {
          const branch = await readCurrentBranch(s.workingDirectory)
          if (integ.authProfileId) profileIdBySession.set(s.id, integ.authProfileId)
          if (s.workingDirectory) cwdBySession.set(s.id, s.workingDirectory)
          orchestrator.registerSession({
            sessionId: s.id,
            slug: integ.repoSlug,
            branch,
            integration: integ,
          })
          if (focusedSessionResolver() === s.id) {
            orchestrator.setFocus(s.id, true)
          }
        }
      }
    } catch {
      // Best-effort; if session state can't be read the orchestrator stays
      // empty and syncNow / config-update will register sessions on demand.
    }
  })()

  return {
    orchestrator,
    resolveSessionIdFromWindow: () => focusedSessionResolver(),
    setFocusedSessionResolver: (fn) => {
      focusedSessionResolver = fn
    },
  }
}
