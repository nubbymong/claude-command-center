/**
 * window-close-coordinator.ts -- ONE state machine for "may the app go away?"
 *
 * Two doors lead out of the app and they used to disagree (rc.14 review F2,
 * aicc_planning#46):
 *
 *  - Closing the WINDOW: the `close` event is prevented, the renderer is asked
 *    (`window:closeRequested`), and the window closes only after
 *    `window:allowClose`. On Windows the quit then follows the close
 *    (`window-all-closed` -> app.quit()), so the teardown in `before-quit` runs
 *    AFTER the user's decision. Correct.
 *  - QUITTING on macOS (Cmd+Q, the app menu): Electron emits `before-quit`
 *    BEFORE it closes any window, so the teardown -- hooks, logging, watchdog,
 *    MCP, agents, every PTY, the panes -- ran first, and only then did the
 *    window's close handler put up the dialog. Cancel reset a flag over an app
 *    that had already killed the work it was offering to save.
 *
 * The coordinator makes both doors go through the same decision: while a live
 * window exists and the renderer has not allowed the close, a quit is held
 * (preventDefault) and the renderer is asked exactly as for a close; when the
 * renderer allows it, the window closes and, if the exit began as a quit, the
 * quit is re-issued -- this time with no window to ask, so the teardown runs.
 * Cancel restores nothing because nothing was taken down.
 *
 * It also owns the close-dialog state that used to live in `createWindow()`'s
 * closure (`allowClose`, `closeRequestedOnce`): the IPC listeners that read it
 * are registered once per process (rc.14 review F3), so the state must outlive
 * any one window too.
 *
 * Pure: Electron reaches it only through `deps`, so every transition is unit-
 * tested without an app. No default export (project convention).
 */

export interface CloseCoordinatorDeps {
  /** A live (not destroyed) main window exists right now. */
  hasWindow: () => boolean
  /** Send `window:closeRequested` to the renderer (it shows the save/cancel dialog). */
  askRenderer: () => void
  /** `mainWindow.close()` -- fires the window's `close` event again, now allowed. */
  closeWindow: () => void
  /** `app.quit()` -- re-enters `before-quit`, now with no window to ask. */
  quit: () => void
  /** The real shutdown: flush sessions, stop services, kill PTYs. Runs at most once. */
  teardown: () => void
}

export interface CloseCoordinator {
  /** The window's `close` event. `preventDefault` is the event's. */
  onWindowClose: (preventDefault: () => void) => void
  /** The app's `before-quit` event. */
  onBeforeQuit: (preventDefault: () => void) => void
  /** Renderer: sessions saved (or discarded) -- the window may go. */
  onAllowClose: () => void
  /** Renderer: the user cancelled the close dialog. */
  onCancelClose: () => void
  /**
   * A main window was (re)created: first launch, or a macOS dock reopen after
   * the last window closed. The per-window decision starts over -- a window
   * closed with Save left `allowClose` set, and without this reset the next
   * window would close (or quit) without ever asking.
   */
  onWindowCreated: () => void
  /** Test seam / diagnostics. */
  state: () => { allowClose: boolean; closeRequestedOnce: boolean; quitRequested: boolean; tornDown: boolean }
}

export function createCloseCoordinator(deps: CloseCoordinatorDeps): CloseCoordinator {
  let allowClose = false
  let closeRequestedOnce = false
  let quitRequested = false
  let tornDown = false

  const ask = () => {
    // A second attempt while the dialog is already up asks nothing again.
    if (closeRequestedOnce) return
    closeRequestedOnce = true
    deps.askRenderer()
  }

  return {
    onWindowClose(preventDefault) {
      if (allowClose) return // the renderer already decided: let it close
      // Second close attempt while a request is outstanding (an NSIS installer
      // retry, a second Alt+F4): allow immediately, as before. Nothing has been
      // torn down, so this is the user overriding their own dialog, not data loss.
      if (closeRequestedOnce) return
      preventDefault()
      ask()
    },

    onBeforeQuit(preventDefault) {
      if (deps.hasWindow() && !allowClose) {
        // macOS Cmd+Q / menu Quit (or any app.quit() with the window still up):
        // hold the quit, ask the renderer, and remember to quit once allowed.
        quitRequested = true
        preventDefault()
        ask()
        return
      }
      if (tornDown) return // a second before-quit after the real one: nothing left to do
      tornDown = true
      deps.teardown()
    },

    onAllowClose() {
      allowClose = true
      deps.closeWindow()
      // The exit began as a quit: now that the window is going, quit for real.
      // Re-entering before-quit finds no live window (or allowClose set) and
      // runs the teardown. On Windows window-all-closed would quit anyway;
      // calling it here is idempotent and makes macOS behave the same.
      if (quitRequested) deps.quit()
    },

    onCancelClose() {
      closeRequestedOnce = false
      quitRequested = false
    },

    onWindowCreated() {
      // `tornDown` deliberately survives: a teardown that already ran is not
      // undone by a window appearing, and a second quit must still not re-run it.
      allowClose = false
      closeRequestedOnce = false
      quitRequested = false
    },

    state: () => ({ allowClose, closeRequestedOnce, quitRequested, tornDown }),
  }
}
