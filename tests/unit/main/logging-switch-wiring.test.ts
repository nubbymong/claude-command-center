/// <reference types="vite/client" />
/**
 * P3.12 round 1 (V1): a logging switch turned off stops indexing sessions that
 * are already running, for both assistants (pty-manager applyLoggingSwitches,
 * tested in tests/unit/main/pty-codex-logs.test.ts). This pins what reaches it:
 * the config handlers tell main when the settings are saved and when the saved
 * configs are, and main's start-up calls applyLoggingSwitches from both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'
import loggingServiceSource from '../../../src/main/logging/logging-service.ts?raw'
import settingsPageSource from '../../../src/renderer/components/SettingsPage.tsx?raw'
import sessionDialogSource from '../../../src/renderer/components/SessionDialog.tsx?raw'
import consentSource from '../../../src/renderer/components/LoggingConsentPrompt.tsx?raw'
import logIndexTextSource from '../../../src/renderer/lib/log-index-text.ts?raw'
import knowledgeSource from '../../../src/shared/app-knowledge.ts?raw'
import tipsSource from '../../../src/renderer/tips-library.ts?raw'
import changelogSource from '../../../src/renderer/changelog.ts?raw'
import privacySource from '../../../PRIVACY.md?raw'

const h = vi.hoisted(() => ({ handlers: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>, saved: [] as string[] }))
vi.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { h.handlers[c] = fn } } }))
vi.mock('../../../src/main/config-manager', () => ({
  loadAllConfig: () => ({}),
  saveConfig: (key: string) => { h.saved.push(key); return true },
  migrateFromLocalStorage: () => true,
  isRendererConfigKey: (k: unknown) => typeof k === 'string',
  readConfig: () => [],
}))
vi.mock('../../../src/main/credential-store', () => ({ deleteCredential: () => true }))
vi.mock('../../../src/main/config-save-guard', () => ({ isValidConfigsPayload: () => true, sshCredentialKeysToInvalidate: () => [] }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))
vi.mock('../../../src/main/tokenomics/tokenomics-service', () => ({ refreshTokenomicsConfigs: () => {} }))

const { registerConfigHandlers } = await import('../../../src/main/ipc/config-handlers')

beforeEach(() => { h.handlers = {}; h.saved = [] })

describe('the logging switches reach running sessions (P3.12 round 1, V1)', () => {
  it('a saved configs list fires onConfigsSaved (and only that); saved settings fire onSettingsSaved', async () => {
    const onSettingsSaved = vi.fn()
    const onConfigsSaved = vi.fn()
    registerConfigHandlers({ onSettingsSaved, onConfigsSaved })
    await h.handlers['config:save']({}, 'configs', [])
    expect(onConfigsSaved).toHaveBeenCalledTimes(1)
    expect(onSettingsSaved).not.toHaveBeenCalled()
    await h.handlers['config:save']({}, 'settings', {})
    expect(onSettingsSaved).toHaveBeenCalledTimes(1)
    expect(onConfigsSaved).toHaveBeenCalledTimes(1)
    await h.handlers['config:save']({}, 'commands', [])
    expect(onConfigsSaved).toHaveBeenCalledTimes(1)
  })

  it('main calls applyLoggingSwitches when the settings are saved and when the configs are, each in its own try', () => {
    const settingsAt = indexSource.indexOf('onSettingsSaved:')
    const settingsBody = indexSource.slice(settingsAt, indexSource.indexOf('})', settingsAt))
    expect(settingsBody).toMatch(/try \{ applyLoggingSwitches\(\) \} catch \(err\) \{ logError\(/)
    const configsAt = indexSource.indexOf('onConfigsSaved:')
    expect(configsAt).toBeGreaterThan(-1)
    const configsBody = indexSource.slice(configsAt, indexSource.indexOf('}', indexSource.indexOf('catch', configsAt) + 20) + 1)
    expect(configsBody).toMatch(/try \{ applyLoggingSwitches\(\) \} catch \(err\) \{ logError\(/)
  })

  it('P3.12 (W4, X1, X3): main keeps the conversations written while not indexed from start-up, before (and whether or not) logging starts; the worker starts with them and is told of each change; they are written at quit', () => {
    const gapsAt = indexSource.indexOf("initIndexingGaps(join(getDataDirectory(), 'logging-gaps.json'))")
    expect(gapsAt).toBeGreaterThan(-1)
    expect(gapsAt).toBeLessThan(indexSource.indexOf('initLogging({ emit: emitWithMerge'))
    // P3.12 (Y1): the worker starts with every window, and is told of each change.
    expect(loggingServiceSource).toMatch(/notIndexedSnapshot,\r?\n/)
    expect(loggingServiceSource).toMatch(/setNotIndexedListener\(\(update\) => sup\.notIndexedWindows\(update\)\)/)
    const quitAt = indexSource.indexOf('quitTeardown = () => {')
    expect(indexSource.slice(quitAt, quitAt + 1200)).toMatch(/try \{ flushIndexingGaps\(\) \} catch/)
    // Round 7 (K3): an OS shutdown that may be vetoed writes without latching the quit.
    const shutAt = indexSource.indexOf("powerMonitor.on('shutdown'")
    expect(shutAt).toBeGreaterThan(-1)
    expect(indexSource.slice(shutAt, shutAt + 300)).toMatch(/flushIndexingGaps\(\{ final: false \}\)/)
    const sigAt = indexSource.indexOf("process.on('SIGTERM', () => {")
    expect(indexSource.slice(sigAt, sigAt + 300)).toMatch(/flushIndexingGaps\(\)/)
  })

  it('P3.12 round 2 (W4): every text about the switch says off stops indexing at once and on applies to sessions started after it', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    for (const [name, src] of Object.entries({ settingsPageSource, sessionDialogSource, consentSource, logIndexTextSource, knowledgeSource, tipsSource })) {
      expect(flat(src), name).toMatch(/sessions started after/)
    }
    expect(flat(sessionDialogSource)).not.toMatch(/They keep the settings they launched with; your edits apply/)
  })

  it('P3.16a (U2): no text says the conversation index powers Tokenomics; the Tokenomics cost index is its own, which the switch does not stop', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ')
    // The premise the texts follow: app knowledge says the two indexes are separate.
    expect(flat(knowledgeSource)).toMatch(/the Tokenomics cost index, which reads Claude and Codex transcripts locally, is separate and not affected by that switch/)
    const tipAt = tipsSource.indexOf("title: 'Session Activity Logging'")
    expect(tipAt).toBeGreaterThan(-1)
    const bodyAt = tipsSource.indexOf('body:', tipAt)
    const tipBody = tipsSource.slice(bodyAt, tipsSource.indexOf('\n', bodyAt))
    const privacyAt = privacySource.indexOf('an index of your Claude Code and Codex session transcripts')
    expect(privacyAt).toBeGreaterThan(-1)
    const surfaces: Record<string, string> = {
      'log-index-text.ts': logIndexTextSource,
      'the Session Activity Logging tip': tipBody,
      'PRIVACY.md (the index entry)': privacySource.slice(privacyAt).split(/\r?\n- /)[0],
    }
    // A sentence that names Tokenomics beside power/powered/used to power would
    // say this index feeds it (a separate index of its own is said in its own
    // sentence). A sentence ends at a full stop and a space, so the dot in a path
    // such as ~/.claude/projects does not end one (round 1: `[^.]*` stopped there,
    // and a regression after the path went unseen).
    const powersTokenomics = (text: string) => flat(text).split(/\.\s/)
      .some((s) => /(?:[Pp]owers?|powered by|used to power)\b.*\bTokenomics\b|\bTokenomics\b.*\b(?:is|are) powered by\b/.test(s))
    expect(powersTokenomics("Powers the Logs page by indexing Claude's own transcripts (~/.claude/projects) and the Tokenomics page.")).toBe(true)
    expect(powersTokenomics("Powers the Logs page by indexing Claude's own transcripts (~/.claude/projects). Tokenomics reads them with an index of its own.")).toBe(false)
    for (const [name, src] of Object.entries(surfaces)) expect(powersTokenomics(src), name).toBe(false)
  })

  it('P3.12 (T1): the changelog says what is never indexed for a Codex session only', () => {
    expect(changelogSource).toContain('For a Codex session, what it wrote while indexing was off is never indexed.')
    expect(changelogSource).not.toMatch(/what a session wrote while it was off is never indexed/)
  })
})
