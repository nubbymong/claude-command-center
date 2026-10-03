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
//  - the logged line names the question by its length only;
//  - ADR-009 round 1: on Windows node-pty joins the arguments into one command
//    line that codex.exe splits again, so the question rides argv only when
//    that line gives it back as ONE argument, whole (never with a double
//    quote, and only to a .exe started directly); otherwise it is typed
//    through the pane. Checked against node-pty's own quoting and a separate
//    parser of the Windows rules.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'

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

const { buildCodexSpawn, ASK_PROJECT_DOC_MAX_BYTES_CEILING, nodePtyWindowsCommandLine, splitWindowsCommandLine } = await import('../../../../src/main/providers/codex/spawn')
// node-pty's own Windows quoting (pure JS; nothing native is loaded by it).
const { argsToCommandLine } = createRequire(path.join(process.cwd(), 'package.json'))('node-pty/lib/windowsPtyAgent.js') as { argsToCommandLine: (file: string, args: string[]) => string }
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
      // An exact resume is not the picker's route, whatever was asked for.
      expect(out.viaPicker).toBeUndefined()
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
      // Said, so main records the guidance the picker carries (review).
      expect(out.viaPicker).toBe(true)
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

/** A separate reading of a Windows command line by the rules codex.exe (a
 *  Rust program: std's Windows argument parser) splits it with. */
function splitLikeCodex(line: string): string[] {
  const out: string[] = []
  let i = 0
  let cur = ''
  let inQ = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { inQ = !inQ; continue }
    if ((c === ' ' || c === '\t') && !inQ) break
    cur += c
  }
  out.push(cur)
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  cur = ''
  inQ = false
  let any = false
  while (i < line.length) {
    const c = line[i]
    if ((c === ' ' || c === '\t') && !inQ) {
      out.push(cur); cur = ''; any = false
      while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
      continue
    }
    if (c === '\\') {
      let n = 0
      while (i < line.length && line[i] === '\\') { n++; i++ }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) { cur += '"'; i++ }
      } else cur += '\\'.repeat(n)
      any = true
      continue
    }
    if (c === '"' && inQ) {
      if (line[i + 1] === '"') { cur += '"'; i += 2 } else { inQ = false; i++ }
      any = true
      continue
    }
    if (c === '"') { inQ = true; i++; any = true; continue }
    cur += c; i++; any = true
  }
  if (cur !== '' || inQ || any) out.push(cur)
  return out
}

describe('the route a picker launch took (review)', () => {
  it('[host] the picker asked for but not in place: Codex is started directly, and the launch does not say it went through the picker', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, useResumePicker: true })
    expect(out.cmd).toBe(linuxLaunch.executable)
    expect(out.viaPicker).toBeUndefined()
  })
})

describe('the question and the Windows command line (ADR-009 round 1)', () => {
  const Q = '"'
  const B = '\\'
  const win = { ...linuxLaunch, executable: EXE, env: winEnv }
  const buildWin = (q: string, launch: typeof win = win) => withWin32(() => buildCodexSpawn({ sessionId: 'sid', realmLaunch: launch, codexOptions: STANDARD, askPrompt: q }))
  // Quotes, backslashes before a quote and at the end, spaces, tabs, and the
  // characters cmd.exe gives a meaning.
  const CORPUS = [
    'how do I add an account?',
    'what does 100% mean',
    'a ^ b & c | d < e > f',
    '%PATH% and ^& and && and ||',
    `C:${B}dir${B} with a trailing backslash${B}`,
    `ends in two backslashes${B}${B}`,
    `no-spaces-trailing${B}`,
    `${B}${B}server${B}share x`,
    'tab\there',
    '-m gpt-4 what is this?',
    '--',
    `${Q}How do I add an SSH host?${Q}`,
    `${Q}Cannot start Codex${Q} -- what does that error mean?${Q}`,
    `${Q} ${Q}`,
    `what does ${Q}Restart${Q} do?`,
    `${Q}no-spaces-quoted${Q}`,
    `back${B}${Q}slash quote`,
    `two${B}${B}${Q} backslashes then a quote`,
    `ends with a quote${Q}`,
    `${Q}starts with a quote`,
    `x ${B}${B}${Q} y ${B}`,
  ]

  it('[host] the mirror of node-pty\'s quoting is node-pty\'s own, for every case', () => {
    for (const file of [EXE, `C:${B}Program Files${B}codex${B}codex.exe`]) {
      for (const q of CORPUS) {
        const args = ['-m', 'gpt-5.5', '-c', `developer_instructions=${Q}a ${B}${Q}b${B}${Q} c${Q}`, '--', q]
        expect(nodePtyWindowsCommandLine(file, args), JSON.stringify(q)).toBe(argsToCommandLine(file, args))
      }
    }
  })

  it('[host] a question rides argv only when node-pty\'s line gives it back as ONE argument, whole; otherwise it is typed', () => {
    for (const q of CORPUS) {
      const out = buildWin(q)
      if (out.askPromptOnArgv) {
        const split = splitLikeCodex(argsToCommandLine(out.cmd, out.args))
        expect(split.slice(1), JSON.stringify(q)).toEqual(out.args)
        expect(split[split.length - 1]).toBe(q)
        expect(split[split.length - 2]).toBe('--')
      } else {
        expect(out.args, JSON.stringify(q)).not.toContain(q)
        expect(out.args).not.toContain('--')
      }
    }
  })

  it('[host] a question that starts and ends with a double quote and holds a space is typed, not split (finding L1-1)', () => {
    for (const q of [`${Q}How do I add an SSH host?${Q}`, `${Q}Cannot start Codex${Q} -- what does that error mean?${Q}`, `${Q} ${Q}`]) {
      const out = buildWin(q)
      expect(out.askPromptOnArgv, JSON.stringify(q)).toBeUndefined()
      expect(out.args).not.toContain('--')
    }
  })

  it('[host] on Windows every question holding a double quote is typed, even one the line would keep', () => {
    for (const q of CORPUS.filter((c) => c.includes(Q))) expect(buildWin(q).askPromptOnArgv, JSON.stringify(q)).toBeUndefined()
  })

  it('[host] the plain ones, the characters cmd.exe reads included, still ride argv', () => {
    for (const q of ['how do I add an account?', 'what does 100% mean', 'a ^ b & c | d < e > f', '%PATH% and ^& and && and ||', `C:${B}dir${B} with a trailing backslash${B}`, `ends in two backslashes${B}${B}`, `no-spaces-trailing${B}`, '-m gpt-4 what is this?']) {
      expect(buildWin(q).askPromptOnArgv, JSON.stringify(q)).toBe(true)
    }
  })

  it('[host] the direct route starts codex.exe itself, never cmd.exe, so nothing re-reads % ^ & on the way', () => {
    const out = buildWin('100% ^ & | < >')
    expect(out.askPromptOnArgv).toBe(true)
    expect(out.cmd).toBe(EXE)
    expect(out.commandLine).toBeUndefined()
    expect(out.cmd.toLowerCase()).not.toContain('cmd.exe')
  })

  it('[host] a batch file as Windows reads its name (trailing dots or spaces dropped) takes no question on argv: Windows would hand it to cmd.exe', () => {
    for (const exe of [`C:${B}tools${B}codex.cmd.`, `C:${B}tools${B}codex.bat `, `C:${B}tools${B}codex.CMD. .`]) {
      const out = buildWin('how do I add an account?', { ...win, executable: exe })
      expect(out.askPromptOnArgv, exe).toBeUndefined()
      expect(out.args).not.toContain('how do I add an account?')
    }
  })

  it('[host] on macOS and Linux the arguments reach the process as they are: a quoted question still rides argv', () => {
    const q = `${Q}How do I add an SSH host?${Q}`
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: STANDARD, askPrompt: q })
      expect(out.askPromptOnArgv).toBe(true)
      expect(out.args.slice(-2)).toEqual(['--', q])
    } finally {
      if (orig) Object.defineProperty(process, 'platform', orig)
    }
  })

  it('[host] the app\'s own reading of a line agrees with codex.exe\'s, and refuses two quotes inside a quoted part', () => {
    for (const q of CORPUS) {
      const line = argsToCommandLine(EXE, ['-m', 'gpt-5.5', '--', q])
      expect(splitWindowsCommandLine(line), JSON.stringify(q)).toEqual(splitLikeCodex(line))
    }
    expect(splitWindowsCommandLine(`codex.exe ${Q}a${Q}${Q}b${Q}`)).toBeNull()
  })
})
