/**
 * Desktop verification for the launch-hold fix, against a REAL ConPTY in the
 * REAL app (no mocks): a write that lands while the launch line is still queued
 * must reach the launched program, not the bare shell that briefly precedes it.
 *
 * Driven through the app's own IPC rather than the UI, so it exercises
 * pty-manager end to end without depending on session-dialog selectors.
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

test.describe('PTY launch hold', () => {
  test('a write during the launch window lands after the launcher, and is not lost', async () => {
    test.setTimeout(60_000)

    const out = await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: any }).electronAPI
      const id = 'e2e-launch-hold-' + Date.now()
      const chunks: string[] = []
      const off = api.pty.onData(id, (d: string) => { chunks.push(d) })

      await api.pty.spawn(id, {
        cwd: 'C:\\',
        cols: 120,
        rows: 30,
        shellOnly: true,
        // The launcher command: this is what the 300ms timer writes.
        terminalOptions: { command: 'echo', args: 'CCC_LAUNCHER_RAN' },
      })

      // Immediately -- well inside the 300ms window. Before the fix this went
      // straight to the bare shell.
      api.pty.write(id, 'echo CCC_HELD_WRITE\r')

      await new Promise((r) => setTimeout(r, 8000))
      off?.()
      api.pty.kill(id)
      return chunks.join('')
    })

    // Strip ANSI so ordering is measured on text, not escape sequences.
    const clean = out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')

    // Both must have actually run: the launcher, and our held write. The write
    // being DELIVERED is half the fix -- holding it must not drop it.
    const launcherAt = clean.indexOf('CCC_LAUNCHER_RAN')
    const heldAt = clean.indexOf('CCC_HELD_WRITE')

    expect(launcherAt, `launcher never ran. Output:\n${clean.slice(0, 2000)}`).toBeGreaterThanOrEqual(0)
    expect(heldAt, `held write was LOST. Output:\n${clean.slice(0, 2000)}`).toBeGreaterThanOrEqual(0)
    expect(heldAt, `held write reached the shell BEFORE the launcher. Output:\n${clean.slice(0, 2000)}`)
      .toBeGreaterThan(launcherAt)
  })
})
