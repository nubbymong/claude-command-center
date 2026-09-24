// @vitest-environment jsdom
/**
 * WP2 commit 6e: "Check again" on the Settings, Accounts Providers card.
 *
 * A provider whose CLI was not found, did not run, could not be checked, or
 * is too old (or unsupported) gets "Check again", which asks main to look
 * for the CLI again (discover); main's answer arrives with the snapshot it
 * pushes, and its proven executable is replaced by that check. A ready or
 * turned-off provider has no such button.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ProviderInstallationView } from '../../../src/shared/providers'
import { provider, snapshot } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const pa = {
  discover: vi.fn(),
  setEnabled: vi.fn(async () => ({ ok: true })),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }

const { ProvidersCard, offersCheckAgain } = await import('../../../src/renderer/components/settings/accounts/ProvidersCard')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  pa.discover.mockReset()
  pa.discover.mockResolvedValue({ ok: true, installation: {} })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function codex(over: Partial<ProviderInstallationView>): ProviderInstallationView {
  return provider({ providerId: 'codex', displayName: 'Codex', ...over })
}

async function render(codexView: ProviderInstallationView, claudeView?: ProviderInstallationView) {
  useProviderAccountsStore.setState({
    snapshot: snapshot({ providers: [claudeView ?? provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281' }), codexView] }),
    loaded: true,
  })
  await act(async () => { root.render(<ProvidersCard />) })
}

describe('Providers card: Check again', () => {
  it('a missing CLI gets Check again, which asks main to look again', async () => {
    await render(codex({ discoveryState: 'missing', version: undefined }))
    const btn = byTest('provider-check-again-codex')!
    expect(btn.textContent).toBe('Check again')
    await act(async () => { btn.click() })
    expect(pa.discover).toHaveBeenCalledTimes(1)
    expect(pa.discover).toHaveBeenCalledWith('codex')
  })

  it('a too-old CLI gets it too', async () => {
    await render(codex({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('provider-check-again-codex')).not.toBeNull()
  })

  it('so does a CLI that did not run or could not be checked, and an unsupported one', () => {
    expect(offersCheckAgain(codex({ discoveryState: 'invalid' }))).toBe(true)
    expect(offersCheckAgain(codex({ discoveryState: 'error' }))).toBe(true)
    expect(offersCheckAgain(codex({ discoveryState: 'found', compatibility: 'unsupported' }))).toBe(true)
  })

  it('a ready, newer-than-tested, unchecked or turned-off provider has none', async () => {
    expect(offersCheckAgain(codex({}))).toBe(false)
    expect(offersCheckAgain(codex({ compatibility: 'too-new' }))).toBe(false)
    expect(offersCheckAgain(codex({ discoveryState: 'unchecked' }))).toBe(false)
    expect(offersCheckAgain(codex({ enabled: false, discoveryState: 'missing' }))).toBe(false)
    await render(codex({}))
    expect(byTest('provider-check-again-codex')).toBeNull()
    expect(byTest('provider-check-again-claude')).toBeNull()
  })

  it('works for Claude Code too', async () => {
    await render(codex({}), provider({ providerId: 'claude', displayName: 'Claude Code', discoveryState: 'missing', version: undefined }))
    await act(async () => { byTest('provider-check-again-claude')!.click() })
    expect(pa.discover).toHaveBeenCalledWith('claude')
  })

  it('says it is checking while main looks, and shows a failure', async () => {
    let answer: (v: unknown) => void = () => {}
    pa.discover.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    await render(codex({ discoveryState: 'missing', version: undefined }))
    await act(async () => { byTest('provider-check-again-codex')!.click() })
    const btn = byTest('provider-check-again-codex') as HTMLButtonElement
    expect(btn.textContent).toBe('Checking...')
    expect(btn.disabled).toBe(true)
    await act(async () => { answer({ ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' }) })
    expect(byTest('provider-error-codex')!.textContent).toBe('The account list is not available right now.')
  })
})
