/**
 * [host] Unit 5 W1 (BUG-8 fallback), PR-level ADR-009 round 1 (D6): an image FILE
 * copied in Explorer or Finder is copied into the screenshots folder only when
 * the path the clipboard names is a plain file; anything else (a folder named
 * like an image, a device) is no image, and nothing is copied. The clipboard
 * and the file system are faked: nothing real is read or written.
 *
 * Electron 44: the clipboard is read with clipboard.read() (ClipboardItem[]); a
 * copied file arrives as `text/uri-list` (file:// URIs), the only format read
 * for it (Electron 44 does not offer Windows' FileNameW). The fake below has
 * that shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pathToFileURL } from 'url'

const PICKED = process.platform === 'win32' ? 'C:\\Users\\me\\Pictures\\shot.png' : '/Users/me/Pictures/shot.png'
/** A png copied in Explorer from \\localhost\c$ (Windows hands it over as file://localhost/c$/...). */
const ON_LOCALHOST_SHARE = '\\\\localhost\\c$\\Users\\me\\Pictures\\shot.png'

type FakeItem = { types: string[]; getType: (t: string) => Promise<Blob> }
const h = vi.hoisted(() => ({
  isFile: true,
  copies: [] as Array<[string, string]>,
  made: [] as string[],
  statted: [] as string[],
  items: [] as unknown[],
  readError: null as Error | null,
  reads: 0,
}))

function item(payloads: Record<string, string | Buffer>): FakeItem {
  return {
    types: Object.keys(payloads),
    getType: async (t: string) => {
      if (!(t in payloads)) throw new Error(`type ${t} not present`)
      const v = payloads[t]
      return new Blob([typeof v === 'string' ? v : new Uint8Array(v)])
    },
  }
}

const URI_LIST = 'text/uri-list'
const FILENAMEW = 'electron application/osclipboard;format="FileNameW"'

vi.mock('electron', () => ({
  clipboard: {
    read: async () => {
      h.reads += 1
      if (h.readError) throw h.readError
      return h.items
    },
  },
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: (p: string) => {
      h.statted.push(p)
      if (p === PICKED || p === ON_LOCALHOST_SHARE) return { size: 1024, isFile: () => h.isFile }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
    mkdirSync: (p: string) => { h.made.push(p) },
    copyFileSync: (from: string, to: string) => { h.copies.push([from, to]) },
  }
})

const { readClipboardImageFilePath, readClipboardFilePaths } = await import('../../../src/main/clipboard-file')
const SHOTS = process.platform === 'win32' ? 'C:\\res\\screenshots' : '/res/screenshots'
const realPlatform = process.platform
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true })

beforeEach(() => {
  h.isFile = true; h.copies.length = 0; h.made.length = 0; h.statted.length = 0
  h.items = [item({ [URI_LIST]: `${pathToFileURL(PICKED).href}\r\n` })]
  h.readError = null; h.reads = 0
})
afterEach(() => { onPlatform(realPlatform) })

// Copied files are read on Windows and macOS only, as before.
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('readClipboardImageFilePath copies only a plain file', () => {
  it('a plain image file named by text/uri-list is copied into the screenshots folder, keeping its extension', async () => {
    const r = await readClipboardImageFilePath(SHOTS)
    expect(h.copies).toHaveLength(1)
    expect(h.copies[0][0]).toBe(PICKED)
    expect(r).toEqual({ path: h.copies[0][1] })
    expect(h.copies[0][1].startsWith(SHOTS)).toBe(true)
    expect(h.copies[0][1].endsWith('.png')).toBe(true)
  })

  it('a path that is not a plain file (a folder named like an image, a device) is no image, and nothing is copied', async () => {
    h.isFile = false
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.copies).toEqual([])
    expect(h.made).toEqual([])
  })

  it('the picked file is stat-ed once: its size and whether it is a plain file come from the same stat', async () => {
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ path: h.copies[0][1] })
    expect(h.statted).toEqual([PICKED])
  })

  it('the first image among several copied files is the one taken', async () => {
    const other = process.platform === 'win32' ? 'C:\\Users\\me\\notes.txt' : '/Users/me/notes.txt'
    h.items = [item({ [URI_LIST]: [pathToFileURL(other).href, pathToFileURL(PICKED).href].join('\r\n') })]
    expect(await readClipboardFilePaths()).toEqual([other, PICKED])
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ path: h.copies[0][1] })
    expect(h.copies[0][0]).toBe(PICKED)
  })

  it('a clipboard read that fails is no image, and never an error into the paste path', async () => {
    h.readError = new Error('clipboard busy')
    await expect(readClipboardImageFilePath(SHOTS)).resolves.toEqual({ error: 'no-image' })
    expect(h.copies).toEqual([])
  })

  it('a clipboard with no copied file (text only) is no image, and nothing is stat-ed', async () => {
    h.items = [item({ 'text/plain': PICKED })]
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.statted).toEqual([])
  })
})

describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a copied image file that is gone', () => {
  it('is no image, not too large, and nothing is copied', async () => {
    const gone = process.platform === 'win32' ? 'C:\\Users\\me\\Pictures\\gone.png' : '/Users/me/Pictures/gone.png'
    h.items = [item({ [URI_LIST]: `${pathToFileURL(gone).href}\r\n` })]
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.copies).toEqual([])
  })
})

describe.runIf(process.platform === 'win32')('Windows: shares, pipes and the device namespaces', () => {
  it('a png copied from \\\\localhost\\c$ (file://localhost/c$/...) is copied like any other', async () => {
    h.items = [item({ [URI_LIST]: 'file://localhost/c$/Users/me/Pictures/shot.png\r\n' })]
    expect(await readClipboardFilePaths()).toEqual([ON_LOCALHOST_SHARE])
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ path: h.copies[0][1] })
    expect(h.copies[0][0]).toBe(ON_LOCALHOST_SHARE)
  })

  it('Windows FileNameW alone is not read: Electron 44 never offers it, and Explorer copies arrive as text/uri-list', async () => {
    h.items = [item({ [FILENAMEW]: Buffer.from(`${PICKED}\0`, 'ucs2') })]
    expect(await readClipboardFilePaths()).toEqual([])
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.statted).toEqual([])
  })

  it('a text/uri-list naming a pipe (file://./pipe/...) is never stat-ed', async () => {
    h.items = [item({ [URI_LIST]: 'file://./pipe/shot.png\r\n' })]
    expect(await readClipboardImageFilePath(SHOTS)).toEqual({ error: 'no-image' })
    expect(h.statted).toEqual([])
  })

  it('a text/uri-list naming the pipe, mailslot or IPC$ share of this or any computer is never stat-ed', async () => {
    for (const u of ['file://127.0.0.1/pipe/shot.png', 'file://localhost/pipe/shot.png', 'file://localhost/PIPE/shot.png',
      'file://server/mailslot/shot.png', 'file://localhost/IPC$/shot.png', 'file://127.0.0.1/pipe./shot.png',
      // PIPE and MAILSLOT once in upper case, as Windows compares share names: a dotless i, a long s
      'file://localhost/p%C4%B1pe/shot.png', 'file://127.0.0.1/ma%C4%B1lslot/shot.png', 'file://server/mail%C5%BFlot/shot.png', 'file://localhost/%C4%B1pc$/shot.png']) {
      h.items = [item({ [URI_LIST]: `${u}\r\n` })]
      expect(await readClipboardImageFilePath(SHOTS), u).toEqual({ error: 'no-image' })
    }
    expect(h.statted).toEqual([])
    expect(h.copies).toEqual([])
  })
})

describe('copied files are read on Windows and macOS only, as before', () => {
  it('Linux: no clipboard read at all, and no image', async () => {
    onPlatform('linux')
    expect(await readClipboardFilePaths()).toEqual([])
    expect(h.reads).toBe(0)
  })
})
