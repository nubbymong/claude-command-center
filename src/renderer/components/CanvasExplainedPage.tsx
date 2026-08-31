import React from 'react'

/**
 * Canvas Explained (M4, W33/W46) — the full-page explainer the front page's
 * "Canvas Explained" card opens.
 *
 * Built from the approved v3 mock (.ccc-canvas/canvas-explained.html) as REAL
 * layout, not a scaled screenshot of it: prose and object cards are DOM on a
 * 4px rhythm; only the genuinely diagrammatic parts (version rail, the three
 * loops) are inline SVG. Each diagram exists in two orientations — horizontal
 * for a wide pane, stacked for a narrow one — because a single wide viewBox
 * scaled into a 320px pane renders its labels at ~5px, which fails the "must
 * read at 320px" bar the mock itself was called out on. The swap is a
 * container query against THIS page's own scroll body (`@container/cxp`), not
 * the viewport: the canvas pane is user-resizable and docks beside the
 * terminal, so viewport breakpoints would lie (same reasoning as
 * `.canvas-stage` in styles.css).
 *
 * Everything is drawn with app tokens (var(--color-*)/surface/status), so both
 * themes work without a single hex; SVG text inherits the app font. The page
 * is self-contained by design — styles.css is not touched (that file is
 * builder F1's surface in this milestone).
 */

interface Props {
  /** Returns to the canvas front page. The mounting chrome owns pane close. */
  onHome: () => void
}

/** JetBrains Mono ships with the app but Tailwind's `font-mono` resolves to
 *  the generic stack, so mono is named explicitly — same as sibling canvas
 *  components. */
const MONO = "'JetBrains Mono', ui-monospace, monospace"

/* Token shorthands: one place to retune the whole page's palette. */
const T_PRIMARY = 'var(--text-primary)'
const T_SECONDARY = 'var(--text-secondary)'
const T_MUTED = 'var(--text-muted)'
const OK = 'var(--status-success)'
const BAD = 'var(--status-danger)'
const BOX = 'var(--surface-sunken)'
const BORDER = 'var(--border-strong)'
/** The approved end-state gets a faint success wash, like the mock's #14231c. */
const APPROVED_FILL = 'color-mix(in srgb, var(--status-success) 8%, var(--surface-sunken))'

type Tone = 'blue' | 'mauve' | 'green' | 'peach'
const STROKE: Record<Tone, string> = {
  blue: 'var(--color-blue)',
  mauve: 'var(--color-mauve)',
  green: 'var(--color-green)',
  peach: 'var(--color-peach)',
}

/* Arrowheads as stroked paths rather than <marker> defs: markers need
 * document-unique ids and every diagram here renders twice (wide + narrow),
 * so id bookkeeping would be the only thing markers bought. Each helper
 * returns a `M …` fragment that concatenates onto the shaft's path. */
const headRight = (x: number, y: number): string => `M ${x - 6} ${y - 3.5} L ${x} ${y} L ${x - 6} ${y + 3.5}`
const headDown = (x: number, y: number): string => `M ${x - 3.5} ${y - 6} L ${x} ${y} L ${x + 3.5} ${y - 6}`
const headUp = (x: number, y: number): string => `M ${x - 3.5} ${y + 6} L ${x} ${y} L ${x + 3.5} ${y + 6}`

/* ── Flow diagrams (the three mode loops) ─────────────────────────────── */

interface FlowNode {
  /** Width in the WIDE orientation's viewBox units (narrow uses one width). */
  w: number
  tone: Tone
  fill?: string
  title: string
  lines: string[]
}

interface FlowSpec {
  aria: string
  nodes: FlowNode[]
  /** arrows[i] joins nodes[i] → nodes[i+1]; `ok` draws it in success green. */
  arrows: Array<{ label?: string; ok?: boolean }>
  /** The rework loop: an arc from the review node (index 1) back to node 0.
   *  Its label is the mode's own word for sending a version back -- "Reject"
   *  on a mockup, "Submit Revisions" on a plan -- drawn in the same tone
   *  either way, because the app deliberately paints REVISIONS the same red as
   *  a rejection rather than implying a plan has a third outcome. */
  reject?: string
  /** Testing only: the pack stack the verdict feeds into. */
  pack?: { title: string; lines: string[] }
  gap?: number
}

const nodeH = (n: FlowNode): number => 46 + 14 * n.lines.length

/** One flow box. `w` is passed separately so the narrow variant can restate
 *  every node at a single stacked width. */
function NodeBox({ x, y, w, n }: { x: number; y: number; w: number; n: FlowNode }) {
  const cx = x + w / 2
  return (
    <g>
      <rect x={x} y={y} width={w} height={nodeH(n)} rx={11} fill={n.fill ?? BOX} stroke={STROKE[n.tone]} strokeWidth={1.4} />
      <text x={cx} y={y + 24} textAnchor="middle" fill={T_PRIMARY} fontSize={13} fontWeight={650}>
        {n.title}
      </text>
      {n.lines.map((line, i) => (
        <text key={line} x={cx} y={y + 42 + i * 14} textAnchor="middle" fill={T_SECONDARY} fontSize={10.5}>
          {line}
        </text>
      ))}
    </g>
  )
}

/** The pack stack: two offset cards, because the pack is a THING notes land
 *  in, not another process step — same visual argument the mock makes. */
function PackStack({ x, y, pack }: { x: number; y: number; pack: { title: string; lines: string[] } }) {
  return (
    <g>
      <rect
        x={x + 6}
        y={y + 5}
        width={54}
        height={40}
        rx={7}
        fill="var(--surface-raised)"
        stroke={BORDER}
        strokeWidth={1.2}
        transform={`rotate(3 ${x + 33} ${y + 25})`}
      />
      <rect x={x} y={y} width={54} height={40} rx={7} fill={BOX} stroke={BORDER} strokeWidth={1.2} />
      <text x={x + 70} y={y + 13} fill={T_SECONDARY} fontSize={11} fontWeight={650}>
        {pack.title}
      </text>
      {pack.lines.map((line, i) => (
        <text key={line} x={x + 70} y={y + 27 + i * 12} fill={T_MUTED} fontSize={9.5}>
          {line}
        </text>
      ))}
    </g>
  )
}

/** Horizontal orientation — shown from 576px of pane width up. */
function FlowWide({ spec }: { spec: FlowSpec }) {
  const M = 6
  const gap = spec.gap ?? 80
  const heights = spec.nodes.map(nodeH)
  const maxH = Math.max(...heights)
  const topPad = spec.arrows.some((a) => a.label) ? 22 : 8
  const midY = topPad + maxH / 2
  const xs: number[] = []
  let cursor = M
  for (const n of spec.nodes) {
    xs.push(cursor)
    cursor += n.w + gap
  }
  const last = spec.nodes.length - 1
  const lastRight = xs[last] + spec.nodes[last].w
  const packX = lastRight + 56
  const width = (spec.pack ? packX + 60 + 104 : lastRight) + M
  const height = topPad + maxH + (spec.reject ? 54 : 8)
  const y = (i: number): number => midY - heights[i] / 2

  const cx0 = xs[0] + spec.nodes[0].w / 2
  const cx1 = xs[1] + spec.nodes[1].w / 2
  const arcY = topPad + maxH + 40

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={spec.aria} className="mt-2 hidden h-auto w-full @xl/cxp:block">
      {spec.nodes.map((n, i) => (
        <NodeBox key={n.title} x={xs[i]} y={y(i)} w={n.w} n={n} />
      ))}
      {spec.arrows.map((a, i) => {
        const x1 = xs[i] + spec.nodes[i].w + 4
        const x2 = xs[i + 1] - 5
        const tone = a.ok ? OK : T_MUTED
        return (
          <g key={spec.nodes[i].title}>
            <path
              d={`M ${x1} ${midY} H ${x2} ${headRight(x2, midY)}`}
              fill="none"
              stroke={tone}
              strokeWidth={a.ok ? 1.8 : 1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {a.label && (
              <text x={(x1 + x2) / 2} y={midY - 10} textAnchor="middle" fill={tone} fontSize={10.5} fontWeight={650}>
                {a.label}
              </text>
            )}
          </g>
        )
      })}
      {spec.pack && (
        <g>
          <path
            d={`M ${lastRight + 4} ${midY} H ${packX - 6} ${headRight(packX - 6, midY)}`}
            fill="none"
            stroke={OK}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <PackStack x={packX} y={midY - 20} pack={spec.pack} />
        </g>
      )}
      {spec.reject && (
        <g>
          <path
            d={`M ${cx1} ${y(1) + heights[1] + 3} V ${arcY - 10} Q ${cx1} ${arcY} ${cx1 - 10} ${arcY} H ${cx0 + 10} Q ${cx0} ${arcY} ${cx0} ${arcY - 10} V ${y(0) + heights[0] + 8} ${headUp(cx0, y(0) + heights[0] + 6)}`}
            fill="none"
            stroke={BAD}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x={(cx0 + cx1) / 2} y={arcY - 7} textAnchor="middle" fill={BAD} fontSize={11} fontWeight={650}>
            {spec.reject}
          </text>
        </g>
      )}
    </svg>
  )
}

/** Stacked orientation for narrow panes. Same data, one node width; the
 *  reject arc runs up the left channel with its (long) label set as a legend
 *  line at the bottom, in the arc's own colour — rotated label text is the
 *  alternative and it does not read. */
function FlowNarrow({ spec }: { spec: FlowSpec }) {
  const W = 320
  const NW = 236
  const NX = spec.reject ? 56 : 42
  const cx = NX + NW / 2
  const heights = spec.nodes.map(nodeH)
  const ys: number[] = []
  let yc = 6
  spec.nodes.forEach((_, i) => {
    ys.push(yc)
    yc += heights[i]
    if (i < spec.nodes.length - 1) yc += spec.arrows[i]?.label ? 46 : 36
  })
  let bottom = yc
  let packY = 0
  if (spec.pack) {
    packY = bottom + 34
    bottom = packY + 46
  }
  let legendY = 0
  if (spec.reject) {
    legendY = bottom + 16
    bottom = legendY + 6
  }
  const height = bottom + 2
  const mid0 = ys[0] + heights[0] / 2
  const mid1 = ys[1] + heights[1] / 2

  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={spec.aria} className="mx-auto mt-2 block h-auto w-full max-w-[380px] @xl/cxp:hidden">
      {spec.nodes.map((n, i) => (
        <NodeBox key={n.title} x={NX} y={ys[i]} w={NW} n={n} />
      ))}
      {spec.arrows.map((a, i) => {
        const topY = ys[i] + heights[i] + 3
        const botY = ys[i + 1] - 5
        const tone = a.ok ? OK : T_MUTED
        return (
          <g key={spec.nodes[i].title}>
            <path
              d={`M ${cx} ${topY} V ${botY} ${headDown(cx, botY + 1)}`}
              fill="none"
              stroke={tone}
              strokeWidth={a.ok ? 1.8 : 1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {a.label && (
              <text x={cx + 12} y={(topY + botY) / 2 + 3.5} fill={tone} fontSize={10.5} fontWeight={650}>
                {a.label}
              </text>
            )}
          </g>
        )
      })}
      {spec.pack && (
        <g>
          <path
            d={`M ${cx} ${ys[ys.length - 1] + heights[heights.length - 1] + 3} V ${packY - 6} ${headDown(cx, packY - 5)}`}
            fill="none"
            stroke={OK}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <PackStack x={NX + 24} y={packY} pack={spec.pack} />
        </g>
      )}
      {spec.reject && (
        <g>
          <path
            d={`M ${NX} ${mid1} H 26 Q 18 ${mid1} 18 ${mid1 - 10} V ${mid0 + 10} Q 18 ${mid0} 26 ${mid0} H ${NX - 7} ${headRight(NX - 5, mid0)}`}
            fill="none"
            stroke={BAD}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x={18} y={legendY} fill={BAD} fontSize={10.5} fontWeight={650}>
            {spec.reject}
          </text>
        </g>
      )}
    </svg>
  )
}

/* ── The three mode loops, as data ────────────────────────────────────── */

const MOCKUP_FLOW: FlowSpec = {
  aria: 'Mockup loop: the agent shows v1, you review it with notes, drawings and images; approving a version approves the artefact and earlier rounds settle, while rejecting it makes your notes drive the next version.',
  nodes: [
    { w: 196, tone: 'blue', title: 'Agent shows v1', lines: ['then v2, v3 … one open at a time'] },
    { w: 196, tone: 'peach', title: 'You review it', lines: ['notes · drawings · images'] },
    { w: 196, tone: 'green', fill: APPROVED_FILL, title: 'Artefact approved', lines: ['earlier rounds settle · Library'] },
  ],
  arrows: [{}, { label: 'Approve vN', ok: true }],
  reject: 'Reject vN — your notes drive v(N+1)',
}

// A plan has NO Reject: it is iterative, so the back arc is Submit Revisions
// and the loop is the normal outcome of a first round rather than a failure.
// Approve is held back while the plan carries an open question, or while a
// note is still unsent, so an approval never arrives carrying work.
const PLAN_FLOW: FlowSpec = {
  aria: 'Plan loop: the agent posts plan v1 as steps you can point at; you review the steps, noting one and answering its open questions. There is no Reject on a plan: you submit revisions, and plan v2 answers your notes. Approving starts the work, and Approve stays unavailable while any question is still open or a note is unsent.',
  nodes: [
    { w: 196, tone: 'mauve', title: 'Agent posts plan v1', lines: ['steps you can point at'] },
    {
      w: 196,
      tone: 'peach',
      title: 'You review the steps',
      lines: ['note a step · answer its questions', 'Approve blocked while one is open'],
    },
    { w: 196, tone: 'green', fill: APPROVED_FILL, title: 'Work starts', lines: ['plan one click away on Home'] },
  ],
  arrows: [{}, { label: 'Approve', ok: true }],
  reject: 'Submit Revisions — v2 answers your notes',
}

const TESTING_FLOW: FlowSpec = {
  aria: 'Testing flow: the agent serves the build and you click through it live, saving as many notes as you need; you give one pass or fail verdict per build, and the notes collect into a test pack named by you or automatically.',
  gap: 54,
  nodes: [
    { w: 176, tone: 'green', title: 'Agent serves build 5', lines: ['you click through it live'] },
    { w: 190, tone: 'peach', title: 'You save a note', lines: ['site paused while you write', '× as many moments as you need'] },
    { w: 136, tone: 'blue', title: 'Pass / Fail', lines: ['one verdict per build'] },
  ],
  arrows: [{}, {}],
  pack: { title: 'test pack', lines: ['your name, or', 'auto-named'] },
}

/* ── The artefact version rail (anatomy) ──────────────────────────────── */

const RAIL_ARIA =
  'Version rail: v1 rejected, the agent revises to v2, rejected again, revised to v3, approved and signed off into the Library.'

/** Verdict chip inside a rail node — the app's own badge recipe (tinted wash
 *  plus toned text) rather than the mock's solid fills, so it survives both
 *  themes and matches the chips the Library actually renders. */
function VerdictChip({ cx, y, label, tone }: { cx: number; y: number; label: string; tone: string }) {
  return (
    <g>
      <rect
        x={cx - 38}
        y={y}
        width={76}
        height={16}
        rx={4}
        fill={`color-mix(in srgb, ${tone} 16%, transparent)`}
        stroke={`color-mix(in srgb, ${tone} 55%, transparent)`}
        strokeWidth={1}
      />
      <text x={cx} y={y + 11.5} textAnchor="middle" fill={tone} fontSize={9} fontWeight={800} letterSpacing="0.06em">
        {label}
      </text>
    </g>
  )
}

function RailNode({ x, y, w, version, verdict }: { x: number; y: number; w: number; version: string; verdict: 'rejected' | 'approved' }) {
  const cx = x + w / 2
  const tone = verdict === 'approved' ? OK : BAD
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={56}
        rx={10}
        fill={verdict === 'approved' ? APPROVED_FILL : BOX}
        stroke={tone}
        strokeWidth={verdict === 'approved' ? 1.6 : 1.4}
      />
      <text x={cx} y={y + 21} textAnchor="middle" fill={T_PRIMARY} fontSize={13} fontWeight={650}>
        {version}
      </text>
      <VerdictChip cx={cx} y={y + 29} label={verdict === 'approved' ? 'APPROVED' : 'REJECTED'} tone={tone} />
    </g>
  )
}

function RailWide() {
  // xs: 140-wide nodes with 64 gaps; trailing green arrow into the Library.
  const xs = [6, 210, 414]
  const y = 8
  const midY = y + 28
  return (
    <svg viewBox="0 0 726 74" role="img" aria-label={RAIL_ARIA} className="mt-2 hidden h-auto w-full @xl/cxp:block">
      <RailNode x={xs[0]} y={y} w={140} version="v1" verdict="rejected" />
      <RailNode x={xs[1]} y={y} w={140} version="v2" verdict="rejected" />
      <RailNode x={xs[2]} y={y} w={140} version="v3" verdict="approved" />
      {[0, 1].map((i) => (
        <g key={i}>
          <path
            d={`M ${xs[i] + 144} ${midY} H ${xs[i + 1] - 5} ${headRight(xs[i + 1] - 5, midY)}`}
            fill="none"
            stroke={T_MUTED}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x={xs[i] + 172} y={midY - 8} textAnchor="middle" fill={T_MUTED} fontSize={10}>
            agent revises
          </text>
        </g>
      ))}
      <path
        d={`M 558 ${midY} H 612 ${headRight(612, midY)}`}
        fill="none"
        stroke={OK}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={624} y={midY - 2} fill={T_SECONDARY} fontSize={11} fontWeight={650}>
        → Library
      </text>
      <text x={624} y={midY + 13} fill={T_MUTED} fontSize={10}>
        signed off
      </text>
    </svg>
  )
}

function RailNarrow() {
  const NX = 60
  const cx = 160
  const ys = [6, 100, 194]
  return (
    <svg viewBox="0 0 320 306" role="img" aria-label={RAIL_ARIA} className="mx-auto mt-2 block h-auto w-full max-w-[380px] @xl/cxp:hidden">
      <RailNode x={NX} y={ys[0]} w={200} version="v1" verdict="rejected" />
      <RailNode x={NX} y={ys[1]} w={200} version="v2" verdict="rejected" />
      <RailNode x={NX} y={ys[2]} w={200} version="v3" verdict="approved" />
      {[0, 1].map((i) => (
        <g key={i}>
          <path
            d={`M ${cx} ${ys[i] + 59} V ${ys[i + 1] - 5} ${headDown(cx, ys[i + 1] - 4)}`}
            fill="none"
            stroke={T_MUTED}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x={cx + 12} y={(ys[i] + 56 + ys[i + 1]) / 2 + 5} fill={T_MUTED} fontSize={10}>
            agent revises
          </text>
        </g>
      ))}
      <path
        d={`M ${cx} 253 V 278 ${headDown(cx, 279)}`}
        fill="none"
        stroke={OK}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={cx} y={298} textAnchor="middle" fill={T_SECONDARY} fontSize={11} fontWeight={650}>
        → Library · signed off
      </text>
    </svg>
  )
}

/* ── DOM pieces of the anatomy ────────────────────────────────────────── */

/** A note's stored objects, drawn as OBJECTS (glyph first, words second) —
 *  the owner's rule: attachments are things the note holds, not text cards. */
function StoredObject({ glyph, name, caption }: { glyph: React.ReactNode; name: string; caption: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
      <svg viewBox="0 0 44 28" className="h-7 w-11 shrink-0" aria-hidden="true">
        {glyph}
      </svg>
      <div className="text-[12px] font-semibold leading-none text-[var(--text-primary)]">{name}</div>
      <p className="m-0 text-[11px] leading-[1.4] text-[var(--text-secondary)]">{caption}</p>
    </div>
  )
}

/** One cell of the Testing evidence record: content box above, caption below;
 *  the boxes stretch so the caption row stays on one aligned baseline. */
function EvidenceCell({ caption, bare, children }: { caption: string; bare?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {bare ? (
        <div className="flex flex-1 flex-col justify-start gap-2">{children}</div>
      ) : (
        <div className="flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-base)] p-3">{children}</div>
      )}
      <p className="m-0 text-[11px] leading-[1.4] text-[var(--text-secondary)]">{caption}</p>
    </div>
  )
}

/* ── Section shell ────────────────────────────────────────────────────── */

function Section({ id, tone, title, sub, children }: { id: string; tone: string; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 @xl/cxp:p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="m-0 text-[12px] font-bold uppercase leading-none tracking-[0.04em]" style={{ color: tone }}>
          {title}
        </h2>
        <span className="text-[12px] text-[var(--text-secondary)]">{sub}</span>
      </div>
      {children}
    </section>
  )
}

/* ── The page ─────────────────────────────────────────────────────────── */

// Default export: the component is this file's sole export, which is the one
// case repo convention allows it — and it is how every mounted canvas pane
// sibling (CanvasEmptyState, CanvasQueuePopover, …) is consumed by F1's code.
export default function CanvasExplainedPage({ onHome }: Props): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-[var(--surface-stage)]" data-testid="canvas-explained-page">
      {/* Sticky, not merely shrink-0: the front page mounts this inside its own
          scrolling stage div, so the header must pin itself rather than rely on
          owning the scroll container. Works identically when it does own it. */}
      <header className="sticky top-0 z-10 flex h-[44px] shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-chrome)] px-4">
        <button
          type="button"
          onClick={onHome}
          data-testid="canvas-explained-home"
          aria-label="Back to the canvas home page"
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-ring"
        >
          <span aria-hidden="true">‹</span>
          <span>Home</span>
        </button>
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">Canvas Explained</span>
      </header>

      {/* The scroll body is the query container: every "wide vs stacked"
          decision below answers to this element's width, i.e. the pane's. */}
      <div className="min-h-0 flex-1 overflow-y-auto @container/cxp">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 py-6 @xl/cxp:px-6">
          <div>
            <h1
              className="m-0 pb-1 text-[24px] font-extrabold leading-[1.25] tracking-[-0.02em]"
              style={{
                // The rename page's `.rn-name` gradient recipe (also the front
                // page wordmark), restated inline because this file owns no
                // styles.css section. pb-1 keeps descenders out of the clip box.
                background:
                  'linear-gradient(100deg, var(--text-primary) 30%, color-mix(in srgb, var(--brand) 55%, var(--text-primary)) 75%, var(--brand))',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              How the Canvas works
            </h1>
            <p className="m-0 mt-1 max-w-[66ch] text-[13px] leading-[1.55] text-[var(--text-secondary)]">
              The agent puts an <strong className="font-semibold text-[var(--text-primary)]">artefact</strong> on the canvas — a mockup, a
              plan, or a test pack. Every revision is a new <strong className="font-semibold text-[var(--text-primary)]">version</strong>;
              your reviews and everything attached to them are stored on the version they were made against. This page shows what is stored
              and how it moves.
            </p>
          </div>

          {/* THE ARTEFACT — versions, one review, and what a note stores. */}
          <Section id="cxp-artefact" tone="var(--color-peach)" title="The artefact" sub="versions increment; each review and its objects are stored on its version">
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] p-3 @xl/cxp:p-4">
              <p className="m-0 text-[10px] font-medium tracking-[0.1em] text-[var(--text-secondary)]" style={{ fontFamily: MONO }}>
                {'ARTEFACT · “Login page mockup”'}
              </p>
              <RailWide />
              <RailNarrow />
            </div>

            {/* The review hangs off v1 — leftmost in the wide rail, topmost in
                the narrow one, so a left-aligned connector reads in both. */}
            <div className="mb-1 mt-3 flex items-center gap-2" style={{ color: 'var(--color-peach)' }}>
              <svg viewBox="0 0 12 24" className="h-6 w-3 shrink-0" aria-hidden="true">
                <path d={`M 6 1 V 18 ${headDown(6, 21)}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[11px] font-medium">your review of v1</span>
            </div>

            <div className="grid gap-3 @2xl/cxp:grid-cols-[236px_44px_minmax(0,1fr)] @2xl/cxp:items-start">
              <div className="flex flex-col gap-2 rounded-[11px] border bg-[var(--surface-sunken)] p-3" style={{ borderColor: 'var(--color-peach)' }}>
                <div className="text-[12px] font-bold text-[var(--text-primary)]">Review #1 · Rejected</div>
                <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-base)] px-3 py-2">
                  <div className="text-[11px] text-[var(--text-secondary)]">“logo is the wrong blue”</div>
                  <div className="mt-1 text-[9.5px] text-[var(--text-muted)]" style={{ fontFamily: MONO }}>
                    NOTE · anchored
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-base)] px-3 py-2">
                  <div className="text-[11px] text-[var(--text-secondary)]">“tighten this spacing”</div>
                  <div className="mt-1 text-[9.5px] text-[var(--text-muted)]" style={{ fontFamily: MONO }}>
                    NOTE · region
                  </div>
                </div>
              </div>

              <div className="text-[var(--text-muted)]">
                <div className="hidden flex-col items-center gap-1 pt-8 @2xl/cxp:flex">
                  <span className="text-[10px]">stores</span>
                  <svg viewBox="0 0 28 12" className="h-3 w-7" aria-hidden="true">
                    <path d={`M 2 6 H 24 ${headRight(24, 6)}`} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="flex items-center gap-2 @2xl/cxp:hidden">
                  <svg viewBox="0 0 12 24" className="h-6 w-3 shrink-0" aria-hidden="true">
                    <path d={`M 6 1 V 18 ${headDown(6, 21)}`} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[11px]">stores</span>
                </div>
              </div>

              <div className="grid min-w-0 grid-cols-2 gap-2 @3xl/cxp:grid-cols-4">
                <StoredObject
                  name="anchor"
                  caption="the element or region you chose"
                  glyph={
                    <g stroke="var(--color-blue)" strokeWidth={1.5} fill="none" strokeLinecap="round">
                      <circle cx={14} cy={14} r={8} />
                      <path d="M14 2v5M14 21v5M2 14h5M21 14h5" />
                    </g>
                  }
                />
                <StoredObject
                  name="drawing"
                  caption="your marks over the screen"
                  glyph={<ellipse cx={16} cy={14} rx={13} ry={8} fill="none" stroke="var(--color-red)" strokeWidth={1.8} transform="rotate(-8 16 14)" />}
                />
                <StoredObject
                  name="images"
                  caption="pasted with Ctrl+V, inline: Image 1, 2…"
                  glyph={
                    <g>
                      <rect x={3} y={3} width={22} height={16} rx={3} fill="var(--surface-raised)" stroke={BORDER} strokeWidth={1} />
                      <rect x={11} y={9} width={22} height={16} rx={3} fill="var(--surface-overlay)" stroke={BORDER} strokeWidth={1} />
                    </g>
                  }
                />
                <StoredObject
                  name="your words"
                  caption="the note itself, in your voice"
                  glyph={
                    <g stroke="var(--text-secondary)" strokeWidth={1.6} strokeLinecap="round">
                      <path d="M4 7h30M4 14h23M4 21h27" />
                    </g>
                  }
                />
              </div>
            </div>

            {/* The storage guarantee, then the two W46 terms IN PLACE — the
                spec forbids a glossary section, so they live where they apply. */}
            <p className="m-0 mt-3 max-w-[76ch] text-[12px] leading-[1.55] text-[var(--text-secondary)]">
              Every object is stored on the note, on its version.{' '}
              <span className="font-medium text-[var(--text-primary)]">Rejecting a version never loses them</span>: the agent reads them to
              build the next one, and History keeps the whole trail. A note reads{' '}
              <strong className="font-semibold text-[var(--text-primary)]">resolved</strong> once the agent has acted on it. A review reads{' '}
              <strong className="font-semibold text-[var(--text-primary)]">settled</strong> once every note in it is closed.
            </p>
          </Section>

          <Section id="cxp-mockup" tone="var(--color-blue)" title="Mockup" sub="v1 → your review → v2 → … until you approve">
            <FlowWide spec={MOCKUP_FLOW} />
            <FlowNarrow spec={MOCKUP_FLOW} />
          </Section>

          <Section id="cxp-plan" tone="var(--color-mauve)" title="Plan" sub="same machine — the versions are drafts of the plan">
            <FlowWide spec={PLAN_FLOW} />
            <FlowNarrow spec={PLAN_FLOW} />
          </Section>

          <Section id="cxp-testing" tone="var(--color-green)" title="Testing" sub="one build under test — what one saved note stores">
            <FlowWide spec={TESTING_FLOW} />
            <FlowNarrow spec={TESTING_FLOW} />

            <div className="my-1 flex justify-center" style={{ color: 'var(--color-peach)' }}>
              <svg viewBox="0 0 12 22" className="h-5 w-3" aria-hidden="true">
                <path d={`M 6 1 V 16 ${headDown(6, 19)}`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <div
              className="rounded-xl border border-dashed p-3 @xl/cxp:p-4"
              style={{ borderColor: 'color-mix(in srgb, var(--status-success) 45%, transparent)' }}
              data-testid="canvas-explained-evidence"
            >
              <p className="m-0 mb-3 text-[10px] font-medium tracking-[0.1em]" style={{ fontFamily: MONO, color: 'var(--status-success)' }}>
                ONE SAVED NOTE — LOCKED TOGETHER AS EVIDENCE
              </p>
              <div className="grid grid-cols-1 gap-3 @md/cxp:grid-cols-2 @3xl/cxp:grid-cols-[1.1fr_0.9fr_1.3fr_0.8fr_0.7fr]">
                <EvidenceCell caption="screenshot + your drawings">
                  <svg viewBox="0 0 128 88" className="h-auto w-full" aria-hidden="true">
                    <rect x={4} y={4} width={70} height={9} rx={4} fill="var(--surface-overlay)" />
                    <rect x={4} y={21} width={120} height={48} rx={6} fill="var(--surface-raised)" />
                    <ellipse cx={88} cy={45} rx={26} ry={14} fill="none" stroke="var(--color-red)" strokeWidth={2.4} transform="rotate(-4 88 45)" />
                  </svg>
                </EvidenceCell>
                <EvidenceCell caption="page state — never what you typed" bare>
                  {['route /checkout', 'dialog open', '2 fields filled'].map((chip) => (
                    <span
                      key={chip}
                      className="inline-block self-start rounded-md border border-[var(--border-strong)] bg-[var(--surface-base)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)]"
                      style={{ fontFamily: MONO }}
                    >
                      {chip}
                    </span>
                  ))}
                </EvidenceCell>
                <EvidenceCell caption="how you got here — actions + timing">
                  <div className="flex flex-col gap-1 text-[10.5px] leading-[1.5] text-[var(--text-secondary)]" style={{ fontFamily: MONO }}>
                    <span>{'16:43:58 click “Checkout”'}</span>
                    <span>16:44:01 typed into Email</span>
                    <span>16:44:02 note saved ●</span>
                  </div>
                </EvidenceCell>
                <EvidenceCell caption="your words">
                  <svg viewBox="0 0 90 40" className="h-auto w-full max-w-[90px]" aria-hidden="true">
                    <g stroke="var(--text-secondary)" strokeWidth={1.6} strokeLinecap="round">
                      <path d="M4 8h70M4 20h54M4 32h62" />
                    </g>
                  </svg>
                </EvidenceCell>
                <EvidenceCell caption="Image 1, 2…">
                  <svg viewBox="0 0 90 52" className="h-auto w-full max-w-[90px]" aria-hidden="true">
                    <rect x={4} y={4} width={46} height={32} rx={4} fill="var(--surface-raised)" stroke={BORDER} strokeWidth={1} />
                    <rect x={18} y={14} width={46} height={32} rx={4} fill="var(--surface-overlay)" stroke={BORDER} strokeWidth={1} />
                  </svg>
                </EvidenceCell>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
