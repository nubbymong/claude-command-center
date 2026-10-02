// P3.15 (row 71): which ConPTY a PTY that asks for the bundled one runs under
// on Windows. node-pty loads its native conpty module from the first of its
// build and prebuild folders that holds it, and looks for conpty.dll (which
// starts the OpenConsole.exe beside it) in a `conpty` folder next to that
// module; asking for it when either file is missing fails the spawn. So the
// bundled ConPTY is chosen only when both files are beside the module node-pty
// will load, found as its own loader finds it (in a packaged app, under
// app.asar.unpacked), and otherwise the system ConPTY, with the reason.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

const h = vi.hoisted(() => ({ warns: [] as string[] }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))

const { chooseConpty, nativeModuleDirs, asarUnpackedPath, bundledConptyChoice, bundledConptyFailed, findNodePtyLibDir, NODE_PTY_MAX_PATH, LOADED_MODULE_PREFIX, namespacedPrefixLength, _resetBundledConptyForTest } = await import('../../../src/main/bundled-conpty')

const LIB = path.join(path.sep, 'app', 'node_modules', 'node-pty', 'lib')
const PKG = path.dirname(LIB)
const PREBUILD = path.join(PKG, 'prebuilds', 'win32-x64')
const RELEASE = path.join(PKG, 'build', 'Release')
const filesIn = (dir: string, names: string[]): string[] => names.map((n) => path.join(dir, n))
const ALL = ['conpty.node', path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')]
const existsOnly = (files: string[]) => (p: string): boolean => files.includes(p)

beforeEach(() => { h.warns = [] })

describe('chooseConpty', () => {
  it('the bundled ConPTY when conpty.dll and OpenConsole.exe sit beside the prebuilt module node-pty loads', () => {
    const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL)) })
    expect(c).toEqual({ kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: PREBUILD })
  })

  it('looks where node-pty\'s loader looks, in its order: build/Release, build/Debug, then the prebuild for the platform and arch', () => {
    expect(nativeModuleDirs(LIB, 'win32', 'arm64')).toEqual([
      path.join(PKG, 'build', 'Release'), path.join(LIB, 'build', 'Release'),
      path.join(PKG, 'build', 'Debug'), path.join(LIB, 'build', 'Debug'),
      path.join(PKG, 'prebuilds', 'win32-arm64'), path.join(LIB, 'prebuilds', 'win32-arm64'),
    ])
    const arm = path.join(PKG, 'prebuilds', 'win32-arm64')
    expect(chooseConpty({ platform: 'win32', arch: 'arm64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(arm, ALL)) }))
      .toMatchObject({ kind: 'bundled', dir: arm })
  })

  it('a module built from source wins over the prebuild, and its own conpty folder decides (node-pty never looks in the prebuild then)', () => {
    const built = existsOnly([...filesIn(PREBUILD, ALL), path.join(RELEASE, 'conpty.node')])
    const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: built })
    expect(c.kind).toBe('system')
    expect(c.options).toEqual({ useConpty: true })
    expect(c.kind === 'system' && c.reason).toContain(path.join(RELEASE, 'conpty', 'conpty.dll'))
    const builtWithDll = existsOnly([...filesIn(PREBUILD, ALL), ...filesIn(RELEASE, ALL)])
    expect(chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: builtWithDll })).toMatchObject({ kind: 'bundled', dir: RELEASE })
  })

  it('the system ConPTY, with the missing file named, when conpty.dll or OpenConsole.exe is not there', () => {
    for (const missing of [path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')]) {
      const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL.filter((f) => f !== missing))) })
      expect(c.kind, missing).toBe('system')
      expect(c.options, missing).toEqual({ useConpty: true })
      expect(c.kind === 'system' && c.reason, missing).toContain(path.join(PREBUILD, missing))
    }
  })

  it('the system ConPTY when node-pty or its native module cannot be found', () => {
    expect(chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: null, exists: () => true })).toMatchObject({ kind: 'system', options: { useConpty: true } })
    const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL.slice(1))) })
    expect(c).toMatchObject({ kind: 'system', options: { useConpty: true } })
    expect(c.kind === 'system' && c.reason).toMatch(/conpty\.node/)
  })

  it('off Windows nothing is looked up and the options are what they always were', () => {
    for (const platform of ['darwin', 'linux']) {
      const exists = vi.fn(() => true)
      expect(chooseConpty({ platform, arch: 'x64', nodePtyLibDir: LIB, exists })).toEqual({ kind: 'not-windows', options: { useConpty: true } })
      expect(exists).not.toHaveBeenCalled()
    }
  })

  it('in a packaged app the files are looked for under app.asar.unpacked, where native files really are', () => {
    const asarLib = path.join(path.sep, 'opt', 'AI Code Conductor', 'resources', 'app.asar', 'node_modules', 'node-pty', 'lib')
    const unpacked = path.join(path.sep, 'opt', 'AI Code Conductor', 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
    const seen: string[] = []
    const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: asarLib, exists: (p) => { seen.push(p); return filesIn(unpacked, ALL).includes(p) } })
    expect(c).toEqual({ kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: unpacked })
    expect(seen.every((p) => !p.split(/[\\/]/).includes('app.asar'))).toBe(true)
  })
})

describe('asarUnpackedPath', () => {
  it('maps only an app.asar path segment, in either separator, and leaves app.asar.unpacked and look-alikes alone', () => {
    expect(asarUnpackedPath('C:\\P\\resources\\app.asar\\node_modules\\x')).toBe('C:\\P\\resources\\app.asar.unpacked\\node_modules\\x')
    expect(asarUnpackedPath('/r/app.asar/node_modules/x')).toBe('/r/app.asar.unpacked/node_modules/x')
    expect(asarUnpackedPath('/r/app.asar.unpacked/node_modules/x')).toBe('/r/app.asar.unpacked/node_modules/x')
    expect(asarUnpackedPath('/r/myapp.asar/x')).toBe('/r/myapp.asar/x')
    expect(asarUnpackedPath('/r/app.asarx/x')).toBe('/r/app.asarx/x')
  })
})

describe('the installed node-pty (the tree the app is built from)', () => {
  it('carries conpty.dll and OpenConsole.exe where its loader would load the win32-x64 module from', () => {
    const lib = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty', 'lib')
    const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
    expect(chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: lib, exists: isFile })).toMatchObject({ kind: 'bundled', options: { useConpty: true, useConptyDll: true } })
  })
})

describe('bundledConptyChoice (the app\'s own, worked out once)', () => {
  it('is worked out once, and a fallback on Windows is logged once', () => {
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: () => false })
    const a = bundledConptyChoice()
    const b = bundledConptyChoice()
    expect(a).toBe(b)
    expect(a.kind).toBe('system')
    expect(h.warns.length).toBe(1)
    expect(h.warns[0]).toMatch(/system ConPTY/)
  })

  it('the bundled choice, and off Windows, log nothing', () => {
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL)) })
    expect(bundledConptyChoice().kind).toBe('bundled')
    _resetBundledConptyForTest({ platform: 'linux', arch: 'x64', nodePtyLibDir: LIB, exists: () => true })
    expect(bundledConptyChoice().kind).toBe('not-windows')
    expect(h.warns).toEqual([])
  })
})

// Round 1 (F2): node-pty's LoadConptyDll (src/win/conpty.cc) reads its module's
// path into a wchar_t[MAX_PATH] and builds conpty\conpty.dll beside it with
// PathCombineW into another wchar_t[MAX_PATH]: the whole conpty.dll path must
// fit in MAX_PATH (260) with its terminating null, so 259 characters at most,
// or node-pty cannot find the file and the spawn fails (a long install folder).
// Round 2 (J4): Node loads a .node file through its \\?\ namespaced path
// (path.toNamespacedPath), so the module name Windows records, and node-pty
// reads back, is 4 characters longer than the path the app measures (the
// lens A probe: the loaded conpty.node is listed as \\?\<drive>:\...): 255 at most.
describe('a conpty.dll path too long for node-pty (round 1, F2)', () => {
  const SUFFIX = path.join(path.sep, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty', 'conpty.dll').length
  /** A lib folder whose conpty.dll path is exactly `n` characters long. */
  const at = (n: number) => {
    const base = path.join(path.sep, 'x'.repeat(n - 1 - SUFFIX))
    const lib = path.join(base, 'node_modules', 'node-pty', 'lib')
    const pre = path.join(base, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
    expect(path.join(pre, 'conpty', 'conpty.dll').length).toBe(n)
    return { lib, files: filesIn(pre, ALL) }
  }
  it('MAX_PATH is the bound node-pty has (260 with the terminating null), and the loader adds the 4-character \\?\ prefix', () => {
    expect(NODE_PTY_MAX_PATH).toBe(260)
    expect(LOADED_MODULE_PREFIX).toBe(4)
    expect(path.win32.toNamespacedPath('C:\\a\\conpty.node').length - 'C:\\a\\conpty.node'.length).toBe(LOADED_MODULE_PREFIX)
  })
  it('round 2 (J4): 255 characters: the bundled ConPTY; 256 and more (259 too): the system ConPTY, saying why', () => {
    const ok = at(255)
    expect(chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: ok.lib, exists: existsOnly(ok.files) }).kind).toBe('bundled')
    for (const n of [256, 259, 260, 300]) {
      const long = at(n)
      const c = chooseConpty({ platform: 'win32', arch: 'x64', nodePtyLibDir: long.lib, exists: existsOnly(long.files) })
      expect(c.kind, String(n)).toBe('system')
      expect(c.options, String(n)).toEqual({ useConpty: true })
      expect(c.kind === 'system' && c.reason, String(n)).toMatch(new RegExp(`is ${n} characters, ${n + 4} as Windows names the loaded module, more than the 259 node-pty can use`))
    }
  })
})

// Round 1 (F5): the app's own lookup, with no lookup or file check handed in:
// node-pty found by require.resolve, and the files checked as files.
// Round 4 (P8): the loader's prefix is longer for a UNC install (\\?\UNC\).
describe('namespacedPrefixLength (round 4, P8)', () => {
  const W = (...p: string[]) => p.join(String.fromCharCode(92))
  it('4 for a drive path, 6 for a UNC path, none for a namespaced path, as path.toNamespacedPath adds them', () => {
    const drive = W('C:', 'Program Files', 'App', 'conpty.dll')
    const unc = W('', '', 'server', 'share', 'App', 'conpty.dll')
    const named = W('', '', '?', 'C:', 'App', 'conpty.dll')
    expect(namespacedPrefixLength(drive)).toBe(4)
    expect(namespacedPrefixLength(unc)).toBe(6)
    expect(namespacedPrefixLength(named)).toBe(0)
    for (const p of [drive, unc]) expect(path.win32.toNamespacedPath(p).length - p.length, p).toBe(namespacedPrefixLength(p))
    expect(namespacedPrefixLength('/app/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll')).toBe(4)
  })
})

describe('the app\'s own lookup (round 1, F5)', () => {
  const made: string[] = []
  afterAll(() => {
    // Only the folders this file made: its own mkdtemp prefix, in the temp folder.
    for (const dir of made) {
      if (path.basename(dir).startsWith('p315-conpty-') && path.resolve(path.dirname(dir)) === path.resolve(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  // Round 2 (J2): real paths on both sides (a junctioned node_modules), and the
  // first folder node-pty's loader would load from (a tree built from source
  // loads build/Release, not the prebuild).
  const real = (p: string): string => fs.realpathSync(p)
  const isFileHere = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
  it('resolves the lib folder of node-pty, the folder its loader looks from', () => {
    expect(real(findNodePtyLibDir()!)).toBe(real(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty', 'lib')))
  })
  it('finds, by itself, the folder node-pty loads its win32-x64 module from, and its bundled ConPTY there', () => {
    const lib = findNodePtyLibDir()!
    const first = nativeModuleDirs(lib, 'win32', 'x64').map(asarUnpackedPath).find((d) => isFileHere(path.join(d, 'conpty.node')))
    expect(first).toBeDefined()
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64' })
    const c = bundledConptyChoice()
    const there = ['conpty.dll', 'OpenConsole.exe'].every((f) => isFileHere(path.join(first!, 'conpty', f)))
    if (there) {
      expect(c).toMatchObject({ kind: 'bundled', options: { useConpty: true, useConptyDll: true } })
      expect(real((c as { dir: string }).dir)).toBe(real(first!))
    } else {
      expect(c.kind).toBe('system')
      expect(c.kind === 'system' && c.reason).toContain(first!)
    }
  })
  it('a folder named conpty.dll is not the file: the system ConPTY (real folders in a temp tree)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p315-conpty-'))
    made.push(root)
    const pre = path.join(root, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
    fs.mkdirSync(path.join(pre, 'conpty', 'conpty.dll'), { recursive: true })
    fs.writeFileSync(path.join(pre, 'conpty.node'), '')
    fs.writeFileSync(path.join(pre, 'conpty', 'OpenConsole.exe'), '')
    fs.mkdirSync(path.join(root, 'node_modules', 'node-pty', 'lib'), { recursive: true })
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: path.join(root, 'node_modules', 'node-pty', 'lib') })
    const c = bundledConptyChoice()
    expect(c.kind).toBe('system')
    expect(c.kind === 'system' && c.reason).toContain(path.join(pre, 'conpty', 'conpty.dll'))
  })
})

// Round 1 (F1): the bundled ConPTY can be there and still fail when a session
// starts (a blocked or damaged file, OpenConsole.exe unable to start). pty-
// manager then starts the session on the system ConPTY and reports it here,
// so the rest of the run does not ask for the bundled one again.
describe('bundledConptyFailed (round 1, F1)', () => {
  it('turns the app\'s choice to the system ConPTY for the rest of the run, with the reason, logged once', () => {
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL)) })
    expect(bundledConptyChoice().kind).toBe('bundled')
    const c = bundledConptyFailed('Cannot launch conpty')
    expect(c.kind).toBe('system')
    expect(c.options).toEqual({ useConpty: true })
    expect(c.kind === 'system' && c.reason).toMatch(/failed to start: Cannot launch conpty/)
    expect(bundledConptyChoice()).toBe(c)
    expect(bundledConptyFailed('a second report')).toBe(c)
    expect(bundledConptyChoice()).toBe(c)
    expect(h.warns.length).toBe(1)
    expect(h.warns[0]).toMatch(/bundled ConPTY failed to start \(Cannot launch conpty\)/)
  })
  it('the warning lines carry no control characters from a reason or a path', () => {
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: existsOnly(filesIn(PREBUILD, ALL)) })
    bundledConptyChoice()
    bundledConptyFailed(`bad${String.fromCharCode(27)}[2Jthing${String.fromCharCode(7)}`)
    const odd = path.join(path.sep, `odd${String.fromCharCode(27)}]0;x`, 'node_modules', 'node-pty', 'lib')
    _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: odd, exists: (p) => p.endsWith('conpty.node') })
    bundledConptyChoice()
    expect(h.warns.length).toBe(2)
    for (const w of h.warns) expect(w).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

// Round 1 (F6): a dev install that builds node-pty from source (electron-
// rebuild) leaves build/Release/conpty.node, which node-pty loads first, with
// no conpty folder beside it; node-pty's own post-install puts it there.
describe('the dev install (round 1, F6)', () => {
  it('runs node-pty\'s post-install after electron-rebuild', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const post = pkg.scripts.postinstall
    const rebuild = post.indexOf('electron-rebuild --only=node-pty')
    const copy = post.indexOf('node node_modules/node-pty/scripts/post-install.js')
    expect(rebuild).toBeGreaterThan(-1)
    expect(copy).toBeGreaterThan(rebuild)
    expect(post.slice(rebuild, copy)).toMatch(/&&\s*$/)
  })
})
