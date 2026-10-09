/**
 * [host] Electron 44 (Chromium 152) names more powerful features in its
 * permission handlers (local-network-access, loopback-network,
 * web-app-installation, and others). The canvas guard decides by ORIGIN, never
 * by name, so every name the installed Electron declares is refused to canvas
 * content and answered for the app's own pages as before. The names are read
 * from the installed electron.d.ts, so a later Electron's new names are
 * covered without editing this file.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { installCanvasPermissionGuard } from '../../../src/main/canvas/ccc-ux-protocol'

const dts = fs.readFileSync(path.join(__dirname, '../../../node_modules/electron/electron.d.ts'), 'utf8')

/** The permission names in the first `<method>(handler: ... permission: '<a>' | '<b>' ...` signature. */
function declaredNames(method: string): string[] {
  const at = dts.indexOf(`${method}(handler: ((webContents:`)
  if (at < 0) return []
  const sig = dts.slice(at, dts.indexOf('\n', at))
  const m = /permission: ((?:'[^']+'(?: \| )?)+)/.exec(sig)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
}

const REQUEST_NAMES = declaredNames('setPermissionRequestHandler')
const CHECK_NAMES = declaredNames('setPermissionCheckHandler')

function install() {
  let request: ((wc: unknown, p: string, cb: (g: boolean) => void, d?: { requestingUrl?: string }) => void) | null = null
  let check: ((wc: unknown, p: string, origin: string) => boolean) | null = null
  installCanvasPermissionGuard({
    setPermissionRequestHandler: (fn) => { request = fn as typeof request },
    setPermissionCheckHandler: (fn) => { check = fn as typeof check },
  })
  return {
    request(p: string, url: string): boolean {
      let granted: boolean | undefined
      request!(null, p, (g) => { granted = g }, { requestingUrl: url })
      expect(granted, `${p}: the request handler never answered`).toBeTypeOf('boolean')
      return granted!
    },
    check: (p: string, origin: string) => check!(null, p, origin),
  }
}

const CANVAS = 'ccc-ux://0123456789abcdef/v1/index.html'
const APP_PAGES = ['file:///C:/Program%20Files/AI%20Code%20Conductor/resources/app.asar/out/renderer/index.html', 'http://localhost:5173/']

describe('the canvas permission guard and Chromium 152 permission names', () => {
  it('reads the installed Electron\'s names, which include the 152 additions', () => {
    for (const names of [REQUEST_NAMES, CHECK_NAMES]) {
      expect(names.length).toBeGreaterThan(20)
      for (const n of ['local-network-access', 'loopback-network', 'local-network', 'web-app-installation', 'clipboard-read', 'media']) {
        expect(names, n).toContain(n)
      }
    }
  })

  it('canvas content is refused every declared permission, by request and by check', () => {
    const g = install()
    for (const p of REQUEST_NAMES) expect(g.request(p, CANVAS), p).toBe(false)
    for (const p of CHECK_NAMES) expect(g.check(p, 'ccc-ux://0123456789abcdef'), p).toBe(false)
  })

  // Every document inside canvas content, whatever address it reports
  // (srcdoc, blank, blob, data, an opaque origin, or none at all).
  it('a frame inside canvas content is refused every declared permission, by request and by check', () => {
    const g = install()
    const nested = ['about:srcdoc', 'about:blank', 'blob:ccc-ux://0123456789abcdef/0b7c1f9e-0000-4000-8000-000000000000', 'data:text/html,x', '']
    for (const url of nested) for (const p of REQUEST_NAMES) expect(g.request(p, url), `${p} ${url}`).toBe(false)
    for (const origin of ['null', '']) for (const p of CHECK_NAMES) expect(g.check(p, origin), `${p} ${origin}`).toBe(false)
  })

  it('the app\'s own pages keep the answer they had (granted), for every declared name', () => {
    const g = install()
    for (const url of APP_PAGES) {
      for (const p of REQUEST_NAMES) expect(g.request(p, url), `${p} ${url}`).toBe(true)
      for (const p of CHECK_NAMES) expect(g.check(p, new URL(url).origin === 'null' ? 'file://' : new URL(url).origin), `${p} ${url}`).toBe(true)
    }
  })
})
