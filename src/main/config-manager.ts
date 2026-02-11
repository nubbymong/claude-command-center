/**
 * Config Manager — all CONFIG/ file I/O for the main process
 * Stores config in ResourcesDirectory/CONFIG/ so it survives uninstall/reinstall
 * and can live on a network drive for portability.
 */

import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'fs'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'

// All config file names
const CONFIG_FILES = {
  commands: 'commands.json',
  configs: 'configs.json',
  configGroups: 'config-groups.json',
  configSections: 'config-sections.json',
  settings: 'settings.json',
  magicButtons: 'magic-buttons.json',
  appMeta: 'app-meta.json',
  sessionState: 'session-state.json',
  windowState: 'window-state.json',
  sshCredentials: 'ssh-credentials.json',
} as const

export type ConfigKey = keyof typeof CONFIG_FILES

let _configDir: string | null = null

export function getConfigDir(): string {
  if (!_configDir) {
    _configDir = join(getResourcesDirectory(), 'CONFIG')
  }
  return _configDir
}

export function ensureConfigDir(): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    logInfo(`[config-manager] Created CONFIG directory: ${dir}`)
  }
}

/**
 * Read a single config file. Returns parsed JSON or null if not found/invalid.
 */
export function readConfig<T = unknown>(key: ConfigKey): T | null {
  const filePath = join(getConfigDir(), CONFIG_FILES[key])
  try {
    if (!existsSync(filePath)) return null
    const data = readFileSync(filePath, 'utf-8')
    return JSON.parse(data) as T
  } catch (err) {
    logError(`[config-manager] Failed to read ${key}: ${err}`)
    return null
  }
}

/**
 * Write a config file atomically (write .tmp then rename).
 */
export function writeConfig(key: ConfigKey, data: unknown): boolean {
  ensureConfigDir()
  const filePath = join(getConfigDir(), CONFIG_FILES[key])
  const tmpPath = filePath + '.tmp'
  try {
    const json = JSON.stringify(data, null, 2)
    writeFileSync(tmpPath, json, 'utf-8')
    // Atomic rename — on Windows, rename fails if target exists, so unlink first
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    renameSync(tmpPath, filePath)
    return true
  } catch (err) {
    logError(`[config-manager] Failed to write ${key}: ${err}`)
    // Clean up tmp file if it exists
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* ignore */ }
    return false
  }
}

/**
 * Check if CONFIG/ directory has any config files (for migration detection).
 */
export function configHasData(): boolean {
  const dir = getConfigDir()
  if (!existsSync(dir)) return false
  try {
    const files = readdirSync(dir)
    // Check if any of the known config files exist
    return files.some(f => Object.values(CONFIG_FILES).includes(f as any))
  } catch {
    return false
  }
}

/**
 * Load all config files in one shot. Returns object keyed by config key.
 * Also returns needsMigration flag if CONFIG/ is empty.
 */
export function loadAllConfig(): { data: Record<string, unknown>; needsMigration: boolean } {
  ensureConfigDir()
  const hasData = configHasData()

  const data: Record<string, unknown> = {}
  for (const key of Object.keys(CONFIG_FILES) as ConfigKey[]) {
    data[key] = readConfig(key)
  }

  logInfo(`[config-manager] Loaded all config from ${getConfigDir()}, needsMigration=${!hasData}`)
  return { data, needsMigration: !hasData }
}

/**
 * Save a specific config key.
 */
export function saveConfig(key: ConfigKey, value: unknown): boolean {
  return writeConfig(key, value)
}

/**
 * Migrate data from localStorage (sent by renderer) into CONFIG/ files.
 * Also migrates old userData files (session-state, window-state, ssh-credentials).
 */
export function migrateFromLocalStorage(localStorageData: Record<string, unknown>): boolean {
  try {
    ensureConfigDir()

    // Map localStorage keys to config file keys
    const keyMap: Record<string, ConfigKey> = {
      'claude-multi-commands': 'commands',
      'claude-multi-configs': 'configs',
      'claude-multi-config-groups': 'configGroups',
      'claude-multi-config-sections': 'configSections',
      'claude-multi-settings': 'settings',
      'claude-multi-magic-buttons': 'magicButtons',
    }

    for (const [lsKey, configKey] of Object.entries(keyMap)) {
      const raw = localStorageData[lsKey]
      if (raw != null) {
        // localStorage data comes as strings, parse them
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        writeConfig(configKey, parsed)
        logInfo(`[config-manager] Migrated ${lsKey} → ${configKey}`)
      }
    }

    // Build appMeta from localStorage flags
    const appMeta: Record<string, unknown> = {}
    if (localStorageData['claude-conductor-setup-version']) {
      appMeta.setupVersion = localStorageData['claude-conductor-setup-version']
    }
    if (localStorageData['claude-conductor-last-seen-version']) {
      appMeta.lastSeenVersion = localStorageData['claude-conductor-last-seen-version']
    }
    if (localStorageData['claude-multi-commands-seeded-v2']) {
      appMeta.commandsSeeded = true
    }
    if (localStorageData['claude-multi-color-migration-v2']) {
      appMeta.colorMigrated = true
    }
    if (Object.keys(appMeta).length > 0) {
      writeConfig('appMeta', appMeta)
      logInfo(`[config-manager] Migrated app-meta flags`)
    }

    // Migrate old userData files if they exist
    migrateUserDataFiles()

    logInfo(`[config-manager] Migration complete`)
    return true
  } catch (err) {
    logError(`[config-manager] Migration failed: ${err}`)
    return false
  }
}

/**
 * Copy old userData files (session-state, window-state, ssh-credentials)
 * to CONFIG/ if they exist in the old location but not in CONFIG/.
 */
function migrateUserDataFiles(): void {
  // Import app lazily to avoid circular deps at module load
  const { app } = require('electron')
  const userData = app.getPath('userData')

  const filesToMigrate: Array<{ oldName: string; configKey: ConfigKey }> = [
    { oldName: 'session-state.json', configKey: 'sessionState' },
    { oldName: 'window-state.json', configKey: 'windowState' },
    { oldName: 'ssh-credentials.json', configKey: 'sshCredentials' },
  ]

  for (const { oldName, configKey } of filesToMigrate) {
    const oldPath = join(userData, oldName)
    const newPath = join(getConfigDir(), CONFIG_FILES[configKey])

    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        const content = readFileSync(oldPath, 'utf-8')
        const parsed = JSON.parse(content)
        writeConfig(configKey, parsed)
        logInfo(`[config-manager] Migrated ${oldName} from userData to CONFIG/`)
      } catch (err) {
        logError(`[config-manager] Failed to migrate ${oldName}: ${err}`)
      }
    }
  }
}
