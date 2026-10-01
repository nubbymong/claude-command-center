import { describe, it, expect } from 'vitest'
import { parseHdropBuffer, parseFileUrl, pickPasteableImage, mimeForImage, isReapableImageFile } from '../../../src/main/clipboard-file'

// Unit 5 W1: pure decoders for clipboard file references (BUG-8 fallback).
describe('parseFileUrl (macOS public.file-url)', () => {
  it('decodes a file:// url to a path and percent-decodes spaces', () => {
    expect(parseFileUrl('file:///Users/me/My%20Pics/a.png')).toBe('/Users/me/My Pics/a.png')
  })
  it('strips a localhost host and decodes unicode', () => {
    expect(parseFileUrl('file://localhost/tmp/caf%C3%A9.png')).toBe('/tmp/café.png')
  })
  it('returns null for empty or non-file input', () => {
    expect(parseFileUrl('')).toBeNull()
    expect(parseFileUrl('http://x/y.png')).toBeNull()
  })
})

// A real-shaped DROPFILES, as Explorer puts it on the clipboard (shlobj_core.h):
// pFiles (4 bytes, offset 0), pt (two 4-byte coordinates, offset 4), fNC (4 bytes,
// offset 12) and fWide (4 bytes, offset 16): 20 bytes, then the path list.
function dropfiles(list: string, opts: { wide: boolean; fNC?: number }): Buffer {
  const header = Buffer.alloc(20)
  header.writeUInt32LE(20, 0)
  header.writeInt32LE(0, 4)
  header.writeInt32LE(0, 8)
  header.writeUInt32LE(opts.fNC ?? 0, 12)
  header.writeUInt32LE(opts.wide ? 1 : 0, 16)
  return Buffer.concat([header, Buffer.from(list, opts.wide ? 'ucs2' : 'latin1')])
}

describe('parseHdropBuffer (Windows CF_HDROP)', () => {
  it('reads a single wide (UTF-16LE) path from a DROPFILES buffer', () => {
    expect(parseHdropBuffer(dropfiles('C:\\pics\\a.png' + '\0\0', { wide: true }))).toEqual(['C:\\pics\\a.png'])
  })
  it('reads multiple null-separated paths', () => {
    expect(parseHdropBuffer(dropfiles('C:\\a.png\0C:\\b.jpg\0\0', { wide: true }))).toEqual(['C:\\a.png', 'C:\\b.jpg'])
  })
  it('reads a wide path with spaces and non-Latin letters whole, not as 8-bit junk', () => {
    const path = 'C:\\Users\\me\\My Pictures\\caf\u00e9 \u65e5\u672c.png'
    expect(parseHdropBuffer(dropfiles(path + '\0\0', { wide: true }))).toEqual([path])
  })
  it('reads fWide at offset 16: a set fNC (offset 12, whose second byte is offset 13) does not make a narrow list wide', () => {
    // fNC = 0x100 puts a 1 at byte 13, the byte the parser used to read.
    expect(parseHdropBuffer(dropfiles('C:\\pics\\a.png\0\0', { wide: false, fNC: 0x100 }))).toEqual(['C:\\pics\\a.png'])
    // And a wide list with fNC set is still wide.
    expect(parseHdropBuffer(dropfiles('C:\\pics\\a.png\0\0', { wide: true, fNC: 0x100 }))).toEqual(['C:\\pics\\a.png'])
  })
  it('reads a narrow (fWide 0) list as 8-bit text', () => {
    expect(parseHdropBuffer(dropfiles('C:\\pics\\a.png\0C:\\pics\\b.png\0\0', { wide: false }))).toEqual(['C:\\pics\\a.png', 'C:\\pics\\b.png'])
  })
  it('returns [] for a too-short buffer', () => {
    expect(parseHdropBuffer(Buffer.alloc(4))).toEqual([])
  })
})

describe('pickPasteableImage', () => {
  const MB = 1024 * 1024
  const sizeOf = (p: string) => (p.includes('big') ? 11 * MB : 2 * MB)
  it('picks the first allowed image extension, case-insensitive', () => {
    expect(pickPasteableImage(['/a/notes.txt', '/a/Pic.PNG'], sizeOf)).toEqual({ path: '/a/Pic.PNG' })
  })
  it('rejects an oversize image', () => {
    expect(pickPasteableImage(['/a/big.png'], sizeOf)).toEqual({ error: 'too-large' })
  })
  it('returns no-image when nothing qualifies', () => {
    expect(pickPasteableImage(['/a/doc.pdf', '/a/folder'], sizeOf)).toEqual({ error: 'no-image' })
  })
})

describe('mimeForImage', () => {
  it('maps the allowed extensions case-insensitively', () => {
    expect(mimeForImage('a.png')).toBe('image/png')
    expect(mimeForImage('a.GIF')).toBe('image/gif')
    expect(mimeForImage('a.bmp')).toBe('image/bmp')
    expect(mimeForImage('a.webp')).toBe('image/webp')
    expect(mimeForImage('a.jpeg')).toBe('image/jpeg')
    expect(mimeForImage('a.unknown')).toBe('image/jpeg')
  })
})

describe('isReapableImageFile', () => {
  it('matches screenshot- and clipboard- image files', () => {
    expect(isReapableImageFile('screenshot-123.jpg')).toBe(true)
    expect(isReapableImageFile('clipboard-123.png')).toBe(true)
    expect(isReapableImageFile('clipboard-123.gif')).toBe(true)
  })
  it('ignores unrelated files', () => {
    expect(isReapableImageFile('catalogue.json')).toBe(false)
    expect(isReapableImageFile('clipboard-123.txt')).toBe(false)
    expect(isReapableImageFile('notes.png')).toBe(false)
  })
})
