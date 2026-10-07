// @vitest-environment jsdom
/**
 * [host] WP2 PR 4, P4.5 (row 57): Cloud Agents on Codex, in the renderer.
 *
 *   - New agent: with both assistants on, an Assistant choice (Claude Code
 *     first); with one on, that one, no choice; Codex accounts listed as the
 *     New session dialog lists them; the per-run choice worded as Codex's
 *     Auto preset (section 10, question 7, default A), with the Windows known
 *     issue beside it; a sign-in that needs each launch confirmed holds
 *     Dispatch until it is ticked, for exactly that account; the request
 *     carries only the provider's own fields (a Codex config's model and
 *     effort; never a profile or a pinned Claude version).
 *   - The store: a Codex agent is refused only by Codex being off or not set
 *     up (never by Claude Code being off), main's rejection is shown; a Retry
 *     of an agent whose sign-in needs confirming asks first and sends the
 *     acknowledgement only on a yes.
 *   - The page: Retry is held back by the agent's own provider; the summary
 *     names the assistant and the Codex account.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { snapshot, local } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), retryFailedConfigSaves: vi.fn() }))

const api = {
  cloudAgent: {
    dispatch: vi.fn(async () => ({ id: 'agent-1' })),
    retry: vi.fn(async () => ({ id: 'agent-2' })),
    cancel: vi.fn(async () => true),
    remove: vi.fn(async () => ({ ok: true, removed: true })),
    onStatusChanged: vi.fn(() => () => {}),
    onOutputChunk: vi.fn(() => () => {}),
  },
  accountProfiles: { authInfo: vi.fn(async () => []) },
  dialog: { openFolder: vi.fn(async () => null) },
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, ...api }

const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useCloudAgentStore, CODEX_AGENT_OFF, CODEX_AGENT_NOT_SET_UP, CODEX_AUTO_LABEL, CODEX_AGENT_WINDOWS_NOTE, CONFIRM_SIGN_IN } = await import('../../../src/renderer/stores/cloudAgentStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useLaunchAckStore } = await import('../../../src/renderer/stores/launchAckStore')
const { default: NewAgentDialog } = await import('../../../src/renderer/components/NewAgentDialog')
const { SummaryTab } = await import('../../../src/renderer/components/CloudAgentsPage')

const CLAUDE_OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'

let container: HTMLDivElement
let root: Root

const assistants = (claudeEnabled: boolean | undefined, codexEnabled: boolean | undefined) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled, codexEnabled }, isLoaded: true })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of Object.values(api.cloudAgent)) f.mockClear()
  useCloudAgentStore.setState({ agents: [], error: null, selectedAgentId: null })
  useAccountProfilesStore.setState({ profiles: [] } as any)
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true } as any)
  useLaunchAckStore.setState({ queue: [] })
  useConfigStore.setState({ configs: [
    { id: 'cfg-cx', label: 'Codex app', workingDirectory: 'C:/proj', sessionType: 'local', color: '', provider: 'codex', codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high', permissionsPreset: 'auto' } } as any,
    { id: 'cfg-cl', label: 'Claude app', workingDirectory: 'C:/proj2', sessionType: 'local', color: '', provider: 'claude', legacyVersion: { enabled: true, version: '2.0.1' } } as any,
  ] })
  ;(window as any).electronPlatform = 'win32'
  assistants(true, true)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  assistants(undefined, undefined)
})

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const byTest = <T extends Element = HTMLButtonElement>(id: string) => q<T>(`[data-testid="${id}"]`)

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

function openDialog(configId = 'cfg-cx') {
  act(() => { root.render(<NewAgentDialog onClose={() => {}} />) })
  setValue(q<HTMLInputElement>('input')!, 'Tidy')
  setValue(q<HTMLTextAreaElement>('textarea')!, 'Tidy the imports')
  // The project picker is the first select.
  setValue(q<HTMLSelectElement>('select')!, configId)
}
const pick = (provider: 'claude' | 'codex') => act(() => { q<HTMLButtonElement>(`[data-testid="new-agent-provider"] [data-provider="${provider}"]`)!.click() })
const permission = () => q<HTMLInputElement>('[data-testid="new-agent-permissions"] input[type="checkbox"]')!

describe('New agent: the assistant', () => {
  it('both on: a choice, Claude Code first; Codex is offered and dispatches with its own fields only', async () => {
    openDialog()
    const radios = container.querySelectorAll('[data-testid="new-agent-provider"] [role="radio"]')
    expect([...radios].map((r) => r.textContent)).toEqual(['Claude Code', 'Codex'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    pick('codex')
    expect(byTest('new-agent-dispatch')!.disabled).toBe(false)
    await act(async () => { byTest('new-agent-dispatch')!.click() })
    await flush()
    expect(api.cloudAgent.dispatch).toHaveBeenCalledWith({
      name: 'Tidy', description: 'Tidy the imports', projectPath: 'C:/proj', configId: 'cfg-cx', skipPermissions: false,
      provider: 'codex', providerAccountId: 'acc-work', codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high' },
    })
  })

  it("Codex from a Claude config takes only the folder; Claude Code from a Codex config takes no Codex options", async () => {
    openDialog('cfg-cl')
    pick('codex')
    await act(async () => { byTest('new-agent-dispatch')!.click() })
    await flush()
    const sent = (api.cloudAgent.dispatch.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(sent).toMatchObject({ provider: 'codex', projectPath: 'C:/proj2' })
    expect(sent).not.toHaveProperty('codexOptions')
    expect(sent).not.toHaveProperty('legacyVersion')
    expect(sent).not.toHaveProperty('profileId')
    act(() => { root.unmount() })
    root = createRoot(container)
    api.cloudAgent.dispatch.mockClear()
    openDialog('cfg-cx')
    await act(async () => { byTest('new-agent-dispatch')!.click() })
    await flush()
    const claude = (api.cloudAgent.dispatch.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(claude).toMatchObject({ provider: 'claude', projectPath: 'C:/proj' })
    expect(claude).not.toHaveProperty('codexOptions')
    expect(claude).not.toHaveProperty('providerAccountId')
  })

  it('only Codex on: no choice, Codex; Claude Code being off holds nothing back', () => {
    assistants(false, true)
    openDialog()
    expect(byTest('new-agent-provider')).toBeNull()
    expect(byTest('new-agent-dispatch')!.disabled).toBe(false)
    expect(container.textContent).toContain(CODEX_AUTO_LABEL)
    expect(byTest('new-agent-claude-off')).toBeNull()
  })

  it('neither on: Claude Code, which says it is off', () => {
    assistants(false, undefined)
    openDialog()
    expect(byTest('new-agent-provider')).toBeNull()
    expect(byTest('new-agent-dispatch')!.disabled).toBe(true)
    expect(byTest('new-agent-claude-off')!.textContent).toBe(CLAUDE_OFF)
  })
})

describe('New agent: a Codex agent', () => {
  it('the per-run choice is worded as Auto, with the Windows known issue once ticked; it is sent as skipPermissions', async () => {
    openDialog()
    pick('codex')
    expect(container.textContent).toContain(CODEX_AUTO_LABEL)
    expect(container.textContent).not.toContain('--dangerously-skip-permissions')
    expect(byTest('new-agent-codex-windows')).toBeNull()
    act(() => { permission().click() })
    expect(byTest('new-agent-codex-windows')!.textContent).toBe(CODEX_AGENT_WINDOWS_NOTE)
    await act(async () => { byTest('new-agent-dispatch')!.click() })
    await flush()
    expect(api.cloudAgent.dispatch).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', skipPermissions: true }))
  })

  it('switching the assistant clears the per-run choice (it means a different thing for each)', () => {
    openDialog()
    act(() => { permission().click() })
    expect(permission().checked).toBe(true)
    pick('codex')
    expect(permission().checked).toBe(false)
  })

  it('not on Windows: no Windows note', () => {
    ;(window as any).electronPlatform = 'darwin'
    openDialog()
    pick('codex')
    act(() => { permission().click() })
    expect(byTest('new-agent-codex-windows')).toBeNull()
  })

  it("this computer's sign-in: Dispatch waits for the confirmation, which covers exactly that account and is sent with it", async () => {
    openDialog()
    pick('codex')
    setValue(q<HTMLSelectElement>('#new-agent-codex-account-select')!, local.id)
    expect(byTest('new-agent-dispatch')!.disabled).toBe(true)
    expect(byTest('new-agent-codex-blocked')!.textContent).toBe(CONFIRM_SIGN_IN)
    const ack = byTest<HTMLInputElement>('new-agent-codex-ack')!
    expect(ack.closest('label')!.textContent).toBe('Run this agent with the Codex sign-in already on this computer (alex@example.com)')
    act(() => { ack.click() })
    expect(byTest('new-agent-dispatch')!.disabled).toBe(false)
    // The tick belongs to the account it was given for: another account
    // neither needs nor carries it.
    setValue(q<HTMLSelectElement>('#new-agent-codex-account-select')!, 'acc-personal')
    expect(byTest('new-agent-codex-ack')).toBeNull()
    expect(byTest('new-agent-dispatch')!.disabled).toBe(false)
    setValue(q<HTMLSelectElement>('#new-agent-codex-account-select')!, local.id)
    expect(byTest<HTMLInputElement>('new-agent-codex-ack')!.checked).toBe(true)
    await act(async () => { byTest('new-agent-dispatch')!.click() })
    await flush()
    expect(api.cloudAgent.dispatch).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', providerAccountId: local.id, acknowledgeRealmOnly: true }))
  })

  it('no Codex account: Dispatch is held back with the way to Accounts', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [] }), loaded: true } as any)
    openDialog()
    pick('codex')
    expect(byTest('new-agent-dispatch')!.disabled).toBe(true)
    expect(byTest('new-agent-codex-notice')!.textContent).toBe('Sign in to Codex first. Open Accounts.')
  })

  it("Codex off: no choice is offered and the agent is Claude Code's; the Codex sentences are main's own", () => {
    assistants(true, false)
    openDialog()
    expect(byTest('new-agent-provider')).toBeNull()
    expect(byTest('new-agent-dispatch')!.disabled).toBe(false)
    expect(CODEX_AGENT_OFF).toBe('Codex is off. Turn it on in Settings, Accounts.')
    expect(CODEX_AGENT_NOT_SET_UP).toBe('Codex is not set up yet. Set it up in Settings, Accounts.')
  })
})

describe('the store', () => {
  it('a Codex dispatch is refused by Codex being off or not set up, never by Claude Code being off', async () => {
    assistants(true, false)
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p', provider: 'codex' })
    expect(useCloudAgentStore.getState().error).toBe(CODEX_AGENT_OFF)
    assistants(true, undefined)
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p', provider: 'codex' })
    expect(useCloudAgentStore.getState().error).toBe(CODEX_AGENT_NOT_SET_UP)
    expect(api.cloudAgent.dispatch).not.toHaveBeenCalled()
    assistants(false, true)
    useCloudAgentStore.setState({ error: null })
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p', provider: 'codex' })
    expect(api.cloudAgent.dispatch).toHaveBeenCalledTimes(1)
    expect(useCloudAgentStore.getState()).toMatchObject({ error: null, selectedAgentId: 'agent-1' })
  })

  it("main's rejection of a request is shown in the banner", async () => {
    api.cloudAgent.dispatch.mockResolvedValueOnce({ rejected: 'That agent request was not valid.' } as any)
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p', provider: 'codex' })
    expect(useCloudAgentStore.getState()).toMatchObject({ error: 'That agent request was not valid.', selectedAgentId: null })
  })

  const codexAgent = (over: Record<string, unknown> = {}) => ({ id: 'ca-x', name: 'Tidy', description: 'd', status: 'failed', createdAt: 1, updatedAt: 1, projectPath: 'C:/p', output: '', provider: 'codex', providerAccountId: 'acc-work', ...over })

  it('a Codex retry on a managed account goes straight on; Claude Code being off does not stop it', async () => {
    assistants(false, true)
    useCloudAgentStore.setState({ agents: [codexAgent() as any] })
    await useCloudAgentStore.getState().retry('ca-x')
    expect(api.cloudAgent.retry).toHaveBeenCalledWith('ca-x')
    expect(useLaunchAckStore.getState().queue).toHaveLength(0)
  })

  it('a Codex retry while Codex is off is refused; a Claude Code retry is not stopped by Codex', async () => {
    assistants(true, false)
    useCloudAgentStore.setState({ agents: [codexAgent() as any, { ...codexAgent({ id: 'ca-claude', provider: undefined, providerAccountId: undefined }) } as any] })
    await useCloudAgentStore.getState().retry('ca-x')
    expect(useCloudAgentStore.getState().error).toBe(CODEX_AGENT_OFF)
    expect(api.cloudAgent.retry).not.toHaveBeenCalled()
    await useCloudAgentStore.getState().retry('ca-claude')
    expect(api.cloudAgent.retry).toHaveBeenCalledWith('ca-claude')
  })

  it("a retry on this computer's sign-in asks first: a yes sends the acknowledgement, a no sends nothing", async () => {
    useCloudAgentStore.setState({ agents: [codexAgent({ providerAccountId: local.id }) as any] })
    const yes = useCloudAgentStore.getState().retry('ca-x')
    await vi.waitFor(() => expect(useLaunchAckStore.getState().queue).toHaveLength(1))
    const asked = useLaunchAckStore.getState().queue[0]
    expect(asked).toMatchObject({ sessionId: 'cloud-agent:ca-x', sessionLabel: 'Tidy', external: true, email: 'alex@example.com', retryAgent: true })
    expect(api.cloudAgent.retry).not.toHaveBeenCalled()
    act(() => { useLaunchAckStore.getState().answer(asked.requestId, true) })
    await yes
    expect(api.cloudAgent.retry).toHaveBeenCalledWith('ca-x', { acknowledgeRealmOnly: true })
    api.cloudAgent.retry.mockClear()
    const no = useCloudAgentStore.getState().retry('ca-x')
    await vi.waitFor(() => expect(useLaunchAckStore.getState().queue).toHaveLength(1))
    act(() => { useLaunchAckStore.getState().answer(useLaunchAckStore.getState().queue[0].requestId, false) })
    await no
    expect(api.cloudAgent.retry).not.toHaveBeenCalled()
  })
})

describe('the page', () => {
  it('the summary names the assistant and the Codex account as Accounts names it', () => {
    act(() => { root.render(<SummaryTab agent={{ id: 'ca-x', name: 'Tidy', description: 'd', status: 'completed', createdAt: 1, updatedAt: 1, projectPath: 'C:/p', output: '', provider: 'codex', providerAccountId: 'acc-work', accountEmail: 'alex@work.example' } as any} />) })
    expect(byTest('cloud-agent-assistant')!.textContent).toBe('Codex')
    expect(container.textContent).toContain('Work')
    act(() => { root.render(<SummaryTab agent={{ id: 'ca-y', name: 'Old', description: 'd', status: 'completed', createdAt: 1, updatedAt: 1, projectPath: 'C:/p', output: '' } as any} />) })
    expect(byTest('cloud-agent-assistant')!.textContent).toBe('Claude Code')
  })
})
