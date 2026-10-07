// Lane: linuxKey host (185) — key-auth combos. See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  hosts, makeWin, makeLivePort, runSession, report, killRemoteTmux, sleep,
  claudeRan, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(0))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — 185 key lane (LIVE, on-demand)', () => {
  itIf(hosts.linuxKey)('key + tmux wrap (fresh): statusline updates arrive for the session id', async () => {
    const e = hosts.linuxKey!
    const sid = `lv1${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T1 key+tmux fresh', w, sid)
    // #572: end through the PRODUCT path (before killPty, which clears the End
    // target) so the matrix exercises the same kill users click; the key-auth
    // exec below stays as belt-and-braces.
    await endSshRemote(sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(claudeRan(w.events, sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxKey)('key + tmux reattach: statusline still updates after reconnect', async () => {
    const e = hosts.linuxKey!
    const sid = `lv2${Date.now().toString(36)}`
    const w1 = await runSession(sid, e)
    report('T2a first connect', w1, sid)
    const firstOk = claudeRan(w1.events, sid)
    killPty(sid) // drop the local PTY; the remote tmux session survives
    await sleep(3000)
    const w2 = await runSession(sid, e, { win: makeWin(), nudge: true })
    report('T2b reattach', w2, sid)
    await endSshRemote(sid) // #572: product End path first (see T1)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(firstOk).toBe(true)
    expect(claudeRan(w2.events, sid)).toBe(true)
  }, 480_000)

  itIf(hosts.linuxKey)('key + NO tmux (detachable off): statusline via /dev/tty-or-pts', async () => {
    const e = hosts.linuxKey!
    const sid = `lv3${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T3 key no-tmux', w, sid)
    killPty(sid)
    expect(claudeRan(w.events, sid)).toBe(true)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// rc.16 R8 lane (plan 4.2 "Live"): a found tmux client that fails
// operationally must never prune a live detached session. The lane plants a
// shim at the STAGED candidate path ("$HOME"/.claude/bin/tmux -- the one
// candidate that needs no root) that prints a protocol mismatch and exits 1,
// beside the host's real system tmux holding a real detached session. It runs
// here because it needs that system tmux: the Pi is deliberately the host
// without one. Any staged tmux already there (the staging ladder leaves one) is
// moved aside and put back; the shim carries a marker so only the lane's own
// file is ever removed.
const { probeTmuxLive } = await import('../../src/main/pty-manager')
const { deadSessionIds, hasUnverifiedOffer } = await import('../../src/renderer/utils/detachedRemotesLiveness')

describe('rc.16 R8 -- a tmux client that cannot talk to its server never prunes (LIVE, 185)', () => {
  itIf(hosts.linuxKey)('T27 staged-path shim printing a protocol mismatch beside the real tmux -> UNVERIFIED, offered with the note; shim removed -> verified live', async () => {
    const e = hosts.linuxKey!
    const sid = `lv27${Date.now().toString(36)}`
    const name = `ccc-${sid}`
    const knownHostsNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const onHost = (cmd: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
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
    onHost(`tmux new-session -d -s ${name} 'sleep 900'`)
    try {
      onHost(`mkdir -p ${STAGED}; if [ -e ${SHIM} ] && ! grep -q ${MARK} ${SHIM}; then mv -f ${SHIM} ${BACKUP}; fi; printf '%s\\n' '#!/bin/sh' '# ${MARK}' 'echo "protocol version mismatch (client 8, server 7)" >&2' 'exit 1' > ${SHIM}; chmod +x ${SHIM}`)
      const shimmed = await probeTmuxLive(target, [sid])
      // 7ef62a2e: 'verified' -- the shim's failure read as an empty listing beside the real one.
      expect(shimmed).toEqual({ outcome: 'unverified', liveSessionIds: [] })
      expect(deadSessionIds([sid], shimmed)).toEqual([])
      // The resume surface's own predicate: still offered, with the "could not verify" note.
      expect(hasUnverifiedOffer([entry], { [sid]: 'unverified' })).toBe(true)
      onHost(restore)
      const clean = await probeTmuxLive(target, [sid])
      expect(clean).toEqual({ outcome: 'verified', liveSessionIds: [sid] })
      expect(deadSessionIds([sid], clean)).toEqual([])
    } finally {
      try { onHost(restore) } catch { /* the second restore is idempotent */ }
      try { onHost(`tmux kill-session -t ${name} 2>/dev/null; true`) } catch { /* already gone */ }
    }
  }, 180_000)
})
