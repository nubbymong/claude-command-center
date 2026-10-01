// src/main/channel-rules.ts
import { send } from './channel-bus'
import { loadRules, saveRule } from './channel-rules-store'
import { getGateway } from './hooks/index'
import { onInternal, type InternalEventMap } from './internal-events'
import { getSessionsForDependentBranches, getSessionsForProject, getSessionMeta, type SessionMeta } from './session-registry'
import { shouldFire, renderTemplate, type RuleEventContext } from './channel-rules-core'
import type { ChannelRule, RuleTargetStrategy } from '../shared/channel-types'

let started = false

function resolveTargets(strategy: RuleTargetStrategy, ctx: RuleEventContext): SessionMeta[] {
  switch (strategy) {
    case 'dependent-branches':
      return getSessionsForDependentBranches(
        String(ctx.branch ?? 'main'),
        ctx.repo ? String(ctx.repo) : undefined,
      )
    case 'project-sessions':
      return ctx.projectPath ? getSessionsForProject(String(ctx.projectPath)) : []
    case 'pr-session':
    case 'anomaly-session':
    case 'pr-author': {
      const sid = String(ctx.targetSessionId ?? '')
      const m = sid ? getSessionMeta(sid) : undefined
      return m ? [m] : []
    }
    case 'events-feed-only':
      return []  // filter-only rule, never sends
    default:
      return []
  }
}

function fireMatching(ctx: RuleEventContext): void {
  const now = Date.now()
  for (const rule of loadRules()) {
    if (!shouldFire(rule, ctx, now)) continue
    if (rule.then.template === null) {
      bumpFire(rule, now)
      continue  // events-feed-only: bump fireCount but do not send
    }
    const targets = resolveTargets(rule.then.target, ctx)
    const text = renderTemplate(rule.then.template, ctx as Record<string, unknown>)
    for (const t of targets) {
      void send({
        targetSessionId: t.id,
        targetLabel: t.label,
        payload: { kind: 'rule', text },
        meta: {
          source: `rule:${rule.id}`,
          ts: new Date().toISOString(),
          firedBy: 'system',
        },
      })
    }
    bumpFire(rule, now)
  }
}

function bumpFire(rule: ChannelRule, now: number): void {
  // per-fire persist of fireCount/lastFiredAt; rule cooldowns throttle fire frequency so write volume stays low
  saveRule({ ...rule, fireCount: rule.fireCount + 1, lastFiredAt: new Date(now).toISOString() })
}

export function startRulesEngine(): void {
  if (started) return
  started = true

  onInternal('pr:merged', (p: InternalEventMap['pr:merged']) =>
    fireMatching({ event: 'pr:merged', branch: p.branch, repo: p.repo, n: p.number }),
  )

  onInternal('ci:failed', (p: InternalEventMap['ci:failed']) =>
    fireMatching({ event: 'ci:failed', targetSessionId: p.sessionId, prBranch: p.prBranch, logTail: p.logTail }),
  )

  onInternal('codex-review:complete', (p: InternalEventMap['codex-review:complete']) =>
    fireMatching({ event: 'codex-review:complete', targetSessionId: p.authorSessionId, prNumber: p.prNumber, findingCount: p.findingCount, findings: p.findings }),
  )

  onInternal('tokenomics:anomaly', (p: InternalEventMap['tokenomics:anomaly']) =>
    fireMatching({ event: 'tokenomics:anomaly', targetSessionId: p.sessionId, headroom: p.headroom }),
  )

  onInternal('memory:added', (p: InternalEventMap['memory:added']) =>
    fireMatching({ event: 'memory:added', projectPath: p.projectPath, entryTitle: p.entryTitle, entryBody: p.entryBody }),
  )

  // Attention Pulse rule consumes the CC-side Notification(idle_prompt) hook (filter-only).
  const gw = getGateway()
  if (gw) {
    gw.subscribe((e) => {
      noteTurnEvent(e)
      if (e.event === 'Notification') {
        const p = e.payload as { notification_type?: unknown }
        fireMatching(notificationRuleContext(p.notification_type, turnMsAt(e.sessionId, e.ts)))
      }
    })
  }

  // P3.10 round 1 (S5): a Codex session has no Notification hook; its 60 s
  // idle mark (attention-source) feeds the rules exactly what Claude Code's
  // Notification idle_prompt feeds them, so a rule on it treats both alike.
  onInternal('attention:idle-prompt', (p: InternalEventMap['attention:idle-prompt']) =>
    fireMatching(notificationRuleContext('idle_prompt', turnMsAt(p?.sessionId, Date.now()))),
  )
}

/**
 * P3.16 (M3): each session's turn, for a rule's duration (the Attention Pulse:
 * at least 120000 ms): from the session's UserPromptSubmit to its Stop, as the
 * Hooks gateway received them (its `ts`). Both assistants send both events;
 * neither Claude Code's Notification input nor either assistant's Stop input
 * carries a duration. A turn still running counts to the moment asked.
 */
const turns = new Map<string, { promptAt: number; endedAt: number | null }>()
const TURNS_KEPT = 1000

function noteTurnEvent(e: { sessionId?: unknown; event?: unknown; ts?: unknown }): void {
  if (typeof e.sessionId !== 'string' || !e.sessionId || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return
  if (e.event === 'UserPromptSubmit') {
    turns.delete(e.sessionId)
    turns.set(e.sessionId, { promptAt: e.ts, endedAt: null })
    while (turns.size > TURNS_KEPT) {
      const oldest = turns.keys().next().value
      if (oldest === undefined) break
      turns.delete(oldest)
    }
  } else if (e.event === 'Stop' || e.event === 'StopFailure') {
    const t = turns.get(e.sessionId)
    if (t && t.endedAt === null) t.endedAt = Math.max(t.promptAt, e.ts)
  }
}

/** How long the session's last turn ran (0 when none was seen). */
function turnMsAt(sessionId: unknown, at: number): number {
  const t = typeof sessionId === 'string' ? turns.get(sessionId) : undefined
  if (!t) return 0
  return Math.max(0, (t.endedAt ?? at) - t.promptAt)
}

/** The rule engine's input for a session waiting on the user: the
 *  notification's type and how long the session's turn ran (P3.16, M3: the
 *  gateway's times, above). One builder for both assistants (P3.10 round 1, S5). */
export function notificationRuleContext(matcher: unknown, durationMs: unknown): RuleEventContext {
  return { event: 'Notification', matcher: typeof matcher === 'string' ? matcher : undefined, durationMs: Number(durationMs ?? 0) }
}
