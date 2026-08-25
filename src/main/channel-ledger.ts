// src/main/channel-ledger.ts
import type { LedgerRecord } from '../shared/channel-types'
import { appendLine, listFiles, deleteFile } from './channel-storage'
import { redactHookPayload } from './hooks/hook-payload-redactor'
import { reapAttachments } from './channel-attachments'

let seq = 0
function newId(): string { return `${Date.now().toString(36)}-${(seq++).toString(36)}` }

export function ledgerFileForDate(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 10)}.jsonl`
}

type LedgerInput = Omit<LedgerRecord, 'id' | 'ts'> & { ts?: string }

// Appends a single redacted record. The summary is redacted; the full payload
// body is NEVER written here (Section 2.F). Returns the record id.
export function appendLedger(input: LedgerInput): string {
  const record: LedgerRecord = {
    id: newId(),
    ts: input.ts ?? new Date().toISOString(),
    source: input.source,
    target: input.target,
    transport: input.transport,
    kind: input.kind,
    summary: redactHookPayload(input.summary),
    firedBy: input.firedBy,
    attachmentPath: input.attachmentPath,
  }
  appendLine(ledgerFileForDate(new Date(record.ts)), JSON.stringify(record))
  return record.id
}

const LEDGER_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/

// Deletes ledger files older than `retentionDays`. Non-ledger files are ignored.
// Also reaps attachments/ on the same retention window (#487 audit) -- the
// ledger rotates but the attachments a record's `attachmentPath` points at were
// exempt, so screenshot-heavy channel traffic grew that dir without bound.
export function rotateLedgers(now: Date = new Date(), retentionDays = 30): void {
  const cutoff = now.getTime() - retentionDays * 86_400_000
  for (const name of listFiles()) {
    const m = LEDGER_RE.exec(name)
    if (!m) continue
    const fileTime = Date.UTC(+m[1], +m[2] - 1, +m[3])
    if (fileTime < cutoff) deleteFile(name)
  }
  reapAttachments(now, retentionDays)
}
