import { useEffect, useState } from 'react'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'

const MONITOR = String.fromCodePoint(0x1f5a5)
const CHECK = String.fromCodePoint(0x2713)
const DOT_COLOURS = ['var(--ob)', 'var(--status-success)', 'var(--accent)', 'var(--color-mauve)']

// Real accounts: the captured profiles, or the signed-in global login as the
// primary. Copy is deliberately light + factual (all claims code-verified):
// logins are private per account, memory/projects/history are junction-shared,
// the real ~/.claude login is never moved or rewritten, and claude-backup.ts
// snapshots it once before any account setup.
export function AccountsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const [globalEmail, setGlobalEmail] = useState<string | null>(null)

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
            Run each <b>local</b> session under whichever account you pick — logins never mix, while memory, projects
            and history are shared, so switching never loses your place.
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

          <div className="ma-heads">
            <div className="mh-ic">{CHECK}</div>
            <div>
              <b>Claude Code outside Command Center keeps working exactly as today.</b>
              <span>
                Terminal, IDE, anywhere — same login, same history. Nothing is moved or rewritten, and your setup is
                backed up once before accounts are ever set up.
              </span>
            </div>
          </div>

          <p className="ma-local">
            <span className="ml-ic">{MONITOR}</span>
            <span>
              SSH sessions use the remote machine's own login — accounts apply to <b>local</b> sessions only.
            </span>
          </p>
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        <button className="cta" onClick={onNext} type="button">Next →</button>
      </div>
    </>
  )
}
