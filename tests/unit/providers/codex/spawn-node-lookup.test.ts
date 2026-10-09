// The node the Codex resume picker runs on, on Windows
// (src/main/providers/codex/spawn.ts resolveNodeExe): found in PATH's fully
// qualified folders, in PATH's order, read in this process with no shell and
// no process started; a relative PATH entry, and so the current folder, is
// never searched; a folder that does not answer is asked nothing more in that
// lookup; nothing found leaves bare `node`, so the launch fails visibly.
// Synthetic environments only (never this process's own); the disk is
// answered by an injected stat, or by a stubbed statSync on the picker route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'

const started: string[] = []
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn((cmd: unknown) => {
      started.push(String(cmd))
      throw new Error('no process is started to find node')
    }),
  }
})
// The disk, on the picker route: one file answers as node.exe, everything
// else as the real disk answers (a Windows path is not there on CI).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: vi.fn((p: unknown, o?: unknown) => {
      if (p === (globalThis as any).__nodeLookupFile) return { isFile: () => true } as import('fs').Stats
      return (actual.statSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
  }
})
// What the os module reports, forced per case; every other answer is the
// real one.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => (globalThis as any).__osPlatform ?? actual.platform()) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => (globalThis as any).__nodeLookupResDir ?? '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { resolveNodeExe, __resetNodeExeCache, buildCodexSpawn } = await import('../../../../src/main/providers/codex/spawn')
type Stat = 'file' | 'none' | 'unreachable'

/** A stat that records every path it is asked and answers from `files`
 *  ('file') and `down` (a folder that does not answer). */
function disk(files: string[], down: string[] = []): { asked: string[]; statFile: (p: string) => Stat } {
  const asked: string[] = []
  return {
    asked,
    statFile: (p: string) => {
      asked.push(p)
      if (down.some((d) => p.toLowerCase().startsWith(d.toLowerCase() + '\\'))) return 'unreachable'
      return files.includes(p) ? 'file' : 'none'
    },
  }
}

beforeEach(() => {
  started.length = 0
  __resetNodeExeCache()
})
afterEach(() => {
  delete (globalThis as any).__nodeLookupFile
  delete (globalThis as any).__nodeLookupResDir
  delete (globalThis as any).__osPlatform
  __resetNodeExeCache()
})

describe('node for the picker is found in PATH\'s absolute folders without starting a process', () => {
  it('the first fully qualified PATH folder holding node.exe gives it; relative entries are never asked', () => {
    const d = disk(['C:\\second\\node.exe', 'C:\\third\\node.exe'])
    const env = { Path: 'C:\\first;relative\\bin;.;.\\node_modules\\.bin;C:\\second;C:\\third' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('C:\\second\\node.exe')
    expect(d.asked).toEqual(['C:\\first\\node.exe', 'C:\\second\\node.exe'])
    expect(started).toEqual([])
  })

  it('the current folder is never searched: only a PATH folder is ever asked', () => {
    // Only the folders PATH names in full are asked.
    const d = disk(['C:\\project\\node.exe'])
    const env = { PATH: '.;node_modules\\.bin;C:\\tools' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('node')
    expect(d.asked).toEqual(['C:\\tools\\node.exe'])
    expect(started).toEqual([])
  })

  it('a folder that does not answer is asked once, and the walk goes on', () => {
    const d = disk(['C:\\third\\node.exe'], ['C:\\down'])
    const env = { PATH: 'C:\\down;C:\\down;C:\\third' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('C:\\third\\node.exe')
    expect(d.asked.filter((p) => p.startsWith('C:\\down'))).toEqual(['C:\\down\\node.exe'])
    expect(started).toEqual([])
  })

  it('a quoted folder is read without its quotes; a share is read; a device path or a drive-relative entry is not', () => {
    const d = disk(['\\\\srv\\share\\node\\node.exe'])
    const env = { PATH: '\\\\?\\C:\\dev;\\\\.\\pipe\\x;C:rel;"C:\\Program Files\\nodejs";\\\\srv\\share\\node' }
    expect(resolveNodeExe({ platform: 'win32', env, statFile: d.statFile })).toBe('\\\\srv\\share\\node\\node.exe')
    expect(d.asked).toEqual(['C:\\Program Files\\nodejs\\node.exe', '\\\\srv\\share\\node\\node.exe'])
  })

  it('PATH is read by its Windows name in any spelling', () => {
    const d = disk(['C:\\n\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { pAtH: 'C:\\n' }, statFile: d.statFile })).toBe('C:\\n\\node.exe')
  })

  it('no PATH folder holds node.exe: bare node, and still no process started', () => {
    const d = disk([])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a;C:\\b' }, statFile: d.statFile })).toBe('node')
    expect(resolveNodeExe({ platform: 'win32', env: {}, statFile: d.statFile })).toBe('node')
    expect(started).toEqual([])
  })

  it('a found node is kept for later launches under the same PATH, and looked up again under another', () => {
    const first = disk(['C:\\a\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a' }, statFile: first.statFile })).toBe('C:\\a\\node.exe')
    const again = disk([])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\a' }, statFile: again.statFile })).toBe('C:\\a\\node.exe')
    expect(again.asked).toEqual([])
    const other = disk(['C:\\b\\node.exe'])
    expect(resolveNodeExe({ platform: 'win32', env: { PATH: 'C:\\b' }, statFile: other.statFile })).toBe('C:\\b\\node.exe')
    expect(other.asked).toEqual(['C:\\b\\node.exe'])
  })
})

/** The picker launch through the npm launcher with the launch built for
 *  Windows (process.platform 'win32'), the picker deployed in a temp
 *  resources folder that is removed afterwards. */
async function pickerLaunchOnWindows(): Promise<{ cmd: string; script: string; deployedScript: string }> {
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const os = await vi.importActual<typeof import('os')>('os')
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-node-lookup-'))
  try {
    fs.mkdirSync(path.join(res, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(res, 'scripts', 'codex-resume-picker.js'), '// stub')
    ;(globalThis as any).__nodeLookupResDir = res
    ;(globalThis as any).__nodeLookupFile = 'C:\\ccc-test-only\\nodejs\\node.exe'
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let out!: ReturnType<typeof buildCodexSpawn>
    try {
      out = buildCodexSpawn({
        sessionId: 'sid', useResumePicker: true,
        realmLaunch: { executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', env: { SystemRoot: 'C:\\Windows', Path: 'relative;C:\\ccc-test-only\\nodejs', CODEX_HOME: 'C:\\r' }, sessionsDir: 'C:\\r\\sessions' },
        codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' },
      })
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig)
    }
    const pickDir = out.pickFile ? path.dirname(out.pickFile) : null
    if (pickDir && path.dirname(pickDir) === os.tmpdir() && /^ccc-codex-pick-/.test(path.basename(pickDir))) fs.rmSync(pickDir, { recursive: true, force: true })
    return { cmd: out.cmd, script: out.args[0], deployedScript: path.join(res, 'scripts', 'codex-resume-picker.js') }
  } finally {
    if (path.dirname(res) === os.tmpdir() && /^ccc-node-lookup-/.test(path.basename(res))) fs.rmSync(res, { recursive: true, force: true })
  }
}

describe('the picker route on Windows starts the node its session\'s PATH names', () => {
  it('the picker\'s executable is node.exe from the launch environment\'s PATH, found without a process', async () => {
    const launch = await pickerLaunchOnWindows()
    expect(launch.cmd).toBe('C:\\ccc-test-only\\nodejs\\node.exe')
    expect(launch.script).toBe(launch.deployedScript)
    expect(started).toEqual([])
  })

  it('the picker\'s node is looked up for the platform the launch is built for, whatever the os module reports', async () => {
    ;(globalThis as any).__osPlatform = 'linux'
    const launch = await pickerLaunchOnWindows()
    expect(launch.cmd).toBe('C:\\ccc-test-only\\nodejs\\node.exe')
    expect(started).toEqual([])
  })
})
