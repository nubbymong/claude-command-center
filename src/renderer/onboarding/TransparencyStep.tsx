import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useGitHubStore } from '../stores/githubStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'

const PALETTE = String.fromCodePoint(0x1f3a8)
const PERSON = String.fromCodePoint(0x1f464)
const BRANCH = String.fromCodePoint(0x21c4)
const STRIP = String.fromCodePoint(0x25a4)
const SPARK = String.fromCodePoint(0x2733)
const GEAR = String.fromCodePoint(0x2699)
const CHART = String.fromCodePoint(0x1f4ca)
const SHIELD = String.fromCodePoint(0x1f6e1)

// p8 Transparency: an honest recap of everything the flow configured (all
// values below are read live from the real stores) + the two remaining
// consent decisions (log indexing, Sentinel) + this machine's name (replaces
// the legacy boot prompt). Advancing marks the logging consent as seen.
export function TransparencyStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const ghProfiles = useGitHubStore((s) => s.profiles)
  const ghEnabled = useGitHubStore((s) => s.config?.enabledByDefault)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const [globalEmail, setGlobalEmail] = useState<string | null>(null)

  useEffect(() => {
    void useGitHubStore.getState().loadConfig()
    void useAccountProfilesStore.getState().hydrate()
    void window.electronAPI.accountProfiles.globalEmail().then(setGlobalEmail).catch(() => {})
  }, [])

  const save = (patch: Parameters<ReturnType<typeof useSettingsStore.getState>['updateSettings']>[0]) => {
    void useSettingsStore.getState().updateSettings(patch)
  }

  const email = profiles.find((p) => p.isPrimary)?.accountEmail || profiles[0]?.accountEmail || globalEmail
  const toolCount = [
    settings.conductorTools?.vision !== false,
    settings.conductorTools?.codexReview !== false && settings.codexEnabled !== false,
    settings.conductorTools?.hostTransfer !== false,
  ].filter(Boolean).length
  const themeLabel = settings.theme === 'system' ? 'System' : settings.theme === 'light' ? 'Light' : 'Dark'

  const recap: { icon: string; label: string; value: string }[] = [
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
      value: settings.conductorToolsEnabled !== false ? `On: ${toolCount} of 3 tools` : 'Off (Settings → General)',
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
              <div className="tc-t">CCC Sentinel</div>
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
