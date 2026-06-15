import { describe, it, expect } from 'vitest'
import { buildKpiSpawnArgs } from '../../src/main/insights-runner'

// Unit 3 W1: the headless KPI extraction is read-only (it reads one archived
// HTML report). It must NOT pass --dangerously-skip-permissions — `-p` already
// skips the workspace-trust dialog and --allowedTools Read pre-authorizes the
// only tool it needs (verified on the VM: an out-of-cwd absolute Read succeeds
// with no permission denials and no dangerous flag).
describe('buildKpiSpawnArgs', () => {
  it('builds a read-only print-JSON invocation', () => {
    expect(buildKpiSpawnArgs()).toEqual(['-p', '--allowedTools', 'Read', '--output-format', 'json'])
  })

  it('never includes --dangerously-skip-permissions', () => {
    expect(buildKpiSpawnArgs()).not.toContain('--dangerously-skip-permissions')
  })

  it('restricts tools to Read only', () => {
    const args = buildKpiSpawnArgs()
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('Read')
  })
})
