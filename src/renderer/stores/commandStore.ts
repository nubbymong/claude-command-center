import { create } from 'zustand'
import { saveConfigNow, saveConfigDebounced } from '../utils/config-saver'

export interface CustomCommand {
  id: string
  label: string
  prompt: string           // Base command (script path) — no longer includes arguments
  scope: 'global' | 'config'
  configId?: string
  color?: string
  /** Which pane this button runs in. The row it sits in IS this value -- there
   *  is deliberately no 'any': a button that ran in whichever pane happened to
   *  be showing meant the Claude row could execute a shell line, with nothing
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
  /** The third kind of button: it types NOTHING and opens `pageUrl` in the
   *  session's browser pane (item 26). The other two kinds are not stored --
   *  they are read off `target` -- but a page button has no target, so it
   *  needs its own mark. Absent means "a typing command", as it always did. */
  kind?: 'page'
  /** http/https only (shared/browser-url), validated in the dialog and again
   *  by main before anything loads. Only meaningful when `kind === 'page'`. */
  pageUrl?: string
}

export interface CommandSection {
  id: string
  name: string
  scope: 'global' | 'config'
  configId?: string
  color?: string
  target?: 'claude' | 'partner'
}

interface CommandState {
  commands: CustomCommand[]
  sections: CommandSection[]
  isLoaded: boolean
  hydrate: (commands: CustomCommand[], sections?: CommandSection[]) => void
  addCommand: (command: CustomCommand) => void
  updateCommand: (id: string, updates: Partial<CustomCommand>) => void
  removeCommand: (id: string) => void
  reorderCommands: (reordered: CustomCommand[]) => void
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
      const commands = [...state.commands, command]
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
