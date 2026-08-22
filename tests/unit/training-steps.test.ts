import { describe, it, expect } from 'vitest'
import {
  trainingSteps,
  currentTrainingVersion,
  getNewSteps,
  type TrainingStep,
} from '../../src/renderer/training-steps'

describe('training-steps', () => {
  describe('trainingSteps array', () => {
    it('has exactly 21 steps', () => {
      // v1.5.12 added dynamic-workflows; permission-tray step removed with the
      // feature; v2-readiness added multi-account + sentinel steps (16 -> 18);
      // v2.0.0 added the ai-usage-meter step (18 -> 19); the Agent Canvas got
      // an entry of its own (19 -> 20) -- FinishStep promises the Feature Guide
      // "explains every feature", and it was the one shipped feature missing.
      // Ask Conductor was the next one missing (20 -> 21): it shipped in 2.0 as
      // "Ask Command Center" and was renamed, but never got a card (#372).
      expect(trainingSteps).toHaveLength(21)
    })

    it('every step has required fields', () => {
      for (const step of trainingSteps) {
        expect(step.id).toBeTruthy()
        expect(step.title).toBeTruthy()
        expect(step.sinceVersion).toMatch(/^\d+\.\d+\.\d+$/)
        expect(step.bullets.length).toBeGreaterThan(0)
        expect(step.screenshotFilename).toMatch(/\.jpg$/)
      }
    })

    it('has unique step ids', () => {
      const ids = trainingSteps.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('original steps have unique screenshot filenames', () => {
      const originalSteps = trainingSteps.filter(s => s.sinceVersion === '1.0.0')
      const filenames = originalSteps.map((s) => s.screenshotFilename)
      expect(new Set(filenames).size).toBe(filenames.length)
    })

    it('steps are in logical order starting with session-options and ending with github-sidebar', () => {
      expect(trainingSteps[0].id).toBe('session-options')
      expect(trainingSteps[trainingSteps.length - 1].id).toBe('github-sidebar')
    })
  })

  describe('the Ask Conductor entry (#372)', () => {
    // Fail loudly on a missing step rather than letting a non-null assertion
    // throw an opaque TypeError three lines later.
    const ask = (): TrainingStep => {
      const step = trainingSteps.find((s) => s.id === 'ask-conductor')
      if (!step) throw new Error('no trainingSteps entry with id "ask-conductor" (#372)')
      return step
    }

    it('exists, so the Feature Guide covers the help surface itself', () => {
      expect(ask().id).toBe('ask-conductor')
    })

    it('is filed under its current name, never the retired 2.0 one', () => {
      const step = ask()
      expect(step.title).toBe('Ask Conductor')
      // It shipped as "Ask Command Center". The card is user-facing copy about
      // what the feature is TODAY, so the old name must not leak into it.
      // Every user-facing string on the card, howToTrigger labels and values
      // included -- those render in the card's right column.
      const copy = [
        step.title,
        step.summary ?? '',
        step.proTip ?? '',
        ...step.bullets,
        ...(step.highlights ?? []),
        ...(step.howToTrigger ?? []).flatMap((t) => [t.label, t.value]),
      ].join(' ')
      expect(copy).not.toContain('Ask Command Center')
      expect(copy).not.toContain('Command Center')
    })

    it('uses the hero layout and names a screenshot asset', () => {
      const step = ask()
      // `summary` is what switches FeatureGuidePage to the hero layout; without
      // it the card silently falls back to the flat bullet list.
      expect(step.summary).toBeTruthy()
      expect(step.highlights?.length).toBeGreaterThan(0)
      expect(step.howToTrigger?.length).toBeGreaterThan(0)
      // Only the shape is asserted here; that the file actually exists on disk
      // is covered for every step by training-screenshots-exist.test.ts.
      expect(step.screenshotFilename).toMatch(/\.jpg$/)
    })

    it('does not move the training version (rides with the 2.1 cards)', () => {
      expect(ask().sinceVersion).toBe('2.1.0')
      expect(currentTrainingVersion()).toBe('2.1.0')
    })
  })

  describe('currentTrainingVersion', () => {
    it('returns a valid semver string', () => {
      const ver = currentTrainingVersion()
      expect(ver).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('returns the highest sinceVersion across all steps', () => {
      const ver = currentTrainingVersion()
      for (const step of trainingSteps) {
        expect(compareSemver(ver, step.sinceVersion)).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('getNewSteps', () => {
    it('returns all steps when no lastVersion provided', () => {
      const steps = getNewSteps()
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('returns all steps when no lastVersion is undefined', () => {
      const steps = getNewSteps(undefined)
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('returns no steps when lastVersion equals currentTrainingVersion', () => {
      const steps = getNewSteps(currentTrainingVersion())
      expect(steps).toHaveLength(0)
    })

    it('returns no steps when lastVersion is higher than all steps', () => {
      const steps = getNewSteps('99.99.99')
      expect(steps).toHaveLength(0)
    })

    it('returns all steps when lastVersion is 0.0.0', () => {
      // All steps have sinceVersion > 0.0.0
      const steps = getNewSteps('0.0.0')
      expect(steps).toHaveLength(trainingSteps.length)
    })

    it('filters by sinceVersion correctly', () => {
      // If we set lastVersion to just below the current, should get steps at or above
      const steps = getNewSteps('0.99.99')
      // All current steps are sinceVersion 1.0.0, which is > 0.99.99
      expect(steps.length).toBeGreaterThan(0)
    })
  })
})

// Helper to verify ordering (mirrors the internal compareVersions)
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
