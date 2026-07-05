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

// Severe-breaking-only (spec 2026-07-04): Trigger A no longer raises findings.
// Unknown model / effort observations are housekeeping, not breaking changes,
// so the observer is a safe no-op and never accumulates findings.
describe('sentinel observe (Trigger A) — no-op under severe-breaking-only', () => {
  it('known model -> no finding', () => {
    observe({ kind: 'model', value: 'claude-opus-4-8-20260601', source: 'statusline' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
  it('unknown model -> no finding (registry-proposal findings cut)', () => {
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
  it('unknown effort -> no finding (info findings cut)', () => {
    observe({ kind: 'effort', value: 'theoretical', source: 'hooks' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
  it('repeated observations never accumulate findings', () => {
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    observe({ kind: 'model', value: 'claude-vision-2', source: 'statusline' })
    observe({ kind: 'effort', value: 'theoretical', source: 'hooks' })
    expect(state.snapshot().findings).toHaveLength(0)
  })
})
