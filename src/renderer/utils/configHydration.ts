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
import { useBrowserStore } from '../stores/browserStore'
import { ASK_LABEL, ASK_LEGACY_LABEL } from '../lib/askConductor'
import { migrateColorRecords } from './migrateIdentityColors'
import { configWritesLocked } from '../stores/configWriteLockStore'

/**
 * The reason to latch writes off after a `config:loadAll` that RESOLVED, or
 * null when the read was clean. Two failures never reject: the CONFIG dir was
 * unreachable (`readFailed`: nothing read, not a fresh install), or one or
 * more files exist but could not be read or parsed (`failedKeys`). Both used
 * to look like "absent", and absent is what every boot migration and store
 * treats as "free to write defaults". (ADR-009 pass, beta.16.)
 */
export function readFailureLockReason(
  result: { readFailed?: boolean; failedKeys?: string[] } | null | undefined,
): string | null {
  if (!result) return null
  if (result.readFailed) return 'the app could not reach your configuration folder this launch'
  const failed = Array.isArray(result.failedKeys) ? result.failedKeys.filter((k) => typeof k === 'string' && k) : []
  if (failed.length === 0) return null
  return `the app could not read ${failed.length === 1 ? 'one of your configuration files' : `${failed.length} of your configuration files`} this launch (${failed.join(', ')})`
}

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
/**
 * One-time migration of the retired `target: 'any'`.
 *
 * "Any" ran a button in whichever pane happened to be showing, while the button
 * itself sat in the Claude row -- so the row could lie about where a command
 * executed, and a button under the Claude mark could run a shell line. The
 * owner's call was to drop it: a button lives in the row it runs in.
 *
 * Everything that was 'any' becomes 'claude', which is where those buttons were
 * already filed and where they landed most of the time (the partner pane is
 * opened deliberately, and rarely left open). Nothing is lost: a command that
 * belongs in the shell is one drag away, and its row will then be telling the
 * truth about it.
 *
 * Returns the SAME array reference when there is nothing to migrate, so a
 * healthy launch writes nothing.
 */
export function migrateCommandTargets(commands: CustomCommand[]): CustomCommand[] {
  let changed = false
  const out = commands.map((c) => {
    if ((c as { target?: string }).target !== 'any') return c
    changed = true
    return { ...c, target: 'claude' as const }
  })
  return changed ? out : commands
}


export function removeRetiredCommands(commands: CustomCommand[]): CustomCommand[] {
  const filtered = commands.filter((c) => !RETIRED_COMMAND_IDS.has(c.id))
  return filtered.length === commands.length ? commands : filtered
}

/**
 * Was this saved config created by the RETIRED "Ask the Conductor" launch path?
 *
 * Until 2.1.0-beta.16 the only way the app could open a session was through a
 * saved config, so asking for help created and PERSISTED one -- pointing at the
 * app's own staged help workspace -- into the user's Saved Configs, beside their
 * real projects. Ask Conductor no longer needs it, so it is removed once.
 *
 * The match is deliberately tight: the exact help-workspace path AND one of the
 * two labels the app itself ever wrote (it was renamed from "Ask Command Center"
 * in 2.1). Nobody creates a config in the app's own help folder by hand, and a
 * config the user has RENAMED is theirs now and is left alone.
 */
export function isRetiredAskConfig(config: unknown, helpDir: string): boolean {
  if (!config || typeof config !== 'object' || !helpDir) return false
  const c = config as { workingDirectory?: unknown; label?: unknown }
  // Own properties only. Both comparisons would otherwise be satisfiable from
  // Object.prototype, and this predicate decides a delete.
  if (!Object.hasOwn(c, 'workingDirectory') || !Object.hasOwn(c, 'label')) return false
  if (c.workingDirectory !== helpDir) return false
  // The labels the app itself wrote, from the module that writes them — the
  // same two strings were spelled out here as literals, so a third rename would
  // either silently stop matching or, worse, be "fixed" by pointing the deleter
  // at whatever the current build writes.
  return c.label === ASK_LABEL || c.label === ASK_LEGACY_LABEL
}

/**
 * One-time removal of that config, run before the stores hydrate so the row
 * never renders even once.
 *
 * Guarded by an appMeta flag rather than by "did we find one", so the help
 * workspace is only staged for this on a single launch. A launch that cannot
 * resolve the workspace path at all leaves the flag unset and tries again next
 * time -- deleting on a guessed path is not worth saving one IPC call. (A path
 * that resolves to the WRONG directory -- the registry read failed and the
 * resources dir fell back, or the user moved it -- is indistinguishable from
 * "there was nothing to remove", so that one does burn the flag. The cost is an
 * orphan row the user can delete by hand; the alternative is re-running a delete
 * on every launch forever.)
 *
 * Nothing here may throw into the boot path, and nothing may set the flag on a
 * write that did not land: `config.save` RESOLVES FALSE on a failed write (it
 * catches everything internally and returns a boolean), so the outcome has to be
 * read from the return value. Treating it as a promise that rejects is how this
 * would have marked itself permanently done having deleted nothing.
 */
export async function retireAskConfig(
  configData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Never under the write latch: this migration WRITES (configs, app-meta). A
  // read that failed leaves these sections looking absent, and absent is what
  // it treats as "free to write". It is idempotent and runs on the next healthy
  // boot. (ADR-009 pass, beta.16.)
  if (configWritesLocked()) return configData
  // ABSENT is not CORRUPT, and the difference is the common case: `readConfig`
  // returns NULL for a config file that does not exist, so every install that
  // has never written app-meta.json arrives here with `appMeta: null`. Treating
  // that as corrupt would leave the one-shot flag permanently unwritable — and
  // this migration stages the help workspace to run, which REWRITES the two
  // files in it, so "never records the flag" means "restages on every launch,
  // forever". Same distinction the configs section draws below.
  const rawMeta = configData.appMeta
  const metaAbsent = rawMeta === undefined || rawMeta === null
  const metaIsWritable = metaAbsent || (typeof rawMeta === 'object' && !Array.isArray(rawMeta))
  const meta = metaIsWritable && !metaAbsent ? { ...(rawMeta as Record<string, unknown>) } : {}
  if (meta.askConfigRetired) return configData

  let helpDir: string | null = null
  try {
    helpDir = await window.electronAPI.help.workspace()
  } catch {
    helpDir = null
  }
  if (!helpDir) return configData

  // A section that is PRESENT but not an array is CORRUPT, not empty.
  // Substituting `[]` for it would hand hydrateStores a clean value and silence
  // the "your config was reset" notice that is the user's only signal the
  // section was dropped, so this migration stands aside and lets the coercion
  // report it. An ABSENT section is just a config file that has never held one.
  const rawConfigs = configData.configs
  if (rawConfigs !== undefined && rawConfigs !== null && !Array.isArray(rawConfigs)) return configData
  const configs = Array.isArray(rawConfigs) ? (rawConfigs as unknown[]) : []
  const kept = configs.filter((c) => !isRetiredAskConfig(c, helpDir))
  const removed = configs.length - kept.length

  try {
    if (removed > 0) {
      const saved = await window.electronAPI.config.save('configs', kept)
      if (!saved) {
        // The row is still on disk. Leaving the flag unset is the whole point:
        // it retries next launch instead of recording a deletion that never
        // happened. The in-memory value stays as read, so the session the user
        // is in matches what is stored.
        console.error('[configHydration] Ask config removal did not persist; will retry next launch')
        return configData
      }
      console.log(`[configHydration] Removed ${removed} retired Ask Conductor config(s)`)
    }
    // A corrupt appMeta is left exactly as it was found, flag and all: spreading
    // a string into `{...}` yields character indices, and writing that back
    // replaces the user's file with a mangled derivative of itself. Writing a
    // fresh `{askConfigRetired:true}` over it instead would be a silent repair
    // that discards the bytes. It stays out of the return value too, so
    // coerceObject still sees the original and warns.
    if (!metaIsWritable) return removed > 0 ? { ...configData, configs: kept } : configData
    const newMeta = { ...meta, askConfigRetired: true }
    const metaSaved = await window.electronAPI.config.save('appMeta', newMeta)
    if (!metaSaved) return removed > 0 ? { ...configData, configs: kept } : configData
    return { ...configData, configs: kept, appMeta: newMeta }
  } catch (e) {
    // Never block boot on this. Without the flag it simply runs again next launch.
    console.error('[configHydration] Ask config retirement failed; will retry', e)
    return removed > 0 ? { ...configData, configs: kept } : configData
  }
}

/**
 * Gather all relevant localStorage keys for migration to CONFIG/.
 */
export const MIGRATED_LOCAL_STORAGE_KEYS: readonly string[] = [
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

export function gatherLocalStorageData(): Record<string, string> {
  const data: Record<string, string> = {}
  for (const key of MIGRATED_LOCAL_STORAGE_KEYS) {
    const value = localStorage.getItem(key)
    if (value != null) {
      data[key] = value
    }
  }
  return data
}

/**
 * Forget the v1 localStorage snapshot once it has been migrated into CONFIG/.
 * It used to be kept forever, so any later launch that (wrongly or rightly)
 * decided CONFIG/ was empty would re-migrate it and roll commands, configs and
 * settings back to the v1 state. The migration is one-way; the snapshot has no
 * job after it.
 */
export function clearMigratedLocalStorage(): void {
  for (const key of MIGRATED_LOCAL_STORAGE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* storage unavailable: nothing to forget */ }
  }
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

  // `map` always allocates, so returning it unconditionally made the caller's
  // `migrated !== commands` identity check true on EVERY boot of every install
  // whose commands carry no defaultArgs -- the empty list included. The caller
  // reads that as "something changed" and writes commands.json, so rewriting on
  // every launch was the normal path rather than an edge case. Return the
  // original reference unless a command was actually rewritten.
  const out = commands.map((cmd) => {
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
  // Element-wise rather than a flag set at each of the three rewrite branches:
  // one place cannot miss a branch, and every non-rewriting path above already
  // returns the ORIGINAL cmd object, so identity is exactly the question.
  return out.some((c, i) => c !== commands[i]) ? out : commands
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
  // These two migrations are the only writes hydration performs, and they go
  // straight to the IPC rather than through config-saver -- so the write latch
  // has to be honoured HERE too. It matters most in the case that motivated the
  // latch: when the config could not be read at all, `configData` is `{}`, the
  // command list reads as absent, and persisting the default over it deletes
  // every command the user had.
  const saveCommands = (value: CustomCommand[], why: string): void => {
    const locked = configWritesLocked()
    if (locked) {
      console.warn(`[configHydration] ${why} computed but NOT saved: ${locked}`)
      return
    }
    window.electronAPI.config.save('commands', value)
    console.log(`[configHydration] ${why}`)
  }

  // Run one-time migration to split args out of prompt field
  const migrated = migrateCommandArgs(commands)
  if (migrated !== commands) {
    commands = migrated
    saveCommands(commands, 'Migrated command args from prompt field')
  }
  // One-time cleanup: drop retired built-in commands (currently the legacy
  // "Setup Statusline") from existing persisted configs so they stop appearing.
  const cleaned = removeRetiredCommands(commands)
  if (cleaned !== commands) {
    commands = cleaned
    saveCommands(commands, 'Removed retired built-in command(s)')
  }
  // The retired 'any' target (see migrateCommandTargets).
  const retargeted = migrateCommandTargets(commands)
  if (retargeted !== commands) {
    commands = retargeted
    saveCommands(commands, "Migrated commands off the retired 'any' target")
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

  // browser (favourites + per-config home) keeps its empty default when
  // absent; its hydrate re-validates every URL against the http/https rule.
  const browser = configData.browser == null
    ? {}
    : coerceObject(configData.browser, 'browser', warnings)
  useBrowserStore.getState().hydrate(browser)

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
  // Never under the write latch (see retireAskConfig): a failed read makes
  // `settings` look absent, and absent is exactly what this migration writes
  // over. Idempotent; it runs on the next healthy boot.
  if (configWritesLocked()) return configData
  // A settings section that is present but NOT a plain object is left exactly
  // as it is, the same way the configs section below is. `|| {}` rejects only
  // FALSY values, so a string or an array is truthy and spreads into
  // character/index keys -- and this function writes that back, replacing the
  // user's file with a mangled derivative of itself and setting
  // identityColorMigratedV2 on it, so it never revisits. Worse, the result is
  // a genuine plain object, so hydrateStores' coerceObject passes it WITHOUT
  // setting configHydrationNoticePending: a corruption that would have been
  // detected and reported becomes silent and permanent. The sibling migration
  // in this file already guards exactly this via metaIsWritable.
  const rawSettingsValue = configData.settings
  const settingsAbsent = rawSettingsValue === undefined || rawSettingsValue === null
  const settingsIsWritable =
    settingsAbsent || (typeof rawSettingsValue === 'object' && !Array.isArray(rawSettingsValue))
  if (!settingsIsWritable) return configData
  const rawSettings = { ...((rawSettingsValue as any) || {}) }
  if (rawSettings.identityColorMigratedV2) return configData            // guard set: fast path

  // `|| []` accepted anything truthy, so a configs section that is present but
  // not an array reached migrateColorRecords and threw `records.map is not a
  // function` from OUTSIDE the try blocks below. App.tsx's catch then hydrated
  // from {}, resetting every store to defaults — and the next config the user
  // touches persists that empty state over the file that held their real one.
  // A corrupt section is left for hydrateStores to coerce and report.
  if (configData.configs !== undefined && configData.configs !== null && !Array.isArray(configData.configs)) {
    return configData
  }
  const configs = (Array.isArray(configData.configs) ? configData.configs : []) as any[]
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
      // Boolean, not a rejection: config.save catches its own write errors and
      // resolves false, so the catch below never sees a failed write.
      if (!(await window.electronAPI.config.save('settings', newSettings))) return configData
      return { ...configData, settings: newSettings }
    } catch (e) {
      console.error('[colourMigration] guard persist failed (no-op case); will retry', e)
      return configData
    }
  }

  // Something changed now, OR a prior partial success left migrated records.
  try {
    if (changedNow) {
      // 1) persist configs FIRST. A false return means they are NOT on disk, so
      // the guard must not be written either — otherwise the migration records
      // itself as done and the notice invites the user to review colours that
      // were never saved.
      if (!(await window.electronAPI.config.save('configs', records))) {
        console.error('[colourMigration] configs did not persist; guard NOT set, will retry')
        return configData
      }
    }
    const dismissed = rawSettings.colourMigrationNoticeDismissed === true
    const newSettings = {
      ...rawSettings,
      identityColorMigratedV2: true,
      colourMigrationNoticePending: dismissed ? rawSettings.colourMigrationNoticePending : true,
    }
    // 2) guard + pending SECOND
    if (!(await window.electronAPI.config.save('settings', newSettings))) {
      // The configs ARE on disk; only the guard is not. Hydrate from what was
      // written so memory matches, and let the next launch retry the guard.
      return { ...configData, configs: changedNow ? records : configs }
    }
    return { ...configData, configs: changedNow ? records : configs, settings: newSettings }
  } catch (e) {
    console.error('[colourMigration] persist failed; guard NOT set, hydrating original data', e)
    return configData                                                   // safe original; retry next launch
  }
}
