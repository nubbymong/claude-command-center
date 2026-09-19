// WP1.70: which gate rules apply. The phase is not merely self-declared in a
// JSON file: an environment override can only raise it, the traceability
// manifest can only raise it, and for the LEDGER rules it is derived as
// `candidate` as soon as retirement has visibly started (any `delete` ledger
// path is gone from the tree), so the strict retirement rules cannot be dodged
// by leaving the manifest at `gate0`. The TRACEABILITY completeness rules
// (nothing planned, digest-bound evidence) need the explicit declaration, so a
// single unrelated deletion cannot turn the branch red for 73 planned items.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Phase = 'gate0' | 'candidate'
export type PhaseResolution = { phase: Phase; reason: string }
const ROOT = resolve(__dirname, '..', '..')

type Ledger = { entries?: Array<{ path: string; disposition: string }> }

export function resolvePhaseDetailed(ledger?: Ledger, { eager = true }: { eager?: boolean } = {}): PhaseResolution {
  if (process.env.WP1_PHASE === 'candidate') return { phase: 'candidate', reason: 'WP1_PHASE=candidate in the environment' }
  const traceability = JSON.parse(readFileSync(resolve(__dirname, 'traceability.json'), 'utf8')) as { phase?: Phase }
  if (traceability.phase === 'candidate') return { phase: 'candidate', reason: 'tests/wp1/traceability.json declares phase candidate' }
  if (eager) {
    const l = ledger ?? (JSON.parse(readFileSync(resolve(__dirname, 'legacy-codex-ledger.json'), 'utf8')) as Ledger)
    const gone = (l.entries ?? []).find((e) => e.disposition === 'delete' && !existsSync(resolve(ROOT, e.path)))
    if (gone) return { phase: 'candidate', reason: `phase auto-raised: ledger delete path ${gone.path} is gone from the tree (retirement started)` }
  }
  return { phase: 'gate0', reason: 'no candidate declaration and no retirement started' }
}

export function resolvePhase(ledger?: Ledger, opts?: { eager?: boolean }): Phase {
  return resolvePhaseDetailed(ledger, opts).phase
}
