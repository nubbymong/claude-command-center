// @vitest-environment jsdom
/**
 * Row 14 (Codex-only mode, no Claude noise) and OD27 M1 D5 on the AI usage
 * popover under the Copilot chip: a provider that is off (or Codex not set
 * up) has no section. Claude Code off shows the one muted D5 line where its
 * section would be; Codex off or not set up shows nothing. The on/off is the
 * one the Account usage page reads (useClaudeOff, usesCodex), through the
 * real settings and session stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: AiUsagePopover } = await import('../../../src/renderer/components/AiUsagePopover')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const D5_LINE = 'Claude Code is off. Turn it on in Settings, Accounts to see its accounts.'

let container: HTMLDivElement
let root: Root

// One session of each assistant, each with a figure only its own section
// shows: 77% is the Codex 5h window, 42% the Claude one.
const SESSIONS = [
  { id: 'claude-1', status: 'idle', createdAt: 2, provider: 'claude', rateLimitCurrent: 42 },
  { id: 'codex-1', status: 'idle', createdAt: 1, provider: 'codex', rateLimitCurrent: 77 },
]

function setSwitches(over: { claudeEnabled?: boolean; codexEnabled?: boolean }) {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...over } }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending', aiUsageCycle: null })
  // The active session is the Claude one: the strongest case for Claude Code
  // off, a session still listed after its switch was turned off.
  useSessionStore.setState({ sessions: SESSIONS, activeSessionId: 'claude-1' } as never)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useSessionStore.setState({ sessions: [], activeSessionId: null } as never)
})

async function render() {
  await act(async () => {
    root.render(React.createElement(AiUsagePopover, { open: true, onClose: () => {} }))
  })
}

const text = () => container.textContent ?? ''
const d5Lines = () => Array.from(container.querySelectorAll('div')).filter((el) => el.textContent === D5_LINE)

describe('AI usage popover: a provider that is off has no section (row 14, OD27 M1 D5)', () => {
  it('Claude Code only (Codex answered off): no Codex section; the Claude section as before', async () => {
    setSwitches({ claudeEnabled: true, codexEnabled: false })
    await render()
    expect(text()).not.toMatch(/codex/i)
    expect(text()).not.toContain('77%')
    expect(text()).toContain('42%')
    expect(d5Lines()).toHaveLength(0)
  })

  it('Codex not set up (never answered) reads as off: no Codex section', async () => {
    await render() // DEFAULT_SETTINGS: neither switch saved
    expect(text()).not.toMatch(/codex/i)
    expect(text()).not.toContain('77%')
    expect(text()).toContain('42%')
  })

  it('Codex only (Claude Code off): the one muted D5 line where the Claude section was, no Claude figure', async () => {
    setSwitches({ claudeEnabled: false, codexEnabled: true })
    await render()
    expect(text()).toContain('Codex')
    expect(text()).toContain('77%')
    expect(text()).not.toContain('42%')
    const lines = d5Lines()
    expect(lines).toHaveLength(1)
    expect(lines[0].style.color).toBe('var(--text-muted)')
    // Nothing else names Claude: no section, no "no Claude session" note.
    expect(text().replace(D5_LINE, '')).not.toMatch(/claude/i)
  })

  it('both on: both sections as before, and no D5 line', async () => {
    setSwitches({ claudeEnabled: true, codexEnabled: true })
    await render()
    expect(text()).toContain('Codex')
    expect(text()).toContain('77%')
    expect(text()).toContain('42%')
    expect(d5Lines()).toHaveLength(0)
  })

  it('a switch flipped in Settings while the popover is open re-renders it', async () => {
    setSwitches({ claudeEnabled: true, codexEnabled: true })
    await render()
    await act(async () => { setSwitches({ claudeEnabled: false }) })
    expect(text()).not.toContain('42%')
    expect(d5Lines()).toHaveLength(1)
    await act(async () => { setSwitches({ claudeEnabled: true, codexEnabled: false }) })
    expect(text()).toContain('42%')
    expect(text()).not.toMatch(/codex/i)
    expect(d5Lines()).toHaveLength(0)
  })
})
