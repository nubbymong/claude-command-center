/**
 * [host] npm's postinstall gets node-pty and better-sqlite3 ready for Electron.
 * On Windows it uses the prebuilt binaries both packages ship, as CI and the
 * release build do (neither ever rebuilds them there), so a machine without
 * Visual Studio's Spectre-mitigated libraries installs cleanly; a module with
 * no prebuild for the machine is still rebuilt from source. macOS and Linux
 * rebuild both, as CI and the release build do there. node-pty's own
 * post-install step runs after any rebuild, a step that fails fails the
 * install, and npm starting the script runs it from a linked checkout too.
 * Local packaging takes the installed binaries as they are, as release.yml
 * does. main() runs on fake package trees with a recording stand-in for
 * spawnSync (child_process is mocked as well, for the start-up case): nothing
 * is built, spawned or installed.
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, resolve, relative, sep } from 'path'
import { modulesToRebuild, prebuildFiles, NATIVE_MODULES, main, isThisScript } from '../../../scripts/postinstall-native.mjs'
import { fakeNativeTree, recordingRunner, postInstallPath, rebuildCliPath } from '../../helpers/postinstall-native-tree'

const spawned = vi.hoisted(() => ({
  spawnSync: vi.fn((_cmd: string, args: string[]) => ({ status: /post-install\.js$/.test(String(args?.[0])) ? 3 : 0 })),
}))
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawnSync: spawned.spawnSync }))
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()), spawnSync: spawned.spawnSync }))

const ROOT = resolve(__dirname, '../../..')
const SCRIPT = join(ROOT, 'scripts', 'postinstall-native.mjs')
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

describe('main() on a fake package tree', () => {
  it('Windows with both prebuilds present: nothing is rebuilt, node-pty\'s post-install runs from the tree, and the install passes', () => {
    const root = fakeNativeTree(allWin('x64'))
    const { run, calls } = recordingRunner()
    expect(main({ platform: 'win32', arch: 'x64', root, run })).toBe(0)
    expect(calls).toEqual([{ cmd: process.execPath, args: [postInstallPath(root)], cwd: root }])
  })

  it('Windows with a prebuild missing: only that module is rebuilt with @electron/rebuild, then node-pty\'s post-install runs', () => {
    const files = allWin('x64')
    for (const [missing, only] of [['node_modules/better-sqlite3/prebuilds/win32-x64.node', 'better-sqlite3'],
      ['node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 'node-pty'], [null, 'node-pty,better-sqlite3']] as const) {
      const root = fakeNativeTree(missing === null ? [] : files.filter((f: string) => f !== missing))
      const { run, calls } = recordingRunner()
      expect(main({ platform: 'win32', arch: 'x64', root, run }), only).toBe(0)
      expect(calls, only).toEqual([
        { cmd: process.execPath, args: [rebuildCliPath(root), `--only=${only}`], cwd: root },
        { cmd: process.execPath, args: [postInstallPath(root)], cwd: root },
      ])
    }
  })

  it('macOS and Linux: both are rebuilt, then node-pty\'s post-install runs', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const root = fakeNativeTree([])
      const { run, calls } = recordingRunner()
      expect(main({ platform, arch: 'arm64', root, run }), platform).toBe(0)
      expect(calls.map((c) => c.args), platform).toEqual([[rebuildCliPath(root), '--only=node-pty,better-sqlite3'], [postInstallPath(root)]])
    }
  })

  it('a rebuild that fails, or does not exit normally, fails the install with its status, and post-install does not run', () => {
    for (const [status, code] of [[7, 7], [null, 1]] as const) {
      const root = fakeNativeTree([])
      const { run, calls } = recordingRunner({ rebuild: status })
      expect(main({ platform: 'linux', arch: 'x64', root, run }), String(status)).toBe(code)
      expect(calls.map((c) => c.args[0]), String(status)).toEqual([rebuildCliPath(root)])
    }
  })

  it('a post-install that fails, or does not exit normally, fails the install with its status', () => {
    for (const [status, code] of [[5, 5], [null, 1]] as const) {
      for (const [platform, present] of [['win32', allWin('x64')], ['linux', []]] as const) {
        const { run } = recordingRunner({ post: status })
        expect(main({ platform, arch: 'x64', root: fakeNativeTree([...present]), run }), `${platform} ${status}`).toBe(code)
      }
    }
  })
})

describe('npm starting the script runs it', () => {
  it('the script is recognised by its real path, so a checkout reached through a junction or a symlink runs it too', () => {
    const linked = join(sep, 'linked-checkout', 'scripts', 'postinstall-native.mjs')
    const realpath = (p: string) => (p === resolve(linked) ? SCRIPT : p)
    expect(isThisScript(linked, SCRIPT, realpath)).toBe(true)
    expect(isThisScript(SCRIPT, SCRIPT, realpath)).toBe(true)
    expect(isThisScript(join(ROOT, 'scripts', 'release-gate.mjs'), SCRIPT, realpath)).toBe(false)
    for (const none of [undefined, '', 42]) expect(isThisScript(none as never, SCRIPT, realpath), String(none)).toBe(false)
    expect(isThisScript(SCRIPT, SCRIPT, () => { throw new Error('ENOENT') })).toBe(false)
    // With the real file system: the script by a relative path, as npm passes it.
    expect(isThisScript(relative(process.cwd(), SCRIPT))).toBe(true)
  })

  it('loaded as the script node runs, it runs main() and its status becomes the exit code', async () => {
    // child_process is mocked for this file: first show the script's own spawnSync is the stand-in.
    spawned.spawnSync.mockClear()
    const root = fakeNativeTree(allWin('x64'))
    main({ platform: 'win32', arch: 'x64', root })
    expect(spawned.spawnSync).toHaveBeenCalledTimes(1)
    expect(spawned.spawnSync.mock.calls[0][1]).toEqual([postInstallPath(root)])

    spawned.spawnSync.mockClear()
    const argv1 = process.argv[1]
    const exitCode = process.exitCode
    process.argv[1] = SCRIPT
    try {
      vi.resetModules()
      await import('../../../scripts/postinstall-native.mjs')
      const last = spawned.spawnSync.mock.calls.at(-1)
      expect(last?.[1]).toEqual([postInstallPath(ROOT)])
      expect(process.exitCode).toBe(3)
    } finally {
      process.argv[1] = argv1
      process.exitCode = exitCode
    }
  })
})
