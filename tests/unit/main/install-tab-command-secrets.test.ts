/**
 * WP2: the transient install/update tab (openCommandTerminal, commit 6e) runs
 * a third party's install script, so its shell gets NONE of the user's
 * command-button secrets -- while every ordinary local shell still gets the
 * Global ones as environment variables (ADR-018 D5).
 *
 * End to end, with nothing between the steps faked: the REAL
 * openCommandTerminal builds the tab's session record; its options go through
 * the REAL pty:spawn handler exactly as TerminalView sends them; the options
 * that handler hands pty-manager are turned into the shell's environment by
 * the REAL spawn builder. Only the disk, the keychain and pty-manager itself
 * are faked (nothing spawns).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const spawnPty = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  beginSpawnPreparation: (win: unknown, sid: string) => ({ current: true, spawn: (o: unknown) => spawnPty(win, sid, o), abandon: vi.fn() }),
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(), resolveVersionBinary: () => null }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
let commandsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'commands' ? commandsOnDisk : null) }))
const vault: Record<string, string> = {}
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: (k: string) => vault[k] ?? null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ launchRefusal: () => null }) }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { buildClaudeLocalSpawn } = await import('../../../src/main/providers/claude/spawn')
const { openCommandTerminal, spentCommand } = await import('../../../src/renderer/utils/commandTerminal')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

/** The environment the shell of the last spawn would start with. */
function spawnedEnv(): Record<string, string> {
  const opts = spawnPty.mock.calls.at(-1)![2] as { shellOnly?: boolean; commandSecrets?: Record<string, string> }
  return buildClaudeLocalSpawn({ sessionId: SID, shellOnly: opts.shellOnly, commandSecrets: opts.commandSecrets } as never).env
}
const secretVars = (env: Record<string, string>) => Object.keys(env).filter((k) => k.startsWith('CCC_CMD_SECRET_'))

beforeEach(() => {
  spawnPty.mockClear()
  useSessionStore.setState({ sessions: [] } as never)
  // A Global command button with a secret: every local shell may reference it.
  commandsOnDisk = [{ id: 'aaa111', hasSecretArg: true, scope: 'global' }]
  for (const k of Object.keys(vault)) delete vault[k]
  vault['aaa111_cmdsecret'] = 'tok-a'
})

describe('the install tab gets none of the command-button secrets', () => {
  it('an ordinary local shell tab still gets them (the control)', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, terminalOptions: {} })
    expect(secretVars(spawnedEnv())).toEqual(['CCC_CMD_SECRET_aaa111'])
    expect(spawnedEnv().CCC_CMD_SECRET_aaa111).toBe('tok-a')
  })

  it("the install tab's first spawn: the install command runs with no secret variable in its environment", async () => {
    const id = openCommandTerminal({ label: 'Install Codex', command: 'npm install -g @openai/codex' })
    const tab = useSessionStore.getState().sessions.find((s) => s.id === id)!
    expect(tab.terminalOptions).toEqual({ command: 'npm install -g @openai/codex', elevated: false, noCommandSecrets: true })
    // What TerminalView sends for this tab (its session record's options).
    await spawn({}, SID, { cwd: '', shellOnly: tab.shellOnly, terminalOptions: tab.terminalOptions })
    expect(spawnPty.mock.calls[0][2].commandSecrets).toBeUndefined()
    expect(secretVars(spawnedEnv())).toEqual([])
    // The command itself still reaches the spawn, unchanged.
    expect(spawnPty.mock.calls[0][2].terminalOptions.command).toBe('npm install -g @openai/codex')
  })

  it("the tab's plain shell after a Restart (its command spent) stays without them", async () => {
    const id = openCommandTerminal({ label: 'Update Codex', command: 'npm install -g @openai/codex@latest' })
    const tab = useSessionStore.getState().sessions.find((s) => s.id === id)!
    await spawn({}, SID, { cwd: '', shellOnly: true, terminalOptions: spentCommand(tab.terminalOptions) })
    expect(secretVars(spawnedEnv())).toEqual([])
  })

  it('asking for none can only take secrets away: false or absent is an ordinary shell', async () => {
    await spawn({}, SID, { cwd: 'C:/w', shellOnly: true, terminalOptions: { noCommandSecrets: false } })
    expect(secretVars(spawnedEnv())).toEqual(['CCC_CMD_SECRET_aaa111'])
  })
})
