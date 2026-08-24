// @vitest-environment jsdom
/**
 * The sidebar dock: Ask Conductor, the tip row beneath it, and the right-click
 * hide that switches either FEATURE off rather than merely unmounting a row.
 *
 * What is worth pinning here, as opposed to restating the markup:
 *
 *  - the tip row carries the tip TEXT and a count, which is the whole argument
 *    for moving it out of the session header (a pill with room for an icon);
 *  - hiding writes the setting only on CONFIRM. A right-click that opened a
 *    dialog and switched the feature off underneath it would be a trap, and the
 *    dialog is the only place the user is told where the way back is;
 *  - `showTips: false` must leave NOTHING behind -- no row, and no picking
 *    either, or the library burns down invisibly and the count lies on re-enable;
 *  - with both features off the dock renders nothing at all, rather than an
 *    empty bordered strip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: AskConductorDock } = await import('../../../src/renderer/components/sidebar/AskConductorDock')
const { useTipsStore, countUnseenTips } = await import('../../../src/renderer/stores/tipsStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { TIPS_LIBRARY } = await import('../../../src/renderer/tips-library')

/** A tip with no `requires`, so it resolves without any usage history. */
const FREE_TIPS = TIPS_LIBRARY.filter((t) => !t.requires?.length && !t.excludes?.length)

const EMPTY = { features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} }

let container: HTMLDivElement
let root: Root
const updates: any[] = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  updates.length = 0
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useTipsStore.setState({ tracking: EMPTY, currentTipId: null, silencedUntilRestart: false, isLoaded: true })
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, showTips: true, showAskConductor: true },
    updateSettings: (async (patch: any) => { updates.push(patch) }) as any,
  } as any)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = (props: Partial<React.ComponentProps<typeof AskConductorDock>> = {}) =>
  act(() => {
    root.render(
      <AskConductorDock onOpened={() => {}} isActive={false} onShowTip={() => {}} {...props} />,
    )
  })

/** Put a real tip on screen and return it. */
function armTip() {
  const tip = FREE_TIPS[0]
  expect(tip, 'the library must contain at least one unconditional tip').toBeDefined()
  useTipsStore.setState({ currentTipId: tip.id, tracking: { ...EMPTY, tipsShown: { [tip.id]: 1 } } })
  return tip
}

const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)

describe('sidebar dock -- the tip row', () => {
  it('shows the tip text itself, not just an icon', () => {
    const tip = armTip()
    render()
    const row = q('sidebar-tip-pill')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(tip.variants.primary.shortText)
  })

  it('the row IS the tip -- no "Tip of the day" header eating the width (#361)', () => {
    armTip()
    render()
    expect(q('sidebar-tip-pill')!.textContent).not.toContain('Tip of the day')
  })

  it('gives the headline two lines rather than truncating it to one', () => {
    // 256px rail, minus the mark and the counter, is about 30 characters at
    // 11px -- and the longest headline in the library is 59. One line meant an
    // ellipsis on nearly half the library; the clamp is what buys the room.
    armTip()
    render()
    const text = q('sidebar-tip-text')!
    expect(text.className).toContain('line-clamp-2')
    expect(text.className).not.toContain('truncate')
  })

  it('sits after the Ask Conductor pill, not before it', () => {
    armTip()
    render()
    const ask = q('sidebar-ask-pill')!
    const tip = q('sidebar-tip-pill')!
    // DOCUMENT_POSITION_FOLLOWING === 4: the tip comes after Ask in the tree.
    expect(ask.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows how many tips have never been surfaced', () => {
    const tip = armTip()
    render()
    const count = q('sidebar-tip-count')
    expect(count).not.toBeNull()
    // Every free tip except the one already stamped shown.
    expect(count!.textContent).toContain(String(countUnseenTips(useTipsStore.getState().tracking)))
    expect(countUnseenTips({ ...EMPTY, tipsShown: { [tip.id]: 1 } }))
      .toBe(countUnseenTips(EMPTY) - 1)
  })

  it('counts with a badge, not a worded pill (#361)', () => {
    armTip()
    render()
    const count = q('sidebar-tip-count')!
    const n = countUnseenTips(useTipsStore.getState().tracking)
    // The number alone. "N new" spent room the tip needed; the wording lives in
    // the tooltip and the accessible name, where it costs nothing.
    expect(count.textContent!.trim()).toBe(String(n))
    expect(count.getAttribute('aria-label')).toContain('new tip')
  })

  it('drops a dismissed tip out of the count', () => {
    const tip = FREE_TIPS[0]
    expect(countUnseenTips({ ...EMPTY, tipsDismissed: { [tip.id]: 1 } }))
      .toBe(countUnseenTips(EMPTY) - 1)
  })

  it('renders no row when there is nowhere to send the click', () => {
    armTip()
    render({ onShowTip: undefined })
    expect(q('sidebar-tip-pill')).toBeNull()
    // ...but Ask is unaffected: the two rows are independent.
    expect(q('sidebar-ask-pill')).not.toBeNull()
  })

  it('renders no row while tips are silenced for this launch', () => {
    armTip()
    useTipsStore.setState({ silencedUntilRestart: true })
    render()
    expect(q('sidebar-tip-pill')).toBeNull()
  })
})

describe('sidebar dock -- hiding a feature', () => {
  it('needs a confirmation: right-click alone changes nothing', () => {
    armTip()
    render()
    act(() => {
      q('sidebar-tip-pill')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(q('dock-row-menu')).not.toBeNull()
    expect(updates).toEqual([])
  })

  it('still changes nothing when the dialog is cancelled', () => {
    armTip()
    render()
    act(() => { q('sidebar-tip-pill')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    act(() => { (q('dock-row-menu-hide') as HTMLButtonElement).click() })
    expect(q('hide-dock-feature-dialog')).not.toBeNull()
    act(() => { (q('hide-dock-feature-cancel') as HTMLButtonElement).click() })
    expect(updates).toEqual([])
    expect(q('sidebar-tip-pill')).not.toBeNull()
  })

  it('writes showTips:false only once the dialog is confirmed', () => {
    armTip()
    render()
    act(() => { q('sidebar-tip-pill')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    act(() => { (q('dock-row-menu-hide') as HTMLButtonElement).click() })
    act(() => { (q('hide-dock-feature-confirm') as HTMLButtonElement).click() })
    expect(updates).toEqual([{ showTips: false }])
    // The tip already picked for this launch is dropped too, so no other entry
    // point can raise it and a re-enable starts clean.
    expect(useTipsStore.getState().currentTipId).toBeNull()
  })

  it('covers the window, not the sidebar rail', () => {
    // The dialog is rendered from inside the dock and the sidebar root is
    // `relative`, so an `absolute` backdrop is scoped to the 256px rail --
    // which on a real desktop renders the dialog as a squeezed column with a
    // wrapped title. jsdom has no layout, so the positioning scheme is the
    // only thing a unit test can hold onto.
    armTip()
    render()
    act(() => { q('sidebar-tip-pill')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    act(() => { (q('dock-row-menu-hide') as HTMLButtonElement).click() })
    const backdrop = q('hide-dock-feature-backdrop')!
    expect(backdrop.className).toContain('fixed')
    expect(backdrop.className).not.toContain('absolute')
  })

  it('hides Ask Conductor from its own row, independently of tips', () => {
    armTip()
    render()
    act(() => { q('sidebar-ask-pill')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    act(() => { (q('dock-row-menu-hide') as HTMLButtonElement).click() })
    act(() => { (q('hide-dock-feature-confirm') as HTMLButtonElement).click() })
    expect(updates).toEqual([{ showAskConductor: false }])
    // Tips were never touched.
    expect(useTipsStore.getState().currentTipId).not.toBeNull()
  })
})

describe('sidebar dock -- the Ask row copy (#372)', () => {
  const SUBTITLE = 'Ask about and customise app functionality'

  it('says what Ask is for under the label, not just "About this app"', () => {
    render()
    const ask = q('sidebar-ask-pill')!
    expect(ask.textContent).toContain(SUBTITLE)
    expect(ask.textContent).not.toContain('About this app')
  })

  it('carries the same wording in the tooltip, expanded and collapsed', () => {
    render()
    expect(q('sidebar-ask-pill')!.getAttribute('title')).toContain(SUBTITLE.toLowerCase())
    render({ collapsed: true })
    const rail = q('sidebar-ask-pill')!
    // The collapsed rail has no visible subtitle, so the tooltip and the
    // accessible name are the only places the wording reaches the user.
    expect(rail.getAttribute('title')).toContain(SUBTITLE.toLowerCase())
    expect(rail.getAttribute('aria-label')).toContain(SUBTITLE.toLowerCase())
  })
})

describe('sidebar dock -- what the settings actually gate', () => {
  it('showTips:false removes the row', () => {
    armTip()
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, showTips: false },
    } as any)
    render()
    expect(q('sidebar-tip-pill')).toBeNull()
    expect(q('sidebar-ask-pill')).not.toBeNull()
  })

  it('showAskConductor:false removes the Ask pill', () => {
    armTip()
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, showAskConductor: false },
    } as any)
    render()
    expect(q('sidebar-ask-pill')).toBeNull()
    expect(q('sidebar-tip-pill')).not.toBeNull()
  })

  it('renders no dock zone at all when both are off', () => {
    armTip()
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, showTips: false, showAskConductor: false },
    } as any)
    render()
    expect(q('sidebar-dockzone')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('treats an absent showAskConductor as shown, so upgrades keep the entry point', () => {
    const settings = { ...useSettingsStore.getState().settings }
    delete (settings as any).showAskConductor
    useSettingsStore.setState({ settings } as any)
    render()
    expect(q('sidebar-ask-pill')).not.toBeNull()
  })

  it('keeps both rows reachable in the collapsed rail', () => {
    armTip()
    render({ collapsed: true })
    expect(q('sidebar-ask-pill')).not.toBeNull()
    expect(q('sidebar-tip-pill')).not.toBeNull()
  })
})

describe('sidebar dock -- the row survives acknowledging a tip (owner bug, 2026-08-24)', () => {
  it('markTipActed on the shown tip rotates the row to the next tip, never unmounts it', () => {
    const tip = armTip()
    render()
    expect(q('sidebar-tip-pill')).not.toBeNull()
    act(() => { useTipsStore.getState().markTipActed(tip.id) })
    const row = q('sidebar-tip-pill')
    expect(row, 'the tip row must survive "Got it"').not.toBeNull()
    expect(row!.textContent).not.toContain(tip.variants.primary.shortText)
  })

  it('using the feature an excludes-only tip points at rotates the row too', () => {
    // tip.memory-visualiser resolves to null once memory.memory-page is used
    // (excludes with no postUse) -- the second path that used to unmount the row.
    useTipsStore.setState({ currentTipId: 'tip.memory-visualiser', tracking: { ...EMPTY, tipsShown: { 'tip.memory-visualiser': 1 } } })
    render()
    expect(q('sidebar-tip-pill')).not.toBeNull()
    act(() => { useTipsStore.getState().recordUsage('memory.memory-page') })
    expect(q('sidebar-tip-pill'), 'the tip row must survive the excludes gate firing').not.toBeNull()
  })
})
