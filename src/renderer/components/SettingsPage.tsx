import React, { useState, useEffect, useRef } from 'react'
import WhatsNewModal, { markWhatsNewSeen } from './WhatsNewModal'
import TrainingWalkthrough from './TrainingWalkthrough'
import { getLatestVersion } from '../changelog'
import { useSettingsStore, DEFAULT_STATUS_LINE, DEFAULT_TERMINAL_SETTINGS, UpdateChannel } from '../stores/settingsStore'
import type { StatusLineSettings, TerminalSettings, CursorStyle, ThemeMode } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { eventToShortcutString, DEFAULT_SHORTCUTS, SHORTCUT_LABELS } from '../utils/shortcuts'
import GitHubConfigTab from './github/config/GitHubConfigTab'
import CopilotMeterSettings from './settings/CopilotMeterSettings'
import { isSentinelEnabled } from '../../shared/sentinel-enabled'
import { CodexSettingsTab } from './codex/CodexSettingsTab'
import HooksGatewaySection from './github/config/HooksGatewaySection'
import PageFrame from './PageFrame'
import { SectionLabel } from './ui/SectionLabel'
import { Kbd } from './ui/Kbd'
import { useAddAccount } from '../hooks/useAddAccount'
import AccountsPanel from './AccountsPanel'
declare const __BUILD_TIME__: string

export const SETTINGS_TAB_IDS = ['general', 'accounts', 'statusline', 'shortcuts', 'github', 'codex', 'hooks', 'about'] as const
export type SettingsTab = typeof SETTINGS_TAB_IDS[number]

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'statusline', label: 'Status Line' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'github', label: 'GitHub' },
  { id: 'codex', label: 'Codex' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'about', label: 'About' }
]

function StatuslineCodexBanner() {
  const activeSession = useSessionStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId))
  const isCodex = (activeSession?.provider ?? 'claude') === 'codex'
  if (!isCodex) return null
  return (
    <div className="rounded-md bg-yellow/10 border border-yellow/30 p-3 mb-3 text-sm text-yellow">
      Statusline customisation is Claude-only. Switch to a Claude session to configure.
    </div>
  )
}

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
  // Called after the user triggers "Add another account" so the parent can
  // switch the view to Sessions (where the login shell opens).
  onNavigateToSessions?: () => void
}

export default function SettingsPage({ initialTab, onNavigateToSessions }: SettingsPageProps = {}) {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const updateAppMeta = useAppMetaStore((s) => s.update)
  const sentinelAccountProfiles = useAccountProfilesStore((s) => s.profiles)
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

  // Add account: create a profile + open a login shell, then navigate to Sessions.
  const addAccount = useAddAccount()
  const handleAddAccount = async () => {
    await addAccount()
    onNavigateToSessions?.()
  }

  const handleClearAllLogs = async () => {
    if (!window.confirm('Permanently delete the CCC conversation index? This cannot be undone. Active sessions are kept. Your conversations remain in Claude\'s own files (~/.claude/projects).')) return
    try {
      const res = await window.electronAPI.logs2.clearAll()
      window.alert(`Index cleared: ${res.deletedRuns} run(s), ${res.deletedMessages} message(s) removed. Active sessions are kept. Your conversations remain in Claude's own files.`)
    } catch {
      window.alert('Could not clear the index — the logging service may be unavailable.')
    }
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

  const tabsRail = <TabsRail activeTab={activeTab} onChange={setActiveTab} />

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
                    <option value="stable">Stable -- production releases only</option>
                    <option value="beta">Beta -- stable + pre-release builds</option>
                  </select>
                </Field>
                <Field label="Theme">
                  <select
                    value={settings.theme}
                    onChange={(e) => save({ theme: e.target.value as ThemeMode })}
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-full focus:outline-none focus:border-blue/50 transition-colors"
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="system">System -- follow OS preference</option>
                  </select>
                </Field>
                <CheckForUpdatesField />
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
                    checked={!!settings.disableClaudeWorkflows}
                    onChange={(e) => save({ disableClaudeWorkflows: e.target.checked })}
                    className="rounded border-surface1"
                  />
                  Disable Claude Code dynamic workflows
                  <span className="text-[10px] text-overlay0">(applies to new sessions; CC fans out up to 1000 subagents per workflow)</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-subtext0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.loggingEnabled !== false}
                    onChange={(e) => save({ loggingEnabled: e.target.checked })}
                    className="mt-0.5 rounded border-surface1"
                  />
                  <span>
                    Index conversation logs
                    <span className="block text-[10px] text-overlay0">CCC indexes Claude's own transcripts (~/.claude/projects) for browsing here. Turning this off only stops indexing — your conversations remain in Claude's own files and are not affected.</span>
                  </span>
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <button
                    onClick={handleClearAllLogs}
                    className="px-2.5 py-1 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-red/10 hover:text-red hover:border-red/40 transition-colors"
                  >
                    Clear index
                  </button>
                  <span className="text-[10px] text-overlay0">(removes CCC's index only; conversations remain in Claude's own files at ~/.claude/projects)</span>
                </div>
              </Section>

              <Section title="CCC Sentinel" icon={<path d="M8 2L3 5v4c0 3.5 2.1 6.4 5 7.5 2.9-1.1 5-4 5-7.5V5L8 2z" stroke="currentColor" strokeWidth="1.2" fill="none" />}>
                <label className="flex items-start gap-2 text-sm text-subtext0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSentinelEnabled(settings.sentinelEnabled)}
                    onChange={(e) => save({ sentinelEnabled: e.target.checked })}
                    className="mt-0.5 rounded border-surface1"
                  />
                  <span>
                    Enable Sentinel
                    <span className="block text-[10px] text-overlay0">Detects Claude Code updates and proposes registry fixes. Off by default — it spends Claude tokens on a Claude update. Takes effect after restart.</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.sentinelAutoOpen !== false}
                    onChange={(e) => save({ sentinelAutoOpen: e.target.checked })}
                    className="rounded border-surface1"
                  />
                  Auto-open findings panel
                  <span className="text-[10px] text-overlay0">(When an analysis completes with open findings)</span>
                </label>
                <Field label="Analysis account">
                  <select
                    // A stored id whose profile was deleted would render the
                    // select blank; show the default instead (runtime already
                    // falls back to primary via resolveHeadlessProfileHome).
                    value={sentinelAccountProfiles.some((p) => p.id === settings.sentinelAccountProfileId)
                      ? settings.sentinelAccountProfileId ?? ''
                      : ''}
                    onChange={(e) => save({ sentinelAccountProfileId: e.target.value || null })}
                    className="bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text w-64 focus:outline-none focus:border-blue/50 transition-colors"
                  >
                    <option value="">Primary account (default)</option>
                    {sentinelAccountProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.accountEmail || p.id}{p.accountEmail && p.name ? ` (${p.accountEmail})` : ''}
                      </option>
                    ))}
                  </select>
                  <span className="block text-[10px] text-overlay0 mt-1">
                    The account Sentinel's background analysis runs under. Switch it if that account hits its usage limit. Applies to the next analysis or Re-run.
                  </span>
                </Field>
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
                  <Toggle
                    on={(settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorBlink}
                    onClick={() => save({ terminal: { ...(settings.terminal || DEFAULT_TERMINAL_SETTINGS), cursorBlink: !(settings.terminal || DEFAULT_TERMINAL_SETTINGS).cursorBlink } })}
                    label="Cursor Blink"
                  />
                </Field>
                <label className="flex items-start gap-2 text-sm text-subtext0 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={settings.classicTerminalCopyPaste !== false}
                    onChange={(e) => save({ classicTerminalCopyPaste: e.target.checked })}
                    className="mt-0.5 rounded border-surface1"
                  />
                  <span>
                    Classic terminal copy/paste
                    <span className="block text-[10px] text-overlay0">Disables Claude&apos;s mouse mode so selection + right-click copy/paste work the classic way: select text then right-click to copy; right-click with nothing selected to paste. Trade-off: you lose Claude&apos;s click-to-expand and scroll-inside-Claude; xterm scrollback + native selection take over. Changes apply to newly-launched sessions.</span>
                  </span>
                </label>
                <p className="text-[11px] text-overlay0 mt-2 leading-relaxed">
                  Terminal settings apply to new terminals. Restart sessions for changes to take effect.
                </p>
              </Section>

              <Section title="Debug Logging" icon={<path d="M4 4l8 8M4 12l8-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}>
                <Field label="Verbose Logging">
                  <div className="flex items-center gap-3">
                    <Toggle
                      on={settings.debugMode}
                      onClick={() => save({ debugMode: !settings.debugMode })}
                      label="Verbose Logging"
                    />
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

              <Section title="Advanced" icon={<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}>
                <p className="text-[11px] text-overlay0 mb-2 leading-relaxed">
                  Re-display the account attribution banner on the Tokenomics page if you previously dismissed it.
                </p>
                <button
                  onClick={() => updateAppMeta({ accountWizardDismissed: false })}
                  className="px-3 py-1.5 text-sm bg-surface1 hover:bg-surface2 rounded transition-colors"
                >
                  Re-run account attribution wizard
                </button>
              </Section>
            </>
          )}

          {activeTab === 'accounts' && (
            <AccountsPanel onAdd={handleAddAccount} />
          )}

          {activeTab === 'statusline' && (
            <>
              <StatuslineCodexBanner />
              <StatusLineTab sl={sl} onToggle={toggleStatusLine} onSet={setStatusLineField} />
            </>
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

          {activeTab === 'codex' && <CodexSettingsTab />}

          {activeTab === 'hooks' && <HooksGatewaySection />}

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
          mode="help"
        />
      )}
    </>
  )
}

/* ── Status Line Tab ─────────────────────────────────── */

// Only the boolean-valued keys of StatusLineSettings are toggles (font/fontSize
// are not). Narrowing the key type here lets sl[key] resolve to `boolean` for
// the Toggle `on` prop instead of the full number | boolean | StatusLineFont union.
type BooleanStatusLineKey = {
  [K in keyof StatusLineSettings]: StatusLineSettings[K] extends boolean ? K : never
}[keyof StatusLineSettings]

const STATUS_LINE_TOGGLES: { key: BooleanStatusLineKey; label: string; description: string }[] = [
  { key: 'showModel', label: 'Model Name', description: 'Shows the active Claude model' },
  { key: 'showEffort', label: 'Effort Level', description: 'Active reasoning effort next to the model' },
  { key: 'showAccount', label: 'Account', description: 'Claude account this session runs as' },
  { key: 'showTokens', label: 'Token Count', description: 'Input tokens / context window' },
  { key: 'showContextBar', label: 'Context Bar', description: 'Visual progress bar + percentage' },
  { key: 'showCost', label: 'API Cost', description: 'API equivalent cost estimate' },
  { key: 'showLinesChanged', label: 'Lines Changed', description: 'Lines added and removed' },
  { key: 'showDuration', label: 'Duration', description: 'Total session duration' },
  { key: 'showRateLimits', label: 'Rate Limits', description: '5h and 7d usage dot bars' },
  { key: 'showResetTime', label: 'Reset Time', description: 'Time until rate limit resets' },
  { key: 'showCopilot', label: 'Copilot Usage', description: 'GitHub Copilot AI-credit meter (Beta -- limited by the GitHub API)' }
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
  // Master switch -- the same flag onboarding p4's "Status line On/Off" writes.
  // This is the promised recovery surface ("switch it on anytime in Settings ->
  // Status line"), so it must exist here or Off would be a one-way door.
  const statusLineEnabled = useSettingsStore((s) => s.settings.statusLineEnabled ?? true)
  const setMaster = (on: boolean) => {
    void useSettingsStore.getState().updateSettings({ statusLineEnabled: on })
  }
  return (
    <>
      {/* Master switch */}
      <div className="rounded-xl bg-surface0/30 border border-surface0/60 px-4 py-3 flex items-center gap-3">
        <Toggle on={statusLineEnabled} onClick={() => setMaster(!statusLineEnabled)} label="Status line" />
        <div className="min-w-0">
          <div className="text-sm text-text leading-tight">Show the status line</div>
          <div className="text-[11px] text-overlay0 leading-tight">
            Live usage, cost and limits beneath every session. When off, only the session controls remain.
          </div>
        </div>
      </div>

      <div
        inert={!statusLineEnabled}
        className={statusLineEnabled ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none'}
      >
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
                <Toggle
                  on={sl[key]}
                  onClick={() => onToggle(key)}
                  label={label}
                />
                <div className="min-w-0">
                  <div className="text-sm text-text leading-tight">{label}</div>
                  <div className="text-[11px] text-overlay0 leading-tight">{description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Copilot AI-credits config -- self-gates on the meter being enabled, so it
          appears right under the "Copilot Usage" toggle only when relevant. */}
      <CopilotMeterSettings />
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
        <span className={`text-overlay1 ${vis(sl.showEffort)}`}>xhigh</span>
        <span className={`flex items-center gap-1 ${vis(sl.showAccount)}`}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--color-mauve)' }} />
          you@example.com
        </span>
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
  const color = pct >= 90 ? 'var(--status-danger)' : pct >= 70 ? 'var(--status-warning)' : pct >= 50 ? 'var(--brand)' : 'var(--status-success)'
  return (
    <span className="flex items-center gap-1">
      <span className="text-subtext0">{label}:</span>
      <span style={{ letterSpacing: '-1px' }}>
        {Array.from({ length: barWidth }, (_, i) => (
          <span key={i} style={{ color: i < filled ? color : 'var(--border-strong)', fontSize: '9px' }}>{String.fromCodePoint(0x25CF)}</span>
        ))}
      </span>
      <span className="text-subtext0">{pct}%</span>
    </span>
  )
}

/* ── Check for Updates field ─────────────────────────── */

type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'available'

function CheckForUpdatesField() {
  const [status, setStatus] = useState<UpdateCheckStatus>('idle')
  const [foundVersion, setFoundVersion] = useState<string | null>(null)

  const handleCheck = async () => {
    if (status === 'checking') return
    setStatus('checking')
    setFoundVersion(null)
    try {
      const available = await window.electronAPI.update.check()
      if (available) {
        setStatus('available')
        try {
          const ver = await window.electronAPI.update.getVersion()
          if (ver) setFoundVersion(ver)
        } catch { /* version label is optional */ }
      } else {
        setStatus('up-to-date')
      }
    } catch {
      setStatus('idle')
    }
  }

  const statusText =
    status === 'checking' ? 'Checking...' :
    status === 'up-to-date' ? 'Up to date' :
    status === 'available' ? (foundVersion ? `Update available -- v${foundVersion}` : 'Update available') :
    null

  const statusColor =
    status === 'up-to-date' ? 'text-green' :
    status === 'available' ? 'text-yellow' :
    'text-overlay0'

  return (
    <Field label="Check for Updates">
      <div className="flex items-center gap-3">
        <button
          onClick={handleCheck}
          disabled={status === 'checking'}
          className="px-3 py-1.5 text-sm bg-surface1 hover:bg-surface2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-wait border border-surface0/80"
        >
          {status === 'checking' ? 'Checking...' : 'Check now'}
        </button>
        {statusText && status !== 'checking' && (
          <span className={`text-xs ${statusColor}`}>{statusText}</span>
        )}
      </div>
    </Field>
  )
}

/* ── Shared section/field helpers ─────────────────────── */

export function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {icon && (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: 'var(--text-secondary)' }}>
            {icon}
          </svg>
        )}
        <SectionLabel>{title}</SectionLabel>
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

export function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-1">
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{action}</span>
      <Kbd>{keys}</Kbd>
    </div>
  )
}

// Geometry uses inline styles (not Tailwind w-/h-/translate utilities) so the
// control renders identically regardless of utility emission or cascade order
// -- a prior build showed the knob detached from a collapsed track. Track is
// 44x24, the 16px knob is inset 4px and slides 20px between off and on.
export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      className="relative shrink-0 rounded-full transition-colors duration-200"
      style={{ width: 44, height: 24, background: on ? 'var(--status-success)' : 'var(--surface-overlay)' }}
    >
      <span
        className="absolute rounded-full bg-white shadow-sm transition-transform duration-200"
        style={{ width: 16, height: 16, top: 4, left: 4, transform: on ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )
}

export function TabsRail({ activeTab, onChange }: { activeTab: SettingsTab; onChange: (id: SettingsTab) => void }) {
  return (
    <nav className="py-1.5">
      {TABS.map(tab => {
        const active = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className="w-full text-left px-3 py-1.5 text-xs transition-colors focus-ring"
            style={{
              background: active ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
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
              className={`px-1 py-1 rounded-md transition-colors border ${
                conflict ? 'bg-red/10 border-red/30' : 'border-transparent hover:bg-surface0'
              }`}
              title={conflict ? `Conflicts with: ${conflict}` : 'Click to edit'}
            >
              <Kbd>{shortcut}</Kbd>
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
