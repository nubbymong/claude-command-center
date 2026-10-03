// [host] WP2 PR 4, P4.3 (row 53): what a Codex launch carries for Ask
// Conductor (src/main/providers/codex/spawn.ts), as PB4 settled it:
//  - on every Ask launch, both routes: `-c project_doc_max_bytes=<n>` (the
//    help folder's AGENTS.md read whole) and `-c project_root_markers=[]` (no
//    parent folder's AGENTS.md beside it); never on any other launch;
//  - the question as the launch's prompt on the direct route's fresh launch:
//    after `--` (a question starting with "-" stays the question), as ONE
//    argument, whole (8,000 characters, an emoji included), and said so
//    (askPromptOnArgv); never past 8,000 characters, with a lone surrogate
//    (review RASK-3), on the npm .cmd route, an exact resume or the picker
//    (main types it through the pane there);
//  - the logged line names the question by its length only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The resources folder: none, except where a case stages the picker script.
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => (globalThis as any).__askResDir ?? '', getDataDirectory: () => '' }))
// The picker's node lookup, answered without starting anything.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => (process.platform === 'win32' ? 'C:\\node\\node.exe\r\n' : '/usr/local/bin/node\n')) }
})
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as any).__mockMcpPort ?? 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({ readConfig: () => ({}), getConfigDir: () => '/cfg' }))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { buildCodexSpawn, ASK_PROJECT_DOC_MAX_BYTES_CEILING } = await import('../../../../src/main/providers/codex/spawn')
const { askConductorProjectDocMaxBytes } = await import('../../../../src/main/help-workspace')

const linuxLaunch = { executable: '/mock/path/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }, sessionsDir: '/home/u/.codex/sessions' }
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\Users\\u\\.codex' }
const EXE = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe'
const SHIM = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd'
const STANDARD = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }
const EMOJI = String.fromCodePoint(0x1f680)

function withWin32<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
/** The value after each `-c` in a launch's arguments. */
const cValues = (args: readonly string[]): string[] => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))

beforeEach(() => { ;(globalThis as any).__mockMcpPort = 0 })
afterEach(() => { delete (globalThis as any).__mockMcpPort })

describe('the help folder\'s AGENTS.md, on every Ask launch', () => {
  it('[host] the direct route carries the byte bound and no root markers, as plain words', () => {
    const n = askConductorProjectDocMaxBytes('win32')
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askProjectDocMaxBytes: n })
    expect(cValues(out.args)).toContain(`project_doc_max_bytes=${n}`)
    expect(cValues(out.args)).toContain('project_root_markers=[]')
  })

  it('[host] the npm .cmd route takes them too (no whitespace, nothing cmd.exe reads)', () => {
    withWin32(() => {
      const n = askConductorProjectDocMaxBytes('win32')
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv }, codexOptions: STANDARD, askProjectDocMaxBytes: n })
      expect(out.commandLine).toContain(` -c project_doc_max_bytes=${n} `)
      expect(out.commandLine).toContain(' -c project_root_markers=[]')
    })
  })

  it('[host] the bound is the written AGENTS.md\'s UTF-8 size plus room, on each platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const n = askConductorProjectDocMaxBytes(platform)
      expect(Number.isSafeInteger(n) && n > 0 && n <= ASK_PROJECT_DOC_MAX_BYTES_CEILING).toBe(true)
    }
  })

  it('[host] never on a launch that is not Ask Conductor\'s', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD })
    expect(out.args.join(' ')).not.toContain('project_doc_max_bytes')
    expect(out.args.join(' ')).not.toContain('project_root_markers')
  })

  it.each([
    ['zero', 0], ['negative', -1], ['a fraction', 1.5], ['past the ceiling', ASK_PROJECT_DOC_MAX_BYTES_CEILING + 1], ['not a number', Number.NaN],
  ])('[host] a bound that is %s refuses the launch', (_name, n) => {
    expect(() => buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askProjectDocMaxBytes: n })).toThrow(/instruction file/)
  })
})

describe('the question on the direct route (PB4)', () => {
  it('[host] the launch\'s prompt: after `--`, the last argument, and said so', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: 'how do I add an account?' })
    expect(out.args.slice(-2)).toEqual(['--', 'how do I add an account?'])
    expect(out.askPromptOnArgv).toBe(true)
  })

  it('[host] a question starting with "-" comes after `--`, so it is never read as a flag', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: '-m gpt-4 what is this?' })
    expect(out.args.indexOf('--')).toBe(out.args.length - 2)
    expect(out.args[out.args.length - 1]).toBe('-m gpt-4 what is this?')
  })

  it('[host] 8,000 characters with an emoji arrive whole as ONE argument (a Windows codex.exe too)', () => {
    // Exactly the bound: 8,000 UTF-16 units, an emoji at each end.
    const q = EMOJI + 'x'.repeat(7_996) + EMOJI
    expect(q.length).toBe(8_000)
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: EXE, env: winEnv }, codexOptions: STANDARD, askPrompt: q })
      expect(out.commandLine).toBeUndefined()
      expect(out.args[out.args.length - 1]).toBe(q)
      expect(out.args.filter((a) => a === q)).toHaveLength(1)
      expect(out.askPromptOnArgv).toBe(true)
    })
  })

  it('[host] one past the bound does not ride argv (main types it through the pane)', () => {
    const q = 'x'.repeat(8_001)
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: q })
    expect(out.args).not.toContain(q)
    expect(out.args).not.toContain('--')
    expect(out.askPromptOnArgv).toBeUndefined()
  })

  it.each([
    ['half of an emoji at the end', 'what is this ' + String.fromCharCode(0xd83d)],
    ['half of an emoji at the start', String.fromCharCode(0xde80) + ' what is this'],
  ])('[host] a lone surrogate (%s) never rides argv: through the pane it is removed, and the dock told (review RASK-3)', (_name, q) => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: q })
    expect(out.args).not.toContain(q)
    expect(out.args).not.toContain('--')
    expect(out.askPromptOnArgv).toBeUndefined()
  })

  it('[host] the logged line names the question by its length only', () => {
    const q = `my secret project name is ORCHID ${EMOJI}`
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: q })
    expect(out.logLine).toContain(`-- <question, ${[...q].length} characters>`)
    expect(out.logLine).not.toContain('ORCHID')
    expect(out.logLine).not.toContain(EMOJI)
  })

  it('[host] a question holding a control character does not ride argv (the pane refuses it visibly)', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: 'line one\nline two' })
    expect(out.args).not.toContain('--')
    expect(out.askPromptOnArgv).toBeUndefined()
  })
})

describe('where the question never rides argv', () => {
  it('[host] the npm .cmd route: not on the cmd.exe line, and not said to be carried', () => {
    withWin32(() => {
      const shim = { ...linuxLaunch, executable: SHIM, env: winEnv }
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: shim, codexOptions: STANDARD, askPrompt: 'how do I add an account?' })
      expect(out.commandLine).toBeDefined()
      expect(out.commandLine).not.toContain('account')
      expect(out.askPromptOnArgv).toBeUndefined()
      expect(out.logLine).not.toContain('account')
      // Exactly the line the launch builds without a question.
      expect(out.commandLine).toBe(buildCodexSpawn({ sessionId: 'sid', realmLaunch: shim, codexOptions: STANDARD }).commandLine)
    })
  })

  it('[host] an exact resume: the conversation is resumed and the question is left to the pane', () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ask-resume-')))
    try {
      const uuid = '019dd000-0001-7000-8000-0000000000a1'
      const at = new Date(Date.now() - 2 * 24 * 3600 * 1000)
      const day = path.join(home, 'sessions', String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
      fs.mkdirSync(day, { recursive: true })
      const cwd = fs.realpathSync.native(os.tmpdir())
      const meta = { timestamp: at.toISOString(), type: 'session_meta', payload: { id: uuid, cwd, cli_version: '0.155.1' } }
      fs.writeFileSync(path.join(day, 'rollout-2026-09-25T10-00-00-' + uuid + '.jsonl'), JSON.stringify(meta) + '\n')
      const realm = { ...linuxLaunch, sessionsDir: path.join(home, 'sessions'), env: { ...linuxLaunch.env, CODEX_HOME: home } }
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: realm, cwd, codexOptions: STANDARD, askPrompt: 'continue please', resume: { uuid, cwd } })
      expect(out.resumeId).toBe(uuid)
      expect(out.args).not.toContain('continue please')
      expect(out.args).not.toContain('--')
      expect(out.askPromptOnArgv).toBeUndefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('[host] the picker (Past discussions): the picker runs with the flags only, and the question is left to the pane', () => {
    const res = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ask-picker-')))
    let pickDir: string | null = null
    try {
      fs.mkdirSync(path.join(res, 'scripts'))
      const script = path.join(res, 'scripts', 'codex-resume-picker.js')
      fs.writeFileSync(script, '// staged for the test\n')
      ;(globalThis as any).__askResDir = res
      const q = 'how do I add an account?'
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, useResumePicker: true, askPrompt: q, askProjectDocMaxBytes: askConductorProjectDocMaxBytes('linux') })
      pickDir = out.pickFile ? path.dirname(out.pickFile) : null
      expect(out.args[0]).toBe(script)
      expect(out.args).not.toContain(q)
      expect(out.args).not.toContain('--')
      expect(out.askPromptOnArgv).toBeUndefined()
      // The help folder's scope still rides the picker's flags.
      expect(cValues(out.args)).toContain('project_root_markers=[]')
    } finally {
      delete (globalThis as any).__askResDir
      if (pickDir) {
        try { fs.rmSync(path.join(pickDir, 'pick.json'), { force: true }); fs.rmdirSync(pickDir) } catch { /* left for the OS */ }
      }
      fs.rmSync(res, { recursive: true, force: true })
    }
  })
})
