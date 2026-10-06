/**
 * [host] A main-process `net` request (webContents null) gets no client
 * certificate, as on Electron 43, where such a request failed with
 * ERR_SSL_CLIENT_AUTH_CERT_NEEDED. The app's one `net` caller probes whatever
 * URL the user typed into the in-app browser (webview-manager.ts checkUrl).
 * Nothing real is requested.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { selectClientCertificate, installClientCertificatePolicy } from '../../../src/main/client-certificate'

const CERT = { subjectName: 'CN=me', issuerName: 'CN=corp', fingerprint: 'sha256/x' } as unknown as Electron.Certificate

function answer(webContents: unknown) {
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  selectClientCertificate(event, webContents as Electron.WebContents | null, 'https://typed.example/', [CERT], callback)
  return { event, callback }
}

describe('select-client-certificate: a main-process net request presents no certificate', () => {
  it('a main-process net request (webContents null) presents no certificate: the default is prevented and the callback gets none', () => {
    const { event, callback } = answer(null)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
  })

  it('a request with a WebContents is not answered by this handler', () => {
    const { event, callback } = answer({ id: 7 })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })

  it('installs the handler on app select-client-certificate', () => {
    const on = vi.fn()
    installClientCertificatePolicy({ on })
    expect(on).toHaveBeenCalledWith('select-client-certificate', selectClientCertificate)
  })

  it('the main process installs it at startup, before the app is ready (index.ts)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
    const install = src.indexOf('installClientCertificatePolicy(app)')
    const ready = src.indexOf('app.whenReady()')
    expect(install, 'installClientCertificatePolicy(app) is not called in index.ts').toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(-1)
    expect(install, 'the policy must be installed before app.whenReady()').toBeLessThan(ready)
    expect(src).toMatch(/import \{ installClientCertificatePolicy \} from '\.\/client-certificate'/)
  })
})
