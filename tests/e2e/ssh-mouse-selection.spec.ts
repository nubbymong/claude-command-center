/**
 * E2E (#546): the USER-VISIBLE fixed state, exercised in the REAL app + REAL
 * xterm (no mocks) — a drag selects terminal text and right-click copies it.
 *
 * What #546 changes (unit-tested in ssh-mouse-parity / classic-mouse-env /
 * ssh-tmux): the SSH launch now sets CLAUDE_CODE_DISABLE_MOUSE and forces tmux
 * `mouse off`, so the remote program never turns xterm's mouse tracking on. With
 * mouse tracking off, xterm owns the mouse and selection works — the parity the
 * fix restores for SSH sessions. This test proves that end state in the real
 * renderer: drag → right-click → the selection lands on the OS clipboard.
 *
 * SCOPE / honesty:
 *  - This drives a LOCAL shell-only PTY (an SSH remote can't be stood up in the
 *    harness). It proves the renderer-side CONSEQUENCE of the fix's lever
 *    (tracking off ⇒ selection works); that the main process actually sets that
 *    lever for SSH is covered by the unit tests above.
 *  - The BUG state (tracking ON ⇒ selection suppressed) is NOT e2e'd: on Windows
 *    a local ConPTY shell does not forward an application mouse-mode DECSET to
 *    xterm (verified — no ESC[< mouse report reaches the PTY), so the tracking
 *    state can't be induced locally. That direction is unit-covered by
 *    decideContextMenuAction/resolveContextMenuIntent (terminalInput tests).
 *
 * The observable is the OS CLIPBOARD (CCC copies selection via
 * navigator.clipboard) — canvas-independent, unlike xterm's WebGL glyphs, which
 * have no DOM text to read (see session-dialog-permutations.spec.ts).
 *
 * Windows-only (uses a powershell terminal config).
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

const MARKER = 'CCCE2ESELECT546'

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  test.setTimeout(120000)
  await closeIsolatedApp(ctx)
})

async function openDialog() {
  const cancel = page.locator('button:has-text("Cancel")').first()
  if (await cancel.isVisible().catch(() => false)) await cancel.click()
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
}

test.describe('#546 SSH mouse-selection: fixed state in the real app', () => {
  test.skip(process.platform !== 'win32', 'uses a powershell terminal config')

  test('mouse tracking off → drag selects, right-click copies (parity with local)', async () => {
    test.setTimeout(180000)

    // A Terminal-only local config → a real shell-only PTY with a mounted xterm.
    await openDialog()
    await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="terminal"])').click()
    await page.locator('[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="local"])').click()
    await expect(page.locator('text=Terminal startup')).toBeVisible({ timeout: 10000 })
    await page.locator('input[placeholder="npm run dev"]').fill('echo ready')
    await page.locator('input[placeholder="e.g. App Dev"]').fill('E2E Mouse Sel')
    await page.locator('button:has-text("Create config")').click()

    // The active terminal exposes its session id + a real .xterm-screen.
    const term = page.locator('[data-terminal-active]').first()
    await expect(term).toBeVisible({ timeout: 30000 })
    const sid = await term.getAttribute('data-terminal-session')
    expect(sid, 'active terminal must expose data-terminal-session').toBeTruthy()
    await page.waitForTimeout(3000) // let the shell reach its prompt

    // Print a unique, selectable marker line via the session's PTY.
    await page.evaluate(
      ([id, t]) => (window as unknown as { electronAPI: any }).electronAPI.pty.write(id, t),
      [sid as string, `Write-Host '${MARKER}'\r`] as const,
    )
    await page.waitForTimeout(1200)

    // Drag across the whole visible screen, then right-click its centre. With
    // mouse tracking off (a plain shell), the drag selects and the right-click
    // copies (decideContextMenuAction: hasSelection → 'copy').
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText(''))
    const screen = page.locator('[data-terminal-active] .xterm-screen').first()
    await expect(screen).toBeVisible()
    const box = await screen.boundingBox()
    if (!box) throw new Error('no .xterm-screen box')
    await page.mouse.move(box.x + 4, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 25 })
    await page.mouse.up()
    await page.waitForTimeout(150)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await page.waitForTimeout(300)

    const clip = await ctx.app.evaluate(({ clipboard }) => clipboard.readText())
    await page.screenshot({ path: 'test-results/546-selection-copied.png' }).catch(() => {})

    expect(
      clip.includes(MARKER),
      `drag+right-click should have copied the selection (incl. ${MARKER}); clipboard was:\n${clip.slice(0, 500)}`,
    ).toBe(true)
  })
})
