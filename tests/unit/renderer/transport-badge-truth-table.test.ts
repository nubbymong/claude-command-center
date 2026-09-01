// Phase 6 — the transport-badge truth table and the hover-strip geometry, as
// pure functions.
//
// Both used to be inline expressions duplicated across five components, which is
// exactly how they drifted: three surfaces disagreed about whether a container
// session also shows an SSH chip, and the hover strip's park offset was a magic
// 40 nobody could re-derive. Here they are one definition each, exercised
// exhaustively so a mutation to either fails loudly.
import { describe, it, expect } from 'vitest'
import {
  configIsPersistent,
  containerNameOf,
  effectiveSshRuntime,
  isContainerSsh,
  resolveTransportBadge,
  type SshBadgeInput,
  type TransportBadgeKind,
} from '../../../src/renderer/components/sidebar/transportBadge'
import {
  HOVER_STRIP_EDGE_PX,
  HOVER_STRIP_SPAWN_PX,
  countPillWidthPx,
  hoverStripRightPx,
} from '../../../src/renderer/components/sidebar/sessionsPanelState'

const ssh = (over: SshBadgeInput = {}): SshBadgeInput => ({ ...over })

describe('resolveTransportBadge — the three-way truth table', () => {
  // The whole table, spelled out. `persistent` is the caller's answer (a saved
  // config's `detachable`, or a live session's reported tmux wrap), so both
  // values are exercised against every runtime shape.
  const rows: Array<{ name: string; ssh: SshBadgeInput; persistent: boolean; expect: TransportBadgeKind }> = [
    { name: 'structured container + persistent', ssh: ssh({ runtime: { type: 'container', container: 'c' } }), persistent: true, expect: 'container' },
    { name: 'structured container + not persistent', ssh: ssh({ runtime: { type: 'container', container: 'c' } }), persistent: false, expect: 'container' },
    { name: 'structured container with NO name', ssh: ssh({ runtime: { type: 'container' } }), persistent: false, expect: 'container' },
    { name: 'legacy dockerContainer hint', ssh: ssh({ dockerContainer: 'legacy' }), persistent: true, expect: 'container' },
    { name: 'legacy docker-shaped postCommand (#572)', ssh: ssh({ postCommand: 'sudo docker exec -it box bash' }), persistent: true, expect: 'container' },
    { name: 'podman-shaped postCommand', ssh: ssh({ postCommand: 'podman exec -it box sh' }), persistent: false, expect: 'container' },
    { name: 'explicit host runtime + persistent', ssh: ssh({ runtime: { type: 'host' } }), persistent: true, expect: 'persistent' },
    { name: 'explicit host runtime + not persistent', ssh: ssh({ runtime: { type: 'host' } }), persistent: false, expect: 'ssh' },
    { name: 'no runtime + persistent', ssh: ssh(), persistent: true, expect: 'persistent' },
    { name: 'no runtime + not persistent', ssh: ssh(), persistent: false, expect: 'ssh' },
    { name: 'empty dockerContainer is not a container', ssh: ssh({ dockerContainer: '   ' }), persistent: false, expect: 'ssh' },
    { name: 'non-container postCommand is not a container', ssh: ssh({ postCommand: 'cd /srv && ls' }), persistent: true, expect: 'persistent' },
  ]
  for (const row of rows) {
    it(`${row.name} → ${row.expect}`, () => {
      expect(resolveTransportBadge({ isSsh: true, ssh: row.ssh, persistent: row.persistent })).toBe(row.expect)
    })
  }

  it('a NON-SSH row gets no transport chip at all, whatever else is set', () => {
    expect(resolveTransportBadge({ isSsh: false, ssh: undefined, persistent: true })).toBe('none')
    // Even a local row carrying leftover ssh fields (a config switched back to
    // local keeps its sshConfig) must not sprout a chip.
    expect(resolveTransportBadge({ isSsh: false, ssh: ssh({ runtime: { type: 'container', container: 'c' } }), persistent: false })).toBe('none')
    expect(resolveTransportBadge({ isSsh: false, ssh: ssh({ dockerContainer: 'c' }), persistent: false })).toBe('none')
  })

  it('an SSH row with NO sshConfig at all still resolves (persistent default)', () => {
    expect(resolveTransportBadge({ isSsh: true, ssh: undefined, persistent: true })).toBe('persistent')
    expect(resolveTransportBadge({ isSsh: true, ssh: undefined, persistent: false })).toBe('ssh')
  })

  it('container OUTRANKS persistence — asserted directly, not implied by a row', () => {
    // The mutation this guards: swapping the two branches, which would make a
    // container config read SSH-Persistent (the value main forces OFF for it).
    const container = ssh({ runtime: { type: 'container', container: 'c' } })
    expect(resolveTransportBadge({ isSsh: true, ssh: container, persistent: true })).not.toBe('persistent')
    expect(resolveTransportBadge({ isSsh: true, ssh: container, persistent: false })).not.toBe('ssh')
  })
})

describe('isContainerSsh / containerNameOf', () => {
  it('an UNKNOWN runtime type is not a container (main fails that launch closed)', () => {
    // A hand-edited or newer-build config saying 'containr'/'Container' must not
    // paint a container badge on a session that will refuse to launch.
    expect(isContainerSsh(ssh({ runtime: { type: 'containr' } as never }))).toBe(false)
    expect(isContainerSsh(ssh({ runtime: { type: 'Container' } as never }))).toBe(false)
    expect(resolveTransportBadge({ isSsh: true, ssh: ssh({ runtime: { type: 'Container' } as never }), persistent: true })).toBe('persistent')
  })

  it('survives non-string junk in the container/postCommand fields', () => {
    expect(isContainerSsh(ssh({ dockerContainer: 42 as never }))).toBe(false)
    expect(isContainerSsh(ssh({ postCommand: { evil: true } as never }))).toBe(false)
    expect(containerNameOf(ssh({ runtime: { type: 'container', container: [] as never } }))).toBeUndefined()
  })

  it('names the container from the structured field, the legacy hint, or neither', () => {
    expect(containerNameOf(ssh({ runtime: { type: 'container', container: '  rocky-dev  ' } }))).toBe('rocky-dev')
    expect(containerNameOf(ssh({ dockerContainer: 'legacy-box' }))).toBe('legacy-box')
    // Structured wins over the superseded hint.
    expect(containerNameOf(ssh({ runtime: { type: 'container', container: 'new' }, dockerContainer: 'old' }))).toBe('new')
    // A named container runtime with no name of its own falls back to the hint.
    expect(containerNameOf(ssh({ runtime: { type: 'container' }, dockerContainer: 'old' }))).toBe('old')
    expect(containerNameOf(ssh({ runtime: { type: 'container' } }))).toBeUndefined()
    expect(containerNameOf(ssh())).toBeUndefined()
  })

  it('effectiveSshRuntime mirrors main: structured wins, the post-command parse is the fallback', () => {
    expect(effectiveSshRuntime(ssh({ runtime: { type: 'host' }, postCommand: 'docker exec -it x bash' }))?.type).toBe('host')
    expect(effectiveSshRuntime(ssh({ postCommand: 'docker exec -it x bash' }))?.type).toBe('container')
    expect(effectiveSshRuntime(ssh())).toBeUndefined()
  })
})

describe('configIsPersistent — detachable is opt-OUT', () => {
  it('only an explicit false opts out', () => {
    expect(configIsPersistent(ssh())).toBe(true)
    expect(configIsPersistent(ssh({ detachable: true }))).toBe(true)
    expect(configIsPersistent(undefined)).toBe(true)
    expect(configIsPersistent(ssh({ detachable: false }))).toBe(false)
  })
})

describe('hover-strip geometry', () => {
  it('parks on the row padding when nothing holds the right edge', () => {
    expect(hoverStripRightPx(0, false)).toBe(HOVER_STRIP_EDGE_PX)
  })

  it('parks FLUSH against the count pill — the replica\'s 25px for a 1-digit count', () => {
    expect(hoverStripRightPx(1, false)).toBe(25)
    expect(hoverStripRightPx(1, false)).toBe(HOVER_STRIP_EDGE_PX + countPillWidthPx(1))
  })

  it('widens with the count so a 2- or 3-digit pill is never covered', () => {
    expect(countPillWidthPx(9)).toBeLessThan(countPillWidthPx(10))
    expect(countPillWidthPx(99)).toBeLessThan(countPillWidthPx(100))
    expect(hoverStripRightPx(12, false)).toBeGreaterThan(hoverStripRightPx(1, false))
    expect(hoverStripRightPx(120, false)).toBeGreaterThan(hoverStripRightPx(12, false))
  })

  it('clears the xN control, and BOTH terms when a Multi Spawn row is also running', () => {
    expect(hoverStripRightPx(0, true)).toBe(HOVER_STRIP_EDGE_PX + HOVER_STRIP_SPAWN_PX)
    expect(hoverStripRightPx(2, true)).toBe(HOVER_STRIP_EDGE_PX + HOVER_STRIP_SPAWN_PX + countPillWidthPx(2))
    // Strictly further left than either term alone — the mutation that drops one.
    expect(hoverStripRightPx(2, true)).toBeGreaterThan(hoverStripRightPx(2, false))
    expect(hoverStripRightPx(2, true)).toBeGreaterThan(hoverStripRightPx(0, true))
  })

  it('a zero/negative count adds nothing (no phantom pill room)', () => {
    expect(hoverStripRightPx(0, false)).toBe(HOVER_STRIP_EDGE_PX)
    expect(hoverStripRightPx(-3, false)).toBe(HOVER_STRIP_EDGE_PX)
  })
})
