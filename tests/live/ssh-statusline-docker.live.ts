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
  hosts, makeLivePort, runSession, report, pane, states, makeWin, spawnPty, getSshFlow, writePty, resizePty, stripPane,
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

// ---------------------------------------------------------------------------
// rc.16 R1 lanes (plan 1.2 "Live"): the PRODUCTION-composed entry command on
// real hosts, one lane at a time. T24/T25 need a host whose prompt the flow's
// SHELL_PROMPT_RE never captures -- zsh's default `%` -- so each lane switches
// the Rocky user's login shell to zsh for ITS OWN duration (inside the test,
// never in a hook: a hook could run when another lane is selected with -t)
// and reverts it in a finally, loudly if the revert fails. A breadcrumb on the
// host records the original shell so a run that died mid-lane is repaired by
// the next one, and an original that is already zsh is never recorded (it can
// only be that leftover). An empty ~/.zshrc is created if none exists so zsh's
// first-run wizard cannot swallow the prompt, and removed again if the lane
// made it. T26 needs a STOPPED container with a shell entrypoint; the lane
// creates and removes its own (`ccc-test-start`, from the fixture image).
const { startStatuslineWatcher } = await import('../../src/main/statusline-watcher')

type Ev = { channel: string; payload: unknown }
const flowInfos = (ev: Ev[], sid: string) => ev.filter((e) => e.channel === `ssh:flowState:${sid}`).map((e) => (e.payload as { info?: string }).info)
const lastFlow = (ev: Ev[], sid: string) => ev.filter((e) => e.channel === `ssh:flowState:${sid}`).map((e) => e.payload as { state: string; info?: string }).at(-1)
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** The last non-empty line of a stripped pane: where the shell's prompt sits. */
const lastLine = (s: string) => s.replace(/\r/g, '').trimEnd().split('\n').at(-1) ?? ''
/** zsh's prompt ends in `% ` (`%m%# `, Rocky's `[%n@%m]%~%# `, a spaced
 *  `user@host ~ % `): the shape SHELL_PROMPT_RE cannot capture, which is the
 *  whole point of the lane. Judged on the prompt LINE, never the whole pane. */
const ZSH_PROMPT_TAIL_RE = /%\s*$/
/** ...and, where no idle prompt is on screen (T25 runs straight through), the
 *  typed entry echoed right after that prompt. */
const ZSH_PROMPT_THEN_ENTRY_RE = /%\s+(?:sudo\s+)?(?:docker|podman)\s+exec\b/

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return
    await sleep(500)
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`)
}

/** A command on the Rocky host over the key login (a measurement channel, not
 *  the product path). `sudo` pipes the rootful password on STDIN, never argv;
 *  stderr is passed through so a failed chsh/chown says why. */
function rocky(cmd: string, opts: { sudo?: boolean } = {}): string {
  const key = hosts.linuxRockyKey!
  const knownHostsNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const full = opts.sudo ? `sudo -S -p '' sh -c ${sq(cmd)}` : cmd
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${knownHostsNull}`,
    `${key.username}@${key.host}`, full],
    { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'inherit'], input: opts.sudo ? `${hosts.linuxRocky!.password}\n` : undefined })
}

const CRUMB = '.ccc-live-zsh-original-shell'
const loginShell = (u: string) => rocky(`getent passwd ${sq(u)} | cut -d: -f7`).trim()
/** chsh, then read the entry back: a chsh that "succeeded" without taking
 *  effect would make the lane test bash and pass for the wrong reason. */
function setLoginShell(u: string, shell: string): void {
  rocky(`chsh -s ${sq(shell)} ${sq(u)}`, { sudo: true })
  const now = loginShell(u)
  if (now !== shell) throw new Error(`chsh for ${u} did not take effect: login shell is ${now || '(none)'}, wanted ${shell}`)
}

/** Run `body` with the given Rocky user(s) on a zsh login shell; revert
 *  afterwards whatever happens, and fail loudly if the revert itself fails. A
 *  user who is GENUINELY on zsh (still on it after the breadcrumb repair) is
 *  left exactly as found: never switched, never reverted. */
async function withZshLoginShell<T>(users: string[], body: () => Promise<T>): Promise<T> {
  const zshPath = rocky('command -v zsh || true').trim()
  // Loud, never silent: without zsh the lane would test bash and pass for
  // the wrong reason. Installing a package on a fleet host is the owner's call.
  if (!zshPath) throw new Error('T24/T25 need zsh on the Rocky host (`sudo dnf install -y zsh`); the lane does not install packages')
  // A run that died mid-lane left its breadcrumb: put those shells back first.
  const crumb = rocky(`cat "$HOME/${CRUMB}" 2>/dev/null || true`).trim()
  for (const line of crumb.split('\n').filter(Boolean)) {
    const eq = line.indexOf('=')
    if (eq > 0) setLoginShell(line.slice(0, eq), line.slice(eq + 1))
  }
  if (crumb) rocky(`rm -f "$HOME/${CRUMB}"`) // consumed: every shell it named is back
  const original = new Map<string, string>()
  for (const u of [...new Set(users)]) {
    const sh = loginShell(u)
    if (sh.endsWith('/zsh')) { console.log(`zsh lane: ${u} is already on zsh; left as found`); continue }
    original.set(u, sh || '/bin/bash')
  }
  const wroteCrumb = original.size > 0
  if (wroteCrumb) rocky(`printf '%s\\n' ${[...original].map(([u, sh]) => sq(`${u}=${sh}`)).join(' ')} > "$HOME/${CRUMB}"`)
  const madeZshrc: string[] = []
  const switched: string[] = []
  try {
    for (const u of original.keys()) {
      const made = rocky(`h=$(getent passwd ${sq(u)} | cut -d: -f6); if [ -e "$h/.zshrc" ]; then echo present; else : > "$h/.zshrc"; chown ${sq(u)} "$h/.zshrc"; echo created; fi`, { sudo: true }).trim()
      if (made.endsWith('created')) madeZshrc.push(u)
      setLoginShell(u, zshPath)
      switched.push(u)
    }
    return await body()
  } finally {
    const failures: string[] = []
    for (const u of switched) {
      try { setLoginShell(u, original.get(u)!) } catch (err) { failures.push(`${u}: ${(err as Error).message}`) }
    }
    for (const u of madeZshrc) {
      try { rocky(`h=$(getent passwd ${sq(u)} | cut -d: -f6); rm -f "$h/.zshrc"`, { sudo: true }) } catch { /* leave it */ }
    }
    if (failures.length === 0) { if (wroteCrumb) rocky(`rm -f "$HOME/${CRUMB}"`) }
    else throw new Error(`Rocky login shell NOT reverted -- fix by hand with chsh: ${failures.join('; ')}`)
  }
}

/** After claude-running: wait for the first statusline tick, nudging the way
 *  runSession does (a trust prompt is answered; an idle claude is poked). */
async function awaitFirstTick(w: ReturnType<typeof makeWin>, sid: string, cap: number): Promise<void> {
  const t0 = Date.now()
  let nudged = false
  let trustAnswered = false
  while (Date.now() - t0 < cap) {
    await sleep(1000)
    const flat = stripPane(pane(w.events, sid)).replace(/\s/g, '')
    const trustPending = !trustAnswered && /trustthisfolder|Doyoutrust/i.test(flat)
    if (trustPending) {
      trustAnswered = true
      if (flat.includes('❯No,exit')) {
        writePty(sid, '\x1b[B')
        setTimeout(() => writePty(sid, '\r'), 250)
      } else {
        writePty(sid, '\r')
      }
    }
    if (updates(w.events).some((u) => u.sessionId === sid)) return
    if (!nudged && !trustPending && Date.now() - t0 > 12_000) {
      nudged = true
      resizePty(sid, 121, 30)
      resizePty(sid, 120, 30)
      writePty(sid, 'hi')
      setTimeout(() => writePty(sid, '\r'), 300)
    }
  }
}

describe('rc.16 R1 -- a zsh host: the `%` prompt is never captured, so only the sentinel can prove the entry (LIVE)', () => {
  const zshReady = Boolean(hosts.linuxRocky && hosts.linuxRockyKey)

  itIf(zshReady)('T24 cancelled sudo on a `%` host -> failed by the deadline with no launch write; Run again, the secret typed at the new prompt -> proven entry, claude runs IN the container, no orphan after End', async () => {
    const e = hosts.linuxRocky!
    await withZshLoginShell([e.username], async () => {
      const sid = `lv24${Date.now().toString(36)}`
      const w = makeWin()
      try { startStatuslineWatcher(() => w.win as never) } catch { /* status-dir watch is irrelevant here */ }
      // NO saved sudo secret: the entry's sudo prompt waits for the user.
      spawnPty(w.win, sid, {
        ssh: { host: e.host, port: 22, username: e.username, password: e.password, remotePath: '~', detachable: false, runtime: { type: 'container', engine: 'podman', container: 'ccc-test', sudo: true } },
        provider: 'claude',
      } as never)
      let pane1 = 0
      try {
        await waitFor(() => states(w.events, sid).includes('awaiting-postcommand'), 60_000, 'awaiting-postcommand on the zsh host')
        expect(lastLine(stripPane(pane(w.events, sid)))).toMatch(ZSH_PROMPT_TAIL_RE) // the lane IS on a `%` prompt
        getSshFlow(sid)!.runPostCommand()
        const pane0 = pane(w.events, sid).length
        await waitFor(() => /\[sudo\] password/.test(stripPane(pane(w.events, sid).slice(pane0))), 30_000, 'the entry\'s sudo prompt')
        writePty(sid, '\x03') // the user cancels; zsh's `%` prompt returns with no error text at all
        await waitFor(() => lastFlow(w.events, sid)?.state === 'failed', 40_000, 'the entry to fail by the unproven deadline')
        expect(lastFlow(w.events, sid)).toEqual({ state: 'failed', info: 'container entry failed' })
        expect(flowInfos(w.events, sid)).not.toContain('inner')
        expect(states(w.events, sid)).not.toContain('awaiting-claude')
        expect(pane(w.events, sid)).not.toContain('base64 -d') // zero launch writes on the host
        // Run again: a fresh attempt with a fresh nonce; this time the user types the secret.
        pane1 = pane(w.events, sid).length
        getSshFlow(sid)!.runPostCommand()
        await waitFor(() => /\[sudo\] password/.test(stripPane(pane(w.events, sid).slice(pane1))), 30_000, 'the second attempt\'s sudo prompt')
        writePty(sid, `${e.password}\r`)
        await waitFor(() => lastFlow(w.events, sid)?.state === 'awaiting-claude', 60_000, 'the proven entry')
        expect(lastFlow(w.events, sid)).toEqual({ state: 'awaiting-claude', info: 'inner' })
        expect(stripPane(pane(w.events, sid).slice(pane1))).toMatch(/__CCC_[a-f0-9]+_IN__/)
        getSshFlow(sid)!.launchClaude()
        await waitFor(() => states(w.events, sid).includes('claude-running'), 90_000, 'claude-running inside the container')
        await awaitFirstTick(w, sid, 60_000)
        report('T24 zsh cancelled sudo then run again', w, sid)
      } finally {
        // End first, whatever happened: the fixture container is shared, and a
        // claude left inside it would read as another lane's orphan.
        try { await endSshRemote(sid) } catch { /* nothing launched, or the link is gone */ }
        killPty(sid)
      }
      const paneText = pane(w.events, sid)
      expect(misParsedStageFail(w.events, sid)).toEqual([])
      // The launch happened on the SECOND attempt's proven shell: the setup went
      // out after that attempt started, never before.
      expect(paneText.indexOf('base64 -d')).toBeGreaterThan(pane1)
      expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
      // End must clear the in-container claude, as T20 asserts for rootless.
      await sleep(4000)
      expect(claudeCountInContainer(true, sid)).toBe(0)
    })
  }, 420_000)

  itIf(zshReady)('T25 zsh login shell (`%` prompt): the entry is proven by the sentinel, claude runs in the container, statusline updates', async () => {
    const e = hosts.linuxRockyKey!
    await withZshLoginShell([e.username], async () => {
      const sid = `lv25${Date.now().toString(36)}`
      try {
        const w = await runSession(sid, e, {
          detachable: false,
          runtime: { type: 'container', engine: 'podman', container: 'ccc-test' },
        })
        report('T25 zsh login shell', w, sid)
        const paneText = stripPane(pane(w.events, sid))
        expect(misParsedStageFail(w.events, sid)).toEqual([])
        const inAt = paneText.search(/__CCC_[a-f0-9]+_IN__/)
        expect(inAt).toBeGreaterThan(0)
        expect(paneText.slice(0, inAt)).toMatch(ZSH_PROMPT_THEN_ENTRY_RE) // the entry was typed at a `%` prompt
        expect(flowInfos(w.events, sid)).toContain('inner')
        expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
      } finally {
        try { await endSshRemote(sid) } catch { /* nothing launched, or the link is gone */ }
        killPty(sid)
      }
    })
  }, 400_000)
})

describe('rc.16 R1 -- `start -ai` attaches an entrypoint that need not be a shell: never auto-promoted (LIVE)', () => {
  const ready = Boolean(hosts.linuxRockyKey)
  const CTR = 'ccc-test-start'

  itIf(ready)('T26 `start -ai` on a stopped container: awaiting-claude/unverified (explicit consent), never inner, no sentinel, no launch write', async () => {
    const e = hosts.linuxRockyKey!
    rocky(`podman rm -f ${CTR} >/dev/null 2>&1; podman create --name ${CTR} -it --network=host localhost/ccc-test-img bash >/dev/null`)
    const sid = `lv26${Date.now().toString(36)}`
    const w = makeWin()
    try {
      spawnPty(w.win, sid, {
        ssh: { host: e.host, port: 22, username: e.username, remotePath: '~', detachable: false, runtime: { type: 'container', engine: 'podman', container: CTR, mode: 'start' } },
        provider: 'claude',
      } as never)
      await waitFor(() => states(w.events, sid).includes('awaiting-postcommand'), 60_000, 'awaiting-postcommand')
      getSshFlow(sid)!.runPostCommand()
      await waitFor(() => ['awaiting-claude', 'failed'].includes(lastFlow(w.events, sid)?.state ?? ''), 60_000, 'the attach to settle')
      expect(lastFlow(w.events, sid)).toEqual({ state: 'awaiting-claude', info: 'unverified' })
      expect(flowInfos(w.events, sid)).not.toContain('inner')
      expect(pane(w.events, sid)).not.toContain('__CCC_')
      expect(pane(w.events, sid)).not.toContain('base64 -d')
      getSshFlow(sid)!.skip()
    } finally {
      killPty(sid)
      try { rocky(`podman rm -f ${CTR} >/dev/null 2>&1 || true`) } catch { /* already gone */ }
    }
  }, 240_000)
})
