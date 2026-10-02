/**
 * PR-level ADR-009 round 1 (A1): with a saved image, main says (off Windows)
 * whether the shell it spawns a local plain terminal and a partner shell with
 * (login-shell.ts localSessionShell) is
 * of the sh family, the shells Alt+V types a path into. Windows answers as
 * before. Nothing is read from the real clipboard and no file is written: the
 * readers are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: () => {} },
}))
const h = vi.hoisted(() => ({ shell: '/bin/bash', picked: { path: '/res/screenshots/clipboard-1.png' } as { path: string } | { error: 'no-image' } }))
vi.mock('../../../src/main/clipboard-image', () => ({ readClipboardImageWithRetry: async () => null }))
vi.mock('../../../src/main/clipboard-text', () => ({ readClipboardTextWithRetry: async () => '' }))
vi.mock('../../../src/main/clipboard-file', () => ({ readClipboardImageFilePath: () => h.picked }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))
vi.mock('../../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/login-shell')>()),
  localSessionShell: () => h.shell,
}))

const { registerClipboardHandlers } = await import('../../../src/main/ipc/clipboard-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
registerClipboardHandlers()
const saveImage = handlers.get(IPC.CLIPBOARD_SAVE_IMAGE)!

const realPlatform = process.platform
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
beforeEach(() => { h.shell = '/bin/bash'; h.picked = { path: '/res/screenshots/clipboard-1.png' } })
afterEach(() => { onPlatform(realPlatform) })

describe('clipboard:saveImage says whether a plain terminal\'s shell is of the sh family (PR-level ADR-009 round 1, A1)', () => {
  it('macOS and Linux: sh for a shell of the sh family, other for any other', async () => {
    for (const [p, shell, kind] of [['linux', '/bin/bash', 'sh'], ['darwin', '/bin/zsh', 'sh'], ['linux', '/bin/dash', 'sh'], ['linux', '/usr/bin/fish', 'other'], ['darwin', '/opt/homebrew/bin/nu', 'other'], ['linux', '/usr/bin/pwsh', 'other']] as const) {
      onPlatform(p)
      h.shell = shell
      expect(await saveImage({}), `${p} ${shell}`).toEqual({ path: '/res/screenshots/clipboard-1.png', posixShell: kind })
    }
  })

  it('Windows: the answer it always gave', async () => {
    onPlatform('win32')
    h.shell = '/usr/bin/fish'
    expect(await saveImage({})).toEqual({ path: '/res/screenshots/clipboard-1.png' })
  })

  it('no image: the error alone, on every platform', async () => {
    h.picked = { error: 'no-image' }
    for (const p of ['linux', 'win32'] as const) {
      onPlatform(p)
      expect(await saveImage({}), p).toEqual({ error: 'no-image' })
    }
  })
})
