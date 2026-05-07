/**
 * Config Manager — all CONFIG/ file I/O for the main process
 * Stores config in ResourcesDirectory/CONFIG/ so it survives uninstall/reinstall
 * and can live on a network drive for portability.
 */

import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, copyFileSync, rmSync, statSync } from 'fs'
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
  cloudAgents: 'cloud-agents.json',
  agentTemplates: 'agent-templates.json',
  agentTeams: 'agent-teams.json',
  agentTeamRuns: 'agent-team-runs.json',
  accounts: 'accounts.json',
  visionGlobal: 'vision-global.json',
  commandSections: 'command-sections.json',
  usageTracking: 'usage-tracking.json',
  commandBarUi: 'command-bar-ui.json',
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

// ── Daily safety-net backups ──
//
// CONFIG/_backups/YYYY-MM-DD/ keeps a copy of every top-level *.json in CONFIG.
// Idempotent per day, prunes to BACKUP_RETENTION_DAYS most recent. Run once at
// app startup BEFORE anything writes to CONFIG, so a destructive write on day N
// still leaves day N-1 intact.
//
// Recovery is manual (user copies files back into CONFIG/) but the data is
// always there. Designed to defend against any accidental loss — corrupted
// writes, errant tooling (incl. our own capture script), or manual mishaps.

const BACKUP_DIR_NAME = '_backups'
const BACKUP_RETENTION_DAYS = 7

export function snapshotConfig(): void {
  try {
    const configDir = getConfigDir()
    if (!existsSync(configDir)) return

    const today = new Date().toISOString().slice(0, 10)
    const backupRoot = join(configDir, BACKUP_DIR_NAME)
    const todayDir = join(backupRoot, today)

    // Once-per-day: if today's folder already exists, just prune and return.
    // Skipping the copy keeps startup fast and avoids snapshot-of-snapshot.
    if (existsSync(todayDir)) {
      pruneOldBackups(backupRoot)
      return
    }

    mkdirSync(todayDir, { recursive: true })

    let copied = 0
    for (const name of readdirSync(configDir)) {
      // Only top-level *.json. Skip the backup dir itself, .tmp/.bak/etc.
      if (name === BACKUP_DIR_NAME) continue
      if (!name.endsWith('.json')) continue
      const src = join(configDir, name)
      try {
        if (!statSync(src).isFile()) continue
        copyFileSync(src, join(todayDir, name))
        copied++
      } catch (err) {
        logError(`[config-manager] Failed to back up ${name}: ${err}`)
      }
    }

    logInfo(`[config-manager] Daily backup created: ${todayDir} (${copied} files)`)
    pruneOldBackups(backupRoot)
  } catch (err) {
    // Never let a backup failure block app startup
    logError(`[config-manager] snapshotConfig failed (non-fatal): ${err}`)
  }
}

function pruneOldBackups(backupRoot: string): void {
  try {
    if (!existsSync(backupRoot)) return
    const dailies = readdirSync(backupRoot)
      .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort()
    const toRemove = dailies.length - BACKUP_RETENTION_DAYS
    if (toRemove <= 0) return
    for (let i = 0; i < toRemove; i++) {
      const dir = join(backupRoot, dailies[i])
      try {
        rmSync(dir, { recursive: true, force: true })
        logInfo(`[config-manager] Pruned old backup: ${dir}`)
      } catch (err) {
        logError(`[config-manager] Failed to prune ${dir}: ${err}`)
      }
    }
  } catch (err) {
    logError(`[config-manager] pruneOldBackups failed: ${err}`)
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
    // On Windows, renameSync fails if target exists. Use copyFileSync (which overwrites
    // atomically) then clean up tmp. This avoids the unlink+rename window where neither
    // file exists.
    if (existsSync(filePath)) {
      copyFileSync(tmpPath, filePath)
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
    } else {
      renameSync(tmpPath, filePath)
    }
    return true
  } catch (err) {
    logError(`[config-manager] Failed to write ${key}: ${err}`)
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

  // v1.4: strip removed legacy SSH fields. shellOnly stays (it's a
  // user-meaningful "no claude" toggle for both local + ssh); the
  // others were redundant once manual flow + idle fallback became the
  // only flow.
  stripLegacySshFields(data)

  // v1.5: back-fill provider field + claudeOptions on TerminalConfig[].
  // Strips top-level Claude fields; persists back to disk only if something actually changed.
  migrateConfigsToProviderShape(data)

  logInfo(`[config-manager] Loaded all config from ${getConfigDir()}, needsMigration=${!hasData}`)
  return { data, needsMigration: !hasData }
}

// v1.5: provider-shape migration constants
const CLAUDE_FIELDS = ['model', 'effortLevel', 'legacyVersion', 'disableAutoMemory', 'flickerFree', 'powershellTool', 'agentIds'] as const

/**
 * Migrate a single TerminalConfig from the legacy flat shape to the
 * provider-namespaced shape. Pure function -- no side effects.
 *
 * - Sets provider='claude' if missing.
 * - Copies the seven Claude-specific fields into claudeOptions (if not already there).
 * - Strips those fields from the top level.
 * - Idempotent: running on a new-shape entry returns an equal-by-value object.
 */
export function migrateConfigToProviderShape(cfg: any): any {
  const out = { ...cfg }
  if (!out.provider) out.provider = 'claude'
  if (out.provider === 'claude') {
    const claudeOptions = { ...(out.claudeOptions ?? {}) }
    for (const field of CLAUDE_FIELDS) {
      if (field in out && out[field] !== undefined && claudeOptions[field] === undefined) {
        claudeOptions[field] = out[field]
      }
      delete out[field]
    }
    out.claudeOptions = claudeOptions
  }
  return out
}

/**
 * Run migrateConfigToProviderShape over every entry in data.configs[].
 * Persists back to disk only when something actually changed. Idempotent.
 */
function migrateConfigsToProviderShape(data: Record<string, unknown>): void {
  const configs = data.configs as Array<Record<string, unknown>> | null
  if (!Array.isArray(configs)) return
  let dirty = false
  const migrated: any[] = []
  for (const c of configs) {
    const out = migrateConfigToProviderShape(c)
    // Dirty if provider was absent OR any legacy top-level field was present
    if (!c.provider || CLAUDE_FIELDS.some(f => f in c)) dirty = true
    migrated.push(out)
  }
  if (dirty) {
    data.configs = migrated
    writeConfig('configs', migrated)
    logInfo('[config-manager] Migrated configs.json to provider shape')
  }
}

/**
 * Silent migration: strips `startClaudeAfter` and `connectionFlow` from
 * any persisted SSH config. Rewrites the file only if a strip happened
 * so unchanged installs stay byte-identical. Idempotent.
 */
function stripLegacySshFields(data: Record<string, unknown>): void {
  const cleaned: ConfigKey[] = []

  const cleanSshConfig = (sshConfig: Record<string, unknown> | null | undefined): boolean => {
    if (!sshConfig || typeof sshConfig !== 'object') return false
    let dirty = false
    if ('startClaudeAfter' in sshConfig) { delete sshConfig.startClaudeAfter; dirty = true }
    if ('connectionFlow' in sshConfig) { delete sshConfig.connectionFlow; dirty = true }
    return dirty
  }

  // configs.json: TerminalConfig[] with optional sshConfig per entry
  const configs = data.configs as Array<Record<string, unknown>> | null
  if (Array.isArray(configs)) {
    let dirty = false
    for (const c of configs) {
      if (cleanSshConfig(c.sshConfig as Record<string, unknown> | undefined)) dirty = true
    }
    if (dirty) { writeConfig('configs', configs); cleaned.push('configs') }
  }

  // session-state.json: { sessions: SavedSession[], ... }
  const sessionState = data.sessionState as { sessions?: Array<Record<string, unknown>> } | null
  if (sessionState && Array.isArray(sessionState.sessions)) {
    let dirty = false
    for (const s of sessionState.sessions) {
      if (cleanSshConfig(s.sshConfig as Record<string, unknown> | undefined)) dirty = true
    }
    if (dirty) { writeConfig('sessionState', sessionState); cleaned.push('sessionState') }
  }

  if (cleaned.length > 0) {
    logInfo(`[config-manager] Stripped legacy SSH fields (startClaudeAfter, connectionFlow) from: ${cleaned.join(', ')}`)
  }
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
