// src/main/channel-rules-store.ts
import type { ChannelRule } from '../shared/channel-types'
import { readJsonFile, writeJsonFile } from './channel-storage'

const FILE = 'rules.json'
const SCHEMA_VERSION = 1

export const BUILTIN_RULES: ChannelRule[] = [
  { id: 'pr-cascade', name: 'PR Cascade', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'pr:merged', branch: 'main' },
    then: { template: 'PR #{n} merged on main.\nYour branch ({branch}) depends on this change.\nRecommended: rebase, then run tsc.', target: 'dependent-branches' },
    cooldownMs: 30000 },
  { id: 'codex-routing', name: 'Codex Routing', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'codex-review:complete' },
    then: { template: 'Codex review found {findingCount} issues on #{prNumber}:\n{findings}', target: 'pr-author' } },
  { id: 'ci-self-heal', name: 'CI Self-Heal', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'ci:failed', scope: 'bound-pr' },
    then: { template: 'CI failed on {prBranch}:\n{logTail}\nPlease investigate.', target: 'pr-session' },
    cooldownMs: 60000 },
  { id: 'rate-limit-guard', name: 'Rate-Limit Guard', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'tokenomics:anomaly', headroomBelow: 10 },
    then: { template: 'Rate-limit headroom is {headroom}%. Consider pausing this session.', target: 'anomaly-session' },
    cooldownMs: 300000 },
  { id: 'memory-broadcast', name: 'Memory Broadcast', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'memory:added', scope: 'project' },
    then: { template: 'New project memory added: {entryTitle}\n{entryBody}', target: 'project-sessions' },
    cooldownMs: 300000 },
  { id: 'attention-pulse', name: 'Attention Pulse', enabled: true, builtin: true, fireCount: 0,
    when: { event: 'Notification', matcher: 'idle_prompt', minDurationMs: 120000 },
    then: { template: null, target: 'events-feed-only' } },
]

interface RulesFile {
  schemaVersion: number
  // user-created rules (full records)
  rules: ChannelRule[]
  // overrides applied on top of BUILTIN_RULES, keyed by builtin id
  overrides: Record<string, Partial<ChannelRule>>
}

function seed(): RulesFile {
  return { schemaVersion: SCHEMA_VERSION, rules: [], overrides: {} }
}
function read(): RulesFile {
  const f = readJsonFile<RulesFile>(FILE, seed)
  if (f.schemaVersion !== SCHEMA_VERSION) return seed()
  return { schemaVersion: SCHEMA_VERSION, rules: f.rules ?? [], overrides: f.overrides ?? {} }
}

// Effective rule list = built-ins (with overrides merged) + user rules.
export function loadRules(): ChannelRule[] {
  const f = read()
  const merged = BUILTIN_RULES.map(b => ({ ...b, ...(f.overrides[b.id] ?? {}), id: b.id, builtin: true }))
  return [...merged, ...f.rules]
}

export function saveRule(rule: ChannelRule): void {
  const f = read()
  if (BUILTIN_RULES.some(b => b.id === rule.id)) {
    f.overrides[rule.id] = { enabled: rule.enabled, cooldownMs: rule.cooldownMs, fireCount: rule.fireCount, lastFiredAt: rule.lastFiredAt }
  } else {
    const idx = f.rules.findIndex(r => r.id === rule.id)
    if (idx >= 0) f.rules[idx] = rule
    else f.rules.push(rule)
  }
  writeJsonFile(FILE, f)
}

export function deleteRule(id: string): boolean {
  if (BUILTIN_RULES.some(b => b.id === id)) return false  // built-ins cannot be deleted, only disabled
  const f = read()
  f.rules = f.rules.filter(r => r.id !== id)
  writeJsonFile(FILE, f)
  return true
}
