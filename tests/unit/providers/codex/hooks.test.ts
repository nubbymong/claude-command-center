// P3.10 (rows 43, 46, 47, 63): the Codex hooks the app gives a launch, and the
// per-launch hook file that hands the forwarder the gateway's port and token.
// Evidence: the P3.10 VM probe of the real 0.153.4 and 0.155.1 TUIs (the P3.1
// record's addendum 14): `-c` hooks are "Session flags" hooks, reviewed once
// by the user and trusted while unchanged; on Windows the command runs through
// PowerShell; a bare .cmd path and `async = true` are accepted.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  codexHookCommand,
  codexHookConfigArgs,
  writeCodexHookFile,
  removeCodexHookFile,
  sweepStaleCodexHookFolders,
  deployCodexHookScripts,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_DIR_PREFIX,
  CODEX_HOOK_FILE_NAME,
  CODEX_HOOK_STALE_MS,
} from '../../../../src/main/providers/codex/hooks'

const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 'p310-hooks-test-'
const made: string[] = []
function tmp(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
afterEach(() => {
  // TEST CLEANUP GUARD: only the folders this test made, by their own prefix, under the temp folder.
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(TEST_PREFIX) || path.dirname(d) !== fs.realpathSync.native(os.tmpdir())) continue
    fs.rmSync(d, { recursive: true, force: true })
  }
})

/** cmd.exe's refusal set for an argument (spawn.ts CMD_UNSAFE_ARG_RE). */
const CMD_UNSAFE_ARG_RE = /["%&^|<>!()\s]/

describe('codexHookCommand', () => {
  it('Windows: the wrapper by its bare path when that is a plain word (either launch route)', () => {
    expect(codexHookCommand('C:\\Res\\scripts', 'win32', false)).toBe('C:\\Res\\scripts\\ccc-codex-hook.cmd')
    expect(codexHookCommand('C:\\Res\\scripts', 'win32', true)).toBe('C:\\Res\\scripts\\ccc-codex-hook.cmd')
  })

  it('Windows: a path with a space is PowerShell\'s call of the quoted path on a direct launch, none through cmd.exe', () => {
    expect(codexHookCommand('C:\\My Res\\scripts', 'win32', false)).toBe("& 'C:\\My Res\\scripts\\ccc-codex-hook.cmd'")
    expect(codexHookCommand('C:\\My Res\\scripts', 'win32', true)).toBeNull()
  })

  it('refuses a path holding a quote (any of PowerShell\'s), a control character, or a relative one', () => {
    expect(codexHookCommand("C:\\O'Brien\\scripts", 'win32', false)).toBeNull()
    expect(codexHookCommand('C:\\a\u2019b\\scripts', 'win32', false)).toBeNull()
    expect(codexHookCommand('C:\\a\nb\\scripts', 'win32', false)).toBeNull()
    expect(codexHookCommand('scripts', 'win32', false)).toBeNull()
    expect(codexHookCommand("/home/o'b/scripts", 'linux', false)).toBeNull()
    expect(codexHookCommand('/home/a\tb/scripts', 'darwin', false)).toBeNull()
    expect(codexHookCommand('scripts', 'linux', false)).toBeNull()
    expect(codexHookCommand('', 'linux', false)).toBeNull()
  })

  it('elsewhere: node with the single-quoted script path', () => {
    expect(codexHookCommand('/Users/me/Res/scripts', 'darwin', false)).toBe("node '/Users/me/Res/scripts/ccc-codex-hook.js'")
    expect(codexHookCommand('/home/me/My Res/scripts', 'linux', false)).toBe("node '/home/me/My Res/scripts/ccc-codex-hook.js'")
  })
})

describe('codexHookConfigArgs', () => {
  it('one -c per event, each the command, asynchronous, with a bounded timeout', () => {
    const args = codexHookConfigArgs('C:\\Res\\scripts\\ccc-codex-hook.cmd')
    expect(args.length).toBe(CODEX_HOOK_EVENTS.length * 2)
    expect([...CODEX_HOOK_EVENTS]).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'])
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-c')
      expect(args[i + 1]).toBe(`hooks.${CODEX_HOOK_EVENTS[i / 2]}=[{hooks=[{type='command',command='C:\\Res\\scripts\\ccc-codex-hook.cmd',timeout=10,async=true}]}]`)
    }
  })

  it('a plain command passes cmd.exe unchanged (no quote, no space): the npm-shim route can carry it', () => {
    for (const a of codexHookConfigArgs('C:\\Res\\scripts\\ccc-codex-hook.cmd')) expect(CMD_UNSAFE_ARG_RE.test(a), a).toBe(false)
  })

  it('a command holding a single quote is a TOML basic string with \\ and " escaped', () => {
    const args = codexHookConfigArgs("& 'C:\\My Res\\x.cmd'")
    expect(args[1]).toBe(`hooks.SessionStart=[{hooks=[{type='command',command="& 'C:\\\\My Res\\\\x.cmd'",timeout=10,async=true}]}]`)
  })

  it('never names the session: the same command for every session (Codex keeps the trust while it is unchanged)', () => {
    expect(codexHookConfigArgs('X').join(' ')).not.toMatch(/token|hook\.json|CLAUDE_MULTI_SESSION_ID|CCC_CODEX_HOOK_FILE/i)
  })
})

describe('writeCodexHookFile / removeCodexHookFile', () => {
  it('writes the port, session id and token, owner-only, in a folder made for the launch', () => {
    const root = tmp()
    const h = writeCodexHookFile('sess-1', 51234, TOKEN, root)!
    expect(h).not.toBeNull()
    expect(path.dirname(h.dir)).toBe(root)
    expect(path.basename(h.dir).startsWith(CODEX_HOOK_DIR_PREFIX)).toBe(true)
    expect(h.file).toBe(path.join(h.dir, CODEX_HOOK_FILE_NAME))
    expect(JSON.parse(fs.readFileSync(h.file, 'utf8'))).toEqual({ v: 1, port: 51234, sid: 'sess-1', token: TOKEN })
    if (process.platform !== 'win32') expect(fs.statSync(h.file).mode & 0o777).toBe(0o600)
    removeCodexHookFile(h)
    expect(fs.existsSync(h.dir)).toBe(false)
  })

  it('refuses what the gateway would not route: a bad session id, port or token', () => {
    const root = tmp()
    expect(writeCodexHookFile('../x', 51234, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('a b', 51234, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 0, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 70000, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 1.5, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 51234, 'short', root)).toBeNull()
    expect(writeCodexHookFile('s', 51234, 'x'.repeat(10) + '\n' + 'y'.repeat(10), root)).toBeNull()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('removes only what it put there, never recursively: a foreign file keeps the folder', () => {
    const root = tmp()
    const h = writeCodexHookFile('sess-2', 51234, TOKEN, root)!
    fs.writeFileSync(path.join(h.dir, 'other.txt'), 'x')
    fs.writeFileSync(path.join(h.dir, `${CODEX_HOOK_FILE_NAME}.0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60.tmp`), 'x')
    removeCodexHookFile(h)
    expect(fs.existsSync(h.file)).toBe(false)
    expect(fs.readdirSync(h.dir)).toEqual(['other.txt'])
  })

  it('touches nothing once the folder is not the one made (replaced)', () => {
    const root = tmp()
    const h = writeCodexHookFile('sess-3', 51234, TOKEN, root)!
    fs.unlinkSync(h.file)
    fs.rmdirSync(h.dir)
    fs.mkdirSync(h.dir)
    fs.writeFileSync(h.file, 'someone else')
    removeCodexHookFile(h)
    expect(fs.readFileSync(h.file, 'utf8')).toBe('someone else')
  })
})

describe('sweepStaleCodexHookFolders', () => {
  it('removes only its own real folders older than the bound, emptied, never recursively', () => {
    const root = tmp()
    const old = writeCodexHookFile('sess-old', 51234, TOKEN, root)!
    const fresh = writeCodexHookFile('sess-new', 51234, TOKEN, root)!
    const foreign = fs.mkdtempSync(path.join(root, 'someone-else-'))
    const oldWithMore = writeCodexHookFile('sess-more', 51234, TOKEN, root)!
    fs.writeFileSync(path.join(oldWithMore.dir, 'keep.txt'), 'x')
    const past = new Date(Date.now() - CODEX_HOOK_STALE_MS - 60_000)
    for (const d of [old.dir, foreign, oldWithMore.dir]) fs.utimesSync(d, past, past)
    const removed = sweepStaleCodexHookFolders(root)
    expect(removed).toBe(1)
    expect(fs.existsSync(old.dir)).toBe(false)
    expect(fs.existsSync(fresh.file)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(fs.readdirSync(oldWithMore.dir)).toEqual(['keep.txt'])
  })
})

describe('deployCodexHookScripts', () => {
  it('copies the forwarder and its Windows wrapper into <resourcesDir>/scripts', async () => {
    const res = tmp()
    await deployCodexHookScripts(res, path.resolve(__dirname, '../../../..'))
    expect(fs.existsSync(path.join(res, 'scripts', 'ccc-codex-hook.js'))).toBe(true)
    expect(fs.existsSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'))).toBe(true)
  })
})
