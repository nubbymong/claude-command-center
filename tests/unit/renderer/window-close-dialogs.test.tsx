// @vitest-environment jsdom
/**
 * The window-close dialogs over the surfaces that cover the whole window
 * (VM audit 2026-09-25, round 2).
 *
 * The close dialog was INVISIBLE over the onboarding pages and over Hello
 * Codex: `.ob-root` is z-index 100 and the dialog sat on the default z-50,
 * yet it held the focus on "Save sessions", so a blind Enter saved and quit.
 * And Tab walked out of both close dialogs into the page behind.
 *
 * Verifies:
 *   - the layer: CloseDialog, SshCloseDialog and the "Closing..." overlay
 *     are on WINDOW_CLOSE_Z, above every covering surface (the onboarding
 *     root, the dialogs opened over it, the Hello Codex takeover and replay,
 *     the "Back to setup" pill), and nothing else in the renderer paints at
 *     or above it; App renders them after the covering surfaces, and the two
 *     close dialogs in a fixed order (same layer: the later paints above);
 *   - focus: each keeps Tab and Shift+Tab inside itself, on its own and over
 *     the onboarding pages and the takeover; each keeps the focus it opens
 *     with (Save sessions; Leave running, not the destructive first button);
 *     a Tab from outside comes back in; with both open, the later one has
 *     the keys;
 *   - the native panes (round 3): the in-app browser and the claude.ai
 *     account view are painted by main above all HTML, so no z-index puts
 *     anything over them; each of the three holds the occlusion flag while it
 *     shows (their overlays are `absolute`, which holds none), the way
 *     DialogOverlay does for a fixed one (dialog-primitives.test.tsx).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '2.1.1-beta.1'

const ssh = vi.hoisted(() => ({
  pending: null as null | { sessionId: string; label: string; host?: string; remoteAccount?: string },
  clear: vi.fn(),
  endRemoteAndClose: vi.fn(async () => {}),
  leaveRunningAndClose: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({
  useSshCloseStore: (sel: (s: { pending: typeof ssh.pending; clear: () => void }) => unknown) => sel({ pending: ssh.pending, clear: ssh.clear }),
  endRemoteAndClose: ssh.endRemoteAndClose,
  leaveRunningAndClose: ssh.leaveRunningAndClose,
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(() => Promise.resolve(true)),
  saveConfigDebounced: vi.fn(),
  flushPendingConfigSaves: vi.fn(() => Promise.resolve()),
  retryFailedConfigSaves: vi.fn(() => Promise.resolve()),
}))

const h = React.createElement
const { default: CloseDialog } = await import('../../../src/renderer/components/CloseDialog')
const { default: SshCloseDialog } = await import('../../../src/renderer/components/SshCloseDialog')
const { WINDOW_CLOSE_Z } = await import('../../../src/renderer/components/ui/Dialog')
const { OnboardingShell } = await import('../../../src/renderer/onboarding/OnboardingShell')
const { HelloCodexTakeover } = await import('../../../src/renderer/onboarding/HelloCodex')
const { useHelloCodexStore } = await import('../../../src/renderer/onboarding/hello-codex')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { usePaneOcclusionStore } = await import('../../../src/renderer/stores/paneOcclusionStore')

const ROOT = path.resolve(__dirname, '../../..')
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  ssh.pending = null
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useAppMetaStore.setState({ meta: {} })
  useProviderAccountsStore.setState({ snapshot: null, loaded: true })
  useHelloCodexStore.setState({ open: null })
  usePaneOcclusionStore.setState({ overlays: 0 })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const active = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
}

/** Tab (or Shift+Tab) where focus is, as the browser delivers it; jsdom
 *  moves no focus itself. */
async function tab(shift = false) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })) })
}

const closeDialog = () => h(CloseDialog, { mode: 'close', sessionCount: 2, onSaveAndClose: vi.fn(), onCloseWithoutSaving: vi.fn(), onCancel: vi.fn() })
const PENDING = { sessionId: 's1', label: 'prod box', host: 'prod.example' }

/** The z-index a Tailwind class list sets (`z-50`, `z-[200]`), or null. */
function zOfClass(className: string): number | null {
  const m = className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?=\s|$)/)
  return m ? Number(m[1] ?? m[2]) : null
}
const LAYER = zOfClass(WINDOW_CLOSE_Z)!

describe('the window-close layer', () => {
  it('WINDOW_CLOSE_Z is a z-index class', () => {
    expect(LAYER).toBeGreaterThan(0)
  })

  it('both close dialogs paint on it', async () => {
    ssh.pending = PENDING
    await render(h(React.Fragment, null, h(SshCloseDialog), closeDialog()))
    expect(zOfClass(byTest('close-dialog')!.className)).toBe(LAYER)
    expect(zOfClass(byTest('ssh-close-dialog')!.className)).toBe(LAYER)
  })

  it('it is above every surface that covers the window', async () => {
    const covering: Array<[string, number]> = []
    // The onboarding pages: .ob-root's own z-index.
    const obZ = src('src/renderer/onboarding/onboarding.css').match(/\.ob-root \{[^}]*z-index:\s*(\d+)/)
    expect(obZ, '.ob-root sets a z-index').toBeTruthy()
    covering.push(['.ob-root', Number(obZ![1])])
    // A dialog opened over them (Codex setup's add-account dialog).
    const over = src('src/renderer/onboarding/CodexSetupStep.tsx').match(/const OVER_ONBOARDING = '([^']+)'/)
    expect(over, 'CodexSetupStep names the layer over onboarding').toBeTruthy()
    covering.push(['OVER_ONBOARDING', zOfClass(over![1])!])
    // The "Back to setup" pill shown while the pages step aside.
    const pill = src('src/renderer/onboarding/OnboardingHarness.tsx').match(/className="fixed bottom-16 right-6 (z-\[\d+\])/)
    expect(pill, 'the "Back to setup" pill names its layer').toBeTruthy()
    covering.push(['back-to-setup', zOfClass(pill![1])!])
    // Hello Codex's takeover and replay, as rendered.
    await render(h(HelloCodexTakeover, { onClose: vi.fn(), onStartSession: vi.fn() }))
    covering.push(['hello-codex-takeover', zOfClass(byTest('hello-codex-takeover')!.className)!])
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(h(HelloCodexTakeover, { replay: true, onClose: vi.fn(), onStartSession: vi.fn() }))
    covering.push(['hello-codex-replay', zOfClass(byTest('hello-codex-replay')!.className)!])
    for (const [what, z] of covering) {
      expect(z, `${what} has a z-index`).toBeGreaterThan(0)
      expect(LAYER, `the close dialogs (${LAYER}) paint above ${what} (${z})`).toBeGreaterThan(z)
    }
  })

  it('nothing else in the renderer paints at or above it (the debug panel aside)', () => {
    const ALLOWED = new Set([
      // The layer itself.
      'components/ui/Dialog.tsx:200',
      // The developer debug overlay: a dev tool, above everything on purpose.
      'components/DebugPanel.tsx:9999',
    ])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(tsx?|css)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8')
          const rel = path.relative(path.join(ROOT, 'src/renderer'), p).replace(/\\/g, '/')
          for (const re of [/(?<![\w-])z-\[(\d+)\]/g, /(?<![\w-])z-(\d+)(?![\w[])/g, /z-index:\s*(\d+)/g, /zIndex:\s*(\d+)/g]) {
            for (const m of text.matchAll(re)) {
              const z = Number(m[1])
              if (z >= LAYER && !ALLOWED.has(`${rel}:${z}`)) found.push(`${rel}: ${m[0]}`)
            }
          }
        }
      }
    }
    walk(path.join(ROOT, 'src/renderer'))
    expect(found).toEqual([])
  })

  it('App: the Closing overlay is on it, and the close dialogs come after the covering surfaces, CloseDialog last', () => {
    const app = src('src/renderer/App.tsx')
    expect(app).toMatch(/\{isClosing && \(\s*<DialogOverlay position="absolute" z=\{WINDOW_CLOSE_Z\}/)
    const sshAt = app.indexOf('<SshCloseDialog />')
    const closeAt = app.indexOf('<CloseDialog')
    for (const surface of ['<OnboardingHarness', '<HelloCodexHost']) {
      expect(app.indexOf(surface), `${surface} is rendered before the close dialogs`).toBeLessThan(sshAt)
    }
    // One layer: the later paints above, and has the keys (contain-focus).
    expect(closeAt).toBeGreaterThan(sshAt)
    expect(app.indexOf('{isClosing && (')).toBeGreaterThan(closeAt)
  })
})

describe('the close dialog keeps Tab inside itself', () => {
  it('opens on "Save sessions"; Tab from it goes round to Cancel, Shift+Tab back', async () => {
    await render(closeDialog())
    expect(active()).toBe('close-dialog-save')
    await tab()
    expect(active()).toBe('close-dialog-cancel')
    await tab(true)
    expect(active()).toBe('close-dialog-save')
  })

  it('over the onboarding pages: Tab stays in the dialog, and a Tab from the page behind comes back to it', async () => {
    await render(h(React.Fragment, null,
      h(OnboardingShell, { phase: 0 }, h('button', { type: 'button', 'data-testid': 'page-next' }, 'Next')),
      closeDialog()))
    expect(active()).toBe('close-dialog-save')
    await tab()
    expect(active()).toBe('close-dialog-cancel')
    byTest('page-next')!.focus()
    await tab()
    expect(active()).toBe('close-dialog-cancel')
  })

  it('over the Hello Codex takeover: Tab stays in the dialog, not on the takeover\'s page dots', async () => {
    await render(h(React.Fragment, null,
      h(HelloCodexTakeover, { replay: true, onClose: vi.fn(), onStartSession: vi.fn() }),
      closeDialog()))
    byTest('close-dialog-save')!.focus()
    await tab()
    expect(active()).toBe('close-dialog-cancel')
    await tab(true)
    expect(active()).toBe('close-dialog-save')
  })

  it('with focus on the page body, Tab comes back into it', async () => {
    await render(closeDialog())
    ;(document.activeElement as HTMLElement).blur()
    await tab()
    expect(active()).toBe('close-dialog-cancel')
  })
})

describe('the SSH close dialog keeps Tab inside itself', () => {
  it('opens on "Leave running", not the destructive first button; Tab goes round', async () => {
    ssh.pending = PENDING
    await render(h(SshCloseDialog))
    expect(active()).toBe('ssh-close-leave')
    await tab()
    expect(active()).toBe('ssh-close-end')
    await tab(true)
    expect(active()).toBe('ssh-close-leave')
  })

  it('over the onboarding pages too', async () => {
    ssh.pending = PENDING
    await render(h(React.Fragment, null,
      h(OnboardingShell, { phase: 0 }, h('button', { type: 'button', 'data-testid': 'page-next' }, 'Next')),
      h(SshCloseDialog)))
    await tab()
    expect(active()).toBe('ssh-close-end')
    byTest('page-next')!.focus()
    await tab(true)
    expect(active()).toBe('ssh-close-leave')
  })

  it('with both open, the later one (the app close dialog, painted above) has the keys', async () => {
    ssh.pending = PENDING
    await render(h(React.Fragment, null, h(SshCloseDialog), closeDialog()))
    byTest('ssh-close-leave')!.focus()
    await tab()
    expect(byTest('close-dialog')!.contains(document.activeElement)).toBe(true)
  })
})

describe('the native panes hide while a window-close surface shows', () => {
  const overlays = () => usePaneOcclusionStore.getState().overlays

  it('the close dialog holds the occlusion flag while mounted, and releases it', async () => {
    expect(overlays()).toBe(0)
    await render(closeDialog())
    expect(overlays()).toBe(1)
    act(() => { root.unmount() })
    root = createRoot(container)
    expect(overlays()).toBe(0)
  })

  it('the SSH close dialog holds it only while it has something to ask', async () => {
    await render(h(SshCloseDialog))
    expect(overlays()).toBe(0)
    ssh.pending = PENDING
    await render(h(SshCloseDialog, { key: 'open' }))
    expect(byTest('ssh-close-dialog')).not.toBeNull()
    expect(overlays()).toBe(1)
    act(() => { root.unmount() })
    root = createRoot(container)
    expect(overlays()).toBe(0)
  })

  it('App holds it while the Closing overlay shows, from a hook above its early returns', () => {
    const app = src('src/renderer/App.tsx')
    const hook = app.indexOf('useOccludesNativePanes(isClosing)')
    expect(hook, 'App calls useOccludesNativePanes(isClosing)').toBeGreaterThan(0)
    // Rules of Hooks: before the first early return of the component.
    expect(hook).toBeLessThan(app.indexOf('if (setupComplete === null'))
    expect(app.match(/useOccludesNativePanes\(/g)!.length, 'one call in App').toBe(1)
  })
})
