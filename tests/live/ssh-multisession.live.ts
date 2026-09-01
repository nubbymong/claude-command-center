// LIVE multi-session-per-host test (#24).
//
// Proves, against a REAL forwarding-enabled host, that the per-session remote
// MCP listen port lets two sessions to the SAME host coexist — the exact bug
// #24 fixes. Uses the ACTUAL argv builder (buildSshArgs) with the ACTUAL
// per-session ports (remoteMcpPortForSession), so a regression in either shows
// up here.
//
//   - distinct per-session ports  → both `-R` binds succeed (no warning)
//   - the SAME port (pre-#24 shape) → the 2nd bind is refused
//     ("remote port forwarding failed for listen port N")
//
// On-demand only (tests/live/, gitignored hosts) — never CI. Requires a
// forwarding-ENABLED host under `linuxKey` in hosts.local.json; the test skips
// itself (with a note) on a host that has `AllowTcpForwarding no`, since
// coexistence cannot be shown where no `-R` binds at all.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { join } from 'node:path'
import * as os from 'node:os'
import { buildSshArgs } from '../../src/main/ssh-args'
import { remoteMcpPortForSession } from '../../src/main/ssh-remote-port'

interface HostEntry { host: string; username: string; port?: number }
const hostsPath = process.env.CCC_LIVE_HOSTS ?? join(process.cwd(), 'tests', 'live', 'hosts.local.json')
const hosts: Record<string, HostEntry> = existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath, 'utf-8')) : {}
const linux = hosts.linuxKey
const SSH = os.platform() === 'win32' ? 'ssh.exe' : 'ssh'
const LOCAL = 19333 // -R local target; the remote BIND is independent of it

// Local MCP target port is irrelevant to whether sshd binds the remote port, so
// no local server is needed. We only read ssh's forward-bind stderr.
function target(h: HostEntry) { return { username: h.username, host: h.host, port: h.port ?? 22 } }

/** Run one ssh with the real per-session argv + a trivial remote command; return
 * the combined output. Spawned under node-pty — the same way the app itself runs
 * ssh — because the real argv forces a tty and a headless runner (CI box, VM
 * runner, agent shell) has none for spawnSync; that mismatch failed this test
 * from WINDOWS_1 while the product path was fine. */
function probe(h: HostEntry, remotePort: number, remoteCmd: string): Promise<string> {
  const args = [...buildSshArgs(target(h), LOCAL, os.platform(), remotePort),
    '-o', 'BatchMode=yes', remoteCmd]
  return new Promise((resolve) => {
    const p = pty.spawn(SSH, args, { cols: 200, rows: 50 })
    let out = ''
    p.onData((d) => { out += d })
    const t = setTimeout(() => { p.kill(); resolve(out) }, 25_000)
    p.onExit(() => { clearTimeout(t); resolve(out) })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FWD_FAILED = /remote port forwarding failed for listen port/i

describe('LIVE: multiple sessions to one host (#24)', () => {
  const run = linux ? it : it.skip

  run('distinct per-session -R ports coexist; the same port collides', async () => {
    const h = linux as HostEntry
    // Preflight: does this host allow remote forwarding at all?
    const pre = await probe(h, remoteMcpPortForSession('ccc-live-pre'), 'echo PREFLIGHT')
    if (FWD_FAILED.test(pre)) {
      console.warn(`[live #24] ${h.host} has AllowTcpForwarding off — cannot show -R coexistence here; skipping.`)
      return
    }
    expect(pre).toContain('PREFLIGHT')

    const r1 = remoteMcpPortForSession('ccc-live-session-1')
    const r2 = remoteMcpPortForSession('ccc-live-session-2')
    expect(r1).not.toBe(r2) // the allocator gives distinct ports to distinct sessions

    // Hold r1 open on a background connection for the duration of the probes.
    const holder = pty.spawn(SSH, [...buildSshArgs(target(h), LOCAL, os.platform(), r1),
      '-o', 'BatchMode=yes', 'sleep 12'], { cols: 200, rows: 50 })
    try {
      // Give the holder time to establish its -R r1 bind.
      await sleep(3500)

      // DISTINCT: a 2nd session with r2 must bind cleanly alongside r1.
      const distinct = await probe(h, r2, 'echo DISTINCT_OK')
      expect(distinct).toContain('DISTINCT_OK')
      expect(distinct).not.toMatch(FWD_FAILED)

      // SAME (pre-#24 shape): a 2nd session reusing r1 must be refused.
      const same = await probe(h, r1, 'echo SAME_TRIED')
      expect(same).toMatch(FWD_FAILED)
    } finally {
      holder.kill()
    }
  }, 90_000)
})
