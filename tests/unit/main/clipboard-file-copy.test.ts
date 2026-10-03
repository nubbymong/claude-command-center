/**
 * Unit 5 W1 (BUG-8 fallback), PR-level ADR-009 round 1 (D6): an image FILE
 * copied in Explorer or Finder is copied into the screenshots folder only when
 * the path the clipboard names is a plain file; anything else (a folder named
 * like an image, a device) is no image, and nothing is copied. The clipboard
 * and the file system are faked: nothing real is read or written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  isFile: true,
  copies: [] as Array<[string, string]>,
  made: [] as string[],
}))
const PICKED = process.platform === 'win32' ? 'C:\\Users\\me\\Pictures\\shot.png' : '/Users/me/Pictures/shot.png'

/** A wide DROPFILES block naming one path (shlobj_core.h), as Explorer puts it on the clipboard. */
function dropfiles(p: string): Buffer {
  const header = Buffer.alloc(20)
  header.writeUInt32LE(20, 0)
  header.writeUInt32LE(1, 16)
  return Buffer.concat([header, Buffer.from(`${p}\0\0`, 'ucs2')])
}

vi.mock('electron', () => ({
  clipboard: {
    availableFormats: () => ['CF_HDROP', 'public.file-url'],
    readBuffer: (f: string) => (f === 'CF_HDROP' ? dropfiles(PICKED) : Buffer.alloc(0)),
    read: (f: string) => (f === 'public.file-url' ? `file://${PICKED}` : ''),
  },
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: (p: string) => (p === PICKED ? { size: 1024, isFile: () => h.isFile } : actual.statSync(p)),
    mkdirSync: (p: string) => { h.made.push(p) },
    copyFileSync: (from: string, to: string) => { h.copies.push([from, to]) },
  }
})

const { readClipboardImageFilePath } = await import('../../../src/main/clipboard-file')
const SHOTS = process.platform === 'win32' ? 'C:\\res\\screenshots' : '/res/screenshots'

beforeEach(() => { h.isFile = true; h.copies.length = 0; h.made.length = 0 })

// The clipboard formats are read on Windows (CF_HDROP) and macOS (public.file-url) only.
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('readClipboardImageFilePath copies only a plain file', () => {
  it('a plain image file is copied into the screenshots folder, keeping its extension', () => {
    const r = readClipboardImageFilePath(SHOTS)
    expect(h.copies).toHaveLength(1)
    expect(h.copies[0][0]).toBe(PICKED)
    expect(r).toEqual({ path: h.copies[0][1] })
    expect(h.copies[0][1].startsWith(SHOTS)).toBe(true)
    expect(h.copies[0][1].endsWith('.png')).toBe(true)
  })

  it('a path that is not a plain file (a folder named like an image, a device) is no image, and nothing is copied', () => {
    h.isFile = false
    expect(readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.copies).toEqual([])
    expect(h.made).toEqual([])
  })
})
