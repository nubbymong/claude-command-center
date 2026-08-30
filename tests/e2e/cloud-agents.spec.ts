/**
 * Playwright E2E tests — Cloud Agents page functionality
 *
 * Runs against an isolated temp data dir (helpers/electron-app) so the app
 * boots to a clean, setup-complete first-launch state with no real user data.
 *
 * Current page model (rc.10): navigation goes through the sidebar rail's
 * stable `data-tour="nav-cloud-agents"` anchor and the page opens as a TAB
 * (`data-testid="page-tab"` / `data-page="cloud-agents"`). With ZERO agents —
 * the only state this isolated harness can honestly reach, since dispatching
 * would run a real headless Claude — the page renders the AgentHubExamples
 * empty hub (explainer band + example cards + "New agent" CTA) INSTEAD of the
 * filter chips / search box / split panel, which mount only once at least one
 * agent exists (CloudAgentsPage gates them on counts.all > 0). The dispatch
 * dialog is the shared Dialog primitive: role="dialog" named "New agent".
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

const newAgentDialog = () => page.getByRole('dialog', { name: 'New agent' })

async function navigateToCloudAgents(): Promise<void> {
  // A dialog left open by an earlier test overlays the whole window and
  // intercepts pointer events — close it first (this is exactly how the old
  // spec wedged: its stale `h2:has-text("New Cloud Agent")` probe could not
  // see the renamed dialog, so it clicked into the overlay for 30s).
  const dialog = newAgentDialog()
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
  }
  await page.locator('aside [data-tour="nav-cloud-agents"]').click()
  await expect(
    page.locator('[data-testid="page-tab"][data-page="cloud-agents"][aria-current="page"]'),
  ).toBeVisible({ timeout: 5000 })
}

async function openNewAgentDialog(): Promise<void> {
  if (await newAgentDialog().isVisible().catch(() => false)) return
  await navigateToCloudAgents()
  await page.getByRole('button', { name: 'New agent' }).first().click()
  await expect(newAgentDialog()).toBeVisible({ timeout: 5000 })
}

test.describe('Cloud Agents Page', () => {
  test('renders the dashboard header', async () => {
    await navigateToCloudAgents()
    await expect(page.getByRole('button', { name: 'New agent' }).first()).toBeVisible()
  })

  test('shows New agent button', async () => {
    await navigateToCloudAgents()
    const newBtn = page.getByRole('button', { name: 'New agent' }).first()
    await expect(newBtn).toBeVisible()
  })

  test('empty hub shows examples instead of filter tabs', async () => {
    // The filter chips (All / Running / Done / Failed) mount only once agents
    // exist — with zero agents the page shows the examples hub in their place.
    // Pin BOTH sides of that gate.
    await navigateToCloudAgents()
    await expect(page.getByRole('heading', { name: 'No agents yet' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Refactor a module/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Write missing tests/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Audit dependencies/ })).toBeVisible()
    await expect(page.locator('button.rounded-full', { hasText: 'All' })).toHaveCount(0)
  })

  test('shows empty state when no agents', async () => {
    // Deterministic in the isolated harness (no agents can exist), so this is
    // a real assertion now — the old typeof-boolean check passed regardless.
    await navigateToCloudAgents()
    await expect(page.getByRole('heading', { name: 'No agents yet' })).toBeVisible()
  })

  test('empty hub has no search input, and the explainer band renders', async () => {
    // The "Search agents..." box lives in the same agents-gated chrome as the
    // filter chips. On the empty hub it is absent; the onboarding explainer
    // ("How cloud agents work") renders until dismissed.
    await navigateToCloudAgents()
    await expect(page.getByText('How cloud agents work')).toBeVisible()
    await expect(page.locator('input[placeholder="Search agents..."]')).toHaveCount(0)
  })

  test('New agent button opens dispatch dialog', async () => {
    await navigateToCloudAgents()
    await page.getByRole('button', { name: 'New agent' }).first().click()

    // Shared Dialog primitive: role="dialog" labelled by its "New agent" h2.
    await expect(newAgentDialog()).toBeVisible({ timeout: 2000 })
    await expect(newAgentDialog().getByRole('heading', { name: 'New agent' })).toBeVisible()
  })

  test('dispatch dialog has required fields', async () => {
    // Still open from the previous test, or reopen.
    await openNewAgentDialog()
    const dialog = newAgentDialog()

    await expect(dialog.locator('input[placeholder*="Auth Refactor"]')).toBeVisible()
    await expect(dialog.locator('textarea[placeholder*="Describe"]')).toBeVisible()
    await expect(dialog.locator('select').first()).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Browse' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Dispatch agent' })).toBeVisible()
  })

  test('dispatch button is disabled when fields are empty', async () => {
    await openNewAgentDialog()
    await expect(newAgentDialog().getByRole('button', { name: 'Dispatch agent' })).toBeDisabled()
  })

  test('cancel button closes dialog', async () => {
    await openNewAgentDialog()
    await newAgentDialog().getByRole('button', { name: 'Cancel' }).click()
    await expect(newAgentDialog()).not.toBeVisible()
  })

  test('empty hub fills the frame — no split panel without agents', async () => {
    // The 40%/60% split (agent list + detail) is agents-gated chrome like the
    // chips and search; with zero agents the examples hub owns the frame. Pin
    // the gate and the hub's CTA so this fails loudly if the layout returns.
    await navigateToCloudAgents()
    await expect(page.locator('.w-\\[40\\%\\]')).toHaveCount(0)
    await expect(page.getByText('Select an agent')).toHaveCount(0)
    // Two "New agent" buttons: the header action and the hub CTA.
    await expect(page.getByRole('button', { name: 'New agent' })).toHaveCount(2)
  })
})
