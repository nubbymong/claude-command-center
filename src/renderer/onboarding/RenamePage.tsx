import type { JSX } from 'react'
import brandIcon from '../assets/brand-icon.png'

/**
 * The rename/roadmap page (#525) — the first page of the What's New run,
 * canvas-designed with the owner (v6, 2026-08-26). Upgraders arriving from a
 * build that predates the rename open on "Claude Command Center is now:";
 * fresh installs get the same page under "Welcome to" (owner call on R1:
 * "this rename thing can go for new installs too — advertising the roadmap
 * is ideal"). Copy rules from that review: no fluff, anchor the tagline in
 * what is true TODAY on this line, and keep 2.2 confined to the clearly
 * labelled roadmap band.
 *
 * The CLI brand glyphs are simplified inline SVG marks (no external assets,
 * no emoji, no screenshots) — pictures OF the brands in the app's drawn
 * style. Swap for licensed artwork if the owner supplies it.
 */

function ClaudeGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#d97757" strokeWidth="2.4" strokeLinecap="round">
        <line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" />
        <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /><line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
      </g>
    </svg>
  )
}

function CodexGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 3.2 19.6 7.6 v8.8 L12 20.8 4.4 16.4 V7.6 Z" />
        <path d="M12 8 15.5 10 v4 L12 16 8.5 14 v-4 Z" />
      </g>
    </svg>
  )
}

function CopilotGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="#79b8ff" strokeWidth="1.9" strokeLinecap="round">
        <path d="M4 10.5 C4 6.5 7 5 12 5 s8 1.5 8 5.5 v3 C20 17 17.5 19 12 19 S4 17 4 13.5 Z" />
        <rect x="7" y="10" width="3.4" height="4.6" rx="1.4" fill="#79b8ff" stroke="none" />
        <rect x="13.6" y="10" width="3.4" height="4.6" rx="1.4" fill="#79b8ff" stroke="none" />
      </g>
    </svg>
  )
}

function AntigravityGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="rn-ag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4285F4" /><stop offset="1" stopColor="#9b72cb" />
        </linearGradient>
      </defs>
      <path fill="url(#rn-ag)" d="M12 2 C12.8 7.5 16.5 11.2 22 12 16.5 12.8 12.8 16.5 12 22 11.2 16.5 7.5 12.8 2 12 7.5 11.2 11.2 7.5 12 2 Z" />
    </svg>
  )
}

function QwenGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="#615ced" strokeWidth="2" strokeLinejoin="round">
        <path d="M12 3 20 7.7 v8.6 L12 21 4 16.3 V7.7 Z" />
        <path d="M12 8.2 15.4 12 12 15.8 8.6 12 Z" fill="#615ced" stroke="none" />
      </g>
    </svg>
  )
}

function OpenCodeGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M7 9.5 10 12 7 14.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="15" x2="16.5" y2="15" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

function OllamaGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6.5 C8 3.8 9 2.5 9.7 2.5 10.4 2.5 11 3.8 11 6" />
        <path d="M16 6.5 C16 3.8 15 2.5 14.3 2.5 13.6 2.5 13 3.8 13 6" />
        <path d="M7.2 9.8 C7.2 7.4 9.2 5.8 12 5.8 s4.8 1.6 4.8 4 c1 .7 1.7 1.9 1.7 3.3 0 1.1-.4 2-1.1 2.7 .4.9.6 1.9.6 3.2 h-2.1 c0-1.9-1.3-3.2-3.9-3.2 s-3.9 1.3-3.9 3.2 H6 c0-1.3.2-2.3.6-3.2 -.7-.7-1.1-1.6-1.1-2.7 0-1.4.7-2.6 1.7-3.3 Z" />
        <circle cx="10.2" cy="11.4" r=".6" fill="currentColor" stroke="none" />
        <circle cx="13.8" cy="11.4" r=".6" fill="currentColor" stroke="none" />
      </g>
    </svg>
  )
}

interface TileSpec {
  key: string
  name: string
  sub: string
  live?: boolean
  badge: 'NOW' | 'BETA' | '2.2'
  glyph: () => JSX.Element
}

const TODAY: TileSpec[] = [
  { key: 'claude', name: 'Claude Code', sub: 'Anthropic', live: true, badge: 'NOW', glyph: ClaudeGlyph },
  { key: 'codex', name: 'Codex', sub: 'OpenAI', live: true, badge: 'BETA', glyph: CodexGlyph },
]

const IN_22: TileSpec[] = [
  { key: 'copilot', name: 'Copilot CLI', sub: 'GitHub', badge: '2.2', glyph: CopilotGlyph },
  { key: 'antigravity', name: 'Antigravity', sub: 'Google', badge: '2.2', glyph: AntigravityGlyph },
  { key: 'qwen', name: 'Qwen Code', sub: 'Alibaba', badge: '2.2', glyph: QwenGlyph },
  { key: 'opencode', name: 'OpenCode', sub: 'open source', badge: '2.2', glyph: OpenCodeGlyph },
  { key: 'ollama', name: 'Ollama', sub: 'local models', badge: '2.2', glyph: OllamaGlyph },
]

function Tile({ t }: { t: TileSpec }) {
  const G = t.glyph
  return (
    <div className={`rn-tile${t.live ? ' rn-live' : ''}`} data-ux-id={`tile-${t.key}`}>
      <span className={`rn-badge ${t.badge === 'NOW' ? 'rn-now' : t.badge === 'BETA' ? 'rn-beta' : 'rn-b22'}`}>{t.badge}</span>
      <span className="rn-glyph"><G /></span>
      <span className="rn-tname">{t.name}</span>
      <span className="rn-tsub">{t.sub}</span>
    </div>
  )
}

export function RenamePageView({ fresh }: { fresh: boolean }) {
  return (
    <div className="p2">
      <div className="p2-inner rn-page" data-ux-id="rename-page">
        <div className="rn-lead" data-ux-id="rename-lead-line">
          {fresh ? <>Welcome to</> : <><b>Claude Command Center</b> is now:</>}
        </div>
        <div className="rn-lockup" data-ux-id="brand-lockup">
          <img className="rn-logo" alt="" aria-hidden src={brandIcon} />
          <span className="rn-name" data-ux-id="rename-heading">AI Code Conductor</span>
        </div>
        <p className="rn-tagline" data-ux-id="rename-tagline">
          This app already runs Codex beside Claude Code, and more agents are on the way &mdash; a name tied to one of them no longer fit.
        </p>

        <div className="rn-roadmap" data-ux-id="roadmap-band">
          <div className="rn-rm-head">
            <span className="rn-rm-title">One app, every coding agent</span>
            <span className="rn-rm-pill" data-ux-id="roadmap-pill">2.2 IN DEVELOPMENT</span>
          </div>
          <div className="rn-rm-flex">
            <div className="rn-rm-group" data-ux-id="rm-today">
              <div className="rn-rm-glabel rn-today">Conducting today</div>
              <div className="rn-rm-tiles">{TODAY.map((t) => <Tile key={t.key} t={t} />)}</div>
            </div>
            <div className="rn-rm-arrow" aria-hidden>&rarr;</div>
            <div className="rn-rm-group rn-grow" data-ux-id="rm-22">
              <div className="rn-rm-glabel">Coming in 2.2</div>
              <div className="rn-rm-tiles">{IN_22.map((t) => <Tile key={t.key} t={t} />)}</div>
            </div>
          </div>
          <div className="rn-deep" data-ux-id="rm-deep">
            <b>And 2.2 goes deep, not just wide.</b> Each agent gets the full toolkit &mdash; accounts and switching, usage and spend, memory, insights, the watchdog. <span className="rn-codex-line">Codex runs in beta today and gets the full upgrade in 2.2.</span>
          </div>
        </div>

        <div className="rn-points" data-ux-id="rename-points">
          <div className="rn-pt" data-ux-id="rename-pt-nothing">
            <span className="wn-dot" /><div><b>Nothing to redo.</b> Sessions, configs and accounts carry over.</div>
          </div>
          <div className="rn-pt" data-ux-id="rename-pt-why">
            <span className="wn-dot" /><div><b>Claude stays first-class.</b> New agents arrive beside your workflow, not instead of it.</div>
          </div>
        </div>
        <div className="rn-smallprint" data-ux-id="rename-where">
          Roadmap order can shift &mdash; each agent lands in <b>What&rsquo;s New</b> as it ships.
        </div>
      </div>
    </div>
  )
}
