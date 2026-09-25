// @vitest-environment jsdom
/**
 * WP2 commit 6e (canvas F1): "Which assistants will you use?".
 *
 * Verifies:
 *   - the three cards with the app's own provider marks, Beta on Codex only,
 *     Both selected by default, and the local-only line;
 *   - after first-run setup's "Use Codex only": Codex selected, Claude Code
 *     and Both disabled with "Claude Code is not installed";
 *   - coming back to the page shows the choice already saved;
 *   - Continue saves BOTH keys through the Providers switch path (main's
 *     setEnabled first, then the saved setting), turning on before turning
 *     off, and moves on only once that is done;
 *   - a refusal from main is shown and nothing moves on, and so is an
 *     `internal` failure (review fix: it is an answer, not "no answer"); a
 *     main with no account list yet (`registry-unavailable`, the one "cannot
 *     answer") does not strand the first run: the settings are saved alone.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Answer = { ok: true } | { ok: false; code: string; message: string; consumers?: number }
const setEnabled = vi.fn<(providerId: string, enabled: boolean) => Promise<Answer>>()
const configSave = vi.fn(async () => true)
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  providerAccounts: { setEnabled },
  config: { ...((globalThis as any).window.electronAPI?.config ?? {}), save: configSave },
}

const { AssistantsStep } = await import('../../../src/renderer/onboarding/AssistantsStep')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { resetProviderChoiceForTests, noteClaudeMissingAtSetup } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root
const onNext = vi.fn()
const onBack = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setEnabled.mockReset()
  setEnabled.mockResolvedValue({ ok: true })
  configSave.mockClear()
  onNext.mockReset()
  onBack.mockReset()
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const card = (c: string) => byTest(`assistants-card-${c}`) as HTMLButtonElement
const checked = (c: string) => card(c).getAttribute('aria-checked') === 'true'

async function render() {
  await act(async () => { root.render(<AssistantsStep onNext={onNext} onBack={onBack} />) })
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

async function continueWith(choice?: 'claude' | 'codex' | 'both') {
  if (choice) await act(async () => { card(choice).click() })
  await act(async () => { byTest('assistants-continue')!.click() })
  await flush()
}

describe('the cards', () => {
  it('three cards with the real provider marks, Beta on Codex only, Both selected by default', async () => {
    await render()
    expect(container.querySelector('h2')!.textContent).toBe('Which assistants will you use?')
    expect(card('claude').textContent).toContain('Claude Code')
    expect(card('claude').textContent).toContain("Anthropic's coding agent")
    expect(card('codex').textContent).toContain("OpenAI's coding agent")
    expect(card('codex').textContent).toContain('Beta')
    expect(card('claude').textContent).not.toContain('Beta')
    expect(card('both').textContent).not.toContain('Beta')
    expect(card('claude').querySelector('[data-testid="provider-mark-claude"]')).not.toBeNull()
    expect(card('codex').querySelector('[data-testid="provider-mark-codex"]')).not.toBeNull()
    expect(card('both').querySelector('[data-testid="provider-mark-claude"]')).not.toBeNull()
    expect(card('both').querySelector('[data-testid="provider-mark-codex"]')).not.toBeNull()
    expect([checked('claude'), checked('codex'), checked('both')]).toEqual([false, false, true])
    for (const c of ['claude', 'codex', 'both']) expect(card(c).disabled).toBe(false)
    expect(byTest('assistants-local-note')!.textContent).toBe('Codex sessions run on this computer only in this release.')
  })

  it('selecting a card selects only it', async () => {
    await render()
    await act(async () => { card('claude').click() })
    expect([checked('claude'), checked('codex'), checked('both')]).toEqual([true, false, false])
  })

  it('after "Use Codex only": Codex selected; Claude Code and Both disabled, saying why', async () => {
    noteClaudeMissingAtSetup()
    await render()
    expect([checked('claude'), checked('codex'), checked('both')]).toEqual([false, true, false])
    expect(card('claude').disabled).toBe(true)
    expect(card('both').disabled).toBe(true)
    expect(card('codex').disabled).toBe(false)
    expect(byTest('assistants-why-claude')!.textContent).toBe('Claude Code is not installed')
    expect(byTest('assistants-why-both')!.textContent).toBe('Claude Code is not installed')
    expect(byTest('assistants-why-codex')).toBeNull()
  })

  it('coming back shows the choice already saved', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
    await render()
    expect(checked('codex')).toBe(true)
    expect(card('claude').disabled).toBe(false)
    act(() => { root.unmount() })
    root = createRoot(container)
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: false } })
    await render()
    expect(checked('claude')).toBe(true)
  })

  it('Back goes back', async () => {
    await render()
    await act(async () => { (container.querySelector('.foot .back') as HTMLElement).click() })
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('Continue saves the choice the way the Providers switch does', () => {
  it('Both: Claude Code on, then Codex on; both keys saved', async () => {
    await render()
    await continueWith()
    expect(setEnabled.mock.calls).toEqual([['claude', true], ['codex', true]])
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBe(true)
    expect(s.codexEnabled).toBe(true)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('Codex: Codex on BEFORE Claude Code off (main refuses the last provider off)', async () => {
    await render()
    await continueWith('codex')
    expect(setEnabled.mock.calls).toEqual([['codex', true], ['claude', false]])
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBe(false)
    expect(s.codexEnabled).toBe(true)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('Claude Code: Claude Code on, then Codex off', async () => {
    await render()
    await continueWith('claude')
    expect(setEnabled.mock.calls).toEqual([['claude', true], ['codex', false]])
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBe(true)
    expect(s.codexEnabled).toBe(false)
  })

  it('moves on only once the choice is saved', async () => {
    let release: (a: Answer) => void = () => {}
    setEnabled.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await render()
    await act(async () => { byTest('assistants-continue')!.click() })
    expect(onNext).not.toHaveBeenCalled()
    expect(byTest('assistants-continue')!.textContent).toBe('Saving...')
    await act(async () => { release({ ok: true }) })
    await flush()
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('a refusal is shown, nothing moves on, and the refused key is not saved', async () => {
    setEnabled.mockImplementation(async (id, on) =>
      id === 'claude' && !on ? { ok: false, code: 'consumers', message: 'in use', consumers: 2 } : { ok: true })
    await render()
    await continueWith('codex')
    expect(onNext).not.toHaveBeenCalled()
    expect(byTest('assistants-error')!.textContent).toContain('(2)')
    expect(useSettingsStore.getState().settings.claudeEnabled).toBeUndefined()
  })

  it('an internal failure in main is an answer: returned and shown, nothing saved over it, nothing moves on', async () => {
    setEnabled.mockResolvedValue({ ok: false, code: 'internal', message: 'That did not work; try again.' })
    await render()
    await continueWith('codex')
    expect(onNext).not.toHaveBeenCalled()
    expect(byTest('assistants-error')!.textContent).toContain('That did not work; try again.')
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBeUndefined()
    expect(s.codexEnabled).toBeUndefined()
    expect(configSave).not.toHaveBeenCalled()
    // Stopped at the first failure: the second provider was never asked.
    expect(setEnabled).toHaveBeenCalledTimes(1)
  })

  it('an IPC call that throws reads as internal too, and is returned the same way', async () => {
    setEnabled.mockRejectedValue(new Error('ipc gone'))
    await render()
    await continueWith('both')
    expect(onNext).not.toHaveBeenCalled()
    expect(byTest('assistants-error')).not.toBeNull()
    expect(useSettingsStore.getState().settings.codexEnabled).toBeUndefined()
    expect(configSave).not.toHaveBeenCalled()
  })

  it('when main cannot answer, the settings are saved alone and the run goes on', async () => {
    setEnabled.mockResolvedValue({ ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' })
    await render()
    await continueWith('codex')
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBe(false)
    expect(s.codexEnabled).toBe(true)
    expect(onNext).toHaveBeenCalledTimes(1)
    const saved = configSave.mock.calls.map((c) => (c as unknown as [string, Record<string, unknown>])[1]).at(-1)!
    expect(saved.claudeEnabled).toBe(false)
    expect(saved.codexEnabled).toBe(true)
  })

  it('a save that does not land is shown and nothing moves on, whether main agreed or could not answer (WP2 final fixes)', async () => {
    // The config save answers false (it did not land): updateSettings RESOLVES false, it does not throw.
    configSave.mockResolvedValue(false)
    try {
      for (const answer of [{ ok: true } as Answer, { ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' } as Answer]) {
        setEnabled.mockReset()
        setEnabled.mockResolvedValue(answer)
        onNext.mockReset()
        await render()
        await continueWith('codex')
        expect(onNext).not.toHaveBeenCalled()
        expect(byTest('assistants-error')?.textContent).toContain('The change could not be saved.')
      }
    } finally {
      configSave.mockResolvedValue(true)
    }
  })
})
