/**
 * The ConPTY a PTY runs under on Windows when it asks for node-pty's bundled
 * one (P3.15, row 71).
 *
 * node-pty starts a Windows PTY on the ConPTY built into Windows, unless it is
 * given `useConptyDll: true`: then it loads the conpty.dll it ships, which
 * starts the OpenConsole.exe beside it (the console host Windows Terminal
 * ships; both signed by Microsoft). The console host built into Windows (on
 * the P3.15 VM, build 22621) repaints a full-screen program's scrolling output
 * in place, so the terminal fed by it keeps no scrollback; the bundled one
 * passes the scrolling through (the P3.15 VM run: 38 lines kept against 122).
 *
 * node-pty looks for conpty.dll only in a `conpty` folder beside the native
 * module it loaded, and the spawn fails when the file is not there. So the
 * bundled ConPTY is chosen only when conpty.dll and OpenConsole.exe are beside
 * the module node-pty will load, found the way node-pty's own loader finds it
 * (lib/utils.js, loadNativeModule); otherwise the system ConPTY, with the
 * reason, logged once. Nothing here starts anything or changes what a PTY is
 * given beyond that one option.
 */
import * as fs from 'fs'
import * as path from 'path'
import { logWarn } from './debug-logger'

/** The ConPTY options a PTY is spawned with. */
export interface ConptySpawnOptions {
  useConpty: true
  useConptyDll?: true
}

export type ConptyChoice =
  | { kind: 'bundled'; options: ConptySpawnOptions; dir: string }
  | { kind: 'system'; options: ConptySpawnOptions; reason: string }
  | { kind: 'not-windows'; options: ConptySpawnOptions }

export interface ConptyChoiceDeps {
  platform: string
  arch: string
  /** node-pty's lib folder, where its loader runs from (null: not found). */
  nodePtyLibDir: string | null
  /** Whether a file is there. */
  exists: (p: string) => boolean
}

/** The folders node-pty's loader tries for a native module, in its order:
 *  each of build/Release, build/Debug and the prebuild for the platform and
 *  arch, beside its lib folder and then inside it. */
export function nativeModuleDirs(libDir: string, platform: string, arch: string): string[] {
  const out: string[] = []
  for (const d of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    for (const r of ['..', '.']) out.push(path.join(libDir, r, d))
  }
  return out
}

/** Where a file inside a packaged app's app.asar really is: Electron loads
 *  native modules from app.asar.unpacked, and conpty.dll is found beside the
 *  module it loaded. Only an `app.asar` path segment is mapped. */
export function onDisk(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/]|$)/g, '$1app.asar.unpacked')
}

/** The ConPTY for a PTY that asks for the bundled one. */
export function chooseConpty(deps: ConptyChoiceDeps): ConptyChoice {
  if (deps.platform !== 'win32') return { kind: 'not-windows', options: { useConpty: true } }
  const system = (reason: string): ConptyChoice => ({ kind: 'system', options: { useConpty: true }, reason })
  if (!deps.nodePtyLibDir) return system('node-pty was not found')
  const dir = nativeModuleDirs(deps.nodePtyLibDir, deps.platform, deps.arch)
    .map(onDisk)
    .find((d) => deps.exists(path.join(d, 'conpty.node')))
  if (!dir) return system(`node-pty's conpty.node was not found for win32-${deps.arch}`)
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    const p = path.join(dir, 'conpty', file)
    if (!deps.exists(p)) return system(`${p} is missing`)
  }
  return { kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function nodePtyLibDir(): string | null {
  try { return path.dirname(require.resolve('node-pty')) } catch { return null }
}

let depsOverride: ConptyChoiceDeps | null = null
let cached: ConptyChoice | null = null

/** The app's choice, worked out once (the files do not come and go while it
 *  runs); a fallback on Windows is logged once. */
export function bundledConptyChoice(): ConptyChoice {
  if (cached) return cached
  const deps = depsOverride ?? { platform: process.platform, arch: process.arch, nodePtyLibDir: nodePtyLibDir(), exists: isFile }
  cached = chooseConpty(deps)
  if (cached.kind === 'system') {
    logWarn(`[conpty] node-pty's bundled ConPTY is not available (${cached.reason}); the PTYs that ask for it use the system ConPTY`)
  }
  return cached
}

/** Tests only: forget the choice, and work the next one out from `deps`. */
export function _resetBundledConptyForTest(deps: ConptyChoiceDeps | null): void {
  depsOverride = deps
  cached = null
}
