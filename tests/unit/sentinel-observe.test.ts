import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os'
import { SentinelState } from '../../src/main/sentinel/sentinel-state'
import { makeObserver } from '../../src/main/sentinel/sentinel-observe'
import { _initRegistryForTest, getRegistry } from '../../src/main/model-registry-service'

let dir: string, state: SentinelState, observe: ReturnType<typeof makeObserver>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-obs-'))
  _initRegistryForTest(dir)
  state = new SentinelState(dir)
  observe = makeObserver(state, getRegistry)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('sentinel observe (Trigger A)', () => {
  it('known model -> no finding', () => {
    observe({ kind: 'model', value: 'claude-opus-4-8-20260601', source: 'statusline' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
  it('known display name -> no finding (resolver handles display forms)', () => {
    observe({ kind: 'model', value: 'Opus 4.7 (1M context)', source: 'statusline' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
  it('unknown model -> registry-proposal finding with drafted overlay entry', () => {
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    const f = state.snapshot().findings[0]
    expect(f.kind).toBe('registry-proposal')
    expect(f.proposedPatch!.id).toBe('claude-vision-2')
    expect(f.proposedPatch!.provenance.addedBy).toBe('sentinel')
    expect(f.proposedPatch!.family).toBe('vision')
  })
  it('repeat observations dedup to one finding', () => {
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    expect(state.snapshot().findings).toHaveLength(1)
  })
  it('unknown effort -> info finding (no dead Apply: overlay has no effort schema)', () => {
    observe({ kind: 'effort', value: 'theoretical', source: 'hooks' })
    const f = state.snapshot().findings[0]
    expect(f.title).toContain('theoretical')
    expect(f.kind).toBe('info')
    expect(f.proposedPatch).toBeUndefined()
  })
})
