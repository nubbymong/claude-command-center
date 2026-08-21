/**
 * Which command secrets a shell spawn carries: built in MAIN from the commands
 * file as read from disk, trusting none of it.
 */
import { describe, it, expect, vi } from 'vitest'
import { collectCommandSecrets } from '../../../src/main/command-secrets'

const vault: Record<string, string> = {
  'aaa111_cmdsecret': 'tok-a',
  'bbb222_cmdsecret': 'tok-b',
  'ccc333_cmdsecret': 'tok-c',
  'ddd444_cmdsecret': 'tok-d',
}
const load = (k: string) => vault[k] ?? null

describe('collectCommandSecrets', () => {
  it('returns the values for secret-bearing commands visible to this config', () => {
    const out = collectCommandSecrets([
      { id: 'aaa111', hasSecretArg: true, scope: 'global' },
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'cfg1' },
    ], 'cfg1', load)
    expect(out).toEqual({ aaa111: 'tok-a', bbb222: 'tok-b' })
  })

  it('skips a command scoped to ANOTHER config -- its secret does not belong in this shell', () => {
    const out = collectCommandSecrets([
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'cfg-other' },
    ], 'cfg1', load)
    expect(out).toEqual({})
  })

  it('skips commands that do not say they have a secret, even if the vault has one', () => {
    const out = collectCommandSecrets([
      { id: 'aaa111', scope: 'global' },
      { id: 'ccc333', hasSecretArg: false, scope: 'global' },
      { id: 'ddd444', hasSecretArg: 'yes', scope: 'global' },
    ], 'cfg1', load)
    expect(out).toEqual({})
  })

  it('skips an id that could not become a variable name, before it reaches the vault', () => {
    const spy = vi.fn(load)
    const out = collectCommandSecrets([
      { id: 'a b', hasSecretArg: true, scope: 'global' },
      { id: 'a-b', hasSecretArg: true, scope: 'global' },
      { id: 42, hasSecretArg: true, scope: 'global' },
    ], 'cfg1', spy)
    expect(out).toEqual({})
    expect(spy).not.toHaveBeenCalled()
  })

  it('survives a commands file of any shape', () => {
    expect(collectCommandSecrets(undefined, 'cfg1', load)).toEqual({})
    expect(collectCommandSecrets('nope', 'cfg1', load)).toEqual({})
    expect(collectCommandSecrets({ not: 'an array' }, 'cfg1', load)).toEqual({})
    expect(collectCommandSecrets([null, 'x', 7, { id: 'aaa111', hasSecretArg: true, scope: 'global' }], 'cfg1', load))
      .toEqual({ aaa111: 'tok-a' })
  })

  it('omits a command whose value is missing from the vault', () => {
    const out = collectCommandSecrets([
      { id: 'zzz999', hasSecretArg: true, scope: 'global' },
    ], 'cfg1', load)
    expect(out).toEqual({})
  })

  it('with no configId, only GLOBAL commands are visible', () => {
    const out = collectCommandSecrets([
      { id: 'aaa111', hasSecretArg: true, scope: 'global' },
      { id: 'bbb222', hasSecretArg: true, scope: 'config', configId: 'cfg1' },
    ], undefined, load)
    expect(out).toEqual({ aaa111: 'tok-a' })
  })
})
