// rc.14 review F2 (aicc_planning#46): Quit then Cancel must leave the app whole.
//
// On macOS `before-quit` fires BEFORE the window's `close` event, so the old
// before-quit handler tore everything down (PTYs, MCP, logging, watchdog) and
// only then did the close handler show the save/cancel dialog. These tests
// drive the coordinator through Electron's documented event order for both
// doors -- window close (Windows, title bar) and app quit (macOS Cmd+Q) -- and
// pin that the teardown runs exactly once, only after the renderer allowed it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCloseCoordinator, type CloseCoordinatorDeps } from '../../../src/main/window-close-coordinator'

let windowAlive: boolean
let deps: { [K in keyof CloseCoordinatorDeps]: ReturnType<typeof vi.fn> }
let prevented: number

function make() {
  windowAlive = true
  prevented = 0
  deps = {
    hasWindow: vi.fn(() => windowAlive),
    askRenderer: vi.fn(),
    closeWindow: vi.fn(() => { windowAlive = false }),
    quit: vi.fn(),
    teardown: vi.fn(),
  }
  return createCloseCoordinator(deps)
}
const preventDefault = () => { prevented++ }

beforeEach(() => { make() })

describe('macOS quit (before-quit arrives before any close)', () => {
  it('REGRESSION: Cmd+Q asks the renderer and tears NOTHING down until it allows', () => {
    const c = make()
    c.onBeforeQuit(preventDefault)
    expect(prevented).toBe(1)
    expect(deps.askRenderer).toHaveBeenCalledTimes(1)
    expect(deps.teardown).not.toHaveBeenCalled()
    expect(c.state().quitRequested).toBe(true)
  })

  it('Cmd+Q then Cancel: no teardown, no close, and a later Cmd+Q asks again', () => {
    const c = make()
    c.onBeforeQuit(preventDefault)
    c.onCancelClose()
    expect(deps.teardown).not.toHaveBeenCalled()
    expect(deps.closeWindow).not.toHaveBeenCalled()
    expect(c.state()).toMatchObject({ quitRequested: false, closeRequestedOnce: false })
    c.onBeforeQuit(preventDefault)
    expect(deps.askRenderer).toHaveBeenCalledTimes(2)
    expect(deps.teardown).not.toHaveBeenCalled()
  })

  it('Cmd+Q then Save: window closes, quit is re-issued, and the SECOND before-quit tears down once', () => {
    const c = make()
    c.onBeforeQuit(preventDefault)
    c.onAllowClose()
    expect(deps.closeWindow).toHaveBeenCalledTimes(1)
    expect(deps.quit).toHaveBeenCalledTimes(1)
    // Electron: the re-issued quit -> before-quit again; the window is gone now.
    c.onBeforeQuit(preventDefault)
    expect(prevented).toBe(1) // only the first one was held
    expect(deps.teardown).toHaveBeenCalledTimes(1)
    // A stray extra before-quit never runs the teardown twice.
    c.onBeforeQuit(preventDefault)
    expect(deps.teardown).toHaveBeenCalledTimes(1)
  })

  it('the close event fired by the allowed close does not re-ask', () => {
    const c = make()
    c.onBeforeQuit(preventDefault)
    c.onAllowClose()
    c.onWindowClose(preventDefault) // mainWindow.close() -> 'close' event
    expect(prevented).toBe(1)
    expect(deps.askRenderer).toHaveBeenCalledTimes(1)
  })

  it('with no window (closed to the dock earlier), a quit tears down immediately', () => {
    const c = make()
    windowAlive = false
    c.onBeforeQuit(preventDefault)
    expect(prevented).toBe(0)
    expect(deps.askRenderer).not.toHaveBeenCalled()
    expect(deps.teardown).toHaveBeenCalledTimes(1)
  })
})

describe('window close (Windows title bar; also macOS red button)', () => {
  it('first close is held and asks the renderer; Cancel leaves the window and services alone', () => {
    const c = make()
    c.onWindowClose(preventDefault)
    expect(prevented).toBe(1)
    expect(deps.askRenderer).toHaveBeenCalledTimes(1)
    c.onCancelClose()
    expect(deps.teardown).not.toHaveBeenCalled()
    expect(deps.closeWindow).not.toHaveBeenCalled()
  })

  it('Save: the window closes; the quit that follows (window-all-closed on Windows) tears down once', () => {
    const c = make()
    c.onWindowClose(preventDefault)
    c.onAllowClose()
    expect(deps.closeWindow).toHaveBeenCalledTimes(1)
    expect(deps.quit).not.toHaveBeenCalled() // a plain close never forces a quit (macOS stays in the dock)
    c.onWindowClose(preventDefault) // the allowed close's own event
    expect(prevented).toBe(1)
    c.onBeforeQuit(preventDefault) // Windows: window-all-closed -> app.quit()
    expect(deps.teardown).toHaveBeenCalledTimes(1)
  })

  it('a second close attempt while the dialog is up closes immediately (installer retry), nothing torn down first', () => {
    const c = make()
    c.onWindowClose(preventDefault)
    c.onWindowClose(preventDefault)
    expect(prevented).toBe(1) // the second attempt is not held
    expect(deps.askRenderer).toHaveBeenCalledTimes(1)
    expect(deps.teardown).not.toHaveBeenCalled()
  })

  it('a quit arriving while the close dialog is already up joins it instead of asking twice', () => {
    const c = make()
    c.onWindowClose(preventDefault)
    c.onBeforeQuit(preventDefault)
    expect(deps.askRenderer).toHaveBeenCalledTimes(1)
    expect(c.state().quitRequested).toBe(true)
    c.onAllowClose()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
})

// The coordinator lives for the whole process while windows come and go. A
// window closed with Save leaves `allowClose` set; on macOS the app stays in
// the dock and a click creates a NEW window, which must be asked again.
describe('a second window in the same process (macOS dock reopen)', () => {
  it('after Save-close of the first window, the reopened window is asked again on close and on Cmd+Q', () => {
    const c = make()
    c.onWindowClose(preventDefault)
    c.onAllowClose() // Save: window 1 closes; darwin keeps the app alive
    expect(c.state().allowClose).toBe(true)

    windowAlive = true // dock click -> createWindow()
    c.onWindowCreated()
    expect(c.state()).toMatchObject({ allowClose: false, closeRequestedOnce: false, quitRequested: false })

    c.onWindowClose(preventDefault)
    expect(prevented).toBe(2)
    expect(deps.askRenderer).toHaveBeenCalledTimes(2)
    c.onCancelClose()

    c.onBeforeQuit(preventDefault)
    expect(prevented).toBe(3)
    expect(deps.askRenderer).toHaveBeenCalledTimes(3)
    expect(deps.teardown).not.toHaveBeenCalled()
  })

  it('a window created after the teardown ran never re-runs it', () => {
    const c = make()
    windowAlive = false
    c.onBeforeQuit(preventDefault) // real quit: teardown
    expect(deps.teardown).toHaveBeenCalledTimes(1)
    windowAlive = true
    c.onWindowCreated()
    windowAlive = false
    c.onBeforeQuit(preventDefault)
    expect(deps.teardown).toHaveBeenCalledTimes(1)
  })
})
