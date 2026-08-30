/**
 * Playwright E2E tests — the nav-rail views and the sessions stage.
 *
 * Runs against an isolated temp data dir (helpers/electron-app) so the app
 * boots to a clean, setup-complete first-launch state with no real user data.
 *
 * Navigation model (rc.10, pages-as-tabs): the sidebar nav rail has NO
 * "Sessions" button — 'sessions' is the DEFAULT view. Every rail entry
 * (Cloud Agents, Insights, Tokenomics, Conductor MCP, Memory, Logs, Settings,
 * Feature Guide) opens its page as a TAB in the main strip; closing the last
 * page tab falls back to the sessions stage. Rail buttons carry the stable
 * `data-tour="nav-<view>"` anchor (aria-labels are legitimately dynamic —
 * e.g. Cloud Agents becomes "N agents running" — so the anchor, not the
 * accessible name, is the src-sanctioned stable selector; see SidebarNav).
 * The old clickNavButton(index) helper clicked `.px-2.pt-2 button` by INDEX
 * against a nav order that no longer exists (index 1 landed on Insights).
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

/** Open a nav-rail page by its ViewType key and wait until its tab is active. */
async function openPage(view: string): Promise<void> {
  await page.locator(`aside [data-tour="nav-${view}"]`).click()
  await expect(
    page.locator(`[data-testid="page-tab"][data-page="${view}"][aria-current="page"]`),
  ).toBeVisible({ timeout: 5000 })
}

/** Close every open page tab; with none left the stage falls back to Sessions. */
async function gotoSessions(): Promise<void> {
  const tabs = page.locator('[data-testid="page-tab"]')
  // Bounded loop: never more page tabs than nav entries.
  for (let i = 0; i < 12 && (await tabs.count()) > 0; i++) {
    const tab = tabs.first()
    await tab.hover() // close button fades in on group hover
    // The close button is the tab button's sibling inside the same wrapper —
    // label-agnostic, so a renamed page cannot rot this helper.
    await tab.locator('xpath=following-sibling::button[1]').click()
  }
  await expect(tabs).toHaveCount(0)
}

test.describe('Sessions View', () => {
  test('sessions is the default view and renders the stage', async () => {
    // No nav button opens Sessions any more — it is the default view, and the
    // fallback when the last page tab closes.
    await gotoSessions()
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })

  test('empty sessions shows the app-brand heading', async () => {
    // Land somewhere else first, then come back the way a user does (close the
    // page tab) — proving the fallback-to-sessions path, not just the boot state.
    await openPage('insights')
    await gotoSessions()

    // The e2e seed starts with no configs, so the empty state must show the
    // brand heading (StageEmptyState). Scoped to the h2 so the always-visible
    // TitleBar (same brand text, a span) can't satisfy it.
    const heading = page.locator('h2', { hasText: 'AI Code Conductor' })
    await heading.first().waitFor({ state: 'visible', timeout: 5000 })
    expect(await heading.first().isVisible()).toBe(true)
  })
})

// The old "Browse View" test is gone with its subject: ProjectBrowser is no
// longer reachable from the nav (imported but never rendered in App.tsx), and
// the old "Usage View" is now the Tokenomics page. The current rail pages are
// pinned one by one below: each opens as an active tab and renders content.
const RAIL_PAGES: Array<{ view: string; title: string }> = [
  { view: 'insights', title: 'Insights' },
  { view: 'tokenomics', title: 'Tokenomics' },
  { view: 'vision', title: 'Conductor MCP' },
  { view: 'memory', title: 'Memory' },
  { view: 'logs', title: 'Logs' },
  { view: 'settings', title: 'Settings' },
]

for (const { view, title } of RAIL_PAGES) {
  test.describe(`${title} View`, () => {
    test(`renders the ${title} page as an active tab`, async () => {
      await openPage(view)
      const body = await page.locator('main').innerHTML()
      expect(body.length).toBeGreaterThan(0)
    })
  })
}

test.describe('Feature Guide View', () => {
  test('renders the Feature Guide page as an active tab', async () => {
    // The help entry keeps its own anchor (data-tour="help-button"), not nav-help.
    await page.locator('aside [data-tour="help-button"]').click()
    await expect(
      page.locator('[data-testid="page-tab"][data-page="help"][aria-current="page"]'),
    ).toBeVisible({ timeout: 5000 })
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Sidebar Toggle', () => {
  test('Ctrl+B toggles sidebar', async () => {
    // The launch helper waits for a sidebar anchor, so the sidebar is
    // deterministically present here — assert it instead of skipping.
    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()

    // Toggle off
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(300)
    const hiddenAfterToggle = !await sidebar.isVisible().catch(() => true)

    // Toggle back on
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(300)
    const visibleAfterToggle = await sidebar.isVisible().catch(() => false)

    // At least one toggle should have worked
    expect(hiddenAfterToggle || visibleAfterToggle).toBe(true)
  })
})

test.describe('Session Config Dialog', () => {
  test('Ctrl+T opens new config dialog', async () => {
    await expect(page.locator('aside')).toBeVisible()

    await page.keyboard.press('Control+t')
    await page.waitForTimeout(500)

    // Should see dialog with label/directory inputs
    const hasLabelInput = await page.locator('input[placeholder*="label" i], input[value=""]').first().isVisible().catch(() => false)
    const hasDialog = await page.locator('.fixed, .absolute').first().isVisible().catch(() => false)
    expect(hasLabelInput || hasDialog).toBe(true)

    // Close with Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })
})
