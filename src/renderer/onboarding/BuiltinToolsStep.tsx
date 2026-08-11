import { useSettingsStore, DEFAULT_CONDUCTOR_TOOLS, type ConductorToolsSettings } from '../stores/settingsStore'

const GEAR = String.fromCodePoint(0x2699)
const CHECK = String.fromCodePoint(0x2713)
const GLOBE = String.fromCodePoint(0x1f310)
const MAG = String.fromCodePoint(0x1f50d)
const CAMERA = String.fromCodePoint(0x1f4f7)
const FRAME = String.fromCodePoint(0x1f5bc)

type ToolKey = keyof ConductorToolsSettings

// Every switch drives a real settings.conductorTools.* flag: the conductor MCP
// server filters its tool groups by them per connection, and the master gates
// the attach at every spawn path (local Claude / SSH / Codex). Vision is
// Claude-only (the server never advertises it to Codex); code review runs the
// codex CLI, so it also requires Codex to be enabled.
const TOOLS: { k: ToolKey; icon: string; title: string; desc: string; tag?: string }[] = [
  {
    k: 'vision',
    icon: GLOBE,
    title: 'Vision: see & drive a browser',
    tag: 'Claude only',
    desc: 'Claude can open a real browser, take screenshots, click, type, scroll and run JavaScript. Ideal for testing UIs and reproducing bugs. Not yet available in Codex sessions.',
  },
  {
    k: 'codexReview',
    icon: MAG,
    title: 'Code review',
    tag: 'uses Codex',
    desc: 'Ask Codex for an independent review of your working changes: a fresh pair of eyes on a diff before you commit.',
  },
  {
    k: 'hostTransfer',
    icon: CAMERA,
    title: 'Bring in screenshots, even over SSH',
    desc: 'Pull screenshots and images from your machine straight into the conversation, even on a remote box over SSH.',
  },
  {
    k: 'canvas',
    icon: FRAME,
    title: 'Agent Canvas: read the rendered page',
    desc: 'When a page is open in the Canvas pane, Claude can read what it actually looks like once laid out: element names, sizes, form state, and measured problems such as clipped text, targets too small to hit, and unreadable contrast. Nothing is read unless the canvas is open.',
  },
]

export function BuiltinToolsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tools = useSettingsStore((s) => s.settings.conductorTools) ?? DEFAULT_CONDUCTOR_TOOLS
  const master = useSettingsStore((s) => s.settings.conductorToolsEnabled ?? true)
  // Code review runs the codex CLI: with Codex off it can't work, so the card
  // shows a disabled state (the stored preference is left untouched).
  const codexOn = useSettingsStore((s) => s.settings.codexEnabled) !== false

  const flip = (k: ToolKey) => {
    void useSettingsStore
      .getState()
      .updateSettings({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, ...tools, [k]: !tools[k] } })
  }
  const setMaster = (on: boolean) => {
    void useSettingsStore.getState().updateSettings({ conductorToolsEnabled: on })
  }

  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(760px, 95vw)' }}>
          <h2 className="h2">Want Claude to have a few extra tools?</h2>
          <p className="p2-sub">
            AI Code Conductor can hand every session a set of ready-made tools: no setup, no servers to wire up. Choose
            which ones Claude gets.
          </p>

          <div className={master ? 'mcp-detail' : 'mcp-detail off'} inert={!master}>
            {TOOLS.map((t) => {
              const codexBlocked = t.k === 'codexReview' && !codexOn
              return (
                <div className={codexBlocked ? 'tool-card blocked' : 'tool-card'} key={t.k} inert={codexBlocked}>
                  <div className="tc-ic">{t.icon}</div>
                  <div className="tc-body">
                    <div className="tc-t">
                      {t.title}
                      {(codexBlocked || t.tag) && <span className="gh-tag">{codexBlocked ? 'Codex off' : t.tag}</span>}
                    </div>
                    <div className="tc-d">
                      {codexBlocked
                        ? 'Code review is powered by Codex, which is turned off. Enable it on the Codex page or in Settings → Codex.'
                        : t.desc}
                    </div>
                  </div>
                  <button
                    className={tools[t.k] && !codexBlocked ? 'tc-sw on' : 'tc-sw'}
                    onClick={() => flip(t.k)}
                    aria-label={`${tools[t.k] ? 'Disable' : 'Enable'} ${t.title}`}
                    type="button"
                  />
                </div>
              )
            })}

            {/* Same tool-card geometry as the switches above so the column
                reads as one family (user note: the smaller how-box misaligned). */}
            <div className="tool-card" style={{ marginTop: 16 }}>
              <div className="tc-ic">{GEAR}</div>
              <div className="tc-body">
                <div className="tc-t">How it works</div>
                <div className="tc-d">
                  The Conductor runs a small local helper (an MCP server) and registers it with each session it
                  launches (Claude, Codex, local or SSH), so these tools appear automatically. It runs only while
                  the Conductor is open. Turn this off and new sessions launch without it.
                </div>
              </div>
            </div>
            <div className="assure" style={{ marginTop: 12 }}>
              <div className="assure-ic">{CHECK}</div>
              <div>
                <b>Nothing touches your global Claude config.</b>
                <span>
                  The helper is registered per session, only for sessions launched here. Plain Claude and Codex
                  outside the Conductor never see it.
                </span>
              </div>
            </div>
          </div>

          {!master && (
            <div className="sl-offnote">
              <div className="off-ic">{GEAR}</div>
              <div>
                <b>Built-in tools are off.</b>
                <span>
                  Switch them on anytime in <b>Settings → General</b>.
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
          <span className="oo-lbl">Built-in tools</span>
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
        <button className="cta" onClick={onNext} type="button" style={{ justifySelf: 'end', marginLeft: 0 }}>
          Next →
        </button>
      </div>
    </>
  )
}
