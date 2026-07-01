import { useEffect, useState } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'

const MONITOR = String.fromCodePoint(0x1f5a5)
const WARN = String.fromCodePoint(0x26a0)
const GEAR = String.fromCodePoint(0x2699)
const CHEV = String.fromCodePoint(0x25be)
const DOT_COLOURS = ['var(--ob)', 'var(--status-success)', 'var(--accent)', 'var(--color-mauve)']

// Real accounts: the captured profiles, or the signed-in global login as the primary.
export function AccountsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const [globalEmail, setGlobalEmail] = useState<string | null>(null)
  const [howOpen, setHowOpen] = useState(false)

  useEffect(() => {
    void useAccountProfilesStore.getState().hydrate()
    void window.electronAPI.accountProfiles.globalEmail().then(setGlobalEmail).catch(() => {})
  }, [])

  const accounts =
    profiles.length > 0
      ? profiles.map((p) => ({ email: p.accountEmail, primary: !!p.isPrimary }))
      : globalEmail
        ? [{ email: globalEmail, primary: true }]
        : []

  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(820px, 95vw)' }}>
          <h2 className="h2">Got more than one Claude account?</h2>
          <p className="p2-sub">
            Each account keeps its own login and rate limits — but your memory, projects and history are shared across
            all of them, so switching never loses your place.
          </p>

          <div className="ma-diagram">
            <div className="ma-accounts">
              {accounts.map((a, i) => (
                <div className="ma-card" key={a.email + i}>
                  <div className="ma-top">
                    <span className="ma-dot" style={{ background: DOT_COLOURS[i % DOT_COLOURS.length] }} />
                    <span className="ma-email">{a.email}</span>
                  </div>
                  {a.primary && (
                    <div className="ma-meta">
                      <span className="ma-badge">Primary</span>
                    </div>
                  )}
                </div>
              ))}
              <div className="ma-card add">
                <span className="ma-addt">+ Add more later</span>
                <span className="ma-addsub">any time, in Settings</span>
              </div>
            </div>
            <div className="ma-connect">
              <span />
              <span />
              <span />
            </div>
            <div className="ma-shared">
              <div className="ma-shared-l">Shared across every account</div>
              <div className="ma-chips">
                <span>Memory</span>
                <span>Projects</span>
                <span>History</span>
                <span>Settings</span>
                <span>git · ssh · npm</span>
              </div>
            </div>
          </div>

          <p className="ma-local">
            <span className="ml-ic">{MONITOR}</span>
            <span>
              Multi-account is for your <b>local</b> sessions. SSH sessions run under the remote machine's own login, so
              the account picker doesn't apply there.
            </span>
          </p>

          <div className="ma-heads">
            <div className="mh-ic">{WARN}</div>
            <div>
              <b>We set this up for you automatically — and it changes a few things on your machine.</b>
              <span>
                Your existing login becomes a protected <b>primary</b> account, and your setup is backed up first. We'll
                show you exactly what we touch, and why it's safe, before we finish — on the last step.
              </span>
            </div>
          </div>

          <div className={howOpen ? 'howc open' : 'howc'}>
            <button className="howc-head" onClick={() => setHowOpen((o) => !o)} type="button">
              <span className="how-ic">{GEAR}</span> How accounts stay separate <span className="howc-chev">{CHEV}</span>
            </button>
            <div className="howc-body">
              Each account runs in its own private space — its login, identity and credentials never mix. Everything
              else (your conversation history, memory, projects, and your git / ssh / npm config) is shared, so you keep
              one set of context across all your accounts. You choose which account a session runs under when it starts.
            </div>
          </div>
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        <button className="cta" onClick={onNext} type="button">Next →</button>
      </div>
    </>
  )
}
