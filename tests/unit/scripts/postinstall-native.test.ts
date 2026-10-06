/**
 * [host] npm's postinstall gets node-pty and better-sqlite3 ready for Electron.
 * On Windows it uses the prebuilt binaries both packages ship, as CI and the
 * release build do (neither ever rebuilds them there), so a machine without
 * Visual Studio's Spectre-mitigated libraries installs cleanly; a module with
 * no prebuild for the machine is still rebuilt from source. macOS and Linux
 * rebuild both, as CI and the release build do there. Local packaging takes
 * the installed binaries as they are, as release.yml does. Only the decisions
 * are tested: nothing is built, spawned or installed.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { modulesToRebuild, prebuildFiles, NATIVE_MODULES } from '../../../scripts/postinstall-native.mjs'

const ROOT = resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** A file system holding exactly `present` (paths relative to the repo root, forward slashes). */
const fsWith = (present: string[]) => (p: string) => present.includes(p.replace(/\\/g, '/'))
const allWin = (arch: string) => NATIVE_MODULES.flatMap((m: string) =>
  prebuildFiles(m, 'win32', arch).map((f: string) => `node_modules/${m}/${f}`))

describe('which native modules the install rebuilds', () => {
  it('package.json postinstall runs this script', () => {
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall-native.mjs')
    expect(NATIVE_MODULES).toEqual(['node-pty', 'better-sqlite3'])
  })

  it('Windows with both prebuilds present: nothing is rebuilt', () => {
    for (const arch of ['x64', 'arm64']) {
      expect(modulesToRebuild({ platform: 'win32', arch, exists: fsWith(allWin(arch)) }), arch).toEqual([])
    }
  })

  it('Windows with a prebuild file missing: only that module is rebuilt', () => {
    const files = allWin('x64')
    for (const missing of files) {
      const mod = missing.split('/')[1]
      expect(modulesToRebuild({ platform: 'win32', arch: 'x64', exists: fsWith(files.filter((f) => f !== missing)) }), missing).toEqual([mod])
    }
    expect(modulesToRebuild({ platform: 'win32', arch: 'x64', exists: fsWith([]) })).toEqual(['node-pty', 'better-sqlite3'])
  })

  it('Windows looks for the prebuilds of its own architecture', () => {
    expect(modulesToRebuild({ platform: 'win32', arch: 'arm64', exists: fsWith(allWin('x64')) })).toEqual(['node-pty', 'better-sqlite3'])
    expect(prebuildFiles('node-pty', 'win32', 'x64')).toEqual([
      'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe',
    ])
    expect(prebuildFiles('better-sqlite3', 'win32', 'x64')).toEqual(['prebuilds/win32-x64.node'])
  })

  it('macOS and Linux rebuild both, as CI and the release build do there', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const everything = NATIVE_MODULES.flatMap((m: string) => prebuildFiles(m, platform, 'x64').map((f: string) => `node_modules/${m}/${f}`))
      expect(modulesToRebuild({ platform, arch: 'x64', exists: fsWith(everything) }), platform).toEqual(['node-pty', 'better-sqlite3'])
    }
  })

  it('the installed packages ship every Windows x64 prebuild file the install relies on', () => {
    for (const f of allWin('x64')) expect(existsSync(join(ROOT, f)), f).toBe(true)
  })
})

describe('local packaging takes the installed native binaries as they are', () => {
  it('npm run package, package:win and package:store pass --config.npmRebuild=false, as release.yml does on Windows', () => {
    for (const s of ['package', 'package:win', 'package:store']) expect(pkg.scripts[s], s).toMatch(/electron-builder .*--config\.npmRebuild=false/)
    const releaseYml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
    expect(releaseYml).toMatch(/npx electron-builder --win --publish never --config\.npmRebuild=false/)
  })
})
