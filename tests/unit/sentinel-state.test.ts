import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os'
import { SentinelState } from '../../src/main/sentinel/sentinel-state'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sen-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const finding = {
  id: 'obs:model:claude-x-1', kind: 'registry-proposal' as const, severity: 'warn' as const,
  title: 'Unknown model claude-x-1', evidence: 'statusline', status: 'open' as const, createdAt: 1,
}

describe('SentinelState', () => {
  it('persists and reloads findings + lastSeenCcVersion', () => {
    const s = new SentinelState(dir)
    s.upsertFinding(finding)
    s.setLastSeenCcVersion('2.0.13')
    const s2 = new SentinelState(dir)
    expect(s2.snapshot().findings).toHaveLength(1)
    expect(s2.snapshot().lastSeenCcVersion).toBe('2.0.13')
  })
  it('upsert by id is idempotent (dedup) and does not resurrect non-open findings', () => {
    const s = new SentinelState(dir)
    s.upsertFinding(finding); s.upsertFinding(finding)
    expect(s.snapshot().findings).toHaveLength(1)
    s.setStatus(finding.id, 'dismissed')
    s.upsertFinding(finding)                       // re-observation of a dismissed finding
    expect(s.snapshot().findings[0].status).toBe('dismissed')
  })
  it('setStatus transitions and notifies subscribers', () => {
    const s = new SentinelState(dir)
    let pushes = 0; s.subscribe(() => pushes++)
    s.upsertFinding(finding); s.setStatus(finding.id, 'applied')
    expect(s.snapshot().findings[0].status).toBe('applied')
    expect(pushes).toBe(2)
  })
  it('corrupt state file -> empty state, no throw (fail-open)', () => {
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), 'oops')
    expect(new SentinelState(dir).snapshot().findings).toEqual([])
  })
})
