import { describe, it, expect } from 'vitest'
import {
  isStale, deriveKpis, activityBuckets, typeCounts, indexHealth, filterProjects,
} from '../../../src/renderer/components/memory/memory-stats'
import type { MemoryFile, MemoryProject } from '../../../src/shared/types'

const NOW = 1_750_000_000_000
const DAY = 86_400_000
const mem = (over: Partial<MemoryFile>): MemoryFile => ({
  id: 'x', name: 'x', filename: 'x.md', project: 'p', projectDir: 'P', type: 'project',
  description: '', size: 100, modified: NOW, hasFrontmatter: true, path: '/x', ...over,
})
const proj = (over: Partial<MemoryProject>): MemoryProject => ({
  name: 'p', projectDir: 'P', fileCount: 1, totalSize: 100, lastModified: NOW, types: {}, ...over,
})

describe('memory-stats', () => {
  it('isStale: strictly older than 30d', () => {
    expect(isStale(mem({ modified: NOW - 31 * DAY }), NOW)).toBe(true)
    expect(isStale(mem({ modified: NOW - 29 * DAY }), NOW)).toBe(false)
  })
  it('deriveKpis: totals, touchedThisWeek, stale count + pct', () => {
    const ms = [mem({ modified: NOW - 1 * DAY }), mem({ id: 'y', modified: NOW - 40 * DAY }),
      mem({ id: 'z', modified: NOW - 8 * DAY })]
    const k = deriveKpis(ms, [proj({})], NOW)
    expect(k.total).toBe(3); expect(k.projects).toBe(1)
    expect(k.totalSize).toBe(300)
    expect(k.touchedThisWeek).toBe(1)
    expect(k.staleCount).toBe(1)
    expect(k.stalePct).toBe(33)
  })
  it('activityBuckets: 12 weekly buckets, oldest first, counts by mtime', () => {
    const ms = [mem({ modified: NOW - 1 * DAY }), mem({ id: 'y', modified: NOW - 1 * DAY }),
      mem({ id: 'z', modified: NOW - 8 * DAY }), mem({ id: 'w', modified: NOW - 400 * DAY })]
    const b = activityBuckets(ms, NOW, 12)
    expect(b).toHaveLength(12)
    expect(b[11]).toBe(2)
    expect(b[10]).toBe(1)
    expect(b.reduce((a, c) => a + c, 0)).toBe(3)
  })
  it('typeCounts ordered by TYPE_ORDER, zero types omitted', () => {
    const ms = [mem({}), mem({ id: 'y', type: 'feedback' }), mem({ id: 'z', type: 'feedback' })]
    expect(typeCounts(ms).map(t => t.type)).toEqual(['feedback', 'project'])
    expect(typeCounts(ms).find(t => t.type === 'feedback')!.count).toBe(2)
  })
  it('indexHealth: healthy = has MEMORY.md and <=200 lines', () => {
    const ps = [proj({ memoryMdLines: 150 }), proj({ name: 'q', memoryMdLines: 345 }), proj({ name: 'r' })]
    expect(indexHealth(ps)).toEqual({ healthy: 1, total: 3, overLimit: 1, missing: 1 })
  })
  it('filterProjects: all | active30d | stale (project has >=1 stale memory)', () => {
    const fresh = proj({ name: 'fresh', projectDir: 'F', lastModified: NOW - DAY })
    const old = proj({ name: 'old', projectDir: 'O', lastModified: NOW - 60 * DAY })
    const ms = [mem({ projectDir: 'F', modified: NOW - DAY }), mem({ id: 'y', projectDir: 'F', modified: NOW - 45 * DAY }),
      mem({ id: 'z', projectDir: 'O', modified: NOW - 60 * DAY })]
    expect(filterProjects([fresh, old], ms, 'all', NOW)).toHaveLength(2)
    expect(filterProjects([fresh, old], ms, 'active30d', NOW).map(p => p.name)).toEqual(['fresh'])
    expect(filterProjects([fresh, old], ms, 'stale', NOW).map(p => p.name)).toEqual(['fresh', 'old'])
  })
})
