// @vitest-environment jsdom
/**
 * WP2 commit 6 (canvas F6 / F9): the New session dialog's "Codex account"
 * field, driven through the REAL dialog.
 *
 *  - the list: the default first and preselected "(Default)", this computer's
 *    ~/.codex labelled "confirm at launch", blocked accounts disabled with
 *    "Needs attention", inactive and archived ones absent, and no account at
 *    all -> "Sign in to Codex first" pointing at Accounts;
 *  - choosing the external account shows the per-launch checkbox, which must
 *    be ticked before Create/Save enables, and the tick is handed to the
 *    caller for the one launch -- never written into the config;
 *  - the chosen account is saved as the config's providerAccountId (an edit
 *    the user did not re-point keeps what is stored);
 *  - an edit asks for no tick (nothing launches on an edit), and a tick is
 *    bound to the account it was ticked for;
 *  - F9: no account, a blocked default and a too-old Codex hold a new config
 *    back;
 *  - the per-launch confirm asked before a later launch: one answer per
 *    question, never early, focus on Cancel.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { snapshot, provider, work, old, local } from './accounts-snapshot-harness'
import LaunchAckConfirm, { LAUNCH_ACK_ARM_MS } from '../../../src/renderer/components/LaunchAckConfirm'
import { useLaunchAckStore } from '../../../src/renderer/stores/launchAckStore'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: Record<string, unknown> = {}) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel: vi.fn(), ...props } as any)) })
  return onConfirm
}

function card(group: string, title: string): HTMLInputElement {
  const g = container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!
  const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
  return lab.querySelector('input[type="radio"]') as HTMLInputElement
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) })
}

/** A new Codex config, local, with everything else filled in. */
function newCodexConfig(): ReturnType<typeof vi.fn> {
  const onConfirm = render()
  act(() => { card('Provider', 'Codex').click() })
  act(() => { card('Connection', 'Local').click() })
  const wd = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'C:\\path\\to\\project') as HTMLInputElement
  setInput(wd, 'C:\\proj')
  const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
  setInput(label, 'api-server')
  return onConfirm
}

const select = () => container.querySelector('[data-testid="codex-account-select"]') as HTMLSelectElement | null
const submitBtn = () => container.querySelector('[data-testid="session-dialog-submit"]') as HTMLButtonElement
const ackBox = () => container.querySelector('[data-testid="codex-account-ack-checkbox"]') as HTMLInputElement | null
const submit = () => act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

describe('the Codex account picker', () => {
  it('preselects the default and lists the accounts a new session may use', () => {
    newCodexConfig()
    const sel = select()!
    expect(sel.value).toBe('acc-work')
    const opts = Array.from(sel.options).map((o) => ({ id: o.value, text: o.textContent, disabled: o.disabled }))
    expect(opts).toEqual([
      { id: 'acc-work', text: 'Work (Default)', disabled: false },
      { id: 'acc-personal', text: 'Personal', disabled: false },
      { id: 'acc-local', text: "This computer's Codex (~/.codex) - confirm at launch", disabled: false },
      { id: 'acc-old', text: 'Old (Needs attention)', disabled: true },
    ])
    // Inactive and archived accounts are not offered.
    expect(opts.map((o) => o.id)).not.toContain('acc-parked')
    expect(opts.map((o) => o.id)).not.toContain('acc-gone')
  })

  it('with no Codex account says "Sign in to Codex first", points at Accounts, and holds Create back (F9)', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [] }), loaded: true })
    newCodexConfig()
    expect(select()).toBeNull()
    const warn = container.querySelector('[data-testid="codex-no-account"]')!
    expect(warn.textContent).toBe('Sign in to Codex first. Open Accounts.')
    expect(submitBtn().disabled).toBe(true)
    const opened = vi.fn()
    window.addEventListener('app:openSettings', opened as EventListener)
    act(() => { (warn.querySelector('button') as HTMLButtonElement).click() })
    window.removeEventListener('app:openSettings', opened as EventListener)
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'accounts' })
  })

  it('no Codex account does not hold back saving an edit (an edit launches nothing)', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [] }), loaded: true })
    render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' } } })
    expect(submitBtn().disabled).toBe(false)
  })

  it("saves the chosen account as the config's providerAccountId", () => {
    const onConfirm = newCodexConfig()
    choose(select()!, 'acc-personal')
    expect(submitBtn().disabled).toBe(false)
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-personal')
    expect(launchAck).toBeUndefined()
  })

  it('a new config left on the default saves the default', () => {
    const onConfirm = newCodexConfig()
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBe('acc-work')
  })
})

describe("this computer's own sign-in: the per-launch checkbox", () => {
  it('appears for the external account, names its email, and holds Create back until ticked', () => {
    const onConfirm = newCodexConfig()
    expect(ackBox()).toBeNull()
    choose(select()!, 'acc-local')
    expect(container.querySelector('[data-testid="codex-account-ack"]')!.textContent)
      .toBe('Launch with the Codex sign-in already on this computer (alex@example.com)')
    expect(ackBox()!.checked).toBe(false)
    expect(submitBtn().disabled).toBe(true)
    submit()
    expect(onConfirm).not.toHaveBeenCalled()
    act(() => { ackBox()!.click() })
    expect(submitBtn().disabled).toBe(false)
  })

  it('hands the tick to the caller for the one launch, and never writes it into the config', () => {
    const onConfirm = newCodexConfig()
    choose(select()!, 'acc-local')
    act(() => { ackBox()!.click() })
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-local')
    expect(launchAck).toEqual({ accountId: 'acc-local' })
    expect(JSON.stringify(config)).not.toMatch(/acknowledge/i)
  })

  it('the tick belongs to the account it was ticked for: choosing another account and back does not carry it', () => {
    newCodexConfig()
    choose(select()!, 'acc-local')
    act(() => { ackBox()!.click() })
    choose(select()!, 'acc-work')
    expect(submitBtn().disabled).toBe(false)
    // A different external account would not be covered either; back on the
    // same one, the tick it was given for that account stands.
    choose(select()!, 'acc-local')
    expect(ackBox()!.checked).toBe(true)
  })

  it('a snapshot push that moves the default never carries the tick to the new default', () => {
    // The default is this computer's own sign-in, ticked while untouched.
    const other = { ...local, id: 'acc-local-2', identityId: 'id-ext' }
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...work, isProviderDefault: false }, { ...local, isProviderDefault: true }, other] }), loaded: true })
    const onConfirm = newCodexConfig()
    expect(select()!.value).toBe('acc-local')
    act(() => { ackBox()!.click() })
    expect(submitBtn().disabled).toBe(false)
    // Main publishes a snapshot with another unverified default.
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...work, isProviderDefault: false }, { ...local, isProviderDefault: false }, { ...other, isProviderDefault: true }] }), loaded: true }) })
    expect(select()!.value).toBe('acc-local-2')
    expect(ackBox()!.checked).toBe(false)
    expect(submitBtn().disabled).toBe(true)
    submit()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('an edit asks for no tick and shows no checkbox: nothing launches on an edit', () => {
    const onConfirm = render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' }, providerAccountId: 'acc-local' } })
    expect(select()!.value).toBe('acc-local')
    expect(ackBox()).toBeNull()
    expect(submitBtn().disabled).toBe(false)
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-local')
    expect(launchAck).toBeUndefined()
  })
})

describe('an edit keeps what is stored unless the user re-points it', () => {
  const unbound = { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' } }

  it('an unbound config stays unbound (it follows the provider default)', () => {
    const onConfirm = render({ initial: unbound })
    expect(select()!.value).toBe('acc-work')
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBeUndefined()
  })

  it('re-pointing it binds it', () => {
    const onConfirm = render({ initial: unbound })
    choose(select()!, 'acc-personal')
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBe('acc-personal')
  })
})

describe('F9: what holds a new Codex config back', () => {
  it('a blocked default: the account signed in as someone else, "Open Accounts" read once as the link', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...old, isProviderDefault: true }, { ...work, isProviderDefault: false }, local] }), loaded: true })
    newCodexConfig()
    expect(select()!.value).toBe('acc-old')
    const notice = container.querySelector('[data-testid="codex-account-notice"]')!
    expect(notice.textContent).toBe('This account signed in as someone else. Open Accounts and confirm it is still yours.')
    expect(notice.querySelector('button')!.textContent).toBe('Open Accounts')
    expect(submitBtn().disabled).toBe(true)
    choose(select()!, 'acc-work')
    expect(submitBtn().disabled).toBe(false)
  })

  it('a Codex that is too old, with no update action pointed at Accounts', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', version: '0.150.2', compatibility: 'too-old' })] }), loaded: true })
    newCodexConfig()
    const box = container.querySelector('[data-testid="codex-too-old"]')!
    expect(box.textContent).toBe('Codex 0.150.2 is too old for this app. Update Codex, then restart the app.')
    expect(box.querySelector('button')).toBeNull()
    expect(submitBtn().disabled).toBe(true)
  })

  it("the provider cards carry the app's own provider glyphs", () => {
    render()
    expect(card('Provider', 'Codex').closest('label')!.querySelector('[data-testid="provider-glyph-codex"] svg')).not.toBeNull()
    expect(card('Provider', 'Claude Code').closest('label')!.querySelector('[data-testid="provider-glyph-claude"] svg')).not.toBeNull()
  })

  it('SSH says one thing: Codex runs on this computer only', () => {
    render()
    act(() => { card('Provider', 'Codex').click() })
    expect(card('Connection', 'SSH').disabled).toBe(true)
    expect(container.querySelector('[data-testid="codex-local-note"]')!.textContent).toBe('Codex runs on this computer only in this release.')
    expect(container.textContent!.match(/this computer only/g)).toHaveLength(1)
  })
})

describe('the per-launch confirm asked before a later launch', () => {
  const ask = (sessionId: string, over: Record<string, unknown> = {}) =>
    useLaunchAckStore.getState().request({ sessionId, sessionLabel: sessionId, accountName: "This computer's Codex (~/.codex)", email: 'alex@example.com', external: true, unknown: false, ...over } as never)
  const click = (testId: string) => act(() => { (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click() })
  // Two clocks: the monotonic one the confirm arms on, and the wall clock,
  // which may step (NTP after sleep, a VM resume) and must not matter.
  let mono = 5_000
  let wall = 1_700_000_000_000
  beforeEach(() => {
    useLaunchAckStore.setState({ queue: [] })
    mono = 5_000
    wall = 1_700_000_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    vi.spyOn(Date, 'now').mockImplementation(() => wall)
  })
  afterEach(() => { vi.restoreAllMocks() })
  /** Let the question on screen arm. */
  const wait = () => { mono += LAUNCH_ACK_ARM_MS + 1; wall += LAUNCH_ACK_ARM_MS + 1 }

  it('a wall clock stepped backward never strands the question: it arms 300 ms after it was shown', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => { first = ask('s-1'); second = ask('s-2') })
    // An hour's step backward on the wall clock while the question is up.
    wall -= 3_600_000
    mono += LAUNCH_ACK_ARM_MS + 1
    click('launch-ack-launch')
    await expect(first).resolves.toBe(true)
    // ...and the question queued behind it is not stranded either.
    mono += LAUNCH_ACK_ARM_MS + 1
    click('launch-ack-cancel')
    await expect(second).resolves.toBe(false)
  })

  it('asks about the Codex sign-in on this computer, described by its question, with focus on Cancel', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
    act(() => { void ask('s-1') })
    const panel = document.querySelector('[data-testid="launch-ack-confirm"]')!
    expect(panel.getAttribute('aria-describedby')).toBe('launch-ack-question')
    expect(document.getElementById('launch-ack-question')!.textContent)
      .toBe('Launch with the Codex sign-in already on this computer (alex@example.com)?')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
  })

  it('answers the waiting launch once armed', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let answer!: Promise<boolean>
    act(() => { answer = ask('s-1') })
    wait()
    click('launch-ack-launch')
    await expect(answer).resolves.toBe(true)
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
  })

  it('each new question starts with focus on Cancel, never where the last answer left it', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('s-1'); void ask('s-2') })
    wait()
    const launch = document.querySelector('[data-testid="launch-ack-launch"]') as HTMLButtonElement
    act(() => { launch.focus() })
    act(() => { launch.click() })
    expect(document.getElementById('launch-ack-question')).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
  })

  it('ignores a click that lands before the question has been on screen long enough', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('s-1') })
    click('launch-ack-launch')
    expect(useLaunchAckStore.getState().isPending('s-1')).toBe(true)
  })

  it('two quick activations never approve the next session', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => { first = ask('s-1'); second = ask('s-2') })
    wait()
    click('launch-ack-launch')
    // The second click of a double activation lands on s-2's question.
    click('launch-ack-launch')
    await expect(first).resolves.toBe(true)
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    expect(document.getElementById('launch-ack-question')!.textContent).toContain('?')
    void second
  })

  it('a question withdrawn between render and click never lets the click land on the next one', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let second!: Promise<boolean>
    act(() => { void ask('s-1'); second = ask('s-2') })
    wait()
    const launchForS1 = document.querySelector('[data-testid="launch-ack-launch"]') as HTMLButtonElement
    // s-1's view goes away (a restart) while its question is on screen...
    act(() => { useLaunchAckStore.getState().withdraw('s-1') })
    // ...and a click aimed at s-1's button arrives afterwards.
    act(() => { launchForS1.click() })
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    // Nor does a click on the new question count before it has armed.
    click('launch-ack-launch')
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    wait()
    click('launch-ack-cancel')
    await expect(second).resolves.toBe(false)
  })

  it('stays hidden while a boot gate owns the screen, keeping the question queued', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm, { suppressed: true })) })
    act(() => { void ask('s-2') })
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    useLaunchAckStore.getState().withdraw('s-2')
  })

  it('asks plainly when the account list could not be read', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('api-server', { unknown: true, external: false, email: undefined, accountName: 'this Codex account' }) })
    expect(document.getElementById('launch-ack-question')!.textContent).toBe('Launch api-server on its saved Codex account?')
  })
})
