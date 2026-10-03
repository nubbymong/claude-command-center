// src/main/internal-events.ts
import { logError } from './debug-logger'

export interface InternalEventMap {
  'pr:merged': { repo: string; number: number; branch: string }
  'ci:failed': { sessionId?: string; prBranch?: string; logTail: string; repo?: string }
  'codex-review:complete': { prNumber?: number; authorSessionId?: string; findingCount: number; findings: string }
  'tokenomics:anomaly': { sessionId: string; sessionLabel: string; headroom: number; tool?: string; spendDelta: number; baseline: number }
  'memory:added': { project: string; projectPath?: string; entryTitle: string; entryBody: string }
  'attention:pulse': { sessionId: string }
  // P3.10 round 1 (S5): a session waits for the next prompt, as Claude Code's
  // Notification idle_prompt says; raised for a Codex session by its 60 s
  // idle mark (attention-source), which has no such notification.
  'attention:idle-prompt': { sessionId: string }
}
type Handler<K extends keyof InternalEventMap> = (payload: InternalEventMap[K]) => void

// Handlers are stored opaquely; emitInternal narrows the payload to InternalEventMap[K]
// (K is known at the emit call site) before invoking each handler.
const subs = new Map<keyof InternalEventMap, Set<(p: unknown) => void>>()

export function onInternal<K extends keyof InternalEventMap>(event: K, cb: Handler<K>): () => void {
  let set = subs.get(event)
  if (!set) { set = new Set(); subs.set(event, set) }
  set.add(cb as (p: unknown) => void)
  return () => { set!.delete(cb as (p: unknown) => void) }
}

export function emitInternal<K extends keyof InternalEventMap>(event: K, payload: InternalEventMap[K]): void {
  const set = subs.get(event)
  if (!set) return
  for (const cb of [...set]) {
    try { cb(payload) } catch (err) { logError(`[internal-events] ${String(event)} subscriber threw: ${String(err)}`) }
  }
}
