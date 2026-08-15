import { useEffect, useState, type ReactNode } from 'react'
import { useSettingsStore, type UpdateChannel } from '../stores/settingsStore'
import { useGitHubStore } from '../stores/githubStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { defaultUpdateChannelForVersion } from '../utils/versionLabel'

declare const __APP_VERSION__: string

const PALETTE = String.fromCodePoint(0x1f3a8)
const PERSON = String.fromCodePoint(0x1f464)
const BRANCH = String.fromCodePoint(0x21c4)
const STRIP = String.fromCodePoint(0x25a4)
const SPARK = String.fromCodePoint(0x2733)
const GEAR = String.fromCodePoint(0x2699)
const CHART = String.fromCodePoint(0x1f4ca)
const SHIELD = String.fromCodePoint(0x1f6e1)
const REFRESH = String.fromCodePoint(0x21bb)
const BELL = String.fromCodePoint(0x1f514)

// p8 Transparency: an honest recap of everything the flow configured (all
// values below are read live from the real stores) + the two remaining
// consent decisions (log indexing, Sentinel) + this machine's name (replaces
// the legacy boot prompt). Advancing marks the logging consent as seen.
//
// Two recap rows are load-bearing rather than informational: the update channel
// (a beta install that stays on 'stable' silently stops receiving betas, so the
// row both discloses and sets it) and the session-events listener (on by
// default and never mentioned anywhere else in the flow).
export function TransparencyStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const ghProfiles = useGitHubStore((s) => s.profiles)
  const ghEnabled = useGitHubStore((s) => s.config?.enabledByDefault)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const [globalEmail, setGlobalEmail] = useState<string | null>(null)

  // The channel this build belongs to. A prerelease install that silently sits
  // on 'stable' receives no further prereleases and says nothing about it.
  const buildChannel = defaultUpdateChannelForVersion(
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
  )

  useEffect(() => {
    void useGitHubStore.getState().loadConfig()
    void useAccountProfilesStore.getState().hydrate()
    void window.electronAPI.accountProfiles.globalEmail().then(setGlobalEmail).catch(() => {})
  }, [])

  // Pre-select the channel that matches the running build -- once, and never
  // over an explicit choice (updateChannelChosen). Written rather than merely
  // displayed: the updater and the beta re-onboarding gate both read the
  // PERSISTED value, so a pre-selection that isn't saved fixes nothing.
  useEffect(() => {
    const s = useSettingsStore.getState()
    if (buildChannel === 'stable') return
    if (s.settings.updateChannelChosen || s.settings.updateChannel === buildChannel) return
    void s.updateSettings({ updateChannel: buildChannel })
  }, [buildChannel])

  const save = (patch: Parameters<ReturnType<typeof useSettingsStore.getState>['updateSettings']>[0]) => {
    void useSettingsStore.getState().updateSettings(patch)
  }

  const pickChannel = (channel: UpdateChannel) => save({ updateChannel: channel, updateChannelChosen: true })

  const email = profiles.find((p) => p.isPrimary)?.accountEmail || profiles[0]?.accountEmail || globalEmail
  const toolGates = [
    settings.conductorTools?.vision !== false,
    settings.conductorTools?.codexReview !== false && settings.codexEnabled !== false,
    settings.conductorTools?.hostTransfer !== false,
    settings.conductorTools?.canvas !== false,
  ]
  const toolCount = toolGates.filter(Boolean).length
  const themeLabel = settings.theme === 'system' ? 'System' : settings.theme === 'light' ? 'Light' : 'Dark'

  const channel = settings.updateChannel === 'beta' ? 'beta' : 'stable'
  const recap: { icon: string; label: string; value: string; control?: ReactNode }[] = [
    { icon: PALETTE, label: 'Theme', value: themeLabel },
    { icon: PERSON, label: 'Account', value: email ?? 'Sign in at first session' },
    {
      icon: BRANCH,
      label: 'GitHub',
      // Honest recap: the master (enabledByDefault) decides on/off; connected
      // accounts refine the On case. Profiles can exist with the master off,
      // and the no-account opt-in can be On with zero profiles.
      value:
        ghEnabled === false
          ? 'Off (Settings → GitHub)'
          : ghProfiles.length > 0
            ? `Connected as ${ghProfiles[0].username}`
            : ghEnabled === true
              ? 'On, no account connected yet'
              : 'Off (Settings → GitHub)',
    },
    {
      icon: STRIP,
      label: 'Status line',
      value: settings.statusLineEnabled !== false ? 'On, in every session' : 'Off (Settings → Status line)',
    },
    {
      icon: SPARK,
      label: 'Codex (Beta)',
      value: settings.codexEnabled !== false ? 'On' : 'Off (Settings → Codex)',
    },
    {
      icon: GEAR,
      label: 'Built-in tools',
      // Counted from the gate list above so adding a tool can never leave this
      // reading "3 of 3" while four are advertised.
      value:
        settings.conductorToolsEnabled !== false
          ? `On: ${toolCount} of ${toolGates.length} tools`
          : 'Off (Settings → General)',
    },
    {
      icon: REFRESH,
      label: 'Updates',
      // Reads correctly either way round: a prerelease install is asked to keep
      // its prereleases, a stable install is asked whether it wants them.
      value:
        buildChannel === 'beta'
          ? "You're on a beta build. Keep receiving beta releases, or switch to stable-only?"
          : "You're on a stable build. Stay on stable releases only, or take betas too?",
      control: (
        <div className="gh-choice" role="group" aria-label="Update channel">
          {(['stable', 'beta'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={channel === c ? 'gh-cbtn on focus-ring' : 'gh-cbtn focus-ring'}
              aria-pressed={channel === c}
              onClick={() => pickChannel(c)}
            >
              {c === 'stable' ? 'Stable only' : 'Beta releases'}
            </button>
          ))}
        </div>
      ),
    },
    {
      icon: BELL,
      label: 'Session events',
      value:
        settings.hooksEnabled !== false
          ? 'On: a local-only listener (127.0.0.1) receives tool-call and permission events from your sessions. No telemetry.'
          : 'Off (Settings → Hooks)',
    },
  ]

  const loggingOn = settings.loggingEnabled !== false
  const sentinelOn = settings.sentinelEnabled === true

  const finish = () => {
    // The consent is the page itself: reaching Next means it was seen.
    save({ loggingConsentSeen: true })
    onNext()
  }

  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(880px, 95vw)' }}>
          <h2 className="h2">Here's exactly what we set up.</h2>
          <p className="p2-sub">All of it lives on your machine, and every line below can be changed in Settings.</p>

          <div className="gh-grid" style={{ marginBottom: 16 }}>
            {recap.map((r) => (
              <div className="gh-card" key={r.label}>
                <div className="gh-ic">{r.icon}</div>
                <div>
                  <div className="gh-t">{r.label}</div>
                  <div className="gh-d">{r.value}</div>
                  {r.control}
                </div>
              </div>
            ))}
          </div>

          <div className="tool-card">
            <div className="tc-ic">{CHART}</div>
            <div className="tc-body">
              <div className="tc-t">Index conversation logs</div>
              <div className="tc-d">
                Powers the Logs, Memory and Tokenomics pages by indexing Claude's own transcripts
                (~/.claude/projects). Indexing is local; turning it off only stops the index. Your conversations
                stay in Claude's files either way.
              </div>
            </div>
            <button
              className={loggingOn ? 'tc-sw on' : 'tc-sw'}
              onClick={() => save({ loggingEnabled: !loggingOn })}
              aria-label={`${loggingOn ? 'Disable' : 'Enable'} log indexing`}
              type="button"
            />
          </div>
          <div className="tool-card">
            <div className="tc-ic">{SHIELD}</div>
            <div className="tc-body">
              <div className="tc-t">Sentinel</div>
              <div className="tc-d">
                Watches Claude Code updates for changes that could break your setup and proposes fixes. Off by
                default because it spends Claude tokens when Claude updates. Takes effect after a restart.
              </div>
            </div>
            <button
              className={sentinelOn ? 'tc-sw on' : 'tc-sw'}
              onClick={() => save({ sentinelEnabled: !sentinelOn })}
              aria-label={`${sentinelOn ? 'Disable' : 'Enable'} Sentinel`}
              type="button"
            />
          </div>

          <div className="tool-card">
            <div className="tc-ic">{GEAR}</div>
            <div className="tc-body">
              <div className="tc-t">What should we call this machine?</div>
              <div className="tc-d">Shows in your logs and status line, handy once SSH machines join.</div>
            </div>
            <input
              className="gh-input"
              style={{ width: 200 }}
              placeholder="e.g. Desktop"
              value={settings.localMachineName}
              onChange={(e) => save({ localMachineName: e.target.value })}
            />
          </div>
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        <button className="cta" onClick={finish} type="button">Next →</button>
      </div>
    </>
  )
}
