import { useSettingsStore, DEFAULT_CONDUCTOR_TOOLS, type ConductorToolsSettings } from '../stores/settingsStore'
import { codexPreference, usesClaude } from './provider-choice'

const GEAR = String.fromCodePoint(0x2699)
const CHECK = String.fromCodePoint(0x2713)
const GLOBE = String.fromCodePoint(0x1f310)
const MAG = String.fromCodePoint(0x1f50d)
const CAMERA = String.fromCodePoint(0x1f4f7)
const FRAME = String.fromCodePoint(0x1f5bc)

type ToolKey = keyof ConductorToolsSettings

// Every switch drives a real settings.conductorTools.* flag: the conductor MCP
// server filters its tool groups by them per connection, and the master gates
// the attach at every spawn path (local Claude / SSH / Codex). Vision reaches
// Claude and Codex sessions alike (WP2 PR 4, P4.2). Codex review runs
// the codex CLI, so it is blocked while Codex is off. Claude review answers
// Codex sessions: with Codex off nothing asks for it, so it stays a live
// switch with a note rather than a blocked card (the same rule as Settings).
const TOOLS: { k: ToolKey; icon: string; title: string; desc: string; tag?: string }[] = [
  {
    k: 'vision',
    icon: GLOBE,
    title: 'Vision: see & drive a browser',
    desc: 'Your agent can open a real browser, take screenshots, click, type, scroll and run JavaScript. Ideal for testing UIs and reproducing bugs.',
  },
  {
    k: 'codexReview',
    icon: MAG,
    title: 'Codex review',
    tag: 'uses Codex',
    desc: 'Claude sessions can ask Codex to review: an independent look at your working changes before you commit.',
  },
  {
    k: 'claudeReview',
    icon: MAG,
    title: 'Claude review',
    tag: 'for Codex sessions',
    desc: 'Codex sessions can ask Claude to review: an independent look at your working changes before you commit.',
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
    desc: 'When a page is open in the Canvas pane, your agent can read what it actually looks like once laid out: element names, sizes, form state, and measured problems such as clipped text, targets too small to hit, and unreadable contrast. It can also render files from the project folders you open sessions in — nothing outside those folders. To check its own work it may lay a page out off-screen even when the Canvas pane is closed, but only ever from those same folders.',
  },
]

export function BuiltinToolsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tools = useSettingsStore((s) => s.settings.conductorTools) ?? DEFAULT_CONDUCTOR_TOOLS
  const master = useSettingsStore((s) => s.settings.conductorToolsEnabled ?? true)
  // Codex review runs the codex CLI: with Codex off it can't work, so the
  // card shows a disabled state (the stored preference is left untouched).
  // Nor while the user has not said they use Codex (no saved value): Codex
  // is not set up then, and main offers no Codex review.
  const codex = useSettingsStore((s) => codexPreference(s.settings))
  const codexOn = codex === 'on'
  const codexState = codex === 'off' ? 'off' : 'not set up'
  // P3.4 (row 14), the same rule the other way round: with Claude Code off,
  // Claude review (it runs Claude Code) is blocked as Codex review is while
  // Codex is off, and Codex review, asked for only from Claude sessions,
  // keeps its switch with a note. The page then asks about your sessions.
  const claudeOn = useSettingsStore((s) => usesClaude(s.settings))

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
          <h2 className="h2">{claudeOn ? 'Want Claude to have a few extra tools?' : 'Want your sessions to have a few extra tools?'}</h2>
          <p className="p2-sub">
            AI Code Conductor can hand every session a set of ready-made tools: no setup, no servers to wire up.
            Choose which ones {claudeOn ? 'Claude gets' : 'your sessions get'}.
          </p>

          <div className={master ? 'mcp-detail' : 'mcp-detail off'} inert={!master}>
            {TOOLS.map((t) => {
              const codexBlocked = t.k === 'codexReview' && !codexOn
              const claudeBlocked = t.k === 'claudeReview' && !claudeOn
              const blocked = codexBlocked || claudeBlocked
              const note = blocked
                ? null
                : t.k === 'claudeReview' && !codexOn
                  ? `Only Codex sessions use it; Codex is ${codexState}.`
                  : t.k === 'codexReview' && !claudeOn
                    ? 'Only Claude sessions use it; Claude Code is off.'
                    : null
              return (
                <div className={blocked ? 'tool-card blocked' : 'tool-card'} key={t.k} inert={blocked}>
                  <div className="tc-ic">{t.icon}</div>
                  <div className="tc-body">
                    <div className="tc-t">
                      {t.title}
                      {(blocked || t.tag) && <span className="gh-tag">{codexBlocked ? `Codex ${codexState}` : claudeBlocked ? 'Claude Code off' : t.tag}</span>}
                    </div>
                    <div className="tc-d">
                      {codexBlocked
                        ? codexState === 'off'
                          ? 'Code review is powered by Codex, which is turned off. Turn it on in Settings, Accounts.'
                          : 'Code review is powered by Codex, which is not set up. Set it up in Settings, Accounts.'
                        : claudeBlocked
                          ? 'Code review is powered by Claude Code, which is turned off. Turn it on in Settings, Accounts.'
                          : t.desc}
                    </div>
                    {note && <div className="tc-d tc-note">{note}</div>}
                  </div>
                  <button
                    className={tools[t.k] && !blocked ? 'tc-sw on' : 'tc-sw'}
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
                <b>Built-in Tools are off.</b>
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
          <span className="oo-lbl">Built-in Tools</span>
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
