// Stand-ins for the onboarding pages, for tests that drive the REAL harness
// (OnboardingHarness) and care about which pages it walks, not what each page
// shows. Each renders its id and the buttons the harness hands it.
import React from 'react'

type Nav = { onNext?: () => void; onBack?: () => void }

export function stub(id: string) {
  return function StubPage(props: Nav) {
    return (
      <div data-testid="page" data-page={id}>
        <button type="button" data-testid="stub-next" onClick={() => props.onNext?.()}>Next</button>
        {props.onBack && <button type="button" data-testid="stub-back" onClick={() => props.onBack?.()}>Back</button>}
      </div>
    )
  }
}

/** The release-notes page, which the harness renders twice: for upgraders
 *  and, with `fresh`, as the showcase a fresh install meets after Welcome. */
export function WhatsNewStub(props: Nav & { fresh?: boolean }) {
  return stub(props.fresh ? 'whatsNewV2Fresh' : 'whatsNewV2')(props)
}

/** The finish page ends the run through its own buttons. */
export function FinishStub({ onSkip }: { onTour: () => void; onSkip: () => void }) {
  return (
    <div data-testid="page" data-page="finish">
      <button type="button" data-testid="stub-finish" onClick={onSkip}>Finish</button>
    </div>
  )
}

/** Codex setup, reduced to the harness contract it uses: step aside for a
 *  terminal, see each return, and a Back only when the harness gives one. */
export function CodexSetupStub(props: Nav & { stepAside: () => void; returns: number }) {
  return (
    <div data-testid="page" data-page="codexSetup" data-returns={props.returns}>
      <button type="button" data-testid="stub-next" onClick={() => props.onNext?.()}>Next</button>
      {props.onBack && <button type="button" data-testid="stub-back" onClick={() => props.onBack?.()}>Back</button>}
      <button type="button" data-testid="stub-step-aside" onClick={props.stepAside}>Run</button>
    </div>
  )
}
