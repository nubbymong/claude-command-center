/**
 * Find the file a typed command line would actually run (#379).
 *
 * A command button types a line into a live shell; to say anything about the
 * program that line starts, we first have to work out which file it is. This
 * does that WITHOUT spawning `where` — spawning to answer "what would this
 * spawn" is both slow (a process per keystroke-ish probe) and the wrong shape
 * for a security-sensitive path: everything here reads, nothing executes.
 *
 * Resolution follows the Windows rules the shell would follow: a token with a
 * path separator is resolved against the working directory only; a bare name is
 * searched along PATH; either way the literal name is tried first and then each
 * PATHEXT extension in order. The `exists` predicate is injected so the unit
 * tests can lay out a virtual filesystem instead of touching disk.
 */
import * as fs from 'fs'
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
 * pipelines or understand `;` — it answers "what is the first word", and every
 * consumer treats the answer as a hint. A line whose program is `$env:TOOL` or
 * the right-hand side of a pipe simply fails to resolve, and the caller falls
 * back to the existing behaviour.
 */
export function firstToken(commandLine: string): FirstToken | null {
  if (typeof commandLine !== 'string') return null
  let s = commandLine.trim()
  if (!s) return null

  // The PowerShell call operator, and the POSIX `command`/`exec` prefixes that
  // do the same job. Only one is stripped: `& & x` is not a thing.
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
  exists?: (p: string) => boolean
}

function defaultExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
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

/**
 * The absolute path a program token resolves to, or null.
 *
 * Never throws, never spawns. A token that resolves to a directory, or to
 * nothing, is null — callers read that as "we cannot say anything about this
 * command", which is always a safe answer here because every consumer's
 * fallback is the pre-existing behaviour.
 */
export function resolveExecutable(token: string, opts: ResolveOptions): string | null {
  if (typeof token !== 'string' || token.length === 0) return null

  const platform = opts.platform ?? process.platform
  const isWindows = platform === 'win32'
  const exists = opts.exists ?? defaultExists
  // Join/resolve with the TARGET platform's rules, not the host's. In
  // production the two always agree; keeping them separate is what makes the
  // POSIX behaviour testable at all, and it removes a whole class of "works on
  // my machine" from a path-joining function.
  const pathApi = isWindows ? path.win32 : path.posix

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

  const tryCandidates = (base: string): string | null => {
    if (exists(base)) return base
    for (const ext of exts) {
      // Windows tries `name.EXT`; a token that already ends in that extension
      // was covered by the literal attempt above.
      const withExt = base + ext
      if (exists(withExt)) return withExt
    }
    return null
  }

  if (looksLikePath(token, isWindows)) {
    // Relative to the working directory, exactly as the shell would.
    let base: string
    try {
      base = pathApi.resolve(opts.cwd || '.', token)
    } catch {
      return null
    }
    return tryCandidates(base)
  }

  // A bare name. Windows searches the current directory FIRST, then PATH;
  // POSIX shells do not search the current directory at all.
  if (isWindows) {
    const local = tryCandidates(pathApi.resolve(opts.cwd || '.', token))
    if (local) return local
  }

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
    const hit = tryCandidates(base)
    if (hit) return hit
  }

  return null
}

/** Convenience: parse a command line and resolve its program in one step. */
export function resolveCommandExecutable(
  commandLine: string,
  opts: ResolveOptions,
): { token: string | null; exePath: string | null } {
  const parsed = firstToken(commandLine)
  if (!parsed) return { token: null, exePath: null }
  return { token: parsed.token, exePath: resolveExecutable(parsed.token, opts) }
}
