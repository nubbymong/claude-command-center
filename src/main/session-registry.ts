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
const registry = new Map<string, SessionMeta>()

export function updateSessionMeta(meta: SessionMeta): void {
  registry.set(meta.id, { ...registry.get(meta.id), ...meta })
}
export function clearSessionMeta(id: string): void { registry.delete(id) }
export function getSessionMeta(id: string): SessionMeta | undefined { return registry.get(id) }
export function allSessionMeta(): SessionMeta[] { return [...registry.values()] }

export function getSessionsForProject(projectPath: string): SessionMeta[] {
  return allSessionMeta().filter(m => m.cwd && (m.cwd === projectPath || m.cwd.startsWith(projectPath + '/')))
}
// Sessions whose branch depends on the merged branch. v1.5.10 heuristic: every
// session NOT itself on the merged branch in the same repo is a candidate.
export function getSessionsForDependentBranches(mergedBranch: string): SessionMeta[] {
  return allSessionMeta().filter(m => m.branch && m.branch !== mergedBranch)
}
