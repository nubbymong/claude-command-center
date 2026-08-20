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

  // The tests above pin that the match is not ABSENT. These pin that it is
  // TIGHT, which for an irreversible delete is the whole safety argument: two
  // independent WIDENINGS of the predicate (path compared with startsWith,
  // label compared with startsWith) left the suite fully green until these
  // existed (adversarial review of #308). Every case is a near miss.
  describe('near misses that must all be SPARED', () => {
    const spared: Array<[string, Record<string, unknown>]> = [
      ['a path one level below the help dir', { workingDirectory: `${HELP}/sub` }],
      ['a sibling directory sharing the prefix', { workingDirectory: `${HELP}-notes` }],
      ['a trailing separator', { workingDirectory: `${HELP}/` }],
      ['a trailing backslash', { workingDirectory: `${HELP}\\` }],
      ['a trailing space', { workingDirectory: `${HELP} ` }],
      ['backslashes instead of forward slashes', { workingDirectory: 'C:\\res\\help' }],
      ['a different drive letter', { workingDirectory: 'D:/res/help' }],
      ['a different case', { workingDirectory: 'c:/RES/Help' }],
      ['an unnormalised path that resolves to the same place', { workingDirectory: 'C:/res/x/../help' }],
      ['the workingDirectory bug value "."', { workingDirectory: '.' }],
      ['a label that merely starts with the retired one', { label: 'Ask Conductor about billing' }],
      ['a label with a trailing space', { label: 'Ask Conductor ' }],
      ['a differently-cased label', { label: 'ask conductor' }],
      ['a label that starts with "Ask "', { label: 'Ask my docs' }],
      ['a Cyrillic look-alike in the label', { label: '\u0410sk Conductor' }],
      ['a non-breaking space in the label', { label: 'Ask\u00a0Conductor' }],
    ]
    for (const [name, over] of spared) {
      it(`spares ${name}`, () => {
        expect(isRetiredAskConfig(askConfig(over), HELP)).toBe(false)
      })
    }
  })

  it('does not read the match off the prototype chain', () => {
    // Both halves of the predicate decide a delete, so neither may be
    // satisfiable by anything other than the record's own fields.
    const planted = Object.create({ workingDirectory: HELP, label: 'Ask Conductor' })
    planted.id = 'innocent'
    expect(isRetiredAskConfig(planted, HELP)).toBe(false)
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

  it('does not set the guard when the write RESOLVES false, which is how it fails', async () => {
    // The failure the test above simulates cannot happen: writeConfig catches
    // everything internally and returns a boolean, so a disk-full, ACL or
    // rename-race failure resolves FALSE. Reading it as a rejection is how a
    // one-shot destructive migration marks itself permanently done having
    // deleted nothing at all.
    save.mockResolvedValueOnce(false)
    const data = { configs: [projectConfig, askConfig()], appMeta: {} }
    const out = await retireAskConfig(data)
    expect(out).toBe(data)
    expect((out.appMeta as any)?.askConfigRetired).toBeUndefined()
    // ...and it did not go on to write the guard after the failed removal.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('configs', [projectConfig])
  })

  it('keeps the removal in memory when only the GUARD write fails', async () => {
    save.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const out = await retireAskConfig({ configs: [projectConfig, askConfig()], appMeta: {} })
    expect((out.configs as unknown[]).map((c: any) => c.id)).toEqual(['proj'])
    expect((out.appMeta as any)?.askConfigRetired).toBeUndefined()
  })

  it('tolerates a config file with no configs section at all', async () => {
    const out = await retireAskConfig({ appMeta: {} })
    expect(out.configs).toEqual([])
    expect((out.appMeta as any).askConfigRetired).toBe(true)
  })

  it('stands aside for a CORRUPT configs section instead of silently emptying it', async () => {
    // Normalising a non-array to [] here would hand hydrateStores a clean value
    // and swallow the "section was not an array and was reset" warning, which is
    // the user's only signal that their saved configs were dropped.
    const data = { configs: { nope: true }, appMeta: {} }
    const out = await retireAskConfig(data)
    expect(out).toBe(data)
    expect(save).not.toHaveBeenCalled()
  })

  it('leaves a corrupt appMeta exactly as it found it', async () => {
    // `{...'yes'}` spreads a string into character indices; writing THAT back
    // replaces the user's file with a mangled derivative of itself.
    const data = { configs: [projectConfig], appMeta: 'yes' }
    const out = await retireAskConfig(data)
    expect(out).toBe(data)
    expect(out.appMeta).toBe('yes')
    expect(save).not.toHaveBeenCalled()
  })

  it('still removes the config when appMeta is corrupt, without writing appMeta', async () => {
    const out = await retireAskConfig({ configs: [projectConfig, askConfig()], appMeta: ['a', 'b'] })
    expect((out.configs as unknown[]).map((c: any) => c.id)).toEqual(['proj'])
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('configs', [projectConfig])
    expect(out.appMeta).toEqual(['a', 'b'])
  })
})
