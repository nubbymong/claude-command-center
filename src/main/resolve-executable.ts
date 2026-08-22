/**
 * Find the file a typed command line would actually run (#379).
 *
 * A command button types a line into a live shell; to say anything about the
 * program that line starts, we first have to work out which file it is. This
 * does that WITHOUT spawning `where` -- spawning to answer "what would this
 * spawn" is both slow (a process per probe) and the wrong shape for a
 * security-sensitive path: everything here reads, nothing executes.
 *
 * IT MUST NOT RESOLVE MORE PERMISSIVELY THAN THE SHELL IT STANDS IN FOR.
 * The shell CCC starts for a shell button is `powershell.exe`, and PowerShell
 * does NOT run `.\foo.exe` for a bare `foo` -- the current directory is not on
 * its search path. An earlier version of this file searched the cwd first "as
 * Windows does", which is cmd.exe's rule and not PowerShell's, and the effect
 * was a real capability the typed path does not have: a repo containing its own
 * `bambu-studio.exe` would be the file main spawned, silently, while typing the
 * same line in the pane ran the copy on PATH. So: a bare name is resolved on
 * PATH ONLY, and a path (anything with a separator, or a drive letter) is
 * resolved against the working directory. `.\foo` still works, because the user
 * wrote a path. (Review MAJOR-4.)
 *
 * Resolution is ASYNC and cached. `fs.statSync` down ~40 PATH entries × ~11
 * PATHEXT extensions is ~440 synchronous stats on the main event loop, per
 * button press, before anything is typed -- and this repo already treats
 * main-loop stalls as a correctness problem for PTY input. (Review MAJOR-6.)
 */
import * as fsp from 'fs/promises'
import * as path from 'path'

/** Windows' documented default when PATHEXT is unset. */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'

export interface FirstToken {
  /** The program token with any quoting removed. */
  token: string
  /** Everything after it, untouched. */
  rest: string
}

/**
 * The program token of a command line, or null when there is not one.
 *
 * The shell CCC starts on Windows is PowerShell, so three spellings have to be
 * understood: a bare token, a double-quoted path, and a single-quoted path
 * behind the `&` call operator (`& 'C:\Program Files\x\y.exe' --flag`), which is
 * how anyone pastes a path containing a space. A leading `&` on its own is the
 * call operator and is not part of the name.
 *
 * This is deliberately NOT a shell parser. It does not expand variables, follow
 * pipelines or understand `;` -- it answers "what is the first word", and every
 * consumer treats the answer as a hint. A line whose program is `$env:TOOL` or
 * the right-hand side of a pipe simply fails to resolve, and the caller falls
 * back to the existing behaviour.
 */
export function firstToken(commandLine: string): FirstToken | null {
  if (typeof commandLine !== 'string') return null
  let s = commandLine.trim()
  if (!s) return null

  // The PowerShell call operator. Only one is stripped: `& & x` is not a thing.
  if (s.startsWith('&')) s = s.slice(1).trimStart()
  if (!s) return null

  const quote = s[0]
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1)
    if (end === -1) return null // unterminated quote: not something to reason about
    const token = s.slice(1, end)
    if (!token) return null
    return { token, rest: s.slice(end + 1).trimStart() }
  }

  const m = /\s/.exec(s)
  const token = m ? s.slice(0, m.index) : s
  if (!token) return null
  return { token, rest: m ? s.slice(m.index).trimStart() : '' }
}

export interface ResolveOptions {
  cwd: string
  /** Contents of %PATH% / $PATH. */
  pathEnv?: string
  /** Contents of %PATHEXT%. Ignored off Windows. */
  pathExt?: string
  platform?: NodeJS.Platform
  /** Test seam. Default: the path names an existing regular file. */
  exists?: (p: string) => Promise<boolean>
  /** Test seam: bypass the cache entirely. */
  noCache?: boolean
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

/** True when the token names a location rather than a command to search for. */
function looksLikePath(token: string, isWindows: boolean): boolean {
  if (token.includes('/')) return true
  if (isWindows) {
    if (token.includes('\\')) return true
    if (/^[A-Za-z]:/.test(token)) return true
  }
  return false
}

interface CacheEntry {
  at: number
  result: string | null
}

/**
 * Resolutions live briefly. A button pressed repeatedly must not re-walk PATH
 * every time, but a tool installed a minute ago must still become visible
 * without a restart. Negative results are cached too -- "not installed" is the
 * expensive answer, because it is the one that walks every entry.
 */
const CACHE_TTL_MS = 30_000
const CACHE_MAX = 256
const cache = new Map<string, CacheEntry>()

/** Test seam. */
export function clearExecutableResolutionCache(): void {
  cache.clear()
}

function cacheKey(token: string, o: ResolveOptions, platform: NodeJS.Platform): string {
  return [platform, o.cwd, token, o.pathEnv ?? '', o.pathExt ?? ''].join('\u0000')
}

/**
 * The absolute path a program token resolves to, or null.
 *
 * Never throws, never spawns. A token that resolves to a directory, or to
 * nothing, is null -- callers read that as "we cannot say anything about this
 * command", which is always a safe answer here because every consumer's
 * fallback is the pre-existing behaviour.
 */
export async function resolveExecutable(token: string, opts: ResolveOptions): Promise<string | null> {
  if (typeof token !== 'string' || token.length === 0) return null

  const platform = opts.platform ?? process.platform
  const isWindows = platform === 'win32'
  const exists = opts.exists ?? defaultExists
  // Join/resolve with the TARGET platform's rules, not the host's. In
  // production the two always agree; keeping them separate is what makes the
  // POSIX behaviour testable at all, and it removes a whole class of "works on
  // my machine" from a path-joining function.
  const pathApi = isWindows ? path.win32 : path.posix

  const key = cacheKey(token, opts, platform)
  if (!opts.noCache) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result
    if (hit) cache.delete(key)
  }

  const remember = (result: string | null): string | null => {
    if (opts.noCache) return result
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: Date.now(), result })
    return result
  }

  // Extensions to try after the literal name. Only Windows resolves by
  // extension; on POSIX the name is the name.
  //
  // PATHEXT is conventionally uppercase (`.EXE`) while the files on disk are
  // not, and Windows does not care -- but this path is SHOWN to the user in the
  // warning dialog, and `bambu-studio.EXE` reads as a typo. Lowercase it.
  const exts = isWindows
    ? (opts.pathExt ?? DEFAULT_PATHEXT)
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.startsWith('.') && e.length > 1)
    : []

  const tryCandidates = async (base: string): Promise<string | null> => {
    if (await exists(base)) return base
    for (const ext of exts) {
      // Windows tries `name.EXT`; a token that already ends in that extension
      // was covered by the literal attempt above.
      const withExt = base + ext
      if (await exists(withExt)) return withExt
    }
    return null
  }

  if (looksLikePath(token, isWindows)) {
    // The user wrote a path, so resolve it against the working directory --
    // exactly as the shell would, `.\foo` included.
    let base: string
    try {
      base = pathApi.resolve(opts.cwd || '.', token)
    } catch {
      return remember(null)
    }
    return remember(await tryCandidates(base))
  }

  // A BARE NAME: PATH only, never the current directory. See the header -- the
  // cwd-first rule is cmd.exe's, and importing it here would give the capture
  // path a reach that typing the same line does not have.
  const raw = opts.pathEnv ?? ''
  const sep = isWindows ? ';' : ':'
  for (const entry of raw.split(sep)) {
    // Windows tolerates quoted PATH entries; an empty entry means "here" on
    // POSIX, which we deliberately do not honour.
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    let base: string
    try {
      base = pathApi.resolve(dir, token)
    } catch {
      continue
    }
    const hit = await tryCandidates(base)
    if (hit) return remember(hit)
  }

  return remember(null)
}

/** Convenience: parse a command line and resolve its program in one step. */
export async function resolveCommandExecutable(
  commandLine: string,
  opts: ResolveOptions,
): Promise<{ token: string | null; exePath: string | null }> {
  const parsed = firstToken(commandLine)
  if (!parsed) return { token: null, exePath: null }
  return { token: parsed.token, exePath: await resolveExecutable(parsed.token, opts) }
}
