/**
 * Regression: every screenshotFilename in training-steps.ts MUST resolve to a
 * real asset in src/renderer/assets/training/. Two steps previously pointed at
 * files that did not exist (step-webview.jpg, step-github-sidebar.jpg), which
 * rendered the empty "Screenshot will appear here" placeholder on first run
 * (R-034). This test asserts that can never regress.
 *
 * It mirrors TrainingWalkthrough's getScreenshot() resolution: a step is
 * considered satisfied if either the generic <base>.jpg OR a platform variant
 * (<base>-win.jpg / <base>-mac.jpg) exists.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'
import { trainingSteps } from '../../../src/renderer/training-steps'

const ASSETS_DIR = join(__dirname, '../../../src/renderer/assets/training')

describe('training screenshot assets', () => {
  const files = new Set(readdirSync(ASSETS_DIR))

  it('every screenshotFilename resolves to a real asset (generic or platform variant)', () => {
    const missing: string[] = []
    for (const step of trainingSteps) {
      const name = step.screenshotFilename
      const base = name.replace(/\.jpg$/, '')
      const ok =
        files.has(name) ||
        files.has(`${base}-win.jpg`) ||
        files.has(`${base}-mac.jpg`)
      if (!ok) missing.push(`${step.id} -> ${name}`)
    }
    expect(missing, `Training steps referencing missing assets:\n${missing.join('\n')}`).toEqual([])
  })
})
