// After an install, the app finds the new tool without a restart (owner
// decision D4, 2026-10-10; ADR-024).
//
// Windows gives a program the environment it had when it started. An
// installer that adds a folder to PATH (the Node.js installer, npm's global
// folder, OpenAI's installer for its CLI) writes it to the registry, which only
// programs started afterwards read, so the running app would not find the
// tool it just installed. (Anthropic's native Claude Code installer writes
// no PATH at all: install-folder-path.ts finds that case and offers to add
// its folder.) Before a check the user asked for (Check again on the setup
// screen, Check again in Settings and the CLI help, the check after an
// install ends) main therefore reads the two values Windows builds a new
// program's PATH from, the system one and then the user's
// (windows-registry-path.ts: Windows PowerShell by its full path, every
// character intact), expands their %VARIABLES% against this process's
// environment, and APPENDS to this process's PATH each folder it does not
// have yet. Sessions and terminals started afterwards copy this process's
// environment, so they find the tool too.
//
// What a refresh never does: drop, reorder or rewrite an entry this process's
// PATH already has. It adds only a fully qualified folder (a drive or a
// share): never a relative one, one with a %VARIABLE% this process does not
// define (one created after the app started stays unexpanded and is skipped),
// a control character, or a U+FFFD.
//
// What a refresh CAN change: it is process-wide, and any provider's check
// runs it, so a folder added for one tool is on PATH for every later lookup
// of every tool. A lookup that walks PATH folder by folder finds what it
// found before, since the new folders come last. A lookup that walks by name
// does not: Claude Code is looked for as claude.exe in every PATH folder
// before claude.cmd in any (claude-cli-probe.ts, providers/claude/spawn.ts),
// so once a folder holding claude.exe is appended (Anthropic's installer's
// %USERPROFILE%\.local\bin, say), a PATH that resolved to npm's claude.cmd
// resolves to that claude.exe instead. That is the program a restart of the
// app would pick from the same PATH. Off Windows nothing is done: the CLI
// checks there read the login shell's PATH each time.
import { readRegistryPaths, registryPathFolders, windowsFolderKey, PATH_VALUE_KINDS, type RegistryPaths } from './windows-registry-path'
import { windowsPathFolderIsFullyQualified } from './providers/windows-path-names'
import { logInfo } from './debug-logger'

export { expandWindowsVariables } from './windows-registry-path'

const REPLACEMENT = String.fromCodePoint(0xfffd)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** `current` with every folder of `fresh` it does not have appended, in the
 *  order given; `current` itself is kept exactly as it is. Only fully
 *  qualified folders are added (see the header). */
export function mergeWindowsPath(current: string | undefined, fresh: readonly string[]): { value: string; added: string[] } {
  const base = current ?? ''
  const have = new Set(base.split(';').map(windowsFolderKey).filter((k) => k !== ''))
  const added: string[] = []
  for (const raw of fresh) {
    if (typeof raw !== 'string') continue
    let dir = raw.trim()
    if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
    if (dir === '' || dir.includes('%') || dir.includes(REPLACEMENT) || CONTROL.test(dir) || !windowsPathFolderIsFullyQualified(dir)) continue
    const key = windowsFolderKey(dir)
    if (have.has(key)) continue
    have.add(key)
    added.push(dir)
  }
  if (added.length === 0) return { value: base, added }
  const sep = base === '' || base.endsWith(';') ? '' : ';'
  return { value: `${base}${sep}${added.join(';')}`, added }
}

/** The key the environment already uses for PATH (process.env keeps
 *  Windows' own spelling, `Path`); `Path` when there is none. */
export function windowsPathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
}

export interface PathRefreshDeps {
  platform: string
  /** The environment whose PATH is brought up to date (this process's). */
  env: Record<string, string | undefined>
  /** The system and user PATH values as stored (windows-registry-path.ts);
   *  throws when they cannot be read. */
  readValues: () => Promise<RegistryPaths>
  /** Told once when the values cannot be read, with why. */
  onReadFailure?: (why: string) => void
}

/** Bring `env`'s PATH up to date with the registry's; the folders added. On
 *  Windows only. Values that cannot be read add nothing (and are reported
 *  once through onReadFailure); a value of a type other than REG_SZ or
 *  REG_EXPAND_SZ adds nothing of its own. */
export async function refreshWindowsPathWith(deps: PathRefreshDeps): Promise<string[]> {
  if (deps.platform !== 'win32') return []
  let values: RegistryPaths
  try {
    values = await deps.readValues()
  } catch (err) {
    deps.onReadFailure?.(err instanceof Error ? err.message : String(err))
    return []
  }
  const fresh: string[] = []
  for (const v of [values.machine, values.user]) {
    if (!v || !PATH_VALUE_KINDS.includes(v.kind)) continue
    fresh.push(...registryPathFolders(v, deps.env as NodeJS.ProcessEnv))
  }
  const pathKey = windowsPathKey(deps.env)
  const { value, added } = mergeWindowsPath(deps.env[pathKey], fresh)
  if (added.length > 0) deps.env[pathKey] = value
  return added
}

/** The real ones: this process's platform and environment, the system and
 *  user PATH read through windows-registry-path.ts, and a read that fails
 *  told to `log`, once, with why. */
export function refreshWindowsPathDeps(log: (line: string) => void = logInfo): PathRefreshDeps {
  return {
    platform: process.platform,
    env: process.env,
    readValues: () => readRegistryPaths(),
    onReadFailure: (why) => log(`[path] Could not read PATH from the registry, so nothing was added: ${why}`),
  }
}

let inFlight: Promise<string[]> | null = null

/** This process's PATH brought up to date with the registry's (Windows only;
 *  never throws). Callers that ask while a refresh runs share it. One log
 *  line when folders were added, and one when the registry could not be read. */
export function refreshWindowsPath(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  if (inFlight) return inFlight
  const run = refreshWindowsPathWith(refreshWindowsPathDeps())
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
