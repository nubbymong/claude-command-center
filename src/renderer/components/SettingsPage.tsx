import React, { useState, useEffect, useRef } from 'react'
import WhatsNewModal, { markWhatsNewSeen } from './WhatsNewModal'
import TrainingWalkthrough from './TrainingWalkthrough'
import { getLatestVersion } from '../changelog'
import { useSettingsStore, DEFAULT_STATUS_LINE, DEFAULT_TERMINAL_SETTINGS, UpdateChannel } from '../stores/settingsStore'
import type { StatusLineSettings, TerminalSettings, CursorStyle } from '../stores/settingsStore'
import { eventToShortcutString, DEFAULT_SHORTCUTS, SHORTCUT_LABELS } from '../utils/shortcuts'
import GitHubConfigTab from './github/config/GitHubConfigTab'
import PageFrame from './PageFrame'
declare const __BUILD_TIME__: string

type SettingsTab = 'general' | 'statusline' | 'shortcuts' | 'github' | 'about'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'statusline', label: 'Status Line' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'github', label: 'GitHub' },
  { id: 'about', label: 'About' }
]

function formatBuildTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

interface SettingsPageProps {
  // Initial tab selection used on first render. Allows callers (onboarding
  // modal "Set up now" + auto-detect banner Accept/Edit) to deep-link into
  // the GitHub tab instead of landing on the default General view.
  initialTab?: SettingsTab
}

export default function SettingsPage({ initialTab }: SettingsPageProps = {}) {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showTraining, setShowTraining] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')

  // useState's initializer only reads initialTab once on mount. If a parent
  // updates the deep-link prop while SettingsPage is already mounted (e.g.
  // user is on Settings, a post-update trigger fires the onboarding modal,
  // they click Set up now), the new tab wouldn't apply without this sync.
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
  }, [initialTab])
  const latestVersion = getLatestVersion()

  useEffect(() => {
    window.electronAPI.debug.isEnabled().then(debugEnabled => {
      if (debugEnabled !== settings.debugMode) {
        updateSettings({ debugMode: debugEnabled })
      }
    })
  }, [])

  const save = async (updates: Partial<typeof settings>) => {
    // Await the IPC write so any read-after-write (e.g. the main process
    // re-reading settings for an update check) sees the new value.
    await updateSettings(updates)
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

  const sl = settings.statusLine || DEFAULT_STATUS_LINE

  const toggleStatusLine = (key: keyof StatusLineSettings) => {
    save({ statusLine: { ...sl, [key]: !sl[key] } })
  }

  const setStatusLineField = <K extends keyof StatusLineSettings>(key: K, value: StatusLineSettings[K]) => {
    save({ statusLine: { ...sl, [key]: value } })
  }

  const settingsIcon = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3.5M8 10v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )

  const tabsRail = (
    <nav className="py-1.5">
      {TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
            activeTab === tab.id
              ? 'bg-blue/15 text-blue border-l-2 border-blue'
              : 'text-overlay1 hover:text-text hover:bg-surface0/40 border-l-2 border-transparent'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )

  const activeTabLabel = TABS.find(t => t.id === activeTab)?.label

  return (
    <>
      <PageFrame
        icon={settingsIcon}
        iconAccent="blue"
        title="Settings"
        context={activeTabLabel}
        leftRail={tabsRail}
      >
        <div className="max-w-3xl mx-auto p-5 space-y-4">

          {activeTab === 'general' && (
            <>
              <Section title="Defaults" icon={<path d="M3 3h10v10H3z" stroke="currentColor" strokeWidth="1.2" fill="none" />}>
                <Field label="Default Working Directory">
                  <input
                    value={settings.defaultWorkingDirectory}
                    onChange={e => save({ defaultWorkingDirectory: e.target.value })}
                    placeholder="Leave empty for home directory"
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
                  />
                </Field>
                <Field label="Local Machine Name">
                  <input
                    value={settings.localMachineName}
                    onChange={e => save({ localMachineName: e.target.value })}
                    placeholder="e.g. Desktop, Laptop"
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
                  />
                </Field>
                <Field label="Update Channel">
                  <select
                    value={settings.updateChannel}
                    onChange={(e) => save({ updateChannel: e.target.value as UpdateChannel })}
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue/50 transition-colors"
                  >
                    <option value="stable">Stable — production releases only</option>
                    <option value="beta">Beta — stable + pre-release builds</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer mt-3">
                  <input
                    type="checkbox"
                    checked={settings.showTips}
                    onChange={(e) => save({ showTips: e.target.checked })}
                    className="rounded border-surface1"
                  />
                  Show intelligent tips
                  <span className="text-[10px] text-overlay0">(Contextual feature discovery in session header)</span>
                </label>
              </Section>

              <Section title="Security" icon={<path d="M8 2L3 5v4c0 3.5 2.1 6.4 5 7.5 2.9-1.1 5-4 5-7.5V5L8 2z" stroke="currentColor" strokeWidth="1.2" fill="none" />}>
                <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.skipPermissionsForAgents}
                    onChange={(e) => save({ skipPermissionsForAgents: e.target.checked })}
                    className="rounded border-surface1"
                  />
                  Skip permission prompts for headless agents
                  <span className="text-[10px] text-overlay0">(--dangerously-skip-permissions)</span>
                </label>
              </Section>

              <Section title="Terminal" icon={<><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M5 7l2 2-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><line x1="9" y1="11" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>}>
                <Field label="Font Family">
                  <select
                    value={(settings.terminal || DEFAULT_TERMINAL_SETTINGS).fontFamily}
                    onChange={e => save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), fontFamily: e.target.value } })}
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-48 focus:outline-none focus:border-blue/50 transition-colors"
                  >
                    {['Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New'].map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Font Size">
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={11}
                      max={20}
                      value={(settings.terminal || DEFAULT_TERMINAL_SETTINGS).fontSize}
                      onChange={e => {
                        const sz = parseInt(e.target.value)
                        save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), fontSize: sz }, terminalFontSize: sz })
                      }}
                      className="w-32"
                    />
                    <span className="text-sm text-subtext0 tabular-nums w-8">{(settings.terminal || DEFAULT_TERMINAL_SETTINGS).fontSize}px</span>
                  </div>
                </Field>
                <Field label="Line Height">
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={10}
                      max={16}
                      value={Math.round(((settings.terminal || DEFAULT_TERMINAL_SETTINGS).lineHeight) * 10)}
                      onChange={e => save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), lineHeight: parseInt(e.target.value) / 10 } })}
                      className="w-32"
                    />
                    <span className="text-sm text-subtext0 tabular-nums w-8">{((settings.terminal || DEFAULT_TERMINAL_SETTINGS).lineHeight).toFixed(1)}</span>
                  </div>
                </Field>
                <Field label="Cursor Style">
                  <div className="flex gap-1">
                    {(['bar', 'block', 'underline'] as CursorStyle[]).map(style => (
                      <button
                        key={style}
                        onClick={() => save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), cursorStyle: style } })}
                        className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                          (settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorStyle === style
                            ? 'bg-blue/20 text-blue border border-blue/30'
                            : 'bg-surface0/60 text-overlay1 border border-surface0/80 hover:text-text'
                        }`}
                      >
                        {style.charAt(0).toUpperCase() + style.slice(1)}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Cursor Blink">
                  <button
                    onClick={() => save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), cursorBlink: !(settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorBlink } })}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                      (settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorBlink ? 'bg-green' : 'bg-surface1'
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                        (settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorBlink ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </Field>
                <p className="text-[11px] text-overlay0 mt-2 leading-relaxed">
                  Terminal settings apply to new terminals. Restart sessions for changes to take effect.
                </p>
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
            </>
          )}

          {activeTab === 'statusline' && (
            <StatusLineTab sl={sl} onToggle={toggleStatusLine} onSet={setStatusLineField} />
          )}

          {activeTab === 'shortcuts' && (
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
          )}

          {activeTab === 'github' && <GitHubConfigTab />}

          {activeTab === 'about' && (
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
                <div className="pt-1 flex items-center gap-1.5">
                  <button
                    onClick={() => setShowWhatsNew(true)}
                    className="text-[11px] text-blue hover:text-blue/80 transition-colors"
                  >
                    View What's New
                  </button>
                  <span className="text-[11px] text-overlay0">|</span>
                  <button
                    onClick={() => setShowTraining(true)}
                    className="text-[11px] text-blue hover:text-blue/80 transition-colors"
                  >
                    Replay Training
                  </button>
                </div>
              </div>
            </Section>
          )}
        </div>
      </PageFrame>

      {showWhatsNew && (
        <WhatsNewModal
          onClose={() => {
            markWhatsNewSeen()
            setShowWhatsNew(false)
          }}
          showAllVersions
        />
      )}
      {showTraining && (
        <TrainingWalkthrough
          onClose={() => setShowTraining(false)}
          showAll
        />
      )}
    </>
  )
}

/* ── Status Line Tab ─────────────────────────────────── */

const STATUS_LINE_TOGGLES: { key: keyof StatusLineSettings; label: string; description: string }[] = [
  { key: 'showModel', label: 'Model Name', description: 'Shows the active Claude model' },
  { key: 'showTokens', label: 'Token Count', description: 'Input tokens / context window' },
  { key: 'showContextBar', label: 'Context Bar', description: 'Visual progress bar + percentage' },
  { key: 'showCost', label: 'API Cost', description: 'API equivalent cost estimate' },
  { key: 'showLinesChanged', label: 'Lines Changed', description: 'Lines added and removed' },
  { key: 'showDuration', label: 'Duration', description: 'Total session duration' },
  { key: 'showRateLimits', label: 'Rate Limits', description: '5h and 7d usage dot bars' },
  { key: 'showResetTime', label: 'Reset Time', description: 'Time until rate limit resets' }
]

function StatusLineTab({
  sl,
  onToggle,
  onSet,
}: {
  sl: StatusLineSettings
  onToggle: (key: keyof StatusLineSettings) => void
  onSet: <K extends keyof StatusLineSettings>(key: K, value: StatusLineSettings[K]) => void
}) {
  return (
    <>
      {/* Live Preview */}
      <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
            <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <path d="M2 6h12" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Live Preview</h3>
        </div>
        <div className="p-4">
          <div className="rounded-lg border border-surface0/80 overflow-hidden">
            <StatusLinePreview sl={sl} />
          </div>
          <p className="text-[11px] text-overlay0 mt-2">
            Toggle elements below to see how the status bar changes.
          </p>
        </div>
      </div>

      {/* Typography */}
      <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
            <path d="M3 4h10M5 4v8h2V4M9 4v8h2V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Typography</h3>
        </div>
        <div className="p-4 space-y-3">
          <Field label="Font">
            <div className="flex gap-1">
              {(['sans', 'mono'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => onSet('font', f)}
                  className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                    sl.font === f
                      ? 'bg-blue/20 text-blue border border-blue/30'
                      : 'bg-surface0/60 text-overlay1 border border-surface0/80 hover:text-text'
                  }`}
                >
                  {f === 'sans' ? 'Sans (Inter)' : 'Mono'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Font Size">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={16}
                value={sl.fontSize}
                onChange={(e) => onSet('fontSize', parseInt(e.target.value))}
                className="w-32"
              />
              <span className="text-sm text-subtext0 tabular-nums w-8">{sl.fontSize}px</span>
            </div>
          </Field>
        </div>
      </div>

      {/* Toggle Grid */}
      <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
            <path d="M4 8h8M8 4v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Customize Elements</h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {STATUS_LINE_TOGGLES.map(({ key, label, description }) => (
              <div
                key={key}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface0/30 transition-colors"
              >
                <button
                  onClick={() => onToggle(key)}
                  className={`relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 ${
                    sl[key] ? 'bg-green' : 'bg-surface1'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      sl[key] ? 'translate-x-[18px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
                <div className="min-w-0">
                  <div className="text-sm text-text leading-tight">{label}</div>
                  <div className="text-[11px] text-overlay0 leading-tight">{description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/* ── Status Line Preview (mock data) ─────────────────── */

function StatusLinePreview({ sl }: { sl: StatusLineSettings }) {
  // Elements that are toggled off render at 30% opacity with strikethrough
  const vis = (on: boolean) =>
    on ? '' : 'opacity-30 line-through'

  return (
    <div
      className={`flex flex-col shrink-0 bg-crust border-t border-surface0 text-subtext0 ${sl.font === 'mono' ? 'font-mono' : ''}`}
      style={{ fontSize: `${sl.fontSize}px` }}
    >
      {/* Row 1 */}
      <div className="flex items-center gap-3 px-2 py-1">
        <span className={`text-text font-medium ${vis(sl.showModel)}`}>Claude 4 Sonnet</span>
        <span className={`tabular-nums ${vis(sl.showTokens)}`}>84K / 200K</span>
        <div className={`flex items-center gap-1.5 ${!sl.showContextBar ? 'opacity-30' : ''}`}>
          <div className="w-20 h-1.5 bg-surface1 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: '42%', backgroundColor: 'var(--color-green)' }} />
          </div>
          <span className={`tabular-nums ${!sl.showContextBar ? 'line-through' : ''}`}>42%</span>
        </div>
        <div className="flex-1" />
        <span className={`tabular-nums ${vis(sl.showCost)}`}>API eq $0.1847</span>
        <span
          className={`tabular-nums ${vis(sl.showLinesChanged)}`}
          style={{ color: 'color-mix(in srgb, var(--color-green) 65%, var(--color-subtext0))' }}
        >
          +127
        </span>
        <span
          className={`tabular-nums ${vis(sl.showLinesChanged)}`}
          style={{ color: 'color-mix(in srgb, var(--color-red) 65%, var(--color-subtext0))' }}
        >
          −23
        </span>
        <span className={`text-overlay1 tabular-nums ${vis(sl.showDuration)}`}>3m 42s</span>
      </div>
      {/* Row 2: Rate limits */}
      <div className={`flex items-center gap-3 px-2 py-0.5 border-t border-surface0/50 ${!sl.showRateLimits && !sl.showResetTime ? 'opacity-30' : ''}`}>
        <span className={!sl.showRateLimits ? 'opacity-30' : ''}>
          <MockRateDots label="5h" pct={35} />
        </span>
        <span className={!sl.showRateLimits ? 'opacity-30' : ''}>
          <MockRateDots label="7d" pct={12} />
        </span>
        <span className={`text-overlay0 ${vis(sl.showRateLimits)}`}>
          extra: <span className="text-teal">$1.20</span><span className="text-overlay0">/50</span>
        </span>
        <div className="flex-1" />
        <span className={`text-overlay0 ${vis(sl.showResetTime)}`}>resets 2h 14m</span>
      </div>
    </div>
  )
}

function MockRateDots({ label, pct }: { label: string; pct: number }) {
  const barWidth = 10
  const filled = Math.round(pct * barWidth / 100)
  const color = pct >= 90 ? '#F38BA8' : pct >= 70 ? '#F9E2AF' : pct >= 50 ? '#FAB387' : '#A6E3A1'
  return (
    <span className="flex items-center gap-1">
      <span className="text-subtext0">{label}:</span>
      <span style={{ letterSpacing: '-1px' }}>
        {Array.from({ length: barWidth }, (_, i) => (
          <span key={i} style={{ color: i < filled ? color : '#2a3342', fontSize: '9px' }}>{String.fromCodePoint(0x25CF)}</span>
        ))}
      </span>
      <span className="text-subtext0">{pct}%</span>
    </span>
  )
}

/* ── Shared section/field helpers ─────────────────────── */

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
