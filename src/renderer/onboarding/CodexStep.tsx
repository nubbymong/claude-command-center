import { useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useCodexAccountStore } from '../stores/codexAccountStore'

const GEAR = String.fromCodePoint(0x2699)
const CHECK = String.fromCodePoint(0x2713)

// "Do you use Codex?" — the answer (settings.codexEnabled) drives the
// conditional sign-in page, Codex surfaces, and the codex_review built-in
// tool. All status shown is real (codexAccountStore -> codex CLI).
export function CodexStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const enabled = useSettingsStore((s) => s.settings.codexEnabled)
  const installed = useCodexAccountStore((s) => s.installed)
  const version = useCodexAccountStore((s) => s.version)
  const authMode = useCodexAccountStore((s) => s.authMode)
  const planType = useCodexAccountStore((s) => s.planType)

  useEffect(() => {
    void useCodexAccountStore.getState().refresh()
  }, [])

  // Unanswered defaults to detected reality: if the CLI is on the machine,
  // they probably use it. The answer is only persisted on interaction/Next.
  const master = enabled ?? installed

  const setMaster = (on: boolean) => {
    void useSettingsStore.getState().updateSettings({ codexEnabled: on })
  }
  // Next records the defaulted answer too, so the question is always answered
  // after this page (the sign-in page and p6's review card key off it).
  const finish = () => {
    if (enabled === undefined) void useSettingsStore.getState().updateSettings({ codexEnabled: master })
    onNext()
  }

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">
            Do you use Codex?<span className="beta-tag">Beta</span>
          </h2>
          <p className="p2-sub">
            Run OpenAI's Codex CLI side by side with Claude: same workbench, sessions, status line and history. It
            also powers the code-review tool Claude sessions get.
          </p>

          <div className={master ? 'cx-detail' : 'cx-detail off'} inert={!master}>
            <div className="checkrow">
              <div className={installed ? 'badge ok' : 'badge wait'}>{installed ? CHECK : '!'}</div>
              <div>
                <div className="nm">{installed ? 'Codex CLI is installed' : "We couldn't find the Codex CLI"}</div>
                <div className="meta">
                  {installed ? (
                    <>Version {version ?? 'unknown'}.</>
                  ) : (
                    <>
                      Install it with <code>npm i -g @openai/codex</code>, or turn Codex off for now.
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="checkrow">
              <div className={authMode !== 'none' ? 'badge ok' : 'badge wait'}>{authMode !== 'none' ? CHECK : '!'}</div>
              <div>
                <div className="nm">
                  {authMode === 'chatgpt'
                    ? 'Signed in with ChatGPT'
                    : authMode === 'api-key'
                      ? 'Signed in with an API key'
                      : 'Not signed in yet'}
                </div>
                <div className="meta">
                  {authMode === 'chatgpt' && planType
                    ? `${planType} plan, read from your local Codex config.`
                    : authMode !== 'none'
                      ? 'Read from your local Codex config.'
                      : "We'll sign you in on the next page."}
                </div>
              </div>
            </div>
          </div>

          {!master && (
            <div className="sl-offnote">
              <div className="off-ic">{GEAR}</div>
              <div>
                <b>Codex is off.</b>
                <span>
                  Enable it anytime in <b>Settings → Codex</b>.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="foot" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
        <button className="back" onClick={onBack} type="button" style={{ justifySelf: 'start' }}>
          ← Back
        </button>
        <div className="feat-onoff">
          <span className="oo-lbl">Codex</span>
          <button className={master ? 'oo-btn on' : 'oo-btn'} onClick={() => setMaster(true)} type="button">
            On
          </button>
          <button
            className={master ? 'oo-btn oo-off' : 'oo-btn oo-off on'}
            onClick={() => setMaster(false)}
            type="button"
          >
            Off
          </button>
        </div>
        <button className="cta" onClick={finish} type="button" style={{ justifySelf: 'end', marginLeft: 0 }}>
          Next →
        </button>
      </div>
    </>
  )
}
