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
export function backupRealClaudeOnce(opts?: { homeDir?: string; resourcesDir?: string }): string | null {
  const home = opts?.homeDir ?? os.homedir()
  const root = backupRoot(opts?.resourcesDir)
  const dest = path.join(root, 'initial')
  try {
    if (fs.existsSync(dest)) return null // already have the immutable pre-feature snapshot
    fs.mkdirSync(dest, { recursive: true })

    // 1) ~/.claude.json (the global identity)
    const claudeJson = path.join(home, '.claude.json')
    if (fs.existsSync(claudeJson) && fs.statSync(claudeJson).isFile()) {
      fs.copyFileSync(claudeJson, path.join(dest, '.claude.json'))
    }

    // 2) top-level regular files in ~/.claude/ (.credentials.json, settings.json, etc.)
    const claudeDir = path.join(home, '.claude')
    if (fs.existsSync(claudeDir)) {
      const destClaude = path.join(dest, '.claude')
      fs.mkdirSync(destClaude, { recursive: true })
      for (const ent of fs.readdirSync(claudeDir, { withFileTypes: true })) {
        if (!ent.isFile()) continue // skip projects/memory/etc subdirs (large; never destructively written)
        try { fs.copyFileSync(path.join(claudeDir, ent.name), path.join(destClaude, ent.name)) }
        catch (e) { logWarn(`[backup] skip ${ent.name}: ${e}`) }
      }
    }
    logInfo(`[backup] initial Claude config snapshot written to ${dest}`)
    return dest
  } catch (e) {
    logWarn(`[backup] initial snapshot failed (non-fatal): ${e}`)
    return null
  }
}
