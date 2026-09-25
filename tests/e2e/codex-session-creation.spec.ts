/**
 * E2E: a Codex saved config, created in the REAL packaged app and bound to a
 * Codex account (WP2).
 *
 * The first cut of this spec (P1.4) opened a "New Terminal Config" entry that
 * no longer exists, and skipped itself when it could not find it: both tests
 * skipped on every run and proved nothing (mode-matrix evidence, 2026-09-25).
 * It now drives the current UI, the sidebar's Saved tab and its "+ New",
 * Config, which opens "New saved config", and it never skips: a missing
 * precondition fails with a message saying which.
 *
 * Verifies:
 *   1. the Provider cards: Codex is offered on Local and refused over SSH in
 *      both directions (SSH first greys the Codex card with the reason;
 *      Codex first greys the SSH cards and says Codex runs locally);
 *   2. with Codex on and one Codex account, the Codex card shows the Codex
 *      fields and the "Codex account" picker with that account preselected
 *      (the provider default); Create config persists a config with provider
 *      codex, on this computer, bound to that account by its opaque id, and
 *      it is listed in the Saved tab.
 *
 * The account is seeded, not signed in: a managed Codex account written to
 * the isolated data dir's account registry with the app's own registry
 * transitions (src/shared/providers), so the spec needs no OpenAI sign-in.
 *
 * Which Codex the app sees is the spec's, never the machine's
 * (helpers/fake-codex.ts): a fake at the release the app pins (supported),
 * first on the instance's PATH, every real Codex taken off it, and the
 * "sign-in already on this computer" it checks an empty folder of its own
 * (fakeCodexEnv). A real Codex older than the app's minimum used
 * to hold Create config back ("Update Codex to launch this config"). Test 2
 * checks the app found the fake before it relies on it. Creating a config
 * also launches it; what that launch does with the fake is not checked here.
 *
 * Runs against an isolated temp data dir (helpers/electron-app), so it never
 * touches real user config.
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'
import { installFakeCodex, signInFakeRealm, fakeCodexEnv, FAKE_CODEX_VERSION } from './helpers/fake-codex'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, checkRegistryInvariants, parseRegistryDoc,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc, RegistryResult } from '../../src/shared/providers'

// The seeded account: opaque ids (prefix + lowercase hex, as the app makes).
const HEX = 'e2e0c0de0000000000000001'
const IDENTITY_ID = `idn-${HEX}`
const ACCOUNT_ID = `acct-${HEX}`
const REALM_ID = `realm-${HEX}`
const ACCOUNT_NAME = 'E2E Codex'
const CONFIG_LABEL = 'E2E Codex config'

let ctx: IsolatedApp
let page: IsolatedApp['page']

function ok(r: RegistryResult, step: string): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`seeding the Codex account failed at ${step}: ${r.code}: ${r.message}`)
  return r.doc
}

/** Codex on, one managed Codex account in the registry, and Hello Codex
 *  already seen (its one-time takeover would otherwise cover the window). */
function seedCodexAccount(dataDir: string): void {
  const resources = path.join(dataDir, 'resources')
  const config = path.join(resources, 'CONFIG')

  const settingsFile = path.join(config, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, codexEnabled: true }, null, 2))

  const metaFile = path.join(config, 'app-meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, helloCodexSeenVersion: meta.setupVersion ?? 'seen' }, null, 2))

  let doc = emptyRegistry()
  doc = ok(createIdentity(doc, { id: IDENTITY_ID, friendlyName: ACCOUNT_NAME, colourKey: 'indigo' }, 1), 'createIdentity')
  doc = ok(beginAccountSetup(doc, {
    accountId: ACCOUNT_ID, realmId: REALM_ID, providerId: 'codex', method: 'apiKey',
    realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${REALM_ID}`,
  }, 2), 'beginAccountSetup')
  doc = ok(commitAccountSetup(doc, ACCOUNT_ID, {
    identityId: IDENTITY_ID, authMethod: 'apiKey', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted',
  }, 3), 'commitAccountSetup')
  const problems = checkRegistryInvariants(doc)
  if (problems.length) throw new Error(`the seeded registry breaks its invariants: ${problems.join('; ')}`)
  const text = JSON.stringify(doc, null, 2)
  const parsed = parseRegistryDoc(JSON.parse(text))
  if (!parsed.ok) throw new Error(`the seeded registry does not parse back: ${JSON.stringify(parsed)}`)
  fs.mkdirSync(path.join(resources, 'providers'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'providers', 'registry.json'), text)
  // The account's own sign-in folder, where the app keeps it (realm-paths.ts),
  // signed in as far as the fake can tell.
  signInFakeRealm(path.join(resources, 'codex-realms', REALM_ID))
  installFakeCodex(fakeDir(dataDir))
}

const fakeDir = (dataDir: string) => path.join(dataDir, 'fake-codex')

test.beforeAll(async () => {
  ctx = await launchIsolatedApp({
    seedExtra: seedCodexAccount,
    env: (dataDir) => fakeCodexEnv(fakeDir(dataDir), path.join(dataDir, 'codex-home')),
  })
  page = ctx.page
})

test.afterAll(async () => {
  // Creating a config launches it; a launched session can outlive a graceful
  // close, and closeIsolatedApp tree-kills what is left.
  test.setTimeout(120000)
  await closeIsolatedApp(ctx)
})

const dialog = () => page.locator('[data-testid="session-dialog"]')
const provider = (v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] input[value="${v}"]`)
const providerCard = (v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] label:has(input[value="${v}"])`)
const transport = (v: string) => page.locator(`[role="radiogroup"][aria-label="Connection"] input[value="${v}"]`)
const transportCard = (v: string) => page.locator(`[role="radiogroup"][aria-label="Connection"] label:has(input[value="${v}"])`)

/** Open New saved config the way a user does: the sidebar's Saved tab, then
 *  "+ New", Config. A dialog left open by the test before is cancelled first. */
async function openNewConfig() {
  const cancel = page.locator('[data-testid="session-dialog-cancel"]')
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click()
    await expect(dialog()).toHaveCount(0)
  }
  const savedTab = page.locator('[data-testid="panel-tab-saved"]')
  await expect(savedTab, 'the sidebar\'s Saved tab (panel-tab-saved) is not there: the sidebar did not render').toBeVisible({ timeout: 10000 })
  await savedTab.click()
  const newButton = page.locator('[data-testid="new-button"]')
  await expect(newButton, 'the Saved tab has no "+ New" button (new-button)').toBeVisible({ timeout: 5000 })
  await newButton.click()
  const configItem = page.locator('[data-testid="new-menu-config"]')
  await expect(configItem, '"+ New" has no Config entry (new-menu-config)').toBeVisible({ timeout: 5000 })
  await configItem.click()
  await expect(dialog(), 'New saved config did not open').toBeVisible({ timeout: 10000 })
  await expect(dialog().getByText('New saved config', { exact: true })).toBeVisible()
}

test.describe('Codex saved config (WP2 account binding)', () => {
  test('the Provider cards: Codex on Local, refused over SSH in both directions', async () => {
    await openNewConfig()
    await expect(providerCard('claude')).toBeVisible()
    await expect(providerCard('codex')).toBeVisible()
    await expect(providerCard('terminal')).toBeVisible()
    await expect(provider('codex'), 'Codex is off in this app: the seed turns it on (codexEnabled)').toBeEnabled()

    // SSH first: the Codex card is greyed, and says why.
    await providerCard('claude').click()
    await transportCard('ssh').click()
    await expect(provider('codex')).toBeDisabled()
    await expect(page.locator('[data-testid="codex-ssh-note"]')).toHaveText("Codex can't run over SSH in this release. Choose Claude Code or Terminal only.")

    // Codex first: SSH and SSH Persistent are greyed, and it says Codex is local.
    await transportCard('local').click()
    await expect(provider('codex')).toBeEnabled()
    await providerCard('codex').click()
    await expect(provider('codex')).toBeChecked()
    await expect(transport('ssh')).toBeDisabled()
    await expect(transport('ssh-persistent')).toBeDisabled()
    await expect(page.locator('[data-testid="codex-local-note"]')).toHaveText('Codex runs on this computer only in this release.')
  })

  test('a Codex config is created bound to the Codex account, and listed in the Saved tab', async () => {
    // A real create also launches the config: headroom.
    test.setTimeout(120000)

    // The app sees the spec's Codex, not the machine's: main's own check,
    // asked afresh (the Providers card's Check again).
    const discovered = await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { providerAccounts: { discover: (id: string) => Promise<unknown> } } }).electronAPI
      return api.providerAccounts.discover('codex')
    }) as { ok: boolean; installation?: { discoveryState?: string; version?: string; compatibility?: string } }
    expect(discovered.ok, `main could not check Codex: ${JSON.stringify(discovered)}`).toBe(true)
    expect(
      discovered.installation,
      `the app did not find the spec's fake Codex ${FAKE_CODEX_VERSION} first on its PATH: ${JSON.stringify(discovered.installation)}`,
    ).toMatchObject({ discoveryState: 'found', version: FAKE_CODEX_VERSION, compatibility: 'supported' })

    await openNewConfig()
    await providerCard('codex').click()
    await transportCard('local').click()
    // Nothing in the dialog about the CLI: found, and a version it launches.
    await expect(page.locator('[data-testid="codex-cli-missing"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="codex-too-old"]')).toHaveCount(0)

    // The Codex fields, and no Claude-only ones.
    await expect(dialog().getByText('Reasoning effort').first()).toBeVisible()
    await expect(dialog().getByText('Permissions').first()).toBeVisible()
    await expect(dialog().getByText('Starting model')).toHaveCount(0)

    // The account picker, with the seeded account preselected (the default).
    const noAccount = page.locator('[data-testid="codex-no-account"]')
    await expect(noAccount, 'the dialog says there is no Codex account: the seeded registry was not loaded').toHaveCount(0)
    const picker = page.locator('[data-testid="codex-account-select"]')
    await expect(picker, 'no "Codex account" picker: the Accounts snapshot has not reached the dialog').toBeVisible({ timeout: 15000 })
    await expect(picker).toHaveValue(ACCOUNT_ID)
    await expect(picker.locator(`option[value="${ACCOUNT_ID}"]`)).toHaveText(`${ACCOUNT_NAME} (Default)`)
    await picker.selectOption(ACCOUNT_ID)

    await page.locator('input[placeholder*="path"]').first().fill(ctx.dataDir)
    await page.locator('input[placeholder="e.g. App Dev"]').fill(CONFIG_LABEL)

    // Nothing holds the button back (a Codex too old to launch, an account
    // needing attention): say what did, rather than time out on a click.
    const validation = page.locator('[data-testid="session-dialog-validation"]')
    await expect(validation, 'Create config is held back').toHaveText('')
    await page.locator('[data-testid="session-dialog-submit"]').click()
    await expect(dialog()).toHaveCount(0, { timeout: 15000 })

    // Persisted: provider codex, on this computer, bound to the account.
    const configsPath = path.join(ctx.dataDir, 'resources', 'CONFIG', 'configs.json')
    type Saved = { label?: string; provider?: string; sessionType?: string; providerAccountId?: string; codexOptions?: { permissionsPreset?: string } }
    const read = (): Saved | null => {
      if (!fs.existsSync(configsPath)) return null
      try {
        const list = JSON.parse(fs.readFileSync(configsPath, 'utf8')) as Saved[]
        return list.find((c) => c.label === CONFIG_LABEL) ?? null
      } catch {
        return null // a torn read mid-write: poll again
      }
    }
    await expect.poll(() => read()?.providerAccountId ?? null, { timeout: 30000, intervals: [500] }).toBe(ACCOUNT_ID)
    const saved = read()!
    expect(saved.provider).toBe('codex')
    expect(saved.sessionType).toBe('local')
    expect(saved.codexOptions?.permissionsPreset).toBeTruthy()

    // Listed in the Saved tab. The create launched it and the sidebar followed
    // the new session to Running, so open Saved first.
    await page.locator('[data-testid="panel-tab-saved"]').click()
    await expect(page.getByTestId('saved-tab').getByText(CONFIG_LABEL)).toBeVisible({ timeout: 15000 })
  })
})
