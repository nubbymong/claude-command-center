// @vitest-environment jsdom
/**
 * Settings > Check for Updates (#142).
 *
 * The field used to be a dead end: finding an update only printed "Update
 * available" and left the user to hunt for the bottom-bar Update pill. The
 * primary button now BECOMES "Install now", and it routes through App's
 * onUpdateRequested so an install with sessions open goes via the 'update'
 * close dialog (session state saved first) rather than restarting on top of
 * them. installAndRestart() is only the no-prop fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// __APP_VERSION__ is an esbuild `define` global at build time; stub it for the
// jsdom render (CheckForUpdatesField now shows the installed version + channel,
// #250), mirroring bottom-bar.test.ts.
;(globalThis as any).__APP_VERSION__ = '9.9.9-test'

const { CheckForUpdatesField } = await import('../../../src/renderer/components/SettingsPage')

function renderComponent(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

const buttonByText = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Stub the update IPC surface the field touches. */
function stubUpdateApi(opts: { available: boolean; version?: string }) {
  const installAndRestart = vi.fn().mockResolvedValue(true)
  ;(globalThis as any).window.electronAPI = {
    update: {
      check: vi.fn().mockResolvedValue(opts.available),
      getVersion: vi.fn().mockResolvedValue(opts.version ?? '9.9.9'),
      installAndRestart,
    },
  }
  return { installAndRestart }
}

describe('Settings > Check for Updates (#142)', () => {
  let cleanup: (() => void) | null = null
  beforeEach(() => { cleanup = null })
  afterEach(() => {
    cleanup?.()
    delete (globalThis as any).window.electronAPI
  })

  it('starts as "Check now" with no install action', () => {
    stubUpdateApi({ available: false })
    const { container, unmount } = renderComponent(<CheckForUpdatesField />)
    cleanup = unmount
    expect(buttonByText(container, 'Check now')).toBeTruthy()
    expect(buttonByText(container, 'Install now')).toBeUndefined()
  })

  it('when an update is found, the button becomes "Install now" and shows the version', async () => {
    stubUpdateApi({ available: true, version: '2.1.0-beta.2' })
    const { container, unmount } = renderComponent(<CheckForUpdatesField />)
    cleanup = unmount

    await click(buttonByText(container, 'Check now')!)

    expect(buttonByText(container, 'Install now')).toBeTruthy()
    expect(buttonByText(container, 'Check now')).toBeUndefined()
    expect(container.textContent).toContain('2.1.0-beta.2')
    // #250: update-available state also surfaces the installed version + channel.
    expect(container.textContent).toContain('v9.9.9-test (stable)')
  })

  it('stays on "Check now" and reports up to date when there is no update', async () => {
    stubUpdateApi({ available: false })
    const { container, unmount } = renderComponent(<CheckForUpdatesField />)
    cleanup = unmount

    await click(buttonByText(container, 'Check now')!)

    expect(buttonByText(container, 'Install now')).toBeUndefined()
    expect(container.textContent).toContain('Up to date')
    // #250: up-to-date state also surfaces the installed version + channel.
    expect(container.textContent).toContain('v9.9.9-test (stable)')
  })

  it('Install now calls onUpdateRequested (App saves sessions) and NOT installAndRestart', async () => {
    const { installAndRestart } = stubUpdateApi({ available: true })
    const onUpdateRequested = vi.fn()
    const { container, unmount } = renderComponent(
      <CheckForUpdatesField onUpdateRequested={onUpdateRequested} />,
    )
    cleanup = unmount

    await click(buttonByText(container, 'Check now')!)
    await click(buttonByText(container, 'Install now')!)

    expect(onUpdateRequested).toHaveBeenCalledTimes(1)
    // Critical: bypassing App would restart with live sessions unsaved.
    expect(installAndRestart).not.toHaveBeenCalled()
  })

  it('falls back to installAndRestart when no handler is supplied', async () => {
    const { installAndRestart } = stubUpdateApi({ available: true })
    const { container, unmount } = renderComponent(<CheckForUpdatesField />)
    cleanup = unmount

    await click(buttonByText(container, 'Check now')!)
    await click(buttonByText(container, 'Install now')!)

    expect(installAndRestart).toHaveBeenCalledTimes(1)
  })

  it('ignores repeat clicks while installing', async () => {
    const onUpdateRequested = vi.fn()
    stubUpdateApi({ available: true })
    const { container, unmount } = renderComponent(
      <CheckForUpdatesField onUpdateRequested={onUpdateRequested} />,
    )
    cleanup = unmount

    await click(buttonByText(container, 'Check now')!)
    const install = buttonByText(container, 'Install now')!
    await click(install)
    await click(install)

    expect(onUpdateRequested).toHaveBeenCalledTimes(1)
  })
})
