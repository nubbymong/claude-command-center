// [host] WP2 PR 4, P4.1 (row 51): what a Codex launch carries for the Agent
// Canvas (src/main/providers/codex/spawn.ts):
//  - approvals (the PR 4 VM probe PB2): `canvas_snapshot` and `canvas_review`
//    run without asking on every preset, as Claude pre-allows the two in every
//    mode; under Unrestricted (matched with Claude's Bypass, which asks before
//    nothing) every tool the connection is offered does too; per tool, never
//    a server-wide default;
//  - the canvas guidance as `-c developer_instructions` (section 10 question
//    5's default A), on the direct route only, TOML-encoded;
//  - the launch lines' budgets: under 32,767 characters on the direct route
//    (with the inline guidance, every key, the longest extra arguments and an
//    8,000-character Ask question quoted at its worst), under cmd.exe's 8,191
//    on the npm .cmd route (with every key under every preset and the longest
//    extra arguments); a forced overflow there drops the per-preset keys, with
//    a log line, and still launches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => '/mock/path/codex\n') }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => (globalThis as any).__mockMcpPort ?? 0,
  mcpSessionToken: () => 'tok-minted-directly',
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => (globalThis as any).__mockSettings ?? {},
  getConfigDir: () => '/cfg',
}))
const logWarn = vi.fn()
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: (...a: unknown[]) => logWarn(...a), logError: vi.fn() }))

const { buildCodexSpawn, codexToolApprovalArg, codexPresetApprovedTools, codexLaunchRoute, codexLaunchLineForLog, CODEX_PREALLOWED_TOOLS, CMD_EXE_LINE_MAX } = await import('../../../../src/main/providers/codex/spawn')
const { CODEX_CONDUCTOR_TOOLS, VISION_TOOL_NAMES } = await import('../../../../src/main/providers/codex/conductor-tools')
const { codexInlineGuidance, codexPointerGuidance, CODEX_INLINE_GUIDANCE_MAX } = await import('../../../../src/main/canvas/codex-guidance')
const { tomlString } = await import('../../../../src/main/providers/codex/hooks')
const { EXTRA_ARGS_MAX, codexExtraArgsProblem } = await import('../../../../src/shared/extra-args')

type Preset = 'read-only' | 'standard' | 'auto' | 'unrestricted' | 'plan'
const PRESETS: Preset[] = ['read-only', 'standard', 'auto', 'unrestricted', 'plan']
const linuxLaunch = { executable: '/mock/path/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }, sessionsDir: '/home/u/.codex/sessions' }
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\Users\\u\\.codex' }
const EXE = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'
const SHIM = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.cmd'

function withWin32<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}

/** A launch line's arguments as Windows hands them to a program (MSVC rules,
 *  node-pty's and libuv's quoting): what the 32,767-character limit counts. */
function windowsCommandLine(file: string, args: string[]): string {
  const quote = (a: string): string => {
    if (a === '') return '""'
    if (!/[\s"]/.test(a)) return a
    let out = '"'
    let bs = 0
    for (const ch of a) {
      if (ch === '\\') { bs++; continue }
      if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue }
      out += '\\'.repeat(bs) + ch
      bs = 0
    }
    return out + '\\'.repeat(bs * 2) + '"'
  }
  return [file, ...args].map(quote).join(' ')
}

/** A TOML string read back (the two forms tomlString writes). A literal
 *  string holds no single quote and no control character but a tab (TOML
 *  1.0); a basic one has them escaped. */
function readToml(v: string): string {
  if (v.startsWith("'")) {
    expect(v.endsWith("'")).toBe(true)
    const inner = v.slice(1, -1)
    expect(inner.includes("'"), 'a literal string holds no single quote').toBe(false)
    expect([...inner].some((c) => (c.charCodeAt(0) < 32 && c !== '\t') || c.charCodeAt(0) === 127), 'a literal string holds no control character').toBe(false)
    return inner
  }
  expect(v.startsWith('"') && v.endsWith('"')).toBe(true)
  expect([...v].some((c) => (c.charCodeAt(0) < 32 && c !== '\t') || c.charCodeAt(0) === 127), 'a basic string holds its control characters escaped').toBe(false)
  return v.slice(1, -1).replace(/\\(u[0-9A-Fa-f]{4}|["\\ntr])/g, (_m, e: string) =>
    e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : String.fromCharCode(parseInt(e.slice(1), 16)))
}

/** The longest extra arguments a Codex session may carry. */
const LONGEST_EXTRA = (() => {
  let s = ''
  while (s.length + 12 <= EXTRA_ARGS_MAX) s += (s ? ' ' : '') + '--add-dir=ab'
  return s
})()

const keysOf = (args: string[]): string[] => args.filter((a) => /^mcp_servers\.conductor\.tools\./.test(a))

beforeEach(() => {
  ;(globalThis as any).__mockMcpPort = 19333
  ;(globalThis as any).__mockSettings = {}
  logWarn.mockClear()
})
afterEach(() => {
  delete (globalThis as any).__mockMcpPort
  delete (globalThis as any).__mockSettings
})

describe('approvals (PB2), by parity per preset', () => {
  it.each(PRESETS)('pre-allows exactly canvas_snapshot and canvas_review under %s, per tool', (preset) => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: { model: 'gpt-5.5', permissionsPreset: preset } })
    for (const tool of CODEX_PREALLOWED_TOOLS) expect(out.args).toContain(codexToolApprovalArg(tool))
    expect(CODEX_PREALLOWED_TOOLS).toEqual(['canvas_snapshot', 'canvas_review'])
    // canvas_render reads a model-chosen file: never pre-allowed outside a
    // preset that asks before nothing.
    if (preset !== 'unrestricted') expect(keysOf(out.args)).toEqual(CODEX_PREALLOWED_TOOLS.map(codexToolApprovalArg))
  })

  it('Unrestricted (Claude\'s Bypass asks before nothing): every tool the connection is offered, each by its own key', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'unrestricted' } })
    const want = CODEX_CONDUCTOR_TOOLS.map((t) => codexToolApprovalArg(t.name)).sort()
    expect(keysOf(out.args).sort()).toEqual(want)
    expect(keysOf(out.args)).toContain(codexToolApprovalArg('canvas_render'))
  })

  it.each(['auto', 'standard', 'read-only', 'plan'] as Preset[])('no per-preset keys under %s (Auto cannot ask, and the app approves none of these for Claude\'s Auto: none until OR4; the others ask, as Claude\'s matching modes)', (preset) => {
    expect(codexPresetApprovedTools(preset, {})).toEqual([])
  })

  // WP2 PR 4, P4.2 (row 52): Claude pre-allows none of the vision or browser
  // tools, so no preset but Unrestricted runs them without asking; under
  // Unrestricted each has its own key.
  it.each(PRESETS)('P4.2: the vision tools and the browser push under %s', (preset) => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: { model: 'gpt-5.5', permissionsPreset: preset } })
    const keys = keysOf(out.args)
    const browserish = keys.filter((k) => /\.tools\.(vision_[A-Za-z]+|open_in_app_browser)\./.test(k))
    if (preset === 'unrestricted') {
      expect(browserish.sort()).toEqual([...VISION_TOOL_NAMES, 'open_in_app_browser'].map(codexToolApprovalArg).sort())
    } else {
      expect(browserish).toEqual([])
    }
  })

  it('a switched-off group gets no key under Unrestricted', () => {
    expect(codexPresetApprovedTools('unrestricted', { conductorTools: { vision: false } }).some((t) => t.startsWith('vision_'))).toBe(false)
    expect(codexPresetApprovedTools('unrestricted', { conductorTools: { vision: false } })).toContain('open_in_app_browser')
    expect(codexPresetApprovedTools('unrestricted', { conductorTools: { canvas: false } }).some((t) => t.startsWith('canvas_'))).toBe(false)
    expect(codexPresetApprovedTools('unrestricted', { conductorToolsEnabled: false })).toEqual([])
  })

  it.each(PRESETS)('nothing wider under %s: no server-wide default, no other approval value, only conductor tools', (preset) => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: { model: 'gpt-5.5', permissionsPreset: preset } })
    const line = out.args.join(' ')
    expect(line).not.toMatch(/default_tools_approval_mode/)
    expect(line).not.toMatch(/enabled_tools|disabled_tools/)
    for (const a of out.args.filter((x) => x.includes('approval_mode'))) {
      expect(a).toMatch(/^mcp_servers\.conductor\.tools\.[A-Za-z][A-Za-z0-9_]*\.approval_mode=approve$/)
    }
  })

  it('no keys at all when the built-in tools do not reach the launch (server not bound)', () => {
    ;(globalThis as any).__mockMcpPort = 0
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'unrestricted' } })
    expect(out.args.join(' ')).not.toMatch(/approval_mode/)
  })

  it('a tool name is a plain word or nothing is written', () => {
    expect(() => codexToolApprovalArg('canvas_render;x')).toThrow()
    expect(() => codexToolApprovalArg('a b')).toThrow()
  })
})

describe('developer instructions (question 5, default A)', () => {
  const text = 'line one\nline "two" with C:\\path and it\'s'

  it('the direct route carries them as one TOML-encoded -c value', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, developerInstructions: text, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
    const arg = out.args.find((a) => a.startsWith('developer_instructions='))!
    expect(out.args[out.args.indexOf(arg) - 1]).toBe('-c')
    expect(readToml(arg.slice('developer_instructions='.length))).toBe(text)
  })

  it('a Windows codex.exe is the direct route too', () => {
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: EXE, env: winEnv }, developerInstructions: text, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
      expect(out.commandLine).toBeUndefined()
      expect(out.args.some((a) => a.startsWith('developer_instructions='))).toBe(true)
      expect(codexLaunchRoute(EXE, 'win32')).toBe('direct')
    })
  })

  it('never on the npm .cmd route (it refuses an argument holding a space)', () => {
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv }, developerInstructions: text, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
      expect(out.commandLine).toBeDefined()
      expect(out.commandLine).not.toContain('developer_instructions')
      expect(codexLaunchRoute(SHIM, 'win32')).toBe('cmd')
    })
  })

  it('never when the built-in tools do not reach the launch', () => {
    ;(globalThis as any).__mockMcpPort = 0
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, developerInstructions: text, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
    expect(out.args.join(' ')).not.toContain('developer_instructions')
  })

  it.each([
    ['a space and backslashes', 'C:\\Program Files\\AI Code Conductor\\res\\canvas-plugin\\skills'],
    ['a single quote', "/Users/o'brien/Library/Application Support/ccc/canvas-plugin/skills"],
  ])('the pointer text survives the encoding with a plugin path holding %s', (_name, dir) => {
    const pointer = codexPointerGuidance(dir)
    expect(pointer).toContain(path.join(dir, 'agent-canvas', 'SKILL.md'))
    expect(readToml(tomlString(pointer))).toBe(pointer)
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, developerInstructions: pointer, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
    expect(readToml(out.args.find((a) => a.startsWith('developer_instructions='))!.slice('developer_instructions='.length))).toBe(pointer)
  })

  it('a hook command (no quote, no control character) keeps its literal form', () => {
    expect(tomlString("node '/x/y.js'")).toBe('"node \'/x/y.js\'"')
    expect(tomlString('C:\\res\\hook.cmd')).toBe("'C:\\res\\hook.cmd'")
  })

  it('a text over several lines with no quote takes the basic form, its newlines escaped (a TOML literal string holds none)', () => {
    const lines = ['first line', 'C:\\path\\x', 'third\tcolumn', 'bell' + String.fromCharCode(7)].join('\n')
    const v = tomlString(lines)
    expect(v.startsWith('"')).toBe(true)
    expect(v).toContain('\\n')
    expect(v).toContain('\\u0007')
    expect(readToml(v)).toBe(lines)
  })

  it('the log line names the instructions by length only', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, developerInstructions: codexInlineGuidance(), codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
    const logged = codexLaunchLineForLog(out.args.join(' '))
    expect(logged).toMatch(/developer_instructions=<\d+ characters>/)
    expect(logged).not.toContain('Agent Canvas')
  })

  it('[host] the built launch carries that line as its logLine (the PTY manager logs it, never the arguments)', () => {
    const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: linuxLaunch, developerInstructions: codexInlineGuidance(), codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
    expect(out.logLine).toBe(codexLaunchLineForLog(out.args.join(' ')))
    expect(out.logLine).toMatch(/developer_instructions=<\d+ characters>/)
    expect(out.logLine).not.toContain('Agent Canvas')
  })

  it('[host] on the npm .cmd route the logLine is the cmd.exe line', () => {
    withWin32(() => {
      const out = buildCodexSpawn({ sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv }, codexOptions: { model: 'gpt-5.5', permissionsPreset: 'standard' } })
      expect(out.logLine).toBe(codexLaunchLineForLog(out.commandLine!))
    })
  })
})

describe('launch line budgets', () => {
  it('the inline Windows text is at most 6,000 characters', () => {
    expect(codexInlineGuidance().length).toBeLessThanOrEqual(CODEX_INLINE_GUIDANCE_MAX)
    expect(CODEX_INLINE_GUIDANCE_MAX).toBe(6_000)
  })

  it('the direct route stays under 32,767 characters with the inline text, every key, the longest extra arguments and an 8,000-character question quoted at its worst', () => {
    ;(globalThis as any).__mockSettings = {}
    expect(codexExtraArgsProblem(LONGEST_EXTRA)).toBeNull()
    withWin32(() => {
      const out = buildCodexSpawn({
        sessionId: 'a'.repeat(64), realmLaunch: { ...linuxLaunch, executable: EXE, env: winEnv },
        developerInstructions: codexInlineGuidance(),
        codexOptions: { model: 'gpt-5.5-codex-max', reasoningEffort: 'xhigh', permissionsPreset: 'unrestricted', extraArgs: LONGEST_EXTRA },
      })
      const worstQuestion = '\\"'.repeat(4_000)
      const line = windowsCommandLine(out.cmd, [...out.args, '--', worstQuestion])
      expect(worstQuestion).toHaveLength(8_000)
      expect(line.length).toBeLessThan(32_767)
    })
  })

  it.each(PRESETS)('the npm .cmd line stays under 8,191 characters with every key under %s and the longest extra arguments', (preset) => {
    withWin32(() => {
      const out = buildCodexSpawn({
        sessionId: 'a'.repeat(64), realmLaunch: { ...linuxLaunch, executable: SHIM, env: winEnv },
        codexOptions: { model: 'gpt-5.5-codex-max', reasoningEffort: 'xhigh', permissionsPreset: preset, extraArgs: LONGEST_EXTRA },
      })
      expect(out.commandLine!.length).toBeLessThan(CMD_EXE_LINE_MAX)
      if (preset === 'unrestricted') expect(keysOf(out.commandLine!.split(' ')).length).toBe(CODEX_CONDUCTOR_TOOLS.length)
    })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a forced overflow on the .cmd route drops the per-preset keys, says so, and still launches', () => {
    withWin32(() => {
      const opts = (exe: string, preset: Preset) => ({
        sessionId: 'sid', realmLaunch: { ...linuxLaunch, executable: exe, env: winEnv },
        codexOptions: { model: 'gpt-5.5', permissionsPreset: preset },
      })
      const base = buildCodexSpawn(opts(SHIM, 'read-only')).commandLine!.length
      const keys = buildCodexSpawn(opts(SHIM, 'unrestricted')).commandLine!.length - base
      expect(keys).toBeGreaterThan(200)
      // A shim path long enough that the keys push the line over the limit.
      const pad = CMD_EXE_LINE_MAX - base - Math.floor(keys / 2)
      const longShim = `C:\\${'d'.repeat(pad)}\\codex.cmd`
      const out = buildCodexSpawn(opts(longShim, 'unrestricted'))
      expect(out.commandLine!.length).toBeLessThan(CMD_EXE_LINE_MAX)
      // The two pre-allowed keys stay; the per-preset ones go.
      expect(out.commandLine).toContain(codexToolApprovalArg('canvas_snapshot'))
      expect(out.commandLine).not.toContain(codexToolApprovalArg('canvas_render'))
      expect(logWarn).toHaveBeenCalledWith(expect.stringMatching(/per-preset tool approvals are left off/))
      // Review RVMFIX-2: the keys exist only under Unrestricted, which never
      // asks; without them those tools are refused, not asked about.
      const said = logWarn.mock.calls.map((c) => String(c[0])).find((m) => /per-preset tool approvals are left off/.test(m))!
      expect(said).toMatch(/other than canvas_snapshot and canvas_review are refused/)
      expect(said).not.toMatch(/\bask/)
    })
  })
})

describe('the registered Codex provider offers main its launch helpers (no deep import)', () => {
  it('[host] launchRoute, stagedSkillsDir and the run pane are the package\'s own', async () => {
    const { CodexProvider } = await import('../../../../src/main/providers/codex/index')
    const screen = await import('../../../../src/main/providers/codex/session-screen')
    const p = new CodexProvider()
    withWin32(() => {
      expect(p.launchRoute(SHIM)).toBe('cmd')
      expect(p.launchRoute(EXE)).toBe('direct')
    })
    const res = path.resolve('/res')
    const home = path.join(res, 'codex-realms', 'realm-0123456789abcdef0123')
    expect(p.stagedSkillsDir(home, res)).toBe(path.join(home, 'skills'))
    expect(p.stagedSkillsDir(path.resolve('/home/u/.codex'), res)).toBeNull()
    const sid = 'prov00000000prov00000000'
    p.runScreen.open(sid, { cols: 80, rows: 24, write: () => {}, current: () => true, clamp: (d) => d })
    expect(screen.hasCodexScreen(sid)).toBe(true)
    expect(p.runScreen.has(sid)).toBe(true)
    p.runScreen.close(sid)
    expect(screen.hasCodexScreen(sid)).toBe(false)
  })
})
