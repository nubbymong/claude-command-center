/**
 * Saved Configs panel (#362): the pure helpers behind the cards and the
 * find + categories views. Running configs never appear in a launch list,
 * launch-all never double-launches, the search matches every token, and the
 * inline completion keeps the typed prefix verbatim.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveSavedConfigsView,
  runningConfigIds,
  excludeRunning,
  makeNameLookup,
  matchesQuery,
  searchConfigs,
  completeQuery,
  stepIndex,
  shortPath,
  describeConfig,
  buildCardStacks,
  buildCategories,
  configsInCategory,
  launchAllTargets,
} from '../../../src/renderer/components/sidebar/savedConfigsView'
import type { TerminalConfig, ConfigGroup, ConfigSection } from '../../../src/renderer/stores/configStore'

const cfg = (id: string, over: Partial<TerminalConfig> = {}): TerminalConfig => ({
  id,
  label: id,
  workingDirectory: `/home/nick/${id}`,
  color: '',
  sessionType: 'local',
  provider: 'claude',
  ...over,
})

const groups: ConfigGroup[] = [
  { id: 'gWork', name: 'Work', sectionId: 'sDay' },
  { id: 'gPersonal', name: 'Personal' },
]
const sections: ConfigSection[] = [{ id: 'sDay', name: 'Day job' }]

const configs: TerminalConfig[] = [
  cfg('conductor', { label: 'Conductor beta', pinned: true, groupId: 'gWork', claudeOptions: { effortLevel: 'xhigh' } }),
  cfg('rune', { label: 'rune-dsl', pinned: true }),
  cfg('checkout', { label: 'Checkout service', groupId: 'gWork' }),
  cfg('billing', { label: 'Billing (Codex)', groupId: 'gWork', provider: 'codex', codexOptions: { model: 'gpt-5.5' } }),
  cfg('buildbox', { label: 'build-box', groupId: 'gWork', sessionType: 'ssh', sshConfig: { host: 'build-box', port: 22, username: 'nick', remotePath: '~' } }),
  cfg('blog', { label: 'Blog', groupId: 'gPersonal' }),
  cfg('scratch', { label: 'Scratch shell', groupId: 'gPersonal', shellOnly: true, terminalOptions: { command: 'pwsh' } }),
  cfg('pi', { label: 'pi-server', sessionType: 'ssh', sshConfig: { host: '10.0.0.12', port: 22, username: 'pi', remotePath: '~' } }),
  cfg('notes', { label: 'Notes', sectionId: 'sDay' }),
]

describe('resolveSavedConfigsView', () => {
  it('defaults to the list for absent or unknown values', () => {
    expect(resolveSavedConfigsView(undefined)).toBe('list')
    expect(resolveSavedConfigsView('grid')).toBe('list')
    expect(resolveSavedConfigsView(3)).toBe('list')
  })
  it('round-trips the two new views', () => {
    expect(resolveSavedConfigsView('cards')).toBe('cards')
    expect(resolveSavedConfigsView('find')).toBe('find')
  })
})

describe('running configs', () => {
  it('collects the configIds of live sessions and skips the Ask session', () => {
    const running = runningConfigIds([
      { configId: 'checkout' },
      { configId: 'blog', kind: undefined },
      { configId: 'conductor', kind: 'ask' },
      { configId: undefined },
    ])
    expect([...running].sort()).toEqual(['blog', 'checkout'])
  })
  it('excludeRunning drops exactly those', () => {
    const running = new Set(['checkout', 'pi'])
    expect(excludeRunning(configs, running).map((c) => c.id)).not.toContain('checkout')
    expect(excludeRunning(configs, running).map((c) => c.id)).not.toContain('pi')
    expect(excludeRunning(configs, running)).toHaveLength(configs.length - 2)
  })
})

describe('search', () => {
  const lookup = makeNameLookup(groups, sections)
  it('matches label, group, effective section, directory and ssh host', () => {
    expect(matchesQuery(configs[2], 'check', lookup(configs[2]))).toBe(true)
    expect(matchesQuery(configs[2], 'work', lookup(configs[2]))).toBe(true)
    expect(matchesQuery(configs[2], 'day job', lookup(configs[2]))).toBe(true) // group's section
    expect(matchesQuery(configs[2], 'home/nick', lookup(configs[2]))).toBe(true)
    expect(matchesQuery(configs[4], 'nick@build', lookup(configs[4]))).toBe(true)
    expect(matchesQuery(configs[5], 'work', lookup(configs[5]))).toBe(false)
  })
  it('requires every token to match somewhere', () => {
    expect(matchesQuery(configs[2], 'work check', lookup(configs[2]))).toBe(true)
    expect(matchesQuery(configs[2], 'work zzz', lookup(configs[2]))).toBe(false)
  })
  it('an empty or blank query keeps everything', () => {
    expect(searchConfigs(configs, '', lookup)).toHaveLength(configs.length)
    expect(searchConfigs(configs, '   ', lookup)).toHaveLength(configs.length)
  })
  it('searchConfigs narrows to the matches in list order', () => {
    expect(searchConfigs(configs, 'work', lookup).map((c) => c.id)).toEqual(['conductor', 'checkout', 'billing', 'buildbox'])
    expect(searchConfigs(configs, 'blog', lookup).map((c) => c.id)).toEqual(['blog'])
  })
})

describe('completeQuery (inline auto-complete)', () => {
  const labels = configs.map((c) => c.label)
  it('returns null for an empty query', () => {
    expect(completeQuery('', labels)).toBeNull()
  })
  it('completes the first prefix match, keeping the typed casing', () => {
    expect(completeQuery('che', labels)).toBe('checkout service')
    expect(completeQuery('CHE', labels)).toBe('CHEckout service')
  })
  it('does not complete when nothing starts with the query, or it is already complete', () => {
    expect(completeQuery('zzz', labels)).toBeNull()
    expect(completeQuery('out', labels)).toBeNull() // substring, not prefix
    expect(completeQuery('Blog', labels)).toBeNull()
  })
})

describe('stepIndex', () => {
  it('clamps at both ends and never wraps', () => {
    expect(stepIndex(0, -1, 5)).toBe(0)
    expect(stepIndex(4, 1, 5)).toBe(4)
    expect(stepIndex(2, 1, 5)).toBe(3)
  })
  it('enters the list from nothing selected', () => {
    expect(stepIndex(-1, 1, 5)).toBe(0)
    expect(stepIndex(-1, -1, 5)).toBe(4)
    expect(stepIndex(-1, 1, 0)).toBe(-1)
  })
})

describe('describeConfig', () => {
  it('names the kind, the place and the detail', () => {
    expect(describeConfig(configs[0])).toEqual({ kind: 'Claude', where: 'nick/conductor', detail: 'xhigh', glyph: 'claude' })
    expect(describeConfig(configs[3])).toEqual({ kind: 'Codex', where: 'nick/billing', detail: 'gpt-5.5', glyph: 'codex' })
    expect(describeConfig(configs[4])).toEqual({ kind: 'Claude over SSH', where: 'nick@build-box', detail: undefined, glyph: 'ssh' })
    expect(describeConfig(configs[6])).toEqual({ kind: 'Terminal only', where: 'nick/scratch', detail: 'pwsh', glyph: 'shell' })
  })
  it('shortPath keeps the last two segments and the native separator', () => {
    expect(shortPath('F:\\ccc-wt\\46d46697')).toBe('ccc-wt\\46d46697')
    expect(shortPath('/home/nick/blog')).toBe('nick/blog')
    expect(shortPath('~/blog')).toBe('~/blog')
    expect(shortPath('')).toBe('')
  })
})

describe('buildCardStacks', () => {
  it('pulls pinned out first, then sections (groups, then loose), unsectioned groups, then Ungrouped', () => {
    const stacks = buildCardStacks(configs, groups, sections)
    expect(stacks.map((s) => [s.kind, s.title, s.configs.map((c) => c.id)])).toEqual([
      ['pinned', 'Pinned', ['conductor', 'rune']],
      ['group', 'Work', ['checkout', 'billing', 'buildbox']],
      ['section', 'Day job', ['notes']],
      ['group', 'Personal', ['blog', 'scratch']],
      ['loose', 'Ungrouped', ['pi']],
    ])
  })
  it('titles the section once, on its first stack', () => {
    const stacks = buildCardStacks(configs, groups, sections)
    expect(stacks[1].sectionTitle).toBe('Day job')
    expect(stacks[2].sectionTitle).toBeUndefined()
    expect(stacks[3].sectionTitle).toBeUndefined()
  })
  it('offers launch-all only on group/section stacks with more than one config', () => {
    const stacks = buildCardStacks(configs, groups, sections)
    expect(stacks.find((s) => s.title === 'Work')!.launchAll).toBe(true)
    expect(stacks.find((s) => s.title === 'Day job')!.launchAll).toBe(false) // one config
    expect(stacks.find((s) => s.kind === 'pinned')!.launchAll).toBe(false)
    expect(stacks.find((s) => s.kind === 'loose')!.launchAll).toBe(false)
  })
  it('drops empty stacks and treats a stale groupId as loose', () => {
    const stale = [cfg('ghost', { groupId: 'gone' })]
    expect(buildCardStacks(stale, groups, sections)).toEqual([
      expect.objectContaining({ kind: 'loose', configs: stale }),
    ])
  })
})

describe('categories', () => {
  it('builds All, Pinned, sections, groups with counts over the list handed in', () => {
    const cats = buildCategories(configs, groups, sections)
    expect(cats.map((c) => [c.label, c.count])).toEqual([
      ['All', 9], ['Pinned', 2], ['Day job', 5], ['Work', 4], ['Personal', 2],
    ])
  })
  it('omits Pinned and empty groups when the list has none of them', () => {
    const none = configs.filter((c) => !c.pinned && c.groupId !== 'gPersonal')
    expect(buildCategories(none, groups, sections).map((c) => c.label)).toEqual(['All', 'Day job', 'Work'])
  })
  it('a section chip covers its groups and its loose configs', () => {
    const cat = buildCategories(configs, groups, sections).find((c) => c.label === 'Day job')!
    expect(configsInCategory(configs, cat, groups).map((c) => c.id).sort()).toEqual(['billing', 'buildbox', 'checkout', 'conductor', 'notes'])
  })
})

describe('launchAllTargets', () => {
  it('never includes a running config, a blocked one, or a duplicate', () => {
    const running = new Set(['checkout'])
    const work = configs.filter((c) => c.groupId === 'gWork')
    const targets = launchAllTargets([...work, work[0]], running, (c) => c.provider === 'codex')
    expect(targets.map((c) => c.id)).toEqual(['conductor', 'buildbox'])
  })
  it('returns nothing when everything is running', () => {
    expect(launchAllTargets(configs, new Set(configs.map((c) => c.id)))).toEqual([])
  })
})
