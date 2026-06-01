// src/renderer/components/MultiAccountGate.tsx
// Forced first-run gate for the multi-account feature. Appears on first install,
// on the first launch after updating into the feature, or when the global Claude
// account changed since last launch (re-trigger). NOT dismissible: there is no
// (x) button and the backdrop has no onClick. The only exits are the explicit
// Enable / No thanks decisions in stage 'ask', then a Done button in stage
// 'manage'. Animation classes mirror WhatsNewModal (enter fade + scale).
import React, { useEffect, useState } from 'react'
import AccountsPanel from './AccountsPanel'

interface Props {
  defaultEmail: string | null
  changedTo?: string | null            // set only on the account-change re-trigger; rewords the heading
  onEnable: () => void                 // parent sets multipleAccountsEnabled + accountGateDecided
  onDecline: () => void                // parent records accountGateDecided + closes
  onAdd: () => void | Promise<void>    // parent: addAccount + navigate to sessions + close
  onDone: () => void                   // parent closes the gate (decision already recorded by onEnable)
}

export default function MultiAccountGate({
  defaultEmail,
  changedTo,
  onEnable,
  onDecline,
  onAdd,
  onDone,
}: Props) {
  const [stage, setStage] = useState<'ask' | 'manage'>('ask')

  // Enter animation: `entering` flips true after one frame so the dialog fades
  // in. Mirrors WhatsNewModal. There is no close animation here because the
  // parent unmounts the gate the moment a decision closes it.
  const [entering, setEntering] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(t)
  }, [])

  const backdropClass = `fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${entering ? 'opacity-100' : 'opacity-0'}`
  const dialogClass = `bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-lg max-h-[80vh] flex flex-col transition-all duration-200 ease-out ${entering ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`

  const heading = changedTo
    ? `Your Claude account changed to ${changedTo}`
    : 'Run multiple Claude accounts?'

  const currentLabel = defaultEmail ?? 'your current account'

  return (
    // NOTE: no onClick on this backdrop -- the gate is intentionally
    // non-dismissible by clicking outside.
    <div className={backdropClass} data-testid="account-gate-backdrop">
      <div className={dialogClass} data-testid="account-gate-dialog">
        {stage === 'ask' ? (
          <>
            {/* Header -- no (x) close button by design */}
            <div className="p-4 border-b border-surface0">
              <h2 className="text-xl font-bold text-text">{heading}</h2>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-sm text-subtext0 leading-relaxed">
                CCC can run different Claude accounts in different sessions, for example work
                vs personal, or switching to another account when one hits a usage limit. Your
                current account ({currentLabel}) stays exactly as is. Nothing is moved or copied.
              </p>

              {/* Warning block -- no em dashes */}
              <div
                className="rounded-lg border border-yellow/30 bg-yellow/10 px-3 py-2.5 text-[13px] leading-relaxed text-subtext1"
                data-testid="account-gate-warning"
              >
                If you skip this, every session uses one account, and running /login in any
                session swaps it for everything. With multiple accounts on, each profile
                session's /login is isolated.
              </div>
            </div>

            {/* Footer actions */}
            <div className="p-4 border-t border-surface0 flex justify-end items-center gap-3">
              <button
                onClick={onDecline}
                data-testid="account-gate-decline"
                className="px-4 py-2 rounded font-medium text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
              >
                No thanks
              </button>
              <button
                onClick={() => {
                  onEnable()
                  setStage('manage')
                }}
                data-testid="account-gate-enable"
                className="px-4 py-2 bg-blue text-base rounded font-medium hover:bg-blue/80 transition-colors"
              >
                Enable - set up accounts
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Manage stage: the shared Accounts panel + a Done button. */}
            <div className="flex-1 overflow-y-auto p-4">
              <AccountsPanel defaultEmail={defaultEmail} onAdd={onAdd} />
            </div>
            <div className="p-4 border-t border-surface0 flex justify-end items-center">
              <button
                onClick={onDone}
                data-testid="account-gate-done"
                className="px-4 py-2 bg-blue text-base rounded font-medium hover:bg-blue/80 transition-colors"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
