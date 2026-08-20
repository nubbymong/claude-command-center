// @vitest-environment jsdom
/**
 * One-time removal of the saved config the RETIRED "Ask the Conductor" path
 * created. It is a DELETION of persisted user config, so the match has to be
 * exact: the app's own help-workspace path AND one of the two labels the app
 * itself ever wrote. A config the user renamed is theirs and stays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isRetiredAskConfig, retireAskConfig } from '../../../src/renderer/utils/configHydration'

const HELP = 'C:/res/help'

const askConfig = (over: Record<string, unknown> = {}) => ({
  id: 'ask-cfg',
  label: 'Ask Conductor',
  workingDirectory: HELP,
  color: '#a78bfa',
  identityColorKey: 'mauve',
  sessionType: 'local',
  provider: 'claude',
  ...over,
})

const projectConfig = {
  id: 'proj',
  label: 'Conductor - beta',
  workingDirectory: 'F:/CLAUDE_MULTI_APP',
  color: '#89b4fa',
  sessionType: 'local',
  provider: 'claude',
}

const save = vi.fn(() => Promise.resolve(true))
function setApi(workspace: string | null | (() => Promise<never>)) {
  ;(globalThis as any).window.electronAPI = {
    help: {
      workspace: typeof workspace === 'function' ? workspace : () => Promise.resolve(workspace),
    },
    config: { save },
  }
}

describe('isRetiredAskConfig', () => {
  it('matches both labels the app ever wrote, at the exact help path', () => {
    expect(isRetiredAskConfig(askConfig(), HELP)).toBe(true)
    expect(isRetiredAskConfig(askConfig({ label: 'Ask Command Center' }), HELP)).toBe(true)
  })

  it('leaves a config the user renamed alone', () => {
    expect(isRetiredAskConfig(askConfig({ label: 'My help notes' }), HELP)).toBe(false)
  })

  it('leaves a config with the right label but a different directory alone', () => {
    expect(isRetiredAskConfig(askConfig({ workingDirectory: 'F:/my/help' }), HELP)).toBe(false)
  })

  it('never matches on a missing or empty help path', () => {
    expect(isRetiredAskConfig(askConfig({ workingDirectory: '' }), '')).toBe(false)
    expect(isRetiredAskConfig(askConfig(), '')).toBe(false)
  })

  it('tolerates junk records', () => {
    expect(isRetiredAskConfig(null, HELP)).toBe(false)
    expect(isRetiredAskConfig('Ask Conductor', HELP)).toBe(false)
    expect(isRetiredAskConfig({}, HELP)).toBe(false)
  })
})

describe('retireAskConfig', () => {
  beforeEach(() => {
    save.mockClear()
    setApi(HELP)
  })

  it('removes the config, keeps every other one, and sets the guard', async () => {
    const out = await retireAskConfig({ configs: [projectConfig, askConfig()], appMeta: {} })
    expect((out.configs as unknown[]).map((c: any) => c.id)).toEqual(['proj'])
    expect((out.appMeta as any).askConfigRetired).toBe(true)
    expect(save).toHaveBeenCalledWith('configs', [projectConfig])
    expect(save).toHaveBeenCalledWith('appMeta', { askConfigRetired: true })
  })

  it('sets the guard without a configs write when there is nothing to remove', async () => {
    const out = await retireAskConfig({ configs: [projectConfig], appMeta: {} })
    expect((out.appMeta as any).askConfigRetired).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('appMeta', { askConfigRetired: true })
  })

  it('is a no-op once the guard is set -- it never even stages the workspace', async () => {
    const workspace = vi.fn(() => Promise.resolve(HELP))
    ;(globalThis as any).window.electronAPI = { help: { workspace }, config: { save } }
    const data = { configs: [askConfig()], appMeta: { askConfigRetired: true } }
    const out = await retireAskConfig(data)
    expect(out).toBe(data)
    expect(workspace).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('deletes nothing and leaves the guard unset when the workspace path is unknown', async () => {
    setApi(null)
    const data = { configs: [askConfig()], appMeta: {} }
    const out = await retireAskConfig(data)
    expect(out).toBe(data)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not block boot when the workspace lookup throws', async () => {
    setApi(() => Promise.reject(new Error('EACCES')))
    const data = { configs: [askConfig()], appMeta: {} }
    await expect(retireAskConfig(data)).resolves.toBe(data)
  })

  it('does not block boot when the save fails, and retries next launch', async () => {
    save.mockRejectedValueOnce(new Error('disk full'))
    const out = await retireAskConfig({ configs: [projectConfig, askConfig()], appMeta: {} })
    // The removal still applies in memory for this run, but the guard is NOT
    // set, so the next launch tries the persist again.
    expect((out.configs as unknown[]).map((c: any) => c.id)).toEqual(['proj'])
    expect((out.appMeta as any)?.askConfigRetired).toBeUndefined()
  })

  it('tolerates a config file with no configs section at all', async () => {
    const out = await retireAskConfig({ appMeta: {} })
    expect(out.configs).toEqual([])
    expect((out.appMeta as any).askConfigRetired).toBe(true)
  })
})
