// @vitest-environment jsdom
/**
 * WP2: where main answers "off" instead of running the Claude CLI, the
 * surface that asked says Claude Code is off -- not an error:
 *
 *  - onboarding's version check (`cli:version` answered with the refusal):
 *    the reason, and no "Couldn't read the version" warning;
 *  - the account panel (`accountWeb:status` with `cli.notChecked`): the Code
 *    session line says it was not checked, and why;
 *  - the SSH flow card: main's refusal of "Launch Claude" is shown, and
 *    cleared once the switch changes (off and back on), so a stale refusal
 *    never outlives it.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), retryFailedConfigSaves: vi.fn() }))

const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'
const refusal = { refused: { code: 'provider-off', providerId: 'claude', message: OFF } }

const cli = { version: vi.fn(async (): Promise<unknown> => refusal) }
const accountWeb = {
  status: vi.fn(async (): Promise<unknown> => ({
    ok: true, web: { status: 'none' }, cli: { authenticated: false, notChecked: OFF },
    authCommand: 'claude auth login', authMethod: 'claudeai', authBrowser: 'edge', webSignInMode: 'auto', detectedBrowsers: ['edge'],
  })),
  webStatus: vi.fn(async () => ({ ok: true, web: { status: 'none' } })),
  signInState: vi.fn(async () => ({ ok: true, state: { phase: 'idle' } })),
  onPaneState: vi.fn(() => () => {}),
}
let flowCb: ((msg: { state: string; info?: string }) => void) | null = null
const ssh = {
  onFlowState: vi.fn((_id: string, cb: (msg: { state: string; info?: string }) => void) => { flowCb = cb; return () => {} }),
  getState: vi.fn(() => new Promise(() => {})),
  runPostCommand: vi.fn(),
  launchClaude: vi.fn(async (): Promise<unknown> => refusal),
  skip: vi.fn(),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, cli, accountWeb, ssh }

const { VersionConsentCard } = await import('../../../src/renderer/onboarding/VersionConsentCard')
const { AccountWebSession } = await import('../../../src/renderer/components/settings/AccountWebSession')
const { default: SshFlowOverlay } = await import('../../../src/renderer/components/SshFlowOverlay')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { SSH_ENTRY } = await import('../../../src/shared/ssh-entry')
const { CLAUDE_OFF } = await import('../../../src/renderer/lib/claudeOff')
const { providerOffMessage } = await import('../../../src/shared/providers')
const { default: CLAUDE_OFF_SOURCE } = await import('../../../src/renderer/lib/claudeOff.ts?raw')

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const claude = (claudeEnabled: boolean | undefined) => act(() => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled } }) })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  cli.version.mockClear()
  accountWeb.status.mockClear()
  ssh.launchClaude.mockClear()
  flowCb = null
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

describe("the renderer's Claude-off sentence is main's", () => {
  it('derived from the shared sentence, not a copy of it', () => {
    expect(CLAUDE_OFF).toBe(providerOffMessage('Claude Code'))
    // Derived, in the source: a pinned copy would read the same until one of
    // the two changed.
    expect(CLAUDE_OFF_SOURCE).toContain("export const CLAUDE_OFF = providerOffMessage('Claude Code')")
    expect(CLAUDE_OFF_SOURCE).not.toContain("'Claude Code is off. Turn it on in Settings, Accounts.'")
  })
})

describe('onboarding version check, answered "off"', () => {
  it('says why; no version, and no "could not read" warning', async () => {
    const onVersion = vi.fn()
    await act(async () => { root.render(<VersionConsentCard desc="d" onVersion={onVersion} />) })
    await act(async () => { (container.querySelector('button.run') as HTMLButtonElement).click() })
    await flush()
    expect(byTest('version-consent-refused')!.textContent).toBe(OFF)
    expect(container.textContent).not.toContain("Couldn't read the version")
    expect(onVersion).not.toHaveBeenCalled()
  })

  it('a version still reads as before (the control)', async () => {
    cli.version.mockResolvedValueOnce('2.1.281')
    const onVersion = vi.fn()
    await act(async () => { root.render(<VersionConsentCard desc="d" onVersion={onVersion} />) })
    await act(async () => { (container.querySelector('button.run') as HTMLButtonElement).click() })
    await flush()
    expect(onVersion).toHaveBeenCalledWith('2.1.281')
    expect(byTest('version-consent-refused')).toBeNull()
  })
})

describe('the account panel, answered "not checked"', () => {
  it('the Code session line says it was not checked, and why', async () => {
    await act(async () => { root.render(<AccountWebSession profileId="profile-aaa111" accountName="Work" />) })
    await flush()
    expect(byTest('account-cli-not-checked')!.textContent).toBe(OFF)
    expect(container.textContent).toContain('Code session (not checked)')
    expect(container.textContent).not.toContain('Sign in from a running session')
  })
})

describe("the SSH flow card and main's refusal", () => {
  it('shown after a refused Launch Claude; cleared once the switch goes off and back on', async () => {
    useSessionStore.setState({ sessions: [{ id: 's1', label: 'r', workingDirectory: '~', model: '', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~' } } as any] })
    await act(async () => { root.render(<SshFlowOverlay sessionId="s1" hasPostCommand shellOnly enabled />) })
    await act(async () => { flowCb?.({ state: 'awaiting-claude', info: SSH_ENTRY.INNER }) })
    await act(async () => { (byTest('ssh-launch-claude') as HTMLButtonElement).click() })
    await flush()
    expect(byTest('ssh-claude-off')!.textContent).toBe(OFF)
    claude(false)
    expect(byTest('ssh-claude-off')!.textContent).toBe(CLAUDE_OFF)
    claude(true)
    expect(byTest('ssh-claude-off')).toBeNull()
  })
})
