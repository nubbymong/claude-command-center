// @vitest-environment jsdom
/**
 * [host] The owner's 2026-10-04 answer on tips: no provider filter; each tip
 * about something only one assistant has carries that assistant's mark (the
 * app's own Claude Code / Codex mark, ProviderMark), and a tip that applies to
 * both assistants, or to the app itself, carries none.
 *
 * The classification below was made against the code as it is (PR 4): Codex
 * runs on this computer only (no SSH, no SSH Persistent, no container
 * runtime), Insights and the Artifacts button are Claude Code's, the Multiple
 * Accounts card is Claude's in the Feature Guide (needsClaude), and the tips
 * named for Codex are about Codex alone. Tips that need both assistants (Ask
 * Conductor runs on, Code review both ways) are about both, so unmarked.
 * Adding a tip means deciding its mark here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: TipCard } = await import('../../../src/renderer/components/TipCard')
const { useTipsStore, countUnseenTips } = await import('../../../src/renderer/stores/tipsStore')
const { TIPS_LIBRARY, TIP_PROVIDER_NAMES } = await import('../../../src/renderer/tips-library')

const CLAUDE_ONLY = [
  'tip.effort-level', 'tip.ssh-config', 'tip.ssh-account-tools', 'tip.artifacts-button', 'tip.insights',
  'tip.transparency.statusline-injection', 'tip.dynamic-workflows', 'tip.ssh-persistence', 'tip.remote-resumable',
  'tip.container-runtime', 'tip.multi-account', 'tip.config-edit-guard',
]
const CODEX_ONLY = [
  'tip.codex-sessions', 'tip.codex-accounts-reviewer', 'tip.codex-restart-pick', 'tip.codex-check-sign-in',
  'tip.codex-switch-account', 'tip.codex-plan-compact', 'tip.codex-windows-sandbox', 'tip.hello-codex-replay',
]

describe('which tips carry a mark', () => {
  it('[host] every tip is classified: the Claude Code ones, the Codex ones, and none on the rest', () => {
    const ids = TIPS_LIBRARY.map((t) => t.id)
    for (const id of [...CLAUDE_ONLY, ...CODEX_ONLY]) expect(ids, id).toContain(id)
    const marked = (p: string) => TIPS_LIBRARY.filter((t) => t.provider === p).map((t) => t.id).sort()
    expect(marked('claude')).toEqual([...CLAUDE_ONLY].sort())
    expect(marked('codex')).toEqual([...CODEX_ONLY].sort())
    for (const t of TIPS_LIBRARY) expect([undefined, 'claude', 'codex'], t.id).toContain(t.provider)
  })

  it('[host] a tip named for Codex is marked for Codex', () => {
    for (const t of TIPS_LIBRARY.filter((x) => x.id.startsWith('tip.codex-'))) expect(t.provider, t.id).toBe('codex')
  })

  it('[host] the marks name the assistants as the rest of the app does', () => {
    expect(TIP_PROVIDER_NAMES).toEqual({ claude: 'Claude Code', codex: 'Codex' })
  })
})

let container: HTMLDivElement
let root: Root
const EMPTY = { features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useTipsStore.setState({ tracking: EMPTY, currentTipId: null, silencedUntilRestart: false, isLoaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function show(id: string) {
  useTipsStore.setState({ currentTipId: id })
  act(() => { root.render(<TipCard onClose={() => {}} />) })
  const header = container.querySelector('[data-testid="tip-card-header"]')
  expect(header, `${id} must render`).not.toBeNull()
  return header!
}

describe('the tip card shows the mark', () => {
  it('[host] a Codex tip carries the Codex mark beside its title, named for Codex', () => {
    const header = show('tip.codex-sessions')
    const mark = header.querySelector('[data-testid="provider-mark-codex"]')
    expect(mark).not.toBeNull()
    expect(mark!.getAttribute('title')).toBe('Codex')
    expect(header.querySelector('[data-testid="provider-mark-claude"]')).toBeNull()
    expect(header.querySelector('#tip-card-title')!.contains(mark)).toBe(true)
  })

  it('[host] a Claude Code tip carries the Claude Code mark', () => {
    const header = show('tip.dynamic-workflows')
    const mark = header.querySelector('[data-testid="provider-mark-claude"]')
    expect(mark).not.toBeNull()
    expect(mark!.getAttribute('title')).toBe('Claude Code')
    expect(header.querySelector('[data-testid="provider-mark-codex"]')).toBeNull()
  })

  it('[host] a tip for both assistants, or the app itself, carries no mark', () => {
    for (const id of ['tip.pages-as-tabs', 'tip.session-watchdog', 'tip.ask-conductor']) {
      const header = show(id)
      expect(header.querySelector('[data-testid^="provider-mark-"]'), id).toBeNull()
    }
  })
})

describe('no provider filter', () => {
  it('[host] marked tips stay in the rotation: the store offers every tip as before', () => {
    // countUnseenTips counts what the rotation can still offer. With no usage
    // yet and no platform known (no preload here), that is every tip with
    // nothing to wait for, marked or not.
    expect((window as { electronPlatform?: string }).electronPlatform).toBeUndefined()
    expect(countUnseenTips(EMPTY)).toBe(TIPS_LIBRARY.filter((t) => !t.requires?.length).length)
    for (const id of ['tip.dynamic-workflows', 'tip.codex-sessions']) {
      useTipsStore.setState({ currentTipId: id })
      expect(useTipsStore.getState().getCurrentTip()?.tip.id, id).toBe(id)
    }
  })
})
