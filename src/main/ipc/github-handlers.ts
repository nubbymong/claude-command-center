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
import {
  fetchPRByBranch,
  fetchPRReviews,
  fetchWorkflowRuns,
} from '../github/client/rest-fallback'
import {
  SyncOrchestrator,
  type SyncStateEvent,
} from '../github/session/sync-orchestrator'
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

  // Still stubs — real implementations require section-side machinery
  // (transcript reader, merge/rerun/reply endpoint wrappers) that land in
  // PR 3b alongside the populated panel sections.
  ipcMain.handle(IPC.GITHUB_SESSION_CONTEXT_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(IPC.GITHUB_ACTIONS_RERUN, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_MERGE, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_READY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_REVIEW_REPLY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_NOTIF_MARK_READ, async () => ({ ok: true }))

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
