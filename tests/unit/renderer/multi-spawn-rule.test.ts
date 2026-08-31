// @vitest-environment jsdom
/**
 * Allow Multi Spawn (phase 4) — the pure half.
 *
 * Three things are pinned here, because everything else in the feature is a
 * rendering of them:
 *   1. THE RULE. A config that is not Multi Spawn runs one at a time. The truth
 *      table below is the whole contract — flip the rule in useLaunchConfig.ts
 *      and every surface's test goes red with it.
 *   2. THE MIGRATION. Enable-only, idempotent, and it counts detached remotes
 *      as copies (a left-running remote IS a copy of that config).
 *   3. The ×N count clamp/step and the popover placement, which are the two
 *      places a bad stored value or a full sidebar could misbehave silently.
 */
import { describe, it, expect } from 'vitest'
import {
  isMultiSpawnLaunchBlocked,
  alreadyRunningLaunchCopy,
  cannotSelectCopy,
  flattenPopoverCopy,
} from '../../../src/renderer/hooks/useLaunchConfig'
import {
  MULTI_SPAWN_DEFAULT_COUNT,
  MULTI_SPAWN_MAX_COUNT,
  MULTI_SPAWN_MIN_COUNT,
  MULTI_SPAWN_POPOVER_WIDTH,
  configsToEnableMultiSpawn,
  multiSpawnCopyCount,
  placeMultiSpawnPopover,
  resolveMultiSpawnCount,
  stepMultiSpawnCount,
} from '../../../src/renderer/utils/multiSpawn'

const cfg = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, label: id, sessionType: 'local', ...over }) as any

const sshCfg = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    label: id,
    sessionType: 'ssh',
    sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/w' },
    ...over,
  }) as any

const sess = (id: string, configId?: string, kind?: string) => ({ id, configId, kind })

const remote = (sessionId: string, configId: string, over: Record<string, unknown> = {}) =>
  ({
    sessionId,
    configId,
    host: 'pi.local',
    username: 'mong',
    remotePath: '~/w',
    mux: 'tmux' as const,
    label: configId,
    detachedAt: 1,
    ...over,
  }) as any

describe('the blocking rule — running x allowMultiSpawn', () => {
  // The full truth table. Both axes matter: the rule keys on the RUNNING state,
  // not on the setting alone, so an idle one-at-a-time config launches freely.
  const table: Array<[number, boolean | undefined, boolean]> = [
    [0, undefined, false],
    [0, false, false],
    [0, true, false],
    [1, undefined, true],
    [1, false, true],
    [1, true, false],
    [3, undefined, true],
    [3, false, true],
    [3, true, false],
  ]
  for (const [running, allow, blocked] of table) {
    it(`running=${running} allowMultiSpawn=${String(allow)} => ${blocked ? 'BLOCKED' : 'allowed'}`, () => {
      expect(isMultiSpawnLaunchBlocked({ allowMultiSpawn: allow }, running)).toBe(blocked)
    })
  }

  it('only an explicit true opts out — a truthy-looking value does not', () => {
    // The stored shape is "absent = off"; anything that is not exactly true
    // must stay one-at-a-time rather than quietly become multi-spawn.
    expect(isMultiSpawnLaunchBlocked({ allowMultiSpawn: 1 as unknown as boolean }, 1)).toBe(true)
    expect(isMultiSpawnLaunchBlocked({ allowMultiSpawn: 'true' as unknown as boolean }, 1)).toBe(true)
  })
})

describe('the refusal copy', () => {
  it('names the config and says why, on both surfaces', () => {
    const launch = alreadyRunningLaunchCopy('Pi-Miner')
    expect(launch.headline).toBe('Pi-Miner is already running.')
    expect(launch.body).toContain("isn't a Multi Spawn config")
    const select = cannotSelectCopy('Pi-Miner')
    expect(select.headline).toBe("Pi-Miner can't be selected.")
    expect(select.body).toContain('already running')
    expect(flattenPopoverCopy(launch)).toBe(`${launch.headline} ${launch.body}`)
  })
})

describe('the ×N copy count', () => {
  it('defaults to 2 and clamps a hand-edited value into 1-9', () => {
    expect(resolveMultiSpawnCount(undefined)).toBe(MULTI_SPAWN_DEFAULT_COUNT)
    expect(MULTI_SPAWN_DEFAULT_COUNT).toBe(2)
    expect(resolveMultiSpawnCount(0)).toBe(MULTI_SPAWN_MIN_COUNT)
    expect(resolveMultiSpawnCount(-40)).toBe(MULTI_SPAWN_MIN_COUNT)
    expect(resolveMultiSpawnCount(500)).toBe(MULTI_SPAWN_MAX_COUNT)
    expect(resolveMultiSpawnCount(2.6)).toBe(3)
    // Non-numeric (a string in a hand-edited configs.json, NaN, null) is not a
    // count at all — fall back to the default rather than to NaN copies.
    expect(resolveMultiSpawnCount('3')).toBe(MULTI_SPAWN_DEFAULT_COUNT)
    expect(resolveMultiSpawnCount(Number.NaN)).toBe(MULTI_SPAWN_DEFAULT_COUNT)
    expect(resolveMultiSpawnCount(null)).toBe(MULTI_SPAWN_DEFAULT_COUNT)
  })

  it('steps 1 -> 9 and wraps, so the control never dead-ends', () => {
    expect(stepMultiSpawnCount(1)).toBe(2)
    expect(stepMultiSpawnCount(8)).toBe(9)
    expect(stepMultiSpawnCount(9)).toBe(1)
    expect(stepMultiSpawnCount(undefined)).toBe(3) // default 2, stepped
    expect(stepMultiSpawnCount(99)).toBe(1)        // clamped to 9 first, then wrapped
  })
})

describe('the migration counter', () => {
  it('counts live sessions of the config, skipping the config-less Ask session', () => {
    const c = cfg('a')
    const sessions = [sess('s1', 'a'), sess('s2', 'a'), sess('s3', 'b'), sess('ask', undefined, 'ask')]
    expect(multiSpawnCopyCount(c, sessions, [])).toBe(2)
  })

  it('counts a detached remote as a copy of its config', () => {
    expect(multiSpawnCopyCount(sshCfg('a'), [sess('s1', 'a')], [remote('det-1', 'a')])).toBe(2)
  })

  it('never double-counts a remote whose session is currently live', () => {
    // App-restart: the session came back AND is still in the registry. That is
    // one copy, not two — filterLiveEntries is what keeps it honest.
    expect(multiSpawnCopyCount(sshCfg('a'), [sess('det-1', 'a')], [remote('det-1', 'a')])).toBe(1)
  })

  it("ignores another config's sessions and remotes", () => {
    expect(multiSpawnCopyCount(cfg('a'), [sess('s1', 'b'), sess('s2', 'b')], [])).toBe(0)
    expect(multiSpawnCopyCount(sshCfg('a', { sshConfig: { host: 'other', port: 22, username: 'x', remotePath: '/' } }), [], [remote('d', 'zzz')])).toBe(0)
  })
})

describe('the migration decision — enable-only, idempotent', () => {
  it('enables a config with 2 live sessions', () => {
    expect(configsToEnableMultiSpawn([cfg('a')], [sess('s1', 'a'), sess('s2', 'a')], [])).toEqual(['a'])
  })

  it('enables a config with 1 live session + 1 resumable remote', () => {
    expect(configsToEnableMultiSpawn([sshCfg('a')], [sess('s1', 'a')], [remote('det-1', 'a')])).toEqual(['a'])
  })

  it('leaves a config with a single copy alone (live OR resumable)', () => {
    expect(configsToEnableMultiSpawn([cfg('a')], [sess('s1', 'a')], [])).toEqual([])
    expect(configsToEnableMultiSpawn([sshCfg('a')], [], [remote('det-1', 'a')])).toEqual([])
    expect(configsToEnableMultiSpawn([cfg('a')], [], [])).toEqual([])
  })

  it('leaves an already-enabled config alone — it is never rewritten', () => {
    const configs = [cfg('a', { allowMultiSpawn: true })]
    expect(configsToEnableMultiSpawn(configs, [sess('s1', 'a'), sess('s2', 'a')], [])).toEqual([])
  })

  it('NEVER disables: an enabled config with one copy, or none, is untouched', () => {
    const configs = [cfg('a', { allowMultiSpawn: true }), cfg('b', { allowMultiSpawn: true })]
    expect(configsToEnableMultiSpawn(configs, [sess('s1', 'a')], [])).toEqual([])
  })

  it('is idempotent — applying the result and re-running finds nothing', () => {
    const configs = [cfg('a'), cfg('b')]
    const sessions = [sess('s1', 'a'), sess('s2', 'a'), sess('s3', 'b')]
    const first = configsToEnableMultiSpawn(configs, sessions, [])
    expect(first).toEqual(['a'])
    const applied = configs.map((c) => (first.includes(c.id) ? { ...c, allowMultiSpawn: true } : c))
    expect(configsToEnableMultiSpawn(applied, sessions, [])).toEqual([])
  })

  it('returns every qualifying config in one pass', () => {
    const configs = [cfg('a'), cfg('b'), cfg('c')]
    const sessions = [sess('1', 'a'), sess('2', 'a'), sess('3', 'b'), sess('4', 'b'), sess('5', 'c')]
    expect(configsToEnableMultiSpawn(configs, sessions, [])).toEqual(['a', 'b'])
  })
})

describe('popover placement', () => {
  const viewport = { width: 1200, height: 800 }

  it('sits below the anchor, right-aligned to it, when there is room', () => {
    const p = placeMultiSpawnPopover({ top: 100, right: 400, bottom: 120 }, viewport)
    expect(p.above).toBe(false)
    expect(p.top).toBe(126)
    expect(p.left).toBe(400 - MULTI_SPAWN_POPOVER_WIDTH)
  })

  it('flips ABOVE a row near the bottom of a full list', () => {
    const p = placeMultiSpawnPopover({ top: 760, right: 400, bottom: 780 }, viewport)
    expect(p.above).toBe(true)
    expect(p.top).toBeLessThan(760)
  })

  it('never runs off the left edge of a narrow sidebar', () => {
    const p = placeMultiSpawnPopover({ top: 100, right: 120, bottom: 120 }, viewport)
    expect(p.left).toBeGreaterThanOrEqual(8)
  })

  it('never runs off the right edge either', () => {
    const p = placeMultiSpawnPopover({ top: 100, right: 5000, bottom: 120 }, viewport)
    expect(p.left + MULTI_SPAWN_POPOVER_WIDTH).toBeLessThanOrEqual(viewport.width)
  })
})
