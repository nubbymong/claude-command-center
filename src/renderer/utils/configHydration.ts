import { useCommandStore, DEFAULT_COMMANDS } from '../stores/commandStore'
import { useConfigStore } from '../stores/configStore'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
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
 * Hydrate all stores from loaded config data.
 */
export function hydrateStores(configData: Record<string, unknown>): void {
  const commands = (configData.commands as any[]) || [...DEFAULT_COMMANDS]
  useCommandStore.getState().hydrate(commands)

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

  console.log('[App] All stores hydrated from CONFIG/')
}
