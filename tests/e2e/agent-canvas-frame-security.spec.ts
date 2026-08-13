/**
 * Agent Canvas frame security — the LIVE half of the P1 acceptance gate
 * (spec §3.2): a real ccc-ux:// document in a sandboxed iframe inside the
 * real renderer must have no Node, no IPC bridge, no preload globals, and no
 * network egress beyond its own origin; the serve-time bridge must be there.
 *
 * Content is registered through the real ingress (canvas:render IPC) and the
 * frame is created with exactly the sandbox grants AgentCanvasPane uses (the
 * source-text guard test pins those; this spec proves what they yield).
 */

import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

const SID = 'e2ecanvasframe0000000001'
const DESIGN_HTML = [
  '<!doctype html><html><head><title>Canvas fixture</title></head><body>',
  '<h1 data-ux-id="title">Fixture page</h1>',
  '<button data-ux-id="save">Save</button>',
  '</body></html>',
].join('')

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

test.describe('Agent Canvas content frame', () => {
  let frameUrl = ''

  test('renders through the real ingress and loads over ccc-ux:// (no open port)', async () => {
    const result = await page.evaluate(async ({ sid, html }) => {
      const api = (window as never as { electronAPI: { canvas: { render: (a: unknown) => Promise<{ canvasId: string; versionId: string }> } } }).electronAPI
      return api.canvas.render({ sessionId: sid, source: { mode: 'design', html } })
    }, { sid: SID, html: DESIGN_HTML })

    expect(result.canvasId).toMatch(/^[a-z0-9-]+$/)
    expect(result.versionId).toBe('v1')
    frameUrl = `ccc-ux://${result.canvasId}/${result.versionId}/index.html`

    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.id = 'e2e-canvas-frame'
      // Mirror AgentCanvasPane's grants exactly (pinned by the unit guard).
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.src = src
      frame.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;z-index:99999'
      document.body.appendChild(frame)
    }, frameUrl)

    const frame = page.frame({ url: frameUrl })
    expect(frame, 'iframe attached and navigated').toBeTruthy()
    await frame!.waitForSelector('[data-ux-id="save"]', { timeout: 10_000 })
  })

  test('frame has no Node, no IPC, no preload globals', async () => {
    const frame = page.frame({ url: frameUrl })!
    const probes = await frame.evaluate(() => ({
      require: typeof (window as never as Record<string, unknown>).require,
      process: typeof (window as never as Record<string, unknown>).process,
      electronAPI: typeof (window as never as Record<string, unknown>).electronAPI,
      electronPlatform: typeof (window as never as Record<string, unknown>).electronPlatform,
      ipcRenderer: typeof (window as never as Record<string, unknown>).ipcRenderer,
    }))
    expect(probes).toEqual({
      require: 'undefined',
      process: 'undefined',
      electronAPI: 'undefined',
      electronPlatform: 'undefined',
      ipcRenderer: 'undefined',
    })
  })

  test('bridge was injected at serve time and is running', async () => {
    const frame = page.frame({ url: frameUrl })!
    const bridge = await frame.evaluate(() => ({
      installed: (window as never as Record<string, unknown>).__cccCanvasBridge === true,
      tag: !!document.querySelector('script[src="/__ccc__/canvas-bridge.js"]'),
    }))
    expect(bridge.installed).toBe(true)
    expect(bridge.tag).toBe(true)
  })

  test('connect-src confines fetch to the canvas origin', async () => {
    const frame = page.frame({ url: frameUrl })!
    const results = await frame.evaluate(async () => {
      // Distinguish a CSP block from a mere network failure: a network-isolated
      // CI would see any foreign fetch "fail" even if connect-src allowed it, so
      // that assertion would pass while the CSP claim is false. Capture the
      // actual securitypolicyviolation to prove the block is the CSP.
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.violatedDirective.startsWith('connect-src')) violations.push(e.blockedURI)
      })
      const attempt = async (input: string) => {
        try {
          const res = await fetch(input)
          return `ok:${res.status}`
        } catch {
          return 'blocked'
        }
      }
      const foreignHttps = await attempt('https://example.com/')
      const localhost = await attempt('http://localhost:19333/health')
      const self = await attempt('/__ccc__/canvas-bridge.js')
      // Let the async violation events flush.
      await new Promise((r) => setTimeout(r, 50))
      return { foreignHttps, localhost, self, violations }
    })
    expect(results.foreignHttps).toBe('blocked')
    expect(results.localhost).toBe('blocked')
    expect(results.self).toMatch(/^ok:200$/)
    // The block MUST be attributable to connect-src, not just a dead network.
    expect(results.violations.some((uri) => uri.includes('example.com'))).toBe(true)
    expect(results.violations.some((uri) => uri.includes('localhost'))).toBe(true)
  })

  test('frame cannot reach the parent document (cross-origin isolation)', async () => {
    const frame = page.frame({ url: frameUrl })!
    const reach = await frame.evaluate(() => {
      try {
        const doc = (window.parent as Window).document
        return `reached:${doc.title}`
      } catch {
        return 'isolated'
      }
    })
    expect(reach).toBe('isolated')
  })
})
