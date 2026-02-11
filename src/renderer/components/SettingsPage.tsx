import React, { useState, useEffect } from 'react'
import WhatsNewModal, { markWhatsNewSeen } from './WhatsNewModal'
import { getLatestVersion } from '../changelog'
import { useSettingsStore } from '../stores/settingsStore'

declare const __BUILD_TIME__: string

function formatBuildTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export default function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const latestVersion = getLatestVersion()

  // Sync debug mode from main process on mount
  useEffect(() => {
    window.electronAPI.debug.isEnabled().then(debugEnabled => {
      if (debugEnabled !== settings.debugMode) {
        updateSettings({ debugMode: debugEnabled })
      }
    })
  }, [])

  const save = async (updates: Partial<typeof settings>) => {
    updateSettings(updates)

    // Handle debug mode toggle
    if ('debugMode' in updates) {
      if (updates.debugMode) {
        await window.electronAPI.debug.enable()
      } else {
        await window.electronAPI.debug.disable()
      }
    }
  }

  const openDebugFolder = async () => {
    await window.electronAPI.debug.openFolder()
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h2 className="text-lg font-semibold text-text">Settings</h2>

        <Section title="Defaults">
          <Field label="Default Model">
            <select
              value={settings.defaultModel}
              onChange={e => save({ defaultModel: e.target.value })}
              className="bg-base border border-surface1 rounded px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue"
            >
              <option value="sonnet">Claude Sonnet</option>
              <option value="opus">Claude Opus</option>
              <option value="haiku">Claude Haiku</option>
            </select>
          </Field>
          <Field label="Default Working Directory">
            <input
              value={settings.defaultWorkingDirectory}
              onChange={e => save({ defaultWorkingDirectory: e.target.value })}
              placeholder="Leave empty for home directory"
              className="bg-base border border-surface1 rounded px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue placeholder:text-overlay0"
            />
          </Field>
        </Section>

        <Section title="Appearance">
          <Field label="Terminal Font Size">
            <input
              type="number"
              value={settings.terminalFontSize}
              onChange={e => save({ terminalFontSize: parseInt(e.target.value) || 14 })}
              min={10}
              max={24}
              className="bg-base border border-surface1 rounded px-3 py-2 text-sm text-text w-24 focus:outline-none focus:border-blue"
            />
          </Field>
        </Section>

        <Section title="Debug Logging">
          <Field label="Verbose Logging">
            <div className="flex items-center gap-3">
              <button
                onClick={() => save({ debugMode: !settings.debugMode })}
                className={`relative w-12 h-6 rounded-full transition-colors ${
                  settings.debugMode ? 'bg-green' : 'bg-surface1'
                }`}
              >
                <div
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                    settings.debugMode ? 'translate-x-7' : 'translate-x-1'
                  }`}
                />
              </button>
              <span className={`text-xs ${settings.debugMode ? 'text-green' : 'text-overlay0'}`}>
                {settings.debugMode ? 'ON' : 'OFF'}
              </span>
            </div>
          </Field>
          <div className="text-xs text-overlay0 mt-2">
            When enabled, logs all PTY input/output, session events, and IPC calls to app.log. Logs persist across updates.
          </div>
          <button
            onClick={openDebugFolder}
            className="mt-2 text-xs text-blue hover:text-blue/80 underline"
          >
            Open log folder
          </button>
        </Section>

        <Section title="Keyboard Shortcuts">
          <div className="space-y-1 text-sm">
            <ShortcutRow keys="Ctrl+T" action="New config" />
            <ShortcutRow keys="Ctrl+W" action="Close session" />
            <ShortcutRow keys="Ctrl+Tab" action="Next session" />
            <ShortcutRow keys="Ctrl+Shift+Tab" action="Previous session" />
            <ShortcutRow keys="Ctrl+1-9" action="Jump to session" />
            <ShortcutRow keys="Ctrl+B" action="Toggle sidebar" />
            <ShortcutRow keys="Alt+V" action="Paste clipboard image into terminal" />
          </div>
        </Section>

        <Section title="About">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">Version</span>
              <span className="text-sm text-subtext0">v{latestVersion.version}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">Build</span>
              <span className="text-xs text-overlay0 font-mono">{formatBuildTime(__BUILD_TIME__)}</span>
            </div>
            <div className="pt-2">
              <button
                onClick={() => setShowWhatsNew(true)}
                className="text-sm text-blue hover:text-blue/80 underline"
              >
                View What's New
              </button>
            </div>
          </div>
        </Section>
      </div>

      {/* What's New Modal */}
      {showWhatsNew && (
        <WhatsNewModal
          onClose={() => {
            markWhatsNewSeen()
            setShowWhatsNew(false)
          }}
          showAllVersions
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface0 rounded-lg p-4">
      <h3 className="text-sm font-medium text-subtext1 mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-text">{label}</label>
      <div className="flex-1 max-w-xs">{children}</div>
    </div>
  )
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text">{action}</span>
      <kbd className="px-2 py-0.5 bg-crust rounded text-xs text-overlay1 font-mono">{keys}</kbd>
    </div>
  )
}
