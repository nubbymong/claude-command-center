/**
 * E2E: the rebuilt SessionDialog, driven in the REAL packaged app.
 *
 * Covers every provider × transport permutation of the choice-driven flow, and
 * — the part unit tests cannot reach — actually LAUNCHES a Terminal-only config
 * and asserts its first-run command ran in the spawned PTY with the secret
 * argument resolved from the OS keychain.
 *
 * Runs against an isolated temp data dir (helpers/electron-app), so it never
 * touches real user config.
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

/** Open a fresh New-config dialog (Escape first so a previous one can't stack). */
async function openDialog() {
  await page.keyboard.press('Escape').catch(() => {})
  await page.locator('[data-tour="new-config"]').first().click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
}

const provider = (v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] input[value="${v}"]`)
const transport = (v: string) => page.locator(`[role="radiogroup"][aria-label="Where it runs"] input[value="${v}"]`)

test.describe('SessionDialog — driven flow permutations', () => {
  test('a new config reveals itself: nothing until a provider is picked', async () => {
    await openDialog()
    // Transport is hidden until a provider is chosen, and the footer names the step.
    await expect(page.locator('[role="radiogroup"][aria-label="Where it runs"]')).toHaveCount(0)
    await expect(page.locator('text=Choose what this launcher runs')).toBeVisible()
    await expect(page.locator('text=Workspace')).toHaveCount(0)

    await provider('claude').click()
    await expect(page.locator('[role="radiogroup"][aria-label="Where it runs"]')).toBeVisible()
    await expect(page.locator('text=Choose where it runs')).toBeVisible()
    // Still nothing below until the transport is chosen.
    await expect(page.locator('text=Workspace')).toHaveCount(0)

    await transport('local').click()
    await expect(page.locator('text=Workspace')).toBeVisible()
    await expect(page.locator('text=Session startup')).toBeVisible()
    await expect(page.locator('text=Identity')).toBeVisible()
  })

  test('Claude Code × Local shows model/effort/permission, and GitHub only after a directory', async () => {
    await openDialog()
    await provider('claude').click()
    await transport('local').click()
    await expect(page.locator('text=Starting model')).toBeVisible()
    await expect(page.locator('text=Starting effort')).toBeVisible()
    await expect(page.locator('text=Permission mode')).toBeVisible()
    await expect(page.locator('text=Index conversation logs')).toBeVisible()
    // GitHub is driven by the working directory.
    await expect(page.locator('text=GitHub')).toHaveCount(0)
    await page.locator('input[placeholder*="path"]').first().fill('C:\\temp\\proj')
    await expect(page.locator('text=GitHub')).toBeVisible()
  })

  test('Claude Code × SSH swaps in the SSH fields and drops local-only sections', async () => {
    await openDialog()
    await provider('claude').click()
    await transport('ssh').click()
    await expect(page.locator('text=Remote directory')).toBeVisible()
    await expect(page.locator('text=After connecting, run')).toBeVisible()
    await expect(page.locator('text=Machine name')).toBeVisible()
    // Local-only: indexing never registers over SSH, GitHub detection shells local git.
    await expect(page.locator('text=Index conversation logs')).toHaveCount(0)
    await expect(page.locator('text=GitHub')).toHaveCount(0)
    // Exactly ONE directory field (the old dialog's dead local path is gone).
    await expect(page.locator('text=Working directory')).toHaveCount(0)
  })

  test('Codex × SSH is blocked in BOTH directions', async () => {
    await openDialog()
    // SSH first → Codex card disabled.
    await provider('claude').click()
    await transport('ssh').click()
    await expect(provider('codex')).toBeDisabled()
    await expect(page.locator("text=Codex can't run over SSH yet")).toBeVisible()
    // Codex first → SSH card disabled.
    await transport('local').click()
    await provider('codex').click()
    await expect(transport('ssh')).toBeDisabled()
    await expect(page.locator('text=Codex runs on this PC only')).toBeVisible()
  })

  test('Terminal only × Local shows the command / arguments / secret fields', async () => {
    await openDialog()
    await provider('terminal').click()
    await transport('local').click()
    await expect(page.locator('text=Terminal startup')).toBeVisible()
    await expect(page.locator('text=First-run command')).toBeVisible()
    await expect(page.locator('text=Secret argument')).toBeVisible()
    await expect(page.locator('text=Run as Administrator')).toBeVisible()
    // No AI settings for a plain terminal.
    await expect(page.locator('text=Starting model')).toHaveCount(0)
  })

  test('Terminal only × SSH points at the post-connect command instead', async () => {
    await openDialog()
    await provider('terminal').click()
    await transport('ssh').click()
    await expect(page.locator('text=After connecting, run')).toBeVisible()
    await expect(page.locator('text=First-run command')).toHaveCount(0)
  })

  test('Organise is a real disclosure, not a decorative pill', async () => {
    await openDialog()
    await provider('claude').click()
    await transport('local').click()
    // Collapsed by default; the group/section selects appear only once opened.
    await expect(page.locator('text=(optional — group & section)')).toBeVisible()
    await expect(page.locator('select#group')).toHaveCount(0)
    await page.locator('summary:has-text("Organise")').click()
    await expect(page.locator('select#group')).toBeVisible()
  })
})

test.describe('Terminal-only config actually runs its command', () => {
  test('creates, launches, and the PTY runs the first-run command with the secret', async () => {
    await openDialog()
    await provider('terminal').click()
    await transport('local').click()

    await page.locator('input[placeholder*="path"]').first().fill(process.env.TEMP || 'C:\\temp')
    await page.locator('input[placeholder="npm run dev"]').fill('echo')
    await page.locator('input[placeholder*="--port 4310"]').fill('CCC_E2E_MARKER {secret}')
    await page.locator('input[type="password"]').first().fill('E2E-SECRET-9f3a')
    await page.locator('input[placeholder="e.g. App Dev"]').fill('E2E Terminal')

    await page.locator('button:has-text("Create config")').click()

    // Creating from the sidebar launches the config straight away; the PTY runs
    // `echo CCC_E2E_MARKER $env:CCC_ARG_SECRET` after the cd, so the terminal
    // must show the marker AND the secret resolved from the keychain.
    const term = page.locator('.xterm-screen').first()
    await expect(term).toBeVisible({ timeout: 20000 })
    await expect
      .poll(async () => (await page.locator('.xterm-rows').first().innerText().catch(() => '')) || '',
        { timeout: 30000, intervals: [500] })
      .toContain('CCC_E2E_MARKER')
    const shown = await page.locator('.xterm-rows').first().innerText()
    expect(shown).toContain('E2E-SECRET-9f3a')
  })
})
