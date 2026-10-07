// [host] Electron 44 removed clipboard.readImage(): the image is read with
// clipboard.read() (ClipboardItem[]) and getType(), then decoded with
// nativeImage.createFromBuffer. The electron mock (tests/unit/setup.ts) has
// that shape, so these cases fail against a reader still on the old calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clipboard, nativeImage } from 'electron'
import { readClipboardImageWithRetry } from '../../../src/main/clipboard-image'

// Build a fake NativeImage whose isEmpty() returns a fixed value.
function fakeImage(empty: boolean) {
  return { isEmpty: () => empty } as unknown as Electron.NativeImage
}

/** A ClipboardItem as clipboard.read() resolves it: types plus getType -> Blob. */
function item(payloads: Record<string, Buffer | string>) {
  return {
    types: Object.keys(payloads),
    getType: vi.fn(async (t: string) => {
      if (!(t in payloads)) throw new Error(`type ${t} not present`)
      const v = payloads[t]
      return new Blob([typeof v === 'string' ? v : new Uint8Array(v)])
    }),
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6])

const read = clipboard.read as unknown as ReturnType<typeof vi.fn>
const createFromBuffer = nativeImage.createFromBuffer as unknown as ReturnType<typeof vi.fn>
// No-op sleep so the retry loop doesn't actually wait in tests.
const noSleep = () => Promise.resolve()

describe('readClipboardImageWithRetry (Alt+V first-attempt fix, Electron 44 clipboard)', () => {
  beforeEach(() => {
    read.mockReset()
    createFromBuffer.mockReset()
    createFromBuffer.mockImplementation(() => fakeImage(false))
  })

  it('returns the image when the very first read carries a PNG, decoded from its bytes', async () => {
    const img = fakeImage(false)
    createFromBuffer.mockReturnValue(img)
    read.mockResolvedValue([item({ 'text/plain': 'x', 'image/png': PNG })])

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBe(img)
    expect(read).toHaveBeenCalledTimes(1)
    expect(createFromBuffer).toHaveBeenCalledTimes(1)
    expect(Buffer.compare(createFromBuffer.mock.calls[0][0], PNG)).toBe(0)
  })

  it('retries and succeeds when the first read has no image but a later one does', async () => {
    // This is the Windows delayed-render case: first read empty, then the
    // bitmap syncs in and the second read returns the image. Pre-fix, the
    // single-shot read reported "no image" here -- the first-attempt miss.
    const img = fakeImage(false)
    createFromBuffer.mockReturnValue(img)
    read
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item({ 'image/png': PNG })])

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBe(img)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('an image that decodes empty counts as no image yet, and is read again', async () => {
    const img = fakeImage(false)
    createFromBuffer.mockReturnValueOnce(fakeImage(true)).mockReturnValueOnce(img)
    read.mockResolvedValue([item({ 'image/png': PNG })])

    expect(await readClipboardImageWithRetry(3, 20, noSleep)).toBe(img)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('takes a JPEG when there is no PNG, and the PNG when there are both', async () => {
    read.mockResolvedValue([item({ 'image/jpeg': JPEG })])
    expect(await readClipboardImageWithRetry(1, 20, noSleep)).not.toBeNull()
    expect(Buffer.compare(createFromBuffer.mock.calls[0][0], JPEG)).toBe(0)

    createFromBuffer.mockClear()
    read.mockResolvedValue([item({ 'image/jpeg': JPEG }), item({ 'image/png': PNG })])
    expect(await readClipboardImageWithRetry(1, 20, noSleep)).not.toBeNull()
    expect(Buffer.compare(createFromBuffer.mock.calls[0][0], PNG)).toBe(0)
  })

  it('an image type nativeImage cannot decode is no image (nothing is decoded)', async () => {
    read.mockResolvedValue([item({ 'image/gif': Buffer.from('GIF89a'), 'text/uri-list': 'file:///C:/a.png' })])
    expect(await readClipboardImageWithRetry(2, 20, noSleep)).toBeNull()
    expect(createFromBuffer).not.toHaveBeenCalled()
  })

  it('a read that rejects, or a getType that rejects, is no image: never an error into the paste path', async () => {
    read.mockRejectedValue(new Error('clipboard busy'))
    await expect(readClipboardImageWithRetry(2, 20, noSleep)).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)

    read.mockReset()
    read.mockResolvedValue([{ types: ['image/png'], getType: async () => { throw new Error('gone') } }])
    await expect(readClipboardImageWithRetry(2, 20, noSleep)).resolves.toBeNull()

    read.mockReset()
    read.mockImplementation(() => { throw new Error('sync throw') })
    await expect(readClipboardImageWithRetry(1, 20, noSleep)).resolves.toBeNull()
  })

  it('returns null only when every attempt is empty (genuinely no image)', async () => {
    read.mockResolvedValue([item({ 'text/plain': 'just text' })])

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBeNull()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('respects a custom attempt count and reads at least once', async () => {
    read.mockResolvedValue([])

    expect(await readClipboardImageWithRetry(1, 20, noSleep)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)

    read.mockClear()
    // attempts < 1 is clamped to a single read.
    expect(await readClipboardImageWithRetry(0, 20, noSleep)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('defaults to 6 attempts so Windows delayed-render has time to land', async () => {
    // The default (no-arg) call is what both clipboard IPC handlers use. On
    // Windows the bitmap can take 50-200ms to materialise after focus, so the
    // default must retry enough times to outlast that, not give up at ~40ms.
    read.mockResolvedValue([])
    const result = await readClipboardImageWithRetry(undefined, undefined, noSleep)
    expect(result).toBeNull()
    expect(read).toHaveBeenCalledTimes(6)
  })
})
