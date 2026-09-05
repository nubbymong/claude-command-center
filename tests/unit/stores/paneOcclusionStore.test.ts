// The one answer to "may a native pane paint right now?" -- a page tab on top,
// or any window-level overlay mounted, means no. Pure store; the pane and the
// overlays are exercised in the renderer suites.
import { describe, it, expect, beforeEach } from 'vitest'
import { usePaneOcclusionStore, isNativePaneOccluded } from '../../../src/renderer/stores/paneOcclusionStore'
import type { ViewType } from '../../../src/renderer/types/views'

const store = usePaneOcclusionStore
const occluded = () => isNativePaneOccluded(store.getState())

beforeEach(() => { store.setState({ activeView: 'sessions', overlays: 0 }) })

describe('paneOcclusionStore', () => {
  it('a session tab with nothing on top: the pane may paint', () => {
    expect(occluded()).toBe(false)
  })

  it('EVERY page tab occludes -- Settings, Tokenomics, the Feature Guide, all of them', () => {
    const pages: ViewType[] = ['cloud-agents', 'logs', 'settings', 'insights', 'tokenomics', 'vision', 'memory', 'account-usage', 'help']
    for (const v of pages) {
      store.getState().setActiveView(v)
      expect(occluded(), v).toBe(true)
    }
    store.getState().setActiveView('sessions')
    expect(occluded()).toBe(false)
  })

  it('an overlay occludes for exactly as long as it is held, and releases once', () => {
    const release = store.getState().acquireOverlay()
    expect(store.getState().overlays).toBe(1)
    expect(occluded()).toBe(true)
    release()
    expect(store.getState().overlays).toBe(0)
    expect(occluded()).toBe(false)
    // A double release (an effect cleanup that ran twice) must not go negative
    // and must not un-occlude someone else's overlay.
    release()
    expect(store.getState().overlays).toBe(0)
  })

  it('overlays nest: a dialog over a dialog keeps the pane hidden until the last one goes', () => {
    const a = store.getState().acquireOverlay()
    const b = store.getState().acquireOverlay()
    expect(store.getState().overlays).toBe(2)
    a()
    expect(occluded()).toBe(true)
    b()
    expect(occluded()).toBe(false)
  })

  it('a page tab AND an overlay: still occluded after the overlay goes, until the tab does', () => {
    store.getState().setActiveView('settings')
    const release = store.getState().acquireOverlay()
    release()
    expect(occluded()).toBe(true)
    store.getState().setActiveView('sessions')
    expect(occluded()).toBe(false)
  })
})
