import { create } from 'zustand'
import type { ProviderId, CodexOptions } from '../../shared/types'
import type { IdentityColorKey } from '../../shared/identity-colors'

export type SessionStatus = 'idle' | 'working' | 'complete' | 'error' | 'disconnected'
export type SessionType = 'local' | 'ssh'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'

export interface SSHConfig {
  host: string
  port: number
  username: string
  remotePath: string
  hasPassword?: boolean
  postCommand?: string
  hasSudoPassword?: boolean
  dockerContainer?: string  // Docker container name (enables docker cp for screenshots)
}

export interface Session {
  id: string
  configId?: string
  label: string
  /** User-assigned "work name" for this session, editable while it's open and
   *  persisted by id across restarts (until the session is closed in CCC).
   *  Display-only; renders in place of `label` when set. Empty/undefined =>
   *  fall back to the config-derived `label`. */
  customName?: string
  workingDirectory: string
  model: string
  color: string
  /** V2 identity colour: stable palette key. Authoritative over `color` at render time. */
  identityColorKey?: IdentityColorKey
  /** Pre-migration raw `color`, retained only when this record was migrated. */
  legacyColor?: string
  status: SessionStatus
  createdAt: number
  sessionType: SessionType
  shellOnly?: boolean  // Don't run Claude, just open a shell
  partnerTerminalPath?: string  // Optional partner shell terminal path
  partnerElevated?: boolean     // Run partner terminal as admin (requires gsudo)
  sshConfig?: SSHConfig
  contextPercent?: number
  needsAttention?: boolean
  costUsd?: number
  modelName?: string
  // Codex: reasoning effort label (e.g. "xhigh"). Always undefined for Claude sessions.
  reasoningEffort?: string
  linesAdded?: number
  linesRemoved?: number
  contextWindowSize?: number
  inputTokens?: number
  outputTokens?: number
  totalDurationMs?: number
  rateLimitCurrent?: number
  rateLimitCurrentResets?: string
  rateLimitWeekly?: number
  rateLimitWeeklyResets?: string
  rateLimitExtra?: {
    enabled: boolean
    utilization: number
    usedUsd: number
    limitUsd: number
  }
  /** Dynamic usage buckets from the statusline bridge (limits[] discovery). */
  usageBuckets?: import('../../shared/usage-types').UsageBucket[]
  /** Active-account email from the statusline bridge. Drives the coloured email chip.
   *  v1.5.9: no longer read by the renderer (the chip was removed). Field is kept so
   *  older saved state still hydrates without errors. */
  accountEmail?: string
  /** Identity-palette KEY computed in main via colourForEmail(); resolved to a theme hex at render.
   *  v1.5.9: also inert in the renderer for the same reason as `accountEmail`. */
  accountColour?: IdentityColorKey
  legacyVersion?: {                      // Pinned Claude CLI version
    enabled: boolean
    version: string
  }
  agentIds?: string[]                    // Agent template IDs for this session
  effortLevel?: EffortLevel
  /** True once a LIVE effort tick (statusline effort.level or the hooks effort
   *  gateway) has arrived for THIS session. The sidebar card gates its EffortPill
   *  on this so a spawn-time / persisted / default-guess effortLevel never shows
   *  before real data confirms it. Never persisted -- a restored session starts
   *  with this unset and shows no pill until the first live tick. */
  effortLive?: boolean
  /** LIVE Fast Mode flag from the statusline payload (fast_mode). Set ONLY by the
   *  statusline subscription, never at spawn and never persisted, so the card's ⚡
   *  bolt shows iff a real tick reports fast_mode:true. Distinct from the removed
   *  config-time ClaudeOptions.fastMode toggle. */
  fastMode?: boolean
  disableAutoMemory?: boolean
  /** P6: Claude opts in to the codex_review MCP tool for this session.
   *  Mirrors disableAutoMemory in shape (sparse boolean) and lifecycle. */
  enableCodexReview?: boolean
  /** T16: per-session CCC indexing opt-out. DEFAULT-TRUE (undefined = on).
   *  Mirrors the ClaudeOptions.loggingEnabled field at spawn time. */
  loggingEnabled?: boolean
  machineName?: string
  // Provider discriminator + Codex sub-options (Claude options live in the
  // top-level legacy fields above for now; Codex spawns need this struct).
  provider?: ProviderId
  /** v1.5.19: account profile this session runs under (CLAUDE_CONFIG_DIR). */
  profileId?: string
  /** T8b (bug #5): exact conversation to resume on app-relaunch (uuid + the
   *  cwd it ran in). Round-trips through SavedSession; passed as the `resume`
   *  spawn option for a restored session. In-session restart/switch self-capture
   *  in main and do NOT use these. */
  resumeUuid?: string
  resumeCwd?: string
  /** True only for an in-progress add-account login shell; drives the /login
   *  guidance banner. Cleared once the account is detected. */
  needsLogin?: boolean
  codexOptions?: CodexOptions
  // Optional per-session GitHub integration state. Hydrated from SavedSession
  // on restore so the panel can gate on the per-session `enabled` flag instead
  // of the global `enabledByDefault`. Shape lives in shared/github-types.ts.
  githubIntegration?: import('../../shared/github-types').SessionGitHubIntegration
}

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  isRestoring: boolean  // True while restoring sessions from saved state
  /** Id of the session whose name is currently being edited inline (tab).
   *  Ephemeral UI state — never persisted. null when no rename is in flight. */
  renamingSessionId: string | null

  addSession: (session: Session) => void
  removeSession: (id: string) => void
  setActiveSession: (id: string) => void
  updateSession: (id: string, updates: Partial<Session>) => void
  getSession: (id: string) => Session | undefined
  hasWorkingSessions: () => boolean  // Check if any session is actively working
  setRestoring: (restoring: boolean) => void
  restoreSessions: (sessions: Session[], activeId: string | null) => void
  /** Enter/leave inline-rename mode for a session (id) or clear it (null). */
  beginRename: (id: string | null) => void
  /** Commit a new custom name. Blank/whitespace clears it (reverts to `label`).
   *  Always exits rename mode. */
  renameSession: (id: string, name: string) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isRestoring: false,
  renamingSessionId: null,

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id
    })),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[sessions.length - 1]?.id ?? null
          : state.activeSessionId
      return { sessions, activeSessionId }
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  updateSession: (id, updates) =>
    set((state) => {
      // Skip no-op updates: the statusline bridge ticks ~1-3×/s per working
      // session and frequently re-sends value-identical telemetry. Without this
      // guard every such tick replaced the sessions array (new identity) and
      // re-rendered every subscriber — including the root shell. Bail out when
      // the patch changes nothing on the target session so the array identity
      // (and the matched session object) is preserved.
      const idx = state.sessions.findIndex((s) => s.id === id)
      if (idx === -1) return state
      const current = state.sessions[idx]
      let changed = false
      for (const k in updates) {
        if ((current as unknown as Record<string, unknown>)[k] !== (updates as unknown as Record<string, unknown>)[k]) {
          changed = true
          break
        }
      }
      if (!changed) return state
      const sessions = state.sessions.slice()
      sessions[idx] = { ...current, ...updates }
      return { sessions }
    }),

  getSession: (id) => get().sessions.find((s) => s.id === id),

  hasWorkingSessions: () => get().sessions.some((s) => s.status === 'working'),

  setRestoring: (restoring) => set({ isRestoring: restoring }),

  restoreSessions: (sessions, activeId) =>
    set({
      sessions,
      activeSessionId: activeId || sessions[0]?.id || null,
      isRestoring: false
    }),

  beginRename: (id) => set({ renamingSessionId: id }),

  renameSession: (id, name) => {
    const trimmed = name.trim()
    // Blank => clear the override (undefined) so the tab reverts to `label`.
    get().updateSession(id, { customName: trimmed || undefined })
    set({ renamingSessionId: null })
    // Persist the display name into the logs/history DB so the session's log
    // keeps this name durably (survives close + restart). Best-effort: no-op
    // when logging is disabled or the preload bridge is absent (e.g. tests).
    const s = get().sessions.find((x) => x.id === id)
    const effective = trimmed || s?.label || ''
    try {
      window.electronAPI?.logs2?.renameSession?.({ sessionId: id, configLabel: effective })
    } catch { /* logging off / preload absent */ }
  }
}))

/**
 * The session fields the app shell's RENDER path actually reads (App.tsx's
 * `sessions.map` over the terminal wrappers + the `activeSession` passed to the
 * header / breadcrumb / command bar / GitHub panel). Deliberately EXCLUDES the
 * high-frequency telemetry fields the statusline bridge ticks (contextPercent,
 * costUsd, tokens, rate limits, effortLive, fastMode, status, needsAttention,
 * …) — those are consumed by self-subscribing leaf components (SessionStatusStrip,
 * the sidebar card), never by the shell render itself.
 *
 * Used by `structuralSessionsEqual` so the root subscription can ignore
 * telemetry-only ticks and stop the full-tree re-render cascade.
 */
export const STRUCTURAL_SESSION_FIELDS = [
  'id', 'createdAt', 'configId', 'label', 'customName', 'workingDirectory', 'sessionType',
  'shellOnly', 'sshConfig', 'partnerTerminalPath', 'partnerElevated',
  'legacyVersion', 'agentIds', 'effortLevel', 'disableAutoMemory',
  'enableCodexReview', 'loggingEnabled', 'model', 'provider', 'codexOptions',
  'identityColorKey', 'color', 'githubIntegration',
] as const

/**
 * Equality function over the sessions array that compares only the structural
 * fields the shell renders. Returns true (i.e. "no change → skip re-render")
 * when only telemetry changed. Object/array-valued fields (sshConfig,
 * githubIntegration, agentIds, …) are compared by reference, which is correct
 * because updateSession spreads a fresh session object only when a field's
 * VALUE changed — a telemetry-only patch leaves these references intact.
 */
export function structuralSessionsEqual(a: Session[], b: Session[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] as unknown as Record<string, unknown>
    const sb = b[i] as unknown as Record<string, unknown>
    if (sa === sb) continue
    for (const f of STRUCTURAL_SESSION_FIELDS) {
      if (sa[f] !== sb[f]) return false
    }
  }
  return true
}
