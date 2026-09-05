// @vitest-environment jsdom
/**
 * The E5 dialog primitives themselves (#360).
 *
 * The per-dialog suites prove each migrated surface is token-driven. This one
 * pins the primitives they all sit on, so a change to `ui/Dialog.tsx` cannot
 * quietly re-introduce a palette colour, a click-to-close backdrop, or an
 * unreadable button, across every dialog at once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DialogCallout,
  useDialogEscape,
  dialogButtonStyle,
  dialogSegStyle,
  scrim,
  ON_BRAND,
} from '../../../src/renderer/components/ui/Dialog'
import { paletteSurvivors, expectRaisedPanel, expectNoBackdropClose, pressEscape } from './dialog-tokens-harness'

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(ui: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(ui) })
  return host
}

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  if (host) host.remove()
  root = null
  host = null
})

describe('DialogOverlay', () => {
  it('has no click-to-close — Ctrl+C in a terminal fires click events', () => {
    // The house rule this encodes: a backdrop that closed on click ate the
    // user's dialog when they hit Ctrl+C in a terminal underneath.
    const onClose = vi.fn()
    const c = render(
      <DialogOverlay testId="ov">
        <DialogPanel ariaLabel="x" testId="panel"><button onClick={onClose}>x</button></DialogPanel>
      </DialogOverlay>,
    )
    const overlay = c.querySelector('[data-testid="ov"]') as HTMLElement
    expectNoBackdropClose(overlay, () => !!c.querySelector('[data-testid="panel"]'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('exposes no onClick/onMouseDown prop at the type level (structural guard)', () => {
    // If someone adds one, this render would start forwarding it.
    const c = render(<DialogOverlay testId="ov"><span /></DialogOverlay>)
    const overlay = c.querySelector('[data-testid="ov"]') as HTMLElement
    expect(overlay.onclick).toBeNull()
    expect(overlay.onmousedown).toBeNull()
    expect(overlay.hasAttribute('data-dialog-overlay')).toBe(true)
  })

  it('paints the scrim from the theme-aware token, honouring dim', () => {
    // NOT rgba(0,0,0,…): dialogs used to dim with `bg-base/80`, so the light
    // theme faded to a soft near-white. Hardcoding black here made the light
    // theme flash to 90% black when closing the app.
    const c = render(<DialogOverlay testId="ov" dim={0.42}><span /></DialogOverlay>)
    const overlay = c.querySelector('[data-testid="ov"]') as HTMLElement
    expect(overlay.style.background).toBe('color-mix(in srgb, var(--scrim) 42%, transparent)')
    expect(overlay.style.background).not.toContain('rgba')
    expect(paletteSurvivors(overlay)).toEqual([])
  })

  it('scrim() does not leak binary floating point into the CSS', () => {
    // 0.6 * 100 is 60.00000000000001.
    expect(scrim(0.6)).toBe('color-mix(in srgb, var(--scrim) 60%, transparent)')
    expect(scrim(0.35)).toBe('color-mix(in srgb, var(--scrim) 35%, transparent)')
    expect(scrim(0.9)).toBe('color-mix(in srgb, var(--scrim) 90%, transparent)')
  })
})

describe('DialogPanel', () => {
  it('is the raised surface with the subtle border, by token', () => {
    const c = render(<DialogPanel ariaLabel="t" testId="p">body</DialogPanel>)
    expectRaisedPanel(c.querySelector('[data-testid="p"]') as HTMLElement)
  })

  it('is a modal dialog and carries its accessible name', () => {
    const c = render(<DialogPanel labelledBy="h" testId="p">body</DialogPanel>)
    const panel = c.querySelector('[data-testid="p"]') as HTMLElement
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-labelledby')).toBe('h')
  })

  it('can be an alertdialog for destructive confirms', () => {
    const c = render(<DialogPanel role="alertdialog" ariaLabel="t" testId="p">b</DialogPanel>)
    expect((c.querySelector('[data-testid="p"]') as HTMLElement).getAttribute('role')).toBe('alertdialog')
  })
})

describe('DialogHeader', () => {
  it('renders the title with the id the panel points at, plus subtitle and glyph', () => {
    const c = render(
      <DialogHeader title="Title" titleId="h" subtitle="Sub" glyph={<svg />} />,
    )
    const h = c.querySelector('#h') as HTMLElement
    expect(h.tagName).toBe('H2')
    expect(h.textContent).toBe('Title')
    expect(c.textContent).toContain('Sub')
    expect(paletteSurvivors(c)).toEqual([])
  })

  it('renders a close glyph only when onClose is given, with a real label', () => {
    const onClose = vi.fn()
    const c = render(<DialogHeader title="T" onClose={onClose} closeLabel="Close it" closeTestId="x" />)
    const btn = c.querySelector('[data-testid="x"]') as HTMLButtonElement
    expect(btn.getAttribute('aria-label')).toBe('Close it')
    act(() => { btn.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits the close glyph when there is no onClose', () => {
    const c = render(<DialogHeader title="T" />)
    expect(c.querySelector('button')).toBeNull()
  })
})

describe('DialogButton', () => {
  it('primary is the brand fill with text that flips by token, not a hardcoded colour', () => {
    // The `text-base` trap this replaces: `bg-blue text-base` resolved to a
    // FONT SIZE, so those buttons inherited their text colour.
    const s = dialogButtonStyle('primary')
    expect(s.background).toBe('var(--brand)')
    expect(s.color).toBe(ON_BRAND)
    expect(ON_BRAND).toContain('--text-on-brand')
  })

  it('maps every variant to a token, never a palette literal', () => {
    for (const v of ['primary', 'secondary', 'ghost', 'danger', 'danger-solid'] as const) {
      const s = dialogButtonStyle(v)
      const all = `${s.background ?? ''} ${s.color ?? ''} ${s.border ?? ''}`
      expect(all, `${v} paints from a var()`).toMatch(/var\(--|transparent/)
      expect(all, `${v} must not use a palette hex`).not.toMatch(/#(?!0a0e13)[0-9a-f]{6}/i)
    }
    expect(dialogButtonStyle('danger').color).toBe('var(--status-danger)')
    expect(dialogButtonStyle('secondary').background).toBe('var(--surface-overlay)')
    expect(dialogButtonStyle('ghost').background).toBe('transparent')
  })

  it('renders a real button, forwards handlers and disabled, and keeps its test id', () => {
    const onClick = vi.fn()
    const c = render(<DialogButton variant="primary" testId="b" onClick={onClick}>Go</DialogButton>)
    const b = c.querySelector('[data-testid="b"]') as HTMLButtonElement
    expect(b.tagName).toBe('BUTTON')
    expect(b.getAttribute('type')).toBe('button')
    act(() => { b.click() })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(paletteSurvivors(c)).toEqual([])
  })

  it('does not fire when disabled', () => {
    const onClick = vi.fn()
    const c = render(<DialogButton testId="b" disabled onClick={onClick}>Go</DialogButton>)
    const b = c.querySelector('[data-testid="b"]') as HTMLButtonElement
    act(() => { b.click() })
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('DialogCallout', () => {
  it('tints from the matching status token per tone', () => {
    const cases = [
      ['warning', '--status-warning'],
      ['danger', '--status-danger'],
      ['info', '--status-info'],
      ['success', '--status-success'],
    ] as const
    for (const [tone, token] of cases) {
      const c = render(<DialogCallout tone={tone} testId="c">msg</DialogCallout>)
      const el = c.querySelector('[data-testid="c"]') as HTMLElement
      expect(el.getAttribute('data-tone')).toBe(tone)
      expect(`${el.style.background} ${el.style.borderColor}`).toContain(token)
      expect(paletteSurvivors(el)).toEqual([])
      act(() => { root!.unmount() }); host!.remove(); root = null; host = null
    }
  })
})

describe('useDialogEscape', () => {
  function Probe({ onClose, enabled }: { onClose: () => void; enabled?: boolean }) {
    useDialogEscape(onClose, enabled)
    return <span>probe</span>
  }

  it('closes on Escape from anywhere (capture phase, so the terminal does not win)', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('is inert when disabled — a dialog mid-work cannot be abandoned', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} enabled={false} />)
    pressEscape()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    act(() => { root!.unmount() })
    root = null
    pressEscape()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('dialogSegStyle', () => {
  it('paints selected and unselected from tokens, and marks disabled', () => {
    const on = dialogSegStyle(true)
    const off = dialogSegStyle(false)
    expect(`${on.background} ${on.color}`).toContain('--brand')
    expect(off.background).toBe('var(--surface-raised)')
    expect(off.color).toBe('var(--text-secondary)')
    expect(dialogSegStyle(false, true).cursor).toBe('not-allowed')
    expect(dialogSegStyle(false, true).opacity).toBe(0.5)
  })
})

describe('a whole dialog assembled from the primitives', () => {
  it('renders with zero palette classes end to end', () => {
    const c = render(
      <DialogOverlay testId="ov">
        <DialogPanel labelledBy="t" testId="p">
          <DialogHeader title="Confirm" titleId="t" subtitle="Sure?" onClose={() => {}} />
          <DialogBody>
            <DialogCallout tone="warning">Careful.</DialogCallout>
          </DialogBody>
          <DialogFooter left={<span>hint</span>}>
            <DialogButton variant="ghost">Cancel</DialogButton>
            <DialogButton variant="primary">OK</DialogButton>
          </DialogFooter>
        </DialogPanel>
      </DialogOverlay>,
    )
    expect(paletteSurvivors(c)).toEqual([])
  })
})

// A window-covering backdrop must also cover the NATIVE panes (the browser and
// claude.ai account views main paints above all HTML). The overlay holds the
// occlusion flag for exactly its mounted life; an `absolute` overlay covers
// only its own ancestor and holds nothing.
const { usePaneOcclusionStore } = await import('../../../src/renderer/stores/paneOcclusionStore')

describe('DialogOverlay and the native panes', () => {
  it('a fixed overlay occludes the native panes while mounted, and releases on unmount', () => {
    usePaneOcclusionStore.setState({ activeView: 'sessions', overlays: 0 })
    const h = document.createElement('div')
    document.body.appendChild(h)
    const r = createRoot(h)
    act(() => { r.render(<DialogOverlay><div>hi</div></DialogOverlay>) })
    expect(usePaneOcclusionStore.getState().overlays).toBe(1)
    act(() => { r.unmount() })
    h.remove()
    expect(usePaneOcclusionStore.getState().overlays).toBe(0)
  })

  it('an absolute overlay leaves the native panes alone', () => {
    usePaneOcclusionStore.setState({ activeView: 'sessions', overlays: 0 })
    const h = document.createElement('div')
    document.body.appendChild(h)
    const r = createRoot(h)
    act(() => { r.render(<DialogOverlay position="absolute"><div>hi</div></DialogOverlay>) })
    expect(usePaneOcclusionStore.getState().overlays).toBe(0)
    act(() => { r.unmount() })
    h.remove()
  })
})
