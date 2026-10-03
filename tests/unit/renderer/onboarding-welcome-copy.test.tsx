// @vitest-environment jsdom
/**
 * The Welcome page's opening line follows whether Claude Code is part of this
 * run (VM audit 2026-09-25, item 5): a Codex-only run was told the app sits
 * "on top of the Claude Code you already use".
 *
 * Verifies:
 *   - with Claude Code on, the line is unchanged;
 *   - with Claude Code off (the saved setting, or main's switch), or when
 *     first-run setup found no Claude Code CLI and the user chose "Use Codex
 *     only", the line names no Claude and no Claude-only feature.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { provider, snapshot } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { WelcomeStep } = await import('../../../src/renderer/onboarding/WelcomeStep')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { resetProviderChoiceForTests, noteClaudeMissingAtSetup } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useProviderAccountsStore.setState({ snapshot: null, loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function lede(): Promise<string> {
  await act(async () => { root.render(<WelcomeStep onNext={() => {}} />) })
  return container.querySelector('[data-testid="welcome-lede"]')!.textContent!.replace(/\s+/g, ' ').trim()
}

const WITH_CLAUDE = 'Welcome. I built AI Code Conductor to sit on top of the Claude Code you already use. It runs your sessions and adds accounts, status lines, history and cost tracking on top.'

function expectNoClaude(text: string) {
  expect(text).not.toMatch(/claude/i)
  // The status line is Claude Code's; a run without it has none.
  expect(text).not.toMatch(/status line/i)
  expect(text).toContain('AI Code Conductor')
  expect(text).not.toContain(String.fromCodePoint(0x2014))
}

describe('the Welcome lede', () => {
  it('with Claude Code on: the Claude Code line, unchanged', async () => {
    expect(await lede()).toBe(WITH_CLAUDE)
  })

  it('with Claude Code off in the saved setting: no Claude', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true }, isLoaded: true })
    expectNoClaude(await lede())
  })

  it('with Claude Code switched off in main: no Claude', async () => {
    useProviderAccountsStore.setState({
      snapshot: snapshot({ providers: [provider({ providerId: 'claude', displayName: 'Claude Code', enabled: false }), provider({ providerId: 'codex', displayName: 'Codex' })] }),
      loaded: true,
    })
    expectNoClaude(await lede())
  })

  it('after first-run setup found no Claude Code CLI ("Use Codex only"): no Claude', async () => {
    noteClaudeMissingAtSetup()
    expectNoClaude(await lede())
  })
})
