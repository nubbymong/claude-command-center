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

// ---------------------------------------------------------------------------
// LIVE PTY SESSIONS — a separate set, on purpose.
// ---------------------------------------------------------------------------
//
// `registry` above is shared METADATA about sessions, and it has two unrelated
// writers: `pty-manager` on spawn, and `github-handlers.bindGitHubMeta`, which
// patches `{ id, repo, branch }` for every SAVED session with a GitHub
// integration at handler-registration time — whether or not that session has
// ever run. `updateSessionMeta` is a merge-patch, so such a write CREATES an
// entry for an id that has no process behind it.
//
// That makes "is there an entry" a description, not a lifecycle fact, and the
// Agent Canvas's ownership lease had come to rest on it: a session whose canvas
// is ownerless must be resumable, dismissable and visible, and a github-only
// entry made all three refuse for the rest of the run with no PTY anywhere and
// nothing short of a restart to reverse it.
//
// So the fact gets its own set, with exactly TWO writers and no fields to
// merge: `markPtySessionAlive` from pty-manager's spawn, `markPtySessionGone`
// from its cleanup. DO NOT write to it from anywhere else — not from the SSH
// flow, the sentinel, the statusline, or a metadata binder. Anything that wants
// to say something ABOUT a session belongs in `updateSessionMeta`; this answers
// only "is a PTY running for this id, right now".

const livePtySessions = new Set<string>()

/** pty-manager, at spawn. The ONLY place that may add. */
export function markPtySessionAlive(id: string): void { livePtySessions.add(id) }
/** pty-manager, at cleanup. The ONLY place that may remove. */
export function markPtySessionGone(id: string): void { livePtySessions.delete(id) }
/** Is a PTY running for this session right now? The unforgeable liveness
 *  signal the canvas ownership lease gates on — see canvas-session-link. */
export function isPtySessionLive(id: string): boolean { return livePtySessions.has(id) }
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
