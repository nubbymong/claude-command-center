import React, { useCallback, useState } from 'react'
import ExcalidrawPane from './ExcalidrawPane'
import { useCanvasStore } from '../stores/canvasStore'

interface Props {
  sessionId: string
  onClose: () => void
}

/** What one keypress asks the agent to do. Typed into the terminal WITHOUT a
 *  newline — the user reads it, can edit it, and presses Enter themselves.
 *  Plain words, no tool names: the agent-canvas skill (canvas-plugin.ts)
 *  carries the workflow — htmlPath, data-ux-ids, self-check, hand-back — so
 *  the user never has to speak MCP (owner feedback 2026-08-14). */
const STARTER_PROMPT =
  'Show me a design mockup of what you are building on my Agent Canvas.'

const LOOP_STEPS: Array<{ title: string; detail: string }> = [
  { title: 'Agent renders', detail: 'a real page appears here' },
  { title: 'You annotate', detail: 'click elements, drag regions, sketch' },
  { title: 'Submit review', detail: 'your notes land in the chat' },
  { title: 'Agent revises', detail: 'it reads every note and re-renders' },
  { title: 'You resolve', detail: 'approve or follow up, note by note' },
]

/**
 * The Agent Canvas landing (owner feedback 2026-08-13): with nothing rendered
 * yet, the pane used to fall straight back to the old Draw sketchpad —
 * indistinguishable from the feature it replaced, teaching nothing. This is
 * the empty state's actual job: say what the surface IS, put the first render
 * one keypress away, and keep the classic sketchpad one click away (spec D2 —
 * old Draw behaviour is preserved, it just is not the greeting).
 */
export default function CanvasEmptyState({ sessionId, onClose }: Props) {
  const emptyView = useCanvasStore((s) => s.bySessionId[sessionId]?.emptyView ?? 'intro')
  const setEmptyView = useCanvasStore((s) => s.setEmptyView)
  const [typed, setTyped] = useState(false)
  const [copied, setCopied] = useState(false)

  const typeIntoTerminal = useCallback(() => {
    // No newline: the terminal shows the request, the user sends it.
    window.electronAPI.pty.write(sessionId, STARTER_PROMPT)
    setTyped(true)
    window.setTimeout(() => setTyped(false), 4000)
  }, [sessionId])

  const copyPrompt = useCallback(() => {
    void navigator.clipboard?.writeText(STARTER_PROMPT).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }, [])

  if (emptyView === 'sketchpad') {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <ExcalidrawPane sessionId={sessionId} />
        {/* The way back to the canvas identity — floating so the classic pane
            keeps its whole chrome untouched. */}
        <button
          onClick={() => setEmptyView(sessionId, 'intro')}
          className="absolute bottom-3 right-3 z-10 px-2.5 py-1 text-[11px] rounded-full border border-mauve/50 bg-crust/95 text-mauve hover:bg-mauve/10 shadow-lg"
          title="Back to the Agent Canvas introduction"
        >
          Agent Canvas
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Same chrome family as the live canvas surface. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
        <span className="text-[11px] font-medium text-subtext1">Agent Canvas</span>
        <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface0 text-overlay1 border border-surface1/60">
          nothing rendered yet
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setEmptyView(sessionId, 'sketchpad')}
          className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0/60 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
          title="Open the classic free-form sketchpad"
        >
          Sketchpad
        </button>
        <button
          onClick={onClose}
          className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
          title="Close Agent Canvas"
        >
          Close
        </button>
      </div>

      {/* Dot-grid stage so the empty surface reads as a canvas, not a void. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          backgroundImage: 'radial-gradient(color-mix(in srgb, var(--color-overlay0) 25%, transparent) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        <div className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-6">
          {/* Identity */}
          <div className="flex items-start gap-4">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true" className="shrink-0 mt-1">
              <rect x="3" y="6" width="30" height="24" rx="3" className="stroke-mauve" strokeWidth="2" />
              <rect x="8" y="12" width="12" height="4" rx="1" className="fill-overlay1" />
              <rect x="8" y="19" width="20" height="3" rx="1" className="fill-surface2" />
              <rect x="8" y="24" width="16" height="3" rx="1" className="fill-surface2" />
              <circle cx="33" cy="30" r="9" className="fill-crust stroke-peach" strokeWidth="2" />
              <path d="M29.5 30.2l2.3 2.3 4.4-4.6" className="stroke-peach" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <div>
              <h2 className="text-lg font-semibold text-text">Agent Canvas</h2>
              <p className="text-[13px] text-subtext0 mt-1 leading-relaxed">
                Your agent renders real pages here — mockups or the built app — and you review them
                where you can point at things, instead of describing them in chat.
              </p>
            </div>
          </div>

          {/* The loop */}
          <div className="rounded-lg border border-surface0 bg-mantle/80 p-4">
            <div className="text-[11px] font-medium text-subtext1 uppercase tracking-wide mb-3">The review loop</div>
            <ol className="flex flex-col gap-2">
              {LOOP_STEPS.map((step, i) => (
                <li key={step.title} className="flex items-center gap-3">
                  <span className="w-5 h-5 shrink-0 rounded-full bg-surface0 border border-surface1 text-overlay1 text-[10px] flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="text-[13px] text-text">{step.title}</span>
                  <span className="text-[12px] text-overlay1">— {step.detail}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Getting started */}
          <div className="rounded-lg border border-mauve/40 bg-mauve/5 p-4">
            <div className="text-[11px] font-medium text-mauve uppercase tracking-wide mb-2">Start here</div>
            <p className="text-[13px] text-subtext0 mb-3">
              Ask your agent to put something on the canvas. This pane takes over automatically when a
              version arrives.
            </p>
            <div className="rounded border border-surface1 bg-crust px-3 py-2 text-[12px] font-mono text-text/90 leading-relaxed">
              {STARTER_PROMPT}
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={typeIntoTerminal}
                className="px-2.5 py-1 text-[12px] rounded border border-mauve/50 text-mauve hover:bg-mauve/10 transition-colors"
                title="Types the request into this session's terminal — you press Enter to send it"
              >
                {typed ? 'Typed — press Enter in the terminal' : 'Type it into the terminal'}
              </button>
              <button
                onClick={copyPrompt}
                className="px-2.5 py-1 text-[12px] rounded border border-surface1 text-overlay1 hover:text-text transition-colors"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Review controls, so the vocabulary is familiar before content exists. */}
          <div className="rounded-lg border border-surface0 bg-mantle/80 p-4">
            <div className="text-[11px] font-medium text-subtext1 uppercase tracking-wide mb-3">Once something is rendered</div>
            <ul className="flex flex-col gap-1.5 text-[12px] text-subtext0">
              <li><span className="text-text">Browse</span> — the page is live: hover to inspect, <span className="text-text">click to select</span> what a note is about. <span className="font-mono text-[11px] px-1 rounded bg-surface0 border border-surface1/60">↑</span> selects the parent, <span className="font-mono text-[11px] px-1 rounded bg-surface0 border border-surface1/60">Esc</span> clears.</li>
              <li><span className="text-text">Region</span> — drag a rectangle when a note is about an area, not one element.</li>
              <li><span className="text-text">Draw</span> — sketch on the glass; attach the sketch to a note to show what you mean.</li>
              <li><span className="text-text">Submit review</span> — your notes go to the agent as one batch; it revises and the loop continues.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
