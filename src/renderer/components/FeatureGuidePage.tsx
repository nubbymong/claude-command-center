import { useMemo, useRef, useState } from 'react'
import PageFrame from './PageFrame'
import { APP_KNOWLEDGE_SECTIONS } from '../../shared/app-knowledge'
import { trainingSteps, SECTION_LABELS, type TrainingStep, type TrainingSection } from '../training-steps'
import { useConfigStore, type TerminalConfig } from '../stores/configStore'
import { useLaunchConfig } from '../hooks/useLaunchConfig'
import { generateId } from '../utils/id'

// Full-screen Feature Guide — a peer page (ViewType 'help'), NOT the old
// createPortal modal that floated over every other page. It renders the same
// owner-approved catalogue the tour uses (trainingSteps), grouped by section in
// a PageFrame left rail, plus the curated prose (APP_KNOWLEDGE_SECTIONS) as an
// Overview + Reference, and keeps "Ask the Conductor" — a real Claude session
// staged with the app knowledge — as a page action.

// Same platform-aware screenshot resolution the tour uses, so cards show the
// existing training captures without a second asset set.
const screenshotModules = import.meta.glob('../assets/training/*.jpg', { eager: true, as: 'url' })
const screenshotMap: Record<string, string> = {}
for (const [path, url] of Object.entries(screenshotModules)) {
  const filename = path.split('/').pop()
  if (filename) screenshotMap[filename] = url as string
}
function getScreenshot(filename: string): string | undefined {
  const platform = window.electronPlatform === 'darwin' ? 'mac' : 'win'
  const base = filename.replace('.jpg', '')
  return screenshotMap[`${base}-${platform}.jpg`] || screenshotMap[filename]
}

// `**bold**` and `` `code` `` inline formatting used by the training copy.
function renderRich(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /\*\*(.+?)\*\*|`(.+?)`/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<strong key={k++} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{m[1]}</strong>)
    else out.push(<code key={k++} className="fg-code">{m[2]}</code>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type GuideSectionId = 'overview' | TrainingSection | 'reference'

const SECTION_ORDER: TrainingSection[] = ['getting-started', 'productivity', 'integrations', 'admin', 'tips']

// A friendly major.minor for the "since" chip (2.1.0 -> 2.1, 1.5.26 -> 1.5).
function shortVersion(v: string): string {
  const parts = v.split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : v
}

interface Props {
  /** Return to the sessions grid (the X in the header and after an Ask launch). */
  onNavigateToSessions: () => void
  /** Launch the classic step-by-step feature tour (TrainingWalkthrough help mode). */
  onStartTour: () => void
}

export default function FeatureGuidePage({ onNavigateToSessions, onStartTour }: Props) {
  const [active, setActive] = useState<GuideSectionId>('overview')
  const [query, setQuery] = useState('')
  const [question, setQuestion] = useState('')
  const [launching, setLaunching] = useState(false)
  const askInputRef = useRef<HTMLInputElement | null>(null)
  const launchConfig = useLaunchConfig()
  const configs = useConfigStore((s) => s.configs)

  const stepsBySection = useMemo(() => {
    const map = new Map<TrainingSection, TrainingStep[]>()
    for (const s of SECTION_ORDER) map.set(s, [])
    for (const step of trainingSteps) {
      if (step.section) map.get(step.section)?.push(step)
    }
    return map
  }, [])

  const q = query.trim().toLowerCase()
  const matchedSteps = useMemo(() => {
    if (!q) return []
    return trainingSteps.filter((s) => {
      const hay = [s.title, s.summary ?? '', ...(s.highlights ?? []), ...(s.bullets ?? [])].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [q])
  const matchedKnowledge = useMemo(() => {
    if (!q) return []
    return APP_KNOWLEDGE_SECTIONS.filter((s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q))
  }, [q])

  // "Ask the Conductor": stage the help workspace, reuse/create the Ask config,
  // copy any typed question, launch through the normal config path. Mirrors the
  // retired HelpPanel.ask so behaviour is unchanged, only relocated.
  const ask = async () => {
    setLaunching(true)
    try {
      const dir = await window.electronAPI.help.workspace()
      if (!dir) return
      let config = useConfigStore.getState().configs.find((c) => c.workingDirectory === dir)
      if (config && config.label === 'Ask Command Center') {
        useConfigStore.getState().updateConfig(config.id, { label: 'Ask Conductor' })
        config = { ...config, label: 'Ask Conductor' }
      }
      if (!config) {
        const created: TerminalConfig = {
          id: generateId(),
          label: 'Ask Conductor',
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
        try { await navigator.clipboard.writeText(question.trim()) } catch { /* clipboard may be unavailable; session is still primed */ }
      }
      launchConfig(config)
      onNavigateToSessions()
    } finally {
      setLaunching(false)
    }
  }

  const railItems: { id: GuideSectionId; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    ...SECTION_ORDER.map((s) => ({ id: s, label: SECTION_LABELS[s], count: stepsBySection.get(s)?.length ?? 0 })),
    { id: 'reference', label: 'Reference' },
  ]

  const leftRail = (
    <nav className="py-1.5" data-ux-id="rail" aria-label="Feature Guide sections">
      {railItems.map((item) => {
        const on = active === item.id && !q
        return (
          <button
            key={item.id}
            data-ux-id={`rail-${item.id}`}
            onClick={() => { setQuery(''); setActive(item.id) }}
            className="w-full text-left px-3 py-1.5 text-xs transition-colors focus-ring flex items-center gap-2"
            style={{
              background: on ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
              color: on ? 'var(--accent)' : 'var(--text-secondary)',
              borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
              fontWeight: on ? 600 : 400,
            }}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.count ? <span className="tabular-nums" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{item.count}</span> : null}
          </button>
        )
      })}
    </nav>
  )

  const actions = (
    <>
      <label
        className="hidden sm:flex items-center gap-1.5 rounded-md px-2 py-1"
        style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <input
          data-ux-id="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search features…"
          className="bg-transparent text-xs outline-none w-40"
          style={{ color: 'var(--text-secondary)' }}
        />
      </label>
      <button
        onClick={onStartTour}
        className="text-[11px] px-2.5 py-1 rounded-md transition-colors focus-ring"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        Feature tour
      </button>
      <button
        data-ux-id="ask-conductor"
        onClick={() => { if (active !== 'overview') { setActive('overview'); setQuery('') } setTimeout(() => askInputRef.current?.focus(), 40) }}
        className="text-[11px] px-2.5 py-1 rounded-md font-semibold transition-colors focus-ring"
        style={{ background: 'color-mix(in srgb, var(--brand) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 45%, transparent)', color: '#cfe6ff' }}
      >
        Ask the Conductor
      </button>
    </>
  )

  return (
    <PageFrame
      icon={<GuideIcon />}
      iconAccent="teal"
      title="Feature Guide"
      context={q ? `Search: ${query}` : railItems.find((r) => r.id === active)?.label}
      actions={actions}
      onClose={onNavigateToSessions}
      leftRail={leftRail}
    >
      <div className="fg-scope max-w-[1040px] mx-auto px-7 py-6" data-ux-id="content">
        {q ? (
          <SearchResults steps={matchedSteps} knowledge={matchedKnowledge} query={query} onClear={() => setQuery('')} />
        ) : active === 'overview' ? (
          <Overview
            question={question}
            setQuestion={setQuestion}
            askInputRef={askInputRef}
            onAsk={ask}
            launching={launching}
            onStartTour={onStartTour}
            onGo={(id) => setActive(id)}
          />
        ) : active === 'reference' ? (
          <Reference />
        ) : (
          <SectionView section={active} steps={stepsBySection.get(active) ?? []} />
        )}
      </div>

      {/* Page-scoped styles: the code chip + card primitives, kept local so the
          guide reads consistently without leaning on utility classes that vary. */}
      <style>{`
        .fg-scope .fg-code, .fg-code { background: var(--surface-base); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0 5px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: #cfe6ff; }
      `}</style>
    </PageFrame>
  )
}

function GuideIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  )
}

// ── The feature card ─────────────────────────────────────────────────────────
function FeatureCard({ step }: { step: TrainingStep }) {
  const shot = getScreenshot(step.screenshotFilename)
  const highlights = step.highlights ?? step.bullets ?? []
  return (
    <article
      data-ux-id={`card-${step.id}`}
      className="grid rounded-2xl overflow-hidden mb-5"
      style={{ gridTemplateColumns: '360px 1fr', background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="p-4 flex items-center justify-center" style={{ background: 'var(--surface-base)', borderRight: '1px solid var(--border-subtle)' }}>
        {shot ? (
          <img src={shot} alt="" className="rounded-lg w-full" style={{ border: '1px solid var(--border-strong)' }} />
        ) : (
          <div className="w-full rounded-lg grid place-items-center" style={{ aspectRatio: '16/10', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', fontSize: 11 }}>{step.title}</div>
        )}
      </div>
      <div className="p-5">
        <div className="flex items-center gap-2.5 mb-2">
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{step.title}</h3>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: '#9fd0ff' }}>since {shortVersion(step.sinceVersion)}</span>
        </div>
        {step.summary && <p className="text-[13px] mb-3.5 max-w-[80ch]" style={{ color: 'var(--text-secondary)' }}>{step.summary}</p>}
        <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 240px' }}>
          <div data-ux-id={`card-${step.id}-highlights`}>
            <h4 className="fg-eyebrow">Worth knowing</h4>
            <ul className="flex flex-col gap-1.5 list-none p-0 m-0">
              {highlights.map((h, i) => (
                <li key={i} className="relative pl-4 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                  <span className="absolute left-0 rounded-full" style={{ top: 7, width: 6, height: 6, background: 'var(--accent)', opacity: .85 }} />
                  {renderRich(h)}
                </li>
              ))}
            </ul>
          </div>
          {step.howToTrigger && step.howToTrigger.length > 0 && (
            <div data-ux-id={`card-${step.id}-howto`}>
              <h4 className="fg-eyebrow">How to open</h4>
              <div className="flex flex-col gap-2">
                {step.howToTrigger.map((h, i) => (
                  <div key={i} className="rounded-lg px-2.5 py-1.5" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}>
                    <div className="fg-eyebrow" style={{ marginBottom: 1 }}>{h.label}</div>
                    <div className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{renderRich(h.value)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {step.proTip && (
          <div className="mt-3.5 flex gap-2.5 rounded-xl px-3 py-2.5" style={{ background: 'color-mix(in srgb, var(--fast-mode) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--fast-mode) 30%, transparent)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fast-mode)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M9 18h6M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" /></svg>
            <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
              <span className="block uppercase font-semibold tracking-wide mb-0.5" style={{ color: 'var(--fast-mode)', fontSize: 10 }}>Pro tip</span>
              {step.proTip}
            </div>
          </div>
        )}
      </div>
      <style>{`.fg-eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px}`}</style>
    </article>
  )
}

// ── A feature section (hero + its cards) ─────────────────────────────────────
const SECTION_BLURB: Record<TrainingSection, { title: string; blurb: string }> = {
  'getting-started': { title: 'The first things to set up', blurb: 'A saved config is the unit of work — what runs, where, and as whom. Get these right and every other feature has something to hang off.' },
  productivity: { title: 'Move faster inside a session', blurb: 'Panes, sketches and captures that live next to the terminal, so you never have to leave the session to show Claude something.' },
  integrations: { title: 'Everything the Conductor plugs into', blurb: 'Codex, browser automation, agents, GitHub and the Agent Canvas — each wired into the same session model.' },
  admin: { title: 'See what your sessions are doing', blurb: 'The dashboards over your own usage: spend, memory, insights, transcripts and every preference in one place.' },
  tips: { title: 'Power moves and shortcuts', blurb: 'Small things you will start using on day two.' },
}

function SectionView({ section, steps }: { section: TrainingSection; steps: TrainingStep[] }) {
  const meta = SECTION_BLURB[section]
  return (
    <div>
      <SectionHero eyebrow={SECTION_LABELS[section]} title={meta.title} blurb={meta.blurb} />
      {steps.map((s) => <FeatureCard key={s.id} step={s} />)}
    </div>
  )
}

function SectionHero({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb: string }) {
  return (
    <div className="mb-6" data-ux-id="section-hero">
      <div className="fg-eyebrow" style={{ letterSpacing: '.1em' }}>{eyebrow}</div>
      <h2 className="text-[21px] font-bold mt-1 mb-1" style={{ color: 'var(--text-primary)', letterSpacing: '-.2px' }}>{title}</h2>
      <p className="text-[13.5px] max-w-[76ch]" style={{ color: 'var(--text-secondary)' }}>{blurb}</p>
      <style>{`.fg-eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--text-muted)}`}</style>
    </div>
  )
}

// ── Overview landing ─────────────────────────────────────────────────────────
function Overview({
  question, setQuestion, askInputRef, onAsk, launching, onStartTour, onGo,
}: {
  question: string
  setQuestion: (v: string) => void
  askInputRef: React.RefObject<HTMLInputElement | null>
  onAsk: () => void
  launching: boolean
  onStartTour: () => void
  onGo: (id: GuideSectionId) => void
}) {
  const overview = APP_KNOWLEDGE_SECTIONS.find((s) => s.id === 'overview')
  const quick: { id: TrainingSection; label: string; desc: string }[] = [
    { id: 'getting-started', label: 'Getting started', desc: 'Configs, accounts' },
    { id: 'integrations', label: 'Integrations', desc: 'Codex, agents, canvas' },
    { id: 'admin', label: 'Admin & data', desc: 'Tokenomics, memory, logs' },
    { id: 'productivity', label: 'Productivity', desc: 'Panes, sketch, snap' },
  ]
  return (
    <div>
      <div className="rounded-2xl p-7 mb-5" data-ux-id="overview-hero" style={{ background: 'linear-gradient(135deg, var(--surface-raised), var(--surface-panel))', border: '1px solid var(--border-subtle)' }}>
        <h2 className="text-[24px] font-bold mb-2" style={{ color: 'var(--text-primary)', letterSpacing: '-.3px' }}>
          Everything <span style={{ color: 'var(--accent)' }}>AI Code Conductor</span> can do
        </h2>
        <p className="text-[14px] mb-5 max-w-[82ch]" style={{ color: 'var(--text-secondary)' }}>{overview?.body}</p>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {quick.map((qk) => (
            <button key={qk.id} onClick={() => onGo(qk.id)} className="text-left rounded-xl px-3.5 py-3 transition-colors focus-ring" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[13px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>{qk.label}</div>
              <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{qk.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Ask the Conductor */}
      <div className="rounded-2xl p-6 mb-5" data-ux-id="ask-card" style={{ background: 'var(--surface-raised)', border: '1px solid color-mix(in srgb, var(--brand) 35%, var(--border-subtle))' }}>
        <div className="flex items-start gap-3 mb-3">
          <span className="grid place-items-center rounded-lg shrink-0" style={{ width: 34, height: 34, background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: 'var(--brand)' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          </span>
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Ask the Conductor</h3>
            <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Opens a Claude session already primed with this guide, so it can answer questions about the app itself. Uses your normal Claude usage.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={askInputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !launching) onAsk() }}
            placeholder="e.g. How do I run two accounts at once?"
            className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          />
          <button
            onClick={onAsk}
            disabled={launching}
            className="text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors focus-ring disabled:opacity-60"
            style={{ background: 'var(--brand)', color: 'var(--ob-on)' }}
          >
            {launching ? 'Opening…' : 'Ask'}
          </button>
        </div>
        <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>Your question is copied to the clipboard; paste it when the Claude prompt appears.</p>
      </div>

      <div className="flex items-center justify-between rounded-2xl px-5 py-4" data-ux-id="tour-card" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Prefer a walkthrough?</h3>
          <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Step through every feature one at a time, docked beside the live app.</p>
        </div>
        <button onClick={onStartTour} className="text-[12.5px] font-medium px-3.5 py-2 rounded-lg transition-colors focus-ring shrink-0" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>Take the tour</button>
      </div>
    </div>
  )
}

// ── Reference (prose from app-knowledge) ─────────────────────────────────────
function Reference() {
  const ids = ['privacy', 'troubleshooting', 'shortcuts']
  const secs = ids.map((id) => APP_KNOWLEDGE_SECTIONS.find((s) => s.id === id)).filter(Boolean) as { id: string; title: string; body: string }[]
  return (
    <div>
      <SectionHero eyebrow="Reference" title="Privacy, data and troubleshooting" blurb="The plain-English answers to where your data lives and what to check when something looks off." />
      {secs.map((s) => (
        <article key={s.id} data-ux-id={`ref-${s.id}`} className="rounded-2xl p-5 mb-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
          <h3 className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{s.title}</h3>
          <p className="text-[13px] leading-relaxed max-w-[86ch]" style={{ color: 'var(--text-secondary)' }}>{s.body}</p>
        </article>
      ))}
    </div>
  )
}

// ── Search results ───────────────────────────────────────────────────────────
function SearchResults({ steps, knowledge, query, onClear }: { steps: TrainingStep[]; knowledge: { id: string; title: string; body: string }[]; query: string; onClear: () => void }) {
  const empty = steps.length === 0 && knowledge.length === 0
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="fg-eyebrow" style={{ fontSize: 11, letterSpacing: '.1em', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Search</div>
          <h2 className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>{steps.length + knowledge.length} result{steps.length + knowledge.length === 1 ? '' : 's'} for “{query}”</h2>
        </div>
        <button onClick={onClear} className="text-[12px] px-3 py-1.5 rounded-lg focus-ring" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>Clear</button>
      </div>
      {empty && <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Nothing in the guide matches “{query}”. Try the Ask the Conductor box on the Overview.</p>}
      {steps.map((s) => <FeatureCard key={s.id} step={s} />)}
      {knowledge.map((s) => (
        <article key={s.id} className="rounded-2xl p-5 mb-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
          <h3 className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{s.title}</h3>
          <p className="text-[13px] leading-relaxed max-w-[86ch]" style={{ color: 'var(--text-secondary)' }}>{s.body}</p>
        </article>
      ))}
    </div>
  )
}
