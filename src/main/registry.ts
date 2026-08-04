/**
 * Centralized config/registry helper with cross-platform support.
 *
 * On Windows: Uses the Windows Registry with dual-key fallback.
 * During the rename from "Claude Conductor" → "Claude Command Center",
 * existing installations still have values under the old key. This module
 * reads from the new key first, falls back to the old key, and auto-migrates
 * values it finds in the old key to the new key.
 *
 * On macOS/Linux: Uses a JSON file at ~/.claude-conductor/platform-config.json
 * as a cross-platform fallback store.
 *
 * The startup function `migrateRegistryKeys()` copies ALL values from the
 * old key to the new key (if the old key still exists) and then deletes it.
 * On non-Windows platforms it is a no-op.
 */
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { logInfo } from './debug-logger'

// Read order: current brand first, then each legacy key in reverse age. Writes
// always go to BRAND_KEY, so a FRESH install only ever creates the new-brand key
// and leaves no legacy name in the registry. An upgraded install keeps its
// existing key (harmless, and it is what a downgrade would still read) while the
// new key becomes authoritative from the first write.
const BRAND_KEY = 'Software\\AI Code Conductor'
const LEGACY_KEYS = ['Software\\Claude Command Center', 'Software\\Claude Conductor']
// The oldest key is the only one migrateRegistryKeys() deletes (unchanged
// behaviour); the intermediate key is deliberately left in place so a downgrade
// to a build that does not know BRAND_KEY still resolves the user's data dir.
const OLD_KEY = 'Software\\Claude Conductor'
const NEW_KEY = BRAND_KEY

// --- Cross-platform JSON fallback (macOS / Linux) ---

// macOS/Linux stand-in for the Windows registry. Same rule as the data
// directory: a fresh install writes under the current brand, an install that
// already has a config file keeps using it (moving it would strand the pointer
// to the user's data directory).
const BRAND_FALLBACK_DIR = join(homedir(), '.ai-code-conductor')
const LEGACY_FALLBACK_DIRS = [join(homedir(), '.claude-conductor')]

function fallbackConfigPaths(): { dir: string; file: string } {
  const brandFile = join(BRAND_FALLBACK_DIR, 'platform-config.json')
  if (existsSync(brandFile)) return { dir: BRAND_FALLBACK_DIR, file: brandFile }
  for (const dir of LEGACY_FALLBACK_DIRS) {
    const file = join(dir, 'platform-config.json')
    if (existsSync(file)) return { dir, file }
  }
  return { dir: BRAND_FALLBACK_DIR, file: brandFile }
}

function readFallbackConfig(): Record<string, string> {
  try {
    const { file } = fallbackConfigPaths()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'))
    }
  } catch {}
  return {}
}

function writeFallbackConfig(config: Record<string, string>): void {
  try {
    const { dir, file } = fallbackConfigPaths()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(config, null, 2))
  } catch {}
}

// --- Public API ---

/**
 * Read a registry value (Windows) or JSON config value (macOS/Linux).
 * On Windows, tries the new key first then falls back to the old key.
 * If found under the old key, auto-migrates the value to the new key.
 */
export function readRegistry(valueName: string): string | null {
  if (process.platform !== 'win32') {
    // Cross-platform fallback: read from JSON file
    const config = readFallbackConfig()
    return config[valueName] ?? null
  }

  // Current brand key wins.
  const newVal = readRegValue(BRAND_KEY, valueName)
  if (newVal !== null) return newVal

  // Then each legacy key, newest first. A hit is copied forward so the brand key
  // becomes authoritative, but the legacy key itself is left alone.
  for (const legacy of LEGACY_KEYS) {
    const oldVal = readRegValue(legacy, valueName)
    if (oldVal !== null) {
      writeRegValue(BRAND_KEY, valueName, oldVal)
      logInfo(`[registry] Adopted ${valueName} from "${legacy}" into the current key`)
      return oldVal
    }
  }

  return null
}

/**
 * Write a registry value (Windows) or JSON config value (macOS/Linux).
 */
export function writeRegistry(valueName: string, value: string): boolean {
  if (process.platform !== 'win32') {
    // Cross-platform fallback: write to JSON file
    try {
      const config = readFallbackConfig()
      config[valueName] = value
      writeFallbackConfig(config)
      return true
    } catch {
      return false
    }
  }
  return writeRegValue(NEW_KEY, valueName, value)
}

/**
 * Startup migration: copy all values from old key to new key, then delete old key.
 * Safe to call multiple times — no-ops if old key doesn't exist.
 * No-op on non-Windows platforms.
 */
export function migrateRegistryKeys(): void {
  if (process.platform !== 'win32') return

  // Copy anything the brand key is missing forward from the legacy keys, newest
  // first so a newer value is never overwritten by an older one.
  for (const legacy of LEGACY_KEYS) {
    const values = readAllRegValues(legacy)
    if (values === null) continue
    for (const [name, value] of Object.entries(values)) {
      if (readRegValue(BRAND_KEY, name) === null) {
        writeRegValue(BRAND_KEY, name, value)
        logInfo(`[registry] Adopted from "${legacy}": ${name} = ${value}`)
      }
    }
  }

  // Only the ORIGINAL key is deleted (unchanged from before). The intermediate
  // "Claude Command Center" key stays: an upgraded install may be rolled back to
  // a build that only knows that key, and deleting it would strand that build's
  // data-directory pointer. Fresh installs never create it in the first place.
  if (readAllRegValues(OLD_KEY) !== null) {
    try {
      execSync(`reg delete "HKCU\\${OLD_KEY}" /f 2>nul`, { encoding: 'utf-8' })
      logInfo('[registry] Deleted the original (pre-rename) registry key')
    } catch {
      // May fail if key is already gone
    }
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
