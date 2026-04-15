import { Page } from '@playwright/test'

/**
 * Dismiss any modal overlays that might be blocking interaction.
 * Handles: WhatsNew modal, Setup dialog, Tip modal, Training walkthrough.
 */
export async function dismissModals(page: Page): Promise<void> {
  // Try to close WhatsNew modal (look for close button or backdrop)
  try {
    // WhatsNew modal has a close button - try clicking it
    const closeBtn = page.locator('button:has-text("Close")').first()
    if (await closeBtn.isVisible({ timeout: 2000 })) {
      await closeBtn.click()
      await page.waitForTimeout(500)
    }
  } catch {
    // No modal visible, that's fine
  }

  // Also try clicking any backdrop overlay (fixed inset-0 elements)
  try {
    const backdrop = page.locator('.fixed.inset-0.z-50').first()
    if (await backdrop.isVisible({ timeout: 500 })) {
      // Click the backdrop edge to dismiss
      await backdrop.click({ position: { x: 5, y: 5 } })
      await page.waitForTimeout(500)
    }
  } catch {
    // No backdrop visible
  }
}

/**
 * Wait for the app to be ready (past setup, config loaded, modals dismissed).
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000) // React hydration + config load
  await dismissModals(page)
}
