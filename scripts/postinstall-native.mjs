#!/usr/bin/env node
// npm postinstall: get the two native modules, node-pty and better-sqlite3,
// ready for Electron.
//
// Both ship prebuilt N-API binaries, which load unchanged under every Electron.
// On Windows, CI and the release build use those prebuilds as shipped: they
// install with `npm ci --ignore-scripts` (so this script never runs there) and
// package with `--config.npmRebuild=false`. The install does the same: a module
// whose prebuild for this Windows architecture is present is not rebuilt. That
// runs the binaries that ship, and keeps a Windows machine without Visual
// Studio's Spectre-mitigated libraries (node-pty's source build needs them and
// stops at MSB8040 without them) installing cleanly. A module with no prebuild
// for this machine is still rebuilt from source. On macOS and Linux both are
// rebuilt against Electron, as CI and the release build do there. Then
// node-pty's own post-install step runs, as before (on Windows it puts the
// bundled ConPTY beside a from-source build).
//
// `npm run rebuild` still rebuilds everything from source on demand.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

export function main({ platform = process.platform, arch = process.env.npm_config_arch || process.arch } = {}) {
  const rebuild = modulesToRebuild({ platform, arch, exists: (p) => existsSync(path.join(ROOT, p)) })
  const prebuilt = NATIVE_MODULES.filter((m) => !rebuild.includes(m))
  if (prebuilt.length) {
    console.log(`[postinstall] ${prebuilt.join(' and ')}: using the prebuilt binaries shipped for ${platform}-${arch}, as CI and the release build do`)
  }
  if (rebuild.length) {
    const cli = path.join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js')
    const r = spawnSync(process.execPath, [cli, `--only=${rebuild.join(',')}`], { cwd: ROOT, stdio: 'inherit' })
    if (r.status !== 0) return r.status ?? 1
  }
  const post = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'node-pty', 'scripts', 'post-install.js')], { cwd: ROOT, stdio: 'inherit' })
  return post.status ?? 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
