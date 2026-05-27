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
      if (e.event === 'Notification') {
        const matcher = (e.payload as { notification_type?: string }).notification_type
        fireMatching({
          event: 'Notification',
          matcher,
          durationMs: Number((e.payload as { duration_ms?: number }).duration_ms ?? 0),
        })
      }
    })
  }
}
