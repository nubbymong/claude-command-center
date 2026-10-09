/**
 * The account list the window reads at start waits for the start's profile
 * steps (the first account made from the user's own sign-in among them), so
 * the window never reads the list before they have run.
 *
 * Driven through the REAL list handler on a fake ipcMain, asked from the app's
 * own window; the steps are held on a gate the test opens (the account store's
 * settled promise, answered here), and the list is the account store's answer,
 * stood in and counted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))
const steps = vi.hoisted(() => ({ settled: Promise.resolve() as Promise<void>, open: () => {} }))
const listed = vi.hoisted(() => ({ reads: 0 }))
vi.mock('../../../src/main/account-profiles', () => ({
  listProfiles: () => { listed.reads++; return [{ id: 'primary', name: '', createdAt: 0, isPrimary: true }] },
  startProfileStepsSettled: () => steps.settled,
  upsertProfile: vi.fn(),
  isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
  safeTeardownProfile: vi.fn(),
  readProfileAccountEmail: vi.fn(),
  getProfileConfigDir: vi.fn(),
  createProfile: vi.fn(),
  captureDetectedAccount: vi.fn(),
  backupProfileHomeToCanonical: vi.fn(),
  restoreProfileIdentityFromCanonical: vi.fn(),
  readProfileCredentialStamp: vi.fn(),
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(), detectedNewAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: vi.fn(() => false), sessionsOnProfile: vi.fn(() => [] as string[]),
}))
vi.mock('../../../src/main/usage/account-usage', () => ({ fetchAllAccountsUsage: vi.fn(), fetchAllAccountsUsageStreaming: vi.fn(), fetchAccountUsage: vi.fn(), knownUsageLabels: vi.fn(), claudeAccountDataAllowed: vi.fn() }))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/debug-logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ clearWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/session-store', () => ({ removeWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn() }))
vi.mock('../../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: vi.fn() }))
vi.mock('../../../src/main/managed-launch-diagnostics', () => ({ listManagedLaunchReports: vi.fn(() => []) }))

const { registerAccountProfilesHandlers } = await import('../../../src/main/ipc/account-profiles-handlers')

// The app's own window, and an event from its top frame (trusted-sender.ts).
const appFrame = { frame: 'app' }
const appWebContents = { mainFrame: appFrame }
const appWindow = { isDestroyed: () => false, webContents: appWebContents }
const fromApp = () => ({ sender: appWebContents, senderFrame: appFrame })
const list = () => handlers.get(IPC.ACCOUNT_PROFILES_LIST)!(fromApp())
const settleAllButTheGate = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

beforeEach(() => {
  handlers.clear()
  listed.reads = 0
  steps.settled = Promise.resolve()
  registerAccountProfilesHandlers(() => appWindow as never)
})

describe('the account list the window reads at start', () => {
  // Mutation to prove this can fail: skip the wait for the start's profile steps.
  it('is read only once the start\'s profile steps have run', async () => {
    steps.settled = new Promise<void>((resolve) => { steps.open = resolve })
    let answered: unknown = null
    const asked = Promise.resolve(list()).then((r) => { answered = r })
    await settleAllButTheGate()
    expect(listed.reads).toBe(0)
    expect(answered).toBeNull()
    steps.open()
    await asked
    expect(listed.reads).toBe(1)
    expect(answered).toEqual([{ id: 'primary', name: '', createdAt: 0, isPrimary: true }])
  })

  it('with the steps already run, the list is read at once', async () => {
    expect(await list()).toEqual([{ id: 'primary', name: '', createdAt: 0, isPrimary: true }])
    expect(listed.reads).toBe(1)
  })
})
