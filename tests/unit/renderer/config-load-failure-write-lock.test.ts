/**
 * A failed config READ must never become a config WRITE.
 *
 * The bug: when `config:loadAll` rejects, App's boot catch calls
 * `hydrateStores({})`. Every section then reads as absent, the stores fill with
 * defaults, and two of those defaults are persisted immediately -- an empty
 * commands.json, and a full set of default settings via settingsStore's font
 * migration. The user's own commands and settings are gone, on a launch where
 * nothing was wrong with them except that the app could not read one file.
 *
 * Nothing warned, either: the "your config was reset" notice keys on
 * `warnings.length > 0`, and `{}` produces no warnings because every section is
 * merely ABSENT rather than corrupt. So the loudest failure in the app was its
 * quietest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

function setupWindow() {
  const calls: Array<{ key: string; data: unknown }> = []
  const save = vi.fn((key: string, data: unknown) => {
    calls.push({ key, data })
    return Promise.resolve(true)
  })
  ;(globalThis as any).window = { electronAPI: { config: { save } } }
  return { calls, save }
}

const { hydrateStores } = await import('../../../src/renderer/utils/configHydration')
const { useConfigWriteLockStore } = await import('../../../src/renderer/stores/configWriteLockStore')
const { saveConfigNow } = await import('../../../src/renderer/utils/config-saver')

beforeEach(() => {
  useConfigWriteLockStore.getState().unlock()
})

describe('hydrating from a failed load', () => {
  it('writes NOTHING while the latch is on -- not commands, not settings', async () => {
    const { calls } = setupWindow()
    useConfigWriteLockStore.getState().lock('could not read your configuration')

    hydrateStores({})
    // settingsStore's migration write is dispatched through config-saver, which
    // is async; give the microtask queue a turn so a leak would be caught.
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.map((c) => c.key)).toEqual([])
  })

  it('holds even for a migration that DID have work to do', async () => {
    // The empty-list case is covered above, but it passes for a second reason
    // once migrateCommandArgs returns its input unchanged -- there is no write
    // to suppress. This one gives the migration real work, so the only thing
    // that can stop the write is the latch itself. Without it the test above
    // would still be green with the hydration-side check deleted.
    const { calls } = setupWindow()
    useConfigWriteLockStore.getState().lock('could not read your configuration')

    hydrateStores({ commands: [{ id: 'u3', label: 'Deploy', prompt: 'scripts/deploy.ps1 -Env prod' }] })
    await Promise.resolve()

    expect(calls.filter((c) => c.key === 'commands')).toEqual([])
  })

  it('config-saver refuses every key while latched, and resumes on unlock', async () => {
    const { save } = setupWindow()
    useConfigWriteLockStore.getState().lock('could not read your configuration')

    expect(await saveConfigNow('settings', { a: 1 })).toBe(false)
    expect(await saveConfigNow('configs', [{ id: 'x' }])).toBe(false)
    expect(save).not.toHaveBeenCalled()

    // "Start fresh anyway" is a real escape, not a label: after it, saving works.
    useConfigWriteLockStore.getState().unlock()
    expect(await saveConfigNow('settings', { a: 1 })).toBe(true)
    expect(save).toHaveBeenCalledWith('settings', { a: 1 })
  })
})

describe('the write that fired on every healthy boot too', () => {
  it('does not rewrite commands.json when no command was actually migrated', async () => {
    const { calls } = setupWindow()
    // A perfectly ordinary command list: plain-text prompt, no defaultArgs, so
    // the migration has nothing to do. `Array.map` still allocates, so the
    // caller's `migrated !== commands` identity check used to be TRUE here and
    // rewrote the file on every single launch.
    hydrateStores({ commands: [{ id: 'u1', label: 'Run tests', prompt: 'please run the tests' }] })
    await Promise.resolve()

    expect(calls.filter((c) => c.key === 'commands')).toEqual([])
  })

  it('still rewrites when a command genuinely IS migrated', async () => {
    const { calls } = setupWindow()
    hydrateStores({
      commands: [{ id: 'u2', label: 'Deploy', prompt: 'scripts/deploy.ps1 -Env prod' }],
    })
    await Promise.resolve()

    const written = calls.filter((c) => c.key === 'commands')
    expect(written).toHaveLength(1)
    const cmds = written[0].data as Array<{ prompt: string; defaultArgs?: string[] }>
    expect(cmds[0].prompt).toBe('scripts/deploy.ps1')
    // splitArgs keeps `-Key Value` together as one token, by design.
    expect(cmds[0].defaultArgs).toEqual(['-Env prod'])
  })
})
