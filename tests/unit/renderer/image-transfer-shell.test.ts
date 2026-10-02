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
    typeImagePathIntoShell('sh1', '/home/me/res/screenshots/clipboard-1.jpg', false, 'sh')
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

// PR-level ADR-009 round 1 (A1): off Windows a path is typed only into a shell
// main spawned of the sh family (main says which, with the saved image), and
// only when it holds no control character; otherwise nothing is typed and the
// caller shows where the image was saved. Windows (PowerShell) is unchanged.
describe('typeImagePathIntoShell types only into a shell of the sh family, a path with no control character (PR-level ADR-009 round 1, A1)', () => {
  it('macOS and Linux: typed into a shell of the sh family, and it says so', () => {
    expect(typeImagePathIntoShell('sh1', '/home/me/res/screenshots/clipboard-1.jpg', false, 'sh')).toBe(true)
    expect(h.writeSessionInput).toHaveBeenCalledWith('sh1', "'/home/me/res/screenshots/clipboard-1.jpg'")
  })

  it('macOS and Linux: a shell that is not of the sh family (fish, nu, pwsh ...), or none said, gets nothing', () => {
    for (const kind of ['other', undefined] as const) {
      h.writeSessionInput.mockReset()
      expect(typeImagePathIntoShell('sh1', '/home/me/res/screenshots/clipboard-1.jpg', false, kind), String(kind)).toBe(false)
      expect(h.writeSessionInput, String(kind)).not.toHaveBeenCalled()
    }
  })

  it('macOS and Linux: a path with a control character gets nothing, even into the sh family', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x15, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f]) {
      const c = String.fromCharCode(code)
      h.writeSessionInput.mockReset()
      expect(typeImagePathIntoShell('sh1', `/home/me/res${c}/screenshots/a.jpg`, false, 'sh'), code.toString(16)).toBe(false)
      expect(h.writeSessionInput, code.toString(16)).not.toHaveBeenCalled()
    }
    // The first and last characters past the controls are typed.
    for (const code of [0x20, 0xa0]) {
      h.writeSessionInput.mockReset()
      expect(typeImagePathIntoShell('sh1', `/home/me/res${String.fromCharCode(code)}/screenshots/a.jpg`, false, 'sh'), code.toString(16)).toBe(true)
    }
  })

  it('Windows: unchanged, typed whatever main said of a POSIX shell', () => {
    for (const kind of ['sh', 'other', undefined] as const) {
      h.writeSessionInput.mockReset()
      expect(typeImagePathIntoShell('sh1', 'C:\\res\\screenshots\\clipboard-1.jpg', true, kind), String(kind)).toBe(true)
      expect(h.writeSessionInput).toHaveBeenCalledWith('sh1', "'C:\\res\\screenshots\\clipboard-1.jpg'")
    }
  })
})
