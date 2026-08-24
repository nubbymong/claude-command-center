// Two-level canvas history projection (item C, phase 4): versions group into
// artifacts by kind, drafts are excluded, uat runs are archived, and a version
// locates to its artifact + position.

import { describe, it, expect } from 'vitest'
import type { CanvasVersion } from '../../../src/shared/canvas'
import {
  groupVersionsIntoArtifacts,
  locateVersion,
  splitArchived,
} from '../../../src/renderer/canvas/canvas-history'

const v = (id: string, mode: CanvasVersion['mode'], over: Partial<CanvasVersion> = {}): CanvasVersion => ({
  id,
  mode,
  createdAt: `2026-08-24T10:0${id.replace('v', '')}:00Z`,
  source: mode === 'uat' ? { mode: 'uat', distRoot: '/d', entry: 'index.html' } : { mode: 'design', entry: 'index.html' },
  ...over,
})

describe('groupVersionsIntoArtifacts', () => {
  it('starts a new artifact whenever the kind changes', () => {
    const arts = groupVersionsIntoArtifacts([
      v('v1', 'plan'),
      v('v2', 'plan'),
      v('v3', 'plan'),
      v('v4', 'design'),
    ])
    expect(arts).toHaveLength(2)
    expect(arts[0].kind).toBe('plan')
    expect(arts[0].label).toBe('Plan')
    expect(arts[0].versions.map((x) => x.id)).toEqual(['v1', 'v2', 'v3'])
    expect(arts[0].updatedAt).toBe(v('v3', 'plan').createdAt)
    expect(arts[1].kind).toBe('design')
    expect(arts[1].label).toBe('Mockup')
    expect(arts[1].versions.map((x) => x.id)).toEqual(['v4'])
  })

  it('keeps a plan and a later plan as SEPARATE artifacts when a mockup sits between', () => {
    const arts = groupVersionsIntoArtifacts([v('v1', 'plan'), v('v2', 'design'), v('v3', 'plan')])
    expect(arts.map((a) => a.kind)).toEqual(['plan', 'design', 'plan'])
    // The two plan runs never merge into one number line.
    expect(arts[0].versions).toHaveLength(1)
    expect(arts[2].versions).toHaveLength(1)
  })

  it('excludes drafts — the agent’s own loop is never history', () => {
    const arts = groupVersionsIntoArtifacts([v('v1', 'design'), v('v2', 'design', { draft: true })])
    expect(arts).toHaveLength(1)
    expect(arts[0].versions.map((x) => x.id)).toEqual(['v1'])
  })

  it('marks uat runs archived, with their build label', () => {
    const arts = groupVersionsIntoArtifacts([
      v('v1', 'uat', { source: { mode: 'uat', distRoot: '/d', entry: 'index.html', buildLabel: 'nightly-42' } }),
    ])
    expect(arts[0].archived).toBe(true)
    expect(arts[0].label).toBe('nightly-42')
  })
})

describe('locateVersion + splitArchived', () => {
  const arts = groupVersionsIntoArtifacts([v('v1', 'plan'), v('v2', 'plan'), v('v3', 'design'), v('v4', 'uat')])

  it('finds a version’s artifact and its 1-based position', () => {
    const loc = locateVersion(arts, 'v2')
    expect(loc?.artifact.kind).toBe('plan')
    expect(loc?.index).toBe(1) // second of the plan run
  })

  it('returns null for an unknown version', () => {
    expect(locateVersion(arts, 'v99')).toBeNull()
  })

  it('splits live artifacts from archived uat builds', () => {
    const { live, archived } = splitArchived(arts)
    expect(live.map((a) => a.kind)).toEqual(['plan', 'design'])
    expect(archived.map((a) => a.kind)).toEqual(['uat'])
  })
})
