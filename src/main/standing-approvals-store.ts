// src/main/standing-approvals-store.ts
import type { StandingApproval, StandingApprovalTool, StandingApprovalTtl } from '../shared/channel-types'
import { readJsonFile, writeJsonFile } from './channel-storage'

const FILE = 'standing-approvals.json'
const SCHEMA_VERSION = 1
const TTL_MS: Record<StandingApprovalTtl, number | null> = { '1h': 3600_000, '4h': 14_400_000, 'until-restart': null }

interface ApprovalsFile { schemaVersion: number; approvals: StandingApproval[] }
function seed(): ApprovalsFile { return { schemaVersion: SCHEMA_VERSION, approvals: [] } }
function read(): ApprovalsFile {
  const f = readJsonFile<ApprovalsFile>(FILE, seed)
  return f.schemaVersion === SCHEMA_VERSION ? { schemaVersion: SCHEMA_VERSION, approvals: f.approvals ?? [] } : seed()
}
function prune(list: StandingApproval[], now: number): StandingApproval[] {
  return list.filter(a => a.expiresAt === null || a.expiresAt > now)
}

export function loadApprovals(now: number = Date.now()): StandingApproval[] {
  const f = read()
  const pruned = prune(f.approvals, now)
  if (pruned.length !== f.approvals.length) writeJsonFile(FILE, { schemaVersion: SCHEMA_VERSION, approvals: pruned })
  return pruned
}

export function addApproval(tool: StandingApprovalTool, ttl: StandingApprovalTtl, now: number = Date.now()): StandingApproval {
  const dur = TTL_MS[ttl]
  const approval: StandingApproval = {
    id: `${tool}-${now}`, tool, ttl, createdAt: now,
    expiresAt: dur === null ? null : now + dur,
  }
  const f = read()
  f.approvals = [...prune(f.approvals, now), approval]
  writeJsonFile(FILE, f)
  return approval
}

export function removeApproval(id: string): void {
  const f = read()
  f.approvals = f.approvals.filter(a => a.id !== id)
  writeJsonFile(FILE, f)
}

export function clearUntilRestart(): void {
  const f = read()
  f.approvals = f.approvals.filter(a => a.ttl !== 'until-restart')
  writeJsonFile(FILE, f)
}

// True if an active standing approval covers `tool`. NOTE: callers must still
// skip auto-allow for high-risk payloads (Section 5.F item 3) -- this function
// is tool-scope only.
export function matchApproval(tool: string, now: number = Date.now()): boolean {
  return loadApprovals(now).some(a => a.tool === '*' || a.tool === tool)
}
