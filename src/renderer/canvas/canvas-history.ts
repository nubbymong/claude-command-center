// Two-level canvas history (item C, phase 4) — a DISPLAY PROJECTION over the
// flat version list. No data migration: version ids and review anchors are
// untouched; this only decides how the chrome GROUPS them.
//
// Level 1 is the ARTIFACT — a plan, a mockup, a legacy test build — each a
// contiguous run of versions of the same kind. Level 2 is the version run
// WITHIN one artifact ("plan v3 of 3"). A plan can have ten versions and they
// never mix into one flat number with the mockup's.
//
// Kinds: a version's `mode` ('plan' | 'design' | 'uat') is the artifact kind
// ('design' reads as "mockup"). A 'uat' artifact is ARCHIVED — testing is live
// now and no longer versioned, but builds saved by older betas stay readable so
// their old review notes keep an anchor.

import type { CanvasVersion } from '../../shared/canvas'
import { CanvasMode } from '../../shared/canvas'

export interface CanvasArtifact {
  /** Stable within a render of the list: the id of the artifact's FIRST
   *  version. Used as the picker key and to remember the open artifact. */
  key: string
  /** The artifact kind, from its versions' `mode`. */
  kind: CanvasMode
  /** The word the user reads — "Plan", "Mockup", or the build label. */
  label: string
  /** This artifact's own versions, in render order. */
  versions: CanvasVersion[]
  /** The latest version's timestamp — the "updated" the picker shows. */
  updatedAt: string
  /** A legacy test build: shown muted, read-only, under ARCHIVED. */
  archived: boolean
}

/** "Plan" / "Mockup" / a uat build's label. Mirrors AgentCanvasPane.versionKind
 *  but at the artifact grain (the first version carries the kind). */
function artifactLabel(v: CanvasVersion): string {
  if (v.source.mode === 'uat') return v.source.buildLabel?.trim() || 'Test build'
  return v.mode === 'plan' ? 'Plan' : 'Mockup'
}

/**
 * Group the ready (non-draft) versions into artifacts — a new artifact begins
 * wherever the kind changes. Drafts are the agent's own loop (#366) and never
 * appear in history.
 */
export function groupVersionsIntoArtifacts(versions: readonly CanvasVersion[]): CanvasArtifact[] {
  const artifacts: CanvasArtifact[] = []
  for (const v of versions) {
    if (v.draft) continue
    const kind = v.mode
    const last = artifacts[artifacts.length - 1]
    if (last && last.kind === kind) {
      last.versions.push(v)
      last.updatedAt = v.createdAt
    } else {
      artifacts.push({
        key: v.id,
        kind,
        label: artifactLabel(v),
        versions: [v],
        updatedAt: v.createdAt,
        archived: kind === 'uat',
      })
    }
  }
  return artifacts
}

/** The artifact a given version belongs to, and its 1-based position within
 *  that artifact — the two facts the stepper needs ("plan v2 of 3"). Returns
 *  null when the version is a draft or not present. */
export function locateVersion(
  artifacts: readonly CanvasArtifact[],
  versionId: string,
): { artifact: CanvasArtifact; index: number } | null {
  for (const artifact of artifacts) {
    const index = artifact.versions.findIndex((v) => v.id === versionId)
    if (index >= 0) return { artifact, index }
  }
  return null
}

/** The live artifacts (plan/mockup) and the archived ones (legacy uat builds),
 *  split for the two groups the picker renders. Order within each is preserved. */
export function splitArchived(artifacts: readonly CanvasArtifact[]): {
  live: CanvasArtifact[]
  archived: CanvasArtifact[]
} {
  const live: CanvasArtifact[] = []
  const archived: CanvasArtifact[] = []
  for (const a of artifacts) (a.archived ? archived : live).push(a)
  return { live, archived }
}
