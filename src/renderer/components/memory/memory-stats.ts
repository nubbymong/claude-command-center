// Pure dashboard derivations over the scan result (spec §4.1: stats are
// renderer-derived; 751 items is trivial). All functions take `now` explicitly
// for testability. THREE staleness lenses are INTENTIONALLY distinct (spec
// §3.1): per-memory KPI, per-project Stale filter, per-project row dot.
import type { MemoryFile, MemoryProject } from '../../../shared/types'
import { TYPE_ORDER } from './memory-ui'

export const STALE_MS = 30 * 86_400_000
const WEEK_MS = 7 * 86_400_000

export function isStale(m: MemoryFile, now: number): boolean {
  return now - m.modified > STALE_MS
}

export interface MemoryKpis {
  total: number; projects: number; totalSize: number
  touchedThisWeek: number; staleCount: number; stalePct: number
}

export function deriveKpis(memories: MemoryFile[], projects: MemoryProject[], now: number): MemoryKpis {
  const staleCount = memories.filter((m) => isStale(m, now)).length
  return {
    total: memories.length,
    projects: projects.length,
    totalSize: memories.reduce((a, m) => a + m.size, 0),
    touchedThisWeek: memories.filter((m) => now - m.modified <= WEEK_MS).length,
    staleCount,
    stalePct: memories.length ? Math.round((staleCount / memories.length) * 100) : 0,
  }
}

/** Weekly mtime buckets, oldest..newest (index weeks-1 = current week). */
export function activityBuckets(memories: MemoryFile[], now: number, weeks = 12): number[] {
  const buckets = new Array<number>(weeks).fill(0)
  for (const m of memories) {
    const age = now - m.modified
    if (age < 0) continue
    const w = Math.floor(age / WEEK_MS)
    if (w < weeks) buckets[weeks - 1 - w]++
  }
  return buckets
}

export function typeCounts(memories: MemoryFile[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>()
  for (const m of memories) counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
  return TYPE_ORDER.filter((t) => counts.has(t)).map((t) => ({ type: t, count: counts.get(t)! }))
}

export interface IndexHealth { healthy: number; total: number; overLimit: number; missing: number }

export function indexHealth(projects: MemoryProject[]): IndexHealth {
  let healthy = 0, overLimit = 0, missing = 0
  for (const p of projects) {
    if (p.memoryMdLines == null) missing++
    else if (p.memoryMdLines > 200) overLimit++
    else healthy++
  }
  return { healthy, total: projects.length, overLimit, missing }
}

export type ScopeFilter = 'all' | 'active30d' | 'stale'

export function filterProjects(
  projects: MemoryProject[], memories: MemoryFile[], scope: ScopeFilter, now: number,
): MemoryProject[] {
  if (scope === 'all') return projects
  if (scope === 'active30d') return projects.filter((p) => now - p.lastModified <= STALE_MS)
  const staleDirs = new Set(memories.filter((m) => isStale(m, now)).map((m) => m.projectDir))
  return projects.filter((p) => staleDirs.has(p.projectDir))
}
