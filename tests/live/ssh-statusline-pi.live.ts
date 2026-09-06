// Lane: linuxPassword host (Pi) — password combos + key combos (linuxPiKey).
// See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  hosts, makeLivePort, runSession, report, killRemoteTmux,
  updates, misParsedStageFail, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(1))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — Pi lane (LIVE, on-demand)', () => {
  itIf(hosts.linuxPassword)('password + tmux: password auto-types and statusline updates', async () => {
    const e = hosts.linuxPassword!
    const sid = `lv4${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T4 password+tmux', w, sid)
    // #572: THE leak this matrix used to plant on password hosts -- the old
    // key-auth-only cleanup silently no-opped here and every run left a claude
    // eating ~350MB of the host forever (the mongminer exhaustion). The product
    // End path now answers the password prompt itself; assert it worked.
    const ended = await endSshRemote(sid)
    killPty(sid)
    expect(ended).toBe('completed')
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPassword)('password + NO tmux: statusline updates', async () => {
    const e = hosts.linuxPassword!
    const sid = `lv5${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T5 password no-tmux', w, sid)
    await endSshRemote(sid) // no tmux to kill, but this removes the remote sidecars
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  // CSV coverage slots (2026-08-31): the matrix has keyless rows against the
  // Debian-family password host; prove the key-auth shape on the same box.
  itIf(hosts.linuxPiKey)('pi key + tmux: statusline updates', async () => {
    const e = hosts.linuxPiKey!
    const sid = `lv14${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T14 pi key+tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPiKey)('pi key + NO tmux: statusline updates', async () => {
    const e = hosts.linuxPiKey!
    const sid = `lv15${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T15 pi key no-tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// rc.16 R8 lane (plan 4.2 "Live"): a found tmux client that fails
// operationally must never prune a live detached session. The lane plants a
// shim at the STAGED candidate path ("$HOME"/.claude/bin/tmux -- the one
// candidate that needs no root) that prints a protocol mismatch and exits 1,
// beside the Pi's real tmux holding a real detached session. Any staged tmux
// already there (the staging ladder leaves one) is moved aside and put back; the
// shim carries a marker so only the lane's own file is ever removed.
const { probeTmuxLive } = await import('../../src/main/pty-manager')
const { deadSessionIds, hasUnverifiedOffer } = await import('../../src/renderer/utils/detachedRemotesLiveness')

describe('rc.16 R8 -- a tmux client that cannot talk to its server never prunes (LIVE, Pi)', () => {
  itIf(hosts.linuxPiKey)('T27 staged-path shim printing a protocol mismatch beside the real tmux -> UNVERIFIED, offered with the note; shim removed -> verified live', async () => {
    const e = hosts.linuxPiKey!
    const sid = `lv27${Date.now().toString(36)}`
    const name = `ccc-${sid}`
    const knownHostsNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const pi = (cmd: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${knownHostsNull}`,
      `${e.username}@${e.host}`, cmd], { encoding: 'utf8', timeout: 20000 })
    const STAGED = '"$HOME"/.claude/bin'
    const SHIM = `${STAGED}/tmux`
    const BACKUP = `${STAGED}/tmux.ccc-t27-backup`
    const MARK = 'ccc-t27-shim'
    // Only the lane's own shim is removed; a staged tmux moved aside is put back.
    const restore = `if [ -e ${BACKUP} ]; then mv -f ${BACKUP} ${SHIM}; elif [ -e ${SHIM} ] && grep -q ${MARK} ${SHIM}; then rm -f ${SHIM}; fi; true`
    const target = { username: e.username, host: e.host, port: 22 }
    const entry = { sessionId: sid, configId: 'cfg-t27', label: 'ccc-t27', host: e.host, username: e.username, remotePath: '~', mux: 'tmux' as const, detachedAt: Date.now() }
    pi(`tmux new-session -d -s ${name} 'sleep 900'`)
    try {
      pi(`mkdir -p ${STAGED}; if [ -e ${SHIM} ] && ! grep -q ${MARK} ${SHIM}; then mv -f ${SHIM} ${BACKUP}; fi; printf '%s\\n' '#!/bin/sh' '# ${MARK}' 'echo "protocol version mismatch (client 8, server 7)" >&2' 'exit 1' > ${SHIM}; chmod +x ${SHIM}`)
      const shimmed = await probeTmuxLive(target, [sid])
      expect(shimmed).toEqual({ outcome: 'unverified', liveSessionIds: [] }) // 7ef62a2e: verified, [] -> pruned
      expect(deadSessionIds([sid], shimmed)).toEqual([])
      // The resume surface's own predicate: still offered, with the "could not verify" note.
      expect(hasUnverifiedOffer([entry], { [sid]: 'unverified' })).toBe(true)
      pi(restore)
      const clean = await probeTmuxLive(target, [sid])
      expect(clean).toEqual({ outcome: 'verified', liveSessionIds: [sid] })
      expect(deadSessionIds([sid], clean)).toEqual([])
    } finally {
      try { pi(restore) } catch { /* the second restore is idempotent */ }
      try { pi(`tmux kill-session -t ${name} 2>/dev/null; true`) } catch { /* already gone */ }
    }
  }, 180_000)
})
