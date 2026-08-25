// tests/unit/channel-attachments.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { vi } from 'vitest'

let channelsRoot: string
vi.mock('../../src/main/channel-storage', () => ({
  channelsDir: () => channelsRoot,
}))

import { persistAttachment, reapAttachments } from '../../src/main/channel-attachments'

function attachmentsDir(): string {
  return path.join(channelsRoot, 'attachments')
}

describe('channel-attachments: reapAttachments (#487 audit)', () => {
  beforeEach(() => {
    channelsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-attachments-test-'))
  })

  it('persistAttachment writes into <channelsDir>/attachments', () => {
    const p = persistAttachment('data:image/png;base64,AAAA', 'png')
    expect(fs.existsSync(p)).toBe(true)
    expect(path.dirname(p)).toBe(attachmentsDir())
  })

  it('no-ops when attachments/ does not exist yet', () => {
    expect(() => reapAttachments()).not.toThrow()
  })

  it('deletes attachments older than retentionDays, keeps newer ones', () => {
    const dir = attachmentsDir()
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const oldTs = now - 40 * 86_400_000 // 40 days old
    const newTs = now - 1 * 86_400_000 // 1 day old
    const oldFile = path.join(dir, `${oldTs.toString(36)}.png`)
    const newFile = path.join(dir, `${newTs.toString(36)}.png`)
    fs.writeFileSync(oldFile, Buffer.from('old'))
    fs.writeFileSync(newFile, Buffer.from('new'))

    reapAttachments(new Date(now), 30)

    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(newFile)).toBe(true)
  })

  it('leaves non-timestamp filenames alone', () => {
    const dir = attachmentsDir()
    fs.mkdirSync(dir, { recursive: true })
    const strange = path.join(dir, 'not-a-timestamp.png')
    fs.writeFileSync(strange, Buffer.from('x'))

    reapAttachments(new Date(), 30)

    expect(fs.existsSync(strange)).toBe(true)
  })

  // Round-1 adversarial finding (BLOCKER): the old whole-string base36 guard
  // still let any all-base36 STEM through parseInt(stem, 36) -- "logo",
  // "note", "icon", "README" (and, case-insensitively, "Thumbs.db") all parse
  // cleanly to a small number that lands in 1970, so `ts < cutoff` was true
  // and every one of them got deleted. Thumbs.db is a guaranteed real-world
  // victim on Windows. These must all SURVIVE a reap.
  it('#487 round-1: never deletes non-timestamp base36-coincidental filenames (Thumbs.db et al.)', () => {
    const dir = attachmentsDir()
    fs.mkdirSync(dir, { recursive: true })
    const victims = ['Thumbs.db', 'logo.png', 'note.txt', 'README.txt', 'icon.png']
    for (const v of victims) {
      fs.writeFileSync(path.join(dir, v), Buffer.from('keep me'))
    }

    reapAttachments(new Date(), 30)

    for (const v of victims) {
      expect(fs.existsSync(path.join(dir, v))).toBe(true)
    }
  })

  // Companion positive case: a GENUINE Date.now().toString(36)-named file
  // older than retention must still be deleted, and one at/after the cutoff
  // must still be kept -- the plausibility/round-trip checks must not turn
  // into a blanket "never delete anything" regression.
  it('#487 round-1: still deletes a genuine expired timestamp file, keeps one at cutoff', () => {
    const dir = attachmentsDir()
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const retentionDays = 30
    const expiredTs = now - 40 * 86_400_000 // 40 days old -- past retention
    const atCutoffTs = now - retentionDays * 86_400_000 // exactly at cutoff -- kept
    const expiredFile = path.join(dir, `${expiredTs.toString(36)}.png`)
    const atCutoffFile = path.join(dir, `${atCutoffTs.toString(36)}.png`)
    fs.writeFileSync(expiredFile, Buffer.from('old'))
    fs.writeFileSync(atCutoffFile, Buffer.from('boundary'))

    reapAttachments(new Date(now), retentionDays)

    expect(fs.existsSync(expiredFile)).toBe(false)
    expect(fs.existsSync(atCutoffFile)).toBe(true)
  })
})
