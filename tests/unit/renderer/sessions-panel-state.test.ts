/**
 * Sessions panel (two-mode left panel, canvas design pass 2026-08-24; REVISED
 * by the owner 2026-08-24 rc.1 pass): the pure state helpers. A config is a
 * TEMPLATE — it may relaunch while running, Quick Start keeps running pins,
 * and the surfaces show a live-session COUNT. What stays guarded: DELETE
 * while sessions run, and group/section launch-all fills in only what is not
 * already running (bring-up, never a silent doubling).
 */
import { describe, it, expect } from 'vitest'
import {
  resolveDefaultPanelTab,
  resolveQuickStartCollapsed,
  resolveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  quickStartConfigs,
  DELETE_WHILE_RUNNING_REASON,
  pinMenuLabel,
  PIN_WHILE_RUNNING_HINT,
  runningCountLabel,
  launchableInGroup,
  launchableInSection,
} from '../../../src/renderer/components/sidebar/sessionsPanelState'
import { runningConfigCounts } from '../../../src/renderer/components/sidebar/savedConfigsView'
import type { TerminalConfig } from '../../../src/renderer/stores/configStore'

const cfg = (id: string, over: Partial<TerminalConfig> = {}): TerminalConfig => ({
  id,
  label: id,
  workingDirectory: `/home/nick/${id}`,
  color: '',
  sessionType: 'local',
  provider: 'claude',
  ...over,
})

const counts = (entries: Array<[string, number]>) => new Map(entries)

describe('resolveDefaultPanelTab', () => {
  it("defaults to 'running' when absent (plan Q1)", () => {
    expect(resolveDefaultPanelTab(undefined)).toBe('running')
  })
  it("returns 'saved' only for the exact stored value", () => {
    expect(resolveDefaultPanelTab('saved')).toBe('saved')
    expect(resolveDefaultPanelTab('running')).toBe('running')
  })
  it("treats junk (hand edit, older file) as the default", () => {
    expect(resolveDefaultPanelTab('cards')).toBe('running')
    expect(resolveDefaultPanelTab(42)).toBe('running')
    expect(resolveDefaultPanelTab(null)).toBe('running')
  })
})

describe('resolveQuickStartCollapsed', () => {
  it('is expanded unless explicitly true', () => {
    expect(resolveQuickStartCollapsed(undefined)).toBe(false)
    expect(resolveQuickStartCollapsed(false)).toBe(false)
    expect(resolveQuickStartCollapsed('true')).toBe(false)
    expect(resolveQuickStartCollapsed(true)).toBe(true)
  })
})

describe('quickStartConfigs — every pinned config, running or not', () => {
  const configs = [
    cfg('a', { pinned: true }),
    cfg('b', { pinned: true }),
    cfg('c'), // not pinned — never in Quick Start
    cfg('d', { pinned: true }),
  ]

  it('is the pinned configs, in config order (pinned carries over, plan Q2)', () => {
    expect(quickStartConfigs(configs).map((c) => c.id)).toEqual(['a', 'b', 'd'])
  })

  it('a running pin STAYS — Quick Start can spawn another (owner revision)', () => {
    // The old design omitted running pins; the mutant that re-adds the filter
    // has no `running` argument to lean on any more, but pin the outcome:
    // membership is decided by `pinned` alone.
    expect(quickStartConfigs(configs).map((c) => c.id)).toContain('b')
  })

  it('never shows an unpinned config', () => {
    expect(quickStartConfigs(configs).map((c) => c.id)).not.toContain('c')
  })
})

describe('the delete-refusal reason (the guard itself lives at the two surfaces)', () => {
  it('says what to do', () => {
    expect(DELETE_WHILE_RUNNING_REASON).toMatch(/close/i)
    expect(DELETE_WHILE_RUNNING_REASON).toMatch(/delet/i)
  })
})

describe('runningConfigCounts — the indicator source', () => {
  it('counts per config, ask sessions excluded', () => {
    const c = runningConfigCounts([
      { configId: 'a', kind: undefined },
      { configId: 'a', kind: undefined },
      { configId: 'b', kind: undefined },
      { configId: 'a', kind: 'ask' },
    ] as never)
    expect(c.get('a')).toBe(2)
    expect(c.get('b')).toBe(1)
    expect(c.get('missing')).toBeUndefined()
  })
})

describe('launch-all fills in what is missing (bring-up, not doubling)', () => {
  const configs = [
    cfg('g1', { groupId: 'G' }),
    cfg('g2', { groupId: 'G' }),
    cfg('loose', { sectionId: 'S' }),
    cfg('other'),
  ]
  const groups = [{ id: 'G', name: 'Group', sectionId: 'S' }]

  it('group launch-all filters the running config out', () => {
    expect(launchableInGroup(configs, 'G', counts([['g1', 1]])).map((c) => c.id)).toEqual(['g2'])
    expect(launchableInGroup(configs, 'G', new Map()).map((c) => c.id)).toEqual(['g1', 'g2'])
  })

  it('group launch-all is empty when every member runs (silent no-op, like an empty group)', () => {
    expect(launchableInGroup(configs, 'G', counts([['g1', 1], ['g2', 2]]))).toEqual([])
  })

  it("section launch-all covers the section's groups + loose configs, minus running", () => {
    expect(launchableInSection(configs, groups, 'S', counts([['g2', 1]])).map((c) => c.id)).toEqual(['g1', 'loose'])
    expect(launchableInSection(configs, groups, 'S', new Map()).map((c) => c.id)).toEqual(['g1', 'g2', 'loose'])
  })
})

describe('pin menu + count labels', () => {
  it('verb flips with the pinned flag', () => {
    expect(pinMenuLabel(undefined)).toBe('Pin to Quick Start')
    expect(pinMenuLabel(false)).toBe('Pin to Quick Start')
    expect(pinMenuLabel(true)).toBe('Unpin from Quick Start')
  })
  it('the while-running hint says Quick Start can spawn another — not that it waits', () => {
    expect(PIN_WHILE_RUNNING_HINT).toMatch(/another/i)
    expect(PIN_WHILE_RUNNING_HINT).not.toMatch(/closes/i)
  })
  it('the count pill label reads naturally for one and many', () => {
    expect(runningCountLabel(1)).toMatch(/^1 session running/)
    expect(runningCountLabel(3)).toMatch(/^3 sessions running/)
  })
})

describe('resolveSidebarWidth (#461)', () => {
  it('absent or garbage falls back to the default', () => {
    expect(resolveSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(resolveSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(resolveSidebarWidth('wide')).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(resolveSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(resolveSidebarWidth(Infinity)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
  it('clamps a hand-edited value into the working range', () => {
    expect(resolveSidebarWidth(0)).toBe(SIDEBAR_WIDTH_MIN)
    expect(resolveSidebarWidth(-50)).toBe(SIDEBAR_WIDTH_MIN)
    expect(resolveSidebarWidth(99999)).toBe(SIDEBAR_WIDTH_MAX)
  })
  it('keeps an in-range value (rounded)', () => {
    expect(resolveSidebarWidth(300)).toBe(300)
    expect(resolveSidebarWidth(300.6)).toBe(301)
  })
})
