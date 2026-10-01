// P3.15 (row 71): which ConPTY a PTY that asks for the bundled one runs under
// on Windows. node-pty loads its native conpty module from the first of its
// build and prebuild folders that holds it, and looks for conpty.dll (which
// starts the OpenConsole.exe beside it) in a `conpty` folder next to that
// module; asking for it when either file is missing fails the spawn. So the
// bundled ConPTY is chosen only when both files are beside the module node-pty
// will load, found as its own loader finds it (in a packaged app, under
// app.asar.unpacked), and otherwise the system ConPTY, with the reason.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

const h = vi.hoisted(() => ({ warns: [] as string[] }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))

const { chooseConpty, nativeModuleDirs, onDisk, bundledConptyChoice, _resetBundledConptyForTest } = await import('../../../src/main/bundled-conpty')

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

describe('onDisk', () => {
  it('maps only an app.asar path segment, in either separator, and leaves app.asar.unpacked and look-alikes alone', () => {
    expect(onDisk('C:\\P\\resources\\app.asar\\node_modules\\x')).toBe('C:\\P\\resources\\app.asar.unpacked\\node_modules\\x')
    expect(onDisk('/r/app.asar/node_modules/x')).toBe('/r/app.asar.unpacked/node_modules/x')
    expect(onDisk('/r/app.asar.unpacked/node_modules/x')).toBe('/r/app.asar.unpacked/node_modules/x')
    expect(onDisk('/r/myapp.asar/x')).toBe('/r/myapp.asar/x')
    expect(onDisk('/r/app.asarx/x')).toBe('/r/app.asarx/x')
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
