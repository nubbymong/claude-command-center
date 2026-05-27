// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn().mockResolvedValue(undefined),
  saveConfigDebounced: vi.fn(),
}))

const { default: AccountAliasesSection } = await import('../../../src/renderer/components/settings/AccountAliasesSection')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

let container: HTMLDivElement
let root: Root

function makeSession(id: string, accountAliasEmail?: string) {
  return {
    id,
    label: id,
    workingDirectory: '/x',
    model: 'sonnet',
    color: 'mauve',
    status: 'idle' as const,
    createdAt: 0,
    sessionType: 'local' as const,
    accountAliasEmail,
  } as any
}

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true } as any)
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isRestoring: false,
  } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
function renderSection() { act(() => { root.render(createElement(AccountAliasesSection)) }) }

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('AccountAliasesSection', () => {
  it('renders existing aliases from settings', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountAliases: [
        { email: 'nicholas@live.co.uk', alias: 'personal' },
        { email: 'me@me.com', alias: 'work' },
      ] }, isLoaded: true,
    } as any)
    renderSection(); await flush()
    expect(container.textContent).toContain('nicholas@live.co.uk')
    expect(container.textContent).toContain('personal')
    expect(container.textContent).toContain('me@me.com')
    expect(container.textContent).toContain('work')
  })

  it('adds a new row via the add-account form (email canonicalised)', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, '  Nicholas@Live.CO.UK ')
    setInput(byTestId('add-alias-input') as HTMLInputElement, 'personal')
    act(() => { (byTestId('add-alias-btn') as HTMLButtonElement).click() })
    await flush()
    const aliases = useSettingsStore.getState().settings.accountAliases
    expect(aliases).toEqual([{ email: 'nicholas@live.co.uk', alias: 'personal' }])
  })

  it('rejects an invalid email shape', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, 'notanemail')
    setInput(byTestId('add-alias-input') as HTMLInputElement, 'alias1')
    act(() => { (byTestId('add-alias-btn') as HTMLButtonElement).click() })
    await flush()
    expect(byTestId('add-alias-error')).toBeTruthy()
    expect(useSettingsStore.getState().settings.accountAliases ?? []).toEqual([])
  })

  it('rejects an overlong alias (>16 chars)', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, 'a@b.com')
    setInput(byTestId('add-alias-input') as HTMLInputElement, 'seventeenchars123')
    act(() => { (byTestId('add-alias-btn') as HTMLButtonElement).click() })
    await flush()
    expect(byTestId('add-alias-error')).toBeTruthy()
    expect(useSettingsStore.getState().settings.accountAliases ?? []).toEqual([])
  })

  it('rejects a duplicate email (case-insensitive)', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountAliases: [
        { email: 'me@x.com', alias: 'work' },
      ] }, isLoaded: true,
    } as any)
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, 'ME@X.com')
    setInput(byTestId('add-alias-input') as HTMLInputElement, 'second')
    act(() => { (byTestId('add-alias-btn') as HTMLButtonElement).click() })
    await flush()
    expect(byTestId('add-alias-error')).toBeTruthy()
    expect(useSettingsStore.getState().settings.accountAliases?.length).toBe(1)
  })

  it('removes a row and clears matching session aliases', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountAliases: [
        { email: 'me@x.com', alias: 'work' },
        { email: 'other@y.com', alias: 'personal' },
      ] }, isLoaded: true,
    } as any)
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'me@x.com'),
        makeSession('s2', 'me@x.com'),
        makeSession('s3', 'other@y.com'),
      ],
      activeSessionId: 's1',
      isRestoring: false,
    } as any)
    renderSection(); await flush()
    act(() => { (byTestId('remove-me@x.com') as HTMLButtonElement).click() })
    await flush()
    expect(useSettingsStore.getState().settings.accountAliases).toEqual([
      { email: 'other@y.com', alias: 'personal' },
    ])
    const sessions = useSessionStore.getState().sessions
    expect(sessions.find((s) => s.id === 's1')?.accountAliasEmail).toBeUndefined()
    expect(sessions.find((s) => s.id === 's2')?.accountAliasEmail).toBeUndefined()
    // unrelated alias should still be set
    expect(sessions.find((s) => s.id === 's3')?.accountAliasEmail).toBe('other@y.com')
  })

  it('clears the add-form inputs after a successful save', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, 'a@b.com')
    setInput(byTestId('add-alias-input') as HTMLInputElement, 'work')
    act(() => { (byTestId('add-alias-btn') as HTMLButtonElement).click() })
    await flush()
    expect((byTestId('add-email-input') as HTMLInputElement).value).toBe('')
    expect((byTestId('add-alias-input') as HTMLInputElement).value).toBe('')
  })
})
