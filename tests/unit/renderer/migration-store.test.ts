/**
 * Unit test for the migration store gating + run flow. Mocks window.electronAPI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMigrationStore } from '../../../src/renderer/stores/migrationStore'

const api = {
  detect: vi.fn(),
  run: vi.fn(),
  reclaim: vi.fn(),
  onProgress: vi.fn(() => () => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = { electronAPI: { logMigration: api } }
  useMigrationStore.setState({ phase: 'idle', present: false, sessionFolders: 0, progressDone: 0, progressTotal: 0, report: null })
})

describe('migrationStore', () => {
  it('detect() populates present + sessionFolders', async () => {
    api.detect.mockResolvedValue({ present: true, sessionFolders: 990, frozen: false })
    await useMigrationStore.getState().detect()
    expect(useMigrationStore.getState().present).toBe(true)
    expect(useMigrationStore.getState().sessionFolders).toBe(990)
  })

  it('run() drives phase idle -> running -> done and stores the report', async () => {
    const report = { totalSessions: 2, importedSessions: 2, skippedSessions: 0, importedEvents: 5, unparseable: [], dbBytesBefore: 10, dbBytesAfter: 20 }
    api.run.mockResolvedValue(report)
    const phases: string[] = []
    const unsub = useMigrationStore.subscribe((s) => phases.push(s.phase))
    await useMigrationStore.getState().run()
    unsub()
    expect(phases).toContain('running')
    expect(useMigrationStore.getState().phase).toBe('done')
    expect(useMigrationStore.getState().report).toEqual(report)
  })

  it('run() goes to phase error when the IPC rejects', async () => {
    api.run.mockRejectedValue(new Error('worker down'))
    await useMigrationStore.getState().run()
    expect(useMigrationStore.getState().phase).toBe('error')
    expect(useMigrationStore.getState().errorMessage).toMatch(/worker down/)
  })

  it('reclaim() moves done -> reclaimed and records reclaimed bytes', async () => {
    useMigrationStore.setState({ phase: 'done', report: { totalSessions: 1, importedSessions: 1, skippedSessions: 0, importedEvents: 1, unparseable: [], dbBytesBefore: 1, dbBytesAfter: 2 } })
    api.reclaim.mockResolvedValue({ deletedFolders: 990, reclaimedBytes: 5_900_000_000, failedFolders: [] })
    await useMigrationStore.getState().reclaim()
    expect(useMigrationStore.getState().phase).toBe('reclaimed')
    expect(useMigrationStore.getState().reclaimedBytes).toBe(5_900_000_000)
  })

  it('shouldSurface is true only when present, not migrated, and not yet seen', () => {
    const { shouldSurface } = useMigrationStore.getState()
    expect(shouldSurface({ present: true, migrated: false, seen: false })).toBe(true)
    expect(shouldSurface({ present: true, migrated: true, seen: false })).toBe(false)
    expect(shouldSurface({ present: true, migrated: false, seen: true })).toBe(false)
    expect(shouldSurface({ present: false, migrated: false, seen: false })).toBe(false)
  })
})
