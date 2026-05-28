// src/renderer/components/insights/parseInsightsReport.ts
// Parse insights-job HTML into a structured tree the renderer can map onto V2
// React components. Uses DOMParser (available in jsdom + renderer). Each known
// section type maps to a discriminated shape; unknown sections are dropped.

export type InsightsSection =
  | { kind: 'at-a-glance'; title: string; body: string }
  | { kind: 'narrative'; title: string; paragraphs: string[] }
  | { kind: 'big-wins'; items: Array<{ title: string; desc: string }> }
  | { kind: 'friction'; items: Array<{ title: string; desc: string }> }
  | { kind: 'features'; items: Array<{ title: string; oneliner: string; why: string }> }
  | { kind: 'patterns'; items: Array<{ title: string; summary: string; detail: string }> }
  | { kind: 'horizon'; title: string; body: string }

export interface ParsedInsights {
  title: string
  subtitle: string
  sections: InsightsSection[]
}

function txt(el: Element | null): string {
  return (el?.textContent || '').trim()
}

export function parseInsightsReport(html: string): ParsedInsights {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const title = txt(doc.querySelector('h1'))
  const subtitle = txt(doc.querySelector('.subtitle'))
  const sections: InsightsSection[] = []

  const glance = doc.querySelector('.at-a-glance')
  if (glance) sections.push({ kind: 'at-a-glance', title: txt(glance.querySelector('h2')), body: txt(glance.querySelector('.glance-section')) })

  const narrative = doc.querySelector('.narrative')
  if (narrative) sections.push({
    kind: 'narrative',
    title: txt(narrative.querySelector('h2')),
    paragraphs: Array.from(narrative.querySelectorAll('p')).map(p => txt(p)),
  })

  const wins = Array.from(doc.querySelectorAll('.big-win'))
  if (wins.length) sections.push({
    kind: 'big-wins',
    items: wins.map(w => ({ title: txt(w.querySelector('.big-win-title')), desc: txt(w.querySelector('.big-win-desc')) })),
  })

  const fric = Array.from(doc.querySelectorAll('.friction-category'))
  if (fric.length) sections.push({
    kind: 'friction',
    items: fric.map(f => ({ title: txt(f.querySelector('.friction-title')), desc: txt(f.querySelector('.friction-desc')) })),
  })

  const feats = Array.from(doc.querySelectorAll('.feature-card'))
  if (feats.length) sections.push({
    kind: 'features',
    items: feats.map(f => ({
      title: txt(f.querySelector('.feature-title')),
      oneliner: txt(f.querySelector('.feature-oneliner')),
      why: txt(f.querySelector('.feature-why')),
    })),
  })

  const pats = Array.from(doc.querySelectorAll('.pattern-card'))
  if (pats.length) sections.push({
    kind: 'patterns',
    items: pats.map(p => ({
      title: txt(p.querySelector('.pattern-title')),
      summary: txt(p.querySelector('.pattern-summary')),
      detail: txt(p.querySelector('.pattern-detail')),
    })),
  })

  const horizon = doc.querySelector('.horizon-card')
  if (horizon) sections.push({
    kind: 'horizon',
    title: txt(horizon.querySelector('.horizon-title')),
    body: txt(horizon.querySelector('.horizon-possible')),
  })

  return { title, subtitle, sections }
}
