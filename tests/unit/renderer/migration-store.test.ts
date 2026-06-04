/**
 * Unit test for the migration store gating + run flow. Mocks window.electronAPI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMigrationStore } from '../../../src/renderer/stores/migrationStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'

const api = {
  detect: vi.fn(),
  run: vi.fn(),
  reclaim: vi.fn(),
  onProgress: vi.fn(() => () => {}),
}

// run() success now marks legacyLogsMigrated centrally, which routes through
// settingsStore.updateSettings -> saveConfigNow -> window.electronAPI.config.save.
// Mirror the config mock used by log-migration-prompt.test.tsx so the call is a no-op.
const configSave = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = { electronAPI: { logMigration: api, config: { save: configSave } } }
  useMigrationStore.setState({ phase: 'idle', present: false, sessionFolders: 0, progressDone: 0, progressTotal: 0, report: null })
  // Reset the migrated flag so the run() success assertion starts from false.
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, legacyLogsMigrated: false } }))
})

describe('migrationStore', () => {
  it('detect() populates present + sessionFolders', async () => {
    api.detect.mockResolvedValue({ present: true, sessionFolders: 990, frozen: false })
    await useMigrationStore.getState().detect()
    expect(useMigrationStore.getState().present).toBe(true)
    expect(useMigrationStore.getState().sessionFolders).toBe(990)
  })

  it('run() drives phase idle -> running -> done and stores the report', async () => {
    const report = { totalSessions: 2, importedSessions: 2, skippedSessions: 0, importedEvents: 5, unparseable: [], foldedPartnerDirs: 0, detectedFolders: 2, dbBytesBefore: 10, dbBytesAfter: 20 }
    api.run.mockResolvedValue(report)
    const phases: string[] = []
    const unsub = useMigrationStore.subscribe((s) => phases.push(s.phase))
    await useMigrationStore.getState().run()
    unsub()
    expect(phases).toContain('running')
    expect(useMigrationStore.getState().phase).toBe('done')
    expect(useMigrationStore.getState().report).toEqual(report)
    // run() success marks migration complete centrally (covers the prompt path too).
    expect(useSettingsStore.getState().settings.legacyLogsMigrated).toBe(true)
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

  it('reclaim() failure sets phase error with errorKind reclaim and leaves failedFolders empty', async () => {
    useMigrationStore.setState({ phase: 'done', report: { totalSessions: 1, importedSessions: 1, skippedSessions: 0, importedEvents: 1, unparseable: [], dbBytesBefore: 1, dbBytesAfter: 2 } })
    api.reclaim.mockRejectedValue(new Error('locked'))
    await useMigrationStore.getState().reclaim()
    expect(useMigrationStore.getState().phase).toBe('error')
    expect(useMigrationStore.getState().errorKind).toBe('reclaim')
    expect(useMigrationStore.getState().failedFolders).toEqual([])
    expect(useMigrationStore.getState().errorMessage).toMatch(/locked/)
  })

  it('reclaim() surfaces failedFolders from the IPC result', async () => {
    useMigrationStore.setState({ phase: 'done', report: { totalSessions: 1, importedSessions: 1, skippedSessions: 0, importedEvents: 1, unparseable: [], dbBytesBefore: 1, dbBytesAfter: 2 } })
    api.reclaim.mockResolvedValue({ deletedFolders: 5, reclaimedBytes: 1000, failedFolders: ['C:/logs/APP/s3'] })
    await useMigrationStore.getState().reclaim()
    expect(useMigrationStore.getState().phase).toBe('reclaimed')
    expect(useMigrationStore.getState().failedFolders).toEqual(['C:/logs/APP/s3'])
  })
})
