// src/main/session-registry.ts
export interface SessionMeta {
  id: string
  label: string
  cwd?: string
  branch?: string
  repo?: string
  prNumber?: number
  provider?: string
  identityColorKey?: string
}

// Patch type for updateSessionMeta: only id is required; all other fields
// (including label) are optional so callers that only bind repo/branch do not
// accidentally clobber a label set at spawn time.
export type SessionMetaPatch = { id: string } & Partial<Omit<SessionMeta, 'id'>>

const registry = new Map<string, SessionMeta>()

export function updateSessionMeta(meta: SessionMetaPatch): void {
  const existing = registry.get(meta.id)
  // label falls back to existing label or id if this is a first-write with no label
  const merged: SessionMeta = {
    label: existing?.label ?? meta.id,
    ...existing,
    ...meta,
  } as SessionMeta
  registry.set(meta.id, merged)
}
export function clearSessionMeta(id: string): void { registry.delete(id) }
export function getSessionMeta(id: string): SessionMeta | undefined { return registry.get(id) }
export function allSessionMeta(): SessionMeta[] { return [...registry.values()] }

export function getSessionsForProject(projectPath: string): SessionMeta[] {
  return allSessionMeta().filter(m => m.cwd && (m.cwd === projectPath || m.cwd.startsWith(projectPath + '/')))
}
// Sessions whose branch depends on the merged branch. v1.5.10 heuristic: every
// session NOT itself on the merged branch in the same repo is a candidate.
// repo is optional for backward-compat; when provided, filters to that repo only.
export function getSessionsForDependentBranches(mergedBranch: string, repo?: string): SessionMeta[] {
  return allSessionMeta().filter(m =>
    m.branch && m.branch !== mergedBranch && (repo === undefined || m.repo === repo))
}
