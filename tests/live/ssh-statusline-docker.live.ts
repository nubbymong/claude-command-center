// Lane: DOCKER/container runtime on the Rocky host (item e, live proof).
//
// Drives the STRUCTURED runtime field end-to-end: the app composes
// `[sudo] podman exec -it ccc-test bash`, runs it as the post-connect stage,
// re-runs settings staging INSIDE the container, launches claude there, and
// the statusline POST crosses back to the app because the fixture container
// runs --network=host (the container-netns delivery decision is recorded in
// the morning report; a bridge-network container is a known open design item).
//
// Fixture (provisioned 2026-08-31): rootless AND rootful (sudo) `ccc-test`
// containers on the Rocky host from image localhost/ccc-test-img —
// node:22-bookworm + claude installed, host ~/.claude + ~/.claude.json
// bind-mounted :z, --network=host, linger enabled.
//
// NOTE (owner design question, hop-1 vs hop-2 tmux): the CURRENT product
// stages tmux INSIDE the container (containerSetup re-runs the ladder there).
// The owner's stated model puts persistence on hop 1 (host tmux wrapping the
// exec client). T23 records what the current model does — it is evidence for
// that design conversation, not an endorsement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  hosts, makeLivePort, runSession, report, pane,
  updates, misParsedStageFail, endSshRemote, killPty, settingsState, sleep,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(5))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

/** Count claude processes INSIDE the named container store (rootless via the
 *  key host; rootful via sudo -S with the password piped on stdin). */
/** Count THIS SESSION's claude processes inside the container, matched by the
 *  same session-unique `settings-<safeSid>` marker the End path kills by.
 *  Scoped, not a blunt claude count: the fixture container is SHARED — other
 *  FROM boxes run their own docker combos against it concurrently, and a
 *  whole-container count reads their live sessions as this test's orphans
 *  (exactly what happened when the Rocky-FROM pack overlapped a WINDOWS_1
 *  rerun, 2026-08-31). The bracket trick keeps pgrep from matching its own
 *  bash -c cmdline. */
function claudeCountInContainer(rootful: boolean, sid: string): number {
  const key = hosts.linuxRockyKey!
  const safeSid = sid.replace(/[^a-zA-Z0-9_-]/g, '_')
  const pattern = `settings-[${safeSid[0]}]${safeSid.slice(1)}`
  // Rootful goes through `sudo -S` with the password on STDIN (never argv — it
  // would sit in the remote process list otherwise).
  const cmd = rootful
    ? `sudo -S podman exec ccc-test bash -c "pgrep -fc ${pattern} || true" 2>/dev/null`
    : `podman exec ccc-test bash -c "pgrep -fc ${pattern} || true"`
  // The probe is a MEASUREMENT channel, not the product path — skip host-key
  // pinning entirely so a locked/unreadable known_hosts (the WINDOWS_1 VM's
  // standing file-lock) cannot fail the measurement while the product sessions
  // themselves run fine.
  const knownHostsNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${knownHostsNull}`,
    `${key.username}@${key.host}`, cmd],
    { encoding: 'utf8', timeout: 20000, input: rootful ? `${hosts.linuxRocky!.password}\n` : undefined })
  return Number(out.trim().split('\n').pop()) || 0
}

describe('SSH statusline matrix — docker lane (LIVE, on-demand)', () => {
  itIf(hosts.linuxRockyKey)('T20 docker exec (podman rootless, key): claude runs IN the container, statusline updates, End leaves no in-container orphan', async () => {
    const e = hosts.linuxRockyKey!
    const sid = `lv20${Date.now().toString(36)}`
    const w = await runSession(sid, e, {
      detachable: false,
      runtime: { type: 'container', engine: 'podman', container: 'ccc-test' },
    })
    report('T20 docker rootless', w, sid)
    const inContainer = claudeCountInContainer(false, sid)
    // #572 one hop deeper: killing the exec CLIENT alone can orphan claude
    // inside the container — End must actually clear it.
    await endSshRemote(sid)
    killPty(sid)
    await sleep(4000)
    const afterEnd = claudeCountInContainer(false, sid)
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
    expect(inContainer).toBeGreaterThan(0)
    expect(afterEnd).toBe(0)
  }, 360_000)

  itIf(hosts.linuxRocky)('T21 docker exec (podman rootful, sudo+password): sudo auto-answers and statusline updates', async () => {
    const e = hosts.linuxRocky!
    const sid = `lv21${Date.now().toString(36)}`
    const w = await runSession(sid, e, {
      detachable: false,
      runtime: { type: 'container', engine: 'podman', container: 'ccc-test', sudo: true },
      sudoPassword: e.password,
    })
    report('T21 docker rootful sudo', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 360_000)

  // Persistence for containers is FORCED OFF in the product for now: the hop-2
  // wrap (tmux inside the container) is live-proven to break statusline
  // delivery (claude-running reached, updates=0 — measured here 2026-08-31
  // before the gate landed). Until the hop-1 design (host tmux wrapping the
  // exec client) is built, a container session with Detachable on runs a BARE
  // claude and must still deliver.
  itIf(hosts.linuxRockyKey)('T23 docker exec with Detachable on: ladder forced off (no hop-2 tmux), statusline still updates', async () => {
    const e = hosts.linuxRockyKey!
    const sid = `lv23${Date.now().toString(36)}`
    const w = await runSession(sid, e, {
      runtime: { type: 'container', engine: 'podman', container: 'ccc-test' },
    })
    report('T23 docker detachable-forced-off', w, sid)
    const paneText = pane(w.events, sid)
    await endSshRemote(sid)
    killPty(sid)
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    // Bare launch: no tmux wrap markers in the pane…
    expect(paneText.includes('has-session')).toBe(false)
    // …and the statusline still ticks from inside the container.
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 360_000)
})
