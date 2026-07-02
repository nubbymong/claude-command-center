import { useState } from 'react'
import { VALIDATED_CC_VERSION, ccCompatStatus } from '../../shared/cc-compat'
import { VersionConsentCard } from './VersionConsentCard'

const CHECK = String.fromCodePoint(0x2713)

// Real verdict: the user's Claude version vs the shipped VALIDATED_CC_VERSION.
//  - behind  → tell them how to update, gate the flow (update + reopen).
//  - current / ahead → good to go, continue.
// If the p2 version run was skipped, ask for consent HERE (VersionConsentCard)
// rather than silently running the command — the flow promises every command
// an explicit OK.
export function CompatibilityStep({
  onNext,
  onBack,
  version: initialVersion,
  onVersion,
}: {
  onNext: () => void
  onBack: () => void
  version: string | null
  onVersion?: (v: string) => void
}) {
  const [version, setVersion] = useState<string | null>(initialVersion)
  const status = version ? ccCompatStatus(version) : null

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">Quick compatibility check.</h2>
          <p className="p2-sub">
            {version ? (
              <>
                You're on Claude Code <b>{version}</b>.
              </>
            ) : (
              'This check needs your Claude Code version.'
            )}
          </p>

          {!version && (
            <VersionConsentCard
              desc="One command reads your version:"
              onVersion={(v) => {
                setVersion(v)
                onVersion?.(v)
              }}
            />
          )}

          {(status === 'current' || status === 'ahead') && (
            <div className="allgood">
              <div className="ag-ic">{CHECK}</div>
              <div>
                <b>Everything will work as expected.</b>
                <span>
                  {status === 'ahead'
                    ? `A touch newer than the ${VALIDATED_CC_VERSION} we validate against. Good to go.`
                    : `Exactly the version we validate against (${VALIDATED_CC_VERSION}). Nothing to do here.`}
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
                  <span>Command Center is built for {VALIDATED_CC_VERSION}+. On {version}, some things may not work.</span>
                </div>
              </div>
              <div className="updbox">
                <div className="ub-l">
                  <b>Update Claude Code, then reopen Command Center</b>
                  <span>
                    Run <code>claude update</code>, or let it update itself. Once you're on {VALIDATED_CC_VERSION}+,
                    we'll carry on from here.
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        {status === 'behind' || !version ? (
          <button className="skip foot-skip" onClick={onNext} type="button">Continue anyway →</button>
        ) : (
          <button className="cta" onClick={onNext} type="button">Next →</button>
        )}
      </div>
    </>
  )
}
