// @vitest-environment jsdom
/**
 * The command dialog KNOWS THE SESSION (ADR-018 D12) and carries the upgrade
 * review (D13).
 *
 * Why these tests exist: until 2.1.0-beta.16 the dialog's only fact about the
 * session was one boolean, so a Codex session was told "Claude", an SSH
 * session was never told that its partner shell is on THIS PC, and a secret
 * argument could be offered for a destination that can never receive it. The
 * dialog now reads `SessionCapabilities` and nothing else; every string below
 * is derived from it, and every "where" is machine-explicit. The review banner
 * is the other half: on upgrade nothing is changed silently -- the banner lists
 * what clashed and each fix is one click the user makes.
 *
 * Same mock pattern as command-dialog-type-first: the store is replaced by a
 * hand-rolled object whose functions can be asserted; ids are fixed; the Ask
 * Conductor launcher (loaded by dynamic import) is a spy.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Section = { id: string; name: string; scope: 'global' | 'config'; configId?: string }

// Hoisted so the vi.mock factories (which vitest lifts above the imports) can
// reach them, and so each test can set the sections / read the spies.
const store = vi.hoisted(() => ({
  sections: [] as Array<{ id: string; name: string; scope: 'global' | 'config'; configId?: string }>,
  addSection: vi.fn(),
  clearReview: vi.fn(),
}))
const ask = vi.hoisted(() => ({ launchAskConductor: vi.fn(() => Promise.resolve('ask-1')) }))

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: store.sections, addSection: store.addSection, clearReview: store.clearReview }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/lib/askConductor', () => ({ launchAskConductor: ask.launchAskConductor }))

const { default: CommandDialog } = await import('../../../src/renderer/components/CommandDialog')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const { describeReviewReason } = await import('../../../src/renderer/lib/command-upgrade')

// The sessions these tests speak of. Every one is built by the real
// `sessionCapabilities`, so a test here also pins what THAT derives.
const local = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
const localNoConfig = sessionCapabilities({ provider: 'claude', sessionType: 'local' } as never)
const localShell = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg', shellOnly: true } as never)
const codex = sessionCapabilities({ provider: 'codex', sessionType: 'local', configId: 'cfg' } as never)
const sshClaude = sessionCapabilities({ provider: 'claude', sessionType: 'ssh', configId: 'cfg', sshConfig: { host: 'build-box' } } as never)
const sshShell = sessionCapabilities({ provider: 'claude', sessionType: 'ssh', configId: 'cfg', shellOnly: true, sshConfig: { host: 'build-box' } } as never)
const askSession = sessionCapabilities({ provider: 'claude', sessionType: 'local', kind: 'ask' } as never)

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  store.sections = []
  store.addSection.mockReset()
  // The real store appends; mirroring that here is what lets the select show
  // the section the dialog just created (it re-reads the store on render).
  store.addSection.mockImplementation((s: Section) => { store.sections = [...store.sections, s] })
  store.clearReview.mockReset()
  ask.launchAskConductor.mockClear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const byTest = <T extends Element = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`)
const within = <T extends Element = HTMLElement>(scopeId: string, sel: string) => q<T>(`[data-testid="${scopeId}"] ${sel}`)

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function choose(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
function render(props: Record<string, unknown>) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  act(() => {
    root.render(React.createElement(CommandDialog, { onConfirm, onCancel, ...props } as never))
  })
  return { onConfirm, onCancel }
}
const pick = (kind: 'prompt' | 'shell' | 'page') => act(() => { byTest(`command-kind-${kind}`)!.click() })
const click = (id: string) => act(() => { byTest(id)!.click() })
const fill = (label: string, text: string) => act(() => {
  type(byTest<HTMLInputElement>('command-label')!, label)
  type(byTest<HTMLTextAreaElement>('command-text')!, text)
})
const submit = () => act(() => { byTest<HTMLButtonElement>('command-submit')!.click() })
const optionValues = () => Array.from(byTest<HTMLSelectElement>('command-section')!.options).map((o) => o.value)
const optionTexts = () => Array.from(byTest<HTMLSelectElement>('command-section')!.options).map((o) => o.textContent)
const argChip = (arg: string) => q(`button[aria-label="Remove argument ${arg}"]`)

describe('a. the agent is named, never assumed (Codex)', () => {
  it('says Codex on the tile, the helper and the preview, and "Claude" appears nowhere', () => {
    render({ capabilities: codex, configId: 'cfg' })
    const tile = byTest('command-kind-prompt')!
    expect(tile.textContent).toContain('Send a prompt')
    expect(tile.textContent).toContain('to Codex')
    expect(container.textContent).not.toContain('Claude')
    pick('prompt')
    expect(container.textContent).toContain('Submitted to Codex')
    expect(byTest('command-preview')!.textContent).toContain('sends to the Codex terminal')
    expect(container.textContent).not.toContain('Claude')
  })
})

describe('b. an SSH Claude session says which machine', () => {
  it('the prompt tile names the host', () => {
    render({ capabilities: sshClaude, configId: 'cfg' })
    expect(byTest('command-kind-prompt')!.textContent).toContain('to Claude on build-box')
  })

  it('for a shell line the host chip is drawn, disabled, with the reason; the partner chip is this PC and chosen', () => {
    const { onConfirm } = render({ capabilities: sshClaude, configId: 'cfg' })
    pick('shell')
    expect(q('[role="radiogroup"][data-testid="command-runs-in"]')).not.toBeNull()
    const main = byTest<HTMLButtonElement>('command-where-main')!
    const partner = byTest<HTMLButtonElement>('command-where-partner')!
    expect(main.disabled).toBe(true)
    expect(main.textContent).toContain('On build-box')
    expect(main.textContent).toContain('no remote shell in this session')
    expect(main.getAttribute('title')).toContain('no remote shell pane')
    expect(partner.disabled).toBe(false)
    expect(partner.getAttribute('aria-checked')).toBe('true')
    expect(partner.textContent).toContain('On this PC')
    expect(partner.textContent).toContain('partner shell')
    expect(byTest('command-field-runs')!.textContent).toContain('After connecting, run')
    fill('Deploy', './deploy.ps1')
    submit()
    expect(onConfirm.mock.calls[0][0].target).toBe('partner')
    expect(onConfirm.mock.calls[0][0].kind).toBe('shell')
  })
})

describe('c. the secret toggle is offered only where the value can arrive', () => {
  it('SSH terminal-only, main shell selected: no toggle, the one-line reason instead; pick the partner and it appears', () => {
    render({ capabilities: sshShell, configId: 'cfg' })
    pick('shell')
    expect(byTest('command-where-main')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-secret-toggle')).toBeNull()
    expect(byTest('command-secret-unavailable')!.textContent).toContain('Secret values reach shells on this PC only')
    click('command-where-partner')
    expect(byTest('command-secret-toggle')).not.toBeNull()
    expect(byTest('command-secret-unavailable')).toBeNull()
  })

  it('a local Claude session offers it for a shell line (partner shell, this PC)', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    expect(byTest('command-secret-toggle')).not.toBeNull()
  })

  it('never for a prompt -- a reference typed into an agent is just text', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(byTest('command-secret-toggle')).toBeNull()
    expect(byTest('command-secret-unavailable')).toBeNull()
  })
})

describe('d. a legacy SSH main-shell button that already carries a secret', () => {
  it('says the secret will not arrive, and saving untouched keeps it -- nothing is deleted silently', () => {
    const { onConfirm } = render({
      capabilities: sshShell, configId: 'cfg',
      initial: { id: 'legacy1', label: 'Deploy', prompt: './deploy.ps1', scope: 'config', configId: 'cfg', target: 'claude', hasSecretArg: true, defaultArgs: ['-T {secret}'] },
    })
    expect(byTest('command-kind-shell')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-secret-toggle')).toBeNull()
    expect(byTest('command-secret-unavailable')!.textContent).toContain('will not arrive')
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(false)
    submit()
    const [record, secret] = onConfirm.mock.calls[0]
    expect(record.hasSecretArg).toBe(true)
    expect(secret).toBeUndefined()
  })
})

describe('e. a page button is fetched from this PC', () => {
  it('"Where it runs" says so, the hint says so, and the preview types nothing', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('page')
    expect(byTest('command-runs-in')!.textContent).toContain('From this PC')
    expect(byTest('command-runs-in')!.textContent).toContain('the browser pane')
    expect(byTest('command-field-runs')!.textContent).toContain('fetched from this computer')
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'https://docs.example.com') })
    expect(byTest('command-preview-line')!.textContent).toContain('docs.example.com')
    expect(byTest('command-preview-line')!.textContent).toContain('(types nothing)')
    expect(byTest('command-preview')!.textContent).toContain('opens in the browser pane (from this PC)')
  })
})

describe('f. "Where it shows" -- the band, in the bar\'s own words', () => {
  it('with a config both chips are enabled', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(byTest<HTMLButtonElement>('command-scope-global')!.disabled).toBe(false)
    expect(byTest<HTMLButtonElement>('command-scope-config')!.disabled).toBe(false)
  })

  it('without a config the Session chip is disabled with the reason, and the button saves as Global', () => {
    const { onConfirm } = render({ capabilities: localNoConfig })
    pick('prompt')
    expect(byTest<HTMLButtonElement>('command-scope-config')!.disabled).toBe(true)
    expect(byTest('command-scope-global')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-field-scope')!.textContent).toContain('no saved config')
    fill('Fix', 'fix lint')
    submit()
    expect(onConfirm.mock.calls[0][0].scope).toBe('global')
    expect(onConfirm.mock.calls[0][0].configId).toBeUndefined()
  })

  it('presetScope global starts on Global even with a config; presetScope config starts on Session', () => {
    render({ capabilities: local, configId: 'cfg', presetScope: 'global' })
    pick('prompt')
    expect(byTest('command-scope-global')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-scope-config')!.getAttribute('aria-checked')).toBe('false')
    act(() => { root.unmount() })
    root = createRoot(container)
    render({ capabilities: local, configId: 'cfg', presetScope: 'config' })
    pick('prompt')
    expect(byTest('command-scope-config')!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('g. the Section field follows the band and is re-validated on a scope flip', () => {
  const seed = () => { store.sections = [{ id: 'g1', name: 'Ops', scope: 'global' }, { id: 'c1', name: 'Mine', scope: 'config', configId: 'cfg' }] }

  it('lists only this band\'s sections; a chosen section that is not in the new band is cleared', () => {
    seed()
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(byTest('command-scope-config')!.getAttribute('aria-checked')).toBe('true')
    expect(optionTexts()).toContain('Mine')
    expect(optionTexts()).not.toContain('Ops')
    act(() => { choose(byTest<HTMLSelectElement>('command-section')!, 'c1') })
    expect(byTest<HTMLSelectElement>('command-section')!.value).toBe('c1')
    click('command-scope-global')
    expect(optionTexts()).toContain('Ops')
    expect(optionTexts()).not.toContain('Mine')
    expect(byTest<HTMLSelectElement>('command-section')!.value).toBe('')
    click('command-scope-config')
    expect(byTest<HTMLSelectElement>('command-section')!.value).toBe('')
  })

  it('"New section…" creates in the Global band when Global is chosen, and selects it', () => {
    seed()
    const { onConfirm } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    click('command-scope-global')
    expect(optionValues()).toContain('__new__')
    act(() => { choose(byTest<HTMLSelectElement>('command-section')!, '__new__') })
    expect(byTest('command-new-section-name')).not.toBeNull()
    act(() => { type(byTest<HTMLInputElement>('command-new-section-name')!, 'Fresh') })
    click('command-new-section-create')
    expect(store.addSection).toHaveBeenCalledTimes(1)
    expect(store.addSection.mock.calls[0][0]).toEqual({ id: 'test-id', name: 'Fresh', scope: 'global', configId: undefined })
    expect(byTest<HTMLSelectElement>('command-section')!.value).toBe('test-id')
    fill('Fix', 'fix lint')
    submit()
    expect(onConfirm.mock.calls[0][0].sectionId).toBe('test-id')
    expect(onConfirm.mock.calls[0][0].scope).toBe('global')
  })

  it('"New section…" creates in the Session band, bound to this config, when Session is chosen', () => {
    seed()
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(byTest('command-scope-config')!.getAttribute('aria-checked')).toBe('true')
    act(() => { choose(byTest<HTMLSelectElement>('command-section')!, '__new__') })
    act(() => { type(byTest<HTMLInputElement>('command-new-section-name')!, 'Deploys') })
    click('command-new-section-create')
    expect(store.addSection.mock.calls[0][0]).toEqual({ id: 'test-id', name: 'Deploys', scope: 'config', configId: 'cfg' })
    expect(byTest<HTMLSelectElement>('command-section')!.value).toBe('test-id')
  })
})

describe('h. the record carries kind, icon and colour', () => {
  it('prompt -> kind prompt / target claude; shell -> kind shell; page -> kind page', () => {
    const { onConfirm } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt'); fill('Fix', 'fix lint'); submit()
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ kind: 'prompt', target: 'claude' })
    pick('shell'); submit()
    expect(onConfirm.mock.calls[1][0]).toMatchObject({ kind: 'shell', target: 'partner' })
    pick('page')
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'https://docs.example.com') })
    submit()
    expect(onConfirm.mock.calls[2][0]).toMatchObject({ kind: 'page', target: 'claude' })
  })

  it('a picked glyph is saved by key; the monogram saves no icon', () => {
    const { onConfirm } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt'); fill('Ship', 'ship it')
    act(() => { within('command-field-icon', '[data-testid="icon-pick-rocket"]')!.click() })
    submit()
    expect(onConfirm.mock.calls[0][0].icon).toBe('rocket')
    act(() => { within('command-field-icon', '[data-testid="icon-pick-monogram"]')!.click() })
    submit()
    expect(onConfirm.mock.calls[1][0].icon).toBeUndefined()
  })

  it('the colour defaults to the first pastel and follows the swatch clicked in the Colour field', () => {
    const { onConfirm } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt'); fill('Ship', 'ship it'); submit()
    expect(onConfirm.mock.calls[0][0].color).toBe('#89B4FA')
    act(() => { within('command-colours', '[aria-label="Colour #A6E3A1"]')!.click() })
    submit()
    expect(onConfirm.mock.calls[1][0].color).toBe('#A6E3A1')
  })
})

describe('i. an existing colour outside the pastels is kept', () => {
  it('shows as a twelfth swatch, selected, and says so', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'old1', label: 'Old', prompt: 'fix', scope: 'global', target: 'claude', kind: 'prompt', color: '#FF5C8A' },
    })
    const swatches = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-colours"] button'))
    expect(swatches).toHaveLength(12)
    const kept = swatches[11]
    expect(kept.getAttribute('aria-label')).toBe('Colour #FF5C8A')
    expect(kept.getAttribute('aria-pressed')).toBe('true')
    expect(kept.getAttribute('title')).toContain('kept')
  })
})

describe('j. the preview draws the REAL chip, with its mark and band', () => {
  const chip = () => within('command-preview', '[data-testid="command-chip"]')!
  const PIN_PATH = 'M12 17v5M5 8l7-5 7 5v9H5z'

  it('monogram first, then the glyph once one is picked', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    expect(chip()).not.toBeNull()
    expect(chip().querySelector('[data-testid="command-icon-monogram"]')!.textContent).toBe('B')
    act(() => { type(byTest<HTMLInputElement>('command-label')!, 'Deploy') })
    expect(chip().querySelector('[data-testid="command-icon-monogram"]')!.textContent).toBe('D')
    act(() => { within('command-field-icon', '[data-testid="icon-pick-rocket"]')!.click() })
    expect(chip().querySelector('[data-testid="command-icon-monogram"]')).toBeNull()
    expect(chip().querySelector('[data-testid="command-icon-glyph"]')!.getAttribute('data-icon')).toBe('rocket')
  })

  it('a pinned button shows its pin in the preview', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'p1', label: 'Pinned', prompt: 'dir', scope: 'global', target: 'partner', kind: 'shell', pinned: true },
    })
    expect(chip().querySelector(`path[d="${PIN_PATH}"]`)).not.toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'p2', label: 'Loose', prompt: 'dir', scope: 'global', target: 'partner', kind: 'shell' },
    })
    expect(chip().querySelector(`path[d="${PIN_PATH}"]`)).toBeNull()
  })

  it('the band label follows the scope', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(byTest('command-preview-band')!.textContent).toBe('Session')
    click('command-scope-global')
    expect(byTest('command-preview-band')!.textContent).toBe('Global')
  })

  it('the target mark sits before the chip: partner for a shell line, agent for a prompt, page for a page', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    const partner = within('command-preview', '[data-testid="command-cluster-partner"]')!
    expect(partner).not.toBeNull()
    expect(partner.compareDocumentPosition(chip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    pick('prompt')
    expect(within('command-preview', '[data-testid="command-cluster-partner"]')).toBeNull()
    expect(within('command-preview', '[data-testid="command-cluster-agent"]')).not.toBeNull()
    pick('page')
    expect(within('command-preview', '[data-testid="command-cluster-page"]')).not.toBeNull()
  })

  it('on SSH the partner mark wears the "this PC" badge', () => {
    render({ capabilities: sshClaude, configId: 'cfg' })
    pick('shell')
    const badge = within('command-preview', '[data-testid="command-cluster-partner"] [data-testid="command-machine-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('this PC')
  })
})

describe('k. the Ask Conductor chip', () => {
  it('is present on a normal session and launches the help session with a question', async () => {
    render({ capabilities: local, configId: 'cfg' })
    const chip = byTest('command-ask-conductor')!
    expect(chip).not.toBeNull()
    await act(async () => { chip.click() })
    // The launcher is loaded by dynamic import on click; give it its ticks.
    await vi.waitFor(() => expect(ask.launchAskConductor).toHaveBeenCalledTimes(1))
    expect(ask.launchAskConductor).toHaveBeenCalledWith(expect.stringContaining('command-bar button'))
  })

  it('is absent inside Ask Conductor itself', () => {
    render({ capabilities: askSession })
    expect(byTest('command-ask-conductor')).toBeNull()
  })
})

describe('l. the upgrade review banner (D13)', () => {
  const secretInitial = (over: Record<string, unknown> = {}) => ({
    id: 'r1', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', kind: 'shell',
    needsReview: ['secret-like-arg'], defaultArgs: ['-Token', TOKEN], ...over,
  })

  it('lists the reason in plain words with a one-click fix; the fix moves the value to the secret and {secret} into the line', () => {
    const { onConfirm } = render({ capabilities: local, configId: 'cfg', initial: secretInitial() })
    expect(byTest('command-review-banner')).not.toBeNull()
    expect(byTest('command-review-reason-secret-like-arg')!.textContent).toContain(describeReviewReason('secret-like-arg'))
    expect(argChip(TOKEN)).not.toBeNull()
    click('command-review-fix-secret')
    expect(byTest<HTMLInputElement>('command-secret-toggle')!.checked).toBe(true)
    expect(byTest<HTMLInputElement>('command-secret-value')!.value).toBe(TOKEN)
    expect(argChip('-Token')).not.toBeNull()
    expect(argChip('{secret}')).not.toBeNull()
    expect(argChip(TOKEN)).toBeNull()
    expect(container.textContent).not.toContain(TOKEN)
    expect(byTest('command-review-reason-secret-like-arg')).toBeNull()
    submit()
    const [record, secret] = onConfirm.mock.calls[0]
    expect(record.hasSecretArg).toBe(true)
    expect(record.defaultArgs).toEqual(['-Token', '{secret}'])
    expect(secret).toBe(TOKEN)
    expect(JSON.stringify(record)).not.toContain(TOKEN)
  })

  it('a flag and value in ONE chip becomes "-Token {secret}"', () => {
    const { onConfirm } = render({ capabilities: local, configId: 'cfg', initial: secretInitial({ defaultArgs: [`-Token ${TOKEN}`] }) })
    click('command-review-fix-secret')
    expect(argChip('-Token {secret}')).not.toBeNull()
    expect(byTest<HTMLInputElement>('command-secret-value')!.value).toBe(TOKEN)
    submit()
    const [record, secret] = onConfirm.mock.calls[0]
    expect(record.defaultArgs).toEqual(['-Token {secret}'])
    expect(secret).toBe(TOKEN)
    expect(JSON.stringify(record)).not.toContain(TOKEN)
  })

  it('a Global prompt inert on shell configs offers "Make it Session-only", which flips the scope', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'p1', label: 'Fix', prompt: 'fix lint', scope: 'global', target: 'claude', kind: 'prompt', needsReview: ['prompt-inert-on-shell-configs'] },
    })
    expect(byTest('command-review-reason-prompt-inert-on-shell-configs')!.textContent).toContain(describeReviewReason('prompt-inert-on-shell-configs'))
    expect(byTest('command-scope-global')!.getAttribute('aria-checked')).toBe('true')
    click('command-review-fix-session')
    expect(byTest('command-scope-config')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-review-reason-prompt-inert-on-shell-configs')).toBeNull()
    expect(byTest('command-review-banner')).toBeNull()
  })

  it('"section dissolved" and "SSH partner is local" are text only -- nothing to fix, just to know', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 's1', label: 'X', prompt: 'dir', scope: 'config', configId: 'cfg', target: 'partner', kind: 'shell', needsReview: ['section-dissolved', 'ssh-partner-is-local'] },
    })
    expect(byTest('command-review-reason-section-dissolved')!.textContent).toContain(describeReviewReason('section-dissolved'))
    expect(byTest('command-review-reason-ssh-partner-is-local')!.textContent).toContain(describeReviewReason('ssh-partner-is-local'))
    expect(byTest('command-review-fix-secret')).toBeNull()
    expect(byTest('command-review-fix-session')).toBeNull()
  })

  it('"Keep as is" clears the tag in the store and hides the banner', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 's1', label: 'X', prompt: 'dir', scope: 'config', configId: 'cfg', target: 'partner', kind: 'shell', needsReview: ['section-dissolved'] },
    })
    click('command-review-dismiss')
    expect(store.clearReview).toHaveBeenCalledWith('s1')
    expect(byTest('command-review-banner')).toBeNull()
  })

  it('no banner on a new command, nor on an edit with nothing to review', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    expect(byTest('command-review-banner')).toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'ok1', label: 'Fine', prompt: 'dir', scope: 'global', target: 'partner', kind: 'shell', needsReview: [] },
    })
    expect(byTest('command-review-banner')).toBeNull()
  })

  it('the secret fix is withheld where a secret cannot be delivered (SSH main shell) -- the reason still shows', () => {
    render({
      capabilities: sshShell, configId: 'cfg',
      initial: secretInitial({ id: 'm1', scope: 'config', configId: 'cfg', target: 'claude' }),
    })
    expect(byTest('command-review-reason-secret-like-arg')).not.toBeNull()
    expect(byTest('command-review-fix-secret')).toBeNull()
    expect(byTest('command-secret-unavailable')).not.toBeNull()
  })
})

describe('m. Escape', () => {
  it('cancels the dialog', () => {
    const { onCancel } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    act(() => { byTest('command-label')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('closes only the "New section…" input while that is open', () => {
    const { onCancel } = render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    act(() => { choose(byTest<HTMLSelectElement>('command-section')!, '__new__') })
    expect(byTest('command-new-section-name')).not.toBeNull()
    act(() => { byTest('command-new-section-name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(byTest('command-new-section-name')).toBeNull()
    expect(byTest('command-section')).not.toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
