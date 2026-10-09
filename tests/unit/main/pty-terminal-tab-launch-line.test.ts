// A terminal tab types a session's launch line only into a sh-family shell.
//
// Off Windows a terminal tab (a shell-only session) runs the user's own login
// shell. Its folder line is typed only into a sh-family shell (sh, bash, zsh,
// dash, ksh), classified the way Alt+V classifies it (localSessionShell). Any
// other shell gets no line and starts in the folder, the PTY's own working
// folder. The user's own first-run command is still typed. The real spawnPty;
// node-pty records.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  shell: '/bin/bash',
  spawns: [] as Array<{ file: string; cwd: string }>,
  writes: [] as string[],
}))

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => 'linux' as NodeJS.Platform, default: { ...real, platform: () => 'linux' as NodeJS.Platform } }
})
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP },
}))
vi.mock('node-pty', () => ({ spawn: (file: string, _args: unknown, opts: { cwd: string }) => {
  h.spawns.push({ file, cwd: opts.cwd })
  return { pid: 4646, cols: 80, rows: 24, process: file,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
} }))
// The tab's shell, as the spawn and Alt+V both name it.
vi.mock('../../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/login-shell')>()),
  localSessionShell: () => h.shell,
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
let folder = ''
let seq = 0
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  SID = `tabline${String(++seq).padStart(17, '0')}`
  folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tab-line-')))
  h.spawns = []
  h.writes = []
  registerFakeClaudePackage({ id: 'claude', displayName: 'Claude', resolveBinary: () => null,
    buildSpawnCommand: () => ({ cmd: h.shell, args: ['-l'], env: {} }), detectUiRunning: () => false,
    ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
    getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '' } as never)
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  vi.useRealTimers()
  fs.rmSync(folder, { recursive: true, force: true })
})

const openTab = (terminalOptions?: { command: string }): void => {
  spawnPty(win, SID, { shellOnly: true, cwd: folder, ...(terminalOptions ? { terminalOptions } : {}) } as never)
  vi.advanceTimersByTime(400)
}

describe('a terminal tab in a shell outside the sh family', () => {
  for (const shell of ['/usr/bin/fish', '/usr/local/bin/pwsh', '/usr/bin/nu']) {
    // Mutation to prove this can fail: type the cd line whatever the shell.
    it(`${path.posix.basename(shell)}: no launch line is typed; the tab still starts in the folder`, () => {
      h.shell = shell
      openTab()
      expect(h.spawns[0].cwd).toBe(folder)
      expect(h.writes.filter((w) => w.includes('cd ') || w.includes('clear'))).toEqual([])
    })
  }

  it('the user\'s own first-run command is still typed', () => {
    h.shell = '/usr/bin/fish'
    openTab({ command: 'htop' })
    expect(h.writes).toEqual(['htop\r'])
  })
})

describe('a terminal tab in a sh-family shell is unchanged', () => {
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/ksh']) {
    it(`${path.posix.basename(shell)}: the same cd line as before`, () => {
      h.shell = shell
      openTab({ command: 'htop' })
      expect(h.writes).toEqual([`cd '${folder}' 2>/dev/null; clear\r`, 'htop\r'])
    })
  }
})
