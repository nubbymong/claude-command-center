import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandStore, CustomCommand, DEFAULT_COMMANDS } from '../../../src/renderer/stores/commandStore'

function makeCommand(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    id: 'cmd-' + Math.random().toString(36).slice(2, 8),
    label: 'Test Command',
    prompt: 'Do something',
    scope: 'global',
    ...overrides,
  }
}

describe('commandStore', () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [], isLoaded: false })
  })

  describe('hydrate', () => {
    it('hydrates commands and marks loaded', () => {
      const cmds = [makeCommand({ id: 'c1' })]
      useCommandStore.getState().hydrate(cmds)
      expect(useCommandStore.getState().isLoaded).toBe(true)
      expect(useCommandStore.getState().commands).toHaveLength(1)
    })
  })

  describe('DEFAULT_COMMANDS', () => {
    it('has at least one built-in command', () => {
      expect(DEFAULT_COMMANDS.length).toBeGreaterThanOrEqual(1)
      expect(DEFAULT_COMMANDS[0].scope).toBe('global')
    })
  })

  describe('addCommand', () => {
    it('adds a command', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', label: 'New' }))
      expect(useCommandStore.getState().commands).toHaveLength(1)
      expect(useCommandStore.getState().commands[0].label).toBe('New')
    })
  })

  describe('updateCommand', () => {
    it('updates a command by id', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', label: 'Old' }))
      useCommandStore.getState().updateCommand('c1', { label: 'Updated' })
      expect(useCommandStore.getState().commands[0].label).toBe('Updated')
    })
  })

  describe('removeCommand', () => {
    it('removes a command', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c2' }))
      useCommandStore.getState().removeCommand('c1')
      expect(useCommandStore.getState().commands).toHaveLength(1)
      expect(useCommandStore.getState().commands[0].id).toBe('c2')
    })
  })

  describe('reorderCommands', () => {
    it('replaces command array with reordered version', () => {
      const c1 = makeCommand({ id: 'c1', label: 'A' })
      const c2 = makeCommand({ id: 'c2', label: 'B' })
      useCommandStore.getState().addCommand(c1)
      useCommandStore.getState().addCommand(c2)
      useCommandStore.getState().reorderCommands([c2, c1])
      expect(useCommandStore.getState().commands[0].id).toBe('c2')
      expect(useCommandStore.getState().commands[1].id).toBe('c1')
    })
  })

  describe('getCommandsForSession', () => {
    it('returns global commands when no configId', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'g1', scope: 'global' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', scope: 'config', configId: 'cfg-a' }))
      const result = useCommandStore.getState().getCommandsForSession()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('g1')
    })

    it('returns global + matching config commands', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'g1', scope: 'global' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', scope: 'config', configId: 'cfg-a' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c2', scope: 'config', configId: 'cfg-b' }))
      const result = useCommandStore.getState().getCommandsForSession('cfg-a')
      expect(result).toHaveLength(2)
      expect(result.map(c => c.id).sort()).toEqual(['c1', 'g1'])
    })

    it('excludes non-matching config commands', () => {
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', scope: 'config', configId: 'cfg-a' }))
      const result = useCommandStore.getState().getCommandsForSession('cfg-b')
      expect(result).toHaveLength(0)
    })
  })
})
