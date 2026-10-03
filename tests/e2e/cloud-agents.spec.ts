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
import fs from 'fs'
import path from 'path'
import { installFakeCodex, signInFakeRealm, fakeCodexEnv, readFakeExecRecords, FAKE_CODEX_VERSION } from './helpers/fake-codex'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, checkRegistryInvariants, parseRegistryDoc,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc, RegistryResult } from '../../src/shared/providers'

let ctx: IsolatedApp
let page: IsolatedApp['page']


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
  test.beforeAll(async () => {
    ctx = await launchIsolatedApp()
    page = ctx.page
  })

  test.afterAll(async () => {
    await closeIsolatedApp(ctx)
  })

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

// ---------------------------------------------------------------------------
// [VM] WP2 PR 4, P4.5 (row 57): a Codex cloud agent, end to end, on the
// spec's own fake Codex (helpers/fake-codex.ts, its `exec --json` mode),
// never the machine's: Codex on and answered, one managed Codex account
// seeded with the app's own registry transitions (no sign-in), the fake first
// on the instance's PATH. The folder picker is answered by main's own dialog
// module, stubbed for the run. Checked: New agent offers the assistant; the
// run is `codex exec` with the task on stdin, in the project as its working
// folder, no path in argv, read-only by default and workspace-write when Auto
// is ticked (section 10, question 7, default A); the reply reaches the page.
// ---------------------------------------------------------------------------

const CX_HEX = 'e2e0c0de00000000000000a5'
const CX_IDENTITY = `idn-${CX_HEX}`
const CX_ACCOUNT = `acct-${CX_HEX}`
const CX_REALM = `realm-${CX_HEX}`
const cxFakeDir = (dataDir: string) => path.join(dataDir, 'fake-codex')
const cxRealmDir = (dataDir: string) => path.join(dataDir, 'resources', 'codex-realms', CX_REALM)

function cxOk(r: RegistryResult, step: string): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`seeding the Codex account failed at ${step}: ${r.code}: ${r.message}`)
  return r.doc
}

/** Codex on and answered, Hello Codex seen, one managed Codex account. */
function seedCodexAgentAccount(dataDir: string): void {
  const config = path.join(dataDir, 'resources', 'CONFIG')
  const settingsFile = path.join(config, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, codexEnabled: true, codexAnswered: true }, null, 2))
  const metaFile = path.join(config, 'app-meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, helloCodexSeenVersion: meta.setupVersion ?? 'seen' }, null, 2))
  let doc = emptyRegistry()
  doc = cxOk(createIdentity(doc, { id: CX_IDENTITY, friendlyName: 'E2E Agent', colourKey: 'indigo' }, 1), 'createIdentity')
  doc = cxOk(beginAccountSetup(doc, {
    accountId: CX_ACCOUNT, realmId: CX_REALM, providerId: 'codex', method: 'apiKey',
    realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${CX_REALM}`,
  }, 2), 'beginAccountSetup')
  doc = cxOk(commitAccountSetup(doc, CX_ACCOUNT, {
    identityId: CX_IDENTITY, authMethod: 'apiKey', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted',
  }, 3), 'commitAccountSetup')
  const problems = checkRegistryInvariants(doc)
  if (problems.length) throw new Error(`the seeded registry breaks its invariants: ${problems.join('; ')}`)
  const parsed = parseRegistryDoc(JSON.parse(JSON.stringify(doc)))
  if (!parsed.ok) throw new Error(`the seeded registry does not parse back: ${JSON.stringify(parsed)}`)
  fs.mkdirSync(path.join(dataDir, 'resources', 'providers'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'resources', 'providers', 'registry.json'), JSON.stringify(doc, null, 2))
  signInFakeRealm(cxRealmDir(dataDir))
  installFakeCodex(cxFakeDir(dataDir))
}

test.describe('Cloud Agents on Codex (P4.5)', () => {
  let cx: IsolatedApp

  test.beforeAll(async () => {
    cx = await launchIsolatedApp({
      seedExtra: seedCodexAgentAccount,
      env: (dataDir) => fakeCodexEnv(cxFakeDir(dataDir), path.join(dataDir, 'codex-home')),
    })
  })

  test.afterAll(async () => {
    test.setTimeout(120000)
    await closeIsolatedApp(cx)
  })

  test('a Codex agent runs codex exec in its project, read-only by default and workspace-write with Auto', async () => {
    test.setTimeout(180000)
    const p = cx.page
    const project = path.join(cx.dataDir, 'agent-project')
    fs.mkdirSync(project, { recursive: true })
    // Browse answers with the project, through main's own dialog module.
    await cx.app.evaluate(({ dialog }, dir) => {
      ;(dialog as unknown as { showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }> }).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    }, project)
    // The app sees the spec's Codex, not the machine's.
    const discovered = await p.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { providerAccounts: { discover: (id: string) => Promise<unknown> } } }).electronAPI
      return api.providerAccounts.discover('codex')
    }) as { ok: boolean; installation?: { discoveryState?: string; version?: string } }
    expect(discovered.installation, JSON.stringify(discovered)).toMatchObject({ discoveryState: 'found', version: FAKE_CODEX_VERSION })

    const dialog = () => p.getByRole('dialog', { name: 'New agent' })
    const run = async (task: string, auto: boolean) => {
      await p.locator('aside [data-tour="nav-cloud-agents"]').click()
      await p.getByRole('button', { name: 'New agent' }).first().click()
      await expect(dialog()).toBeVisible({ timeout: 5000 })
      const codex = dialog().locator('[data-testid="new-agent-provider"] [data-provider="codex"]')
      await expect(codex, 'New agent offers no assistant choice: Codex is not on in this instance').toBeVisible({ timeout: 10000 })
      await codex.click()
      await dialog().locator('input[placeholder*="Auth Refactor"]').fill(auto ? 'Auto run' : 'Read-only run')
      await dialog().locator('textarea[placeholder*="Describe"]').fill(task)
      await dialog().getByRole('button', { name: 'Browse' }).click()
      await expect(dialog().getByText(project)).toBeVisible({ timeout: 5000 })
      await expect(dialog().getByText('Auto: workspace writes, no prompts, for this run')).toBeVisible()
      if (auto) await dialog().locator('[data-testid="new-agent-permissions"] input[type="checkbox"]').check()
      const dispatch = dialog().locator('[data-testid="new-agent-dispatch"]')
      await expect(dispatch, 'Dispatch is held back').toBeEnabled({ timeout: 10000 })
      await dispatch.click()
      await expect(dialog()).toHaveCount(0, { timeout: 10000 })
    }
    const sameDir = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

    // A character outside the BMP: stdin keeps it (PB5), the composer would not.
    const first = `List the files in this project. ${String.fromCodePoint(0x1F680)}`
    await run(first, false)
    await expect(p.getByText(`fake agent: ${first.length} characters, read-only`)).toBeVisible({ timeout: 60000 })
    await expect.poll(() => readFakeExecRecords(cxRealmDir(cx.dataDir)).length, { timeout: 30000 }).toBe(1)
    const one = readFakeExecRecords(cxRealmDir(cx.dataDir))[0]
    expect(one.args).toEqual(['--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(sameDir(one.cwd, project), `the run's working folder ${one.cwd} is not the project ${project}`).toBe(true)
    expect(one.taskLength).toBe(first.length)

    await run('Add a NOTES file.', true)
    await expect(p.getByText('fake agent: 17 characters, workspace-write')).toBeVisible({ timeout: 60000 })
    await expect.poll(() => readFakeExecRecords(cxRealmDir(cx.dataDir)).length, { timeout: 30000 }).toBe(2)
    const two = readFakeExecRecords(cxRealmDir(cx.dataDir))[1]
    expect(two.args).toEqual(['--json', '-s', 'workspace-write', '--skip-git-repo-check', '-'])
    expect(sameDir(two.cwd, project)).toBe(true)
  })
})
