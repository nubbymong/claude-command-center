// tests/unit/ssh-tmux-push.test.ts
//
// #242 tier 4: pushing a pre-downloaded, sha256-verified tmux static build
// down an already-open SSH PTY as base64, for remotes tier 3 (curl/wget)
// could not reach because they have no outbound egress at all.
// buildTmuxPushLines()/buildTmuxPushCommand() are pure string builders
// (mirrors ssh-tmux-stage.test.ts) so every gate is asserted directly on
// text, without spinning up a PTY. Each assertion below was verified to
// actually FAIL against a deliberately broken version of the builder before
// being kept (see the implementer's report for the exact mutation + failure
// output).
import { describe, it, expect } from 'vitest'
import {
  chunkBase64,
  buildTmuxPushControlScript,
  buildTmuxPushLines,
  buildTmuxPushCommand,
  buildArchProbeCommand,
  buildArchProbeCommandBracketed,
  parseArchProbeSentinel,
  mapUnameToTarget,
  ARCH_PROBE_SENTINEL_PREFIX,
  PUSH_B64_LINE_MAX,
  SAFE_B64_RE,
} from '../../src/main/ssh-tmux-push'
import { buildTmuxStageScript, TMUX_STAGE_SHA256, TMUX_STAGE_SENTINEL_PREFIX, tmuxStageAssetUrl, type TmuxStageTarget } from '../../src/main/ssh-tmux-stage'

const ARCHES: TmuxStageTarget[] = ['linux-x86_64', 'linux-arm64', 'macos-x86_64', 'macos-arm64']

// #242 finding F1 (b): every builder below now requires a nonce.
const NONCE = 'testnonce123abc'

/** A synthetic "archive" big enough to require many chunk lines (~7.5x
 *  PUSH_B64_LINE_MAX), standing in for the real ~1.27 MB base64 payload
 *  without inflating the test suite's runtime/memory. */
function fakeTarGzBase64(sizeChars = PUSH_B64_LINE_MAX * 7 + 37): string {
  // Base64 alphabet only, so a coincidental match against real tmux bytes
  // is not something these tests depend on either way.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < sizeChars; i++) out += alphabet[i % alphabet.length]
  return out
}

/** Pull the LAST `echo '<b64>' | base64 -d | sh` line out of a lines[] and
 *  decode it back to the control script's raw shell text. */
function decodeControlLine(lines: string[]): string {
  const controlLine = lines[lines.length - 2] // [..., control-b64-line, 'stty echo ...']
  const m = controlLine.match(/^echo '([A-Za-z0-9+\/=]+)' \| base64 -d \| sh$/)
  expect(m).not.toBeNull()
  return Buffer.from(m![1], 'base64').toString('utf8')
}

describe('chunkBase64', () => {
  it('splits into maxLen-sized pieces, last piece carrying the remainder', () => {
    const chunks = chunkBase64('a'.repeat(2500), 1000)
    expect(chunks).toEqual(['a'.repeat(1000), 'a'.repeat(1000), 'a'.repeat(500)])
  })

  it('returns a single [""] for an empty string rather than []', () => {
    expect(chunkBase64('', 1000)).toEqual([''])
  })

  it('returns exactly one chunk when the input is shorter than maxLen', () => {
    expect(chunkBase64('abc', 1000)).toEqual(['abc'])
  })

  it('reassembles to the exact original input when concatenated back', () => {
    const original = fakeTarGzBase64(12345)
    expect(chunkBase64(original).join('')).toBe(original)
  })
})

describe('buildTmuxPushControlScript', () => {
  it('embeds the arch-specific sha256 digest from ssh-tmux-stage.ts, not a different one', () => {
    for (const arch of ARCHES) {
      const script = buildTmuxPushControlScript(arch, NONCE)
      expect(script).toContain(TMUX_STAGE_SHA256[arch])
      // No cross-contamination: the OTHER three archs' digests must not appear.
      for (const other of ARCHES) {
        if (other !== arch) expect(script).not.toContain(TMUX_STAGE_SHA256[other])
      }
    }
  })

  // Acceptance (a): the remote-side sha256 re-verification must actually gate
  // installation, in program order — decode, then re-verify, THEN chmod/mv.
  // Removing the check (installing straight off the decoded archive) fails
  // this test.
  it('re-verifies sha256 on the remote BEFORE chmod/install, gated by $_pdgok', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).toContain('sha256sum -c')
    expect(script).toContain('shasum -a 256 -c') // BSD/macOS fallback
    const dgIdx = script.indexOf('sha256sum -c')
    const dgOkIdx = script.indexOf('"$_pdgok" != "0"')
    const chmodIdx = script.indexOf('chmod 755')
    expect(dgIdx).toBeGreaterThan(-1)
    expect(dgOkIdx).toBeGreaterThan(dgIdx)
    expect(chmodIdx).toBeGreaterThan(dgOkIdx)
  })

  it('removes the decoded archive and installs nothing on a digest mismatch', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).toMatch(/"\$_pdgok" != "0" \]; then rm -f [^;]+; echo "[^"]*fail=digest"/)
  })

  it('never truncates the final install path directly — extracts to a sibling temp, chmods that, then mv -f', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).not.toMatch(/-O tmux > "?\$HOME\/\.claude\/bin\/tmux/)
    expect(script).toMatch(/tar -xzf [^ ]+ -O tmux > \$HOME\/\.claude\/bin\/\.tmux-push\.\$\$/)
    expect(script).toMatch(/mv -f \$HOME\/\.claude\/bin\/\.tmux-push\.\$\$ \$HOME\/\.claude\/bin\/tmux/)
  })

  it('reports the same ok/fail sentinel shape tier 3 uses, so pty-manager needs no new parser', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=digest`)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=extract`)
  })

  // #242 finding F1 (b): the nonce must be embedded in every sentinel this
  // control script emits.
  it('embeds the nonce in every sentinel literal buildTmuxPushControlScript can emit', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=digest`)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=extract`)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=terminfo`)
    expect(script).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
  })

  it('throws when the nonce fails the charset guard', () => {
    expect(() => buildTmuxPushControlScript('linux-x86_64', 'has a space')).toThrow(/nonce/i)
  })

  // #242 round-3 BLOCKER fix. Pre-fix, this function went digest-check ->
  // tar -> chmod -> mv -f -> straight to `ok path=...` with NO verification
  // the installed binary can actually open a terminal -- re-arming the
  // exact permanent landmine tier 3's own round-2 BLOCKER fix removed (see
  // ssh-tmux-stage.ts's buildTmuxStageScript doc comment, step 5). Mutation
  // to prove this can fail: delete the smoke-test block (the `_psmoke=...`
  // line through the matching `fi;`) from buildTmuxPushControlScript and
  // restore the bare `mv -f ...; echo "... ok path=..."` sequence -- the
  // `smokeIdx`/`newSessionIdx` lookups then return -1, and
  // `.toBeGreaterThan(mvIdx)` fails.
  it('runs a detached smoke test (tmux -V && new-session -d) after mv -f and BEFORE the ok sentinel', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    const mvIdx = script.indexOf('mv -f')
    const smokeIdx = script.indexOf('-V >/dev/null 2>&1 &&')
    const newSessionIdx = script.indexOf('new-session -d -s')
    const okIdx = script.indexOf(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
    expect(mvIdx).toBeGreaterThan(-1)
    expect(smokeIdx).toBeGreaterThan(mvIdx)
    expect(newSessionIdx).toBeGreaterThan(smokeIdx)
    expect(okIdx).toBeGreaterThan(newSessionIdx)
  })

  // Companion assertion: the failure arm of the smoke gate must remove the
  // just-installed (but terminfo-broken) binary before reporting failure --
  // "reported removal, not silent removal" (same reasoning tier 3's own
  // round-2 BLOCKER fix used). Mutation to prove this can fail: report
  // fail=terminfo without the preceding `rm -f $HOME/.claude/bin/tmux` --
  // the regex below requires the removal IMMEDIATELY before the sentinel.
  it('removes the pushed binary and reports fail=terminfo when the smoke test fails, mirroring tier 3', () => {
    const script = buildTmuxPushControlScript('linux-x86_64', NONCE)
    expect(script).toMatch(/rm -f \$HOME\/\.claude\/bin\/tmux; echo "[^"]*fail=terminfo"/)
  })

  // Applies to every arch, not just linux-x86_64 -- the smoke test targets
  // the SAME install path (PUSH_DEST_PATH) regardless of which arch's
  // archive was pushed.
  it('gates the ok sentinel behind the smoke test for every arch', () => {
    for (const arch of ARCHES) {
      const script = buildTmuxPushControlScript(arch, NONCE)
      const mvIdx = script.indexOf('mv -f')
      const okIdx = script.indexOf(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
      const smokeIdx = script.indexOf('new-session -d -s')
      expect(smokeIdx).toBeGreaterThan(mvIdx)
      expect(okIdx).toBeGreaterThan(smokeIdx)
    }
  })
})

describe('buildTmuxPushLines', () => {
  // Acceptance (b): a ~1.27 MB transfer typed one bounded line at a time
  // must never be echoed into the visible pane. Mutation to prove this can
  // fail: delete the 'stty -echo'/'stty echo' push()es in buildTmuxPushLines
  // — the two assertions below then fail because the first/last lines
  // become 'mkdir -p ...' and the control line respectively.
  it('brackets the ENTIRE line sequence in stty -echo / stty echo', () => {
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    expect(lines[0]).toBe('stty -echo 2>/dev/null')
    expect(lines[lines.length - 1]).toBe('stty echo 2>/dev/null')
  })

  it('creates ~/.claude/bin defensively before writing into it', () => {
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    expect(lines).toContain('mkdir -p "$HOME/.claude/bin" 2>/dev/null')
  })

  it('splits the payload across multiple chunk lines rather than one giant line', () => {
    const b64 = fakeTarGzBase64() // ~7.5x PUSH_B64_LINE_MAX
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: b64, nonce: NONCE })
    const chunkLines = lines.filter((l) => /^echo '[A-Za-z0-9+\/=]*' >> /.test(l))
    expect(chunkLines.length).toBeGreaterThan(1)
    expect(chunkLines.length).toBe(Math.ceil(b64.length / PUSH_B64_LINE_MAX))
  })

  // Acceptance (c): no single line may exceed a safe length. 4096 is the
  // canonical-mode tty line-discipline limit this constant exists to stay
  // under (see PUSH_B64_LINE_MAX's doc comment) — asserted against the FULL
  // line (including the `echo '…' >> <path>` wrapper), not just the base64
  // substring, since the wrapper's overhead is what a naive "just don't
  // chunk the base64 itself" fix would forget to account for.
  it('never emits a line longer than the safe tty canonical-mode limit', () => {
    const b64 = fakeTarGzBase64(200_000) // well beyond one line at any reasonable chunk size
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: b64, nonce: NONCE })
    const SAFE_TTY_LINE_MAX = 4096
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(SAFE_TTY_LINE_MAX)
    }
    // And the invariant is doing real work, not vacuously true because
    // nothing this long was ever produced.
    expect(lines.some((l) => l.length > PUSH_B64_LINE_MAX)).toBe(true)
  })

  it('concatenating every chunk line\'s base64 payload back together reproduces the exact original archive bytes', () => {
    const b64 = fakeTarGzBase64(54321) // not a multiple of PUSH_B64_LINE_MAX
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: b64, nonce: NONCE })
    const reassembled = lines
      .filter((l) => /^echo '[A-Za-z0-9+\/=]*' >> /.test(l))
      .map((l) => l.match(/^echo '([A-Za-z0-9+\/=]*)' >> /)![1])
      .join('')
    expect(reassembled).toBe(b64)
  })

  it('base64-wraps the control line so its sentinel literals never appear in plaintext', () => {
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    const joined = lines.join('\n')
    // Mutation to prove this can fail: inline buildTmuxPushControlScript's
    // raw text directly instead of base64-wrapping it — every one of these
    // then fails, because the raw control script contains the prefix and
    // every fail=/ok literal verbatim (mirrors the equivalent
    // buildTmuxStageCommand test in ssh-tmux-stage.test.ts).
    expect(joined).not.toContain(TMUX_STAGE_SENTINEL_PREFIX)
    expect(joined).not.toContain('fail=digest')
    expect(joined).not.toContain('fail=extract')
    expect(joined).not.toContain('ok path=')
    expect(joined).not.toContain('sha256sum')
  })

  it('the control line decodes back to EXACTLY buildTmuxPushControlScript for the same arch', () => {
    for (const arch of ARCHES) {
      const lines = buildTmuxPushLines({ arch, tarGzBase64: 'AAAA', nonce: NONCE })
      expect(decodeControlLine(lines)).toBe(buildTmuxPushControlScript(arch, NONCE))
    }
  })

  it('is deterministic for the same input', () => {
    const input = { arch: 'linux-x86_64' as const, tarGzBase64: fakeTarGzBase64(), nonce: NONCE }
    expect(buildTmuxPushLines(input)).toEqual(buildTmuxPushLines(input))
  })

  // #242 round-2 BLOCKER regression test. The accumulator file is written by
  // the interactive remote shell (chunk lines, `>>`) but read by a DIFFERENT
  // `sh` process piped in via the control line (`base64 -d | sh`) -- proven
  // empirically in this worktree that a bare `$$`-suffixed literal resolves
  // to two DIFFERENT pids across that process boundary (the piped `sh`'s own
  // pid, not the interactive shell's). The fix captures the path ONCE, in
  // the interactive shell, into an exported variable both sides read --
  // this test extracts the `>>` target from a chunk line and the `<` source
  // from the DECODED control script and asserts they are the literal same
  // shell expression. Mutation to prove this can fail: revert
  // buildTmuxPushControlScript to read a raw `$HOME/.../.ccc-tmux-push.$$.b64`
  // literal instead of `"$PUSH_ACCUMULATOR_PATH"` -- the two sides then
  // diverge (`"$PUSH_ACCUMULATOR_PATH"` vs a literal path containing `$$`)
  // and this assertion fails. See the implementer's report for the actual
  // failure output.
  it('the chunk-write target and the control script\'s read source are the exact same shell expression', () => {
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    const chunkLine = lines.find((l) => /^echo '[A-Za-z0-9+\/=]*' >> /.test(l))
    expect(chunkLine).toBeDefined()
    const writeTarget = chunkLine!.match(/>> (.+)$/)?.[1]
    expect(writeTarget).toBeDefined()

    const control = decodeControlLine(lines)
    const readSource = control.match(/base64 -d < (\S+) >/)?.[1]
    expect(readSource).toBeDefined()

    expect(readSource).toBe(writeTarget)
    // And it must not be a literal containing `$$` -- a bare `$$`-suffixed
    // path is exactly the shape that resolves to two different pids across
    // the interactive-shell / piped-sh process boundary (the bug this test
    // guards against). It must be a variable reference the interactive
    // shell set ONCE and exported.
    expect(writeTarget).not.toMatch(/\$\$/)
    expect(readSource).not.toMatch(/\$\$/)
  })

  // Companion assertion: the exported-variable capture line must actually
  // exist, must be the one place `$$` is evaluated for the accumulator path,
  // and must run BEFORE the first chunk line (so the variable exists by the
  // time the interactive shell needs it).
  it('captures the accumulator path once (with $$) into an exported variable, before any chunk line', () => {
    const lines = buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    const captureIdx = lines.findIndex((l) => /^\w+=\$HOME\/.*\$\$.*; export \w+$/.test(l))
    expect(captureIdx).toBeGreaterThan(-1)
    const firstChunkIdx = lines.findIndex((l) => /^echo '[A-Za-z0-9+\/=]*' >> /.test(l))
    expect(firstChunkIdx).toBeGreaterThan(captureIdx)
  })
})

describe('SAFE_B64_RE / non-base64 payload rejection (#242 round-2 MAJOR fix)', () => {
  it('accepts real base64 alphabet + padding', () => {
    expect(SAFE_B64_RE.test('AAAA')).toBe(true)
    expect(SAFE_B64_RE.test('YQ==')).toBe(true)
    expect(SAFE_B64_RE.test('')).toBe(true)
    expect(SAFE_B64_RE.test(fakeTarGzBase64())).toBe(true)
  })

  it('rejects a payload containing a single quote', () => {
    expect(SAFE_B64_RE.test("AAAA'; rm -rf ~ #")).toBe(false)
  })

  // The actual injection boundary: buildTmuxPushLines interpolates
  // tarGzBase64 into single-quoted remote shell text (`echo '<chunk>' >>
  // ...`). A `'` in the input closes that quote early. Mutation to prove
  // this can fail: delete the `SAFE_B64_RE.test(...)` guard at the top of
  // buildTmuxPushLines -- this test then fails because the throw never
  // happens and the malicious payload is emitted verbatim.
  it('buildTmuxPushLines throws rather than emit a payload containing a single quote', () => {
    expect(() =>
      buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: "AAAA'; touch $HOME/pwned; echo '", nonce: NONCE }),
    ).toThrow()
  })

  it('buildTmuxPushLines does not throw on a genuine base64 payload', () => {
    expect(() => buildTmuxPushLines({ arch: 'linux-x86_64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })).not.toThrow()
  })
})

describe('buildTmuxPushCommand (wire form fed through runChunkedWrite)', () => {
  it('joins every line with a trailing \\r, matching how pty-manager writes other PTY commands', () => {
    const input = { arch: 'linux-x86_64' as const, tarGzBase64: fakeTarGzBase64(10), nonce: NONCE }
    const lines = buildTmuxPushLines(input)
    expect(buildTmuxPushCommand(input)).toBe(lines.map((l) => `${l}\r`).join(''))
  })

  it('never contains the sentinel prefix or any fail=/ok literal in plaintext, at full scale', () => {
    const wire = buildTmuxPushCommand({ arch: 'macos-arm64', tarGzBase64: fakeTarGzBase64(), nonce: NONCE })
    expect(wire).not.toContain(TMUX_STAGE_SENTINEL_PREFIX)
    expect(wire).not.toContain('fail=digest')
    expect(wire).not.toContain('fail=extract')
    expect(wire).not.toContain('ok path=')
  })

  it('is deterministic and reproduces the archive bytes when every chunk line is decoded and concatenated', () => {
    const b64 = fakeTarGzBase64(98765)
    const wire = buildTmuxPushCommand({ arch: 'linux-arm64', tarGzBase64: b64, nonce: NONCE })
    // Chunk lines write to the exported accumulator variable ("$VAR"), not a
    // literal $HOME/...-suffixed path -- see PUSH_ACCUMULATOR_VAR's doc
    // comment in ssh-tmux-push.ts (#242 round-2 BLOCKER fix: a literal
    // $$-suffixed path here would resolve to a DIFFERENT pid than the one
    // the control script's piped `sh` reads).
    const reassembled = [...wire.matchAll(/echo '([A-Za-z0-9+\/=]*)' >> "\$\w+"/g)]
      .map((m) => m[1])
      .join('')
    expect(reassembled).toBe(b64)
  })
})

describe('mapUnameToTarget / buildArchProbeCommand / parseArchProbeSentinel', () => {
  it('maps all four uname combos ssh-tmux-stage.ts recognizes, and rejects anything else', () => {
    expect(mapUnameToTarget('Linux-x86_64')).toBe('linux-x86_64')
    expect(mapUnameToTarget('Linux-aarch64')).toBe('linux-arm64')
    expect(mapUnameToTarget('Linux-arm64')).toBe('linux-arm64')
    expect(mapUnameToTarget('Darwin-x86_64')).toBe('macos-x86_64')
    expect(mapUnameToTarget('Darwin-arm64')).toBe('macos-arm64')
    expect(mapUnameToTarget('SunOS-sparc64')).toBeNull()
    expect(mapUnameToTarget('')).toBeNull()
  })

  it('parses a real (post-execution) probe reply into the right target', () => {
    expect(parseArchProbeSentinel(`${ARCH_PROBE_SENTINEL_PREFIX} Linux-x86_64\r\n`)).toBe('linux-x86_64')
  })

  it('returns undefined (not a false match) for a chunk-truncated reply', () => {
    expect(parseArchProbeSentinel(`${ARCH_PROBE_SENTINEL_PREFIX} Linux-x86`)).toBeUndefined()
  })

  it('returns undefined when the sentinel is absent from this chunk', () => {
    expect(parseArchProbeSentinel('some unrelated PTY output\r\n')).toBeUndefined()
  })

  // The actual echo-immunity property buildArchProbeCommand's doc comment
  // argues for: the UNEXPANDED, as-typed command text (what a terminal
  // echoes back WHILE the line is being entered, before the shell has run
  // anything) must never itself satisfy parseArchProbeSentinel — mirrors the
  // "echo immunity" regression block in pty-manager-ssh-tmux.test.ts for
  // tier 3, but exercised directly here since this probe is deliberately
  // plaintext rather than base64-wrapped.
  it('the command\'s own pre-execution (as-typed) text never satisfies its own parser', () => {
    const typed = buildArchProbeCommand()
    // Simulate the terminal echoing the line back exactly as typed, followed
    // by the real \r\n from pressing Enter to submit it.
    expect(parseArchProbeSentinel(`${typed}\r\n`)).toBeUndefined()
  })

  it('is deterministic and contains no chunk-of-a-real-archive-shaped text', () => {
    expect(buildArchProbeCommand()).toBe(buildArchProbeCommand())
    expect(buildArchProbeCommand()).toContain('uname -s')
    expect(buildArchProbeCommand()).toContain('uname -m')
  })
})

// #242 round-3 MINOR fix: the raw probe (buildArchProbeCommand) is
// plaintext, so both the outgoing command and its reply were visible in the
// user's pane -- unlike everything else tier 3/4 writes. Mutation to prove
// this can fail: revert buildArchProbeCommandBracketed to `return
// buildArchProbeCommand()` (no bracket) -- the first assertion below then
// fails because the line no longer starts with 'stty -echo'.
describe('buildArchProbeCommandBracketed (#242 round-3 MINOR fix)', () => {
  it('brackets the raw probe in stty -echo / stty echo', () => {
    const bracketed = buildArchProbeCommandBracketed()
    expect(bracketed).toBe(`stty -echo 2>/dev/null; ${buildArchProbeCommand()}; stty echo 2>/dev/null`)
    expect(bracketed.startsWith('stty -echo')).toBe(true)
    expect(bracketed.endsWith('stty echo 2>/dev/null')).toBe(true)
  })

  it('does not collide with the base64 -d | sh substring pty-manager tests use to identify the tier-3 staging write', () => {
    expect(buildArchProbeCommandBracketed()).not.toContain('base64 -d | sh')
  })

  it('the bracketed command\'s own pre-execution (as-typed) text still never satisfies its own parser', () => {
    const typed = buildArchProbeCommandBracketed()
    expect(parseArchProbeSentinel(`${typed}\r\n`)).toBeUndefined()
  })
})

// #242 round-3 MINOR fix: mapUnameToTarget (host-side, callable TS) and
// buildTmuxStageScript's `case "$_u-$_m" in ... esac` block (remote shell
// text) must recognise the EXACT same set of uname combos -- the item's own
// doc comment claimed they already did, with no test tying them together, so
// a combo added to either side alone could silently drift from the other.
// This parses the real remote script text back out (not a re-derivation of
// either table's logic) and cross-checks both directions.
describe('mapUnameToTarget stays in lockstep with buildTmuxStageScript\'s case table (#242 round-3 MINOR fix)', () => {
  const SFX_TO_TARGET: Record<string, TmuxStageTarget> = {
    'linux-x86_64': 'linux-x86_64',
    'linux-arm64': 'linux-arm64',
    'macos-x86_64': 'macos-x86_64',
    'macos-arm64': 'macos-arm64',
  }

  /** Parse the `case "$_u-$_m" in ... esac` block out of the REAL remote
   *  script text and return every combo it recognises, mapped to the target
   *  its clause assigns. The wildcard `*) _sfx="";;` clause (the
   *  "unrecognised" case) is intentionally excluded -- it has no target. */
  function extractShellCombos(): Record<string, TmuxStageTarget> {
    const script = buildTmuxStageScript(NONCE)
    const caseBlock = script.match(/case "\$_u-\$_m" in ([\s\S]*?) esac/)
    expect(caseBlock).not.toBeNull()
    const body = caseBlock![1]
    const out: Record<string, TmuxStageTarget> = {}
    const clauseRe = /([^)]+)\) _sfx=(\S+?);;/g
    let m: RegExpExecArray | null
    while ((m = clauseRe.exec(body))) {
      const combos = m[1].trim()
      const sfx = m[2]
      if (combos === '*') continue // the unrecognised-combo fallthrough, not a real target
      const target = SFX_TO_TARGET[sfx]
      expect(target).toBeDefined() // an _sfx this test doesn't know means SFX_TO_TARGET itself is stale
      for (const combo of combos.split('|')) out[combo.trim()] = target
    }
    return out
  }

  /** Extract every `case '<combo>':` label straight out of
   *  mapUnameToTarget's OWN (transpiled) source via Function#toString --
   *  deliberately NOT a second hand-typed list of "the combos it currently
   *  accepts", which would just be a THIRD copy of the same table with the
   *  same drift risk as the two this test exists to tie together. A combo
   *  added to the switch is discovered here automatically. */
  function extractMapUnameCombos(): string[] {
    const src = mapUnameToTarget.toString()
    return [...src.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((m) => m[1])
  }

  // Mutation to prove this can fail: add a fifth combo (e.g.
  // `Linux-riscv64`) to ONLY buildTmuxStageScript's case block -- extractShellCombos
  // then reports a combo mapUnameToTarget's switch has no case for, and
  // `mapUnameToTarget(combo)` returns `null` instead of the expected target.
  it('every combo the shell case table recognises maps to the SAME target via mapUnameToTarget', () => {
    const shellCombos = extractShellCombos()
    expect(Object.keys(shellCombos).length).toBeGreaterThan(0)
    for (const [combo, target] of Object.entries(shellCombos)) {
      expect(mapUnameToTarget(combo)).toBe(target)
    }
  })

  // Mutation to prove this can fail: add a case to ONLY mapUnameToTarget's
  // switch (e.g. `case 'SunOS-sparc64': return 'linux-x86_64'`), leaving the
  // shell table untouched -- extractMapUnameCombos then reports a combo
  // extractShellCombos never produced, so `shellCombos[combo]` is undefined
  // and the first assertion below fails (independently of whichever
  // pre-existing test also happens to notice the new combo).
  it('mapUnameToTarget recognises nothing the shell table does not', () => {
    const shellCombos = extractShellCombos()
    const tsCombos = extractMapUnameCombos()
    expect(tsCombos.length).toBeGreaterThan(0)
    for (const combo of tsCombos) {
      expect(shellCombos[combo]).toBeDefined()
    }
    // And the two sets are the SAME SIZE -- catches a combo added to the
    // shell table without ALSO adding the matching case (the previous test
    // already catches that via a wrong-target/null mismatch, but a size
    // check here is a second, independent tripwire on the exact same drift).
    expect(tsCombos.length).toBe(Object.keys(shellCombos).length)
  })
})

// #242 finding F6 (adversarial review round 4, MINOR): the release-asset URL
// was hand-built TWICE -- once as remote shell text in buildTmuxStageScript
// (this module's `_url="..."` line) and again as a TS template literal in
// pty-manager.ts's downloadAndCacheTmuxArchive -- with no shared constant and
// no test tying them together. Both now build from the SAME
// TMUX_ASSET_FILENAME_PREFIX/SUFFIX + tmuxReleaseBaseUrl() parts (only the
// arch differs: a shell variable on the remote, a TS string on the host).
// This parses the real remote script's `_url=` assignment back out (not a
// re-derivation of either side's logic) and cross-checks it against
// tmuxStageAssetUrl(arch) for every recognised arch.
describe('tmuxStageAssetUrl stays in lockstep with the remote script\'s curl/wget URL (#242 finding F6)', () => {
  /** Pull the `_url="..."` template straight out of the REAL remote script
   *  text -- `$_sfx` is the shell variable the remote substitutes with the
   *  arch suffix at runtime; substituting it with a literal arch string here
   *  is the host-side equivalent of that shell expansion. */
  function extractRemoteUrlTemplate(): string {
    const script = buildTmuxStageScript(NONCE)
    const m = script.match(/_url="([^"]+)";/)
    expect(m).not.toBeNull()
    return m![1]
  }

  // Mutation to prove this can fail: change ONLY pty-manager.ts's
  // downloadAndCacheTmuxArchive (or ssh-tmux-stage.ts's buildTmuxStageScript)
  // to hand-build a differently-shaped URL again (e.g. a different owner/repo
  // or filename template) instead of sharing tmuxReleaseBaseUrl()/
  // TMUX_ASSET_FILENAME_PREFIX/SUFFIX -- the two sides drift and this
  // assertion fails for every arch.
  it('the remote script curls the exact URL tmuxStageAssetUrl(arch) builds host-side, for every recognised arch', () => {
    const template = extractRemoteUrlTemplate()
    for (const arch of ARCHES) {
      const remoteUrl = template.replace('$_sfx', arch)
      expect(remoteUrl).toBe(tmuxStageAssetUrl(arch))
    }
  })

  it('resolves to a well-formed https URL under the tmux-builds release path', () => {
    for (const arch of ARCHES) {
      const url = tmuxStageAssetUrl(arch)
      expect(url).toMatch(/^https:\/\/github\.com\/tmux\/tmux-builds\/releases\/download\/v[0-9A-Za-z.]+\/tmux-[0-9A-Za-z.]+-.+\.tar\.gz$/)
    }
  })
})
