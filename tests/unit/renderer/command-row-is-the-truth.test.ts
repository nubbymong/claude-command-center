/**
 * "Any" is gone: a command button lives in the row it runs in.
 *
 * The old third target ran a button in whichever pane happened to be showing,
 * while the button itself was filed in the Claude row. So a button sitting under
 * the Claude mark could execute a shell line, and which one it did depended on
 * invisible state — whether the partner pane was open at the moment you clicked.
 * The owner's call (2026-08-21) was to drop it rather than mark it.
 */
import { describe, it, expect } from 'vitest'
import { migrateCommandTargets } from '../../../src/renderer/utils/configHydration'
import type { CustomCommand } from '../../../src/renderer/stores/commandStore'

const cmd = (over: Partial<CustomCommand> & { id: string }): CustomCommand => ({
  label: 'x', prompt: 'echo hi', scope: 'global', ...over,
})

describe('migrating off the retired "any" target', () => {
  it('rewrites every "any" to claude — the row those buttons were already filed in', () => {
    const before = [
      cmd({ id: 'a', target: 'any' as never }),
      cmd({ id: 'b', target: 'any' as never }),
    ]
    const after = migrateCommandTargets(before)
    expect(after.map((c) => c.target)).toEqual(['claude', 'claude'])
  })

  it('leaves partner commands alone — they were never ambiguous', () => {
    const before = [cmd({ id: 'p', target: 'partner' })]
    expect(migrateCommandTargets(before)[0].target).toBe('partner')
  })

  it('leaves an ABSENT target absent, because absent already meant claude', () => {
    // Rewriting these would churn the file for every user on the first launch
    // after the update, for no change in behaviour whatsoever.
    const before = [cmd({ id: 'n' })]
    const after = migrateCommandTargets(before)
    expect(after[0].target).toBeUndefined()
    expect(after).toBe(before)
  })

  it('returns the SAME array when there is nothing to migrate, so nothing is written', () => {
    const before = [cmd({ id: 'a', target: 'claude' }), cmd({ id: 'b', target: 'partner' })]
    expect(migrateCommandTargets(before)).toBe(before)
  })

  it('keeps everything else about a migrated command untouched', () => {
    const before = [cmd({
      id: 'a', target: 'any' as never, label: 'Deploy', prompt: './deploy.ps1',
      defaultArgs: ['-Env prod'], sectionId: 's1', color: '#abc', scope: 'config', configId: 'c1',
    })]
    const after = migrateCommandTargets(before)[0]
    expect(after).toEqual({ ...before[0], target: 'claude' })
  })

  it('is idempotent — a second launch changes nothing and writes nothing', () => {
    const once = migrateCommandTargets([cmd({ id: 'a', target: 'any' as never })])
    expect(migrateCommandTargets(once)).toBe(once)
  })
})
