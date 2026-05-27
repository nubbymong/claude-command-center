// src/main/internal-events.ts
import { logError } from './debug-logger'

export interface InternalEventMap {
  'pr:merged': { repo: string; number: number; branch: string }
  'ci:failed': { sessionId?: string; prBranch?: string; logTail: string; repo?: string }
  'codex-review:complete': { prNumber?: number; authorSessionId?: string; findingCount: number; findings: string }
  'tokenomics:anomaly': { sessionId: string; sessionLabel: string; headroom: number; tool?: string; spendDelta: number; baseline: number }
  'memory:added': { project: string; projectPath?: string; entryTitle: string; entryBody: string }
  'attention:pulse': { sessionId: string }
}
type Handler<K extends keyof InternalEventMap> = (payload: InternalEventMap[K]) => void

const subs = new Map<keyof InternalEventMap, Set<Handler<keyof InternalEventMap>>>()

export function onInternal<K extends keyof InternalEventMap>(event: K, cb: Handler<K>): () => void {
  let set = subs.get(event)
  if (!set) { set = new Set(); subs.set(event, set) }
  set.add(cb as Handler<keyof InternalEventMap>)
  return () => { set!.delete(cb as Handler<keyof InternalEventMap>) }
}

export function emitInternal<K extends keyof InternalEventMap>(event: K, payload: InternalEventMap[K]): void {
  const set = subs.get(event)
  if (!set) return
  for (const cb of [...set]) {
    try { cb(payload) } catch (err) { logError(`[internal-events] ${String(event)} subscriber threw: ${String(err)}`) }
  }
}
