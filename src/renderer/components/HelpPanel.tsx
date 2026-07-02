import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { APP_KNOWLEDGE_SECTIONS } from '../../shared/app-knowledge'
import { useConfigStore, type TerminalConfig } from '../stores/configStore'
import { useLaunchConfig } from '../hooks/useLaunchConfig'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { generateId } from '../utils/id'

interface Props {
  onClose: () => void
  /** Opens the classic feature tour (TrainingWalkthrough help mode). */
  onStartTour: () => void
  /** Switch the main view to sessions after an Ask session launches. */
  onShowSessions: () => void
}

// One home for help: searchable app knowledge (the same curated doc the Ask
// session reads), the feature tour, and "Ask Claude" — which launches a REAL
// Claude session inside the staged help workspace so Claude already knows the
// app. The typed question is copied to the clipboard for pasting; the session
// is primed either way.
export default function HelpPanel({ onClose, onStartTour, onShowSessions }: Props) {
  const [query, setQuery] = useState('')
  const [question, setQuestion] = useState('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const launchConfig = useLaunchConfig()
  const configs = useConfigStore((s) => s.configs)

  useFocusTrap(dialogRef, true, onClose)

  const q = query.trim().toLowerCase()
  const sections = useMemo(
    () =>
      q
        ? APP_KNOWLEDGE_SECTIONS.filter(
            (s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
          )
        : APP_KNOWLEDGE_SECTIONS,
    [q],
  )

  const ask = async () => {
    setLaunching(true)
    setError(null)
    try {
      const dir = await window.electronAPI.help.workspace()
      if (!dir) {
        setError('Could not prepare the help workspace.')
        return
      }
      // Reuse (or create once) the Ask Command Center config, keyed by the
      // workspace directory, then launch through the standard config path.
      let config = useConfigStore.getState().configs.find((c) => c.workingDirectory === dir)
      if (!config) {
        const created: TerminalConfig = {
          id: generateId(),
          label: 'Ask Command Center',
          workingDirectory: dir,
          color: '#a78bfa',
          identityColorKey: 'mauve',
          sessionType: 'local',
          provider: 'claude',
        }
        useConfigStore.getState().addConfig(created)
        config = created
      }
      if (question.trim()) {
        // Copied, not auto-typed: injecting keystrokes races Claude's startup
        // (and the resume picker), so the user pastes when the prompt is ready.
        try {
          await navigator.clipboard.writeText(question.trim())
        } catch {
          // Clipboard can be unavailable; the session is still primed.
        }
      }
      launchConfig(config)
      onShowSessions()
      onClose()
    } finally {
      setLaunching(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-panel-title"
        className="bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-2xl max-h-[85vh] flex flex-col"
      >
        <div className="p-5 border-b border-surface0 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="help-panel-title" className="text-lg font-bold text-text">Help</h3>
              <p className="text-xs text-subtext0 mt-1">
                Search the guide, replay the feature tour, or ask Claude directly.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-overlay0 hover:text-text transition-colors text-xl leading-none shrink-0"
            >
              &times;
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide (accounts, status line, GitHub, shortcuts…)"
              className="flex-1 bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-blue/50 placeholder:text-overlay0"
            />
            <button
              onClick={() => { onClose(); onStartTour() }}
              className="text-xs px-3 py-2 rounded-lg border border-surface1 bg-surface0 text-subtext0 hover:text-text transition-colors shrink-0"
            >
              Feature tour
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {sections.length === 0 && (
            <p className="text-sm text-subtext0">
              Nothing in the guide matches "{query}". Try asking Claude below.
            </p>
          )}
          {sections.map((s) => (
            <div key={s.id}>
              <h4 className="text-sm font-semibold text-text mb-1">{s.title}</h4>
              <p className="text-[13px] leading-relaxed text-subtext0">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-surface0 shrink-0">
          <div className="flex items-center gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !launching) void ask() }}
              placeholder="Ask Claude about Command Center…"
              className="flex-1 bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-blue/50 placeholder:text-overlay0"
            />
            <button
              onClick={() => void ask()}
              disabled={launching}
              className="text-xs px-3 py-2 rounded-lg bg-blue text-base font-medium hover:bg-blue/80 transition-colors disabled:opacity-60 shrink-0"
            >
              {launching ? 'Opening…' : 'Ask Claude'}
            </button>
          </div>
          <p className="text-[11px] text-overlay0 mt-2">
            Opens a Claude session primed with this guide (uses your normal Claude usage). Your question is copied;
            paste it when the prompt appears.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
