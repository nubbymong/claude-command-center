import { useSettingsStore, DEFAULT_CONDUCTOR_TOOLS, type ConductorToolsSettings } from '../stores/settingsStore'

const GEAR = String.fromCodePoint(0x2699)
const CHECK = String.fromCodePoint(0x2713)
const GLOBE = String.fromCodePoint(0x1f310)
const MAG = String.fromCodePoint(0x1f50d)
const CAMERA = String.fromCodePoint(0x1f4f7)

type ToolKey = keyof ConductorToolsSettings

// Every switch drives a real settings.conductorTools.* flag: the conductor MCP
// server filters its tool groups by them per connection, and the master gates
// the attach at every spawn path (local Claude / SSH / Codex).
const TOOLS: { k: ToolKey; icon: string; title: string; desc: string }[] = [
  {
    k: 'vision',
    icon: GLOBE,
    title: 'Vision — see & drive a browser',
    desc: 'Claude can open a real browser, take screenshots, click, type, scroll and run JavaScript — ideal for testing UIs and reproducing bugs.',
  },
  {
    k: 'codexReview',
    icon: MAG,
    title: 'Second-opinion code review',
    desc: 'Ask another model for an independent review of your working changes — a fresh pair of eyes on a diff before you commit.',
  },
  {
    k: 'hostTransfer',
    icon: CAMERA,
    title: 'Bring in screenshots, even over SSH',
    desc: 'Pull screenshots and images from your machine straight into the conversation — even on a remote box over SSH.',
  },
]

export function BuiltinToolsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tools = useSettingsStore((s) => s.settings.conductorTools) ?? DEFAULT_CONDUCTOR_TOOLS
  const master = useSettingsStore((s) => s.settings.conductorToolsEnabled ?? true)

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
            Command Center can hand every session a set of ready-made tools — no setup, no servers to wire up. Choose
            which ones Claude gets.
          </p>

          <div className={master ? 'mcp-detail' : 'mcp-detail off'} inert={!master}>
            {TOOLS.map((t) => (
              <div className="tool-card" key={t.k}>
                <div className="tc-ic">{t.icon}</div>
                <div className="tc-body">
                  <div className="tc-t">{t.title}</div>
                  <div className="tc-d">{t.desc}</div>
                </div>
                <button
                  className={tools[t.k] ? 'tc-sw on' : 'tc-sw'}
                  onClick={() => flip(t.k)}
                  aria-label={`${tools[t.k] ? 'Disable' : 'Enable'} ${t.title}`}
                  type="button"
                />
              </div>
            ))}

            <div className="how" style={{ marginTop: 16 }}>
              <div className="how-ic">{GEAR}</div>
              <div>
                <b>How it works</b>
                <span>
                  Command Center runs a small local helper (an MCP server) and registers it with each session it
                  launches — Claude, Codex, local or SSH — so these tools appear automatically. It runs only while
                  Command Center is open. Turn this off and new sessions launch without it.
                </span>
              </div>
            </div>
            <div className="assure" style={{ marginTop: 12 }}>
              <div className="assure-ic">{CHECK}</div>
              <div>
                <b>Nothing touches your global Claude config.</b>
                <span>
                  The helper is registered per session, only for sessions launched here — plain Claude and Codex
                  outside Command Center never see it.
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
