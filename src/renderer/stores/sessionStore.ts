import { create } from 'zustand'
import type { ProviderId, CodexOptions, TerminalOptions, SshRuntime } from '../../shared/types'
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
  runtime?: SshRuntime      // item e: structured container runtime
  detachable?: boolean      // item 1: "Detachable" persistent tmux session (default ON; only false disables)
  remoteOs?: 'auto' | 'unix' | 'windows'  // item 3: remote OS (windows = prototype Windows setup path)
}

export interface Session {
  id: string
  configId?: string
  /** What this session IS, when that is not "a launched saved config".
   *  'ask' = the Ask Conductor help session: a real interactive Claude session
   *  in the staged help workspace, deliberately WITHOUT a saved config (it is
   *  not something the user filed, so it must not appear in Saved Configs).
   *  `configId === undefined` is NOT a marker for it -- the add-account login
   *  shell, the re-auth shell and a resumed project folder are all config-less
   *  too. Set once at creation; never changes. */
  kind?: 'ask'
  /** One-shot opening question for an Ask session. Rides `pty.spawn` into the
   *  spawn ENVIRONMENT as CCC_ASK_PROMPT (never into the command text), is
   *  cleared the moment the spawn is issued, and is NEVER persisted -- see the
   *  allowlist in session-persistence.ts. */
  askPrompt?: string
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
  terminalOptions?: TerminalOptions  // Terminal-only command / args / secret / elevated
  partnerTerminalPath?: string  // Optional partner shell terminal path
  partnerElevated?: boolean     // Run partner terminal as admin (requires gsudo)
  sshConfig?: SSHConfig
  contextPercent?: number
  needsAttention?: boolean
  /** Session Watchdog (#235) live state, pushed from main via IPC.WATCHDOG_STATE.
   *  Absent = watchdog off / not running for this session (no indicator shown). */
  watchdog?: { status: string; waitUntil: number | null; gaveUp: boolean }
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
  /** Per-session permission mode -> claude `--permission-mode`. '' / 'default' /
   *  undefined = no flag. Sourced from the config's claudeOptions at launch. */
  permissionMode?: string
  /** Advanced: extra CLI args appended verbatim to the claude launch command. */
  extraArgs?: string
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
  /** True once this session's PTY has EXITED and nothing has respawned it.
   *  Set by TerminalView's exit subscription; cleared by forceRemount.
   *
   *  It exists because a session object outlives its process: main deletes the
   *  PTY and sends `pty:exit`, the renderer writes "[Process exited]" into the
   *  terminal, and the session stays in the list looking exactly like a live
   *  one. Anything that decides "there is already a session, write to it"
   *  therefore has to consult liveness -- see findAskSession, where writing to
   *  a dead PTY buffered the user's question into a pendingWrites map that only
   *  a spawn drains, and a spawn clears it first.
   *
   *  Ephemeral, like effortLive/fastMode: NOT in session-persistence's field
   *  allowlist, so a restored session starts unset (it has no PTY yet either
   *  way, and the restore path spawns one). */
  ptyExited?: boolean
  /** True only for an in-progress add-account login shell; drives the /login
   *  guidance banner. Cleared once the account is detected. */
  needsLogin?: boolean
  /** #242 tier 5: true once this SSH session's flow state has reached
   *  `claude-running` at least once. Set by TerminalView's flow-state
   *  subscription, read at the NEXT spawn to compute SSHOptions.reconnect
   *  (drives `--continue` when no tmux persistence tier is in play).
   *  Mirrors effortLive/fastMode's lifecycle: never persisted (see
   *  session-persistence.ts's explicit field allowlist) -- a session
   *  restored after a full app relaunch starts with this unset, so its
   *  first post-relaunch spawn is correctly NOT treated as a reconnect.
   *  Survives an in-app Restart (forceRemount merges the live store record
   *  without clearing it), which is the actual respawn path this exists
   *  for. */
  sshReachedClaudeRunning?: boolean
  /** SSH tmux enhancement (item 8/9): true once main confirms this SSH
   *  session is running inside a tmux persistence wrapper (survives a dropped
   *  connection). Drives the persistence indicator + the distinct
   *  persistent-SSH icon. Renderer-only, never persisted -- re-established by
   *  main's ssh:sessionInfo push on each spawn. undefined = not yet known;
   *  false = SSH but non-persistent (bare launch). */
  sshTmuxPersistent?: boolean
  /** SSH Persistent (resume liveness): set true when, after an app-restart
   *  auto-reattach, a liveness probe CONFIRMED the remote tmux this session was
   *  reattaching to is gone — so the session came back as a fresh start, not the
   *  one left running. Drives a small inline notice + "Start new". Ephemeral,
   *  never persisted (not in session-persistence's allowlist); cleared on dismiss
   *  / Start new. undefined = not gone (or not yet/ever probed). */
  sshRemoteReattachGone?: boolean
  /** SSH tmux enhancement (item 10): the Claude account the REMOTE session is
   *  signed in as (oauthAccount.emailAddress from the remote ~/.claude.json),
   *  read off the nonce'd setup sentinel. DESCRIPTOR ONLY -- never a
   *  credential; already charset/length-capped host-side before it reaches
   *  here. Renderer-only, not persisted. */
  sshRemoteAccount?: string
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
      // configLabel = the effective display name for the logs DB (falls back to
      // the config label). customName = the user's OWN work name only (empty when
      // cleared) — #536 writes it to the transcript sidecar, so a blank rename
      // clears the sidecar and a generic config label never becomes a "work name".
      window.electronAPI?.logs2?.renameSession?.({ sessionId: id, configLabel: effective, customName: trimmed })
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
  // `kind` is structural: the shell renders an Ask session differently (tab
  // monogram, docked pill, banded header). `askPrompt` is deliberately NOT here
  // -- it is cleared one tick after spawn, and listing it would force a whole
  // -shell re-render for a field nothing structural reads.
  'id', 'createdAt', 'configId', 'kind', 'label', 'customName', 'workingDirectory', 'sessionType',
  'shellOnly', 'terminalOptions', 'sshConfig', 'partnerTerminalPath', 'partnerElevated',
  'legacyVersion', 'agentIds', 'effortLevel', 'permissionMode', 'extraArgs', 'disableAutoMemory',
  'enableCodexReview', 'loggingEnabled', 'model', 'provider', 'codexOptions',
  'identityColorKey', 'color', 'githubIntegration',
  // profileId IS structural: the header's account pill resolves through it, and
  // it changes exactly at the low-frequency moments a re-render is wanted (the
  // launch-gate choice patching an account-less session, a mid-session account
  // switch). Its omission meant the shell handed SessionHeader a STALE record
  // after a gate choice, so the pill fell back to painting the PRIMARY profile
  // — the wrong account — until some other structural field changed (found on
  // the WINDOWS_1 staging VM, 2026-08-30, where the primary is a fake profile).
  'profileId',
  // accountEmail / sshRemoteAccount / accountColour are the SSH analogue of the
  // same bug (found live on the VM 2026-09-01): an SSH session carries NO mapped
  // profileId cold, so the header's account/claude.ai/Claude Code pills resolve
  // ONLY through session.accountEmail || session.sshRemoteAccount. Those land on
  // a single late tick (the first /status the remote reports, or the setup
  // sentinel) — omitting them here made the shell's structural-equality gate
  // return "no change", so App never re-rendered, SessionHeader kept a STALE
  // record, and the top pill shimmered then gave up BLANK while the bottom bar
  // and sidebar (which self-subscribe) showed the account. Listing them re-renders
  // the shell on exactly that one resolve tick (the VALUE is unchanged on every
  // telemetry tick, so no per-tick cascade returns).
  'accountEmail', 'sshRemoteAccount', 'accountColour',
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
