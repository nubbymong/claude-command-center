// src/main/channel-envelope.ts
import type { ChannelPayload, ChannelEnvelopeMeta } from '../shared/channel-types'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
// Bounds the rendered BODY only; the bracketed-paste escapes + header + footer add a small fixed overhead, so the wire envelope is slightly larger.
export const BODY_CAP = 8 * 1024

// Renders the human-readable body for each payload kind.
export function renderBody(p: ChannelPayload): string {
  switch (p.kind) {
    case 'github-pr':
      return `PR #${p.number}: ${p.title}\n${p.url}${p.ciStatus ? `\nCI: ${p.ciStatus}` : ''}${p.logTail ? `\n---\n${p.logTail}` : ''}`
    case 'vision-screenshot':
      return `[image: ${p.path ?? '(pending attachment)'}]${p.caption ? `\n${p.caption}` : ''}`
    case 'tokenomics-anomaly':
      return `Usage anomaly on ${p.sessionLabel}${p.tool ? ` (${p.tool})` : ''}: spend delta $${p.spendDelta.toFixed(2)} vs baseline $${p.baseline.toFixed(2)} at ${p.ts}`
    case 'memory-entry':
      return `${p.title}\n${p.body}`
    case 'pty-tail':
      return p.text
    case 'rule':
      return p.text
    case 'retraction':
      return 'Please disregard the previous channel send. Reason: user retracted.'
    case 'file-diff':
      return `${p.path}\n${p.diff}` // RESERVED -- not produced in v1.5.10
  }
}

export function summarise(p: ChannelPayload): string {
  const body = renderBody(p).replace(/\s+/g, ' ').trim()
  return body.length > 120 ? body.slice(0, 117) + '...' : body
}

function header(meta: ChannelEnvelopeMeta): string {
  const parts = [`ccc-channel:${meta.source}`, `ts:${meta.ts}`]
  if (meta.from) parts.push(`from:${meta.from}`)
  if (meta.firedBy === 'system') parts.push('fired-by:system')
  return `[${parts.join('  ')}]`
}

// `attachmentPath` is where the bus persisted the overflow/full body (Section
// 2.F); the note references it so the agent can read the complete payload.
export function formatTier1(payload: ChannelPayload, meta: ChannelEnvelopeMeta, attachmentPath?: string): string {
  let body = renderBody(payload)
  if (body.length > BODY_CAP) {
    const note = `\n[...truncated, full payload at ${attachmentPath ?? '<resourcesDir>/conductor-channels/attachments>'}]`
    body = body.slice(0, BODY_CAP - note.length) + note
  }
  return `${PASTE_START}${header(meta)}\n\n${body}\n\n[/ccc-channel]${PASTE_END}`
}
