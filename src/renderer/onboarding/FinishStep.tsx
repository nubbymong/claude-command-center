import { BrandMark } from './BrandMark'

const CHECK = String.fromCodePoint(0x2713)

// The flow's last page. Both buttons settle the flow (stamp completion + retire
// legacy popups) via the harness's onDone; they differ only in whether the
// live-app guided tour runs next. There is no config write here — the first
// config is created through the real SessionDialog once the app is revealed.
export function FinishStep({ onTour, onSkip }: { onTour: () => void; onSkip: () => void }) {
  return (
    <>
      <div className="hero">
        <BrandMark className="mark" />
        <h1 className="word">You're all set</h1>
        <div className="sub">Command Center</div>
        <p className="lede">
          Everything you chose is saved and running. Next, a <b>quick tour of the app</b> — then we'll create your
          first session together.
        </p>
        <p className="setup">You can replay the tour anytime from the Feature Guide button in the sidebar.</p>
        <div className="privacy">
          <span className="lock">{CHECK}</span>
          <span>Every choice here can be changed in Settings whenever you like.</span>
        </div>
      </div>
      <div className="foot">
        <button className="skip" onClick={onSkip} type="button">Skip to the app</button>
        <button className="cta" onClick={onTour} type="button">Take the tour →</button>
      </div>
    </>
  )
}
