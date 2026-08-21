// @vitest-environment jsdom
/**
 * The v1 localStorage snapshot is forgotten once migrated. It used to be kept
 * forever, so any later launch that decided CONFIG/ was empty re-migrated it
 * over the user's current commands/configs/settings. (Re-attack round,
 * beta.16 ADR-009 pass.)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { gatherLocalStorageData, clearMigratedLocalStorage, MIGRATED_LOCAL_STORAGE_KEYS } from '../../../src/renderer/utils/configHydration'

beforeEach(() => localStorage.clear())

describe('clearMigratedLocalStorage', () => {
  it('removes exactly the keys gatherLocalStorageData reads, and nothing else', () => {
    for (const k of MIGRATED_LOCAL_STORAGE_KEYS) localStorage.setItem(k, 'v1-' + k)
    localStorage.setItem('unrelated-key', 'keep')
    expect(Object.keys(gatherLocalStorageData()).sort()).toEqual([...MIGRATED_LOCAL_STORAGE_KEYS].sort())
    clearMigratedLocalStorage()
    expect(gatherLocalStorageData()).toEqual({})
    expect(localStorage.getItem('unrelated-key')).toBe('keep')
  })
})
