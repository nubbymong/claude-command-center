/**
 * Sessions panel (two-mode left panel, canvas design pass 2026-08-24): the
 * pure state helpers. The default tab resolves to Running unless 'saved' is
 * stored; Quick Start is launch-only (a pinned config with a live session is
 * omitted and returns when it closes — the old duplicate-pinned-at-top bug
 * cannot recur); a running config is locked against editing; the pin menu
 * verb flips with the pinned flag and pinning-while-running stays allowed.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveDefaultPanelTab,
  resolveQuickStartCollapsed,
  quickStartConfigs,
  quickStartRunningCount,
  canEditConfig,
  pinMenuLabel,
  PIN_WHILE_RUNNING_HINT,
} from '../../../src/renderer/components/sidebar/sessionsPanelState'
import { runningConfigIds } from '../../../src/renderer/components/sidebar/savedConfigsView'
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

describe('quickStartConfigs', () => {
  const configs = [
    cfg('a', { pinned: true }),
    cfg('b', { pinned: true }),
    cfg('c'), // not pinned — never in Quick Start
    cfg('d', { pinned: true }),
  ]

  it('is the pinned configs when nothing runs (pinned carries over, plan Q2)', () => {
    expect(quickStartConfigs(configs, new Set()).map((c) => c.id)).toEqual(['a', 'b', 'd'])
  })

  it('omits a pinned config whose session is live — launch-only', () => {
    const running = new Set(['b'])
    expect(quickStartConfigs(configs, running).map((c) => c.id)).toEqual(['a', 'd'])
    expect(quickStartRunningCount(configs, running)).toBe(1)
  })

  it('returns the config when its session closes', () => {
    const while_running = quickStartConfigs(configs, new Set(['a', 'b', 'd']))
    expect(while_running).toEqual([])
    expect(quickStartRunningCount(configs, new Set(['a', 'b', 'd']))).toBe(3)
    const after_close = quickStartConfigs(configs, new Set(['b']))
    expect(after_close.map((c) => c.id)).toEqual(['a', 'd'])
  })

  it('never shows an unpinned running config anywhere in Quick Start', () => {
    expect(quickStartConfigs(configs, new Set(['c'])).map((c) => c.id)).toEqual(['a', 'b', 'd'])
    expect(quickStartRunningCount(configs, new Set(['c']))).toBe(0)
  })
})

describe('canEditConfig — the running lock', () => {
  it('locks a config with a live session and frees it after', () => {
    const running = runningConfigIds([
      { configId: 'a', kind: undefined },
      { configId: undefined, kind: undefined },
    ] as never)
    expect(canEditConfig('a', running)).toBe(false)
    expect(canEditConfig('b', running)).toBe(true)
    expect(canEditConfig('a', new Set())).toBe(true)
  })

  it('an ask session locks nothing (config-less by design)', () => {
    const running = runningConfigIds([{ configId: 'a', kind: 'ask' }] as never)
    expect(canEditConfig('a', running)).toBe(true)
  })
})

describe('pin menu', () => {
  it('verb flips with the pinned flag', () => {
    expect(pinMenuLabel(undefined)).toBe('Pin to Quick Start')
    expect(pinMenuLabel(false)).toBe('Pin to Quick Start')
    expect(pinMenuLabel(true)).toBe('Unpin from Quick Start')
  })
  it('the while-running hint names the deferred behaviour', () => {
    expect(PIN_WHILE_RUNNING_HINT).toMatch(/quick-start/i)
    expect(PIN_WHILE_RUNNING_HINT).toMatch(/closes/i)
  })
})
