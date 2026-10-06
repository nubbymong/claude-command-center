// [host] Unit 5 W1: pure helpers for clipboard file references (BUG-8 fallback).
// Electron 44 hands copied files over as `text/uri-list` (an RFC 2483 list of
// file:// URIs), so the paths come from uriListToPaths, and every path, from
// the list or from Windows' raw FileNameW, passes isClipboardFilePath first.
import { describe, it, expect } from 'vitest'
import { uriListToPaths, isClipboardFilePath, pickPasteableImage, mimeForImage, isReapableImageFile } from '../../../src/main/clipboard-file'

const onWindows = process.platform === 'win32'

describe('isClipboardFilePath', () => {
  it('Windows: a drive path and a UNC share path pass', () => {
    expect(isClipboardFilePath('C:\\Users\\me\\a.png', 'win32')).toBe(true)
    expect(isClipboardFilePath('c:/Users/me/a.png', 'win32')).toBe(true)
    expect(isClipboardFilePath('\\\\server\\share\\a.png', 'win32')).toBe(true)
  })
  it('Windows: the device namespaces are refused, with either slash', () => {
    for (const p of ['\\\\.\\pipe\\a.png', '\\\\?\\C:\\a.png', '//./pipe/a.png', '//?/C:/a.png', '\\\\.\\C:\\a.png', '/\\.\\pipe\\a.png']) {
      expect(isClipboardFilePath(p, 'win32'), p).toBe(false)
    }
  })
  it('Windows: a relative, drive-relative or root-relative path is refused', () => {
    for (const p of ['a.png', 'pics\\a.png', 'C:a.png', '\\a.png', '\\\\server', '\\\\server\\']) {
      expect(isClipboardFilePath(p, 'win32'), p).toBe(false)
    }
  })
  it('macOS and Linux: an absolute path passes, a relative one does not', () => {
    expect(isClipboardFilePath('/Users/me/a.png', 'darwin')).toBe(true)
    expect(isClipboardFilePath('Users/me/a.png', 'darwin')).toBe(false)
    expect(isClipboardFilePath('C:\\a.png', 'linux')).toBe(false)
  })
  it('a path with a NUL, or no path, is refused on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(isClipboardFilePath(platform === 'win32' ? 'C:\\a\0.png' : '/a\0.png', platform)).toBe(false)
      expect(isClipboardFilePath('', platform)).toBe(false)
      expect(isClipboardFilePath(undefined as unknown as string, platform)).toBe(false)
    }
  })
})

describe('uriListToPaths (text/uri-list, RFC 2483)', () => {
  it('ignores comments, blank lines and anything that is not a file: URI', () => {
    const list = ['# copied by Explorer', '', 'https://example.com/a.png', 'mailto:x@y', 'C:\\not-a-uri.png'].join('\r\n')
    expect(uriListToPaths(list)).toEqual([])
    expect(uriListToPaths('')).toEqual([])
    expect(uriListToPaths(undefined as unknown as string)).toEqual([])
  })

  it('refuses an encoded slash or backslash inside a path segment', () => {
    expect(uriListToPaths(onWindows ? 'file:///C:/a%2Fb.png' : 'file:///a%2Fb.png')).toEqual([])
    expect(uriListToPaths(onWindows ? 'file:///C:/a%5Cb.png' : 'file:///a%2fb.png')).toEqual([])
  })

  it('drops a URI that decodes to a path with a NUL', () => {
    expect(uriListToPaths(onWindows ? 'file:///C:/a%00b.png' : 'file:///a%00b.png')).toEqual([])
  })

  describe.runIf(onWindows)('on Windows', () => {
    it('decodes each file URI to a drive path, percent-decoding, in order, CRLF or LF', () => {
      const list = 'file:///C:/Users/me/My%20Pics/a.png\r\nfile:///D:/caf%C3%A9.jpg\nfile:///c|/b.gif\r\n'
      expect(uriListToPaths(list)).toEqual(['C:\\Users\\me\\My Pics\\a.png', 'D:\\caf\u00e9.jpg', 'c:\\b.gif'])
    })
    it('a host becomes a UNC share path, as a file copied from a share in Explorer always was', () => {
      expect(uriListToPaths('file://server/share/a.png')).toEqual(['\\\\server\\share\\a.png'])
      expect(uriListToPaths('file://localhost/C:/a.png')).toEqual(['C:\\a.png'])
    })
    it('never yields a device-namespace path (a pipe or raw device a stat would open)', () => {
      expect(uriListToPaths('file://./pipe/a.png\r\nfile://./C:/a.png')).toEqual([])
    })
    it('a URI with no drive (not absolute on Windows) is dropped, and the rest are kept', () => {
      expect(uriListToPaths('file:///a.png\r\nfile:///C:/b.png')).toEqual(['C:\\b.png'])
    })
  })

  describe.runIf(!onWindows)('on macOS and Linux', () => {
    it('decodes each file URI to an absolute path, percent-decoding', () => {
      expect(uriListToPaths('file:///Users/me/My%20Pics/a.png\r\nfile://localhost/tmp/caf%C3%A9.png')).toEqual(['/Users/me/My Pics/a.png', '/tmp/caf\u00e9.png'])
    })
    it('a URI naming another host is dropped', () => {
      expect(uriListToPaths('file://server/share/a.png')).toEqual([])
    })
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
