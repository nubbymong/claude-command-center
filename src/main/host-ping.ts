/**
 * host-ping.ts — TIER 1 reachability for the SSH Persistent resume surface.
 *
 * The resume layer has two tiers, and only the CHEAP one may repeat:
 *
 *   tier 2 — the full SSH `tmux ls` verify (ssh-liveness.ts / probeTmuxLive).
 *            Authenticates, spends a connection, and is the ONLY thing that can
 *            say a remote is live or dead. It runs on EVENTS only, never a timer.
 *   tier 1 — this module. "Is the host answering at all?" No SSH, no auth, no
 *            credentials. It can run on a slow timer because it costs a single
 *            ICMP echo (or one TCP SYN).
 *
 * DEMOTE-ONLY, and that asymmetry is the whole design. A reachable host tells
 * you NOTHING about the tmux session — the box can be up with the session long
 * gone — so a successful ping never promotes an entry to 'live'. An unreachable
 * host, by contrast, is proof that nothing on it is re-attachable RIGHT NOW, so
 * repeated failures demote its entries. Promotion stays the exclusive privilege
 * of the authenticated tier-2 verify.
 *
 * SECURITY POSTURE. The host string comes from a saved config / registry entry,
 * but it reaches a process argv, so it is validated against a strict charset
 * BEFORE any spawn and rejected outright otherwise (never "cleaned" and passed
 * on). `execFile` with an ARRAY argv and no shell — a hostile value like
 * `-oProxyCommand=…` is refused by the leading-dash rule rather than relying on
 * argv separation alone. The TCP fallback spawns no process at all.
 *
 * No default export (project convention).
 */
import { execFile as nodeExecFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { logInfo } from './debug-logger'

/** Wall-clock budget for one reachability attempt (each tier), ms. */
export const HOST_PING_TIMEOUT_MS = 3000

/** The port the TCP fallback knocks on — SSH, i.e. the only port whose answer
 *  is actually relevant to a resumable remote. */
export const HOST_PING_TCP_PORT = 22

/** Longest host we will even look at, before charset validation. */
const MAX_HOST_LENGTH = 255

/**
 * The ONLY characters a pingable host may contain: DNS names, IPv4, IPv6 (bare
 * or bracketed), and the underscore some private zones use. Deliberately has no
 * whitespace, no quotes, no shell metacharacters, and no `%` (IPv6 zone ids are
 * not routable from here anyway) — anything outside this set is a
 * configuration error or an attack, and both are answered the same way.
 */
const HOST_CHARSET_RE = /^[A-Za-z0-9.:\[\]_-]+$/

/**
 * True iff `host` is safe to hand to a process argv / socket connect. Rejects
 * a non-string, an empty string, an over-long one, anything starting with `-`
 * (an option, not a host — this is what stops `-oProxyCommand=...` and friends),
 * and anything outside HOST_CHARSET_RE. Exported so the boundary rule is
 * unit-tested against the real predicate rather than a copy of it.
 *
 * Deliberately NOT a `host is string` type guard: callers pass an already-typed
 * string, and a predicate would narrow the REJECT branch to `never`, hiding the
 * runtime fact that a hostile value can still be sitting in that variable.
 */
export function isValidPingHost(host: unknown): boolean {
  if (typeof host !== 'string') return false
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false
  if (host.startsWith('-')) return false
  return HOST_CHARSET_RE.test(host)
}

/** The ping binary for a platform (mirrors pty-manager's `ssh.exe` / `ssh`). */
export function pingBinary(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'ping.exe' : 'ping'
}

/**
 * Argv for a ONE-shot ping with a ~3s budget. Windows takes its wait in ms
 * (`-w`), unix in whole seconds (`-W`). Array form only — there is no shell
 * string anywhere in this module.
 */
export function buildPingArgs(host: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['-n', '1', '-w', String(HOST_PING_TIMEOUT_MS), host]
    : ['-c', '1', '-W', String(Math.ceil(HOST_PING_TIMEOUT_MS / 1000)), host]
}

/**
 * How the answer was obtained: `icmp` (ping replied), `tcp` (ping failed but
 * the SSH port accepted a connection — the ICMP-blocked case), `none` (neither,
 * or the host never got as far as a probe).
 */
export type HostPingVia = 'icmp' | 'tcp' | 'none'

export interface HostPingResult {
  host: string
  /** Host answered SOMETHING. Says nothing about any tmux session on it. */
  reachable: boolean
  via: HostPingVia
  /** Short machine-readable why, for logs/tests: 'invalid-host' | 'icmp-failed'
   *  | 'tcp-failed' | undefined on success. */
  reason?: string
}

/** Seams for tests — the defaults are the real `execFile` and a real socket. */
export interface HostPingDeps {
  platform?: NodeJS.Platform
  execFileImpl?: typeof nodeExecFile
  /** Resolve true iff a TCP connection to host:port completed inside the budget. */
  tcpConnect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  port?: number
  timeoutMs?: number
}

/**
 * TCP fallback: one SYN to the SSH port, no subprocess. Any completed connect is
 * "reachable"; a timeout, refusal, or DNS failure is not. A bracketed IPv6
 * literal is unwrapped, since `net.connect` wants the bare address.
 */
function defaultTcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const target = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    let settled = false
    const socket = new net.Socket()
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    try { socket.connect(port, target) } catch { done(false) }
  })
}

/**
 * Is `host` answering? ICMP first, TCP:22 as a fallback; either success counts.
 *
 * The fallback fires on ANY ping failure, not just a guessed-at "blocked" one:
 * exit codes cannot portably distinguish "ICMP filtered" from "host down" (and
 * a missing/denied `ping` binary is a third case that looks the same), while a
 * TCP handshake on the port we actually care about settles it either way. A
 * refused connection still proves a live host, but we treat only a COMPLETED
 * connect as reachable — refusal is indistinguishable from a middlebox reset
 * here, and demote-only means a false "unreachable" costs a pill, never data.
 *
 * Never throws: every failure path resolves `reachable: false`.
 */
export async function pingHost(host: string, deps: HostPingDeps = {}): Promise<HostPingResult> {
  if (!isValidPingHost(host)) {
    // NOT logged verbatim: a rejected value is exactly the kind of string that
    // should not be echoed into a log file.
    logInfo(`[host-ping] rejected an invalid host (${typeof host} , ${String(host ?? '').length} chars) — never spawned`)
    return { host: String(host ?? ''), reachable: false, via: 'none', reason: 'invalid-host' }
  }
  const platform = deps.platform ?? os.platform()
  const execFileImpl = deps.execFileImpl ?? nodeExecFile
  const tcpConnect = deps.tcpConnect ?? defaultTcpConnect
  const timeoutMs = deps.timeoutMs ?? HOST_PING_TIMEOUT_MS
  const port = deps.port ?? HOST_PING_TCP_PORT

  const icmpOk = await new Promise<boolean>((resolve) => {
    try {
      execFileImpl(
        pingBinary(platform),
        buildPingArgs(host, platform),
        { timeout: timeoutMs, windowsHide: true },
        (err) => resolve(!err),
      )
    } catch {
      // A synchronous spawn throw (missing binary, EACCES) is just another
      // "ping did not answer" — the TCP tier decides.
      resolve(false)
    }
  })
  if (icmpOk) return { host, reachable: true, via: 'icmp' }

  const tcpOk = await tcpConnect(host, port, timeoutMs).catch(() => false)
  return tcpOk
    ? { host, reachable: true, via: 'tcp' }
    : { host, reachable: false, via: 'none', reason: 'tcp-failed' }
}
