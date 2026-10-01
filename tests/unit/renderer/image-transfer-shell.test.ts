/**
 * P3.16a (U6): what Alt+V types into a plain terminal. The image's path, quoted
 * for the shell the terminal runs (shared/shell-quote.ts: PowerShell on Windows,
 * a POSIX shell elsewhere), and nothing else: no sentence for an assistant and
 * no Enter, because a shell reads no images and a submitted line would be run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ writeSessionInput: vi.fn() }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: h.writeSessionInput }))

const { typeImagePathIntoShell, composeShellImagePath } = await import('../../../src/renderer/utils/imageTransfer')

beforeEach(() => { h.writeSessionInput.mockReset() })

describe('typeImagePathIntoShell (Alt+V in a plain terminal)', () => {
  it('Windows: the path in single quotes (PowerShell), written once, with no Enter and no sentence', () => {
    typeImagePathIntoShell('sh1', 'C:\\res\\screenshots\\clipboard-1.jpg', true)
    expect(h.writeSessionInput).toHaveBeenCalledTimes(1)
    expect(h.writeSessionInput).toHaveBeenCalledWith('sh1', "'C:\\res\\screenshots\\clipboard-1.jpg'")
  })

  it('macOS and Linux: the path in single quotes (POSIX shell)', () => {
    typeImagePathIntoShell('sh1', '/home/me/res/screenshots/clipboard-1.jpg', false)
    expect(h.writeSessionInput).toHaveBeenCalledWith('sh1', "'/home/me/res/screenshots/clipboard-1.jpg'")
  })

  it('a path with spaces or a quote in it reaches the shell as one argument', () => {
    expect(composeShellImagePath("C:\\Users\\O'Neil\\my pics\\a.jpg", true)).toBe("'C:\\Users\\O''Neil\\my pics\\a.jpg'")
    expect(composeShellImagePath("/home/o'neil/my pics/a.jpg", false)).toBe("'/home/o'\\''neil/my pics/a.jpg'")
  })

  it('never carries a line end or the sentence an assistant is told', () => {
    for (const isWin32 of [true, false]) {
      const text = composeShellImagePath(isWin32 ? 'C:\\a\\b.jpg' : '/a/b.jpg', isWin32)
      expect(text).not.toMatch(/[\r\n]/)
      expect(text).not.toMatch(/pasted an image|please view/)
    }
  })
})
