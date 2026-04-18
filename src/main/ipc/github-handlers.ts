import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { GitHubConfig, SessionGitHubIntegration } from '../../shared/github-types'
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
 * Data-path handlers (GITHUB_DATA_GET, GITHUB_SYNC_*, GITHUB_SESSION_CONTEXT_GET,
 * etc.) are intentional stubs here — they're wired to the sync orchestrator
 * in PR 3. Defining them now keeps the IPC surface complete so the renderer
 * doesn't see missing-channel errors during PR 2 dev.
 */
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
    const cur = (await configStore.read()) ?? emptyConfig()
    const next = { ...cur, ...patch }
    await configStore.write(next)
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
      sessions[idx] = {
        ...sessions[idx],
        githubIntegration: { ...current, ...patch },
      }
      await deps.saveSessions(sessions)
      return { ok: true }
    },
  )

  ipcMain.handle(IPC.GITHUB_LOCALGIT_GET, async (_e, cwd: string) => {
    const state = await readLocalGitState(cwd, defaultGitRun())
    return { ok: true, state }
  })

  // Stubs — real implementations land in PR 3 (sync orchestrator + sections).
  // Defined here so renderer doesn't see missing-channel errors during PR 2.
  ipcMain.handle(IPC.GITHUB_DATA_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(IPC.GITHUB_SESSION_CONTEXT_GET, async () => ({ ok: true, data: null }))
  ipcMain.handle(IPC.GITHUB_SYNC_NOW, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_SYNC_FOCUSED_NOW, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_SYNC_PAUSE, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_SYNC_RESUME, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_ACTIONS_RERUN, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_MERGE, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_PR_READY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_REVIEW_REPLY, async () => ({ ok: true }))
  ipcMain.handle(IPC.GITHUB_NOTIF_MARK_READ, async () => ({ ok: true }))
}
