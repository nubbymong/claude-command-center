import { create } from 'zustand'

export interface MigrationReportData {
  totalSessions: number
  importedSessions: number
  skippedSessions: number
  importedEvents: number
  unparseable: { path: string; reason: string; skippedLines: number }[]
  dbBytesBefore: number
  dbBytesAfter: number
}

type Phase = 'idle' | 'running' | 'done' | 'error' | 'reclaimed'

interface MigrationState {
  phase: Phase
  present: boolean
  sessionFolders: number
  progressDone: number
  progressTotal: number
  report: MigrationReportData | null
  reclaimedBytes: number
  failedFolders: string[]          // A5
  errorMessage?: string

  detect: () => Promise<void>
  run: () => Promise<void>
  reclaim: () => Promise<void>
  shouldSurface: (args: { present: boolean; migrated: boolean; seen: boolean }) => boolean
}

export const useMigrationStore = create<MigrationState>((set, get) => ({
  phase: 'idle',
  present: false,
  sessionFolders: 0,
  progressDone: 0,
  progressTotal: 0,
  report: null,
  reclaimedBytes: 0,
  failedFolders: [],               // A5

  detect: async () => {
    try {
      const r = await window.electronAPI.logMigration.detect()
      set({ present: r.present, sessionFolders: r.sessionFolders })
    } catch {
      set({ present: false, sessionFolders: 0 })
    }
  },

  run: async () => {
    set({ phase: 'running', progressDone: 0, progressTotal: get().sessionFolders, errorMessage: undefined })
    const unsub = window.electronAPI.logMigration.onProgress(({ done, total }) => {
      set({ progressDone: done, progressTotal: total })
    })
    try {
      const report = await window.electronAPI.logMigration.run()
      set({ phase: 'done', report })
    } catch (e) {
      set({ phase: 'error', errorMessage: e instanceof Error ? e.message : String(e) })
    } finally {
      unsub()
    }
  },

  reclaim: async () => {
    try {
      const r = await window.electronAPI.logMigration.reclaim()
      set({ phase: 'reclaimed', reclaimedBytes: r.reclaimedBytes, failedFolders: r.failedFolders ?? [], present: false, sessionFolders: 0 })  // A5
    } catch (e) {
      set({ phase: 'error', errorMessage: e instanceof Error ? e.message : String(e) })
    }
  },

  shouldSurface: ({ present, migrated, seen }) => present && !migrated && !seen,
}))
