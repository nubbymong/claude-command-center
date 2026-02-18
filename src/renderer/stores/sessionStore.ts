import { create } from 'zustand'

export type SessionStatus = 'idle' | 'working' | 'complete' | 'error' | 'disconnected'
export type SessionType = 'local' | 'ssh'

export interface SSHConfig {
  host: string
  port: number
  username: string
  remotePath: string
  hasPassword?: boolean
  password?: string
  postCommand?: string
  sudoPassword?: string
  startClaudeAfter?: boolean
  dockerContainer?: string  // Docker container name (enables docker cp for screenshots)
}

export interface Session {
  id: string
  configId?: string
  label: string
  workingDirectory: string
  model: string
  color: string
  status: SessionStatus
  createdAt: number
  sessionType: SessionType
  shellOnly?: boolean  // Don't run Claude, just open a shell
  partnerTerminalPath?: string  // Optional partner shell terminal path
  partnerElevated?: boolean     // Run partner terminal as admin (requires gsudo)
  sshConfig?: SSHConfig
  contextPercent?: number
  needsAttention?: boolean
  claudeWaiting?: boolean            // Claude is prompting for input (red InputBar)
  costUsd?: number
  modelName?: string
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
  compactionInterrupt?: boolean         // Per-session on/off (default off)
  compactionInterruptTriggered?: boolean // Set true after auto-Escape, prevents re-trigger
  inputBarHeight?: number               // Per-session remembered input bar height (px)
  visionConfig?: {                       // Vision browser control config
    enabled: boolean
    browser: 'chrome' | 'edge'
    debugPort: number
  }
  visionConnected?: boolean              // Whether vision CDP connection is active
  visionPort?: number                    // Vision proxy port (for env vars)
  legacyVersion?: {                      // Pinned Claude CLI version
    enabled: boolean
    version: string
  }
}

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  isRestoring: boolean  // True while restoring sessions from saved state

  addSession: (session: Session) => void
  removeSession: (id: string) => void
  setActiveSession: (id: string) => void
  updateSession: (id: string, updates: Partial<Session>) => void
  getSession: (id: string) => Session | undefined
  hasWorkingSessions: () => boolean  // Check if any session is actively working
  setRestoring: (restoring: boolean) => void
  restoreSessions: (sessions: Session[], activeId: string | null) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isRestoring: false,

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
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...updates } : s))
    })),

  getSession: (id) => get().sessions.find((s) => s.id === id),

  hasWorkingSessions: () => get().sessions.some((s) => s.status === 'working'),

  setRestoring: (restoring) => set({ isRestoring: restoring }),

  restoreSessions: (sessions, activeId) =>
    set({
      sessions,
      activeSessionId: activeId || sessions[0]?.id || null,
      isRestoring: false
    })
}))
