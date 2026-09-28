// @vitest-environment jsdom
//
// P3.4 (rows 45 and 14): the title bar shows each provider's status pills
// only while that provider is on. Claude Code's are the two it always had
// (Code and Claude.ai, with API only when it is not operational); Codex gets
// one pill from OpenAI's status page, with Codex API only when it is not
// operational, the same way. A provider that is off has no pill and does not
// tint the bar, even from a reading taken before it was turned off.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let settings: Record<string, unknown> = {}
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: any) => any) => selector({ settings: { updateChannel: 'stable', ...settings } }),
}))
vi.mock('../../../src/renderer/components/ThemeToggle', () => ({ default: () => createElement('div') }))
vi.mock('../../../src/renderer/components/ConductorHealthPill', () => ({ default: () => createElement('div') }))
vi.mock('../../../src/renderer/components/sentinel/SentinelDot', () => ({ default: () => createElement('div') }))

const { default: TitleBar } = await import('../../../src/renderer/components/TitleBar')

const now = new Date().toISOString()
const comp = (id: string, label: string, status: string) => ({ id, label, name: label, status })
function payload(opts: { claude?: boolean; codex?: boolean; claudeStatus?: string; codexStatus?: string; codexApiStatus?: string } = {}) {
  const claude = opts.claude !== false
  const codex = opts.codex === true
  return {
    fetchedAt: now,
    claudeCode: claude ? comp('yyzkbfz2thpt', 'Claude Code', opts.claudeStatus ?? 'operational') : null,
    claudeAi: claude ? comp('rwppv331jlwc', 'Claude.ai', 'operational') : null,
    api: claude ? comp('k8w3r06qmzrp', 'API', 'operational') : null,
    codexCli: codex ? comp('01KMKFAMWKNQ84Z1766MV08ZDE', 'Codex CLI', opts.codexStatus ?? 'operational') : null,
    codexApi: codex ? comp('01KMP3KP5MGE23B80K1EK4S8PV', 'Codex API', opts.codexApiStatus ?? 'operational') : null,
    claudeReadAt: claude ? now : null,
    codexReadAt: codex ? now : null,
    worst: 'operational',
  }
}

let container: HTMLDivElement
let root: Root

async function render(p: unknown): Promise<void> {
  ;(globalThis as any).window.electronAPI.serviceStatus.get = vi.fn().mockResolvedValue(p)
  await act(async () => { root.render(createElement(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const pills = (): string[] => [...container.querySelectorAll('[data-testid^="status-pill-"]')].map((e) => e.getAttribute('data-testid')!.slice('status-pill-'.length))
const bg = (): string => (container.firstChild as HTMLElement).style.background

beforeEach(() => {
  settings = {}
  ;(globalThis as any).window.electronAPI = {
    window: { isMaximized: vi.fn().mockResolvedValue(false), onMaximizedChanged: vi.fn().mockReturnValue(() => {}), minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() },
    serviceStatus: { get: vi.fn().mockResolvedValue(null), onUpdate: vi.fn().mockReturnValue(() => {}) },
    serviceHealth: { get: vi.fn().mockResolvedValue(null), restart: vi.fn(), onUpdate: vi.fn().mockReturnValue(() => {}) },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('title-bar provider status pills', () => {
  it('Claude Code only (Codex not set up): the Code and Claude.ai pills, as before, and no Codex pill', async () => {
    await render(payload())
    expect(pills()).toEqual(['Code', 'Claude.ai'])
  })

  it('Codex only (Claude Code off): the Codex pill, and no Anthropic pill even from an earlier reading', async () => {
    settings = { claudeEnabled: false, codexEnabled: true }
    await render(payload({ claude: true, codex: true, claudeStatus: 'major_outage' }))
    expect(pills()).toEqual(['Codex'])
    expect(container.textContent).not.toContain('Claude')
    // Claude's outage, read before it was switched off, does not tint the bar.
    expect(bg()).not.toContain('color-mix')
    const group = container.querySelector('[data-testid="status-group-codex"]') as HTMLElement
    expect(group.title).toContain('Codex CLI: Operational')
    expect(group.title).toContain('Codex API: Operational')
  })

  it('both on: both providers\' pills, Claude\'s first', async () => {
    settings = { codexEnabled: true }
    await render(payload({ codex: true }))
    expect(pills()).toEqual(['Code', 'Claude.ai', 'Codex'])
  })

  it('Codex on but its page not read yet: no Codex pill (Claude Code keeps its own)', async () => {
    settings = { codexEnabled: true }
    await render(payload({ codex: false }))
    expect(pills()).toEqual(['Code', 'Claude.ai'])
  })

  it('Codex off: a Codex reading taken before it was turned off shows nothing', async () => {
    settings = { codexEnabled: false }
    await render(payload({ codex: true, codexStatus: 'major_outage' }))
    expect(pills()).toEqual(['Code', 'Claude.ai'])
    expect(bg()).not.toContain('color-mix')
  })

  it('Codex API not operational: its own pill appears, as Claude\'s API pill does, and the bar is tinted', async () => {
    settings = { claudeEnabled: false, codexEnabled: true }
    await render(payload({ claude: false, codex: true, codexApiStatus: 'partial_outage' }))
    expect(pills()).toEqual(['Codex', 'Codex API'])
    expect(bg()).toContain('color-mix')
  })

  it('a Codex outage is shown on its pill', async () => {
    settings = { claudeEnabled: false, codexEnabled: true }
    await render(payload({ claude: false, codex: true, codexStatus: 'major_outage' }))
    const pill = container.querySelector('[data-testid="status-pill-Codex"]') as HTMLElement
    expect(pill.textContent).toContain('Outage')
    expect(pill.title).toBe('Codex: Major Outage')
  })
})
