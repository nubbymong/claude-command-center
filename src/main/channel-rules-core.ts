// src/main/channel-rules-core.ts
import type { ChannelRule } from '../shared/channel-types'

export interface RuleEventContext {
  event: string
  branch?: string
  headroom?: number
  matcher?: string
  durationMs?: number
  [k: string]: unknown
}

export function shouldFire(rule: ChannelRule, ctx: RuleEventContext, now: number): boolean {
  if (!rule.enabled) return false
  if (rule.when.event !== ctx.event) return false
  if (rule.when.branch && rule.when.branch !== ctx.branch) return false
  if (rule.when.headroomBelow != null && !(typeof ctx.headroom === 'number' && ctx.headroom < rule.when.headroomBelow)) return false
  if (rule.when.matcher && rule.when.matcher !== ctx.matcher) return false
  if (rule.when.minDurationMs != null && !((ctx.durationMs ?? 0) >= rule.when.minDurationMs)) return false
  if (rule.cooldownMs && rule.lastFiredAt) {
    if (now - new Date(rule.lastFiredAt).getTime() < rule.cooldownMs) return false
  }
  return true
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`))
}
