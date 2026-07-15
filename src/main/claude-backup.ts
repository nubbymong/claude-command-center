// src/main/claude-backup.ts
// One-time safety snapshot of the user's REAL Claude config, taken before the
// multi-account feature touches anything, so the original login is always
// recoverable. Strictly READ-ONLY on the real home: it only copies OUT of
// ~/.claude(.json) into a separate backup dir, never writes/deletes the source.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logInfo, logWarn } from './debug-logger'
import { getResourcesDirectory } from './ipc/setup-handlers'

/** Where backups live: a CCC-managed dir SEPARATE from account-profiles/account-homes
 *  (the feature never writes here), so a feature bug cannot touch the backup. */
function backupRoot(resourcesDir?: string): string {
  return path.join(resourcesDir ?? getResourcesDirectory(), 'claude-config-backups')
}

/**
 * Take a ONE-TIME snapshot of the real Claude config. Idempotent: if the initial
 * backup already exists, it is left untouched (we never overwrite the original
 * pre-feature snapshot). Copies ~/.claude.json plus every REGULAR FILE directly
 * inside ~/.claude/ (NOT the big subdirs projects/memory/etc -- those are shared
 * junction targets the feature never destructively writes). Returns the backup
 * dir path, or null if nothing was backed up. Params injectable for tests.
 */
// Files that MUST be captured if they exist at the source for the snapshot to
// count as complete. A failed/partial copy of either (e.g. a transient lock)
// fails the whole attempt so it retries next boot, rather than latching an
// incomplete snapshot as the immutable recovery net forever.
const CRITICAL_CLAUDE_DIR_FILES = ['.credentials.json'] as const

export function backupRealClaudeOnce(opts?: { homeDir?: string; resourcesDir?: string }): string | null {
  const home = opts?.homeDir ?? os.homedir()
  const root = backupRoot(opts?.resourcesDir)
  const dest = path.join(root, 'initial')
  // `initial/` only ever appears via the atomic rename at the END of a fully
  // successful snapshot, so its presence (not a bare half-written dir) is the
  // 'backup done' marker. A crashed/partial attempt leaves only `initial.tmp`,
  // which we clear + retry below.
  if (fs.existsSync(dest)) return null

  const staging = path.join(root, 'initial.tmp')
  try {
    // Clear any stale staging dir from a prior crashed attempt so we start clean.
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })

    const present: string[] = []

    // 1) ~/.claude.json (the global identity). If it exists at source it MUST copy.
    const claudeJson = path.join(home, '.claude.json')
    if (fs.existsSync(claudeJson) && fs.statSync(claudeJson).isFile()) {
      fs.copyFileSync(claudeJson, path.join(staging, '.claude.json'))
      present.push('.claude.json')
    }

    // 2) top-level regular files in ~/.claude/ (.credentials.json, settings.json, etc.)
    const claudeDir = path.join(home, '.claude')
    if (fs.existsSync(claudeDir)) {
      const destClaude = path.join(staging, '.claude')
      fs.mkdirSync(destClaude, { recursive: true })
      for (const ent of fs.readdirSync(claudeDir, { withFileTypes: true })) {
        if (!ent.isFile()) continue // skip projects/memory/etc subdirs (large; never destructively written)
        const isCritical = (CRITICAL_CLAUDE_DIR_FILES as readonly string[]).includes(ent.name)
        try {
          fs.copyFileSync(path.join(claudeDir, ent.name), path.join(destClaude, ent.name))
          present.push(`.claude/${ent.name}`)
        } catch (e) {
          // A critical file that EXISTS at source but fails to copy fails the
          // whole attempt (retry next boot). A non-critical file may be skipped.
          if (isCritical) throw new Error(`critical file ${ent.name} could not be backed up: ${e}`)
          logWarn(`[backup] skip ${ent.name}: ${e}`)
        }
      }
    }

    // Record what was captured so a reader can tell a complete snapshot from an
    // (impossible-now) empty one, and write it INSIDE the staging dir.
    fs.writeFileSync(
      path.join(staging, '.backup-complete.json'),
      JSON.stringify({ capturedAt: Date.now(), present }, null, 2),
    )

    // Atomic publish: rename staging -> initial only now that every copy succeeded.
    fs.renameSync(staging, dest)
    logInfo(`[backup] initial Claude config snapshot written to ${dest} (files: ${present.length})`)
    return dest
  } catch (e) {
    // Leave NO `initial/` behind so the next boot retries. Clear the staging dir.
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* best-effort */ }
    logWarn(`[backup] initial snapshot failed (non-fatal, will retry next boot): ${e}`)
    return null
  }
}
