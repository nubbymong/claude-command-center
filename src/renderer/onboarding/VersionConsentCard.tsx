import { useState } from 'react'

const LOCK = String.fromCodePoint(0x1f512)

// One explicit consent click per `claude --version` run — the flow's "every
// command needs your OK" promise, enforced wherever the version is needed
// (p2 Find Claude, and p3 Compatibility when the p2 run was skipped).
export function VersionConsentCard({ desc, onVersion }: { desc: string; onVersion: (v: string) => void }) {
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = () => {
    const call = window.electronAPI.cli.version
    setChecking(true)
    setFailed(false)
    if (!call) {
      setChecking(false)
      setFailed(true)
      return
    }
    call()
      .then((v) => {
        setChecking(false)
        if (v) onVersion(v)
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
      {failed && (
        <div className="ameta">
          <span>
            Couldn't read the version — make sure <code>claude</code> is on your PATH, then try again.
          </span>
        </div>
      )}
    </div>
  )
}
