/**
 * Centralized Windows registry helper with dual-key fallback.
 *
 * During the rename from "Claude Conductor" → "Claude Command Center",
 * existing installations still have values under the old key. This module
 * reads from the new key first, falls back to the old key, and auto-migrates
 * values it finds in the old key to the new key.
 *
 * The startup function `migrateRegistryKeys()` copies ALL values from the
 * old key to the new key (if the old key still exists) and then deletes it.
 */
import { execSync } from 'child_process'
import { logInfo } from './debug-logger'

const OLD_KEY = 'Software\\Claude Conductor'
const NEW_KEY = 'Software\\Claude Command Center'

/**
 * Read a registry value, trying the new key first then falling back to old.
 * If found under the old key, auto-migrates the value to the new key.
 */
export function readRegistry(valueName: string): string | null {
  if (process.platform !== 'win32') return null

  // Try new key first
  const newVal = readRegValue(NEW_KEY, valueName)
  if (newVal !== null) return newVal

  // Fall back to old key
  const oldVal = readRegValue(OLD_KEY, valueName)
  if (oldVal !== null) {
    // Auto-migrate to new key
    writeRegValue(NEW_KEY, valueName, oldVal)
    logInfo(`[registry] Migrated ${valueName} from old key to new key`)
    return oldVal
  }

  return null
}

/**
 * Write a registry value to the new key.
 */
export function writeRegistry(valueName: string, value: string): boolean {
  if (process.platform !== 'win32') return false
  return writeRegValue(NEW_KEY, valueName, value)
}

/**
 * Startup migration: copy all values from old key to new key, then delete old key.
 * Safe to call multiple times — no-ops if old key doesn't exist.
 */
export function migrateRegistryKeys(): void {
  if (process.platform !== 'win32') return

  // Check if old key exists
  const oldValues = readAllRegValues(OLD_KEY)
  if (oldValues === null) return // Old key doesn't exist, nothing to migrate

  logInfo(`[registry] Found old registry key, migrating ${Object.keys(oldValues).length} value(s)...`)

  // Copy each value to new key (don't overwrite existing new-key values)
  for (const [name, value] of Object.entries(oldValues)) {
    const existing = readRegValue(NEW_KEY, name)
    if (existing === null) {
      writeRegValue(NEW_KEY, name, value)
      logInfo(`[registry] Migrated: ${name} = ${value}`)
    }
  }

  // Delete old key
  try {
    execSync(`reg delete "HKCU\\${OLD_KEY}" /f 2>nul`, { encoding: 'utf-8' })
    logInfo('[registry] Deleted old registry key')
  } catch {
    // May fail if key is already gone
  }
}

// --- Internal helpers ---

/** Sanitize a string for safe use in a cmd.exe double-quoted argument. */
function sanitizeShellArg(s: string): string {
  // In cmd.exe double-quoted strings: " breaks out of quotes, % expands env vars,
  // ! expands with delayed expansion, \r\n can inject new commands.
  // Backslashes are NOT special in cmd.exe (needed for paths and registry keys).
  return s.replace(/["`%!\r\n]/g, '')
}

function readRegValue(key: string, valueName: string): string | null {
  try {
    const safeKey = sanitizeShellArg(key)
    const safeName = sanitizeShellArg(valueName)
    const result = execSync(
      `reg query "HKCU\\${safeKey}" /v "${safeName}" 2>nul`,
      { encoding: 'utf-8' }
    )
    const match = result.match(new RegExp(`${safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_SZ\\s+(.+)`))
    if (match && match[1].trim()) {
      return match[1].trim()
    }
  } catch { /* key/value doesn't exist */ }
  return null
}

function writeRegValue(key: string, valueName: string, value: string): boolean {
  try {
    const safeKey = sanitizeShellArg(key)
    const safeName = sanitizeShellArg(valueName)
    const safeValue = sanitizeShellArg(value)
    execSync(
      `reg add "HKCU\\${safeKey}" /v "${safeName}" /t REG_SZ /d "${safeValue}" /f`,
      { encoding: 'utf-8' }
    )
    return true
  } catch {
    return false
  }
}

function readAllRegValues(key: string): Record<string, string> | null {
  try {
    const safeKey = sanitizeShellArg(key)
    const result = execSync(
      `reg query "HKCU\\${safeKey}" 2>nul`,
      { encoding: 'utf-8' }
    )
    const values: Record<string, string> = {}
    const lines = result.split('\n')
    for (const line of lines) {
      const match = line.match(/^\s+(\S+)\s+REG_SZ\s+(.+)/)
      if (match) {
        values[match[1].trim()] = match[2].trim()
      }
    }
    return Object.keys(values).length > 0 ? values : null
  } catch {
    return null // Key doesn't exist
  }
}
