/**
 * Pure unit test (system Node) for the main-side import orchestration. It slices
 * parsed sessions into bounded chunks and drives them through an injected
 * postChunk(sessions) => Promise<progress> surface (the real one is the
 * supervisor's migrate()). Asserts chunk bounds, full coverage, and tally
 * aggregation — WITHOUT any better-sqlite3.
 */
import { describe, it, expect, vi } from 'vitest'
import { runImport } from '../../../src/main/logging/legacy-log-importer'
import type { ParsedSession } from '../../../src/main/logging/legacy-log-parser'

function mkSession(id: string, events: number, bytesEach = 4): ParsedSession {
  return {
    sessionId: id,
    configLabel: 'L',
    provider: 'claude',
    startedAt: 1,
    events: Array.from({ length: events }, (_, i) => ({ ts: i, type: 'data' as const, data: 'x'.repeat(bytesEach) })),
  }
}

describe('legacy-log-importer runImport', () => {
  it('chunks by session count and aggregates progress', async () => {
    const sessions = Array.from({ length: 55 }, (_, i) => mkSession(`s${i}`, 1))
    const seenChunkSizes: number[] = []
    const postChunk = vi.fn(async (chunk: ParsedSession[]) => {
      seenChunkSizes.push(chunk.length)
      return { importedSessions: chunk.length, skippedSessions: 0, failedSessions: 0, importedEvents: chunk.length }
    })

    const progressUpdates: number[] = []
    const report = await runImport(sessions, postChunk, {
      maxSessionsPerChunk: 25,
      maxBytesPerChunk: 10 * 1024 * 1024,
      onProgress: (done, total) => progressUpdates.push(done),
    })

    // 55 sessions -> 25 + 25 + 5
    expect(seenChunkSizes).toEqual([25, 25, 5])
    expect(report.importedSessions).toBe(55)
    expect(report.skippedSessions).toBe(0)
    expect(report.importedEvents).toBe(55)
    expect(report.totalSessions).toBe(55)
    // Final progress reaches the total.
    expect(progressUpdates[progressUpdates.length - 1]).toBe(55)
  })

  it('splits a chunk early when the byte budget is hit', async () => {
    // Each session ~ 1 MB of raw; budget 2 MB -> at most 2 per chunk.
    const sessions = Array.from({ length: 5 }, (_, i) => mkSession(`b${i}`, 1, 1024 * 1024))
    const seen: number[] = []
    const postChunk = vi.fn(async (chunk: ParsedSession[]) => {
      seen.push(chunk.length)
      return { importedSessions: chunk.length, skippedSessions: 0, failedSessions: 0, importedEvents: chunk.length }
    })
    await runImport(sessions, postChunk, { maxSessionsPerChunk: 25, maxBytesPerChunk: 2 * 1024 * 1024 })
    // No chunk exceeds the byte budget -> each chunk has <= 2 sessions.
    expect(Math.max(...seen)).toBeLessThanOrEqual(2)
    expect(seen.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('aggregates skips reported by the worker', async () => {
    const sessions = [mkSession('x', 1), mkSession('y', 1)]
    const postChunk = vi.fn(async () => ({ importedSessions: 1, skippedSessions: 1, failedSessions: 0, importedEvents: 1 }))
    const report = await runImport(sessions, postChunk, { maxSessionsPerChunk: 25, maxBytesPerChunk: 9e9 })
    expect(report.importedSessions).toBe(1)
    expect(report.skippedSessions).toBe(1)
  })

  it('aggregates FAILED sessions reported by the worker (kept distinct from skips)', async () => {
    const sessions = [mkSession('p', 1), mkSession('q', 1), mkSession('r', 1)]
    const postChunk = vi.fn(async () => ({ importedSessions: 2, skippedSessions: 0, failedSessions: 1, importedEvents: 2 }))
    const report = await runImport(sessions, postChunk, { maxSessionsPerChunk: 25, maxBytesPerChunk: 9e9 })
    expect(report.failedSessions).toBe(1)
    expect(report.skippedSessions).toBe(0)
    expect(report.importedSessions).toBe(2)
  })

  it('handles an empty session list without calling postChunk', async () => {
    const postChunk = vi.fn(async () => ({ importedSessions: 0, skippedSessions: 0, failedSessions: 0, importedEvents: 0 }))
    const report = await runImport([], postChunk, { maxSessionsPerChunk: 25, maxBytesPerChunk: 9e9 })
    expect(postChunk).not.toHaveBeenCalled()
    expect(report.totalSessions).toBe(0)
  })

  it('always ships a single session that alone exceeds the byte budget (lone-oversize)', async () => {
    // One ~3 MB session against a 2 MB budget must STILL import, alone in its chunk
    // (the chunk.length===0 guard) -> a huge session is never silently dropped.
    const sessions = [mkSession('huge', 1, 3 * 1024 * 1024)]
    const seen: number[] = []
    const postChunk = vi.fn(async (chunk: ParsedSession[]) => {
      seen.push(chunk.length)
      return { importedSessions: chunk.length, skippedSessions: 0, failedSessions: 0, importedEvents: chunk.length }
    })
    const report = await runImport(sessions, postChunk, { maxSessionsPerChunk: 25, maxBytesPerChunk: 2 * 1024 * 1024 })
    expect(postChunk).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([1])
    expect(report.importedSessions).toBe(1)
    expect(report.totalSessions).toBe(1)
  })
})
