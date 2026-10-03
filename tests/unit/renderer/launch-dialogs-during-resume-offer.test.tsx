// @vitest-environment jsdom
// P3.5 VM finding V1: while the resume offer is up (the non-modal "restore
// your sessions?" prompt, the 'resume' boot gate), a session the user launches
// that needs a dialog first -- the account choice with two or more accounts,
// or the confirm for a sign-in already on this computer -- showed nothing and
// started nothing until the offer was answered. Those dialogs are held back
// while a boot gate owns the screen so that a restore's own dialogs never
// paint over the page after it (the Multi Spawn startup page, #607). During
// the offer itself no restore has started (it starts once the offer is
// answered), so a dialog then can only be for a launch the user just made: it
// shows, and the launch goes on. Every other gate still holds them back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const gateState: any = { queue: [], restored: [], resolveChoice: vi.fn(), cancelChoice: vi.fn() }
const profilesState: any = { profiles: [] }
const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {}, lastUsedAccountId: undefined } }

vi.mock('../../../src/renderer/stores/accountGateStore', () => ({ useAccountGateStore: (sel: any) => sel(gateState) }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({ useAccountProfilesStore: (sel: any) => sel(profilesState) }))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({ useSettingsStore: (sel: any) => sel(settingsState) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: AccountLaunchGate } = await import('../../../src/renderer/components/AccountLaunchGate')
const { default: LaunchAckConfirm, LAUNCH_ACK_ARM_MS } = await import('../../../src/renderer/components/LaunchAckConfirm')
const { useLaunchAckStore } = await import('../../../src/renderer/stores/launchAckStore')
const { launchDialogsSuppressed } = await import('../../../src/renderer/utils/bootGates')
type Gate = Parameters<typeof launchDialogsSuppressed>[0]

const EVERY_OTHER_GATE: Gate[] = ['logsWipe', 'onboarding', 'training', 'guidedTour', 'guidedConfig', 'githubOnboarding', 'codexReconfirm', 'loggingConsent', 'multiSpawnIntro', 'helloCodex']

let container: HTMLDivElement
let root: Root
let mono = 5_000
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gateState.resolveChoice = vi.fn()
  gateState.queue = []
  gateState.restored = []
  profilesState.profiles = [
    { id: 'primary', name: 'Work', accountEmail: 'work@example.com', isPrimary: true, active: true },
    { id: 'second', name: 'Home', accountEmail: 'home@example.com', isPrimary: false, active: true },
  ]
  useLaunchAckStore.setState({ queue: [] })
  mono = 5_000
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const click = (testId: string) => act(() => { (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click() })

describe('which boot gates hold the launch dialogs back', () => {
  it('none, and the resume offer, show them; every other gate holds them back', () => {
    expect(launchDialogsSuppressed(null)).toBe(false)
    expect(launchDialogsSuppressed('resume')).toBe(false)
    for (const gate of EVERY_OTHER_GATE) expect(launchDialogsSuppressed(gate), String(gate)).toBe(true)
  })
})

describe('a launch made while the resume offer is up shows its dialog and goes on', () => {
  it('the account choice (two or more accounts): shown, and Launch starts the session', () => {
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
    act(() => root.render(<AccountLaunchGate suppressed={launchDialogsSuppressed('resume')} />))
    expect(container.textContent).toContain('Start session')
    click('account-launch-confirm')
    expect(gateState.resolveChoice).toHaveBeenCalledWith('primary')
    // The page after the offer still holds a restore's dialogs back.
    act(() => root.render(<AccountLaunchGate suppressed={launchDialogsSuppressed('multiSpawnIntro')} />))
    expect(container.textContent).toBe('')
  })

  it('the confirm for a sign-in on this computer: shown, and a yes launches', async () => {
    act(() => root.render(<LaunchAckConfirm suppressed={launchDialogsSuppressed('resume')} />))
    let answered!: Promise<boolean>
    act(() => {
      answered = useLaunchAckStore.getState().request({ sessionId: 's2', sessionLabel: 'api', accountName: "This computer's sign-in", email: 'alex@example.com', external: true, unknown: false })
    })
    expect(document.querySelector('[data-testid="launch-ack-question"]')).not.toBeNull()
    mono += LAUNCH_ACK_ARM_MS + 1
    click('launch-ack-launch')
    await expect(answered).resolves.toBe(true)
    // The page after the offer still holds it back.
    act(() => root.render(<LaunchAckConfirm suppressed={launchDialogsSuppressed('multiSpawnIntro')} />))
    act(() => { void useLaunchAckStore.getState().request({ sessionId: 's3', sessionLabel: 'b', accountName: 'x', external: true, unknown: false }) })
    expect(document.querySelector('[data-testid="launch-ack-question"]')).toBeNull()
  })
})
