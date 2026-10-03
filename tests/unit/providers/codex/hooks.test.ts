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
// use (V3). Round 4: the hook folders are prepared asynchronously, once, by one
// call of the owner-only rule, before anything is written in them.
import { describe, it, expect, afterEach, vi } from 'vitest'
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
  realFolderChainBelow,
  codexPlainWrapperDir,
  prepareCodexHookFolders,
  preparedCodexHookRoot,
  __resetCodexHookFoldersForTests,
  verifyPlainCodexHookWrapper,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_DIR_PREFIX,
  CODEX_HOOK_FILE_NAME,
  CODEX_HOOK_ROOT_NAME,
  CODEX_HOOK_STALE_MS,
  CODEX_HOOK_PLAIN_BASE,
  CODEX_HOOK_FOLDERS_RETRY_MS,
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
  __resetCodexHookFoldersForTests()
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

/** A hook root for the hook-file cases (preparing it is tested below). */
function makeRoot(): string {
  const root = path.join(tmp(), CODEX_HOOK_ROOT_NAME)
  fs.mkdirSync(root)
  return root
}

/** The owner-only rule as the real one behaves for the folder order
 *  (src/main/owner-only-folders.ts): each folder in turn; a link is refused,
 *  and so is a folder below a refused one, or below an earlier folder of the
 *  call that is a link by now (a parent outside the call is the caller's
 *  choice, never inspected); a missing folder is made inside its parent;
 *  `ok` decides each verdict. `onEach` runs once a folder is there, before
 *  its verdict. Records every call. */
type Verdict = { dir: string; ok: boolean; detail: string }
function rule(ok: (dir: string) => boolean = () => true, onEach?: (dir: string) => void) {
  const calls: string[][] = []
  const secure = async (dirs: readonly string[]): Promise<Verdict[]> => {
    calls.push([...dirs])
    const refused = new Set<string>()
    const done = new Set<string>()
    const out: Verdict[] = []
    for (const dir of dirs) {
      const refuse = (detail: string): void => { refused.add(dir); out.push({ dir, ok: false, detail }) }
      const parent = path.dirname(dir)
      if (refused.has(parent)) { refuse('its parent was refused'); continue }
      if (done.has(parent) && fs.lstatSync(parent).isSymbolicLink()) { refuse('its parent is a link'); continue }
      let st: fs.Stats | null = null
      try { st = fs.lstatSync(dir) } catch { st = null }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) { refuse('a link'); continue }
      if (!st) fs.mkdirSync(dir)
      onEach?.(dir)
      if (ok(dir)) { done.add(dir); out.push({ dir, ok: true, detail: 'owner-only' }) }
      else refuse('not this user\'s alone')
    }
    return out
  }
  return { calls, secure }
}

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

describe('writeCodexHookFile / removeCodexHookFile', () => {
  it('writes the port, session id and token, owner-only, in a folder made for the launch inside the hook root', () => {
    const root = makeRoot()
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
    const root = makeRoot()
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
    const root = makeRoot()
    const h = writeCodexHookFile('sess-2', 51234, TOKEN, root)!
    fs.writeFileSync(path.join(h.dir, 'other.txt'), 'x')
    fs.writeFileSync(path.join(h.dir, `${CODEX_HOOK_FILE_NAME}.0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60.tmp`), 'x')
    removeCodexHookFile(h)
    expect(fs.existsSync(h.file)).toBe(false)
    expect(fs.readdirSync(h.dir)).toEqual(['other.txt'])
  })

  it('touches nothing once the folder is not the one made (replaced)', () => {
    const root = makeRoot()
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
    const root = makeRoot()
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

  it('round 1 (A5): sweeps only a hook root, never another folder', () => {
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

  it('stages both files into real folders made the user\'s first, and they verify; a changed, replaced or extra-named copy does not', async () => {
    const src = scripts()
    const lad = tmp()
    const data = tmp()
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    const r = rule()
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(true)
    expect(fs.readFileSync(path.join(plain, 'ccc-codex-hook.cmd'), 'utf8')).toBe('rem wrapper')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    // Changed since it was staged.
    fs.writeFileSync(path.join(plain, 'ccc-codex-hook.js'), '// someone else')
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    // Prepared again (the next launch): whole again.
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(true)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    expect(r.calls).toHaveLength(2)
    // A copy with a second name.
    fs.linkSync(path.join(plain, 'ccc-codex-hook.cmd'), path.join(lad, 'second-name.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
  })

  it('refuses a copy folder, or its base, that is a link or junction (never handed to the rule), and a rule that does not take', async () => {
    const src = scripts()
    const lad = tmp()
    const elsewhere = tmp()
    fs.mkdirSync(path.join(lad, CODEX_HOOK_PLAIN_BASE))
    const plain = path.join(lad, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    folderLink(elsewhere, plain)
    const r = rule()
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain }, r.secure)).plain).toBe(false)
    expect(r.calls.flat()).not.toContain(plain)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.js'), path.join(elsewhere, 'ccc-codex-hook.js'))
    fs.copyFileSync(path.join(src, 'ccc-codex-hook.cmd'), path.join(elsewhere, 'ccc-codex-hook.cmd'))
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
    const lad2 = tmp()
    const base2 = tmp()
    folderLink(base2, path.join(lad2, CODEX_HOOK_PLAIN_BASE))
    const r2 = rule()
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: path.join(lad2, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345') }, r2.secure)).plain).toBe(false)
    expect(r2.calls.flat()).not.toContain(path.join(lad2, CODEX_HOOK_PLAIN_BASE))
    expect(fs.readdirSync(base2)).toEqual([])
    const lad3 = tmp()
    const plain3 = path.join(lad3, CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain3 }, rule((d) => d !== plain3).secure)).plain).toBe(false)
    expect(verifyPlainCodexHookWrapper(src, plain3)).toBe(false)
  })

  it('round 4: the check covers both levels: a base folder replaced by a link to where it went is refused, though the copy folder below it is real', async () => {
    const src = scripts()
    const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    expect((await prepareCodexHookFolders({ dataDir: tmp(), scriptsDir: src, plainDir: plain }, rule().secure)).plain).toBe(true)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(true)
    const base = path.dirname(plain)
    fs.renameSync(base, `${base}-moved`)
    folderLink(`${base}-moved`, base)
    expect(verifyPlainCodexHookWrapper(src, plain)).toBe(false)
  })
})

// Round 3b: the hook wrapper resolves its helpers from fixed locations: it
// sets NoDefaultCurrentDirectoryInExePath=1 itself before the first line that
// names a program (where, node), as the Codex launch environment does
// (spawn.ts), and asks where for node on the PATH, so node resolves the same
// way from any start folder. The forwarder stays the file beside the wrapper.
// The same order, run: tests/unit/providers/codex/hook-wrapper-start-folder.test.ts
// (CI and the VM).
describe('round 3b: the wrapper resolves node the same way from any start folder', () => {
  function wrapperLines(): string[] {
    return fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'ccc-codex-hook.cmd'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/^@?echo off$/i.test(l) && !/^rem\b/i.test(l))
  }

  it('sets NoDefaultCurrentDirectoryInExePath=1 before any line that names a program', () => {
    const lines = wrapperLines()
    const set = lines.findIndex((l) => /^set\s+"?NoDefaultCurrentDirectoryInExePath=1"?$/i.test(l))
    expect(set).toBeGreaterThanOrEqual(0)
    const firstProgram = lines.findIndex((l) => /^(where|node)\b/i.test(l))
    expect(firstProgram).toBeGreaterThan(set)
    // Before it, only the wrapper's own environment is set up.
    for (const l of lines.slice(0, set)) expect(l).toMatch(/^setlocal$/i)
  })

  it('asks for node on the PATH only, and runs the forwarder beside the wrapper', () => {
    const lines = wrapperLines()
    expect(lines.filter((l) => /^where\b/i.test(l))).toEqual(['where /q $PATH:node >nul 2>nul || exit /b 0'])
    expect(lines.filter((l) => /^node\b/i.test(l))).toEqual(['node "%~dp0ccc-codex-hook.js"'])
    expect(lines.at(-1)).toBe('exit /b 0')
  })
})

// Round 4 (P1, P2): the hook folders are prepared asynchronously, only while
// Codex is on (src/main/codex-hook-folders.ts decides when). One call of the
// owner-only rule (on Windows one PowerShell call, src/main/owner-only-folders.ts)
// makes each folder the user's and owner-only, a parent before a folder is made
// inside it, and reads each back; the two files are written only after it, and
// each folder is checked again before first use. A launch uses only a root this
// run prepared that is still the same folder.
describe('round 4: preparing the hook folders', () => {
  function scriptsDir(): string {
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.js'), '// forwarder')
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem wrapper')
    return path.join(res, 'scripts')
  }

  it('one rule call for the root, the base and the copy folder, in that order; the files only after it', async () => {
    const src = scriptsDir()
    const data = tmp()
    const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    const seen: Array<[string, string[]]> = []
    const r = rule(() => true, (dir) => { seen.push([dir, fs.existsSync(plain) ? fs.readdirSync(plain) : []]) })
    const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)
    expect(out).toMatchObject({ root: true, plain: true })
    expect(r.calls).toEqual([[root, path.dirname(plain), plain]])
    expect(seen.map(([d]) => d)).toEqual([root, path.dirname(plain), plain])
    expect(seen.every(([, files]) => files.length === 0)).toBe(true)
    expect(fs.readdirSync(plain).sort()).toEqual(['ccc-codex-hook.cmd', 'ccc-codex-hook.js'])
    expect(preparedCodexHookRoot(data)).toBe(root)
  })

  it('without a plain copy to make: the root alone', async () => {
    const data = tmp()
    const r = rule()
    const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, r.secure)
    expect(out).toMatchObject({ root: true, plain: null })
    expect(r.calls).toEqual([[path.join(data, CODEX_HOOK_ROOT_NAME)]])
  })

  it('a launch sees no root until the preparation has finished, and none when the rule refused it or failed', async () => {
    const data = tmp()
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const r = rule()
    const p = prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, async (dirs) => { await gate; return r.secure(dirs) })
    expect(preparedCodexHookRoot(data)).toBeNull()
    release()
    await p
    expect(preparedCodexHookRoot(data)).toBe(root)
    __resetCodexHookFoldersForTests()
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, rule(() => false).secure)).root).toBe(false)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, async () => { throw new Error('the rule failed') })).root).toBe(false)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders({ dataDir: 'relative', scriptsDir: scriptsDir(), plainDir: null }, rule().secure)).root).toBe(false)
  })

  it('one preparation at a time; once ready a further one asks the rule nothing; a root made again in the run is prepared again', async () => {
    const data = tmp()
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    const src = scriptsDir()
    const plan = { dataDir: data, scriptsDir: src, plainDir: null }
    // Launches at the same moment share one attempt, refused or not.
    const no = rule(() => false)
    const refused = await Promise.all([prepareCodexHookFolders(plan, no.secure), prepareCodexHookFolders(plan, no.secure)])
    expect(refused.map((o) => o.root)).toEqual([false, false])
    expect(no.calls).toHaveLength(1)
    // Round 5 (G3): that failure would be remembered for a while; start afresh.
    __resetCodexHookFoldersForTests()
    const r = rule()
    const [a, b] = await Promise.all([prepareCodexHookFolders(plan, r.secure), prepareCodexHookFolders(plan, r.secure)])
    expect(a.root && b.root).toBe(true)
    expect(r.calls).toHaveLength(1)
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(true)
    expect(r.calls).toHaveLength(1)
    // Removed and made again: another folder, not ready until prepared again.
    fs.rmdirSync(root)
    fs.mkdirSync(root)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(true)
    expect(r.calls).toHaveLength(2)
    expect(preparedCodexHookRoot(data)).toBe(root)
    // Replaced by a link: not used, and never handed to the rule.
    fs.rmdirSync(root)
    folderLink(tmp(), root)
    expect(preparedCodexHookRoot(data)).toBeNull()
    expect((await prepareCodexHookFolders(plan, r.secure)).root).toBe(false)
    expect(r.calls).toHaveLength(2)
  })

  it('a folder replaced by a link while the rule runs is refused, and nothing is made or written through it', async () => {
    const src = scriptsDir()
    for (const level of ['root', 'base', 'copy'] as const) {
      __resetCodexHookFoldersForTests()
      const data = tmp()
      const elsewhere = tmp()
      const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
      const target = level === 'root' ? path.join(data, CODEX_HOOK_ROOT_NAME) : level === 'base' ? path.dirname(plain) : plain
      const r = rule(() => true, (dir) => {
        if (dir !== target) return
        fs.renameSync(target, `${target}-moved`)
        folderLink(elsewhere, target)
      })
      const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)
      if (level === 'root') expect(out.root, level).toBe(false)
      else expect(out.plain, level).toBe(false)
      expect(fs.readdirSync(elsewhere), level).toEqual([])
    }
  })

  it('a base or copy folder that is not the user\'s alone gives no plain copy, the root still ready; not retried in the run', async () => {
    const src = scriptsDir()
    for (const refuse of ['base', 'copy'] as const) {
      __resetCodexHookFoldersForTests()
      const data = tmp()
      const plain = path.join(tmp(), CODEX_HOOK_PLAIN_BASE, 'codex-hooks-abcdef012345')
      const no = refuse === 'base' ? path.dirname(plain) : plain
      const r = rule((d) => d !== no)
      const out = await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)
      expect(out, refuse).toMatchObject({ root: true, plain: false })
      expect(verifyPlainCodexHookWrapper(src, plain), refuse).toBe(false)
      expect(fs.existsSync(path.join(plain, 'ccc-codex-hook.cmd')), refuse).toBe(false)
      await prepareCodexHookFolders({ dataDir: data, scriptsDir: src, plainDir: plain }, r.secure)
      expect(r.calls, refuse).toHaveLength(1)
    }
  })

  it('a data folder reached through a link is the user\'s choice: its own real codex-hooks is used', async () => {
    const real = tmp()
    const viaLink = path.join(tmp(), 'data-link')
    folderLink(real, viaLink)
    expect((await prepareCodexHookFolders({ dataDir: viaLink, scriptsDir: scriptsDir(), plainDir: null }, rule().secure)).root).toBe(true)
    expect(preparedCodexHookRoot(viaLink)).toBe(path.join(viaLink, CODEX_HOOK_ROOT_NAME))
    expect(realFolderChainBelow(viaLink, path.join(viaLink, CODEX_HOOK_ROOT_NAME))).toBe(true)
  })

  it('left-behind hook folders are swept once the root is ready', async () => {
    const data = tmp()
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    fs.mkdirSync(root)
    const old = fs.mkdtempSync(path.join(root, CODEX_HOOK_DIR_PREFIX))
    const past = new Date(Date.now() - CODEX_HOOK_STALE_MS - 60_000)
    fs.utimesSync(old, past, past)
    expect((await prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, rule().secure)).root).toBe(true)
    expect(fs.existsSync(old)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('POSIX: a launch applies 0700 again to the prepared root', async () => {
    const data = tmp()
    const root = path.join(data, CODEX_HOOK_ROOT_NAME)
    await prepareCodexHookFolders({ dataDir: data, scriptsDir: scriptsDir(), plainDir: null }, rule().secure)
    fs.chmodSync(root, 0o755)
    expect(preparedCodexHookRoot(data)).toBe(root)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
  })
})

// Round 5 (G3): a preparation that failed is not asked again for
// CODEX_HOOK_FOLDERS_RETRY_MS unless the folders asked for change, so a launch
// (and every change the accounts service announces) meanwhile gets the answer
// at once instead of another call of the rule.
describe('round 5: a failed preparation waits before it is tried again', () => {
  afterEach(() => { vi.useRealTimers() })

  function scriptsDir(): string {
    const res = tmp()
    fs.mkdirSync(path.join(res, 'scripts'))
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.js'), '// forwarder')
    fs.writeFileSync(path.join(res, 'scripts', 'ccc-codex-hook.cmd'), 'rem wrapper')
    return path.join(res, 'scripts')
  }

  it('the same folders: answered at once until the wait is over; other folders: asked at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 0, 0))
    const plan = { dataDir: tmp(), scriptsDir: scriptsDir(), plainDir: null }
    const no = rule(() => false)
    expect((await prepareCodexHookFolders(plan, no.secure)).root).toBe(false)
    expect(await prepareCodexHookFolders(plan, no.secure)).toMatchObject({ root: false, ran: false })
    vi.setSystemTime(Date.now() + CODEX_HOOK_FOLDERS_RETRY_MS - 1)
    expect((await prepareCodexHookFolders(plan, no.secure)).ran).toBe(false)
    expect(no.calls).toHaveLength(1)
    // Gate 3 (quality item 1, nit 3): the SAME folders, once the wait is over
    // (at exactly CODEX_HOOK_FOLDERS_RETRY_MS): the rule is asked again, and
    // the wait starts again from that answer.
    vi.setSystemTime(Date.now() + 1)
    expect(await prepareCodexHookFolders(plan, no.secure)).toMatchObject({ root: false, ran: true })
    expect(no.calls).toHaveLength(2)
    expect((await prepareCodexHookFolders(plan, no.secure)).ran).toBe(false)
    expect(no.calls).toHaveLength(2)
    // Other folders asked for: the rule is asked at once.
    expect((await prepareCodexHookFolders({ ...plan, dataDir: tmp() }, no.secure)).ran).toBe(true)
    expect(no.calls).toHaveLength(3)
    // Past the wait: asked again, and a rule that takes now gives the root.
    vi.setSystemTime(Date.now() + CODEX_HOOK_FOLDERS_RETRY_MS)
    const ok = rule()
    expect((await prepareCodexHookFolders(plan, ok.secure)).root).toBe(true)
    expect(ok.calls).toHaveLength(1)
    expect(CODEX_HOOK_FOLDERS_RETRY_MS).toBeGreaterThanOrEqual(60_000)
  })

  // Gate 3 (quality item 1, nit 4): a clock that went back (the time now is
  // before the failed answer's) never stretches the wait: the rule is asked
  // again at once.
  it('a clock that went back: the same folders are asked again at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 0, 0))
    const plan = { dataDir: tmp(), scriptsDir: scriptsDir(), plainDir: null }
    const no = rule(() => false)
    expect((await prepareCodexHookFolders(plan, no.secure)).root).toBe(false)
    expect((await prepareCodexHookFolders(plan, no.secure)).ran).toBe(false)
    expect(no.calls).toHaveLength(1)
    vi.setSystemTime(Date.now() - 1)
    expect(await prepareCodexHookFolders(plan, no.secure)).toMatchObject({ root: false, ran: true })
    expect(no.calls).toHaveLength(2)
  })
})
