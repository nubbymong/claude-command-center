import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useMigrationStore } from '../stores/migrationStore'

const CLOSE_ANIM_MS = 200

/**
 * One-time surfacing notice for migrating the legacy file logs into SQLite.
 *
 * NET-NEW and separate from LoggingConsentPrompt: existing users already
 * dismissed that consent dialog, so this is how they learn the old logs can be
 * imported. Shown when legacy logs are detected, not yet migrated, and this
 * notice has not been seen (settings.legacyLogsSurfacingSeen). Mouse-driven; it
 * does not autofocus or trap keys (so it never interrupts typing in a terminal).
 *
 * "Import now" runs the migration inline; "Not now" marks the notice seen so it
 * never nags again (the action stays available in Settings -> Security).
 */
export default function LogMigrationPrompt() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const present = useMigrationStore((s) => s.present)
  const sessionFolders = useMigrationStore((s) => s.sessionFolders)
  const detect = useMigrationStore((s) => s.detect)
  const run = useMigrationStore((s) => s.run)
  const shouldSurface = useMigrationStore((s) => s.shouldSurface)

  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => { void detect() }, [detect])
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const seen = settings.legacyLogsSurfacingSeen === true
  const migrated = settings.legacyLogsMigrated === true
  const surface = shouldSurface({ present, migrated, seen })

  const dismiss = (alsoRun: boolean) => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      void updateSettings({ legacyLogsSurfacingSeen: true })
      if (alsoRun) void run()
    }, CLOSE_ANIM_MS)
  }

  if (!surface) return null

  const visible = entering && !closing
  const cardClass = [
    'fixed bottom-4 right-4 z-40 w-80 rounded-xl shadow-2xl p-4',
    'transition-all duration-200 ease-out',
    visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
  ].join(' ')

  return (
    <div
      className={cardClass}
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      role="dialog"
      aria-labelledby="log-migration-heading"
      tabIndex={-1}
    >
      <h2 id="log-migration-heading" className="text-sm font-semibold text-text mb-1">
        Import your existing logs
      </h2>
      <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--text-secondary)' }}>
        We found {sessionFolders.toLocaleString()} folder(s) of older session logs. Import them into the new
        searchable store. Your original files are kept until you choose to reclaim the space.
      </p>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => dismiss(false)}
          className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
          style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
        >
          Not now
        </button>
        <button
          onClick={() => dismiss(true)}
          className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--color-blue)', color: 'var(--color-crust)' }}
        >
          Import now
        </button>
      </div>
    </div>
  )
}
