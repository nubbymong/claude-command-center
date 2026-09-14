// @vitest-environment jsdom
/**
 * The config-load-failed notice must say WHY: which files failed, in the
 * words the lock was set with. Before this it rendered static copy and the
 * file names lived only in console.error -- so a user with a locked
 * settings.json read "your configuration could not be loaded" with nothing
 * nameable to fix. (Re-attack round, beta.16 ADR-009 pass.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ConfigLoadFailedNotice from '../../../src/renderer/components/ConfigLoadFailedNotice'
import { useConfigWriteLockStore } from '../../../src/renderer/stores/configWriteLockStore'
import { readFailureLockReason } from '../../../src/renderer/utils/configHydration'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useConfigWriteLockStore.getState().unlock()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const mount = async () => {
  await act(async () => { root.render(createElement(ConfigLoadFailedNotice)) })
  await act(async () => { await Promise.resolve() })
}

describe('ConfigLoadFailedNotice', () => {
  it('renders nothing while writes are not locked', async () => {
    await mount()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders the lock reason verbatim, naming the failed files', async () => {
    const reason = readFailureLockReason({ readFailed: false, failedKeys: ['settings', 'commands'] })!
    expect(reason).toContain('settings, commands')
    act(() => { useConfigWriteLockStore.getState().lock(reason) })
    await mount()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    const el = container.querySelector('[data-ux-id="config-load-failed-reason"]')
    expect(el?.textContent).toBe(reason)
  })
})
