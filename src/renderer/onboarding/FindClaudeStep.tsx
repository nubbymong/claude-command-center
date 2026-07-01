import { useEffect, useState } from 'react'

const CHECK = String.fromCodePoint(0x2713)
const LOCK = String.fromCodePoint(0x1f512)

// Everything here is real, read-only app data. The version is the one thing that
// needs a command run, so it stays behind a single explicit consent click (honouring
// this page's "we never run a command without your approval" promise) — CCC needs it
// for the p3 compatibility check, so there's no "run it yourself" dead end.
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
  const [checking, setChecking] = useState(false)
  const [versionFailed, setVersionFailed] = useState(false)

  useEffect(() => {
    const cli = window.electronAPI.cli
    void cli.check().then(setInstalled).catch(() => setInstalled(false))
    if (cli.path) void cli.path().then(setPath).catch(() => {})
    void window.electronAPI.accountProfiles.globalEmail().then(setEmail).catch(() => {})
  }, [])

  const runVersion = () => {
    const call = window.electronAPI.cli.version
    setChecking(true)
    setVersionFailed(false)
    if (!call) {
      setChecking(false)
      setVersionFailed(true)
      return
    }
    call()
      .then((v) => {
        setChecking(false)
        if (v) {
          setVersion(v)
          onVersion?.(v)
        } else setVersionFailed(true)
      })
      .catch(() => {
        setChecking(false)
        setVersionFailed(true)
      })
  }

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">Let's find Claude Code.</h2>
          <p className="p2-sub">
            Command Center runs on top of Claude Code, so first let's check it's installed and that you're signed in.
          </p>

          <div className="checkrow">
            <div className={installed === false ? 'badge wait' : 'badge ok'}>{installed === false ? '!' : CHECK}</div>
            <div>
              <div className="nm">{installed === false ? "We couldn't find Claude Code" : 'Claude Code is installed'}</div>
              <div className="meta">
                {installed === null ? (
                  'Checking…'
                ) : installed === false ? (
                  'Install Claude Code, then reopen Command Center.'
                ) : path ? (
                  <>
                    Found at <code>{path}</code> — we only located the file; nothing has been run.
                  </>
                ) : (
                  'Found on your PATH — we only located the file; nothing has been run.'
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
                  Read just now with <code>claude --version</code> — nothing else ran.
                </div>
              </div>
            </div>
          ) : (
            <div className="approve">
              <div className="ah">
                Check which version you have <span className="pill">Needs your OK</span>
              </div>
              <div className="desc">
                Command Center needs your Claude version to check compatibility next. With your OK it'll run one short,
                read-only command:
              </div>
              <div className="cmd">
                <span className="cm">claude</span> <span className="fl">--version</span>
              </div>
              <div className="ameta">
                <span>Prints the version and confirms Claude responds.</span>
                <span className="chip ok">{LOCK} Read-only · local · ~1s</span>
              </div>
              <div className="abtns">
                <button className="run" onClick={runVersion} disabled={checking} type="button">
                  {checking ? 'Checking…' : 'Run it for me'}
                </button>
              </div>
              {versionFailed && (
                <div className="ameta">
                  <span>
                    Couldn't read the version — make sure <code>claude</code> is on your PATH, then try again.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="checkrow">
            <div className={email ? 'badge ok' : 'badge wait'}>{email ? CHECK : '!'}</div>
            <div>
              <div className="nm">{email ? "You're signed in" : 'Not signed in yet'}</div>
              <div className="meta">
                {email ? (
                  <>
                    as <b>{email}</b> — read from your local Claude config, no command run.
                  </>
                ) : (
                  "We'll help you sign in when you start your first session."
                )}
              </div>
            </div>
          </div>

          <div className="p2-priv">
            <span className="lock">{LOCK}</span>
            <span>
              We never run a Claude command without your approval, and we'll always show you the exact command first.
              Nothing here leaves your machine.
            </span>
          </div>
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        <button className="cta" onClick={onNext} type="button">Continue →</button>
      </div>
    </>
  )
}
