import { useEffect, useState } from 'react'
import { VALIDATED_CC_VERSION, ccCompatStatus } from '../../shared/cc-compat'

const CHECK = String.fromCodePoint(0x2713)
const LOCK = String.fromCodePoint(0x1f512)

// Real verdict: the user's Claude version vs the shipped VALIDATED_CC_VERSION.
//  - behind  → tell them how to update, gate the flow (update + reopen).
//  - current / ahead → good to go, continue.
export function CompatibilityStep({
  onNext,
  onBack,
  version: initialVersion,
}: {
  onNext: () => void
  onBack: () => void
  version: string | null
}) {
  const [version, setVersion] = useState<string | null>(initialVersion)

  useEffect(() => {
    if (version) return
    const call = window.electronAPI.cli.version
    if (call) void call().then((v) => { if (v) setVersion(v) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const status = version ? ccCompatStatus(version) : null

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">Let's make sure your Claude Code is a good match.</h2>
          <p className="p2-sub">
            {version ? (
              <>
                You're on Claude Code <b>{version}</b>.
              </>
            ) : (
              'Reading your Claude Code version…'
            )}
          </p>

          {(status === 'current' || status === 'ahead') && (
            <div className="allgood">
              <div className="ag-ic">{CHECK}</div>
              <div>
                <b>Everything will work as expected.</b>
                <span>
                  {status === 'ahead'
                    ? `You're on ${version}, a touch newer than the ${VALIDATED_CC_VERSION} we've validated — everything we've tested works. You're good to go.`
                    : `You're on the version we've validated Command Center against (${VALIDATED_CC_VERSION}) — nothing to do here.`}
                </span>
              </div>
            </div>
          )}

          {status === 'behind' && (
            <>
              <div className="verdict warn">
                <div className="v-ic">!</div>
                <div>
                  <b>Your Claude Code is older than we've validated.</b>
                  <span>Command Center is built for {VALIDATED_CC_VERSION} and newer — on {version}, some things may not work. Let's get you updated first.</span>
                </div>
              </div>
              <div className="updbox">
                <div className="ub-l">
                  <b>Update Claude Code, then reopen Command Center</b>
                  <span>Claude Code usually updates itself; if not, reinstall it from the official installer. Once you're on {VALIDATED_CC_VERSION}+, reopen Command Center and we'll carry on from here.</span>
                </div>
              </div>
            </>
          )}

          <div className="p2-priv">
            <span className="lock">{LOCK}</span>
            <span>We compared your version against the one we've validated — instant and local. Nothing leaves your machine.</span>
          </div>
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        {status === 'behind' ? (
          <button className="skip foot-skip" onClick={onNext} type="button">Continue anyway →</button>
        ) : (
          <button className="cta" onClick={onNext} type="button">Continue →</button>
        )}
      </div>
    </>
  )
}
