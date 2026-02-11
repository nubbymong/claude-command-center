import { create } from 'zustand'
import { saveConfigNow, saveConfigDebounced } from '../utils/config-saver'

export interface CustomCommand {
  id: string
  label: string
  prompt: string
  scope: 'global' | 'config'
  configId?: string
  color?: string
  target?: 'claude' | 'partner' | 'any'
}

interface CommandState {
  commands: CustomCommand[]
  isLoaded: boolean
  hydrate: (commands: CustomCommand[]) => void
  addCommand: (command: CustomCommand) => void
  updateCommand: (id: string, updates: Partial<CustomCommand>) => void
  removeCommand: (id: string) => void
  reorderCommands: (reordered: CustomCommand[]) => void
  getCommandsForSession: (configId?: string) => CustomCommand[]
}

export const DEFAULT_COMMANDS: CustomCommand[] = [
  {
    id: 'builtin-setup-statusline',
    label: 'Setup Statusline',
    prompt: 'Please configure Claude\'s statusline on this machine so context usage is reported. Run these bash commands: 1) Create ~/.claude directory if it doesn\'t exist. 2) Write a Node.js script to ~/.claude/.sl.js that reads JSON from stdin, extracts context_window.used_percentage and cost.total_cost_usd, and outputs "XX% context | $Y.YYYY" to stdout. 3) Update ~/.claude/settings.json to set statusLine to {"type":"command","command":"node ~/.claude/.sl.js","padding":0} — merge with existing settings, don\'t overwrite them. After setup, confirm it worked by showing the contents of both files.',
    scope: 'global',
    color: '#89B4FA',
  },
]

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: [],
  isLoaded: false,

  hydrate: (commands) => set({ commands, isLoaded: true }),

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
  }
}))
