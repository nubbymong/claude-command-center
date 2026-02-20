import { describe, it, expect } from 'vitest'
import {
  trainingSteps,
  currentTrainingVersion,
  getNewSteps,
  type TrainingStep,
} from '../../src/renderer/training-steps'

describe('training-steps', () => {
  describe('trainingSteps array', () => {
    it('has exactly 7 steps', () => {
      expect(trainingSteps).toHaveLength(7)
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

    it('has unique screenshot filenames', () => {
      const filenames = trainingSteps.map((s) => s.screenshotFilename)
      expect(new Set(filenames).size).toBe(filenames.length)
    })

    it('steps are in logical order starting with welcome', () => {
      expect(trainingSteps[0].id).toBe('welcome')
      expect(trainingSteps[trainingSteps.length - 1].id).toBe('tips')
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
