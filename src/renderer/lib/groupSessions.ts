/**
 * Pure classification of flat SessionRecord rows into the Logs tree shape:
 *  - native rows (configId present + still live) bucket under that configId
 *  - migrated rows (configId === null) whose label matches a live config attach
 *    to that group, tagged legacy: true (muted in the UI), matching the FIRST
 *    live config that carries the label
 *  - everything else (dead configId, or migrated with no label match) -> Orphaned
 *
 * Groups are ordered by their newest session (startedAt desc); sessions within a
 * group are newest-first. No React - fully unit-testable.
 */
export interface LogSessionRow {
  sessionId: string
  configId: string | null
  configLabel: string
  projectCwd: string | null
  accountEmail: string | null
  profileId: string | null
  provider: string
  startedAt: number
  endedAt: number | null
  status: string
  byteSize: number
  eventCount: number
}

export interface GroupedSession extends LogSessionRow {
  /** True for a migrated (configId=null) row attached to a live group by label. */
  legacy: boolean
}

export interface ConfigGroup {
  configId: string
  configLabel: string
  sessions: GroupedSession[]
}

export interface GroupedResult {
  groups: ConfigGroup[]
  orphaned: GroupedSession[]
}

export function groupSessionsByConfig(
  sessions: LogSessionRow[],
  liveConfigIdSet: Set<string>,
  liveLabelMap: Map<string, string>, // configId -> label, for live configs only
): GroupedResult {
  // First live configId carrying a given label (for legacy-row attachment).
  const labelToConfigId = new Map<string, string>()
  for (const [cid, label] of liveLabelMap) {
    if (!labelToConfigId.has(label)) labelToConfigId.set(label, cid)
  }

  const byConfig = new Map<string, ConfigGroup>()
  const orphaned: GroupedSession[] = []

  const ensureGroup = (cid: string): ConfigGroup => {
    let g = byConfig.get(cid)
    if (!g) {
      g = { configId: cid, configLabel: liveLabelMap.get(cid) ?? cid, sessions: [] }
      byConfig.set(cid, g)
    }
    return g
  }

  for (const s of sessions) {
    if (s.configId && liveConfigIdSet.has(s.configId)) {
      ensureGroup(s.configId).sessions.push({ ...s, legacy: false })
      continue
    }
    if (s.configId == null) {
      const matchCid = labelToConfigId.get(s.configLabel)
      if (matchCid) {
        ensureGroup(matchCid).sessions.push({ ...s, legacy: true })
        continue
      }
    }
    // dead configId OR migrated-with-no-label-match -> Orphaned
    orphaned.push({ ...s, legacy: s.configId == null })
  }

  // Sort sessions newest-first within each group + the orphan bucket.
  const newestFirst = (a: LogSessionRow, b: LogSessionRow) => b.startedAt - a.startedAt
  for (const g of byConfig.values()) g.sessions.sort(newestFirst)
  orphaned.sort(newestFirst)

  // Order groups by their newest session desc.
  const groups = Array.from(byConfig.values()).sort(
    (a, b) => (b.sessions[0]?.startedAt ?? 0) - (a.sessions[0]?.startedAt ?? 0),
  )

  return { groups, orphaned }
}
