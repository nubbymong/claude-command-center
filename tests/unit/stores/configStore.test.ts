import { describe, it, expect, beforeEach } from 'vitest'
import { useConfigStore, TerminalConfig, ConfigGroup, ConfigSection } from '../../../src/renderer/stores/configStore'

function makeConfig(overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    id: 'cfg-' + Math.random().toString(36).slice(2, 8),
    label: 'Test Config',
    workingDirectory: 'C:\\dev',
    model: 'sonnet',
    color: '#89B4FA',
    sessionType: 'local',
    ...overrides,
  }
}

describe('configStore', () => {
  beforeEach(() => {
    useConfigStore.setState({ configs: [], groups: [], sections: [], isLoaded: false })
  })

  describe('hydrate', () => {
    it('hydrates configs, groups, sections and marks loaded', () => {
      const configs = [makeConfig({ id: 'c1' })]
      const groups: ConfigGroup[] = [{ id: 'g1', name: 'Group 1' }]
      const sections: ConfigSection[] = [{ id: 's1', name: 'Section 1' }]
      useConfigStore.getState().hydrate(configs, groups, sections)
      const state = useConfigStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.configs).toHaveLength(1)
      expect(state.groups).toHaveLength(1)
      expect(state.sections).toHaveLength(1)
    })
  })

  describe('addConfig / removeConfig / updateConfig', () => {
    it('adds a config', () => {
      const config = makeConfig({ id: 'c1', label: 'MyConfig' })
      useConfigStore.getState().addConfig(config)
      expect(useConfigStore.getState().configs).toHaveLength(1)
      expect(useConfigStore.getState().configs[0].label).toBe('MyConfig')
    })

    it('removes a config', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1' }))
      useConfigStore.getState().addConfig(makeConfig({ id: 'c2' }))
      useConfigStore.getState().removeConfig('c1')
      expect(useConfigStore.getState().configs).toHaveLength(1)
      expect(useConfigStore.getState().configs[0].id).toBe('c2')
    })

    it('updates config properties', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1', label: 'Old' }))
      useConfigStore.getState().updateConfig('c1', { label: 'New', color: '#FF0000' })
      const config = useConfigStore.getState().configs[0]
      expect(config.label).toBe('New')
      expect(config.color).toBe('#FF0000')
    })
  })

  describe('group operations', () => {
    it('adds a group', () => {
      useConfigStore.getState().addGroup({ id: 'g1', name: 'Dev' })
      expect(useConfigStore.getState().groups).toHaveLength(1)
      expect(useConfigStore.getState().groups[0].name).toBe('Dev')
    })

    it('renames a group', () => {
      useConfigStore.getState().addGroup({ id: 'g1', name: 'Old' })
      useConfigStore.getState().renameGroup('g1', 'New')
      expect(useConfigStore.getState().groups[0].name).toBe('New')
    })

    it('removes a group and ungroups its configs', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1', groupId: 'g1' }))
      useConfigStore.getState().addConfig(makeConfig({ id: 'c2', groupId: 'g1' }))
      useConfigStore.getState().addGroup({ id: 'g1', name: 'Group' })
      useConfigStore.getState().removeGroup('g1')
      expect(useConfigStore.getState().groups).toHaveLength(0)
      // Configs should be ungrouped
      expect(useConfigStore.getState().configs[0].groupId).toBeUndefined()
      expect(useConfigStore.getState().configs[1].groupId).toBeUndefined()
    })

    it('toggles group collapsed', () => {
      useConfigStore.getState().addGroup({ id: 'g1', name: 'G', collapsed: false })
      useConfigStore.getState().toggleGroupCollapsed('g1')
      expect(useConfigStore.getState().groups[0].collapsed).toBe(true)
      useConfigStore.getState().toggleGroupCollapsed('g1')
      expect(useConfigStore.getState().groups[0].collapsed).toBe(false)
    })

    it('moves config to group', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1' }))
      useConfigStore.getState().addGroup({ id: 'g1', name: 'G' })
      useConfigStore.getState().moveConfigToGroup('c1', 'g1')
      expect(useConfigStore.getState().configs[0].groupId).toBe('g1')
    })

    it('removes config from group', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1', groupId: 'g1' }))
      useConfigStore.getState().moveConfigToGroup('c1', undefined)
      expect(useConfigStore.getState().configs[0].groupId).toBeUndefined()
    })
  })

  describe('section operations', () => {
    it('adds a section', () => {
      useConfigStore.getState().addSection({ id: 's1', name: 'Prod' })
      expect(useConfigStore.getState().sections).toHaveLength(1)
    })

    it('renames a section', () => {
      useConfigStore.getState().addSection({ id: 's1', name: 'Old' })
      useConfigStore.getState().renameSection('s1', 'New')
      expect(useConfigStore.getState().sections[0].name).toBe('New')
    })

    it('removes section and clears sectionId from groups and configs', () => {
      useConfigStore.getState().addSection({ id: 's1', name: 'S' })
      useConfigStore.getState().addGroup({ id: 'g1', name: 'G', sectionId: 's1' })
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1', sectionId: 's1' }))
      useConfigStore.getState().removeSection('s1')
      expect(useConfigStore.getState().sections).toHaveLength(0)
      expect(useConfigStore.getState().groups[0].sectionId).toBeUndefined()
      expect(useConfigStore.getState().configs[0].sectionId).toBeUndefined()
    })

    it('moves group to section', () => {
      useConfigStore.getState().addGroup({ id: 'g1', name: 'G' })
      useConfigStore.getState().addSection({ id: 's1', name: 'S' })
      useConfigStore.getState().moveGroupToSection('g1', 's1')
      expect(useConfigStore.getState().groups[0].sectionId).toBe('s1')
    })

    it('moves config to section', () => {
      useConfigStore.getState().addConfig(makeConfig({ id: 'c1' }))
      useConfigStore.getState().addSection({ id: 's1', name: 'S' })
      useConfigStore.getState().moveConfigToSection('c1', 's1')
      expect(useConfigStore.getState().configs[0].sectionId).toBe('s1')
    })
  })
})
