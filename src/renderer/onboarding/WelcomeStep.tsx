import { BrandMark } from '../components/BrandMark'
import { useSettingsStore, type ThemeMode } from '../stores/settingsStore'
import { useProviderAccountsStore } from '../stores/providerAccountsStore'
import { claudeCodeOn } from './hello-codex'
import { claudeWasMissingAtSetup } from './provider-choice'

const LOCK = String.fromCodePoint(0x1f512)
const CHECK = String.fromCodePoint(0x2713)

function ThemeTile({
  look,
  name,
  desc,
  mini,
  selected,
  onSelect,
}: {
  look: ThemeMode
  name: string
  desc: string
  mini: 'd' | 'l' | 's'
  selected: boolean
  onSelect: (l: ThemeMode) => void
}) {
  return (
    <button className={selected ? 'tile sel' : 'tile'} onClick={() => onSelect(look)} type="button">
      <span className="ck">{CHECK}</span>
      <div className={`mini ${mini}`}>
        <div className="rail" />
        <div className="pane">
          <div className="bar b1" />
          <div className="bar b2" />
          <div className="bar b3" />
          <div className="dot" />
        </div>
      </div>
      <div className="tname">{name}</div>
      <div className="tdesc">{desc}</div>
    </button>
  )
}

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  // The theme setting is the source of truth; the app's theme controller stamps
  // data-theme on <html> live, so picking a tile re-themes the whole harness.
  const theme = useSettingsStore((s) => s.settings.theme)
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const pick = (look: ThemeMode) => {
    void useSettingsStore.getState().updateSettings({ theme: look })
  }
  // A run that goes on without Claude Code (it is off, or setup found no
  // Claude Code CLI and the user chose "Use Codex only") is not told about
  // "the Claude Code you already use", nor about the Claude-only status line.
  const withClaude = claudeCodeOn({ claudeEnabled }, snapshot) && !claudeWasMissingAtSetup()
  return (
    <>
      <div className="hero">
        <BrandMark className="mark" />
        <h1 className="word">AI Code</h1>
        <div className="sub">Conductor</div>
        {withClaude ? (
          <p className="lede" data-testid="welcome-lede">
            Welcome. I built <b>AI Code Conductor to sit on top of the Claude Code you already use</b>. It runs your
            sessions and adds accounts, status lines, history and cost tracking on top.
          </p>
        ) : (
          <p className="lede" data-testid="welcome-lede">
            Welcome. I built <b>AI Code Conductor to sit on top of your coding assistants</b>. It runs your sessions
            as tabs and adds accounts and usage tracking on top.
          </p>
        )}
        <p className="setup">
          This one-time walkthrough takes about <b>5 minutes</b>. Every feature is optional: skip it now, switch it
          on later in Settings.
        </p>
        <p className="themeq">First, pick a look (you can change it anytime)</p>
        <div className="tiles">
          <ThemeTile look="dark" name="Dark" desc="Easy on the eyes, our default." mini="d" selected={theme === 'dark'} onSelect={pick} />
          <ThemeTile look="light" name="Light" desc="Bright, without the glare." mini="l" selected={theme === 'light'} onSelect={pick} />
          <ThemeTile look="system" name="System" desc="Follow your OS." mini="s" selected={theme === 'system'} onSelect={pick} />
        </div>
        <div className="privacy">
          <span className="lock">{LOCK}</span>
          {/* Not "everything stays on your machine": Codex review sends a diff to
              OpenAI, and GitHub polling + update checks reach github.com. Same
              honest framing as Settings → GitHub ("No telemetry", then what the
              feature actually calls). */}
          <span>
            No telemetry. Your sessions, logs and settings stay on your machine — only the features you switch on
            reach out (GitHub, Codex review, update checks). Any command the Conductor runs is shown to you first.
          </span>
        </div>
      </div>
      <div className="foot">
        {/* Not "we'll get to Claude next": a fresh install picks its
            assistants first (WP2), and a Codex-only run never meets Claude. */}
        <span className="hint">No account needed yet. You pick your assistants in a moment.</span>
        {/* The page's primary button takes focus on entry, not the page body. */}
        <button className="cta" onClick={onNext} type="button" autoFocus data-testid="welcome-next">
          Let's go →
        </button>
      </div>
    </>
  )
}
