import type { ShowcaseArtKind } from './showcase-pages'

/**
 * The drawn illustrations for the What's New showcase pages — pure CSS
 * mini-app vignettes (styles in onboarding.css under `.sv-*`), no screenshots
 * and no emoji, per the project's JSX conventions. Decorative: every vignette
 * is aria-hidden, because the copy beside it says everything it draws.
 *
 * These are pictures OF the features, not the features: a change to the real
 * canvas pane or command bar does not oblige a change here, only a glance at
 * whether the picture still tells the truth.
 */

function CanvasVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-canvas">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-toolrow">
        <span className="sv-toolchip">Snap</span>
        <span className="sv-toolchip sv-amber">Review needed · 2</span>
        <span className="sv-toolchip">Logs</span>
        <span className="sv-toolchip">Browser</span>
      </div>
      <div className="sv-body">
        <div className="sv-main">
          <div className="sv-mode-line"><span className="sv-mode">MOCKUP</span><span className="sv-keel" /></div>
          <div className="sv-chips"><span className="sv-chip sv-on">Inspect</span><span className="sv-chip">Sketch</span><span className="sv-chip">Region</span></div>
          <div className="sv-framed">
            <span className="sv-frame-tag">PAGE UNDER REVIEW</span>
            <div className="sv-form">
              <div className="sv-mock-h" />
              <div className="sv-mock-field" />
              <div className="sv-mock-field" />
              <div className="sv-mock-btn" />
            </div>
            <span className="sv-pin">1</span>
            <div className="sv-note">
              <div className="sv-note-who">Your note · #1</div>
              <div className="sv-note-txt">The button feels cramped against the fields.</div>
              <div className="sv-abc"><span className="sv-pick">A · more gap</span><span>B · full width</span><span>C · move right</span></div>
            </div>
          </div>
        </div>
        <div className="sv-panel">
          <div className="sv-pn-h">NEEDS YOU (2)</div>
          <div className="sv-pn-row" />
          <div className="sv-pn-row" />
          <div className="sv-pn-h sv-pn-dim">WITH THE AGENT</div>
          <div className="sv-pn-row sv-pn-faint" />
        </div>
      </div>
    </div>
  )
}

function WatchdogVignette() {
  return (
    <div className="sv-term" aria-hidden data-ux-id="showcase-art-watchdog">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-term-body">
        <div className="sv-tline sv-dim">&gt; refactoring src/pipeline/ingest.ts …</div>
        <div className="sv-tline sv-dim">&gt; 14 files changed, tests green</div>
        <div className="sv-banner">You&apos;ve hit your usage limit. Resets at 3:00 PM.</div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Watchdog: waiting 42 min, retry 1 of 3</div>
        <div className="sv-typed">&gt; continue where you left off<span className="sv-caret" /></div>
      </div>
    </div>
  )
}

function OneRowVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-oneRow">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-term-lines">
        <div>&gt; claude …</div>
        <div className="sv-dim">&gt; working…</div>
      </div>
      <div className="sv-toolrow sv-toolrow-bar">
        <span className="sv-toolchip">+ Add</span>
        <span className="sv-toolchip">Snap</span>
        <span className="sv-toolchip">Canvas</span>
        <span className="sv-toolchip">Logs</span>
        <span className="sv-toolchip">Browser</span>
        <span className="sv-sep" />
        <span className="sv-toolchip sv-blue">build</span>
        <span className="sv-toolchip sv-green">test</span>
        <span className="sv-sep" />
        <span className="sv-toolchip sv-peach">deploy</span>
        <span className="sv-toolchip">3 more</span>
      </div>
    </div>
  )
}

function PanelVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-panel">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-chips"><span className="sv-chip">Saved 23</span><span className="sv-chip sv-on">Running 3</span></div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          Orchid
          <span className="sv-qs-count">1</span>
          <span className="sv-chip sv-on sv-qs-start">▸ Start</span>
        </div>
        <div className="sv-pn-h sv-pn-neutral">Active sessions</div>
        <div className="sv-pn-row" />
        <div className="sv-pn-row" />
        <div className="sv-pn-row sv-pn-faint" />
      </div>
    </div>
  )
}

function AccountsVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-accounts">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Accounts</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--ob)' }} />work<span className="sv-meter"><i style={{ width: '62%' }} /></span>62%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-warning)' }} />personal<span className="sv-meter"><i style={{ width: '28%' }} /></span>28%</div>
        <div className="sv-acct"><span className="sv-acct-dot" style={{ background: 'var(--status-success)' }} />team<span className="sv-meter"><i style={{ width: '9%' }} /></span>9%</div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Switched account — the session kept going</div>
      </div>
    </div>
  )
}

function MultiSpawnVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-multiSpawn">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-chips"><span className="sv-chip sv-on">Saved 23</span><span className="sv-chip">Select</span></div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          Orchid
          <span className="sv-qs-count">3</span>
          <span className="sv-chip sv-on sv-qs-start">▸ ×3</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          Ingest
          <span className="sv-qs-count">1</span>
          <span className="sv-chip sv-qs-start">▸</span>
        </div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> Ingest is already running — enable Multi Spawn &amp; launch?</div>
      </div>
    </div>
  )
}

function RemoteResumeVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-remoteResume">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Active sessions</div>
        <div className="sv-pn-row" />
        <div className="sv-pn-row" />
        <div className="sv-pn-h sv-pn-dim">Remote Resumable 2</div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          build-box
          <span className="sv-chip sv-green sv-qs-start">Resumable</span>
        </div>
        <div className="sv-qs sv-dim">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          rack-pi
          <span className="sv-chip sv-peach sv-qs-start">Unreachable</span>
        </div>
        <div className="sv-wd-chip"><span className="sv-wd-dot" /> you@build-box · left 2h ago</div>
      </div>
    </div>
  )
}

function SidebarMarksVignette() {
  return (
    <div className="sv-mini" aria-hidden data-ux-id="showcase-art-sidebarMarks">
      <div className="sv-tb"><span className="sv-tl" /><span className="sv-tl" /><span className="sv-tl" /></div>
      <div className="sv-panel-body">
        <div className="sv-pn-h sv-pn-neutral">Saved</div>
        <div className="sv-qs">
          <span className="sv-qs-dot" />
          api
          <span className="sv-chip sv-blue sv-qs-start">SSH</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-success)' }} />
          build-box
          <span className="sv-chip sv-green sv-qs-start">SSH persistent</span>
        </div>
        <div className="sv-qs">
          <span className="sv-qs-dot" style={{ background: 'var(--status-warning)' }} />
          sandbox
          <span className="sv-chip sv-teal sv-qs-start">container</span>
        </div>
        <div className="sv-pn-h sv-pn-dim">Ungrouped</div>
        <div className="sv-pn-row" />
      </div>
    </div>
  )
}

export function ShowcaseVignette({ kind }: { kind: ShowcaseArtKind }) {
  if (kind === 'canvas') return <CanvasVignette />
  if (kind === 'watchdog') return <WatchdogVignette />
  if (kind === 'panel') return <PanelVignette />
  if (kind === 'accounts') return <AccountsVignette />
  if (kind === 'multiSpawn') return <MultiSpawnVignette />
  if (kind === 'remoteResume') return <RemoteResumeVignette />
  if (kind === 'sidebarMarks') return <SidebarMarksVignette />
  return <OneRowVignette />
}
