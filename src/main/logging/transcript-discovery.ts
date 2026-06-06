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
 *   1. Replace every `:` with `-`
 *   2. Replace every run of one or more `\/` characters with a single `-`
 *   No case change; underscores are preserved verbatim.
 *
 * Real examples observed on the dev machine:
 *   F:\CLAUDE-MULTI-APP   → F--CLAUDE-MULTI-APP
 *   C:\Users\nicho        → C--Users-nicho
 *   f:\platform_v9        → f--platform_v9   (lowercase f preserved; _ preserved)
 *   /home/jane/repos/app  → -home-jane-repos-app
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

  // Normalize to forward-slash for uniform matching, then run the regex.
  // We need the LAST occurrence, so we use a global match and take the last.
  const normalized = p.replace(/\\/g, '/')

  // Match `.claude/projects` case-insensitively, capturing the rest after it.
  // We scan for ALL occurrences and take the last one.
  const pattern = /\.claude\/projects(\/.*)?$/i
  const match = normalized.match(pattern)
  if (!match) return null

  // Everything from `.claude/projects` onward (the "rest" after the prefix).
  // match[1] is the part after `.claude/projects`, e.g. `/f--x/a.jsonl` or undefined.
  const rest = match[1] ?? ''

  // Reconstruct as canonical path under homedir.
  // path.join normalizes separators for the current platform.
  const canonical = path.join(homedir(), '.claude', 'projects') + (rest ? path.normalize(rest) : '')
  return path.normalize(canonical)
}

// ---------------------------------------------------------------------------
// mangleCwdToProjectDir
// ---------------------------------------------------------------------------

/**
 * Maps a filesystem cwd to Claude CLI's project-folder naming convention,
 * replicating the rule used by `src/main/utils/claude-project-path.ts`.
 *
 * Verified mangle rule (2026-06-06) against real ~/.claude/projects dirs:
 *   F:\CLAUDE-MULTI-APP → F--CLAUDE-MULTI-APP   (real dir observed)
 *   C:\Users\nicho      → C--Users-nicho          (real dir observed)
 *   f:\platform_v9      → f--platform_v9           (case + underscores preserved)
 *
 * Steps:
 *   1. Replace every `:` with `-`
 *   2. Replace every run of one or more `\/` with a single `-`
 */
export function mangleCwdToProjectDir(cwd: string): string {
  return cwd
    .replace(/:/g, '-')
    .replace(/[/\\]+/g, '-')
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
  /** Override Date.now() for testing */
  now?: () => number
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
   * BIND-ONCE: a given sessionId gets AT MOST one successful heuristic binding
   * ever (in-memory Map). Repeat calls for the same sessionId return the SAME
   * stored binding (or null if first call failed — failures may retry).
   */
  bindOnce(sessionId: string, cwd: string, startedAtMs: number): DiscoveryBinding | null
}

/**
 * Creates a heuristic binder that locates transcript files by scanning the
 * project directory for the most-recently-modified `.jsonl` within the
 * session-start time window.
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

      const binding: DiscoveryBinding = { path: canonical, confidence: 'heuristic' }

      // Store the successful binding so future calls return the same value.
      successCache.set(sessionId, binding)
      return binding
    },
  }
}
