import React, { useState, useEffect, useRef } from 'react'
import WhatsNewModal, { markWhatsNewSeen } from './WhatsNewModal'
import { getLatestVersion } from '../changelog'
import { useSettingsStore } from '../stores/settingsStore'
import { eventToShortcutString, DEFAULT_SHORTCUTS, SHORTCUT_LABELS } from '../utils/shortcuts'

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

  useEffect(() => {
    window.electronAPI.debug.isEnabled().then(debugEnabled => {
      if (debugEnabled !== settings.debugMode) {
        updateSettings({ debugMode: debugEnabled })
      }
    })
  }, [])

  const save = async (updates: Partial<typeof settings>) => {
    updateSettings(updates)
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
    <div className="flex-1 flex flex-col bg-base overflow-hidden">
      {/* Page header */}
      <div className="px-5 pt-4 pb-3 border-b border-surface0/80 bg-mantle/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue/10 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-blue">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 5v3.5M8 10v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-text">Settings</h1>
            <p className="text-[11px] text-overlay0 mt-0.5">Application preferences and configuration</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-5 space-y-4">

          <Section title="Defaults" icon={<path d="M3 3h10v10H3z" stroke="currentColor" strokeWidth="1.2" fill="none" />}>
            <Field label="Default Working Directory">
              <input
                value={settings.defaultWorkingDirectory}
                onChange={e => save({ defaultWorkingDirectory: e.target.value })}
                placeholder="Leave empty for home directory"
                className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
              />
            </Field>
          </Section>

          <Section title="Appearance" icon={<><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>}>
            <Field label="Terminal Font Size">
              <input
                type="number"
                value={settings.terminalFontSize}
                onChange={e => save({ terminalFontSize: parseInt(e.target.value) || 14 })}
                min={10}
                max={24}
                className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-24 focus:outline-none focus:border-blue/50 tabular-nums transition-colors"
              />
            </Field>
            <Field label="Input Bar Max Height">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  value={settings.inputBarMaxHeight || 400}
                  onChange={e => save({ inputBarMaxHeight: parseInt(e.target.value) })}
                  min={100}
                  max={800}
                  step={50}
                  className="flex-1 accent-blue"
                />
                <span className="text-xs text-overlay1 font-mono w-14 text-right tabular-nums">{settings.inputBarMaxHeight || 400}px</span>
              </div>
            </Field>
          </Section>

          <Section title="Debug Logging" icon={<path d="M4 4l8 8M4 12l8-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}>
            <Field label="Verbose Logging">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => save({ debugMode: !settings.debugMode })}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                    settings.debugMode ? 'bg-green' : 'bg-surface1'
                  }`}
                >
                  <div
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      settings.debugMode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className={`text-xs font-medium ${settings.debugMode ? 'text-green' : 'text-overlay0'}`}>
                  {settings.debugMode ? 'ON' : 'OFF'}
                </span>
              </div>
            </Field>
            <p className="text-[11px] text-overlay0 mt-1 leading-relaxed">
              Logs PTY input/output, session events, and IPC calls to app.log. Persists across updates.
            </p>
            <button
              onClick={openDebugFolder}
              className="mt-2 text-[11px] text-blue hover:text-blue/80 transition-colors"
            >
              Open log folder
            </button>
          </Section>

          <Section title="Keyboard Shortcuts" icon={<><rect x="2" y="6" width="12" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M5 9h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>}>
            <div className="space-y-0.5">
              {Object.keys(SHORTCUT_LABELS).map((action) => (
                <ShortcutEditor
                  key={action}
                  action={action}
                  label={SHORTCUT_LABELS[action]}
                  shortcut={settings.keyboardShortcuts?.[action] || DEFAULT_SHORTCUTS[action]}
                  allShortcuts={settings.keyboardShortcuts || DEFAULT_SHORTCUTS}
                  onSave={(newShortcut) => {
                    save({
                      keyboardShortcuts: {
                        ...DEFAULT_SHORTCUTS,
                        ...settings.keyboardShortcuts,
                        [action]: newShortcut,
                      },
                    })
                  }}
                />
              ))}
              <ShortcutRow keys="Ctrl+1-9" action="Jump to session" />
            </div>
            <button
              onClick={() => save({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS } })}
              className="mt-3 text-[11px] text-blue hover:text-blue/80 transition-colors"
            >
              Reset to Defaults
            </button>
          </Section>

          <Section title="About" icon={<><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M8 7v4M8 5.5v.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>}>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text">Version</span>
                <span className="text-sm text-subtext0 font-medium">v{latestVersion.version}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-text">Build</span>
                <span className="text-xs text-overlay0 font-mono tabular-nums">{formatBuildTime(__BUILD_TIME__)}</span>
              </div>
              <div className="pt-1">
                <button
                  onClick={() => setShowWhatsNew(true)}
                  className="text-[11px] text-blue hover:text-blue/80 transition-colors"
                >
                  View What's New
                </button>
              </div>
            </div>
          </Section>
        </div>
      </div>

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

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
          {icon}
        </svg>
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-text shrink-0">{label}</label>
      <div className="flex-1 max-w-xs">{children}</div>
    </div>
  )
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-1">
      <span className="text-sm text-text">{action}</span>
      <kbd className="px-2 py-0.5 bg-crust/80 rounded-md text-[11px] text-overlay1 font-mono border border-surface0/50">{keys}</kbd>
    </div>
  )
}

function ShortcutEditor({ action, label, shortcut, allShortcuts, onSave }: {
  action: string; label: string; shortcut: string; allShortcuts: Record<string, string>; onSave: (s: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [captured, setCaptured] = useState('')
  const [conflict, setConflict] = useState<string | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const testRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (testing) testRef.current?.focus()
  }, [testing])

  const checkConflict = (newShortcut: string): string | null => {
    for (const [key, val] of Object.entries(allShortcuts)) {
      if (key !== action && val === newShortcut) {
        return SHORTCUT_LABELS[key] || key
      }
    }
    return null
  }

  return (
    <div className="flex items-center justify-between py-1.5 px-1 gap-2 rounded-lg hover:bg-surface0/20 transition-colors">
      <span className="text-sm text-text shrink-0">{label}</span>
      <div className="flex items-center gap-1.5">
        {editing ? (
          <div
            ref={inputRef}
            tabIndex={0}
            className="px-2.5 py-1 bg-crust border border-blue/50 rounded-md text-[11px] text-text font-mono min-w-[120px] text-center outline-none animate-pulse"
            onKeyDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const str = eventToShortcutString(e.nativeEvent)
              if (str) {
                const conflictWith = checkConflict(str)
                if (conflictWith) {
                  setConflict(conflictWith)
                  setCaptured(str)
                  setTimeout(() => { setConflict(null); setCaptured('') }, 3000)
                }
                onSave(str)
                setEditing(false)
                if (!conflictWith) setCaptured('')
              }
            }}
            onBlur={() => { setEditing(false); setCaptured('') }}
          >
            {captured || 'Press keys...'}
          </div>
        ) : testing ? (
          <div
            ref={testRef}
            tabIndex={0}
            className="px-2.5 py-1 bg-crust border border-green/40 rounded-md text-[11px] text-text font-mono min-w-[120px] text-center outline-none"
            onKeyDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const str = eventToShortcutString(e.nativeEvent)
              if (str) {
                if (str === shortcut) {
                  setTestResult('Matched!')
                } else {
                  setTestResult(`Got: ${str}`)
                }
                setTimeout(() => { setTesting(false); setTestResult(null) }, 2000)
              }
            }}
            onBlur={() => { setTesting(false); setTestResult(null) }}
          >
            {testResult || `Press ${shortcut}...`}
          </div>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-colors border ${
                conflict
                  ? 'bg-red/10 text-red border-red/30'
                  : 'bg-crust/80 text-overlay1 border-surface0/50 hover:bg-surface0 hover:text-text'
              }`}
              title={conflict ? `Conflicts with: ${conflict}` : 'Click to edit'}
            >
              {shortcut}
            </button>
            <button
              onClick={() => setTesting(true)}
              className="px-1.5 py-1 rounded-md text-[10px] bg-surface0/40 text-overlay0 hover:text-overlay1 transition-colors border border-transparent hover:border-surface0/60"
              title="Test this shortcut"
            >
              Test
            </button>
          </>
        )}
        {conflict && !editing && (
          <span className="text-[10px] text-red">Conflicts with {conflict}</span>
        )}
      </div>
    </div>
  )
}
