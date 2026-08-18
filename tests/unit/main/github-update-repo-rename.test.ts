// Pre-emptive repo-rename soft-switch (adoptRenamedRepoIfLive):
//   - a valid existing override wins (manual choice / prior adopt)
//   - no override + renamed repo LIVE  -> adopt + persist + use it this session
//   - no override + renamed repo 404/error -> stay on the current repo (fail-safe)
// Deps are injected so this needs no network or registry.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  adoptRenamedRepoIfLive,
  activeRepo,
  RENAMED_REPO,
  _resetActiveRepoForTest,
  type AdoptRenamedDeps,
} from '../../../src/main/github-update'

const DEFAULT_REPO = 'nubbymong/claude-command-center'

function deps(over: Partial<AdoptRenamedDeps> = {}): AdoptRenamedDeps & { writes: string[] } {
  const writes: string[] = []
  return {
    readOverride: over.readOverride ?? (() => null),
    writeOverride: over.writeOverride ?? ((s) => { writes.push(s); return true }),
    probe: over.probe ?? (async () => false),
    writes,
  }
}

beforeEach(() => _resetActiveRepoForTest())

describe('adoptRenamedRepoIfLive', () => {
  it('adopts + persists the renamed repo once it is live, and uses it this session', async () => {
    const d = deps({ probe: async (slug) => slug === RENAMED_REPO })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe(RENAMED_REPO)
    expect(d.writes).toEqual([RENAMED_REPO])   // persisted
    expect(activeRepo()).toBe(RENAMED_REPO)     // in effect immediately, no restart
  })

  it('stays on the current repo while the renamed repo 404s (not renamed yet)', async () => {
    const d = deps({ probe: async () => false })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe(DEFAULT_REPO)
    expect(d.writes).toEqual([])                // nothing persisted
    expect(activeRepo()).toBe(DEFAULT_REPO)
  })

  it('stays on the current repo when the probe throws (network error / timeout)', async () => {
    const d = deps({ probe: async () => { throw new Error('ENOTFOUND') } })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe(DEFAULT_REPO)
    expect(d.writes).toEqual([])
  })

  it('respects an existing valid override and never re-probes', async () => {
    const probe = vi.fn(async () => true)
    const d = deps({ readOverride: () => 'someorg/custom-fork', probe })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe('someorg/custom-fork')
    expect(probe).not.toHaveBeenCalled()
    expect(activeRepo()).toBe('someorg/custom-fork')
  })

  it('ignores a malformed override and still adopts the renamed repo when live', async () => {
    const d = deps({ readOverride: () => 'not a valid slug!!', probe: async () => true })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe(RENAMED_REPO)
  })

  it('uses this session even if persisting the override fails', async () => {
    const d = deps({ probe: async () => true, writeOverride: () => false })
    const got = await adoptRenamedRepoIfLive(d)
    expect(got).toBe(RENAMED_REPO)
    expect(activeRepo()).toBe(RENAMED_REPO)
  })

  it('the renamed target is a well-formed same-owner slug (nubbymong/ai-code-conductor)', () => {
    expect(RENAMED_REPO).toBe('nubbymong/ai-code-conductor')
    expect(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(RENAMED_REPO)).toBe(true)
  })
})
