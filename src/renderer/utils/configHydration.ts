import { useCommandStore, DEFAULT_COMMANDS, CustomCommand, CommandSection } from '../stores/commandStore'
import { useConfigStore } from '../stores/configStore'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { useTipsStore, UsageTracking } from '../stores/tipsStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import { useAgentLibraryStore } from '../stores/agentLibraryStore'
import { useTeamStore } from '../stores/teamStore'
import { useCommandBarStore } from '../stores/commandBarStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { migrateColorRecords } from './migrateIdentityColors'

/**
 * Ids of built-in commands that have been retired and must be removed from any
 * persisted command list on hydrate. `builtin-setup-statusline` was the old
 * "Setup Statusline" command; CCC now auto-configures the statusline on install.
 */
const RETIRED_COMMAND_IDS = new Set(['builtin-setup-statusline'])

/**
 * One-time cleanup of retired built-in commands from a persisted list. Keyed on
 * stable built-in ids so a user's own command can never be removed (user
 * commands use generated ids). Returns the SAME array reference when nothing
 * changed, so callers can cheaply detect a no-op.
 */
export function removeRetiredCommands(commands: CustomCommand[]): CustomCommand[] {
  const filtered = commands.filter((c) => !RETIRED_COMMAND_IDS.has(c.id))
  return filtered.length === commands.length ? commands : filtered
}

/**
 * Gather all relevant localStorage keys for migration to CONFIG/.
 */
export function gatherLocalStorageData(): Record<string, string> {
  const keys = [
    'claude-multi-commands',
    'claude-multi-commands-seeded-v2',
    'claude-multi-configs',
    'claude-multi-config-groups',
    'claude-multi-config-sections',
    'claude-multi-settings',
    'claude-multi-magic-buttons',
    'claude-multi-color-migration-v2',
    'claude-conductor-setup-version',
    'claude-conductor-last-seen-version',
  ]
  const data: Record<string, string> = {}
  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value != null) {
      data[key] = value
    }
  }
  return data
}

/**
 * Migrate commands that have arguments baked into the prompt field.
 * Splits prompt into base command + defaultArgs for script-based commands.
 * Only runs once — skips if any command already has defaultArgs.
 */
function migrateCommandArgs(commands: CustomCommand[]): CustomCommand[] {
  // Skip if already migrated (any command has defaultArgs defined)
  if (commands.some((c) => c.defaultArgs !== undefined)) {
    return commands
  }

  return commands.map((cmd) => {
    const prompt = cmd.prompt

    // Skip plain text prompts (not script paths)
    // Heuristic: if it doesn't contain a file extension like .ps1, .sh, .bat, .cmd, .py, .js
    // and doesn't start with powershell/pwsh/cmd/bash, treat as text prompt
    const isScript = /\.(ps1|sh|bat|cmd|py|js|exe)\b/i.test(prompt) ||
      /^(powershell|pwsh|cmd|bash)\s/i.test(prompt)
    if (!isScript) return cmd

    // Handle powershell -ExecutionPolicy Bypass -File "path" args...
    const psWrapperMatch = prompt.match(
      /^(powershell(?:\.exe)?)\s+(-ExecutionPolicy\s+\S+\s+)?-File\s+("(?:[^"]+)"|'(?:[^']+)'|\S+)\s*(.*)/i
    )
    if (psWrapperMatch) {
      const psCmd = psWrapperMatch[1]
      const execPolicy = psWrapperMatch[2] || ''
      const scriptPath = psWrapperMatch[3]
      const argsStr = (psWrapperMatch[4] || '').trim()

      const basePrompt = `${psCmd} ${execPolicy}-File ${scriptPath}`.replace(/\s+/g, ' ').trim()

      if (!argsStr) return cmd // No args to extract

      const args = splitArgs(argsStr)
      if (args.length === 0) return cmd

      return { ...cmd, prompt: basePrompt, defaultArgs: args }
    }

    // Handle direct .ps1 script paths: path\script.ps1 -Flag -Key Value
    const directPs1Match = prompt.match(/^(\S+\.ps1)\s+(.*)/i)
    if (directPs1Match) {
      const scriptPath = directPs1Match[1]
      const argsStr = directPs1Match[2].trim()

      if (!argsStr) return cmd

      const args = splitArgs(argsStr)
      if (args.length === 0) return cmd

      return { ...cmd, prompt: scriptPath, defaultArgs: args }
    }

    // Handle other script types with arguments after the script path
    const genericScriptMatch = prompt.match(/^(\S+\.(?:sh|bat|cmd|py|js|exe))\s+(.*)/i)
    if (genericScriptMatch) {
      const scriptPath = genericScriptMatch[1]
      const argsStr = genericScriptMatch[2].trim()

      if (!argsStr) return cmd

      const args = splitArgs(argsStr)
      if (args.length === 0) return cmd

      return { ...cmd, prompt: scriptPath, defaultArgs: args }
    }

    return cmd
  })
}

/**
 * Split an argument string into individual argument tokens.
 * Handles -Flag, -Key Value, and positional args.
 */
function splitArgs(argsStr: string): string[] {
  const args: string[] = []
  const tokens = argsStr.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.startsWith('-')) {
      // Check if next token is a value (not another flag)
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        args.push(`${token} ${tokens[i + 1]}`)
        i += 2
      } else {
        args.push(token)
        i++
      }
    } else {
      // Positional argument
      args.push(token)
      i++
    }
  }
  return args
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * P2.4 hydration guard for an ARRAY config section. Absent (undefined/null)
 * sections default to [] silently (a section being unset is normal). A present
 * non-array section, or array entries that are not plain objects, are dropped
 * with a warning so corrupt JSON can never feed a non-object shape into a store.
 * Valid entries pass through UNTOUCHED — there is no field-level schema here, so
 * this can never drop a real, fully-shaped config record (boot-path safety).
 */
export function coerceArray(raw: unknown, section: string, warnings: string[]): Record<string, unknown>[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    warnings.push(`section "${section}" was not an array (got ${typeof raw}) and was reset`)
    return []
  }
  const valid = raw.filter(isPlainObject) as Record<string, unknown>[]
  const dropped = raw.length - valid.length
  if (dropped > 0) {
    warnings.push(`dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} from section "${section}"`)
  }
  return valid
}

/**
 * P2.4 hydration guard for an OBJECT config section. Absent sections default to
 * {} silently; a present non-object (incl. array) section defaults to {} with a
 * warning. Otherwise the object passes through untouched.
 */
export function coerceObject(raw: unknown, section: string, warnings: string[]): Record<string, unknown> {
  if (raw == null) return {}
  if (!isPlainObject(raw)) {
    warnings.push(`section "${section}" was not an object (got ${Array.isArray(raw) ? 'array' : typeof raw}) and was reset`)
    return {}
  }
  return raw
}

/**
 * Hydrate all stores from loaded config data.
 *
 * P2.4: every section is structurally validated at this boundary (the raw JSON
 * was previously trusted via `as any`). Validation is intentionally permissive —
 * it fails open per section (corrupt -> default + warning) and never applies a
 * field-level schema, so a valid config record is never dropped. Existing
 * per-section defaults are preserved exactly.
 */
export function hydrateStores(configData: Record<string, unknown>): void {
  const warnings: string[] = []

  // commands keep their seeded default when the section is entirely absent.
  let commands: CustomCommand[] = configData.commands == null
    ? [...DEFAULT_COMMANDS]
    : (coerceArray(configData.commands, 'commands', warnings) as unknown as CustomCommand[])
  // Run one-time migration to split args out of prompt field
  const migrated = migrateCommandArgs(commands)
  if (migrated !== commands) {
    commands = migrated
    // Save migrated commands back
    window.electronAPI.config.save('commands', commands)
    console.log('[configHydration] Migrated command args from prompt field')
  }
  // One-time cleanup: drop retired built-in commands (currently the legacy
  // "Setup Statusline") from existing persisted configs so they stop appearing.
  const cleaned = removeRetiredCommands(commands)
  if (cleaned !== commands) {
    commands = cleaned
    window.electronAPI.config.save('commands', commands)
    console.log('[configHydration] Removed retired built-in command(s)')
  }
  const commandSections = coerceArray(configData.commandSections, 'commandSections', warnings) as unknown as CommandSection[]
  useCommandStore.getState().hydrate(commands, commandSections)

  const configs = coerceArray(configData.configs, 'configs', warnings)
  const groups = coerceArray(configData.configGroups, 'configGroups', warnings)
  const sections = coerceArray(configData.configSections, 'configSections', warnings)
  useConfigStore.getState().hydrate(configs as any, groups as any, sections as any)

  const magicButtons = coerceObject(configData.magicButtons, 'magicButtons', warnings)
  useMagicButtonStore.getState().hydrate(magicButtons as any)

  const settings = coerceObject(configData.settings, 'settings', warnings)
  useSettingsStore.getState().hydrate(settings as any)

  const appMeta = coerceObject(configData.appMeta, 'appMeta', warnings)
  useAppMetaStore.getState().hydrate(appMeta as any)

  const cloudAgents = coerceArray(configData.cloudAgents, 'cloudAgents', warnings)
  useCloudAgentStore.getState().hydrate(cloudAgents as any)

  const agentTemplates = coerceArray(configData.agentTemplates, 'agentTemplates', warnings)
  useAgentLibraryStore.getState().hydrate(agentTemplates as any)

  const agentTeams = coerceArray(configData.agentTeams, 'agentTeams', warnings)
  const agentTeamRuns = coerceArray(configData.agentTeamRuns, 'agentTeamRuns', warnings)
  useTeamStore.getState().hydrate(agentTeams as any, agentTeamRuns as any)

  // usageTracking stays undefined when absent (its hydrate treats undefined as
  // "no tracking data yet"); a present-but-corrupt value resets to {}.
  const usageTracking = configData.usageTracking == null
    ? undefined
    : (coerceObject(configData.usageTracking, 'usageTracking', warnings) as unknown as UsageTracking)
  useTipsStore.getState().hydrate(usageTracking as UsageTracking)

  const commandBarUi = coerceObject(configData.commandBarUi, 'commandBarUi', warnings) as { collapsedSectionIds?: string[]; barCollapsed?: boolean }
  useCommandBarStore.getState().hydrate(commandBarUi)

  // excalidraw keeps its { bySessionId: {} } default when absent.
  const excalidraw = configData.excalidraw == null
    ? { bySessionId: {} }
    : coerceObject(configData.excalidraw, 'excalidraw', warnings)
  useExcalidrawStore.getState().hydrate(excalidraw as never)

  if (warnings.length > 0) {
    for (const w of warnings) console.warn('[configHydration] ' + w)
    // Surface to the user via a one-shot dismissible notice. Persist through the
    // already-hydrated settings store so the banner survives the boot it was
    // raised on. Guarded so a normal (warning-free) boot writes nothing.
    void useSettingsStore.getState().updateSettings({
      configHydrationNoticePending: true,
      configHydrationDropped: warnings,
    })
  }
  console.log('[App] All stores hydrated from CONFIG/')
}

/**
 * One-time, idempotent, partial-failure-safe migration of saved config colours
 * to identity keys. Returns possibly-updated configData to hydrate from. Never
 * sets the guard unless the relevant persist actually succeeded.
 */
export async function applyConfigColourMigration(
  configData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawSettings = { ...((configData.settings as any) || {}) }
  if (rawSettings.identityColorMigratedV2) return configData            // guard set: fast path

  const configs = (configData.configs as any[]) || []
  const { records, summary } = migrateColorRecords(configs)
  console.log('[colourMigration] configs', summary)

  const changedNow = summary.changed > 0
  // A prior run may have persisted migrated configs but failed to persist the
  // guard. Detect by migrated records already carrying legacyColor.
  const hasPriorMigrated = configs.some((c: any) => c?.identityColorKey && c?.legacyColor)

  // Genuine no-op (clean install / natively keyed): set guard, never notify.
  if (!changedNow && !hasPriorMigrated) {
    try {
      const newSettings = { ...rawSettings, identityColorMigratedV2: true }
      await window.electronAPI.config.save('settings', newSettings)
      return { ...configData, settings: newSettings }
    } catch (e) {
      console.error('[colourMigration] guard persist failed (no-op case); will retry', e)
      return configData
    }
  }

  // Something changed now, OR a prior partial success left migrated records.
  try {
    if (changedNow) {
      await window.electronAPI.config.save('configs', records)          // 1) persist configs FIRST
    }
    const dismissed = rawSettings.colourMigrationNoticeDismissed === true
    const newSettings = {
      ...rawSettings,
      identityColorMigratedV2: true,
      colourMigrationNoticePending: dismissed ? rawSettings.colourMigrationNoticePending : true,
    }
    await window.electronAPI.config.save('settings', newSettings)       // 2) guard + pending SECOND
    return { ...configData, configs: changedNow ? records : configs, settings: newSettings }
  } catch (e) {
    console.error('[colourMigration] persist failed; guard NOT set, hydrating original data', e)
    return configData                                                   // safe original; retry next launch
  }
}
