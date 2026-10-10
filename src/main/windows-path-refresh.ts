// After an install, the app finds the new tool without a restart (owner
// decision D4, 2026-10-10; ADR-024).
//
// Windows gives a program the environment it had when it started. An
// installer that adds a folder to PATH (Claude Code's native installer, the
// Node.js installer, npm's global folder) writes it to the registry, which
// only programs started afterwards read, so the running app would not find
// the tool it just installed. Before a check the user asked for (Retry on the
// setup screen, Check again, the check after an install tab ends) main
// therefore reads the two values Windows builds a new program's PATH from,
// the system one and then the user's, expands their %VARIABLES% against this
// process's environment, and APPENDS to this process's PATH each folder it
// does not have yet. Sessions and terminals started afterwards copy this
// process's environment, so they find the tool too.
//
// What a refresh never does: drop, reorder or rewrite an entry this process's
// PATH already has. What a program name resolves to now is what it resolves
// to afterwards; a refresh can only add folders, at the end. It adds only a
// fully qualified folder (a drive or a share): never a relative one, one with
// a %VARIABLE% that did not expand, a control character, or one that reg.exe
// could not print intact (reg.exe writes in the console code page, and a
// character it cannot carry arrives as U+FFFD). Off Windows nothing is done:
// the CLI checks there read the login shell's PATH each time.
import { execFile } from 'child_process'
import { systemTool, windowsEnvValue } from './windows-programs'
import { windowsPathFolderIsFullyQualified } from './providers/windows-path-names'
import { logInfo } from './debug-logger'

/** Where Windows keeps PATH for new programs: the system value, then the
 *  user's, in the order it joins them. */
export const REGISTRY_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const

const REPLACEMENT = String.fromCodePoint(0xfffd)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** The Path value in what `reg.exe query <key> /v Path` printed: its type and
 *  its data, or null when there is none. */
export function parseRegQueryPath(output: string): { type: 'REG_SZ' | 'REG_EXPAND_SZ'; data: string } | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+path\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/i.exec(line)
    if (m) return { type: m[1].toUpperCase() as 'REG_SZ' | 'REG_EXPAND_SZ', data: m[2] }
  }
  return null
}

/** `value` with each %NAME% the environment defines (any case) replaced by
 *  its value, as Windows expands a REG_EXPAND_SZ; any other left as written. */
export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const v = windowsEnvValue(env, name)
    return typeof v === 'string' ? v : whole
  })
}

/** One PATH entry as a folder to compare: quotes off, either slash, no
 *  trailing separator below a root, any case. */
function folderKey(entry: string): string {
  let s = entry.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim()
  s = s.replace(/\//g, '\\')
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** `current` with every folder of `fresh` it does not have appended, in the
 *  order given; `current` itself is kept exactly as it is. Only fully
 *  qualified folders are added (see the header). */
export function mergeWindowsPath(current: string | undefined, fresh: readonly string[]): { value: string; added: string[] } {
  const base = current ?? ''
  const have = new Set(base.split(';').map(folderKey).filter((k) => k !== ''))
  const added: string[] = []
  for (const raw of fresh) {
    if (typeof raw !== 'string') continue
    let dir = raw.trim()
    if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
    if (dir === '' || dir.includes('%') || dir.includes(REPLACEMENT) || CONTROL.test(dir) || !windowsPathFolderIsFullyQualified(dir)) continue
    const key = folderKey(dir)
    if (have.has(key)) continue
    have.add(key)
    added.push(dir)
  }
  if (added.length === 0) return { value: base, added }
  const sep = base === '' || base.endsWith(';') ? '' : ';'
  return { value: `${base}${sep}${added.join(';')}`, added }
}

export interface PathRefreshDeps {
  platform: string
  /** The environment whose PATH is brought up to date (this process's). */
  env: Record<string, string | undefined>
  /** What `reg.exe query <key> /v Path` printed, or null. */
  readValue: (key: string) => Promise<string | null>
}

/** Bring `env`'s PATH up to date with the registry's; the folders added. On
 *  Windows only. A value that cannot be read adds nothing of its own. */
export async function refreshWindowsPathWith(deps: PathRefreshDeps): Promise<string[]> {
  if (deps.platform !== 'win32') return []
  const fresh: string[] = []
  for (const key of REGISTRY_PATH_KEYS) {
    let out: string | null = null
    try { out = await deps.readValue(key) } catch { out = null }
    const value = typeof out === 'string' ? parseRegQueryPath(out) : null
    if (!value) continue
    const data = value.type === 'REG_EXPAND_SZ' ? expandWindowsVariables(value.data, deps.env) : value.data
    fresh.push(...data.split(';'))
  }
  // The key the environment already uses (process.env keeps Windows' own
  // spelling, `Path`); a new one only when there is none.
  const pathKey = Object.keys(deps.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
  const { value, added } = mergeWindowsPath(deps.env[pathKey], fresh)
  if (added.length > 0) deps.env[pathKey] = value
  return added
}

/** reg.exe by its full path in the system folder, with its arguments as a
 *  list (no shell), off the event loop; null when it fails or is not there. */
function readRegistryPath(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(systemTool('reg.exe'), ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : String(stdout ?? ''))
      })
    } catch {
      resolve(null)
    }
  })
}

let inFlight: Promise<string[]> | null = null

/** This process's PATH brought up to date with the registry's (Windows only;
 *  never throws). Callers that ask while a refresh runs share it. */
export function refreshWindowsPath(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  if (inFlight) return inFlight
  const run = refreshWindowsPathWith({ platform: process.platform, env: process.env, readValue: readRegistryPath })
    .then((added) => {
      if (added.length > 0) logInfo(`[path] Added to PATH from the registry: ${added.join(';')}`)
      return added
    }, () => [] as string[])
    .finally(() => { inFlight = null })
  inFlight = run
  return run
}

/** `check`, after this process's PATH is brought up to date (`refresh`). A
 *  refresh that fails still checks. */
export async function afterPathRefresh<T>(check: () => Promise<T>, refresh: () => Promise<unknown> = refreshWindowsPath): Promise<T> {
  try { await refresh() } catch { /* the check runs on the PATH there is */ }
  return check()
}
