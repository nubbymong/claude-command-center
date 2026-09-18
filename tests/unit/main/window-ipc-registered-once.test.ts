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
    // Delegated registrations (registerFooHandlers()) are process-global too --
    // the inline-ipcMain regex above cannot see them, and a second call from a
    // macOS dock-reopen throws exactly the same way (adversarial pass, 2.1.1).
    // Any REFERENCE, not only a call: `setTimeout(registerCliHandlers, 0)` and
    // `const reg = registerCliHandlers; reg()` survive a call-shaped regex
    // (re-attack, 2.1.1).
    expect(body).not.toMatch(/\bregister[A-Z]\w*Handlers?\b/)
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
    // Delegated register calls must ALSO sit after the once-flag is set, not
    // just be present somewhere in the body.
    // EVERY delegated register call in the block, not a whitelist of two: a
    // third one hoisted above the guard stayed green under the old list
    // (re-attack, 2.1.1). Any arity: registerFoo(getWindow) counts too
    // (code-quality review, 2.1.1).
    const delegated = [...body.matchAll(/\bregister[A-Z]\w*Handlers?\(/g)]
    expect(delegated.length).toBeGreaterThanOrEqual(3)
    for (const m of delegated) {
      expect(m.index, `${m[0]} must follow the once-flag`).toBeGreaterThan(set)
    }
    // The registrations the dock-reopen crash was first seen on are in here
    // (inline or via delegated registerFoo calls that run inside this block).
    for (const [method, literal, constant] of [
      ['handle', 'window:isMaximized', 'WINDOW_IS_MAXIMIZED'],
      ['on', 'window:allowClose', 'WINDOW_ALLOW_CLOSE'],
      ['on', 'window:cancelClose', 'WINDOW_CANCEL_CLOSE'],
      ['handle', 'session:save', 'SESSION_SAVE'],
    ] as const) {
      // Either spelling: the literal as written today, or the IPC.* constant
      // ADR-021 asks new code to use -- a migration must not turn this red.
      expect(body).toMatch(new RegExp(`ipcMain\\.${method}\\((?:'${literal}'|IPC\\.${constant}\\b)`))
    }
    // CLI + clipboard handlers are delegated to their own register functions
    // called from within this once-guarded block.
    expect(body).toContain('registerCliHandlers()')
    expect(body).toContain('registerClipboardHandlers()')
  })

  it("app.on('activate') / app.on('second-instance') only re-create or refocus the window: no registration on a re-entry path", () => {
    // The macOS dock click and the Windows second launch are the very paths
    // the once-guard exists for; a register*() call in EITHER listener (and an
    // event may have more than one listener) re-registers on every re-entry,
    // and until now no test looked (re-attack rounds 1-2, 2.1.1).
    const listenerBody = (from: number): string => {
      const lineStart = src.lastIndexOf('\n', from) + 1
      const indent = src.slice(lineStart, from)
      expect(indent.trim(), 'listener starts its line').toBe('')
      const end = src.indexOf(`\n${indent}})`, from)
      expect(end, 'listener end').toBeGreaterThan(from)
      return src.slice(from, end)
    }
    for (const ev of ['activate', 'second-instance']) {
      let seen = 0
      for (const m of src.matchAll(new RegExp(`app\\.on\\('${ev}'`, 'g'))) {
        seen++
        expect(listenerBody(m.index!), `${ev} listener at ${m.index}`).not.toMatch(/\bregister[A-Z]\w*Handlers?\b|ipcMain\.(handle|on)\(/)
      }
      expect(seen, `an app.on('${ev}') listener exists`).toBeGreaterThanOrEqual(1)
    }
    // Backstops: each slice must still contain the listener's real work, so a
    // string literal that mimics the closing shape cannot truncate it early.
    expect(listenerBody(src.indexOf("app.on('activate'"))).toContain('createWindow()')
    expect(listenerBody(src.indexOf("app.on('second-instance'"))).toContain('mainWindow')
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

  it('the logs-wipe registration keeps its slot right after registerResumeHandlers, ahead of initLogging (F2)', () => {
    // Folding it into registerLogs2Handlers once moved it behind ~20 unguarded
    // register*() calls; the fix restored the slot, and this pins it, because
    // a comment is not a guard (re-attack, 2.1.1).
    const at = (needle: string) => {
      const i = src.indexOf(needle)
      expect(i, `anchor: ${needle}`).toBeGreaterThanOrEqual(0)
      return i
    }
    const resume = at('    registerResumeHandlers()')
    const wipe = at('    registerLogsWipeHandlers()')
    // Whole lines: a statement appended after either call on the same line
    // would sit between them without being "in the gap" (re-attack round 2).
    for (const i of [resume, wipe]) {
      expect(src.slice(i, src.indexOf('\n', i)).trim()).toMatch(/^register(Resume|LogsWipe)Handlers\(\)$/)
    }
    expect(wipe).toBeGreaterThan(resume)
    expect(wipe).toBeLessThan(at('    registerDebugHandlers()'))
    expect(wipe).toBeLessThan(at('    registerLogs2Handlers(getWindow)'))
    expect(wipe).toBeLessThan(at('initLogging({'))
    // ...and nothing that can throw may be inserted into the gap.
    const gap = src.slice(resume, wipe).split('\n').slice(1)
    expect(gap.every((l) => !l.trim() || l.trim().startsWith('//'))).toBe(true)
  })
})

// Final adversarial pass on 2.1.1: four mutants of the boot wiring stayed green
// under the tests above. Each case here is one of them.
describe('index.ts boot wiring -- mutants of the once-flag and the wipe slot', () => {
  it('the once-flag is declared exactly once, at module scope, and written only inside registerMainWindowIpc()', () => {
    // M7: re-declaring it inside the registrar (with or without an initialiser)
    // makes every call see a fresh `false`/undefined. ONE declaration, at
    // column 0.
    const decls = [...src.matchAll(/\b(?:let|const|var)\s+windowIpcRegistered\b/g)]
    expect(decls).toHaveLength(1)
    expect(src.slice(src.lastIndexOf('\n', decls[0].index!) + 1, decls[0].index!)).toBe('')
    expect(src.slice(decls[0].index!)).toMatch(/^let windowIpcRegistered(?::\s*boolean)? = false$/m)
    // M1: a reset in createWindow() (or anywhere else) re-arms the registrar on
    // the next dock-reopen. The ONLY writes are the declaration and the `= true`
    // inside the registrar. (A `: boolean` annotation on the declaration is
    // tolerated here as above -- re-attack, 2.1.1.)
    const writes = [...src.matchAll(/\bwindowIpcRegistered\s*(?::\s*boolean)?\s*=\s*(?:true|false)\b/g)].map((m) => m.index!)
    expect(writes).toHaveLength(2)
    const header = 'function registerMainWindowIpc(): void {'
    const registrarStart = src.indexOf(header)
    const registrarEnd = src.indexOf('\n}', registrarStart)
    expect(registrarStart).toBeGreaterThanOrEqual(0)
    expect(writes[1]).toBeGreaterThan(registrarStart)
    expect(writes[1]).toBeLessThan(registrarEnd)
    // Code only: a comment in createWindow() that NAMES the flag is not a reset
    // (re-attack, 2.1.1).
    const createWindowCode = bodyOf('function createWindow(): void {')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    expect(createWindowCode).not.toContain('windowIpcRegistered')
  })

  it('registerResumeHandlers()/registerLogsWipeHandlers() sit directly in the ready callback, not inside a try block', () => {
    // M2: one shared try/catch around the pair would swallow a throw in the
    // resume registration and silently skip the first-run wipe prompt AND the
    // boot-failure dialog. The pair is at the callback's own indentation (four
    // spaces, a whole line each), and the line before the first is not a try
    // opener.
    for (const call of ['registerResumeHandlers()', 'registerLogsWipeHandlers()']) {
      expect(src, call).toMatch(new RegExp(`\\n    ${call.replace(/[()]/g, '\\$&')}\\n`))
    }
    const resume = src.indexOf('\n    registerResumeHandlers()\n')
    const prevLine = src.slice(src.lastIndexOf('\n', resume - 1) + 1, resume)
    expect(prevLine).not.toMatch(/\btry\b\s*\{?\s*$/)
  })
})
