import { useCommandStore, DEFAULT_COMMANDS, CustomCommand, CommandSection } from '../stores/commandStore'
import { useConfigStore } from '../stores/configStore'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { useTipsStore, UsageTracking } from '../stores/tipsStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import { useAgentLibraryStore } from '../stores/agentLibraryStore'
import { useTeamStore } from '../stores/teamStore'

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

/**
 * Hydrate all stores from loaded config data.
 */
export function hydrateStores(configData: Record<string, unknown>): void {
  let commands = (configData.commands as CustomCommand[]) || [...DEFAULT_COMMANDS]
  // Run one-time migration to split args out of prompt field
  const migrated = migrateCommandArgs(commands)
  if (migrated !== commands) {
    commands = migrated
    // Save migrated commands back
    window.electronAPI.config.save('commands', commands)
    console.log('[configHydration] Migrated command args from prompt field')
  }
  const commandSections = (configData.commandSections as CommandSection[]) || []
  useCommandStore.getState().hydrate(commands, commandSections)

  const configs = (configData.configs as any[]) || []
  const groups = (configData.configGroups as any[]) || []
  const sections = (configData.configSections as any[]) || []
  useConfigStore.getState().hydrate(configs, groups, sections)

  const magicButtons = configData.magicButtons || {}
  useMagicButtonStore.getState().hydrate(magicButtons as any)

  const settings = configData.settings || {}
  useSettingsStore.getState().hydrate(settings as any)

  const appMeta = configData.appMeta || {}
  useAppMetaStore.getState().hydrate(appMeta as any)

  const cloudAgents = (configData.cloudAgents as any[]) || []
  useCloudAgentStore.getState().hydrate(cloudAgents)

  const agentTemplates = (configData.agentTemplates as any[]) || []
  useAgentLibraryStore.getState().hydrate(agentTemplates)

  const agentTeams = (configData.agentTeams as any[]) || []
  const agentTeamRuns = (configData.agentTeamRuns as any[]) || []
  useTeamStore.getState().hydrate(agentTeams, agentTeamRuns)

  const usageTracking = (configData.usageTracking as UsageTracking) || undefined
  useTipsStore.getState().hydrate(usageTracking as UsageTracking)

  console.log('[App] All stores hydrated from CONFIG/')
}
