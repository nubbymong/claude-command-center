// @vitest-environment jsdom
/**
 * Settings → Custom Commands (ADR-018 D11, M4) -- kept deliberately SMALL.
 *
 * WHY these tests exist: the owner cut this page down to four cards -- Command
 * bar, Core tools, Snap, Commands -- and explicitly fenced out Density, Default
 * icon, a Sections panel, Command secrets and Export/Import (the canvas design
 * still shows them; the built page must not). A later "helpful" addition is the
 * regression this file guards against, alongside the behaviour the four cards
 * DO have:
 *   - Command bar: the overflow radio and "Show the command bar" really write
 *     the shared commandBarStore (the bar's own menu reads the same state);
 *   - Core tools: every hidden tool comes back from here -- per-session hides
 *     name the live session, a dead session is "a closed session", and the
 *     Logs row points at the General privacy toggle;
 *   - Snap: colour + auto-delete moved here from Snap's right-click (M4) and
 *     still write the magicButton store; the days field is clamped 1..365;
 *   - Commands: a plain searchable list -- what kind, where it runs, where it
 *     shows -- with Edit (re-uses CommandDialog, the secret goes to the
 *     keychain) and Delete (a ConfirmCard that says what Global costs).
 * Stores the page mutates (commandBarStore, magicButtonStore) are REAL; the
 * rest are mocked so the tab renders on its own without the whole app.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// --- commands: mutable so a test can change what exists BEFORE rendering; the
// store mock reads them at call time rather than closing over a snapshot.
const G1 = { id: 'g1', label: 'Fix lint', prompt: 'fix the lint errors', scope: 'global' as const, target: 'claude' as const }
const C1 = { id: 'c1', label: 'Deploy', prompt: 'npm run deploy', scope: 'config' as const, configId: 'cfg', target: 'partner' as const, defaultArgs: ['--token', 'abc123'], needsReview: ['secret-like-arg'], sectionId: 'sec-1' }
const P1 = { id: 'p1', label: 'Docs', prompt: '', scope: 'global' as const, kind: 'page' as const, pageUrl: 'https://x' }
const S1 = { id: 's1', label: 'Remote build', prompt: 'make', scope: 'config' as const, configId: 'ssh1', target: 'partner' as const }
const ORPHAN = { id: 'd1', label: 'Orphan', prompt: 'echo', scope: 'config' as const, configId: 'gone', target: 'claude' as const }
const ALL = [G1, C1, P1, S1]
let COMMANDS: Array<Record<string, unknown>> = ALL
let SECTIONS: Array<Record<string, unknown>> = [{ id: 'sec-1', name: 'Release', scope: 'config', configId: 'cfg' }]
const removeCommand = vi.fn()
const updateCommand = vi.fn()
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    get commands() { return COMMANDS },
    get sections() { return SECTIONS },
    removeCommand,
    updateCommand,
  }),
}))

// --- two live sessions; 's-9' in a hide entry is a session that no longer exists.
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [{ id: 's-1', label: 'Alpha' }, { id: 's-2', label: 'Beta' }] }),
}))

// --- a local Claude config and an SSH config (its partner shell is on THIS PC).
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    configs: [
      { id: 'cfg', label: 'My project', sessionType: 'local', provider: 'claude' },
      { id: 'ssh1', label: 'Box', sessionType: 'ssh', provider: 'claude', sshConfig: { host: 'box' } },
    ],
  }),
}))

// --- the General → "Index conversation logs" privacy toggle the Logs row points at.
let SETTINGS: Record<string, unknown> = { loggingEnabled: true }
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (sel: any) => sel({ settings: SETTINGS }),
}))

// --- the Snap card draws the SAME swatches the session dialog does; three is enough here.
vi.mock('../../../src/renderer/components/SessionDialog', () => ({
  COLOR_SWATCHES: ['#00FFFF', '#FF00FF', '#00FF7F'],
  default: () => null,
}))

// --- Toggle from SettingsPage, as a real button so aria-pressed and the click are observable.
vi.mock('../../../src/renderer/components/SettingsPage', () => ({
  Toggle: ({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) =>
    React.createElement('button', { type: 'button', 'aria-pressed': on, 'aria-label': label, onClick }),
}))

// --- CommandDialog as a marker: the props it was opened with are visible on the
// marker, and the onConfirm it was given is parked on a global for a test to call.
vi.mock('../../../src/renderer/components/CommandDialog', () => ({
  default: (p: any) => {
    ;(globalThis as any).__cccDialogProps = p
    return React.createElement('div', {
      'data-testid': 'dialog-mock',
      'data-initial': p.initial?.id,
      'data-config': p.configId ?? '',
      'data-agent': p.capabilities?.agentName,
      'data-remote': p.capabilities?.remoteHost ?? '',
    })
  },
}))

// The REAL commandBarStore and magicButtonStore; their persistence goes through this mock.
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), saveConfigDebounced: vi.fn() }))

;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window?.electronAPI,
  credentials: { save: vi.fn(), delete: vi.fn() },
}

const { CustomCommandsTab } = await import('../../../src/renderer/components/settings/CustomCommandsTab')
const { useCommandBarStore, coerceCommandBarUi, CORE_TOOL_IDS } = await import('../../../src/renderer/stores/commandBarStore')
const { useMagicButtonStore } = await import('../../../src/renderer/stores/magicButtonStore')

let container: HTMLDivElement
let root: Root

const render = () => { act(() => { root.render(React.createElement(CustomCommandsTab)) }) }
const byTestId = (id: string, within: ParentNode = container) => within.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const allByTestId = (id: string, within: ParentNode = container) => Array.from(within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const must = (id: string, within: ParentNode = container): HTMLElement => {
  const el = byTestId(id, within)
  if (!el) throw new Error(`expected [data-testid="${id}"] on screen`)
  return el
}
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('expected an element to click')
  act(() => { (el as HTMLElement).click() })
}
/** Type into a controlled input the way a user would: the native setter (so
 *  React's value tracker sees a change) then an `input` event. */
const typeInto = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const toggleLabelled = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const rowFor = (id: string) => allByTestId('settings-command-row').find((r) => r.getAttribute('data-command-id') === id)
const rowIds = () => allByTestId('settings-command-row').map((r) => r.getAttribute('data-command-id'))
const credentials = () => (globalThis as any).window.electronAPI.credentials as { save: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
const dialogProps = () => (globalThis as any).__cccDialogProps
const cancelButton = (card: Element) => Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')

beforeEach(() => {
  COMMANDS = ALL
  SECTIONS = [{ id: 'sec-1', name: 'Release', scope: 'config', configId: 'cfg' }]
  SETTINGS = { loggingEnabled: true }
  removeCommand.mockClear()
  updateCommand.mockClear()
  credentials().save.mockClear()
  credentials().delete.mockClear()
  delete (globalThis as any).__cccDialogProps
  useCommandBarStore.setState({ state: coerceCommandBarUi({}), isLoaded: true })
  useMagicButtonStore.setState({ settings: { screenshotColor: '#00FFFF', autoDeleteDays: null }, isLoaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the page is the four cards the owner kept, and nothing the owner cut', () => {
  it('renders exactly Command bar, Core tools, Snap and Commands -- no Density, Default icon, Sections, Command secrets, Export or Import', () => {
    render()
    // Exactly four cards, by identity and by count.
    expect(byTestId('settings-command-bar')).not.toBeNull()
    expect(byTestId('settings-core-tools')).not.toBeNull()
    expect(byTestId('settings-snap')).not.toBeNull()
    expect(byTestId('settings-commands')).not.toBeNull()
    expect(container.querySelectorAll('.settings-card')).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('h3')).map((h) => h.textContent)).toEqual(['Command bar', 'Core tools', 'Snap', 'Commands'])
    // The "keep it small" fence: the canvas design still draws these; the page must not.
    const text = container.textContent ?? ''
    expect(text).not.toContain('Density')
    expect(text).not.toContain('Default icon')
    expect(text).not.toContain('Command secrets')
    expect(text).not.toContain('Export')
    expect(text).not.toContain('Import')
    expect(Array.from(container.querySelectorAll('h3')).map((h) => h.textContent)).not.toContain('Sections')
  })
})

describe('Command bar card -- writes the shared commandBarStore', () => {
  it('"One row" is the default; "Two rows, then fold" sets overflow wrap2 in the store and the radio follows it', () => {
    render()
    const fold = must('settings-overflow-fold') as HTMLInputElement
    const wrap2 = must('settings-overflow-wrap2') as HTMLInputElement
    expect(fold.checked).toBe(true)
    expect(wrap2.checked).toBe(false)
    expect(useCommandBarStore.getState().state.overflow).toBe('fold')
    click(wrap2)
    expect(useCommandBarStore.getState().state.overflow).toBe('wrap2')
    expect((byTestId('settings-overflow-wrap2') as HTMLInputElement).checked).toBe(true)
    expect((byTestId('settings-overflow-fold') as HTMLInputElement).checked).toBe(false)
    // And back, so the radio is not a one-way switch.
    click(byTestId('settings-overflow-fold'))
    expect(useCommandBarStore.getState().state.overflow).toBe('fold')
    expect((byTestId('settings-overflow-fold') as HTMLInputElement).checked).toBe(true)
  })

  it('"Show the command bar" is on while barCollapsed is false; clicking it collapses the bar, and again restores it', () => {
    render()
    const toggle = toggleLabelled('Show the command bar')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-pressed')).toBe('true')
    expect(useCommandBarStore.getState().state.barCollapsed).toBe(false)
    click(toggle)
    expect(useCommandBarStore.getState().state.barCollapsed).toBe(true)
    expect(toggleLabelled('Show the command bar')!.getAttribute('aria-pressed')).toBe('false')
    click(toggleLabelled('Show the command bar'))
    expect(useCommandBarStore.getState().state.barCollapsed).toBe(false)
    expect(toggleLabelled('Show the command bar')!.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Core tools card -- where hidden tools come back', () => {
  it('lists one row per Core tool, each "Shown" by default; Snap and Logs carry their caveats', () => {
    render()
    expect(CORE_TOOL_IDS).toEqual(['snap', 'canvas', 'logs', 'browser', 'partner', 'notes'])
    for (const tool of CORE_TOOL_IDS) {
      expect(byTestId(`settings-core-${tool}`), `row for ${tool}`).not.toBeNull()
      expect(must(`settings-core-${tool}-status`).textContent?.startsWith('Shown'), `${tool} status`).toBe(true)
      // Nothing to restore: no "Show everywhere" on a shown tool.
      expect(byTestId(`settings-core-${tool}-show`), `${tool} show link`).toBeNull()
    }
    expect(must('settings-core-snap-status').textContent).toContain('not in terminal-only sessions')
    expect(must('settings-core-logs-status').textContent).toContain('General → Index conversation logs')
    // A plain tool carries no caveat.
    expect(must('settings-core-canvas-status').textContent).toBe('Shown')
  })

  it('Logs says it is off when General → Index conversation logs is off', () => {
    SETTINGS = { loggingEnabled: false }
    render()
    const status = must('settings-core-logs-status').textContent ?? ''
    expect(status).toMatch(/\boff\b/)
    expect(status).toContain('General → Index conversation logs')
    // Still a row that starts with its visibility -- the caveat is appended, not a replacement.
    expect(status.startsWith('Shown')).toBe(true)
  })

  it('a tool hidden everywhere reads "Hidden everywhere" and "Show everywhere" clears it in the store', () => {
    useCommandBarStore.setState({ state: coerceCommandBarUi({ hiddenCoreTools: { everywhere: ['partner'], bySession: {} } }) })
    render()
    expect(must('settings-core-partner-status').textContent).toContain('Hidden everywhere')
    const show = must('settings-core-partner-show')
    expect(show.textContent).toBe('Show everywhere')
    // The other tools are untouched.
    expect(must('settings-core-snap-status').textContent?.startsWith('Shown')).toBe(true)
    click(show)
    expect(useCommandBarStore.getState().state.hiddenCoreTools.everywhere).toEqual([])
    expect(must('settings-core-partner-status').textContent?.startsWith('Shown')).toBe(true)
    expect(byTestId('settings-core-partner-show')).toBeNull()
  })

  it('a tool hidden in sessions names the live one and calls a dead one "a closed session"; "Show everywhere" clears every session', () => {
    useCommandBarStore.setState({ state: coerceCommandBarUi({ hiddenCoreTools: { everywhere: [], bySession: { 's-1': ['canvas'], 's-9': ['canvas'] } } }) })
    render()
    expect(must('settings-core-canvas-status').textContent).toContain('Hidden in 2 sessions (Alpha, a closed session)')
    click(must('settings-core-canvas-show'))
    expect(useCommandBarStore.getState().state.hiddenCoreTools.bySession).toEqual({})
    expect(must('settings-core-canvas-status').textContent?.startsWith('Shown')).toBe(true)
    expect(byTestId('settings-core-canvas-show')).toBeNull()
  })

  it('one session is singular: "Hidden in 1 session (Beta)"', () => {
    useCommandBarStore.setState({ state: coerceCommandBarUi({ hiddenCoreTools: { everywhere: [], bySession: { 's-2': ['logs'] } } }) })
    render()
    expect(must('settings-core-logs-status').textContent).toContain('Hidden in 1 session (Beta)')
  })
})

describe('Snap card -- colour and auto-delete, moved here from the right-click (M4)', () => {
  it('draws the shared COLOR_SWATCHES with the current colour pressed; picking another writes the magicButton store', () => {
    render()
    const swatches = Array.from(must('settings-snap-colours').querySelectorAll('button'))
    expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #00FFFF', 'Colour #FF00FF', 'Colour #00FF7F'])
    expect(swatches.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    click(swatches[1])
    expect(useMagicButtonStore.getState().settings.screenshotColor).toBe('#FF00FF')
    const after = Array.from(must('settings-snap-colours').querySelectorAll('button'))
    expect(after.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('the auto-delete toggle flips autoDeleteDays between null and 7; the days field is disabled while null', () => {
    render()
    const days = () => must('settings-snap-days') as HTMLInputElement
    expect(toggleLabelled('Delete screenshots automatically')!.getAttribute('aria-pressed')).toBe('false')
    expect(days().disabled).toBe(true)
    click(toggleLabelled('Delete screenshots automatically'))
    expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBe(7)
    expect(toggleLabelled('Delete screenshots automatically')!.getAttribute('aria-pressed')).toBe('true')
    expect(days().disabled).toBe(false)
    expect(days().value).toBe('7')
    click(toggleLabelled('Delete screenshots automatically'))
    expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBeNull()
    expect(days().disabled).toBe(true)
  })

  it('typing a number of days writes it, clamped to 1..365 (0 becomes 1, 999 becomes 365)', () => {
    useMagicButtonStore.setState({ settings: { screenshotColor: '#00FFFF', autoDeleteDays: 7 } })
    render()
    const days = () => must('settings-snap-days') as HTMLInputElement
    expect(days().disabled).toBe(false)
    typeInto(days(), '30')
    expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBe(30)
    expect(days().value).toBe('30')
    typeInto(days(), '0')
    expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBe(1)
    typeInto(days(), '999')
    expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBe(365)
    expect(days().value).toBe('365')
  })
})

describe('Commands card -- a plain searchable list', () => {
  it('lists one row per command with its chip, and says what kind it is, where it runs, where it shows, and its section', () => {
    render()
    expect(rowIds()).toEqual(['g1', 'c1', 'p1', 's1'])
    for (const id of ['g1', 'c1', 'p1', 's1']) {
      const row = rowFor(id)!
      const chip = byTestId('command-chip', row)
      expect(chip, `chip in row ${id}`).not.toBeNull()
      expect(chip!.getAttribute('data-command-id')).toBe(id)
    }
    // g1: a Global prompt to the agent.
    const g1 = rowFor('g1')!.textContent ?? ''
    expect(g1).toContain('Prompt')
    expect(g1).toContain('runs in the Claude terminal')
    expect(g1).toContain('shows in Global')
    expect(g1).not.toContain('section')
    // c1: a Session shell line to the partner shell, in a section.
    const c1 = rowFor('c1')!.textContent ?? ''
    expect(c1).toContain('Shell line')
    expect(c1).toContain('runs in the partner shell')
    expect(c1).not.toContain('(this PC)')
    expect(c1).toContain('shows in My project')
    expect(c1).toContain('section Release')
    // p1: a page button -- it runs nothing, it opens the browser pane.
    const p1 = rowFor('p1')!.textContent ?? ''
    expect(p1).toContain('Page')
    expect(p1).toContain('runs in the browser pane')
    expect(p1).toContain('shows in Global')
    // s1: on an SSH config the partner shell is on THIS PC, and the row says so.
    const s1 = rowFor('s1')!.textContent ?? ''
    expect(s1).toContain('Shell line')
    expect(s1).toContain('runs in the partner shell (this PC)')
    expect(s1).toContain('shows in Box')
  })

  it('a command scoped to a config that no longer exists shows in "a deleted config"', () => {
    COMMANDS = [...ALL, ORPHAN]
    render()
    expect(rowFor('d1')!.textContent).toContain('shows in a deleted config')
  })

  it('search narrows the list by label; nothing matching says so; no commands at all points at the bar\'s Add button', () => {
    render()
    expect(byTestId('settings-commands-empty')).toBeNull()
    typeInto(must('settings-commands-search') as HTMLInputElement, 'lint')
    expect(rowIds()).toEqual(['g1'])
    typeInto(must('settings-commands-search') as HTMLInputElement, 'zzz-nothing')
    expect(rowIds()).toEqual([])
    expect(must('settings-commands-empty').textContent).toBe('Nothing matches.')
    // Clearing the search brings everything back.
    typeInto(must('settings-commands-search') as HTMLInputElement, '')
    expect(rowIds()).toEqual(['g1', 'c1', 'p1', 's1'])
    // With no commands at all the empty text is an instruction, not a shrug.
    act(() => { root.unmount() })
    container.remove()
    COMMANDS = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render()
    expect(rowIds()).toEqual([])
    expect(must('settings-commands-empty').textContent).toContain('Add button')
  })

  it('"Needs review" shows the count and, checked, leaves only the commands that need it', () => {
    render()
    const filter = must('settings-commands-review-filter') as HTMLInputElement
    expect(filter.checked).toBe(false)
    expect(filter.parentElement?.textContent).toContain('Needs review (1)')
    click(filter)
    expect((byTestId('settings-commands-review-filter') as HTMLInputElement).checked).toBe(true)
    expect(rowIds()).toEqual(['c1'])
    click(byTestId('settings-commands-review-filter'))
    expect(rowIds()).toEqual(['g1', 'c1', 'p1', 's1'])
  })

  it('with nothing to review the label has no count', () => {
    COMMANDS = [G1, P1]
    render()
    expect(must('settings-commands-review-filter').parentElement?.textContent?.trim()).toBe('Needs review')
  })
})

describe('Commands card -- Edit re-uses CommandDialog with the command\'s own config and capabilities', () => {
  it('Edit on a config command opens the dialog with that command, its config, and the config\'s agent', () => {
    render()
    expect(byTestId('dialog-mock')).toBeNull()
    click(byTestId('settings-command-edit', rowFor('c1')!))
    const dlg = must('dialog-mock')
    expect(dlg.getAttribute('data-initial')).toBe('c1')
    expect(dlg.getAttribute('data-config')).toBe('cfg')
    expect(dlg.getAttribute('data-agent')).toBe('Claude')
    expect(dlg.getAttribute('data-remote')).toBe('')
    expect(dialogProps().configName).toBe('My project')
    expect(dialogProps().capabilities.panesOnDifferentMachines).toBe(false)
  })

  it('Edit on an SSH-config command passes capabilities with the remote host', () => {
    render()
    click(byTestId('settings-command-edit', rowFor('s1')!))
    const dlg = must('dialog-mock')
    expect(dlg.getAttribute('data-initial')).toBe('s1')
    expect(dlg.getAttribute('data-config')).toBe('ssh1')
    expect(dlg.getAttribute('data-agent')).toBe('Claude')
    expect(dlg.getAttribute('data-remote')).toBe('box')
    expect(dialogProps().capabilities.remoteHost).toBe('box')
    expect(dialogProps().capabilities.panesOnDifferentMachines).toBe(true)
    expect(dialogProps().configName).toBe('Box')
  })

  it('Edit on a Global command opens the dialog with no config and the generic local-Claude capabilities', () => {
    render()
    click(byTestId('settings-command-edit', rowFor('g1')!))
    const dlg = must('dialog-mock')
    expect(dlg.getAttribute('data-initial')).toBe('g1')
    expect(dlg.getAttribute('data-config')).toBe('')
    expect(dlg.getAttribute('data-agent')).toBe('Claude')
    expect(dialogProps().configName).toBeUndefined()
  })

  it('confirming with a secret updates the command (review cleared) and saves the secret under the command\'s key; the dialog closes', () => {
    render()
    click(byTestId('settings-command-edit', rowFor('c1')!))
    const onConfirm = dialogProps().onConfirm
    act(() => {
      onConfirm({ label: 'New', prompt: 'x', scope: 'config', configId: 'cfg', target: 'partner', kind: 'shell', hasSecretArg: true }, 'sekret')
    })
    expect(updateCommand).toHaveBeenCalledTimes(1)
    expect(updateCommand).toHaveBeenCalledWith('c1', expect.objectContaining({ label: 'New', needsReview: undefined }))
    expect(credentials().save).toHaveBeenCalledTimes(1)
    const [key, value] = credentials().save.mock.calls[0]
    expect(key).toContain('c1')
    expect(value).toBe('sekret')
    expect(credentials().delete).not.toHaveBeenCalled()
    expect(byTestId('dialog-mock')).toBeNull()
  })

  it('confirming without a secret argument deletes any stored secret for the command', () => {
    render()
    click(byTestId('settings-command-edit', rowFor('c1')!))
    act(() => {
      dialogProps().onConfirm({ label: 'Plain', prompt: 'x', scope: 'config', configId: 'cfg', target: 'partner', kind: 'shell', hasSecretArg: undefined })
    })
    expect(updateCommand).toHaveBeenCalledWith('c1', expect.objectContaining({ label: 'Plain' }))
    expect(credentials().save).not.toHaveBeenCalled()
    expect(credentials().delete).toHaveBeenCalledTimes(1)
    expect(credentials().delete.mock.calls[0][0]).toContain('c1')
    expect(byTestId('dialog-mock')).toBeNull()
  })

  it('Cancel on the dialog closes it and changes nothing', () => {
    render()
    click(byTestId('settings-command-edit', rowFor('c1')!))
    act(() => { dialogProps().onCancel() })
    expect(byTestId('dialog-mock')).toBeNull()
    expect(updateCommand).not.toHaveBeenCalled()
    expect(credentials().save).not.toHaveBeenCalled()
    expect(credentials().delete).not.toHaveBeenCalled()
  })
})

describe('Commands card -- Delete asks first and says what Global costs', () => {
  it('Delete on a Global command asks, naming Global and every config; Cancel does nothing', () => {
    render()
    expect(byTestId('confirm-delete')).toBeNull()
    click(byTestId('settings-command-delete', rowFor('g1')!))
    const card = must('confirm-delete')
    expect(card.querySelector('h3')?.textContent).toBe('Delete "Fix lint"?')
    expect(card.textContent).toContain('Global')
    expect(card.textContent).toContain('every config')
    click(cancelButton(card))
    expect(byTestId('confirm-delete')).toBeNull()
    expect(removeCommand).not.toHaveBeenCalled()
    expect(credentials().delete).not.toHaveBeenCalled()
    // The row is still there.
    expect(rowFor('g1')).toBeDefined()
  })

  it('confirming removes the command and its keychain entry, and closes the confirm', () => {
    render()
    click(byTestId('settings-command-delete', rowFor('g1')!))
    click(must('confirm-delete-ok', must('confirm-delete')))
    expect(removeCommand).toHaveBeenCalledTimes(1)
    expect(removeCommand).toHaveBeenCalledWith('g1')
    expect(credentials().delete).toHaveBeenCalledTimes(1)
    expect(credentials().delete.mock.calls[0][0]).toContain('g1')
    expect(byTestId('confirm-delete')).toBeNull()
  })

  it('Delete on a config command says it disappears from its config, not from everywhere', () => {
    render()
    click(byTestId('settings-command-delete', rowFor('c1')!))
    const card = must('confirm-delete')
    expect(card.querySelector('h3')?.textContent).toBe('Delete "Deploy"?')
    expect(card.textContent).toContain('its config')
    expect(card.textContent).not.toContain('every config')
  })
})

describe('SettingsPage registration (source-level smoke check)', () => {
  // Importing the real SettingsPage drags the whole app into a unit test, so
  // this reads the SOURCE instead: the tab id is in SETTINGS_TAB_IDS, its label
  // is "Custom Commands", and the page renders <CustomCommandsTab />. It is a
  // text check, not a render -- enough to catch the tab being unregistered.
  it('SettingsPage.tsx registers the "commands" tab, labelled "Custom Commands", rendering <CustomCommandsTab />', () => {
    // __dirname is this test file's directory (vite-node provides it), so the
    // path holds no matter where vitest was launched from.
    const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')
    const ids = src.match(/export const SETTINGS_TAB_IDS = \[([^\]]*)\]/)
    expect(ids, 'SETTINGS_TAB_IDS is declared').not.toBeNull()
    expect(ids![1]).toContain("'commands'")
    expect(src).toMatch(/\{\s*id:\s*'commands',\s*label:\s*'Custom Commands'\s*\}/)
    expect(src).toContain('<CustomCommandsTab />')
    expect(src).toMatch(/activeTab === 'commands' && <CustomCommandsTab \/>/)
  })
})
