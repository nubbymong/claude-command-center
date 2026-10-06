// [host] Unit 5 W1: pure helpers for clipboard file references (BUG-8 fallback).
// Electron 44 hands copied files over as `text/uri-list` (an RFC 2483 list of
// file:// URIs), so the paths come from uriListToPaths, and every path passes
// isClipboardFilePath first. Both take the platform whose rules apply, so the
// Windows rules are checked on every OS.
import { describe, it, expect } from 'vitest'
import { hostname } from 'os'
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
  it('Windows: a UNC path on the pipe, mailslot or IPC$ share is refused on any server, in any case, with either slash', () => {
    const servers = ['127.0.0.1', 'localhost', 'LocalHost', hostname(), 'server', '..', '[::1]']
    const shares = ['pipe', 'PIPE', 'Pipe', 'mailslot', 'MailSlot', 'IPC$', 'ipc$', 'pipe.', 'pipe ', 'pipe. .', 'IPC$.']
    for (const server of servers) {
      for (const share of shares) {
        for (const p of [`\\\\${server}\\${share}\\shot.png`, `//${server}/${share}/shot.png`, `\\\\${server}\\${share}`]) {
          expect(isClipboardFilePath(p, 'win32'), p).toBe(false)
        }
      }
    }
  })
  it('Windows: a share name that reads PIPE, MAILSLOT or IPC$ in upper case, as Windows compares names, is refused (a dotless i or a long s included)', () => {
    const dotlessI = String.fromCharCode(0x131)
    const longS = String.fromCharCode(0x17f)
    const shares = [`p${dotlessI}pe`, `P${dotlessI}PE`, `ma${dotlessI}lslot`, `mail${longS}lot`, `ma${dotlessI}l${longS}lot`, `${dotlessI}pc$`, `p${dotlessI}pe. `]
    for (const server of ['127.0.0.1', 'localhost', hostname(), 'server']) {
      for (const share of shares) {
        for (const p of [`\\\\${server}\\${share}\\shot.png`, `//${server}/${share}/shot.png`]) {
          expect(isClipboardFilePath(p, 'win32'), p).toBe(false)
        }
      }
    }
  })
  it('Windows: any other share passes, a share named like those but longer included', () => {
    for (const p of ['\\\\localhost\\c$\\a.png', '\\\\127.0.0.1\\share\\a.png', '\\\\server\\pipes\\a.png', '\\\\server\\pipe2\\a.png', '\\\\server\\ipc\\a.png', '\\\\server\\my pipe\\a.png']) {
      expect(isClipboardFilePath(p, 'win32'), p).toBe(true)
    }
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

  describe('with the Windows rules (on every OS)', () => {
    it('file://localhost/<share>/ (a file copied from \\\\localhost\\<share>) is that UNC path, not a refused drive path', () => {
      expect(uriListToPaths('file://localhost/c$/Users/me/a.png', 'win32')).toEqual(['\\\\localhost\\c$\\Users\\me\\a.png'])
      expect(uriListToPaths('file://LOCALHOST/My%20Share/a%20b.png', 'win32')).toEqual(['\\\\localhost\\My Share\\a b.png'])
    })
    it('file://localhost/C:/ and file:/// with a drive are the drive path', () => {
      expect(uriListToPaths('file://localhost/C:/a.png\r\nfile:///D:/b.png\r\nfile://localhost/e|/c.png', 'win32')).toEqual(['C:\\a.png', 'D:\\b.png', 'e:\\c.png'])
    })
    it('a localhost URI keeps every other refusal: no share, an encoded slash or backslash, a NUL', () => {
      for (const u of ['file://localhost/', 'file://localhost/c$/a%2Fb.png', 'file://localhost/c$/a%5cb.png', 'file://localhost/c$/a%00.png', 'file:///c$/a.png']) {
        expect(uriListToPaths(u, 'win32'), u).toEqual([])
      }
    })
    it('a URI naming the pipe, mailslot or IPC$ share of any server never becomes a path', () => {
      for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', hostname().toLowerCase(), 'server']) {
        for (const share of ['pipe', 'PIPE', 'mailslot', 'IPC$', 'ipc%24', 'pipe.']) {
          const u = `file://${host}/${share}/shot.png`
          expect(uriListToPaths(u, 'win32'), u).toEqual([])
        }
      }
      expect(uriListToPaths('file://localhost/pipe/a.png\r\nfile://server/share/b.png', 'win32')).toEqual(['\\\\server\\share\\b.png'])
    })
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

  describe('with the macOS and Linux rules (on every OS)', () => {
    it('file://localhost/ is this computer, and another host is dropped', () => {
      expect(uriListToPaths('file://localhost/Users/me/a.png\r\nfile:///tmp/b.png\r\nfile://server/share/c.png', 'darwin')).toEqual(['/Users/me/a.png', '/tmp/b.png'])
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
  it('an image file whose size cannot be read (it is gone) is no image, not too large', () => {
    expect(pickPasteableImage(['/a/gone.png'], () => null)).toEqual({ error: 'no-image' })
  })
  it('the limit is 10 MB exactly: 10 MB is pasted, one byte more is too large', () => {
    expect(pickPasteableImage(['/a/shot.png'], () => 10 * MB)).toEqual({ path: '/a/shot.png' })
    expect(pickPasteableImage(['/a/shot.png'], () => 10 * MB + 1)).toEqual({ error: 'too-large' })
  })
  it('only raster images are pasted: an .svg, .tiff, .heic or .ico file is no image, whatever its size', () => {
    for (const p of ['/a/logo.svg', '/a/LOGO.SVG', '/a/scan.tiff', '/a/photo.heic', '/a/icon.ico']) {
      expect(pickPasteableImage([p], () => 1024), p).toEqual({ error: 'no-image' })
    }
    for (const p of ['/a/a.png', '/a/a.jpg', '/a/a.jpeg', '/a/a.gif', '/a/a.webp', '/a/a.bmp']) {
      expect(pickPasteableImage([p], () => 1024), p).toEqual({ path: p })
    }
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
