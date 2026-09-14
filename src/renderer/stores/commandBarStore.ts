import { create } from 'zustand'
import { saveConfigDebounced, saveConfigNow } from '../utils/config-saver'

// Command-bar UI state lives outside CommandBar's local useState so the Claude
// and Partner terminals (separate TerminalView + CommandBar instances per
// session) share the same view of it, and it is persisted so it survives
// restarts. (ADR-018 D6/D8/D9.)
//
// TRAP, by design: hydration below coerces EVERY field and every write below
// writes the WHOLE object -- add a field in both places or it is dropped on
// load and clobbered by the next click (this bit the two-field version).

/** The fixed tools in the Core band. A future tool is appended here and appears
 *  by default: hide state is a denylist, absent = shown. */
export const CORE_TOOL_IDS = ['snap', 'canvas', 'logs', 'browser', 'artifacts', 'partner', 'notes'] as const
export type CoreToolId = typeof CORE_TOOL_IDS[number]

/** One row and fold the rest (default), or wrap to at most a second row then fold. */
export type CommandBarOverflow = 'fold' | 'wrap2'

export interface HiddenCoreTools {
  /** Hidden everywhere; comes back only from Settings -> Custom Commands (or the
   *  empty-bar menu's "Show hidden tools"). */
  everywhere: CoreToolId[]
  /** Hidden in one live session ("In this session"), keyed by session id.
   *  Session ids persist across restarts, so `reconcile` sweeps dead keys. */
  bySession: Record<string, CoreToolId[]>
}

export interface CommandBarUiState {
  collapsedSectionIds: string[]
  // Whole-bar collapse -- when true the CommandBar renders nothing but is
  // restorable from Settings ("Show the command bar"). Shared and persisted.
  barCollapsed: boolean
  overflow: CommandBarOverflow
  hiddenCoreTools: HiddenCoreTools
  /** The one-time upgrade review of existing commands ran for this version
   *  (0 = never). See lib/command-upgrade. */
  upgradeReviewVersion: number
}

interface CommandBarStore {
  state: CommandBarUiState
  isLoaded: boolean
  hydrate: (state: Partial<CommandBarUiState> | Record<string, unknown>) => void
  isCollapsed: (sectionId: string) => boolean
  toggleSection: (sectionId: string) => void
  toggleBar: () => void
  setBarCollapsed: (value: boolean) => void
  setOverflow: (value: CommandBarOverflow) => void
  hideCoreTool: (tool: CoreToolId, where: 'session' | 'everywhere', sessionId: string) => void
  /** Show a tool again: in one session, or everywhere (clears every hide of it). */
  showCoreTool: (tool: CoreToolId, where: 'session' | 'everywhere', sessionId?: string) => void
  isCoreToolHidden: (tool: CoreToolId, sessionId: string) => boolean
  hiddenToolsFor: (sessionId: string) => CoreToolId[]
  /** Drop per-session hide entries for sessions that no longer exist. */
  reconcile: (liveSessionIds: readonly string[]) => void
  markUpgradeReviewDone: (version: number) => void
}

const DEFAULTS: CommandBarUiState = {
  collapsedSectionIds: [],
  barCollapsed: false,
  overflow: 'fold',
  hiddenCoreTools: { everywhere: [], bySession: {} },
  upgradeReviewVersion: 0,
}

const isToolId = (v: unknown): v is CoreToolId => typeof v === 'string' && (CORE_TOOL_IDS as readonly string[]).includes(v)
const toolList = (v: unknown): CoreToolId[] => (Array.isArray(v) ? v.filter(isToolId) : [])

/** Coerce a persisted (possibly hand-edited or corrupt) blob into a valid state. Fails open. */
export function coerceCommandBarUi(next: Record<string, unknown> | Partial<CommandBarUiState> | null | undefined): CommandBarUiState {
  const n = (next ?? {}) as Record<string, unknown>
  const hidden = (n.hiddenCoreTools && typeof n.hiddenCoreTools === 'object' && !Array.isArray(n.hiddenCoreTools))
    ? (n.hiddenCoreTools as Record<string, unknown>)
    : {}
  const bySessionRaw = (hidden.bySession && typeof hidden.bySession === 'object' && !Array.isArray(hidden.bySession))
    ? (hidden.bySession as Record<string, unknown>)
    : {}
  const bySession: Record<string, CoreToolId[]> = {}
  for (const [k, v] of Object.entries(bySessionRaw)) {
    const list = toolList(v)
    if (list.length) bySession[k] = list
  }
  return {
    collapsedSectionIds: Array.isArray(n.collapsedSectionIds) ? (n.collapsedSectionIds as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    barCollapsed: typeof n.barCollapsed === 'boolean' ? n.barCollapsed : false,
    overflow: n.overflow === 'wrap2' ? 'wrap2' : 'fold',
    hiddenCoreTools: { everywhere: toolList(hidden.everywhere), bySession },
    upgradeReviewVersion: typeof n.upgradeReviewVersion === 'number' && Number.isFinite(n.upgradeReviewVersion) ? n.upgradeReviewVersion : 0,
  }
}

export const useCommandBarStore = create<CommandBarStore>((set, get) => ({
  state: { ...DEFAULTS },
  isLoaded: false,

  hydrate: (next) => set({ state: coerceCommandBarUi(next), isLoaded: true }),

  isCollapsed: (sectionId) => get().state.collapsedSectionIds.includes(sectionId),

  toggleSection: (sectionId) =>
    set((s) => {
      const current = s.state.collapsedSectionIds
      const has = current.includes(sectionId)
      const collapsedSectionIds = has
        ? current.filter((id) => id !== sectionId)
        : [...current, sectionId]
      const nextState = { ...s.state, collapsedSectionIds }
      // Debounced — rapid expand/collapse spam shouldn't write to
      // disk on every click. config-saver coalesces successive calls
      // within 300 ms.
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),

  toggleBar: () =>
    set((s) => {
      const nextState = { ...s.state, barCollapsed: !s.state.barCollapsed }
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),

  setBarCollapsed: (value) =>
    set((s) => {
      if (s.state.barCollapsed === value) return s
      const nextState = { ...s.state, barCollapsed: value }
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),

  setOverflow: (value) =>
    set((s) => {
      if (s.state.overflow === value) return s
      const nextState = { ...s.state, overflow: value }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),

  hideCoreTool: (tool, where, sessionId) =>
    set((s) => {
      const h = s.state.hiddenCoreTools
      const hiddenCoreTools: HiddenCoreTools = where === 'everywhere'
        ? { ...h, everywhere: h.everywhere.includes(tool) ? h.everywhere : [...h.everywhere, tool] }
        : { ...h, bySession: { ...h.bySession, [sessionId]: Array.from(new Set([...(h.bySession[sessionId] ?? []), tool])) } }
      const nextState = { ...s.state, hiddenCoreTools }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),

  showCoreTool: (tool, where, sessionId) =>
    set((s) => {
      const h = s.state.hiddenCoreTools
      let hiddenCoreTools: HiddenCoreTools
      if (where === 'everywhere') {
        const bySession: Record<string, CoreToolId[]> = {}
        for (const [k, v] of Object.entries(h.bySession)) {
          const rest = v.filter((t) => t !== tool)
          if (rest.length) bySession[k] = rest
        }
        hiddenCoreTools = { everywhere: h.everywhere.filter((t) => t !== tool), bySession }
      } else {
        const key = sessionId ?? ''
        const rest = (h.bySession[key] ?? []).filter((t) => t !== tool)
        const bySession = { ...h.bySession }
        if (rest.length) bySession[key] = rest
        else delete bySession[key]
        hiddenCoreTools = { ...h, bySession }
      }
      const nextState = { ...s.state, hiddenCoreTools }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),

  isCoreToolHidden: (tool, sessionId) => {
    const h = get().state.hiddenCoreTools
    return h.everywhere.includes(tool) || (h.bySession[sessionId] ?? []).includes(tool)
  },

  hiddenToolsFor: (sessionId) => {
    const h = get().state.hiddenCoreTools
    return Array.from(new Set([...h.everywhere, ...(h.bySession[sessionId] ?? [])]))
  },

  reconcile: (liveSessionIds) =>
    set((s) => {
      const live = new Set(liveSessionIds)
      const entries = Object.entries(s.state.hiddenCoreTools.bySession)
      const kept = entries.filter(([k]) => live.has(k))
      if (kept.length === entries.length) return s
      const nextState = { ...s.state, hiddenCoreTools: { ...s.state.hiddenCoreTools, bySession: Object.fromEntries(kept) } }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),

  markUpgradeReviewDone: (version) =>
    set((s) => {
      if (s.state.upgradeReviewVersion >= version) return s
      const nextState = { ...s.state, upgradeReviewVersion: version }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),
}))
