// rc.14 review F3 (aicc_planning#47): the process-global ipcMain listeners must
// be registered once per process, never once per window.
//
// On macOS the app outlives its last window; the dock click calls
// createWindow() again, and Electron THROWS on a second ipcMain.handle() for a
// channel -- which left the reopened window hidden and unloaded, or crashed
// the app through the rethrowing uncaught-exception handler. index.ts cannot
// be imported in a unit test (it boots the app), so this pins the SHAPE of the
// source: createWindow() registers no ipcMain listener itself, every
// ipcMain.handle/on lives in registerMainWindowIpc(), and that function is
// guarded by the once-flag before it does anything.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const lines = src.split('\n')
const lineOf = (needle: string) => {
  const i = lines.findIndex((l) => l === needle)
  if (i < 0) throw new Error(`anchor not found: ${needle}`)
  return i
}
/** Body of a top-level function: from its header to the next column-0 `}`. */
function bodyOf(header: string): string {
  const start = lineOf(header)
  const end = lines.findIndex((l, n) => n > start && l === '}')
  if (end < 0) throw new Error(`no end for ${header}`)
  return lines.slice(start + 1, end).join('\n')
}

describe('window IPC is registered once per process', () => {
  it('createWindow() registers no ipcMain listener of its own', () => {
    const body = bodyOf('function createWindow(): void {')
    expect(body).not.toMatch(/ipcMain\.(handle|on)\(/)
    // ...but it does make sure the once-registration has run.
    expect(body).toContain('registerMainWindowIpc()')
  })

  it('registerMainWindowIpc() is guarded by the once-flag before its first registration', () => {
    const body = bodyOf('function registerMainWindowIpc(): void {')
    const guard = body.indexOf('if (windowIpcRegistered) return')
    const set = body.indexOf('windowIpcRegistered = true')
    const first = body.search(/ipcMain\.(handle|on)\(/)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(set).toBeGreaterThan(guard)
    expect(first).toBeGreaterThan(set)
    // The registrations the dock-reopen crash was first seen on are in here.
    for (const ch of ["'window:isMaximized'", "'window:allowClose'", "'window:cancelClose'", "'session:save'", "'cli:check'", "'help:workspace'"]) {
      expect(body).toContain(`ipcMain.${ch === "'window:allowClose'" || ch === "'window:cancelClose'" ? 'on' : 'handle'}(${ch}`)
    }
  })

  it('the close-dialog state no longer lives in a createWindow() closure', () => {
    const body = bodyOf('function createWindow(): void {')
    expect(body).not.toMatch(/let allowClose|let closeRequestedOnce/)
    expect(body).toContain('closeCoordinator.onWindowClose(')
  })

  it('before-quit goes through the coordinator (F2), with the teardown assigned, not inlined', () => {
    expect(src).toContain("app.on('before-quit', (e) => closeCoordinator.onBeforeQuit(() => e.preventDefault()))")
    expect(src).toContain('quitTeardown = () => {')
    expect(src).not.toMatch(/app\.on\('before-quit', \(\) => \{/)
  })
})

// Wiring in index.ts that a unit test cannot execute (the module boots the app)
// but which the adversarial pass on #598 found unpinned: each is a one-line call
// a refactor could drop with no test going red.
describe('index.ts wiring pinned by shape', () => {
  it('a (re)created window resets the close decision (rc.14 review F3)', () => {
    expect(bodyOf('function createWindow(): void {')).toContain('closeCoordinator.onWindowCreated()')
  })

  it('a renderer that dies releases any close or quit held on it (render-process-gone -> onRendererGone)', () => {
    const body = bodyOf('function createWindow(): void {')
    const gone = body.indexOf("webContents.on('render-process-gone'")
    expect(gone).toBeGreaterThanOrEqual(0)
    const handler = body.slice(gone, body.indexOf('\n  })', gone))
    expect(handler).toContain('closeCoordinator.onRendererGone()')
    // ...but not for a clean exit (a reload or navigation), which is not a death:
    // the next renderer in the same window can still be asked.
    expect(handler).toMatch(/reason !== 'clean-exit'\) closeCoordinator\.onRendererGone\(\)/)
  })

  it('closeWindow never calls close() on a destroyed window', () => {
    expect(src).toContain('closeWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close() }')
  })

  it('the statusline usage sink feeds the open-account figure the usage page reuses (plan P2)', () => {
    expect(src).toContain('setStatuslineUsageSink(recordLiveUsageForSession)')
  })
})
