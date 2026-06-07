/**
 * logs-wipe.ts — detection-driven, warned, one-time DELETION of the OLD CCC
 * logging artifacts (Logs v2 Task 7).
 *
 * The previous betas wrote two huge, now-orphaned stores that the new
 * transcript-only viewer never reads:
 *   - <dataDir>/logs.db (+ wal/shm/journal) — the abandoned ~21 GB byte-capture DB
 *   - <dataDir>/logs/   — the legacy ~16 GB file-log tree (<label>/<sessionId>/...)
 * plus the legacy-migration markers under
 *   - <resources>/claude-config-backups/logs-migration/ (manifest/FROZEN/import-complete)
 *
 * On first run of the new build we detect these and, AFTER the renderer shows a
 * blocking confirm modal, delete them. The flow is detection-driven + idempotent:
 * once deleted nothing is detected, so no separate "done" marker is needed.
 *
 * SAFETY (this is a DESTRUCTIVE path — discipline is mandatory):
 *   - Paths derive ONLY from getDataDirectory()/getResourcesDirectory() (registry/
 *     config-backed, structurally disjoint from ~/.claude).
 *   - executeWipe builds an explicit allowlist of absolute (path.resolve'd) paths
 *     and, before deleting ANY of them, asserts NONE resolves under
 *     `<homedir>/.claude` — it THROWS first, deleting nothing, if one would
 *     (defends a pathological dataDir-inside-home config).
 *   - It PRESERVES the one-time real-~/.claude safety backup
 *     (claude-config-backups/initial/, a SIBLING of the deleted logs-migration
 *     dir — the parent claude-config-backups is NEVER globbed/deleted), the
 *     loggingEnabled/loggingConsentSeen settings, <dataDir>/debug/,
 *     <resources>/status/, and everything under ~/.claude.
 *   - On any delete failure it throws WITHOUT writing any done-state, so the next
 *     launch simply re-detects (idempotent). It tolerates data-paths.ts recreating
 *     an empty <dataDir>/logs after the wipe.
 *   - It only DELETES the listed artifacts + clears the 2 settings keys. It copies
 *     and moves nothing.
 *
 * No electron import, no better-sqlite3 — fs + the two dir getters are injectable
 * so the core logic is fully unit-testable headlessly. No default export.
 */
import * as realFs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { getDataDirectory, getResourcesDirectory } from '../data-paths'
import { readConfig, writeConfig } from '../config-manager'

/** Settings keys cleared as part of the wipe (legacy-migration bookkeeping only). */
const SETTINGS_KEYS_TO_CLEAR = ['legacyLogsMigrated', 'legacyLogsSurfacingSeen'] as const

/** The injectable surface (fs + dir getters + settings read/clear) for tests. */
export interface WipeDeps {
  fs: Pick<typeof realFs, 'existsSync' | 'statSync' | 'readdirSync' | 'rmSync'>
  getDataDirectory: () => string
  getResourcesDirectory: () => string
  readSettings: () => Record<string, unknown>
  clearSettingsKeys: (keys: string[]) => void
}

export interface WipeInventory {
  /** True when at least one deletable artifact OR clearable settings key exists. */
  present: boolean
  /** Summed byte size of every detected artifact path (files + recursive dirs). */
  totalBytes: number
  /** Absolute, resolved paths that WOULD be deleted (only those that exist). */
  paths: string[]
  /** Settings keys that WOULD be cleared (only those currently present). */
  settingsKeys: string[]
}

export interface WipeResult {
  deletedPaths: string[]
  clearedKeys: string[]
  freedBytes: number
}

function defaultDeps(): WipeDeps {
  return {
    fs: realFs,
    getDataDirectory,
    getResourcesDirectory,
    readSettings: () => (readConfig<Record<string, unknown>>('settings') ?? {}),
    clearSettingsKeys: (keys: string[]) => {
      const settings = readConfig<Record<string, unknown>>('settings') ?? {}
      let dirty = false
      for (const k of keys) {
        if (k in settings) { delete settings[k]; dirty = true }
      }
      if (dirty) writeConfig('settings', settings)
    },
  }
}

/**
 * The FULL static allowlist of deletable artifact paths (resolved absolute),
 * regardless of whether they currently exist. The single source of truth shared
 * by detection + the wipe + the safety guard. NEVER includes a parent dir of a
 * preserved sibling (claude-config-backups is excluded; only its logs-migration
 * child is listed).
 */
function allowlistPaths(deps: WipeDeps): string[] {
  const dataDir = deps.getDataDirectory()
  const resourcesDir = deps.getResourcesDirectory()
  return [
    // <dataDir>/logs.db + glob siblings
    path.resolve(dataDir, 'logs.db'),
    path.resolve(dataDir, 'logs.db-wal'),
    path.resolve(dataDir, 'logs.db-shm'),
    path.resolve(dataDir, 'logs.db-journal'),
    // <dataDir>/logs/ legacy tree
    path.resolve(dataDir, 'logs'),
    // <resources>/claude-config-backups/logs-migration/ markers (SIBLING of the
    // preserved initial/ backup — never the parent claude-config-backups)
    path.resolve(resourcesDir, 'claude-config-backups', 'logs-migration'),
  ]
}

/** Recursively sum byte sizes of a file or directory; 0 on any unreadable path. */
function sizeOf(fs: WipeDeps['fs'], target: string): number {
  let st: realFs.Stats
  try {
    st = fs.statSync(target)
  } catch {
    return 0
  }
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let total = 0
  let entries: realFs.Dirent[]
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const ent of entries) {
    total += sizeOf(fs, path.join(target, ent.name))
  }
  return total
}

/**
 * Detect the old log artifacts. Reports the resolved paths that exist, their
 * summed bytes, and the settings keys still present. `present` is true when there
 * is anything to delete OR clear. Idempotent: tolerates an empty recreated
 * <dataDir>/logs (size 0, but still listed if the dir exists — see below).
 *
 * Note on the empty-logs edge: a recreated EMPTY <dataDir>/logs dir contributes 0
 * bytes and is NOT counted as actionable on its own, so `present` stays false
 * after a successful wipe even if data-paths.ts recreated it. We only treat a path
 * as actionable when it has content (>0 bytes) OR is a file artifact (logs.db*).
 */
export function detectOldLogArtifacts(deps: WipeDeps = defaultDeps()): WipeInventory {
  const fs = deps.fs
  const paths: string[] = []
  let totalBytes = 0

  for (const p of allowlistPaths(deps)) {
    if (!fs.existsSync(p)) continue
    const bytes = sizeOf(fs, p)
    // Tolerate a recreated EMPTY logs/ dir (data-paths.ts mkdir's it on boot):
    // an empty directory contributes nothing and is not actionable on its own.
    let isEmptyDir = false
    try {
      const st = fs.statSync(p)
      if (st.isDirectory() && bytes === 0) {
        // Empty if it has no entries (recursively zero bytes already implies no files).
        isEmptyDir = fs.readdirSync(p).length === 0
      }
    } catch { /* unreadable — treat as actionable below */ }
    if (isEmptyDir) continue
    paths.push(p)
    totalBytes += bytes
  }

  const settings = deps.readSettings()
  const settingsKeys = SETTINGS_KEYS_TO_CLEAR.filter((k) => k in settings)

  return {
    present: paths.length > 0 || settingsKeys.length > 0,
    totalBytes,
    paths,
    settingsKeys: [...settingsKeys],
  }
}

/** The forbidden root no artifact may resolve under. */
function claudeRoot(): string {
  return path.resolve(homedir(), '.claude')
}

/** True if `p` is `root` itself or anything beneath it (path-segment aware). */
function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Execute the wipe: delete the allowlist artifacts that exist, then clear the 2
 * settings keys. THROWS (deleting nothing) if any allowlist path resolves under
 * <homedir>/.claude. On any delete failure it throws WITHOUT clearing settings or
 * writing any done-state, so the next launch re-detects (idempotent).
 */
export function executeWipe(deps: WipeDeps = defaultDeps()): WipeResult {
  const fs = deps.fs
  const forbidden = claudeRoot()
  const all = allowlistPaths(deps)

  // SAFETY GATE: assert BEFORE any deletion. A pathological dataDir-inside-home
  // config could make an artifact resolve under ~/.claude; refuse the whole wipe.
  for (const p of all) {
    if (isUnder(p, forbidden)) {
      throw new Error(`logs-wipe refused: artifact path resolves under ~/.claude (${p}); aborting before any deletion`)
    }
  }

  // Tally + delete only the paths that exist. Sum sizes BEFORE deleting.
  const deletedPaths: string[] = []
  let freedBytes = 0
  for (const p of all) {
    if (!fs.existsSync(p)) continue
    const bytes = sizeOf(fs, p)
    // If a single delete fails we propagate the throw WITHOUT clearing settings or
    // recording a done-state — detection simply re-fires next launch.
    fs.rmSync(p, { recursive: true, force: true })
    deletedPaths.push(p)
    freedBytes += bytes
  }

  // Only after every artifact deleted cleanly do we clear the bookkeeping keys.
  const settings = deps.readSettings()
  const clearedKeys = SETTINGS_KEYS_TO_CLEAR.filter((k) => k in settings)
  if (clearedKeys.length > 0) deps.clearSettingsKeys([...clearedKeys])

  return { deletedPaths, clearedKeys: [...clearedKeys], freedBytes }
}
