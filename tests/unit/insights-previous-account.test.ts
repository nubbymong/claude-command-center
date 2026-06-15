import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Unit 3 W5: the previous-run comparison must be per-account. Previously it picked
// the last complete run across the WHOLE catalogue, so in multi-account a run for
// account A was diffed against account B's run (nonsense "what changed").

const h = vi.hoisted(() => ({ resourcesDir: '' }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))

import { loadPreviousKpis } from '../../src/main/insights-runner'

let tmpRoot = ''

function writeCatalogue(runs: unknown[]) {
  writeFileSync(join(h.resourcesDir, 'insights', 'catalogue.json'), JSON.stringify({ runs }))
}
function writeKpis(id: string, kpis: unknown) {
  const dir = join(h.resourcesDir, 'insights', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kpis.json'), JSON.stringify(kpis))
}

describe('loadPreviousKpis account isolation (W5)', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-prev-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    mkdirSync(join(h.resourcesDir, 'insights'), { recursive: true })
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('compares against the previous complete run of the SAME account', () => {
    writeCatalogue([
      { id: 'a1', status: 'complete', timestamp: 1, profileId: 'A' },
      { id: 'b1', status: 'complete', timestamp: 2, profileId: 'B' },
      { id: 'a2', status: 'complete', timestamp: 3, profileId: 'A' }, // current
    ])
    writeKpis('a1', { marker: 'A-prev' })
    writeKpis('b1', { marker: 'B-prev' })
    const prev = loadPreviousKpis('a2')
    expect(prev).toContain('A-prev')
    expect(prev).not.toContain('B-prev')
  })

  it('returns null when the account has no prior complete run (ignores other accounts)', () => {
    writeCatalogue([
      { id: 'b1', status: 'complete', timestamp: 1, profileId: 'B' },
      { id: 'a1', status: 'complete', timestamp: 2, profileId: 'A' }, // current, no prior A
    ])
    writeKpis('b1', { marker: 'B' })
    expect(loadPreviousKpis('a1')).toBeNull()
  })

  it('single-account (no profileId) still compares against the previous run', () => {
    writeCatalogue([
      { id: 'r1', status: 'complete', timestamp: 1 },
      { id: 'r2', status: 'complete', timestamp: 2 }, // current
    ])
    writeKpis('r1', { marker: 'prev' })
    expect(loadPreviousKpis('r2')).toContain('prev')
  })
})
