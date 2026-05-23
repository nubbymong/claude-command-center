// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the config-saver so the test doesn't touch the real config-manager
// IPC -- configStore calls saveConfigNow/saveConfigDebounced eagerly on every
// mutation, and without window.electronAPI in place those calls would throw.
const saveNowMock = vi.fn()
const saveDebouncedMock = vi.fn()
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: (...args: any[]) => saveNowMock(...args),
  saveConfigDebounced: (...args: any[]) => saveDebouncedMock(...args),
}))

import { useConfigStore } from '../../../src/renderer/stores/configStore'
import type { TerminalConfig } from '../../../src/renderer/stores/configStore'

const baseConfig: TerminalConfig = {
  id: 'cfg-app-dev',
  label: 'App Dev',
  workingDirectory: 'F:/app',
  color: '#7fb',
  sessionType: 'local',
  provider: 'claude',
}

describe('#280 -- TerminalConfig persists githubIntegration on the template', () => {
  beforeEach(() => {
    saveNowMock.mockClear()
    saveDebouncedMock.mockClear()
    useConfigStore.getState().hydrate([], [], [])
  })

  it('updateConfig writes githubIntegration to the config and triggers a save', () => {
    useConfigStore.getState().addConfig(baseConfig)
    useConfigStore.getState().updateConfig('cfg-app-dev', {
      githubIntegration: {
        enabled: true,
        autoDetected: false,
        repoUrl: 'https://github.com/owner/repo',
        repoSlug: 'owner/repo',
        authProfileId: 'profile-1',
      },
    })

    const cfgs = useConfigStore.getState().configs
    expect(cfgs).toHaveLength(1)
    expect(cfgs[0].githubIntegration).toEqual({
      enabled: true,
      autoDetected: false,
      repoUrl: 'https://github.com/owner/repo',
      repoSlug: 'owner/repo',
      authProfileId: 'profile-1',
    })

    // The store persists synchronously via saveConfigNow on updateConfig
    // (see configStore.ts) so any restart will pick the value up from
    // configs.json. addConfig fires saveConfigNow first; updateConfig fires
    // it again with the new shape -- the LAST call is the one that matters.
    const configsCalls = saveNowMock.mock.calls.filter(c => c[0] === 'configs')
    expect(configsCalls.length).toBeGreaterThan(0)
    const lastWrite = configsCalls[configsCalls.length - 1]
    expect(lastWrite[1][0].githubIntegration?.enabled).toBe(true)
    expect(lastWrite[1][0].githubIntegration?.repoSlug).toBe('owner/repo')
  })

  it('updateConfig clears githubIntegration when patched to undefined', () => {
    useConfigStore.getState().addConfig({
      ...baseConfig,
      githubIntegration: { enabled: true, autoDetected: false, repoSlug: 'owner/repo' },
    })

    useConfigStore.getState().updateConfig('cfg-app-dev', {
      githubIntegration: undefined,
    })

    const cfg = useConfigStore.getState().configs[0]
    expect(cfg.githubIntegration).toBeUndefined()
  })
})
