import React from 'react'
import { AGENT_EXAMPLES, type AgentExample, type ExampleIcon } from './example-templates'

// --- icons -------------------------------------------------------------

function ExampleGlyph({ icon }: { icon: ExampleIcon }) {
  const common = {
    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  if (icon === 'refactor') {
    return <svg {...common}><path d="M14 4l6 6" /><path d="M3 21l3-1 11-11-2-2L4 18z" /></svg>
  }
  if (icon === 'tests') {
    return <svg {...common}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
  }
  return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
}

function Plus() {
  return <svg width="11" height="11" viewBox="0 0 12 12"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.6" /><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" /></svg>
}

// --- dismissible "how it works" banner (persists until dismissed) -------

function Step({ n, label }: { n: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
        style={{ background: 'color-mix(in srgb, var(--color-sapphire) 18%, transparent)', color: 'var(--color-sapphire)' }}
      >
        {n}
      </span>
      <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{label}</span>
    </span>
  )
}

export function AgentHubExplainer({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="mx-4 mt-3 mb-1 rounded-xl px-4 py-3 relative shrink-0"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--highlight-inset)' }}
    >
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="absolute top-2.5 right-2.5 w-5 h-5 flex items-center justify-center rounded transition-colors hover:bg-surface0/40 focus-ring"
        style={{ color: 'var(--text-muted)' }}
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
      </button>
      <div className="text-[11px] font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--text-muted)' }}>How cloud agents work</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pr-5">
        <Step n="1" label="Dispatch a task" />
        <span style={{ color: 'var(--text-muted)' }}>&rarr;</span>
        <Step n="2" label="A headless Claude runs it in your project folder" />
        <span style={{ color: 'var(--text-muted)' }}>&rarr;</span>
        <Step n="3" label="Read the output here" />
      </div>
      <div className="mt-2.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        It all runs locally in the background while you keep working.
      </div>
    </div>
  )
}

// --- first-run examples + CTA (shown when there are no agents) ----------

export function AgentHubExamples({ onPick, onNew }: { onPick: (example: AgentExample) => void; onNew: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10 overflow-y-auto min-h-0">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" /></svg>
      </div>
      <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No agents yet</h3>
      <p className="text-xs max-w-sm mb-5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Give a task and a project folder, then read the result here whenever it&apos;s done. Start from an example:
      </p>
      <div className="flex flex-wrap gap-3 justify-center mb-6">
        {AGENT_EXAMPLES.map(ex => (
          <button
            key={ex.id}
            onClick={() => onPick(ex)}
            className="w-52 text-left rounded-xl p-3 transition-all duration-150 hover:-translate-y-0.5 hover:ring-1 hover:ring-sapphire/40 focus-ring"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: 'color-mix(in srgb, var(--color-sapphire) 16%, transparent)', color: 'var(--color-sapphire)' }}
              >
                <ExampleGlyph icon={ex.icon} />
              </span>
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{ex.name}</span>
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{ex.description}</div>
          </button>
        ))}
      </div>
      <button
        onClick={onNew}
        className="px-4 py-2 rounded-lg text-xs font-medium bg-sapphire hover:bg-sapphire/85 text-crust transition-colors inline-flex items-center gap-1.5"
      >
        <Plus />
        New agent
      </button>
    </div>
  )
}
