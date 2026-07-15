// src/main/channel-bus.ts
import type { ChannelPayload, ChannelEnvelopeMeta } from '../shared/channel-types'
import { isSessionWritable, pastePty } from './pty-manager'
import { formatTier1, summarise } from './channel-envelope'
import { appendLedger } from './channel-ledger'
import { pickTransport, formatTier2, sendTier2 } from './channel-capability'
import { persistAttachment } from './channel-attachments'

export interface SendRequest {
  targetSessionId: string
  targetLabel?: string
  payload: ChannelPayload
  meta: ChannelEnvelopeMeta
}
export interface SendResult { ok: boolean; reason?: string; transport?: 'pty' | 'mcp'; ledgerId?: string }

export async function send(req: SendRequest): Promise<SendResult> {
  const { targetSessionId, payload, meta } = req
  const target = req.targetLabel ?? targetSessionId

  // Defense-in-depth: reject the reserved file-diff kind -- no v1.5.10 send-point
  // produces it and it must never reach formatTier1/pastePty.
  if (payload.kind === 'file-diff') {
    const ledgerId = appendLedger({ source: meta.source, target, transport: null, kind: 'failed', summary: 'file-diff payload rejected (not supported in v1.5.10)' })
    return { ok: false, reason: 'file-diff payloads are not supported in v1.5.10', ledgerId }
  }

  const summary = summarise(payload)

  if (!isSessionWritable(targetSessionId)) {
    const ledgerId = appendLedger({ source: meta.source, target, transport: null, kind: 'failed', summary: `not writable: ${summary}`, firedBy: meta.firedBy ? 'system' : 'user' })
    return { ok: false, reason: 'Target session is not writable (disconnected / not running).', ledgerId }
  }

  // Image payloads: persist dataUrl to disk and reference by path instead.
  // Build effectivePayload as a non-mutating copy so the caller's object is never modified.
  let attachmentPath: string | undefined
  let effectivePayload = payload
  if (payload.kind === 'vision-screenshot' && payload.dataUrl && !payload.path) {
    try {
      attachmentPath = persistAttachment(payload.dataUrl, 'png')
      effectivePayload = { ...payload, path: attachmentPath }
    } catch (err) {
      const ledgerId = appendLedger({ source: meta.source, target, transport: null, kind: 'failed', summary: 'attachment too large' })
      return { ok: false, reason: 'attachment too large', ledgerId }
    }
  }

  const transport = pickTransport(targetSessionId)
  if (transport === 'mcp') {
    const tier2Result = await sendTier2(targetSessionId, formatTier2(effectivePayload, meta))
    if (tier2Result.ok) {
      const ledgerId = appendLedger({ source: meta.source, target, transport: 'mcp', kind: 'bus-fire', summary, firedBy: meta.firedBy ? 'system' : 'user', attachmentPath })
      return { ok: true, transport: 'mcp', ledgerId }
    }
    // Fallback to Tier 1. Log the fallback event.
    appendLedger({ source: meta.source, target, transport: 'pty', kind: 'tier-2-fallback', summary: `${tier2Result.reason}: ${summary}` })
  }

  // Tier 1 PTY paste
  const envelope = formatTier1(effectivePayload, meta, attachmentPath)
  const dropped = pastePty(targetSessionId, envelope)
  if (dropped > 0) {
    const ledgerId = appendLedger({ source: meta.source, target, transport: 'pty', kind: 'bus-overflow', summary: `queue full, dropped ${dropped}: ${summary}` })
    return { ok: false, reason: `Session has too many sends queued; dropped ${dropped}.`, ledgerId }
  }
  const ledgerId = appendLedger({ source: meta.source, target, transport: 'pty', kind: 'bus-fire', summary, firedBy: meta.firedBy ? 'system' : 'user', attachmentPath })
  return { ok: true, transport: 'pty', ledgerId }
}

export async function retract(targetSessionId: string, targetLabel?: string): Promise<SendResult> {
  return send({ targetSessionId, targetLabel, payload: { kind: 'retraction' }, meta: { source: 'retraction', ts: new Date().toISOString() } })
}
