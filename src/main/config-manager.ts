/**
 * Config Manager — all CONFIG/ file I/O for the main process
 * Stores config in ResourcesDirectory/CONFIG/ so it survives uninstall/reinstall
 * and can live on a network drive for portability.
 */

import { join } from 'path'
import { readFileSync, existsSync, readdirSync, copyFileSync, rmSync, statSync } from 'fs'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError, logWarn } from './debug-logger'
import { atomicWriteSecure, mkdirSecure, hardenCredentialDir, hardenCredentialFile } from './account-profiles'

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
  conductorSecret: 'conductor-secret.json',
  commandSections: 'command-sections.json',
  usageTracking: 'usage-tracking.json',
  commandBarUi: 'command-bar-ui.json',
  excalidraw: 'excalidraw.json',
} as const

export type ConfigKey = keyof typeof CONFIG_FILES

/**
 * Config keys whose CONTENT is itself a credential, and which therefore must not
 * be world-readable.
 *
 * `conductorSecret` is the 32-byte token that authenticates every request to the
 * loopback Conductor MCP server. That server's own comment is explicit that
 * loopback is not an authorisation boundary and the secret is the only gate --
 * and it exposes `vision_eval`, arbitrary JS in the embedded browser. A
 * world-readable copy of it is a local privilege escalation.
 *
 * `sshCredentials` is here as defence in depth, NOT because it leaks: its values
 * are encrypted with Electron safeStorage and a cross-user reader learns only
 * which configIds have a stored credential. See credential-store.ts's threat
 * model. Tightening the mode costs nothing and removes it from the argument.
 */
const SECRET_CONFIG_KEYS = new Set<ConfigKey>(['conductorSecret', 'sshCredentials'])
const SECRET_FILE_MODE = 0o600

function modeFor(key: ConfigKey): number | undefined {
  return SECRET_CONFIG_KEYS.has(key) ? SECRET_FILE_MODE : undefined
}

/** The on-disk file NAMES of the secret configs -- used to re-harden a secret
 *  file after it is copied into a daily backup (copyFileSync preserves the
 *  source mode, but a pre-fix 0644 copy must not survive in the backup). */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set(
  [...SECRET_CONFIG_KEYS].map((k) => CONFIG_FILES[k]),
)

let _configDir: string | null = null

export function getConfigDir(): string {
  if (!_configDir) {
    _configDir = join(getResourcesDirectory(), 'CONFIG')
  }
  return _configDir
}

export function ensureConfigDir(): void {
  const dir = getConfigDir()
  const existed = existsSync(dir)
  // mkdirSecure, not a bare mkdirSync: CONFIG holds conductor-secret.json, which
  // is the ONLY thing authenticating requests to the loopback MCP server (and so
  // to vision_eval). `mkdir -p` silently accepts a pre-existing junction, so an
  // unprivileged reparse point planted here would redirect every config write --
  // the secret included -- into attacker space, where the file inherits their
  // ACL. Same class as the identity dir, which got this in GHSA-pwfw-2ggq-569x;
  // the config dir never did.
  mkdirSecure(dir)
  // 0700 on POSIX. Re-asserted on EVERY call, not only on create, because
  // existing installs were made at the umask default (0755 observed) and would
  // otherwise stay world-readable forever after an upgrade.
  hardenCredentialDir(dir)
  if (!existed) logInfo(`[config-manager] Created CONFIG directory: ${dir}`)
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

    // CONFIG holds conductor-secret.json + ssh-credentials.json, so the backup
    // subtree must be as locked down as CONFIG itself: mkdirSecure refuses a
    // planted junction on the backup path, and 0700 on both the _backups root
    // and the day folder stops another local user from even listing which
    // credentials exist (these dirs were previously created 0755).
    mkdirSecure(todayDir)
    hardenCredentialDir(backupRoot)
    hardenCredentialDir(todayDir)

    let copied = 0
    for (const name of readdirSync(configDir)) {
      // Only top-level *.json. Skip the backup dir itself, .tmp/.bak/etc.
      if (name === BACKUP_DIR_NAME) continue
      if (!name.endsWith('.json')) continue
      const src = join(configDir, name)
      try {
        if (!statSync(src).isFile()) continue
        const dest = join(todayDir, name)
        copyFileSync(src, dest)
        // copyFileSync preserves the (now 0600) source mode, but re-assert for a
        // secret file backed up from an older 0644 build before this shipped.
        if (SECRET_FILE_NAMES.has(name)) hardenCredentialFile(dest)
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
  // Fail closed on an unregistered key. join(dir, undefined) would otherwise
  // throw OUTSIDE the try below, propagating as an uncaught error rather than
  // the documented null. (This is the class of bug that silently broke the
  // 'excalidraw' key when it was missing from CONFIG_FILES.)
  const fileName = CONFIG_FILES[key]
  if (!fileName) {
    logError(`[config-manager] Refusing to read unknown config key: ${String(key)}`)
    return null
  }
  const filePath = join(getConfigDir(), fileName)
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
 * Write a config file atomically via the shared helper (#233) — staging,
 * exclusive create, the rename retry and cleanup all live in atomic-write.ts.
 *
 * Losing the Windows rename race used to return false here, silently dropping a
 * config save because a scanner held the file for a few milliseconds.
 *
 * The previous copyFileSync-when-target-exists branch truncated the destination
 * in place (same bug fixed in session-state.ts, P7.7.16).
 */
export function writeConfig(key: ConfigKey, data: unknown): boolean {
  // Fail closed on an unregistered key. The CONFIG_FILES[key] lookup ran
  // OUTSIDE the try below, so an unknown key made join(dir, undefined) throw
  // uncaught -- it surfaced to the renderer as an IPC rejection (config-saver
  // -> "Save failed") with nothing in app.log. This is exactly how the missing
  // 'excalidraw' entry stayed invisible. Guard + log so it can never be silent.
  const fileName = CONFIG_FILES[key]
  if (!fileName) {
    logError(`[config-manager] Refusing to write unknown config key: ${String(key)}`)
    return false
  }
  const filePath = join(getConfigDir(), fileName)
  try {
    // ensureConfigDir() is INSIDE the try on purpose: mkdirSecure throws when
    // CONFIG is a planted reparse point (correct -- we must never write the
    // secret into it), but writeConfig has ALWAYS returned false on failure and
    // its callers (config-saver; the cloud-agent/team persisters that run from
    // callbacks with no try/catch of their own) depend on that. Letting the
    // throw escape bricked a legit symlinked-CONFIG layout and could crash the
    // main process via the global rethrow.
    ensureConfigDir()
    // atomicWriteSecure, not a hand-rolled tmp+rename: exclusive create means a
    // link planted at the staging path is refused, AND -- the part that matters
    // here -- the mode is honoured, because open(2) applies a mode only on
    // creation. A plain writeFileSync into an existing inode silently keeps that
    // inode's permissions. Post-#233 this is a thin alias over the shared
    // atomicWriteFileSync, so it carries the wx/random-staging properties too.
    atomicWriteSecure(filePath, JSON.stringify(data, null, 2), modeFor(key))
    // Re-assert for the case the file already existed at 0644 from an older
    // build; the rename above replaces the inode, so this is belt and braces.
    if (SECRET_CONFIG_KEYS.has(key)) hardenCredentialFile(filePath)
    return true
  } catch (err) {
    // Unchanged contract: log and return false. What changed is that a transient
    // Windows rename failure is now retried instead of silently dropping the
    // save (#233), and the staging file can no longer be a planted link.
    logError(`[config-manager] Failed to write ${key}: ${err}`)
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
  try {
    ensureConfigDir()
  } catch (err) {
    // CONFIG is a planted reparse point (mkdirSecure refuses it). Fail closed:
    // hydrate empty rather than throwing (the renderer surfaces an uncaught
    // throw as a hard load failure) and rather than reading THROUGH the junction
    // (which would ingest attacker-controlled config). writeConfig likewise
    // returns false, so any migration this triggers cannot persist into it.
    logError(`[config-manager] ensureConfigDir failed during loadAll (${err}); hydrating empty`)
    return { data: {}, needsMigration: true }
  }
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
const CLAUDE_FIELDS = ['model', 'effortLevel', 'legacyVersion', 'disableAutoMemory', 'agentIds'] as const

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
    }
    out.claudeOptions = claudeOptions
  }
  // P7.7.19: strip legacy Claude fields regardless of provider so codex
  // configs with stale Claude keys converge. On Claude configs they've
  // been copied to claudeOptions above; on Codex configs they're orphan
  // cruft (Codex reads codexOptions only). Either way, removing them now
  // ensures migrateConfigsToProviderShape's dirty flag stops firing on
  // subsequent boots; otherwise configs.json would be rewritten with the
  // same shape every boot (CLAUDE_FIELDS.some(f => f in c) stays true
  // even though no work needed doing).
  for (const field of CLAUDE_FIELDS) {
    delete out[field]
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
    // P7.7.18: check writeConfig return before mutating in-memory data and
    // before logging success. If the disk write fails, leave data.configs
    // untouched so the next save attempt has a clean retry surface (and the
    // in-memory state stays consistent with what callers see on disk).
    const wrote = writeConfig('configs', migrated)
    if (wrote) {
      data.configs = migrated
      logInfo('[config-manager] Migrated configs.json to provider shape')
    } else {
      logWarn('[config-manager] Provider-shape migration computed but disk write failed; leaving in-memory data unchanged for retry on next save')
    }
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
