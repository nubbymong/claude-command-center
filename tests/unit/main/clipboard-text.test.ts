// [host] Electron 44's clipboard.readText() returns a Promise; the mock below
// has that shape (tests/unit/setup.ts), so these cases fail against a reader
// that does not await it.
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
    readText.mockResolvedValue('hello')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('hello')
    // Short-circuits: the common case must cost one read and no delay.
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds when the first read is empty but a later one is not', async () => {
    // The Windows delayed-render case, same as the image path: the source app
    // renders the format lazily, so the FIRST read after the window gains focus
    // comes back empty even though text is present. A one-shot read concludes
    // "nothing to paste", which is the bug. Electron 44 answers with a Promise,
    // which is always truthy: a read that is not awaited ends the retry at once.
    readText.mockResolvedValueOnce('').mockResolvedValueOnce('dictated text')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('dictated text')
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('gives up and returns empty string when every attempt is empty', async () => {
    readText.mockResolvedValue('')

    expect(await readClipboardTextWithRetry(4, 20, noSleep)).toBe('')
    expect(readText).toHaveBeenCalledTimes(4)
  })

  it('treats a rejected read as empty and keeps retrying (Electron 44)', async () => {
    // A failed read must degrade to "nothing to paste", never break the paste
    // keybinding or reject into the renderer.
    readText
      .mockRejectedValueOnce(new Error('clipboard busy'))
      .mockResolvedValueOnce('recovered')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('recovered')
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('resolves empty when every read rejects', async () => {
    readText.mockRejectedValue(new Error('clipboard busy'))

    await expect(readClipboardTextWithRetry(2, 20, noSleep)).resolves.toBe('')
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('treats a synchronous throw as empty too', async () => {
    readText
      .mockImplementationOnce(() => { throw new Error('clipboard busy') })
      .mockResolvedValueOnce('recovered')

    expect(await readClipboardTextWithRetry(3, 20, noSleep)).toBe('recovered')
  })

  it('answers a string: a read that resolves to anything else is empty', async () => {
    for (const odd of [undefined, null, 42, { text: 'x' }]) {
      readText.mockReset()
      readText.mockResolvedValue(odd)
      await expect(readClipboardTextWithRetry(1, 20, noSleep), String(odd)).resolves.toBe('')
    }
  })

  it('always reads at least once even if given a nonsense attempt count', async () => {
    readText.mockResolvedValue('x')

    expect(await readClipboardTextWithRetry(0, 20, noSleep)).toBe('x')
    expect(readText).toHaveBeenCalledTimes(1)
  })
})
