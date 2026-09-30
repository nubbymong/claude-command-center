// P3.10 (rows 43, 46, 47, 63): the Codex hooks the app gives a launch, and the
// per-launch hook file that hands the forwarder the gateway's port and token.
// Evidence: the P3.10 VM probe of the real 0.153.4 and 0.155.1 TUIs (the P3.1
// record's addendum 14): `-c` hooks are "Session flags" hooks, reviewed once
// by the user and trusted while unchanged; on Windows the command runs through
// PowerShell; a bare .cmd path and `async = true` are accepted.
// P3.10 round 1: PowerShell's call of a quoted path is refused for a path
// PowerShell reads as a wildcard or cmd.exe expands (A2, A3); the hook folders
// live in the app's own data folder, in a real, owner-only `codex-hooks`
// folder, and only that folder is swept (A5); a launch through the npm shim
// from a resources folder with a space runs a plain-path copy of the wrapper
// the app keeps under the user's local app data folder, checked before each
// use (V3).
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
  ensureCodexHookRoot,
  realFolderChainBelow,
  codexPlainWrapperDir,
  stagePlainCodexHookWrapper,
  verifyPlainCodexHookWrapper,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_DIR_PREFIX,
  CODEX_HOOK_FILE_NAME,
  CODEX_HOOK_ROOT_NAME,
  CODEX_HOOK_STALE_MS,
  CODEX_HOOK_PLAIN_BASE,
} from '../../../../src/main/providers/codex/hooks'

const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const TEST_PREFIX = 'p310-hooks-test-'
const made: string[] = []
const links: string[] = []
function tmp(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
  made.push(d)
  return d
}
/** A folder link: a junction on Windows (no special right needed), a symlink elsewhere. */
function folderLink(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(at)
}
afterEach(() => {
  // Links first, removed as links (never followed).
  for (const l of links.splice(0)) {
    try { if (fs.lstatSync(l).isSymbolicLink()) { try { fs.unlinkSync(l) } catch { fs.rmdirSync(l) } } } catch { /* gone */ }
  }
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
    expect(codexHookCommand(`C:\\a${String.fromCharCode(0x2019)}b\\scripts`, 'win32', false)).toBeNull()
    expect(codexHookCommand('C:\\a\nb\\scripts', 'win32', false)).toBeNull()
    expect(codexHookCommand('scripts', 'win32', false)).toBeNull()
    expect(codexHookCommand("/home/o'b/scripts", 'linux', false)).toBeNull()
    expect(codexHookCommand('/home/a\tb/scripts', 'darwin', false)).toBeNull()
    expect(codexHookCommand('scripts', 'linux', false)).toBeNull()
    expect(codexHookCommand('', 'linux', false)).toBeNull()
  })

  it('round 1 (A2): refuses PowerShell\'s call for a path PowerShell reads as a wildcard ([ ] * ?)', () => {
    for (const p of ['C:\\My Res[1]\\scripts', 'C:\\Proj [2026]\\CCC\\scripts', 'C:\\My Res]\\scripts', 'C:\\My Res*\\scripts', 'C:\\My Res?\\scripts']) {
      expect(codexHookCommand(p, 'win32', false), p).toBeNull()
    }
  })

  it('round 1 (A3): refuses PowerShell\'s call for a path cmd.exe would expand or read (% ! & ^)', () => {
    for (const p of ['C:\\My %USERNAME%\\scripts', 'C:\\My Res!x!\\scripts', 'C:\\A & B\\scripts', 'C:\\My Res^\\scripts']) {
      expect(codexHookCommand(p, 'win32', false), p).toBeNull()
    }
    // Characters neither shell acts on in that form stay allowed.
    expect(codexHookCommand('C:\\My Res (2)\\x,y;z\\scripts', 'win32', false)).toBe("& 'C:\\My Res (2)\\x,y;z\\scripts\\ccc-codex-hook.cmd'")
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

describe('ensureCodexHookRoot (round 1, A5)', () => {
  it('makes <data>/codex-hooks, a real folder, owner-only, hardened by the app\'s rule, and reuses it', () => {
    const data = tmp()
    const hardened: string[] = []
    const root = ensureCodexHookRoot(data, (d) => { hardened.push(d); return true })
    expect(root).toBe(path.join(data, CODEX_HOOK_ROOT_NAME))
    expect(fs.lstatSync(root!).isDirectory()).toBe(true)
    expect(hardened).toEqual([root])
    if (process.platform !== 'win32') expect(fs.statSync(root!).mode & 0o777).toBe(0o700)
    expect(ensureCodexHookRoot(data)).toBe(root)
  })

  it('refuses a codex-hooks that is a link or junction, or a file; a relative or missing data folder; and a hardening that did not take', () => {
    const data = tmp()
    const elsewhere = tmp()
    folderLink(elsewhere, path.join(data, CODEX_HOOK_ROOT_NAME))
    expect(ensureCodexHookRoot(data)).toBeNull()
    const data2 = tmp()
    fs.writeFileSync(path.join(data2, CODEX_HOOK_ROOT_NAME), 'x')
    expect(ensureCodexHookRoot(data2)).toBeNull()
    expect(ensureCodexHookRoot('relative/data')).toBeNull()
    expect(ensureCodexHookRoot(path.join(tmp(), 'missing'))).toBeNull()
    expect(ensureCodexHookRoot(tmp(), () => false)).toBeNull()
    expect(ensureCodexHookRoot(tmp(), () => { throw new Error('icacls') })).toBeNull()
  })

  it('a data folder reached through a link is the user\'s choice: its own real codex-hooks is used', () => {
    const real = tmp()
    const viaLink = path.join(tmp(), 'data-link')
    folderLink(real, viaLink)
    expect(ensureCodexHookRoot(viaLink)).toBe(path.join(viaLink, CODEX_HOOK_ROOT_NAME))
    expect(realFolderChainBelow(viaLink, path.join(viaLink, CODEX_HOOK_ROOT_NAME))).toBe(true)
  })
})

describe('writeCodexHookFile / removeCodexHookFile', () => {
  it('writes the port, session id and token, owner-only, in a folder made for the launch inside the hook root', () => {
    const root = ensureCodexHookRoot(tmp())!
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

  it('refuses what the gateway would not route: a bad session id, port or token; and a relative root', () => {
    const root = ensureCodexHookRoot(tmp())!
    expect(writeCodexHookFile('../x', 51234, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('a b', 51234, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 0, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 70000, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 1.5, TOKEN, root)).toBeNull()
    expect(writeCodexHookFile('s', 51234, 'short', root)).toBeNull()
    expect(writeCodexHookFile('s', 51234, 'x'.repeat(10) + '\n' + 'y'.repeat(10), root)).toBeNull()
    expect(writeCodexHookFile('s', 51234, TOKEN, 'codex-hooks')).toBeNull()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('removes only what it put there, never recursively: a foreign file keeps the folder', () => {
    const root = ensureCodexHookRoot(tmp())!
    const h = writeCodexHookFile('sess-2', 51234, TOKEN, root)!
    fs.writeFileSync(path.join(h.dir, 'other.txt'), 'x')
    fs.writeFileSync(path.join(h.dir, `${CODEX_HOOK_FILE_NAME}.0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60.tmp`), 'x')
    removeCodexHookFile(h)
    expect(fs.existsSync(h.file)).toBe(false)
    expect(fs.readdirSync(h.dir)).toEqual(['other.txt'])
  })

  it('touches nothing once the folder is not the one made (replaced)', () => {
    const root = ensureCodexHookRoot(tmp())!
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
    const root = ensureCodexHookRoot(tmp())!
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

  it('round 1 (A5): sweeps only a hook root, never another folder (the system temp folder another install shares)', () => {
    const shared = tmp()
    const lookalike = fs.mkdtempSync(path.join(shared, CODEX_HOOK_DIR_PREFIX))
    const past = new Date(Date.now() - CODEX_HOOK_STALE_MS - 60_000)
    fs.utimesSync(lookalike, past, past)
    expect(sweepStaleCodexHookFolders(shared)).toBe(0)
    expect(fs.existsSync(lookalike)).toBe(true)
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

describe('round 1 (V3): the plain-path copy for the npm shim route', () => {
  it('names one folder per install under the local app data folder, stable for its resources folder, only when the wrapper path is plain', () => {
    const a = codexPlainWrapperDir('C:\\Users\\riley\\AppData\\Local', 'C:\\Users\\riley\\AppData\\Local\\AI Code Conductor\\resources')!
    expect(a).toMatch(/^C:\\Users\\riley\\AppData\\Local\\ai-code-conductor\\codex-hooks-[0-9a-f]{12}$/)
    expect(path.win32.basename(path.win32.dirname(a))).toBe(CODEX_HOOK_PLAIN_BASE)
    // The same install (any spelling of its resources folder) keeps the same folder; a dev build has another.
    expect(codexPlainWrapperDir('C:\\Users\\riley\\AppData\\Local', 'c:\\users\\riley\\appdata\\local\\ai code conductor\\resources')).toBe(a)
    expect(codexPlainWrapperDir('C:\\Users\\riley\\AppData\\Local', 'C:\\Users\\riley\\AppData\\Local\\Claude Command Center\\dev\\resources')).not.toBe(a)
    // A user name with a space: no plain path (the shim route then has no hooks).
    expect(codexPlainWrapperDir('C:\\Users\\Riley Smith\\AppData\\Local', 'C:\\x\\resources')).toBeNull()
    expect(codexPlainWrapperDir(undefined, 'C:\\x\\resources')).toBeNull()
    expect(codexPlainWrapperDir('AppData\\Local', 'C:\\x\\resources')).toBeNull()
  })

  function scripts(): string {
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.js'), '// forwarder')
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem wrapper')
    return path.join(res, 'scripts')
  }

  it('stages both files into real folders, hardened, and they verify; a changed, replaced or extra-named copy does not', () => {
    const src = scripts()
    const lad = tmp()
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    const hardened: string[] = []
    expect(stagePlainCodexHookWrapper(src, plain, (d) => { hardened.push(d); return true })).toBe(true)
    expect(hardened).toEqual([plain])
    expect(fs.readFileSync(path.join(plain, 'ccc-codex-hook.cmd'), 'utf8')).toBe('rem wrapper')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    // Changed since it was staged.
    fs.writeFileSync(path.join(plain, 'ccc-codex-hook.js'), '// someone else')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    // Staged again (the next boot): whole again.
    expect(stagePlainCodexHookWrapper(src, plain)).toBe(true)
    // A copy with a second name.
    fs.linkSync(path.join(plain, 'ccc-codex-hook.cmd'), path.join(lad, 'second-name.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
  })

  it('refuses a copy folder, or its base, that is a link or junction, and a hardening that did not take', () => {
    const src = scripts()
    const lad = tmp()
    const elsewhere = tmp()
    fs.mkdirSync(path.join(lad, CODEX_HOOK_PLAIN_BASE))
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    folderLink(elsewhere, plain)
    expect(stagePlainCodexHookWrapper(src, plain)).toBe(false)
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.js'), path.join(elsewhere, 'ccc-codex-hook.js'))
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.cmd'), path.join(elsewhere, 'ccc-codex-hook.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    const lad2 = tmp()
    const base2 = tmp()
    folderLink(base2, path.join(lad2, CODEX_HOOK_PLAIN_BASE))
    expect(stagePlainCodexHookWrapper(src, path.join(lad2, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345'))).toBe(false)
    const lad3 = tmp()
    expect(stagePlainCodexHookWrapper(src, path.join(lad3, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345'), () => false)).toBe(false)
  })
})
