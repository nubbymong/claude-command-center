/**
 * E2E (#513): the Artifacts command-bar button renders for an account-backed
 * local session and its click is wired, in the REAL packaged app.
 *
 * The isolated harness has no account by default, so this seeds a primary
 * account profile (profiles.json) and a restored Claude local session bound to
 * it (session-state.json), resumes it, and asserts the Artifacts button appears
 * in the command bar and is clickable without crashing the app. The button's
 * exact click -> accountWeb.openArtifacts(profileId) mapping is unit-covered
 * (commandbar-artifacts-button.test.tsx); here we prove it surfaces and wires up
 * end-to-end for a real session.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { launchIsolatedApp, IsolatedApp } from './helpers/electron-app'

const PROFILE_ID = 'profile-e2e-artifacts'
const SESSION_LABEL = 'E2E Artifacts'

let ctx: IsolatedApp
let workDir: string

function seed(dataDir: string): void {
  // A primary account so the button resolves a profile.
  const profilesDir = path.join(dataDir, 'resources', 'account-profiles')
  fs.mkdirSync(profilesDir, { recursive: true })
  fs.writeFileSync(
    path.join(profilesDir, 'profiles.json'),
    JSON.stringify({ profiles: [{ id: PROFILE_ID, name: 'E2E Account', accountEmail: 'e2e@example.com', isPrimary: true }] }, null, 2),
  )
  // A restored Claude x Local session bound to that profile (non-shell, so the
  // Artifacts button applies). It resumes into the working dir below.
  const state = {
    sessions: [{
      id: 'e2e-artifacts-sess',
      configId: 'e2e-artifacts-cfg',
      label: SESSION_LABEL,
      customName: SESSION_LABEL,
      workingDirectory: workDir,
      color: '#89b4fa',
      sessionType: 'local',
      shellOnly: false,
      provider: 'claude',
      profileId: PROFILE_ID,
      claudeOptions: { model: 'sonnet' },
    }],
    activeSessionId: 'e2e-artifacts-sess',
    savedAt: 1,
  }
  fs.writeFileSync(path.join(dataDir, 'resources', 'CONFIG', 'session-state.json'), JSON.stringify(state, null, 2))
}

test.beforeAll(async () => {
  test.setTimeout(120000)
  workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-artifacts-')))
  fs.mkdirSync(path.join(workDir, '.git'), { recursive: true })
  ctx = await launchIsolatedApp({ seedExtra: seed })
})

test.afterAll(async () => {
  // Hard-kill: a restored Claude session leaves a live PTY child that can hang a
  // graceful close.
  try {
    const pid = ctx?.app.process().pid
    if (pid) {
      if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
    }
  } catch { /* already gone */ }
  for (const d of [ctx?.dataDir, workDir]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

test.describe('#513 Artifacts button — account-backed session', () => {
  test('renders in the command bar and its click is wired (no crash)', async () => {
    test.setTimeout(90000)
    const page: Page = ctx.page

    // Resume the seeded session so its pane (and command bar) mount.
    const prompt = page.getByRole('dialog', { name: /Resume previous sessions/i })
    if (await prompt.isVisible().catch(() => false)) {
      await prompt.getByRole('button', { name: 'Resume' }).click()
    }
    await expect(page.locator('.session-card').filter({ hasText: SESSION_LABEL }).first()).toBeVisible({ timeout: 30000 })

    // The command bar's core tools render, and the Artifacts button is among them.
    await expect(page.locator('[data-testid="command-band-core"]').first()).toBeVisible({ timeout: 15000 })
    const artifacts = page.locator('[data-testid="artifacts-open"]').first()
    await expect(artifacts).toBeVisible({ timeout: 15000 })
    await expect(artifacts).toContainText('Artifacts')
    await page.screenshot({ path: test.info().outputPath('513-artifacts-in-bar.png') })
    await test.info().attach('513-artifacts-in-bar', { path: test.info().outputPath('513-artifacts-in-bar.png'), contentType: 'image/png' })

    // Clicking is wired: swallow any account-web dialog it raises (the seeded
    // account has no real partition), and confirm the app stays healthy.
    page.on('dialog', (d) => { void d.dismiss().catch(() => {}) })
    await artifacts.click()
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="command-band-core"]').first()).toBeVisible()
  })
})
