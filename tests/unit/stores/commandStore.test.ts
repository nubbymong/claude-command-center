import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandStore, CustomCommand, CommandSection, DEFAULT_COMMANDS } from '../../../src/renderer/stores/commandStore'

function makeCommand(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    id: 'cmd-' + Math.random().toString(36).slice(2, 8),
    label: 'Test Command',
    prompt: 'Do something',
    scope: 'global',
    ...overrides,
  }
}

function makeSection(overrides: Partial<CommandSection> = {}): CommandSection {
  return {
    id: 'sec-' + Math.random().toString(36).slice(2, 8),
    name: 'Test Section',
    scope: 'global',
    ...overrides,
  }
}

describe('commandStore', () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [], sections: [], isLoaded: false })
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

  describe('addSection', () => {
    it('creates a section', () => {
      useCommandStore.getState().addSection(makeSection({ id: 's1', name: 'Deploy' }))
      expect(useCommandStore.getState().sections).toHaveLength(1)
      expect(useCommandStore.getState().sections[0].name).toBe('Deploy')
    })

    it('appends to existing sections', () => {
      useCommandStore.getState().addSection(makeSection({ id: 's1' }))
      useCommandStore.getState().addSection(makeSection({ id: 's2' }))
      expect(useCommandStore.getState().sections).toHaveLength(2)
    })
  })

  describe('updateSection', () => {
    it('modifies a section by id', () => {
      useCommandStore.getState().addSection(makeSection({ id: 's1', name: 'Old' }))
      useCommandStore.getState().updateSection('s1', { name: 'New' })
      expect(useCommandStore.getState().sections[0].name).toBe('New')
    })

    it('does not affect other sections', () => {
      useCommandStore.getState().addSection(makeSection({ id: 's1', name: 'A' }))
      useCommandStore.getState().addSection(makeSection({ id: 's2', name: 'B' }))
      useCommandStore.getState().updateSection('s1', { name: 'Updated' })
      expect(useCommandStore.getState().sections[1].name).toBe('B')
    })
  })

  describe('removeSection', () => {
    it('removes section and clears sectionId from orphaned commands', () => {
      useCommandStore.getState().addSection(makeSection({ id: 's1', name: 'S' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c1', sectionId: 's1' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c2', sectionId: 's1' }))
      useCommandStore.getState().addCommand(makeCommand({ id: 'c3', sectionId: 's2' }))

      useCommandStore.getState().removeSection('s1')

      expect(useCommandStore.getState().sections).toHaveLength(0)
      // Commands that had sectionId 's1' should be cleared
      const c1 = useCommandStore.getState().commands.find(c => c.id === 'c1')
      const c2 = useCommandStore.getState().commands.find(c => c.id === 'c2')
      const c3 = useCommandStore.getState().commands.find(c => c.id === 'c3')
      expect(c1?.sectionId).toBeUndefined()
      expect(c2?.sectionId).toBeUndefined()
      // c3 has different sectionId — should NOT be cleared
      expect(c3?.sectionId).toBe('s2')
    })
  })

  describe('reorderSections', () => {
    it('reorders sections', () => {
      const s1 = makeSection({ id: 's1', name: 'A' })
      const s2 = makeSection({ id: 's2', name: 'B' })
      useCommandStore.getState().addSection(s1)
      useCommandStore.getState().addSection(s2)

      useCommandStore.getState().reorderSections([s2, s1])

      expect(useCommandStore.getState().sections[0].id).toBe('s2')
      expect(useCommandStore.getState().sections[1].id).toBe('s1')
    })
  })

  describe('hydrate with sections', () => {
    it('populates both commands and sections', () => {
      const cmds = [makeCommand({ id: 'c1' })]
      const secs = [makeSection({ id: 's1', name: 'Deploy' })]
      useCommandStore.getState().hydrate(cmds, secs)

      const state = useCommandStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.commands).toHaveLength(1)
      expect(state.sections).toHaveLength(1)
      expect(state.sections[0].name).toBe('Deploy')
    })

    it('defaults sections to empty array when not provided', () => {
      const cmds = [makeCommand({ id: 'c1' })]
      useCommandStore.getState().hydrate(cmds)

      const state = useCommandStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.sections).toEqual([])
    })
  })
})
