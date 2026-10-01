/**
 * The ConPTY a PTY runs under on Windows when it asks for node-pty's bundled
 * one (P3.15, row 71).
 *
 * node-pty starts a Windows PTY on the ConPTY built into Windows, unless it is
 * given `useConptyDll: true`: then it loads the conpty.dll it ships, which
 * starts the OpenConsole.exe beside it (the console host Windows Terminal
 * ships). conpty.dll carries Microsoft's signature; in a signed release
 * electron-builder signs OpenConsole.exe again with the app's certificate, as
 * it signs every executable it packages. The console host built into Windows
 * (on the P3.15 VM, build 22621) repaints a full-screen program's scrolling
 * output in place, so the terminal fed by it keeps no scrollback; the bundled
 * one passes the scrolling through (the P3.15 VM run: 38 lines kept against
 * 122).
 *
 * node-pty looks for conpty.dll only in a `conpty` folder beside the native
 * module it loaded, and the spawn fails when the file is not there. So the
 * bundled ConPTY is chosen only when conpty.dll and OpenConsole.exe are files
 * beside the module node-pty will load, found the way node-pty's own loader
 * finds it (lib/utils.js, loadNativeModule), and only when node-pty can use
 * the path (NODE_PTY_MAX_PATH); otherwise the system ConPTY, with the reason,
 * logged once. When the files are there but still fail as a session starts,
 * pty-manager starts that session on the system ConPTY and reports it here
 * (bundledConptyFailed), so the rest of the run uses the system one. Nothing
 * here starts anything or changes what a PTY is given beyond that one option.
 */
import * as fs from 'fs'
import * as path from 'path'
import { logWarn } from './debug-logger'
import { stripSpoofableText } from '../shared/safe-text'

/** The ConPTY options a PTY is spawned with. */
export interface ConptySpawnOptions {
  useConpty: true
  useConptyDll?: true
}

/** The system ConPTY's options: what every PTY had before P3.15. */
export const SYSTEM_CONPTY_OPTIONS: ConptySpawnOptions = Object.freeze({ useConpty: true })
const BUNDLED_CONPTY_OPTIONS: ConptySpawnOptions = Object.freeze({ useConpty: true, useConptyDll: true })

export type ConptyChoice =
  | { kind: 'bundled'; options: ConptySpawnOptions; dir: string }
  | { kind: 'system'; options: ConptySpawnOptions; reason: string }
  | { kind: 'not-windows'; options: ConptySpawnOptions }

export interface ConptyChoiceDeps {
  platform: string
  arch: string
  /** node-pty's lib folder, where its loader runs from (null: not found). */
  nodePtyLibDir: string | null
  /** Whether a file is there (a folder of that name is not). */
  exists: (p: string) => boolean
}

/** node-pty's LoadConptyDll (src/win/conpty.cc) reads its own module's path
 *  into a wchar_t[MAX_PATH] (GetModuleFileNameW) and builds the path of
 *  conpty\conpty.dll beside it with PathCombineW into another
 *  wchar_t[MAX_PATH]. That path must fit with its terminating null: at most
 *  MAX_PATH - 1 characters (UTF-16 code units, which a JS string's length
 *  counts), or node-pty cannot find the file and the spawn fails. The module's
 *  own path is shorter, so the conpty.dll path is the one that binds. */
export const NODE_PTY_MAX_PATH = 260

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
export function asarUnpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/]|$)/g, '$1app.asar.unpacked')
}

/** The ConPTY for a PTY that asks for the bundled one. */
export function chooseConpty(deps: ConptyChoiceDeps): ConptyChoice {
  if (deps.platform !== 'win32') return { kind: 'not-windows', options: SYSTEM_CONPTY_OPTIONS }
  const system = (reason: string): ConptyChoice => ({ kind: 'system', options: SYSTEM_CONPTY_OPTIONS, reason })
  if (!deps.nodePtyLibDir) return system('node-pty was not found')
  const dir = nativeModuleDirs(deps.nodePtyLibDir, deps.platform, deps.arch)
    .map(asarUnpackedPath)
    .find((d) => deps.exists(path.join(d, 'conpty.node')))
  if (!dir) return system(`node-pty's conpty.node was not found for win32-${deps.arch}`)
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    const p = path.join(dir, 'conpty', file)
    if (!deps.exists(p)) return system(`${p} is missing`)
  }
  const dll = path.join(dir, 'conpty', 'conpty.dll')
  if (dll.length >= NODE_PTY_MAX_PATH) {
    return system(`the path to ${dll} is ${dll.length} characters, more than the ${NODE_PTY_MAX_PATH - 1} node-pty can use`)
  }
  return { kind: 'bundled', options: BUNDLED_CONPTY_OPTIONS, dir }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** node-pty's lib folder as the app loads node-pty (its main, lib/index.js),
 *  where node-pty's own loader looks from; null when it cannot be found. */
export function findNodePtyLibDir(): string | null {
  try { return path.dirname(require.resolve('node-pty')) } catch { return null }
}

/** A log line's reason, as the launch line shows paths: no control characters. */
const forLog = (s: string): string => stripSpoofableText(s, 600)

let depsOverride: Partial<ConptyChoiceDeps> | null = null
let cached: ConptyChoice | null = null

/** The app's choice, worked out once (the files do not come and go while it
 *  runs); a fallback on Windows is logged once. */
export function bundledConptyChoice(): ConptyChoice {
  if (cached) return cached
  const deps: ConptyChoiceDeps = {
    platform: depsOverride?.platform ?? process.platform,
    arch: depsOverride?.arch ?? process.arch,
    nodePtyLibDir: depsOverride && 'nodePtyLibDir' in depsOverride ? depsOverride.nodePtyLibDir ?? null : findNodePtyLibDir(),
    exists: depsOverride?.exists ?? isFile,
  }
  cached = chooseConpty(deps)
  if (cached.kind === 'system') {
    logWarn(`[conpty] node-pty's bundled ConPTY is not available (${forLog(cached.reason)}); the PTYs that ask for it use the system ConPTY`)
  }
  return cached
}

/**
 * P3.15 round 1 (F1): the bundled ConPTY was chosen but failed as a session
 * started (node-pty threw before any process started: conpty.dll blocked,
 * damaged or gone since, OpenConsole.exe unable to start), and that session
 * then started on the system ConPTY. The rest of the run uses the system one;
 * said once. A choice that is not the bundled one is kept as it is.
 */
export function bundledConptyFailed(reason: string): ConptyChoice {
  const current = bundledConptyChoice()
  if (current.kind !== 'bundled') return current
  cached = { kind: 'system', options: SYSTEM_CONPTY_OPTIONS, reason: `node-pty's bundled ConPTY failed to start: ${reason}` }
  logWarn(`[conpty] node-pty's bundled ConPTY failed to start (${forLog(reason)}); the PTYs that ask for it use the system ConPTY from now on`)
  return cached
}

/** Tests only: forget the choice, and work the next one out from `deps`
 *  (each part not given is the app's own: its platform and arch, node-pty
 *  found by require.resolve, and files checked as files). */
export function _resetBundledConptyForTest(deps: Partial<ConptyChoiceDeps> | null): void {
  depsOverride = deps
  cached = null
}
