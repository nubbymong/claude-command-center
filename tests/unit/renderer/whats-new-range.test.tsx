// @vitest-environment jsdom
//
// What's New shows EVERY release the user missed, not just the newest one.
//
// The pure range function is tested in upgrade-flow.test.ts. This pins the
// modal's use of it, and the distinction matters: collapsing the modal back to
// `[changelog[0]]` left the pure tests entirely green, so on their own they
// could not tell whether the component had been wired up at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BUILD_TIME__ = '2026-08-18T00:00:00.000Z'

// A version history with a clear gap to jump: the user last saw 2.0.0 and is
// now on 2.1.0-beta.14, with two releases in between.
vi.mock('../../../src/renderer/changelog', () => ({
  changelog: [
    { version: '2.1.0-beta.14', date: '2026-08-18', changes: [{ type: 'feature', description: 'Newest thing' }] },
    { version: '2.1.0-beta.13', date: '2026-08-17', changes: [{ type: 'fix', description: 'Middle thing' }] },
    { version: '2.1.0-beta.1', date: '2026-07-17', changes: [{ type: 'feature', description: 'Older thing' }] },
    { version: '2.0.0', date: '2026-07-02', changes: [{ type: 'feature', description: 'Ancient thing' }] },
  ],
}))

const metaState: any = { meta: { lastSeenVersion: '2.0.0' } }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const settingsState: any = { settings: { updateChannel: 'beta' } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { default: WhatsNewModal } = await import('../../../src/renderer/components/WhatsNewModal')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(props: { showAllVersions?: boolean } = {}) {
  act(() => {
    root.render(createElement(WhatsNewModal, { onClose: () => {}, ...props }))
  })
  return container.textContent ?? ''
}

describe('WhatsNewModal covers the whole gap', () => {
  it('lists every release since the one last seen', () => {
    metaState.meta = { lastSeenVersion: '2.0.0' }
    const text = render()
    expect(text).toContain('Newest thing')
    expect(text).toContain('Middle thing')
    expect(text).toContain('Older thing')
  })

  it('excludes the release the user had already seen', () => {
    metaState.meta = { lastSeenVersion: '2.0.0' }
    expect(render()).not.toContain('Ancient thing')
  })

  it('shows just the newest entry when only one release was missed', () => {
    metaState.meta = { lastSeenVersion: '2.1.0-beta.13' }
    const text = render()
    expect(text).toContain('Newest thing')
    expect(text).not.toContain('Middle thing')
  })

  it('falls back to the newest entry rather than rendering blank', () => {
    // A first install has no range at all; the modal must never be empty.
    metaState.meta = {}
    expect(render()).toContain('Newest thing')
  })

  it('still shows everything when asked for the full history', () => {
    metaState.meta = { lastSeenVersion: '2.1.0-beta.13' }
    expect(render({ showAllVersions: true })).toContain('Ancient thing')
  })
})
