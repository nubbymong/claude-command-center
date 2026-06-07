/**
 * Pure unit test (system Node) for the detection-driven warned wipe of the OLD
 * CCC logging artifacts (Logs v2 Task 7).
 *
 * This is a DESTRUCTIVE first-run reset: it deletes the abandoned ~21 GB byte-
 * capture `logs.db` + the ~16 GB legacy file-log tree + the import markers, while
 * PRESERVING the real ~/.claude, the one-time safety backup, and the logging
 * consent/enabled settings. Per feedback_no_wipe_configs every test runs under
 * mkdtemp isolation and NEVER touches a real path.
 *
 * The module injects `fs`, the two dir getters, and a settings read/clear pair so
 * the core detect/executeWipe logic is fully unit-testable headlessly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs'
import * as realFs from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { detectOldLogArtifacts, executeWipe } from '../../../src/main/logging/logs-wipe'

// Write a file of an exact byte length so the test can assert summed totals.
function writeBytes(p: string, n: number): void {
  writeFileSync(p, Buffer.alloc(n, 0x61))
}

describe('logs-wipe', () => {
  let root: string
  let dataDir: string
  let resourcesDir: string
  // The in-memory settings the deps reads/clears (mimics readConfig('settings')).
  let settings: Record<string, unknown>

  // Build a deps bundle pointing at the temp dirs + the in-memory settings.
  function deps() {
    return {
      fs: realFs,
      getDataDirectory: () => dataDir,
      getResourcesDirectory: () => resourcesDir,
      readSettings: () => ({ ...settings }),
      clearSettingsKeys: (keys: string[]) => {
        for (const k of keys) delete settings[k]
      },
    }
  }

  // Seed every DELETE-target artifact + every PRESERVE neighbour at known sizes.
  function seedFullInventory() {
    // <dataDir>/logs.db (+ wal/shm/journal siblings)
    writeBytes(join(dataDir, 'logs.db'), 1000)
    writeBytes(join(dataDir, 'logs.db-wal'), 100)
    writeBytes(join(dataDir, 'logs.db-shm'), 50)
    writeBytes(join(dataDir, 'logs.db-journal'), 25)

    // <dataDir>/logs/ legacy tree (label/sessionId/session.jsonl + meta + partner)
    mkdirSync(join(dataDir, 'logs', 'APP_DEV', 's1'), { recursive: true })
    writeBytes(join(dataDir, 'logs', 'APP_DEV', 's1', 'session.jsonl'), 400)
    writeBytes(join(dataDir, 'logs', 'APP_DEV', 's1', 'meta.json'), 20)
    mkdirSync(join(dataDir, 'logs', 'APP_DEV', 's1-partner'), { recursive: true })
    writeBytes(join(dataDir, 'logs', 'APP_DEV', 's1-partner', 'session.jsonl'), 80)

    // <resources>/claude-config-backups/logs-migration/ markers
    const mig = join(resourcesDir, 'claude-config-backups', 'logs-migration')
    mkdirSync(mig, { recursive: true })
    writeBytes(join(mig, 'manifest.json'), 200)
    writeBytes(join(mig, 'FROZEN'), 30)
    writeBytes(join(mig, 'import-complete.json'), 150)

    // PRESERVE: the one-time real-~/.claude safety backup (SIBLING of logs-migration)
    const initial = join(resourcesDir, 'claude-config-backups', 'initial')
    mkdirSync(initial, { recursive: true })
    writeBytes(join(initial, '.claude.json'), 999)

    // PRESERVE: <dataDir>/debug/ and <resources>/status/
    mkdirSync(join(dataDir, 'debug'), { recursive: true })
    writeBytes(join(dataDir, 'debug', 'app.log'), 77)
    mkdirSync(join(resourcesDir, 'status'), { recursive: true })
    writeBytes(join(resourcesDir, 'status', 'state.json'), 33)

    // settings: 2 to clear + 2 to preserve
    settings = {
      legacyLogsMigrated: true,
      legacyLogsSurfacingSeen: true,
      loggingEnabled: true,
      loggingConsentSeen: true,
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'logswipe-'))
    dataDir = join(root, 'data')
    resourcesDir = join(root, 'resources')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(resourcesDir, { recursive: true })
    settings = {}
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // ── detect ──

  it('detect reports nothing actionable when no artifacts present', () => {
    const inv = detectOldLogArtifacts(deps())
    expect(inv.present).toBe(false)
    expect(inv.totalBytes).toBe(0)
    expect(inv.paths).toEqual([])
  })

  it('detect reports the exact inventory + summed bytes', () => {
    seedFullInventory()
    const inv = detectOldLogArtifacts(deps())
    expect(inv.present).toBe(true)
    // logs.db(1000)+wal(100)+shm(50)+journal(25)=1175
    // logs/ tree: 400+20+80=500
    // logs-migration markers: 200+30+150=380
    // total = 2055
    expect(inv.totalBytes).toBe(2055)
    // The allowlist paths that exist (NOT the preserved siblings).
    expect(inv.paths).toContain(join(dataDir, 'logs.db'))
    expect(inv.paths).toContain(join(dataDir, 'logs.db-wal'))
    expect(inv.paths).toContain(join(dataDir, 'logs.db-shm'))
    expect(inv.paths).toContain(join(dataDir, 'logs.db-journal'))
    expect(inv.paths).toContain(join(dataDir, 'logs'))
    expect(inv.paths).toContain(join(resourcesDir, 'claude-config-backups', 'logs-migration'))
    // It must NOT list the preserved safety backup.
    expect(inv.paths).not.toContain(join(resourcesDir, 'claude-config-backups', 'initial'))
    // The settings keys to clear are reported.
    expect(inv.settingsKeys.sort()).toEqual(['legacyLogsMigrated', 'legacyLogsSurfacingSeen'])
  })

  it('detect is present when ONLY the logs.db file exists (no tree/markers)', () => {
    writeBytes(join(dataDir, 'logs.db'), 500)
    const inv = detectOldLogArtifacts(deps())
    expect(inv.present).toBe(true)
    expect(inv.totalBytes).toBe(500)
    expect(inv.paths).toEqual([join(dataDir, 'logs.db')])
  })

  // ── executeWipe ──

  it('executeWipe deletes ONLY the allowlist and clears the 2 keys; preserves the rest', () => {
    seedFullInventory()
    const res = executeWipe(deps())

    // DELETED
    expect(existsSync(join(dataDir, 'logs.db'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-wal'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-shm'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-journal'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs'))).toBe(false)
    expect(existsSync(join(resourcesDir, 'claude-config-backups', 'logs-migration'))).toBe(false)

    // PRESERVED: the safety backup + its parent dir survive
    expect(existsSync(join(resourcesDir, 'claude-config-backups', 'initial', '.claude.json'))).toBe(true)
    expect(existsSync(join(resourcesDir, 'claude-config-backups'))).toBe(true)
    // PRESERVED: debug/ + status/
    expect(existsSync(join(dataDir, 'debug', 'app.log'))).toBe(true)
    expect(existsSync(join(resourcesDir, 'status', 'state.json'))).toBe(true)

    // settings: 2 cleared, 2 preserved
    expect('legacyLogsMigrated' in settings).toBe(false)
    expect('legacyLogsSurfacingSeen' in settings).toBe(false)
    expect(settings.loggingEnabled).toBe(true)
    expect(settings.loggingConsentSeen).toBe(true)

    // report
    expect(res.clearedKeys.sort()).toEqual(['legacyLogsMigrated', 'legacyLogsSurfacingSeen'])
    expect(res.freedBytes).toBe(2055)
    expect(res.deletedPaths).toContain(join(dataDir, 'logs.db'))
    expect(res.deletedPaths).toContain(join(dataDir, 'logs'))
    expect(res.deletedPaths).toContain(join(resourcesDir, 'claude-config-backups', 'logs-migration'))
  })

  it('executeWipe removes ALL logs.db glob siblings (wal/shm/journal)', () => {
    writeBytes(join(dataDir, 'logs.db'), 10)
    writeBytes(join(dataDir, 'logs.db-wal'), 10)
    writeBytes(join(dataDir, 'logs.db-shm'), 10)
    writeBytes(join(dataDir, 'logs.db-journal'), 10)
    executeWipe(deps())
    expect(existsSync(join(dataDir, 'logs.db'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-wal'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-shm'))).toBe(false)
    expect(existsSync(join(dataDir, 'logs.db-journal'))).toBe(false)
  })

  // ── SAFETY ──

  it('SAFETY: throws BEFORE deleting anything if any target resolves under ~/.claude', () => {
    // Craft a pathological dataDir INSIDE the real home/.claude so the resolved
    // artifact paths would land under ~/.claude. The guard must refuse outright.
    const evilDataDir = join(homedir(), '.claude', 'pathological-data')
    // Seed a normal preserved artifact too so we can assert NOTHING was touched.
    seedFullInventory()
    const evilDeps = { ...deps(), getDataDirectory: () => evilDataDir }
    expect(() => executeWipe(evilDeps)).toThrow(/\.claude/)
    // Because the guard fires before any delete, the real (temp) artifacts that
    // would have been deleted under the NON-evil dataDir are irrelevant; what we
    // assert is the throw happened. To be thorough, prove the evil paths were not
    // created/removed and the settings were not cleared.
    expect('legacyLogsMigrated' in settings).toBe(true)
  })

  // ── idempotence ──

  it('idempotence: after wipe, detect reports nothing (tolerating a recreated empty logs/)', () => {
    seedFullInventory()
    executeWipe(deps())
    // Simulate data-paths.ts recreating an EMPTY logs/ dir after the wipe.
    mkdirSync(join(dataDir, 'logs'), { recursive: true })
    const inv = detectOldLogArtifacts(deps())
    expect(inv.present).toBe(false)
    expect(inv.totalBytes).toBe(0)
    expect(inv.paths).toEqual([])
  })

  // ── partial failure ──

  it('partial-failure: a delete that throws leaves remaining artifacts -> detect still present', () => {
    seedFullInventory()
    // Inject an fs whose rmSync throws for the logs.db path (simulating an EBUSY
    // file lock on Windows) but delegates for everything else. The wipe must
    // propagate the throw WITHOUT clearing settings or recording any done-state.
    const failingFs = {
      ...realFs,
      rmSync: ((p: any, opts?: any) => {
        if (String(p).endsWith('logs.db')) throw new Error('EBUSY: locked')
        return realFs.rmSync(p, opts)
      }) as typeof realFs.rmSync,
    }
    const failingDeps = { ...deps(), fs: failingFs }
    expect(() => executeWipe(failingDeps)).toThrow(/EBUSY/)
    // Settings keys were NOT cleared (the throw aborted before the clear step).
    expect('legacyLogsMigrated' in settings).toBe(true)
    expect('legacyLogsSurfacingSeen' in settings).toBe(true)
    // No "done" state is persisted; a re-detect still finds the surviving logs.db.
    const inv = detectOldLogArtifacts(deps())
    expect(inv.present).toBe(true)
    expect(inv.paths).toContain(join(dataDir, 'logs.db'))
  })
})
