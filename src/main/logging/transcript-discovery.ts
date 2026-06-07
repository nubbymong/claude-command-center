/**
 * transcript-discovery.ts — CC-aware transcript location helpers.
 *
 * This is one of two CC-aware modules in the logging subsystem
 * (the other is transcript-normalizer.ts). Its sole responsibility is
 * "where transcript files live and which belongs to a session".
 *
 * No default export. No Electron imports — this is pure node, runnable in
 * the main process and in unit tests without any Electron ABI.
 *
 * ─── Mangle rule ────────────────────────────────────────────────────────────
 * Claude CLI stores transcripts under:
 *   <HOME>/.claude/projects/<mangled-cwd>/<conversation-uuid>.jsonl
 *
 * The mangling rule (verified 2026-06-06 against real ~/.claude/projects dirs):
 *   Replace EVERY non-alphanumeric character (including `:`, `\`, `/`, `_`, `.`, space)
 *   with a single `-`. No run-collapsing. No case change.
 *
 *   Formally: cwd.replace(/[^A-Za-z0-9]/g, '-')
 *
 * Real examples verified against the developer machine's ~/.claude/projects (2026-06-06).
 * NOTE: all four verified pairs are ASCII-only inputs/outputs. The behaviour of
 * `[^A-Za-z0-9]→'-'` for non-ASCII characters (e.g. accented letters, CJK) is an
 * unverified assumption — Claude CLI's actual handling of non-ASCII cwds is unknown.
 *   F:\CLAUDE_MULTI_APP                              → F--CLAUDE-MULTI-APP
 *     (underscore → hyphen, colon → hyphen, backslash → hyphen)
 *   f:\platform_v9                                   → f--platform-v9
 *     (lowercase drive preserved, underscore → hyphen)
 *   F:\platform_v9\.claude-worktrees\warm-toolchain  → F--platform-v9--claude-worktrees-warm-toolchain
 *     (dot → hyphen, each non-alnum replaced individually — NO run-collapsing)
 *   C:\Users\nicho                                   → C--Users-nicho
 *
 * NOTE: src/main/utils/claude-project-path.ts uses a DIFFERENT (older/looser) rule —
 * it preserves underscores and collapses separator runs. That helper serves a separate
 * feature and is intentionally NOT modified here, but the divergence is flagged.
 *
 * ─── Canonicalization ────────────────────────────────────────────────────────
 * In CCC, Claude sessions run under per-profile fake HOMEs:
 *   <resources>/account-profiles/<profileId>/
 * whose .claude/projects is a JUNCTION to the canonical
 *   os.homedir()/.claude/projects
 * Retired builds also used per-session homes:
 *   account-homes/<sessionId>/...
 * Junction paths DANGLE if a profile is deleted, so we must canonicalize
 * BEFORE storing. Canonicalization locates the LAST `.claude/projects`
 * segment and rewrites everything before it to os.homedir().
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// canonicalizeTranscriptPath
// ---------------------------------------------------------------------------

/**
 * Locates the LAST `.claude/projects` segment in the path (case-insensitive,
 * tolerating both `/` and `\` as separators) and rewrites everything before
 * it to `os.homedir()`.
 *
 * - Already-canonical paths pass through unchanged (normalized).
 * - Paths without a `.claude/projects` segment return `null`.
 */
export function canonicalizeTranscriptPath(p: string): string | null {
  if (!p) return null

  // Normalize to forward-slash for uniform matching.
  // NOTE: we do NOT lowercase the string — toLowerCase() is NOT length-preserving
  // for all Unicode code points (e.g. U+0130 İ expands to two code units when
  // lowercased), which would corrupt slice indices.  The `i` flag on the regex
  // provides case-insensitive matching without mutating the string.
  const forwardSlash = p.replace(/\\/g, '/')

  // Find the LAST occurrence of a segment-bounded `.claude/projects` pattern.
  // We iterate all matches with /g and keep the final one so that paths like
  //   /fake-home/.claude/projects/inner/.claude/projects/proj/conv.jsonl
  // resolve to `proj/conv.jsonl` (the part after the last segment), not
  // `inner/.claude/projects/proj/conv.jsonl` (after the first).
  //
  // The trailing boundary uses a LOOKAHEAD `(?=\/|$)` rather than consuming
  // `(?:\/|$)`.  This means `segEnd` always points to the character immediately
  // after `projects` (before any `/`), so we add 1 to skip the separator.
  // The lookahead also prevents adjacent-pair confusion:
  //   .../.claude/projects/.claude/projects/proj/...
  // is scanned correctly because the first match's lookahead `\/` is left for
  // the second match's leading `(?:^|\/)` anchor.
  const segmentPattern = /(?:^|\/)\.claude\/projects(?=\/|$)/gi
  let lastMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = segmentPattern.exec(forwardSlash)) !== null) {
    lastMatch = m
  }
  if (!lastMatch) return null

  // `segEnd` is the index of the character immediately after `projects`.
  // If the path ends exactly there (no trailing `/`), rest is empty.
  // Otherwise we skip the separator at segEnd and take everything after it.
  const segEnd = lastMatch.index + lastMatch[0].length
  const rest = segEnd < forwardSlash.length ? forwardSlash.slice(segEnd + 1) : ''

  // Reconstruct as canonical path under homedir, letting path.join handle
  // platform separator normalisation.
  return path.join(homedir(), '.claude', 'projects', ...(rest ? [rest] : []))
}

// ---------------------------------------------------------------------------
// mangleCwdToProjectDir
// ---------------------------------------------------------------------------

/**
 * Maps a filesystem cwd to Claude CLI's project-folder naming convention.
 *
 * Verified rule (2026-06-06) against real ~/.claude/projects on the dev machine:
 *
 *   Input                                            → Directory name
 *   ──────────────────────────────────────────────────────────────────────────
 *   F:\CLAUDE_MULTI_APP                              → F--CLAUDE-MULTI-APP
 *   f:\platform_v9                                   → f--platform-v9
 *   F:\platform_v9\.claude-worktrees\warm-toolchain  → F--platform-v9--claude-worktrees-warm-toolchain
 *   C:\Users\nicho                                   → C--Users-nicho
 *
 * Rule: replace every non-alphanumeric character individually with `-`.
 *   cwd.replace(/[^A-Za-z0-9]/g, '-')
 *
 * Key properties:
 *   - Underscores, colons, backslashes, forward-slashes, dots, spaces → `-`
 *   - No run-collapsing: `\\` → `--` (two consecutive separators = two hyphens)
 *   - Input case is preserved verbatim (no lowercasing)
 *
 * NOTE: src/main/utils/claude-project-path.ts uses a DIFFERENT (older/looser) rule
 * that preserves underscores and collapses separator runs. It serves a separate
 * feature and is intentionally NOT modified here — but the divergence is flagged
 * so callers do not conflate the two functions.
 */
export function mangleCwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// ---------------------------------------------------------------------------
// resolveResumeTargetFromTranscript (T8b — exact-conversation resume)
// ---------------------------------------------------------------------------

/**
 * From a canonical transcript path `.../<uuid>.jsonl`, derive the resume target:
 *   - `uuid`: the file's basename stem (validated UUID-ish).
 *   - `cwd` : the first JSONL line that carries a non-empty string `cwd` field
 *             (the directory the conversation actually ran in). The mangled
 *             project-folder name is LOSSY, so the real cwd can only be read
 *             back out of the transcript body — same scan used at
 *             providers/claude/telemetry.ts:213-217.
 *
 * Fail-safe: returns `null` on ANY failure (unreadable file, empty file, no
 * cwd field, non-UUID stem). Callers gate the whole resume override on a
 * non-null result, so a null here means "fall back to existing behaviour".
 *
 * `readFile` is injectable for testing; production uses `fs.readFileSync`.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function resolveResumeTargetFromTranscript(
  transcriptPath: string,
  readFile: (p: string, enc: 'utf-8') => string = (p, enc) => fs.readFileSync(p, enc),
): { uuid: string; cwd: string } | null {
  if (!transcriptPath) return null

  const uuid = path.basename(transcriptPath, '.jsonl')
  if (!uuid || !UUID_RE.test(uuid)) return null

  let text: string
  try {
    text = readFile(transcriptPath, 'utf-8')
  } catch {
    return null
  }
  if (!text) return null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj.cwd === 'string' && obj.cwd.trim()) {
        return { uuid, cwd: obj.cwd.trim() }
      }
    } catch {
      // tolerate non-JSON / partial lines and keep scanning
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// makeHeuristicBinder
// ---------------------------------------------------------------------------

export interface DiscoveryBinding {
  path: string
  confidence: 'exact' | 'heuristic'
}

interface FsImpl {
  readdirSync(dir: string): string[]
  statSync(p: string): { mtimeMs: number }
}

interface HeuristicBinderDeps {
  /** Override ~/.claude/projects root for testing */
  projectsRoot?: string
  /** Override fs operations for testing */
  fsImpl?: FsImpl
}

interface HeuristicBinder {
  /**
   * Looks in `<projectsRoot>/<mangled cwd>/` for the newest `*.jsonl` whose
   * mtime >= `startedAtMs - 60_000`.
   *
   * Returns `{ path: canonical absolute path, confidence: 'heuristic' }` or
   * `null` (no dir / no candidate).
   *
   * The returned `path` is canonicalized (prefix rewritten to `os.homedir()`)
   * when `projectsRoot` contains a `.claude/projects` segment; otherwise it
   * falls back to the `path.normalize`'d raw path (test fixtures using a plain
   * temp directory will hit the fallback).
   *
   * BIND-ONCE: a given sessionId gets AT MOST one successful heuristic binding
   * ever (in-memory Map). Repeat calls for the same sessionId return the SAME
   * stored binding (or null if first call failed — failures may retry).
   */
  bindOnce(sessionId: string, cwd: string, startedAtMs: number): DiscoveryBinding | null

  /**
   * Drops the permanent success-cache entry for a sessionId so the NEXT
   * `bindOnce(sessionId, …)` rescans from scratch instead of returning the
   * stale cached binding.
   *
   * Needed for the in-session restart flow (pty-manager reuses the same
   * sessionId): the binder's `endRun(sessionId)` calls this so "bind fresh on
   * restart" holds for the heuristic path too. Unknown sessionIds are a no-op.
   */
  forget(sessionId: string): void
}

/**
 * Creates a heuristic binder that locates transcript files by scanning the
 * project directory for the most-recently-modified `.jsonl` within the
 * session-start time window.
 *
 * Returned paths are canonicalized via {@link canonicalizeTranscriptPath}
 * when possible (i.e. when `projectsRoot` itself contains a `.claude/projects`
 * segment).  When `projectsRoot` has no such segment — as is the case for
 * temporary directories used in test fixtures — canonicalization returns
 * `null` and the binding falls back to the raw `path.normalize`'d path
 * from the injected root.
 *
 * Deps are injectable for testing; production code uses default node:fs and
 * os.homedir().
 */
export function makeHeuristicBinder(deps?: HeuristicBinderDeps): HeuristicBinder {
  const projectsRoot = deps?.projectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const fsImpl: FsImpl = deps?.fsImpl ?? {
    readdirSync: (dir) => fs.readdirSync(dir) as string[],
    statSync: (p) => fs.statSync(p),
  }

  // Successful bindings are stored permanently (BIND-ONCE).
  const successCache = new Map<string, DiscoveryBinding>()

  return {
    bindOnce(sessionId: string, cwd: string, startedAtMs: number): DiscoveryBinding | null {
      // Return existing successful binding immediately.
      const cached = successCache.get(sessionId)
      if (cached !== undefined) return cached

      // Determine the project directory for this cwd.
      const mangled = mangleCwdToProjectDir(cwd)
      const projDir = path.join(projectsRoot, mangled)

      // Try to read the directory; if it doesn't exist, return null (retry allowed).
      let entries: string[]
      try {
        entries = fsImpl.readdirSync(projDir)
      } catch {
        return null
      }

      const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'))
      if (jsonlFiles.length === 0) return null

      // The window lower bound: mtime must be >= startedAtMs - 60_000.
      const windowStart = startedAtMs - 60_000

      let bestPath: string | null = null
      let bestMtime = -Infinity

      for (const name of jsonlFiles) {
        const full = path.join(projDir, name)
        let mtime: number
        try {
          mtime = fsImpl.statSync(full).mtimeMs
        } catch {
          continue
        }
        if (mtime >= windowStart && mtime > bestMtime) {
          bestMtime = mtime
          bestPath = full
        }
      }

      if (!bestPath) return null

      // Canonicalize: rewrite everything before .claude/projects to homedir().
      // If the path is already canonical (or can't be parsed), use it as-is
      // (path.normalize ensures consistent separators).
      const canonical = canonicalizeTranscriptPath(bestPath) ?? path.normalize(bestPath)

      // Freeze before caching: guarantees identity (same reference) for BIND-ONCE
      // and makes the cached object tamper-proof.
      const binding: DiscoveryBinding = Object.freeze({ path: canonical, confidence: 'heuristic' })

      // Store the successful binding so future calls return the same value.
      successCache.set(sessionId, binding)
      return binding
    },

    forget(sessionId: string): void {
      // Drop the permanent success-cache entry so the next bindOnce rescans.
      // Unknown sessionIds: Map.delete is a harmless no-op.
      successCache.delete(sessionId)
    },
  }
}
