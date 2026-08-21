import { create } from 'zustand'
import { saveConfigNow, saveConfigDebounced } from '../utils/config-saver'
import { bandOf, bandMembers, type CommandBand } from '../lib/command-bands'

/**
 * Why an existing command was tagged for the user's attention on the first
 * launch after the one-row bar (ADR-018 D13). Tags are written once, never
 * acted on automatically, and cleared when the user fixes or dismisses them.
 */
export type CommandReviewReason =
  /** An argument looks like a credential (a token/secret/password/api-key flag,
   *  or a key-shaped value) -- offer to store it as a secret argument. */
  | 'secret-like-arg'
  /** A Global "send a prompt" button is inert on the user's terminal-only configs. */
  | 'prompt-inert-on-shell-configs'
  /** The button sat in a user section literally named "Global" that was dissolved
   *  into the fixed Global band. */
  | 'section-dissolved'
  /** A shell button scoped to an SSH config: its partner shell is on this PC,
   *  not on the host, which the old row label never said. */
  | 'ssh-partner-is-local'

export interface CustomCommand {
  id: string
  label: string
  prompt: string           // Base command (script path) — no longer includes arguments
  scope: 'global' | 'config'
  configId?: string
  color?: string
  /** Which pane this button runs in. The cluster it sits in IS this value -- there
   *  is deliberately no 'any': a button that ran in whichever pane happened to
   *  be showing meant the Claude cluster could execute a shell line, with nothing
   *  on screen saying so. Absent means 'claude', which is what it always meant.
   *  Commands stored with the old 'any' are migrated on load. */
  target?: 'claude' | 'partner'
  sectionId?: string       // Which section this button belongs to
  defaultArgs?: string[]   // Default arguments (run on normal click)
  /** One of the arguments is a secret: its VALUE is in the OS keychain under
   *  commandSecretKey(id), and `{secret}` in the arguments is typed as a
   *  reference to the env var main sets when a SHELL starts. The value is never
   *  in this record and never in the command line. See shared/command-secret. */
  hasSecretArg?: boolean
  lastCustomArgs?: string[] // Last custom arguments used (remembered)
  // "Watch for a page": when enabled, the command write triggers a 30 s
  // URL poll against `webView.url`. First successful response tints the
  // Browser button green and points the pane at the page if it is showing
  // nothing; a 30 s timeout flips it red. The command honours its `target`
  // (Claude / Partner) — works for SSH shellOnly sessions where Claude
  // isn't running. The CommandBar also re-probes this URL on any
  // command-button press in the session, so a stopped server downgrades
  // available → failed without a background interval.
  webView?: {
    enabled: boolean
    url: string
  }
  /** What the button DOES. 'page' types NOTHING and opens `pageUrl` in the
   *  session's browser pane (item 26). 'prompt' / 'shell' are stored from
   *  2.1.0-beta.17 on (ADR-018): `target` alone could not tell a prompt from a
   *  main-shell line once a Global button is seen from a terminal-only session.
   *  Absent on old records: read off `target` (partner = shell) and, for a
   *  claude-target button, off the session it is scoped to (a Session button of
   *  a terminal-only config is that shell's line; a Global one is a prompt). */
  kind?: 'prompt' | 'shell' | 'page'
  /** http/https only (shared/browser-url), validated in the dialog and again
   *  by main before anything loads. Only meaningful when `kind === 'page'`. */
  pageUrl?: string
  /** Key into the curated glyph set (components/command-icons). Absent, or an
   *  unknown key, draws the monogram tile: the label's first letter on a tint
   *  of `color`. Stored as a KEY so the set can be redrawn without touching
   *  anyone's data. (ADR-018 D6) */
  icon?: string
  /** A pinned button forms the leading run of its band and never folds into
   *  the "N more" pill. (ADR-018 D6/D8) */
  pinned?: boolean
  /** Position within its scope band (Global, or this config). Assigned once on
   *  upgrade from array position; rewritten for the whole band on every
   *  reorder. Ties broken by array position, so an absent value still sorts. */
  order?: number
  /** Set once on the first launch after the one-row bar for commands that clash
   *  with the new model; cleared on fix or dismiss. Never acted on by the app. */
  needsReview?: CommandReviewReason[]
}

export interface CommandSection {
  id: string
  name: string
  scope: 'global' | 'config'
  configId?: string
  color?: string
  /** RETIRED as a filter in 2.1.0-beta.17: a section is bound to its scope band,
   *  not to a pane -- each chip's own target mark says where it runs. Kept one
   *  release for round-trip; removed from the type after that. */
  target?: 'claude' | 'partner'
}

// The band helpers live in lib/command-bands (pure, no store) so test code
// that mocks this module still has them; re-exported here for convenience.
export { bandOf, bandMembers } from '../lib/command-bands'
export type { CommandBand } from '../lib/command-bands'

interface CommandState {
  commands: CustomCommand[]
  sections: CommandSection[]
  isLoaded: boolean
  hydrate: (commands: CustomCommand[], sections?: CommandSection[]) => void
  addCommand: (command: CustomCommand) => void
  updateCommand: (id: string, updates: Partial<CustomCommand>) => void
  removeCommand: (id: string) => void
  /** Whole-list reorder (Settings list). Prefer moveCommand on the bar. */
  reorderCommands: (reordered: CustomCommand[]) => void
  /**
   * Move one command to a position in a band (ADR-018 D7). `beforeId` null =
   * the end of the band. Rewrites ONLY that band's ordinals. When the command
   * comes from the OTHER band this is a scope change -- the caller has already
   * confirmed it -- and the command is re-scoped to the band (a move into the
   * config band takes `configId`). Persists immediately: a drag is a deliberate
   * one-shot act, not collapse spam.
   */
  moveCommand: (movedId: string, beforeId: string | null, band: CommandBand, configId?: string) => void
  /** The only path the bar uses to change a section: a drop onto a section group. */
  setCommandSection: (id: string, sectionId: string | undefined) => void
  togglePinned: (id: string) => void
  /** Clear the upgrade-review tag (the user fixed or dismissed it). */
  clearReview: (id: string) => void
  getCommandsForSession: (configId?: string) => CustomCommand[]
  addSection: (section: CommandSection) => void
  updateSection: (id: string, updates: Partial<CommandSection>) => void
  removeSection: (id: string) => void
  reorderSections: (reordered: CommandSection[]) => void
}

// No built-in commands: CCC auto-configures the statusline on install, so the
// old "Setup Statusline" command was redundant and only added noise on a fresh
// install. Users create their own commands via the Commands UI.
export const DEFAULT_COMMANDS: CustomCommand[] = []

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: [],
  sections: [],
  isLoaded: false,

  hydrate: (commands, sections?) => set({ commands, sections: sections || [], isLoaded: true }),

  addCommand: (command) =>
    set((state) => {
      // A new button goes to the END of its band.
      const band = bandOf(command)
      const members = bandMembers(state.commands, band, command.configId)
      const last = members.length ? Math.max(...members.map((c, i) => c.order ?? i)) : -1
      const commands = [...state.commands, { ...command, order: command.order ?? last + 1 }]
      saveConfigNow('commands', commands)
      console.log('[commandStore] Added command:', command.label, 'scope:', command.scope, 'configId:', command.configId, 'total:', commands.length)
      return { commands }
    }),

  updateCommand: (id, updates) =>
    set((state) => {
      const commands = state.commands.map((c) => (c.id === id ? { ...c, ...updates } : c))
      saveConfigNow('commands', commands)
      return { commands }
    }),

  removeCommand: (id) =>
    set((state) => {
      const commands = state.commands.filter((c) => c.id !== id)
      saveConfigNow('commands', commands)
      return { commands }
    }),

  reorderCommands: (reordered) =>
    set(() => {
      saveConfigDebounced('commands', reordered)
      return { commands: reordered }
    }),

  moveCommand: (movedId, beforeId, band, configId) =>
    set((state) => {
      const moved = state.commands.find((c) => c.id === movedId)
      if (!moved) return state
      const rescoped: CustomCommand = band === 'global'
        ? { ...moved, scope: 'global', configId: undefined }
        : { ...moved, scope: 'config', configId }
      const others = bandMembers(state.commands, band, configId).filter((c) => c.id !== movedId)
      const at = beforeId ? others.findIndex((c) => c.id === beforeId) : -1
      const ordered = at === -1 ? [...others, rescoped] : [...others.slice(0, at), rescoped, ...others.slice(at)]
      const orderById = new Map(ordered.map((c, i) => [c.id, i]))
      const commands = state.commands.map((c) => {
        if (c.id === movedId) return { ...rescoped, order: orderById.get(movedId) ?? 0 }
        const o = orderById.get(c.id)
        return o === undefined ? c : { ...c, order: o }
      })
      saveConfigNow('commands', commands)
      return { commands }
    }),

  setCommandSection: (id, sectionId) =>
    set((state) => {
      const commands = state.commands.map((c) => (c.id === id ? { ...c, sectionId } : c))
      saveConfigNow('commands', commands)
      return { commands }
    }),

  togglePinned: (id) =>
    set((state) => {
      const commands = state.commands.map((c) => (c.id === id ? { ...c, pinned: !c.pinned || undefined } : c))
      saveConfigNow('commands', commands)
      return { commands }
    }),

  clearReview: (id) =>
    set((state) => {
      if (!state.commands.some((c) => c.id === id && c.needsReview)) return state
      const commands = state.commands.map((c) => (c.id === id ? { ...c, needsReview: undefined } : c))
      saveConfigNow('commands', commands)
      return { commands }
    }),

  getCommandsForSession: (configId?: string) => {
    const all = get().commands
    return all.filter(
      (c) => c.scope === 'global' || (c.scope === 'config' && c.configId === configId)
    )
  },

  addSection: (section) =>
    set((state) => {
      const sections = [...state.sections, section]
      saveConfigNow('commandSections', sections)
      return { sections }
    }),

  updateSection: (id, updates) =>
    set((state) => {
      const sections = state.sections.map((s) => (s.id === id ? { ...s, ...updates } : s))
      saveConfigNow('commandSections', sections)
      return { sections }
    }),

  removeSection: (id) =>
    set((state) => {
      const sections = state.sections.filter((s) => s.id !== id)
      // Also clear sectionId from any commands in this section
      const commands = state.commands.map((c) =>
        c.sectionId === id ? { ...c, sectionId: undefined } : c
      )
      saveConfigNow('commandSections', sections)
      saveConfigNow('commands', commands)
      return { sections, commands }
    }),

  reorderSections: (reordered) =>
    set(() => {
      saveConfigDebounced('commandSections', reordered)
      return { sections: reordered }
    }),
}))
