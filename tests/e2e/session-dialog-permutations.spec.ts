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
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']
// Set by the PTY-launching spec below; cleaned up in afterAll, AFTER
// closeIsolatedApp's tree-kill has torn down the shell that owns it (#487
// audit: cleaning it up in-test raced the still-live shell and always failed).
let probeDirToClean: string | undefined

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  // Tearing down with a live PTY session can exceed the 30s hook default.
  test.setTimeout(120000)
  await closeIsolatedApp(ctx)
  if (probeDirToClean) {
    try {
      fs.rmSync(probeDirToClean, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (err) {
      console.warn(`[e2e] failed to remove probe dir ${probeDirToClean}: ${(err as Error).message}`)
    }
  }
})

/**
 * Open a fresh New-config dialog. These specs share one app instance, so an
 * already-open dialog would block the sidebar button — close it via Cancel.
 * (Escape does NOT close this dialog today; deliberately not added here since a
 * bare Escape-to-close would make silent data loss easier without the
 * unsaved-changes confirm.)
 */
async function openDialog() {
  const cancel = page.locator('button:has-text("Cancel")').first()
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click()
    await expect(page.locator('text=New saved config')).toHaveCount(0)
  }
  // Two-mode panel: open the Saved tab first (the panel defaults to Running),
  // then the central "+ New" button's Config option (#483).
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
}

// The radios are visually-hidden (sr-only) inputs inside styled <label> cards —
// that's what gives them the native ARIA radiogroup keyboard behaviour. A user
// clicks the CARD, so tests click the label and assert on the input.
const provider = (v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] input[value="${v}"]`)
const transport = (v: string) => page.locator(`[role="radiogroup"][aria-label="Where it runs"] input[value="${v}"]`)
const providerCard = (v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] label:has(input[value="${v}"])`)
const transportCard = (v: string) => page.locator(`[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="${v}"])`)

test.describe('SessionDialog — driven flow permutations', () => {
  test('a new config reveals itself: nothing until a provider is picked', async () => {
    await openDialog()
    // Transport is hidden until a provider is chosen, and the footer names the step.
    await expect(page.locator('[role="radiogroup"][aria-label="Where it runs"]')).toHaveCount(0)
    await expect(page.locator('text=Choose what this launcher runs')).toBeVisible()
    await expect(page.locator('text=Workspace')).toHaveCount(0)

    await providerCard('claude').click()
    await expect(page.locator('[role="radiogroup"][aria-label="Where it runs"]')).toBeVisible()
    await expect(page.locator('text=Choose where it runs')).toBeVisible()
    // Still nothing below until the transport is chosen.
    await expect(page.locator('text=Workspace')).toHaveCount(0)

    await transportCard('local').click()
    await expect(page.locator('text=Workspace')).toBeVisible()
    await expect(page.locator('text=Session startup')).toBeVisible()
    await expect(page.locator('text=Identity')).toBeVisible()
  })

  test('Claude Code × Local shows model / effort / permission / logging', async () => {
    await openDialog()
    await providerCard('claude').click()
    await transportCard('local').click()
    await expect(page.locator('text=Starting model')).toBeVisible()
    await expect(page.locator('text=Starting effort')).toBeVisible()
    await expect(page.locator('text=Permission mode')).toBeVisible()
    await expect(page.locator('text=Index conversation logs')).toBeVisible()
    await expect(page.locator('text=Working directory').first()).toBeVisible()
    // The GitHub section is deliberately NOT in this dialog yet (it needs the
    // account picker + autoDetected state); repo binding still happens through
    // the auto-detect banner. Pinned so re-adding it is a conscious change.
    await expect(page.locator('text=Repository')).toHaveCount(0)
  })

  test('Claude Code × SSH swaps in the SSH fields and drops local-only sections', async () => {
    await openDialog()
    await providerCard('claude').click()
    await transportCard('ssh').click()
    await expect(page.locator('text=Remote directory')).toBeVisible()
    await expect(page.locator('text=After connecting, run').first()).toBeVisible()
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
    await providerCard('claude').click()
    await transportCard('ssh').click()
    await expect(provider('codex')).toBeDisabled()
    await expect(page.locator("text=Codex can't run over SSH yet")).toBeVisible()
    // Codex first → SSH card disabled.
    await transportCard('local').click()
    await providerCard('codex').click()
    await expect(transport('ssh')).toBeDisabled()
    await expect(page.locator('text=Codex runs on this PC only')).toBeVisible()
  })

  test('Terminal only × Local shows the command / arguments / secret fields', async () => {
    await openDialog()
    await providerCard('terminal').click()
    await transportCard('local').click()
    await expect(page.locator('text=Terminal startup')).toBeVisible()
    await expect(page.locator('text=First-run command')).toBeVisible()
    await expect(page.locator('text=Secret argument')).toBeVisible()
    await expect(page.locator('text=Run as Administrator')).toBeVisible()
    // No AI settings for a plain terminal.
    await expect(page.locator('text=Starting model')).toHaveCount(0)
  })

  test('Terminal only × SSH points at the post-connect command instead', async () => {
    await openDialog()
    await providerCard('terminal').click()
    await transportCard('ssh').click()
    await expect(page.locator('text=After connecting, run').first()).toBeVisible()
    await expect(page.locator('text=First-run command')).toHaveCount(0)
  })

  test('Organise is a real disclosure, not a decorative pill', async () => {
    await openDialog()
    await providerCard('claude').click()
    await transportCard('local').click()
    // Collapsed by default. <details> keeps its content in the DOM, so assert
    // VISIBILITY rather than presence.
    await expect(page.locator('#ccc-group')).toBeHidden()
    await page.locator('summary:has-text("Organise")').click()
    await expect(page.locator('#ccc-group')).toBeVisible()
    await expect(page.locator('#ccc-section')).toBeVisible()
  })
})

test.describe('Terminal-only config actually runs its command', () => {
  // Spawning a PTY and waiting for a real process needs more than the 30s default.
  test('creates, launches, and the PTY runs the first-run command with the secret', async () => {
    test.setTimeout(180000)

    // A probe that records the argv it was launched with. Asserting on a FILE
    // rather than xterm's output is both stronger (it proves the secret arrived
    // as a real argv element, not just as pixels) and immune to xterm rendering
    // to a canvas, where there is no DOM text to read.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-probe-'))
    probeDirToClean = probeDir
    const probeJs = path.join(probeDir, 'probe.js')
    const probeOut = path.join(probeDir, 'argv.txt')
    fs.writeFileSync(
      probeJs,
      `require('fs').writeFileSync(${JSON.stringify(probeOut)}, 'ARGV=' + process.argv.slice(2).join('|') + '\\nCWD=' + process.cwd())`,
    )

    await openDialog()
    await providerCard('terminal').click()
    await transportCard('local').click()

    await page.locator('input[placeholder*="path"]').first().fill(probeDir)
    await page.locator('input[placeholder="npm run dev"]').fill('node')
    await page.locator('input[placeholder*="--port 4310"]').fill(`${probeJs.replace(/\\/g, '/')} --token {secret}`)
    await page.locator('input[type="password"]').first().fill('E2E-SECRET-9f3a')
    await page.locator('input[placeholder="e.g. App Dev"]').fill('E2E Terminal')

    await page.locator('button:has-text("Create config")').click()

    // Creating from the sidebar launches the config immediately.
    await expect(page.locator('text=E2E Terminal').first()).toBeVisible({ timeout: 30000 })

    await expect
      .poll(() => (fs.existsSync(probeOut) ? fs.readFileSync(probeOut, 'utf8') : ''),
        { timeout: 90000, intervals: [1000] })
      .toContain('ARGV=')

    const shown = fs.readFileSync(probeOut, 'utf8')
    // The secret reached the process as a REAL argv element, resolved from the
    // OS keychain via CCC_ARG_SECRET — never stored in the config file.
    expect(shown).toContain('--token|E2E-SECRET-9f3a')
    // …and it ran in the configured working directory (the cd landed first).
    expect(shown.toLowerCase()).toContain(probeDir.toLowerCase())
    // Cleanup happens in afterAll, AFTER the app (and its still-live shell) is
    // torn down -- see probeDirToClean above. Doing it here always raced the
    // shell that still owns probeDir as its cwd.
  })
})
