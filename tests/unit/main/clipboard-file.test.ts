import { describe, it, expect } from 'vitest'
import { parseHdropBuffer, parseFileUrl, pickPasteableImage } from '../../../src/main/clipboard-file'

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

describe('parseHdropBuffer (Windows CF_HDROP)', () => {
  it('reads a single wide (UTF-16LE) path from a DROPFILES buffer', () => {
    const header = Buffer.alloc(20)
    header.writeUInt32LE(20, 0) // pFiles offset
    header.writeUInt8(1, 13)    // fWide = 1
    const body = Buffer.from('C:\\pics\\a.png' + '\0\0', 'ucs2')
    expect(parseHdropBuffer(Buffer.concat([header, body]))).toEqual(['C:\\pics\\a.png'])
  })
  it('reads multiple null-separated paths', () => {
    const header = Buffer.alloc(20)
    header.writeUInt32LE(20, 0)
    header.writeUInt8(1, 13)
    const body = Buffer.from('C:\\a.png\0C:\\b.jpg\0\0', 'ucs2')
    expect(parseHdropBuffer(Buffer.concat([header, body]))).toEqual(['C:\\a.png', 'C:\\b.jpg'])
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
