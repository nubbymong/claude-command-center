import { useState } from 'react'
import { launchRefusalOf } from '../../shared/providers'

const LOCK = String.fromCodePoint(0x1f512)
const WARN = String.fromCodePoint(0x26a0)

// One explicit consent click per `claude --version` run — the flow's "every
// command needs your OK" promise, enforced wherever the version is needed
// (p2 Find Claude, and p3 Compatibility when the p2 run was skipped).
export function VersionConsentCard({ desc, onVersion }: { desc: string; onVersion: (v: string) => void }) {
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)
  /** WP2: main did not run it because Claude Code is off; its reason. */
  const [refusedText, setRefusedText] = useState<string | null>(null)

  const run = () => {
    const call = window.electronAPI.cli.version
    setChecking(true)
    setFailed(false)
    setRefusedText(null)
    if (!call) {
      setChecking(false)
      setFailed(true)
      return
    }
    call()
      .then((v) => {
        setChecking(false)
        const refusal = launchRefusalOf(v)
        if (refusal) setRefusedText(refusal.message)
        else if (typeof v === 'string' && v) onVersion(v)
        else setFailed(true)
      })
      .catch(() => {
        setChecking(false)
        setFailed(true)
      })
  }

  return (
    <div className="approve">
      <div className="ah">
        Check which version you have <span className="pill">Needs your OK</span>
      </div>
      <div className="desc">{desc}</div>
      <div className="cmd">
        <span className="cm">claude</span> <span className="fl">--version</span>
      </div>
      <div className="ameta">
        <span>Prints the version and confirms Claude responds.</span>
        <span className="chip ok">{LOCK} Read-only · local · ~1s</span>
      </div>
      <div className="abtns">
        <button className="run" onClick={run} disabled={checking} type="button">
          {checking ? 'Checking…' : 'Run it for me'}
        </button>
      </div>
      {refusedText && (
        <div className="ameta">
          <span data-testid="version-consent-refused">{refusedText}</span>
        </div>
      )}
      {failed && (
        <div className="ameta">
          {/* A real failure reads as a warning (onboarding amber), not muted meta text. */}
          <span style={{ color: 'var(--ob)' }}>
            {WARN} Couldn't read the version. Make sure <code>claude</code> is on your PATH, then try again.
          </span>
        </div>
      )}
    </div>
  )
}
