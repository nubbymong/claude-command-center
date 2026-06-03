// Bug 4: per-session vision router. The browser is shared, but each CCC session
// gets its OWN pinned CDP target inside its OWN BrowserContext, so a second
// session navigating can never repoint another session's calls (the prior
// "single shared client" model leaked across sessions). These tests drive a fake
// chrome-remote-interface so the router logic is verified without a real browser.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { _setCdpForTest, VisionManager } from '../../src/main/vision-manager'

function makeFakeCdp(opts: { noBrowserContext?: boolean } = {}) {
  let nextTarget = 1, nextContext = 1
  const targets: Array<{ id: string; type: string; title: string; url: string; contextId?: string }> = []
  const viewportCalls: any[] = []
  const closedTargets: string[] = []
  const disposedContexts: string[] = []

  const targetClient = (targetId: string) => ({
    Page: {
      enable: async () => {},
      navigate: async ({ url }: any) => { const t = targets.find(t => t.id === targetId); if (t) t.url = url },
      loadEventFired: async () => {},
      captureScreenshot: async () => ({ data: Buffer.from('img').toString('base64') }),
      reload: async () => {},
    },
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }: any) => {
        const t = targets.find(t => t.id === targetId)
        if (expression === 'window.location.href') return { result: { value: t?.url } }
        if (expression === 'document.title') return { result: { value: t?.title } }
        return { result: { value: undefined } }
      },
    },
    Emulation: { setDeviceMetricsOverride: async (o: any) => { viewportCalls.push({ targetId, ...o }) } },
    Input: { dispatchMouseEvent: async () => {}, dispatchKeyEvent: async () => {} },
    close: async () => {},
  })

  const rootClient = () => ({
    Target: {
      createBrowserContext: async () => {
        if (opts.noBrowserContext) throw new Error('not supported')
        return { browserContextId: 'ctx-' + (nextContext++) }
      },
      createTarget: async ({ url, browserContextId }: any) => {
        const id = 'tgt-' + (nextTarget++)
        targets.push({ id, type: 'page', title: '', url: url || 'about:blank', contextId: browserContextId })
        return { targetId: id }
      },
      closeTarget: async ({ targetId }: any) => { closedTargets.push(targetId); const i = targets.findIndex(t => t.id === targetId); if (i >= 0) targets.splice(i, 1) },
      disposeBrowserContext: async ({ browserContextId }: any) => { disposedContexts.push(browserContextId) },
    },
    close: async () => {},
  })

  const cdp: any = async (o: any) => {
    if (o && o.target) return targetClient(typeof o.target === 'string' ? o.target : o.target.id)
    return rootClient()
  }
  cdp.List = async () => targets.map(t => ({ ...t }))

  return { cdp, targets, viewportCalls, closedTargets, disposedContexts, removeTarget: (id: string) => { const i = targets.findIndex(t => t.id === id); if (i >= 0) targets.splice(i, 1) } }
}

describe('VisionManager per-session router (Bug 4)', () => {
  let fake: ReturnType<typeof makeFakeCdp>
  let vm: VisionManager

  async function boot(fakeOpts = {}) {
    fake = makeFakeCdp(fakeOpts)
    _setCdpForTest(fake.cdp)
    vm = new VisionManager(9222, 'chrome')
    await vm.start(() => null)
  }

  afterEach(async () => { await vm.stop(); _setCdpForTest(null) })

  it('isolates sessions: navigating one never moves the other', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    await vm.executeCommand({ command: 'navigate', args: ['http://b'], sessionId: 'B' })
    const aUrl = await vm.executeCommand({ command: 'url', args: [], sessionId: 'A' })
    const bUrl = await vm.executeCommand({ command: 'url', args: [], sessionId: 'B' })
    expect(aUrl.data).toBe('http://a')
    expect(bUrl.data).toBe('http://b')
  })

  it('gives each session its own target inside its own BrowserContext', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    await vm.executeCommand({ command: 'navigate', args: ['http://b'], sessionId: 'B' })
    expect(fake.targets).toHaveLength(2)
    expect(fake.targets[0].id).not.toBe(fake.targets[1].id)
    expect(fake.targets[0].contextId).toBeTruthy()
    expect(fake.targets[0].contextId).not.toBe(fake.targets[1].contextId)
  })

  it('reuses the same pinned target across calls from one session', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    await vm.executeCommand({ command: 'eval', args: ['1+1'], sessionId: 'A' })
    expect(fake.targets).toHaveLength(1) // no second target spun up for the same session
  })

  it('guards a target closed underneath the session: errors, then re-allocates', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    fake.removeTarget(fake.targets[0].id) // tab closed out from under the session
    const r = await vm.executeCommand({ command: 'url', args: [], sessionId: 'A' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/closed/i)
    const r2 = await vm.executeCommand({ command: 'navigate', args: ['http://a2'], sessionId: 'A' })
    expect(r2.ok).toBe(true)
  })

  it('setViewport applies device metrics to the session target', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    const r = await vm.executeCommand({ command: 'setViewport', args: ['1440', '900', '2'], sessionId: 'A' })
    expect(r.ok).toBe(true)
    expect(fake.viewportCalls).toHaveLength(1)
    expect(fake.viewportCalls[0]).toMatchObject({ width: 1440, height: 900, deviceScaleFactor: 2 })
  })

  it('tabs lists all targets and flags the calling session\'s own one as current', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    await vm.executeCommand({ command: 'navigate', args: ['http://b'], sessionId: 'B' })
    const tabs = await vm.executeCommand({ command: 'tabs', args: [], sessionId: 'A' })
    expect(tabs.data).toHaveLength(2)
    const current = tabs.data.filter((t: any) => t.current)
    expect(current).toHaveLength(1)
    expect(current[0].url).toBe('http://a')
  })

  it('teardownSession closes the target and disposes its context', async () => {
    await boot()
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    const tgt = fake.targets[0].id
    const ctx = fake.targets[0].contextId!
    await vm.teardownSession('A')
    expect(fake.closedTargets).toContain(tgt)
    expect(fake.disposedContexts).toContain(ctx)
  })

  it('vision_tab to another tab does not close that tab on teardown (only owned targets)', async () => {
    await boot()
    // Session B owns a real page.
    await vm.executeCommand({ command: 'navigate', args: ['http://b'], sessionId: 'B' })
    const bTarget = fake.targets[0].id
    // Session A spins up its own page, then tabs to B's page (index 0).
    await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    const aOwnTarget = fake.targets.find(t => t.url === 'http://a')!.id
    const bIdx = (await vm.executeCommand({ command: 'tabs', args: [], sessionId: 'A' })).data.findIndex((t: any) => t.url === 'http://b')
    await vm.executeCommand({ command: 'tab', args: [String(bIdx)], sessionId: 'A' })
    // A's own page was released; A is now pinned to B's page (unowned).
    expect(fake.closedTargets).toContain(aOwnTarget)
    await vm.teardownSession('A')
    // Teardown must NOT have closed B's page.
    expect(fake.closedTargets).not.toContain(bTarget)
    expect(fake.targets.some(t => t.id === bTarget)).toBe(true)
  })

  it('falls back to a default-context pinned target when BrowserContext is unavailable', async () => {
    await boot({ noBrowserContext: true })
    const r = await vm.executeCommand({ command: 'navigate', args: ['http://a'], sessionId: 'A' })
    expect(r.ok).toBe(true)
    expect(fake.targets).toHaveLength(1)
    expect(fake.targets[0].contextId).toBeUndefined() // default context, but still per-session pinned
    // Still isolated from a second session.
    await vm.executeCommand({ command: 'navigate', args: ['http://b'], sessionId: 'B' })
    const aUrl = await vm.executeCommand({ command: 'url', args: [], sessionId: 'A' })
    expect(aUrl.data).toBe('http://a')
  })
})
