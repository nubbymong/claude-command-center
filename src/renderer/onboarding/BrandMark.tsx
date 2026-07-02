// The brand starburst — 18 radial lines, lifted verbatim from the mockup's `burst()`
// (docs/superpowers/mockups/2026-06-30-onboarding-flow.html). Deterministic, so the
// coordinates are computed once at module load and match the mockup exactly.
// Stroke colour/width/caps come from CSS (`.ob-root .mark line` / `.ob-root .blogo line`).

const N = 18
const INNER = 6.5
const LENGTHS = [31, 18, 27, 16, 30, 20, 25, 17, 32, 18, 26, 16, 29, 21, 24, 18, 30, 19]

const LINES = Array.from({ length: N }, (_, i) => {
  const a = (i / N) * 2 * Math.PI - Math.PI / 2
  const l = LENGTHS[i % LENGTHS.length]
  return {
    x1: +(50 + Math.cos(a) * INNER).toFixed(1),
    y1: +(50 + Math.sin(a) * INNER).toFixed(1),
    x2: +(50 + Math.cos(a) * l).toFixed(1),
    y2: +(50 + Math.sin(a) * l).toFixed(1),
  }
})

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      {LINES.map((ln, i) => (
        <line key={i} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} />
      ))}
    </svg>
  )
}
