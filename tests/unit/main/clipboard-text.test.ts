import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clipboard } from 'electron'
import { readClipboardTextWithRetry } from '../../../src/main/clipboard-text'

const readText = clipboard.readText as unknown as ReturnType<typeof vi.fn>
// No-op sleep so the retry loop doesn't actually wait in tests.
const noSleep = () => Promise.resolve()

describe('readClipboardTextWithRetry (#145 terminal paste)', () => {
  beforeEach(() => {
    readText.mockReset()
  })

  it('returns text when the very first read is non-empty', async () => {
    readText.mockReturnValue('hello')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('hello')
    // Short-circuits: the common case must cost one read and no delay.
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds when the first read is empty but a later one is not', async () => {
    // The Windows delayed-render case, same as the image path: the source app
    // renders the format lazily, so the FIRST read after the window gains focus
    // comes back empty even though text is present. A one-shot read concludes
    // "nothing to paste" — which is the bug.
    readText.mockReturnValueOnce('').mockReturnValueOnce('dictated text')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('dictated text')
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('gives up and returns empty string when every attempt is empty', async () => {
    readText.mockReturnValue('')

    expect(await readClipboardTextWithRetry(4, 20, noSleep)).toBe('')
    expect(readText).toHaveBeenCalledTimes(4)
  })

  it('treats a thrown platform clipboard error as empty and keeps retrying', async () => {
    // A failed read must degrade to "nothing to paste", never break the paste
    // keybinding or reject into the renderer.
    readText
      .mockImplementationOnce(() => { throw new Error('clipboard busy') })
      .mockReturnValueOnce('recovered')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('recovered')
  })

  it('resolves empty when the clipboard throws on every attempt', async () => {
    readText.mockImplementation(() => { throw new Error('clipboard busy') })

    await expect(readClipboardTextWithRetry(2, 20, noSleep)).resolves.toBe('')
  })

  it('coerces a null/undefined read to empty string', async () => {
    readText.mockReturnValue(undefined)

    expect(await readClipboardTextWithRetry(1, 20, noSleep)).toBe('')
  })

  it('always reads at least once even if given a nonsense attempt count', async () => {
    readText.mockReturnValue('x')

    expect(await readClipboardTextWithRetry(0, 20, noSleep)).toBe('x')
    expect(readText).toHaveBeenCalledTimes(1)
  })
})
