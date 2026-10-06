#!/usr/bin/env node
// npm postinstall: get the two native modules, node-pty and better-sqlite3,
// ready for Electron.
//
// Both ship prebuilt N-API binaries, which load unchanged under every Electron.
// On Windows, CI and the release build use those prebuilds as shipped: they
// install with `npm ci --ignore-scripts` (so this script never runs there) and
// package with `--config.npmRebuild=false`. The install does the same: a module
// whose prebuild for this Windows architecture is present is not rebuilt. On a
// clean install (`npm ci`) that runs the binaries that ship (node-pty loads a
// build/Release folder first, so one left by an earlier source build still
// wins until it is removed), and it keeps a Windows machine without Visual
// Studio's Spectre-mitigated libraries (node-pty's source build needs them and
// stops at MSB8040 without them) installing cleanly. A module with no prebuild
// for this machine is still rebuilt from source. On macOS and Linux both are
// rebuilt against Electron, as CI and the release build do there. Then
// node-pty's own post-install step runs, after any rebuild, as before (on
// Windows it puts the bundled ConPTY beside a from-source build). A rebuild or
// post-install that fails fails the install.
//
// `npm run rebuild` still rebuilds everything from source on demand; run
// `node node_modules/node-pty/scripts/post-install.js` after it on Windows
// (CONTRIBUTING.md).

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')

export const NATIVE_MODULES = ['node-pty', 'better-sqlite3']

/** The prebuilt files `mod` ships for `platform`-`arch` and loads, relative to its package folder. */
export function prebuildFiles(mod, platform, arch) {
  if (mod === 'node-pty') {
    const dir = `prebuilds/${platform}-${arch}`
    return platform === 'win32'
      ? [`${dir}/conpty.node`, `${dir}/conpty_console_list.node`, `${dir}/conpty/conpty.dll`, `${dir}/conpty/OpenConsole.exe`]
      : [`${dir}/pty.node`]
  }
  if (mod === 'better-sqlite3') return [`prebuilds/${platform}-${arch}.node`]
  return []
}

/**
 * The native modules the install rebuilds from source: on Windows only those
 * whose prebuild for this architecture is missing (`exists` takes a path
 * relative to the repo root); elsewhere both.
 */
export function modulesToRebuild({ platform, arch, exists }) {
  if (platform !== 'win32') return [...NATIVE_MODULES]
  return NATIVE_MODULES.filter((m) => !prebuildFiles(m, platform, arch).every((f) => exists(path.join('node_modules', m, f))))
}

/**
 * Prepare the native modules of the package tree at `root`: rebuild those
 * modulesToRebuild names with @electron/rebuild, then run node-pty's own
 * post-install step (after any rebuild, and when nothing was rebuilt). Returns
 * the exit status: a rebuild or post-install that fails, or cannot start,
 * fails the install. `run` starts a process (spawnSync's signature).
 *
 * @param {{ platform?: string, arch?: string, root?: string, run?: (command: string, args: string[], options: { cwd: string, stdio: 'inherit' }) => { status: number|null } }} [options]
 * @returns {number}
 */
export function main({ platform = process.platform, arch = process.env.npm_config_arch || process.arch, root = ROOT, run = spawnSync } = {}) {
  const rebuild = modulesToRebuild({ platform, arch, exists: (p) => existsSync(path.join(root, p)) })
  const prebuilt = NATIVE_MODULES.filter((m) => !rebuild.includes(m))
  if (prebuilt.length) {
    console.log(`[postinstall] ${prebuilt.join(' and ')}: using the prebuilt binaries shipped for ${platform}-${arch}, as CI and the release build do`)
  }
  if (rebuild.length) {
    const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js')
    const r = run(process.execPath, [cli, `--only=${rebuild.join(',')}`], { cwd: root, stdio: 'inherit' })
    if (r.status !== 0) return r.status ?? 1
  }
  const post = run(process.execPath, [path.join(root, 'node_modules', 'node-pty', 'scripts', 'post-install.js')], { cwd: root, stdio: 'inherit' })
  return post.status ?? 1
}

/**
 * True when `argv1` (what node was asked to run) is this script, compared by
 * real path, so a checkout reached through a junction or a symlink runs it
 * just as its real path does.
 *
 * @param {unknown} argv1
 * @param {string} [scriptPath]
 * @param {(p: string) => string} [realpath]
 * @returns {boolean}
 */
export function isThisScript(argv1, scriptPath = SCRIPT, realpath = realpathSync) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false
  try {
    return realpath(path.resolve(argv1)) === realpath(scriptPath)
  } catch {
    return false
  }
}

if (isThisScript(process.argv[1])) process.exitCode = main()
