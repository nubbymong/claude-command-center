import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clipboard } from 'electron'
import { readClipboardImageWithRetry } from '../../../src/main/clipboard-image'

// Build a fake NativeImage whose isEmpty() returns a fixed value.
function fakeImage(empty: boolean) {
  return { isEmpty: () => empty } as unknown as Electron.NativeImage
}

const readImage = clipboard.readImage as unknown as ReturnType<typeof vi.fn>
// No-op sleep so the retry loop doesn't actually wait in tests.
const noSleep = () => Promise.resolve()

describe('readClipboardImageWithRetry (Alt+V first-attempt fix)', () => {
  beforeEach(() => {
    readImage.mockReset()
  })

  it('returns the image when the very first read is non-empty', async () => {
    const img = fakeImage(false)
    readImage.mockReturnValue(img)

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBe(img)
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds when the first read is empty but a later one is not', async () => {
    // This is the Windows delayed-render case: first read empty, then the
    // bitmap syncs in and the second read returns the image. Pre-fix, the
    // single-shot read reported "no image" here -- the first-attempt miss.
    const img = fakeImage(false)
    readImage
      .mockReturnValueOnce(fakeImage(true))
      .mockReturnValueOnce(img)

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBe(img)
    expect(readImage).toHaveBeenCalledTimes(2)
  })

  it('returns null only when every attempt is empty (genuinely no image)', async () => {
    readImage.mockReturnValue(fakeImage(true))

    const result = await readClipboardImageWithRetry(3, 20, noSleep)

    expect(result).toBeNull()
    expect(readImage).toHaveBeenCalledTimes(3)
  })

  it('respects a custom attempt count and reads at least once', async () => {
    readImage.mockReturnValue(fakeImage(true))

    expect(await readClipboardImageWithRetry(1, 20, noSleep)).toBeNull()
    expect(readImage).toHaveBeenCalledTimes(1)

    readImage.mockClear()
    // attempts < 1 is clamped to a single read.
    expect(await readClipboardImageWithRetry(0, 20, noSleep)).toBeNull()
    expect(readImage).toHaveBeenCalledTimes(1)
  })
})
