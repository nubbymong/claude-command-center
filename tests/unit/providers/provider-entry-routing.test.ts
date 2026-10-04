// WP2 PR 4 (owner answers, 2026-10-04): the nine imports that reached past a
// provider package's entry point now go through the provider interfaces,
// reached from the registry. tests/wp1/dependency-boundaries.test.ts R4 holds
// the import side (its allowlist is empty). This file holds the behaviour
// side: each consumer asks the REGISTERED provider, and each provider
// operation is the package helper it replaced, unchanged.
//
// [host] Everything here runs in a temp folder: os.homedir and CODEX_HOME
// point into it for the whole file, so nothing reads or writes this
// computer's own ~/.claude or ~/.codex.
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({ tmp: '', port: 19333 }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.tmp, getDataDirectory: () => h.tmp }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => h.port,
  issueMcpSessionToken: (sessionId: string) => `tok${sessionId.replace(/[^a-zA-Z0-9]/g, '')}`,
}))

// Before any module below loads: the fake home and CODEX_HOME.
h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-entry-routing-'))
fs.mkdirSync(path.join(h.tmp, '.claude'), { recursive: true })
fs.mkdirSync(path.join(h.tmp, '.codex'), { recursive: true })
vi.spyOn(os, 'homedir').mockReturnValue(h.tmp)
const codexHomeBefore = process.env.CODEX_HOME
process.env.CODEX_HOME = path.join(h.tmp, '.codex')

afterAll(() => {
  if (codexHomeBefore === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = codexHomeBefore
  vi.restoreAllMocks()
  // Only the folder this file made: its own prefix, directly in the temp folder.
  if (path.basename(h.tmp).startsWith('ccc-vitest-entry-routing-') && path.dirname(h.tmp) === os.tmpdir()) fs.rmSync(h.tmp, { recursive: true, force: true })
})

const { ClaudeProvider, createClaudePackage } = await import('../../../src/main/providers/claude')
const { CodexProvider, createCodexPackage } = await import('../../../src/main/providers/codex')
const shim = await import('../../../src/main/providers/claude/ssh-shim')
const ui = await import('../../../src/main/providers/claude/ui-detection')
const { buildStatuslineSetting } = await import('../../../src/main/providers/claude/statusline-command')
const pricing = await import('../../../src/main/providers/codex/pricing')
const { registerProvider, tryGetProvider } = await import('../../../src/main/providers')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../src/main/providers/core')
const watcher = await import('../../../src/main/statusline-watcher')
const { writeLocalSessionSettings, getLocalSessionSettingsPath } = await import('../../../src/main/hooks/per-session-settings')
const { getAllPricing, registryFallbackPricing } = await import('../../../src/main/tokenomics/tk-pricing')
const { randomId } = await import('../../../src/shared/id')

afterEach(() => { _resetProviderRegistryForTest() })

describe('the provider operations are the package helpers they replaced [host]', () => {
  it('Claude: the SSH surface, the screen readers and the statusline helpers delegate unchanged', () => {
    const p = new ClaudeProvider()
    const sid = 'sid-route-1'
    const nonce = randomId()
    const container = { type: 'container' as const, engine: 'docker' as const, container: 'box1', sudo: true }
    expect(p.remoteSessionCleanupCommand(sid)).toBe(shim.buildRemoteSessionCleanupCommand(sid))
    expect(p.tmuxBinPatchCommand(sid)).toBe(shim.buildTmuxBinPatchCommand(sid))
    expect(p.remoteTmuxKillCommand(sid)).toBe(shim.buildRemoteTmuxKillCommand(sid))
    for (const opts of [undefined, { hasSudoPassword: true }, { sudoProbeNonce: nonce }]) {
      expect(p.containerKillCommand(sid, container, opts)).toBe(shim.buildContainerKillCommand(sid, container, opts))
    }
    expect(p.containerKillCommand(sid, undefined)).toBe('')
    const saw = `x\r\n${shim.END_SUDO_SENTINEL_PREFIX}_${nonce}\r\n`
    for (const out of [saw, 'nothing here', `${shim.END_SUDO_SENTINEL_PREFIX}_${nonce}x`]) {
      expect(p.parseEndSudoSentinel(out, nonce)).toBe(shim.parseEndSudoSentinel(out, nonce))
    }
    expect(p.parseEndSudoSentinel(saw, nonce)).toBe(true)
    const setupOpts = { includeStatusLine: true, includeConductorMcp: true, remoteMcpPort: 40123 }
    // Each call names a fresh temp file; everything else is the same command.
    const sameTemp = (cmd: string) => cmd.replace(/ccc-setup-sid-route-1-[0-9a-f]+\.b64/g, 'ccc-setup-<temp>.b64')
    expect(sameTemp(p.windowsRemoteSetupCommand(sid, setupOpts, nonce))).toBe(sameTemp(shim.getWindowsRemoteSetupCommand(sid, setupOpts, nonce)))
    const launch = { sessionId: sid, envPrefixVars: ['A=1'], extraFlags: '--model x', continueFlag: '' }
    expect(p.windowsLaunchCommand(launch)).toBe(shim.buildWindowsClaudeCommand(launch))
    for (const chunk of ['user@host:~$ ', '❯ ', 'plain text', '╭────── box']) {
      expect(p.lastPromptLine(chunk)).toBe(ui.lastPromptLineForClaude(chunk))
      expect(p.looksLikeShellPromptTail(chunk)).toBe(ui.looksLikeShellPromptTail(chunk))
      for (const sent of [true, false]) expect(p.detectUiRunning(chunk, sent)).toBe(ui.detectClaudeUi(chunk, sent))
      expect(p.detectUiRunning(chunk)).toBe(ui.detectClaudeUi(chunk, true))
    }
    expect(p.statuslineSetting('/res', sid, '/res/url-file')).toEqual(buildStatuslineSetting('/res', sid, '/res/url-file'))
    expect(p.statusPostUrl(sid, undefined, h.port, true)).toBe(shim.statusPostUrl(sid, undefined, h.port, true))
    expect(p.statusPostUrl(sid, 40123, h.port, true)).toBe(shim.statusPostUrl(sid, 40123, h.port, true))
    expect(p.statusPostUrl(sid, undefined, 0, true)).toBe('')
  })

  it('Codex: the package carries its prices, and its session provider the config.toml heal (in the temp CODEX_HOME)', () => {
    const pkg = createCodexPackage()
    expect(pkg.pricing).toBeDefined()
    const ops = pkg.pricing!
    expect(ops.keys()).toEqual(pricing.codexPricingKeys())
    for (const k of ops.keys().slice(0, 5)) expect(ops.price(k)).toEqual(pricing.priceForModel(k))
    expect(ops.price('no-such-model')).toBeNull()
    expect(ops.cachedInputPer1M({ inputPer1M: 4, cachedInputPer1M: null, outputPer1M: 9 })).toBe(4)
    const list = { 'gpt-route-x': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008, litellm_provider: 'openai', mode: 'chat' } }
    const parsed = ops.parseList(list)
    expect([...parsed]).toEqual([...pricing.parseLiteLlmOpenAiPricing(list)])
    expect(ops.serialize(parsed)).toEqual(pricing.serializeCodexPricing(parsed))
    expect([...ops.parseSaved(ops.serialize(parsed))]).toEqual([...pricing.parseCachedCodexPricing(pricing.serializeCodexPricing(parsed))])
    ops.setLive(parsed)
    try {
      expect(pricing.priceForModel('gpt-route-x')).toEqual(parsed.get('gpt-route-x'))
    } finally {
      ops.setLive(null)
    }
    expect(pricing.priceForModel('gpt-route-x')).toBeNull()

    const toml = path.join(process.env.CODEX_HOME!, 'config.toml')
    expect(toml.startsWith(h.tmp)).toBe(true)
    fs.writeFileSync(toml, 'model = "x"\n\n# Managed by Claude Command Center -- do not edit directly.\n[mcp_servers.conductor]\nurl = "http://127.0.0.1:1/sse"\n\n[profiles.mine]\nmodel = "y"\n')
    new CodexProvider().removeLegacyMcpServerConfig()
    const left = fs.readFileSync(toml, 'utf8')
    expect(left).not.toContain('[mcp_servers.conductor]')
    expect(left).toContain('[profiles.mine]')
    expect(left).toContain('model = "x"')
  })
})

describe('each consumer asks the registered provider [host]', () => {
  beforeEach(() => { _resetProviderRegistryForTest() })

  it('statusline dispatch hands every payload to the registered Claude provider; the boot heal is that provider\'s', () => {
    const delivered: unknown[] = []
    let healed = 0
    registerProvider(Object.assign(Object.create(ClaudeProvider.prototype) as object, {
      id: 'claude', displayName: 'Claude',
      deliverStatusline: (data: unknown) => { delivered.push(data) },
      healGlobalStatusline: () => { healed++ },
    }) as never)
    const stop = watcher.startStatuslineWatcher(() => null)
    try {
      watcher.dispatchSSHStatuslineUpdate(JSON.stringify({ sessionId: 'sid-route-2', model: 'm' }))
      expect(delivered).toEqual([expect.objectContaining({ sessionId: 'sid-route-2' })])
      watcher.healGlobalStatusline()
      expect(healed).toBe(1)
      // Nothing registered (a boot-order fault): the dispatch delivers to no
      // one and never throws; the heal says why (the boot caller logs it).
      _resetProviderRegistryForTest()
      expect(tryGetProvider('claude')).toBeNull()
      expect(() => watcher.dispatchSSHStatuslineUpdate(JSON.stringify({ sessionId: 'sid-route-3' }))).not.toThrow()
      expect(delivered).toHaveLength(1)
      expect(() => watcher.healGlobalStatusline()).toThrow(/not registered/)
    } finally {
      stop()
    }
  })

  it('the per-session settings writer takes the statusLine stanza and its URL from the registered Claude provider', () => {
    const urls: unknown[][] = []
    registerProvider(Object.assign(Object.create(ClaudeProvider.prototype) as object, {
      id: 'claude', displayName: 'Claude',
      statusPostUrl: (...args: unknown[]) => { urls.push(args); return `http://127.0.0.1:${h.port}/status?cccSessionId=sid-route-4&token=t` },
      statuslineSetting: (resourcesDir: string, sessionId?: string, urlFile?: string) => ({ type: 'command' as const, command: `ROUTED ${path.basename(resourcesDir)} ${sessionId} ${urlFile ? 'with-url-file' : 'no-url-file'}` }),
    }) as never)
    const res = path.join(h.tmp, 'res')
    const file = writeLocalSessionSettings('sid-route-4', { resourcesDir: res })
    expect(file).toBe(getLocalSessionSettingsPath('sid-route-4'))
    expect(file.startsWith(h.tmp)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine).toEqual({ type: 'command', command: 'ROUTED res sid-route-4 with-url-file' })
    expect(urls).toEqual([['sid-route-4', undefined, h.port, true]])
  })

  it('Tokenomics prices Codex models from the registered package and from nowhere else', () => {
    const claudeKeys = new Set(Object.keys(registryFallbackPricing()))
    const codexOnly = pricing.codexPricingKeys().filter((k) => !claudeKeys.has(k))
    expect(codexOnly.length).toBeGreaterThan(0)
    const before = getAllPricing()
    for (const k of codexOnly) expect(before[k], k).toBeUndefined()
    const real = createCodexPackage()
    registerProviderPackage({
      ...real,
      pricing: { ...real.pricing!, keys: () => ['route-model'], price: (m: string) => (m === 'route-model' ? { inputPer1M: 3, cachedInputPer1M: null, outputPer1M: 7 } : null) },
    })
    expect(getAllPricing()['route-model']).toEqual({ input: 3, output: 7, cacheRead: 3, cacheWrite: 0 })
  })

  it('the real packages, as the composition root registers them, answer exactly as before', () => {
    registerProviderPackage(createClaudePackage())
    registerProviderPackage(createCodexPackage())
    const all = getAllPricing()
    const claudeKeys = new Set(Object.keys(registryFallbackPricing()))
    let priced = 0
    for (const k of pricing.codexPricingKeys()) {
      if (claudeKeys.has(k)) continue
      const p = pricing.priceForModel(k)
      if (!p) continue
      expect(all[k], k).toEqual({ input: p.inputPer1M, output: p.outputPer1M, cacheRead: pricing.codexCachedInputPer1M(p), cacheWrite: 0 })
      priced++
    }
    expect(priced).toBeGreaterThan(0)
  })
})
