import { useEffect, useState } from 'react'
import { VersionConsentCard } from './VersionConsentCard'

const CHECK = String.fromCodePoint(0x2713)
const LOCK = String.fromCodePoint(0x1f512)

// Everything here is real, read-only app data. The version is the one thing
// that needs a command run, so it stays behind a single explicit consent click
// (VersionConsentCard); the page-level privacy line carries the no-command
// promise ONCE instead of every row repeating it.
export function FindClaudeStep({
  onNext,
  onBack,
  onVersion,
}: {
  onNext: () => void
  onBack: () => void
  onVersion?: (v: string) => void
}) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    const cli = window.electronAPI.cli
    void cli.check().then(setInstalled).catch(() => setInstalled(false))
    if (cli.path) void cli.path().then(setPath).catch(() => {})
    void window.electronAPI.accountProfiles.globalEmail().then(setEmail).catch(() => {})
  }, [])

  // On macOS/Linux cli.path resolves to the literal string 'claude' (no real
  // filesystem lookup), which would render as "Found at claude" — treat it as
  // no-path and use the PATH copy instead.
  const realPath = path && path !== 'claude' ? path : null

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">Let's find Claude Code.</h2>
          <p className="p2-sub">First, a check that Claude Code is installed and you're signed in.</p>

          <div className="checkrow">
            <div className={installed === null ? 'badge pending' : installed === false ? 'badge wait' : 'badge ok'}>
              {installed === null ? '…' : installed === false ? '!' : CHECK}
            </div>
            <div>
              <div className="nm">
                {installed === null
                  ? 'Checking for Claude Code…'
                  : installed === false
                    ? "We couldn't find Claude Code"
                    : 'Claude Code is installed'}
              </div>
              <div className="meta">
                {installed === null ? (
                  'Checking…'
                ) : installed === false ? (
                  'Install Claude Code, then reopen Command Center.'
                ) : realPath ? (
                  <>
                    Found at <code>{realPath}</code>.
                  </>
                ) : (
                  'Found on your PATH.'
                )}
              </div>
            </div>
          </div>

          {version ? (
            <div className="checkrow">
              <div className="badge ok">{CHECK}</div>
              <div>
                <div className="nm">Claude Code {version}</div>
                <div className="meta">
                  Read just now with <code>claude --version</code>.
                </div>
              </div>
            </div>
          ) : (
            <VersionConsentCard
              desc="The compatibility check on the next page needs your Claude version. One command:"
              onVersion={(v) => {
                setVersion(v)
                onVersion?.(v)
              }}
            />
          )}

          <div className="checkrow">
            <div className={email ? 'badge ok' : 'badge wait'}>{email ? CHECK : '!'}</div>
            <div>
              <div className="nm">{email ? "You're signed in" : 'Not signed in yet'}</div>
              <div className="meta">
                {email ? (
                  <>
                    as <b>{email}</b>, read from your local Claude config.
                  </>
                ) : (
                  "We'll help you sign in when you start your first session."
                )}
              </div>
            </div>
          </div>

          <div className="p2-priv">
            <span className="lock">{LOCK}</span>
            <span>Every command needs your OK and is shown in full first. Nothing leaves your machine.</span>
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
