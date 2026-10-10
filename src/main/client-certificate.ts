import type { Certificate, Event, WebContents } from 'electron'
import { logWarn } from './debug-logger'

/**
 * The client-certificate answer for every request the app makes: none.
 *
 * Electron emits `select-client-certificate` on `app` whenever a server asks
 * for a TLS client certificate: for a page in any of the app's windows and
 * views (the in-app browser, the account views, the sign-in and artifacts
 * windows, the main window, the splash), for their frames, popups, redirects
 * and service workers, and for a main-process `net` request, which comes with
 * a null `webContents` (the in-app browser's URL check, webview-manager.ts
 * checkUrl). This handler prevents the default for every request and answers
 * with no certificate, so nothing the app loads presents one without the
 * user's choice, and the app offers no choice. A server that requires one
 * answers as it does to a browser that has none.
 *
 * Each refusal is logged once per server per run, by its host and port alone;
 * never a path, a query or a certificate field. Electron names the server as
 * `host:port` (an IPv6 address in brackets), not as a URL; a URL, should one
 * come, is read for its host. A run's log names at most MAX_LOGGED_HOSTS
 * servers, then says once that more were refused, so no page can grow it
 * without bound.
 */
export function selectClientCertificate(
  event: Pick<Event, 'preventDefault'>,
  _webContents: WebContents | null,
  url: string,
  _certificateList: Certificate[],
  callback: (certificate?: Certificate) => void,
): void {
  event.preventDefault()
  callback()
  noteRefusal(url)
}

/** Servers whose refusal this run has logged, up to a bound. */
const loggedHosts = new Set<string>()
const MAX_LOGGED_HOSTS = 200
let overflowLogged = false

/** A server as Electron names it: a host name or an IPv4 address, or an IPv6
 *  address in brackets, then its port (net::HostPortPair::ToString). */
const HOST_AND_PORT_RE = /^(\[[0-9a-f:.]{2,45}\]|[a-z0-9._-]{1,253}):(\d{1,5})$/

/** The server a request names, fit for a log line: its host and port, never
 *  a path, a query or a fragment. */
function requestHost(raw: string): string {
  const named = HOST_AND_PORT_RE.exec(raw.toLowerCase())
  if (named) return `${named[1]}:${named[2]}`
  if (!raw.includes('://')) return '(unparseable)'
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (host && /^[a-z0-9._\-[\]:]{1,253}$/.test(host)) return u.port ? `${host}:${u.port}` : host
    return host ? '(unprintable host)' : '(no host)'
  } catch {
    return '(unparseable)'
  }
}

/** Log one refusal, once per server per run. Never throws. */
function noteRefusal(url: string): void {
  try {
    const host = requestHost(String(url))
    if (loggedHosts.has(host)) return
    if (loggedHosts.size >= MAX_LOGGED_HOSTS) {
      if (!overflowLogged) {
        overflowLogged = true
        logWarn('[client-certificate] more servers asked for a client certificate; none was sent, and they are not logged this run')
      }
      return
    }
    loggedHosts.add(host)
    logWarn(`[client-certificate] ${host} asked for a client certificate; none was sent`)
  } catch { /* the answer is already given */ }
}

/** Tests only: forget which servers were logged. */
export function _resetClientCertificateLogForTest(): void {
  loggedHosts.clear()
  overflowLogged = false
}

/** The slice of Electron's `app` this module registers on. */
export interface ClientCertificateEventSource {
  on(event: 'select-client-certificate', listener: typeof selectClientCertificate): unknown
}

/** Register the policy on `app`. Once, at startup, before any request can be made. */
export function installClientCertificatePolicy(app: ClientCertificateEventSource): void {
  app.on('select-client-certificate', selectClientCertificate)
}
