import type { Certificate, Event, WebContents } from 'electron'

/**
 * The client-certificate answer for a main-process `net` request: none.
 *
 * Electron 44 emits `select-client-certificate` for main-process `net`
 * requests (with a null `webContents`); on Electron 43 such a request failed
 * with ERR_SSL_CLIENT_AUTH_CERT_NEEDED and presented no certificate. The
 * app's one main-process `net` caller is the in-app browser's reachability
 * check (webview-manager.ts checkUrl), which requests whatever URL the user
 * typed. This handler gives such a request no certificate (the default is
 * prevented and the callback gets none), as on Electron 43.
 */
export function selectClientCertificate(
  event: Pick<Event, 'preventDefault'>,
  webContents: WebContents | null,
  _url: string,
  _certificateList: Certificate[],
  callback: (certificate?: Certificate) => void,
): void {
  if (webContents) return
  event.preventDefault()
  callback()
}

/** The slice of Electron's `app` this module registers on. */
export interface ClientCertificateEventSource {
  on(event: 'select-client-certificate', listener: typeof selectClientCertificate): unknown
}

/** Register the policy on `app`. Once, at startup, before any request can be made. */
export function installClientCertificatePolicy(app: ClientCertificateEventSource): void {
  app.on('select-client-certificate', selectClientCertificate)
}
