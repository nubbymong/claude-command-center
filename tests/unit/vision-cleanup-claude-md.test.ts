// Regression: CCC must NEVER delete the user's ~/.claude/CLAUDE.md. Stripping the
// legacy VISION-INSTRUCTIONS marker used to unlinkSync the whole file when nothing
// else remained -- but that file can be the user's own. Leave an empty file instead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cleanupLegacyVisionMarkers } from '../../src/main/vision-manager'

const MARKER =
  '<!-- VISION-INSTRUCTIONS-START -->\nsome legacy vision text\n<!-- VISION-INSTRUCTIONS-END -->'

describe('cleanupLegacyVisionMarkers', () => {
  let dir = ''
  let claudeMd = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-claudemd-'))
    claudeMd = path.join(dir, 'CLAUDE.md')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('leaves an empty file (never unlinks) when stripping the marker empties it', () => {
    fs.writeFileSync(claudeMd, MARKER + '\n')
    cleanupLegacyVisionMarkers(claudeMd)
    expect(fs.existsSync(claudeMd)).toBe(true)
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe('')
  })

  it('preserves the user content around the marker', () => {
    fs.writeFileSync(claudeMd, `# My rules\nkeep me\n\n${MARKER}\n`)
    cleanupLegacyVisionMarkers(claudeMd)
    expect(fs.existsSync(claudeMd)).toBe(true)
    const out = fs.readFileSync(claudeMd, 'utf-8')
    expect(out).toContain('# My rules')
    expect(out).toContain('keep me')
    expect(out).not.toContain('VISION-INSTRUCTIONS')
  })

  it('leaves a file with no marker untouched', () => {
    const original = '# My rules\nno marker here\n'
    fs.writeFileSync(claudeMd, original)
    cleanupLegacyVisionMarkers(claudeMd)
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(original)
  })
})
