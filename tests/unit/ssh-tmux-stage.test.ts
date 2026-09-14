// tests/unit/ssh-tmux-stage.test.ts
//
// #242 tier 3: staging tmux on the remote via curl/wget + a pinned,
// sha256-verified upstream static build. buildTmuxStageCommand(NONCE) is a pure
// string builder (mirrors ssh-tmux.test.ts) so every gate in the emitted
// POSIX fragment is asserted directly on its text, without spinning up a
// PTY. Each assertion below was verified to actually FAIL against a
// deliberately broken version of the builder before being kept (see the
// implementer's report for the exact mutation + failure output).
import { describe, it, expect } from 'vitest'
import { buildTmuxStageScript, buildTmuxStageCommand, TMUX_STAGE_TAG, TMUX_STAGE_SHA256, TMUX_STAGE_SENTINEL_PREFIX, assertSafeNonce } from '../../src/main/ssh-tmux-stage'

// #242 finding F1 (b): every buildTmuxStageScript/buildTmuxStageCommand call
// below now requires a nonce -- a fixed test value stands in for the real
// per-session randomId() pty-manager.ts generates.
const NONCE = 'testnonce123abc'
// NOTE: this module deliberately does NOT import pty-manager (its own doc
// comment: "unit-testable without the pty-manager dependency graph" --
// pty-manager pulls in node-pty, which is not safe to import unmocked under
// plain vitest/node). The echo-immunity regression that feeds
// buildTmuxStageCommand(NONCE)'s output into the REAL parseTmuxStageSentinel
// lives in pty-manager-ssh-tmux.test.ts instead, which already mocks
// node-pty/electron for exactly this reason.

// buildTmuxStageScript(NONCE) is the raw, readable POSIX fragment -- every
// structural gate below (sha256 check, version pin, terminfo probe, etc.)
// is asserted against ITS text. buildTmuxStageCommand(NONCE) is the wire form
// pty-manager actually writes to the PTY (base64-wrapped -- see the
// dedicated describe block near the bottom of this file); it is
// deliberately NOT what these structural tests exercise, since after the
// #242 round-3 MAJOR fix its text is opaque base64, not readable shell.
describe('buildTmuxStageScript', () => {
  it('detects arch/os via uname -s / uname -m', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toContain('uname -s')
    expect(cmd).toContain('uname -m')
  })

  it('maps all four tmux-builds targets off the uname result', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/Linux-x86_64\)\s*_sfx=linux-x86_64/)
    expect(cmd).toMatch(/Linux-(aarch64\|Linux-arm64|arm64)\)\s*_sfx=linux-arm64/)
    expect(cmd).toMatch(/Darwin-x86_64\)\s*_sfx=macos-x86_64/)
    expect(cmd).toMatch(/Darwin-arm64\)\s*_sfx=macos-arm64/)
  })

  it('emits fail=arch when the uname combo matches none of the four targets', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/_sfx=""[\s\S]*fail=arch/)
  })

  // Follow-up adversarial pass (fail-posture MAJOR): both fetchers must be
  // time-bounded well inside the host's 20s STAGE_TIMEOUT_MS (a function-local
  // const in pty-manager.ts, not exported -- the literal 20 below mirrors it).
  // Unbounded, a DROP-egress host blocks curl for ~127s of SYN retries and GNU
  // wget then retries 20 times: the host-side timer fires at 20s and queues the
  // claude launch into a tty that is still mid-download with echo off, and the
  // fail=download sentinel (the thing that unlocks tier 4) is never printed.
  it('downloads with a bounded curl, then bounded wget, then a busybox-safe bounded wget, all inside the 20s stage budget', () => {
    const cmd = buildTmuxStageScript(NONCE)
    // curl leg: BOTH a connect bound and a total-time bound, into the temp file.
    const curlLeg = cmd.match(/curl [^|;]*"\$_tmp"/)?.[0] ?? ''
    expect(curlLeg).toMatch(/--connect-timeout \d+/)
    expect(curlLeg).toMatch(/--max-time \d+/)
    expect(curlLeg).toMatch(/-o "\$_tmp"/)
    // First wget leg (GNU): -T (network timeout) AND -t 1 (GNU defaults to
    // --tries=20, which alone blows the budget).
    expect(cmd).toMatch(/wget -q -T \d+ -t 1 -O "\$_tmp" "\$_url"/)
    // Second wget leg (busybox-safe): -T but NO -t -- busybox wget (Alpine,
    // OpenWrt) has no -t flag at all and usage-errors out of the GNU form.
    expect(cmd).toMatch(/wget -q -T \d+ -O "\$_tmp" "\$_url"/)
    // Round-2 adversarial pass (MAJOR): that busybox-safe leg MUST be gated on
    // the wget actually being busybox. Ungated it also runs after a GENUINE
    // failure of the GNU leg, re-running GNU wget without -t -- 20 retries,
    // ~100s, right back outside the budget on a curl-less DROP-egress host.
    expect(cmd).toMatch(/wget --help 2>&1 \| head -n 1 \| grep -qi busybox\s*&&\s*wget -q -T \d+ -O "\$_tmp"/)
    // The three are chained with || in exactly that order: curl, GNU wget,
    // busybox-gated wget -- each only runs if the previous fetcher failed.
    expect(cmd).toMatch(/curl [^|]*\|\|\s*wget -q -T \d+ -t 1 [^|]*\|\|\s*\{ wget --help/)
    // Every timeout number any leg carries stays inside the 20s stage budget.
    const timeouts = [...cmd.matchAll(/--connect-timeout (\d+)|--max-time (\d+)|-T (\d+)/g)]
      .map((m) => Number(m[1] ?? m[2] ?? m[3]))
    expect(timeouts.length).toBeGreaterThanOrEqual(4) // curl x2 + one -T per wget leg
    for (const t of timeouts) {
      expect(t).toBeGreaterThan(0)
      expect(t).toBeLessThanOrEqual(20)
    }
    expect(cmd).toMatch(/_tmp=\$\(mktemp/)
  })

  // Invariant form of the same fix, deliberately NOT pinned to today's literal
  // flags: split the fragment into individual commands and require that EVERY
  // curl invocation carries --max-time and EVERY wget invocation carries -T.
  // This is the test that must fail if someone later adds a new, unbounded
  // fetcher (or drops the bound from an existing one) anywhere in the script,
  // even if the shape-pinning test above is updated to match the new layout.
  it('contains no unbounded fetch: every curl has --max-time and every wget has -T', () => {
    const cmd = buildTmuxStageScript(NONCE)
    // Command separators in this fragment: ||, |, ;, and subshell parens.
    const fragments = cmd.split(/\|\||[|;()]/)
    const curlFragments = fragments.filter((f) => /\bcurl\b/.test(f))
    // `wget --help` is an implementation PROBE, not a fetch: it touches no
    // network, cannot hang on a dead route, and carrying a -T on it would be
    // meaningless. Everything else calling wget is a fetch and must be bounded.
    const wgetFragments = fragments.filter((f) => /\bwget\b/.test(f) && !/wget --help/.test(f))
    // Guard the guard: the script must actually contain both fetchers, so an
    // accidental tokenizer change cannot turn this test into a vacuous pass.
    expect(curlFragments.length).toBeGreaterThanOrEqual(1)
    expect(wgetFragments.length).toBeGreaterThanOrEqual(2)
    for (const f of curlFragments) {
      expect(f, `unbounded curl invocation: ${f}`).toMatch(/--max-time \d+/)
    }
    for (const f of wgetFragments) {
      expect(f, `unbounded wget invocation: ${f}`).toMatch(/-T \d+/)
    }
  })

  // Adversarial review round 2, MINOR: a predictable /tmp path fallback on
  // a host without `mktemp` lets a co-tenant pre-plant a symlink at that
  // exact path, which curl/wget then follow. The fallback must land inside
  // $HOME/.claude/bin (a directory only this user can write to), never a
  // world-writable /tmp guess.
  it('falls back to a path inside $HOME/.claude/bin, never a predictable /tmp path, when mktemp is unavailable', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).not.toMatch(/\/tmp\/ccc-tmux-stage/)
    expect(cmd).toMatch(/mktemp 2>\/dev\/null \|\| \{[^}]*\$HOME\/\.claude\/bin\/\.ccc-tmux-stage\.\$\$/)
  })

  it('treats an empty/missing download as a distinct failure, not a digest failure', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/if \[ ! -s "\$_tmp" \][\s\S]*?fail=download/)
  })

  // Acceptance (a): the sha256 verification step must actually gate
  // installation. Removing it (installing straight off the download) must
  // fail this test.
  it('verifies the download against the embedded sha256 before installing, with a shasum -a 256 fallback', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toContain('sha256sum -c')
    expect(cmd).toContain('shasum -a 256 -c')
    // Structural gate, not just presence: the digest check must appear
    // BEFORE the chmod/install step in program order, and the chmod must
    // sit inside the digest-ok branch (guarded by $_dgok), not run
    // unconditionally after a bare download.
    const dgIdx = cmd.indexOf('sha256sum -c')
    const dgOkIdx = cmd.indexOf('"$_dgok" != "0"')
    const chmodIdx = cmd.indexOf('chmod 755')
    expect(dgIdx).toBeGreaterThan(-1)
    expect(dgOkIdx).toBeGreaterThan(dgIdx)
    expect(chmodIdx).toBeGreaterThan(dgOkIdx)
  })

  it('embeds a distinct sha256 constant per architecture, all 64 hex chars', () => {
    const cmd = buildTmuxStageScript(NONCE)
    const values = Object.values(TMUX_STAGE_SHA256)
    expect(values).toHaveLength(4)
    const unique = new Set(values)
    expect(unique.size).toBe(4)
    for (const sha of values) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/)
      expect(cmd).toContain(sha)
    }
  })

  it('removes the temp file and installs nothing on a digest mismatch', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/"\$_dgok" != "0" \]; then rm -f "\$_tmp"; echo "[^"]*fail=digest"/)
  })

  // Acceptance (b): the release URL must carry the exact pinned tag, not a
  // floating alias -- a `latest` URL must fail this test.
  it('pins the download URL to the exact v3.7b tag, not a floating alias', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(TMUX_STAGE_TAG).toBe('v3.7b')
    expect(cmd).toContain('/tmux-builds/releases/download/v3.7b/tmux-3.7b-')
    expect(cmd).not.toContain('/latest/')
    expect(cmd).not.toMatch(/\blatest\b/)
  })

  it('installs the verified binary to ~/.claude/bin/tmux at mode 755', () => {
    const cmd = buildTmuxStageScript(NONCE)
    // Round-2 fix: tar extracts to a SIBLING temp file, not straight at the
    // final install path (see the never-truncates-live-path test below) --
    // chmod 755 applies to that sibling, and only a successful `mv -f`
    // afterward puts the verified, executable file at the real path.
    expect(cmd).toMatch(/tar -xzf "\$_tmp" -O tmux > "\$_dst" 2>\/dev\/null/)
    expect(cmd).toContain('chmod 755 "$_dst"')
    expect(cmd).toMatch(/mv -f "\$_dst" "\$HOME\/\.claude\/bin\/tmux"/)
  })

  // Adversarial review round 2, MAJOR: the previous shape
  // (`tar ... -O tmux > "$HOME/.claude/bin/tmux"`) truncates the install
  // path the instant the redirect opens, before tar has extracted anything
  // -- a failed extract (or a second, concurrent staging session on the
  // same host) could leave a 0-byte or corrupted file at the live path.
  // Fails if tar's stdout is ever redirected straight at the final path.
  it('never redirects tar output directly at the final install path', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).not.toMatch(/-O tmux > "\$HOME\/\.claude\/bin\/tmux"/)
  })

  // Extract failure must remove only the sibling temp (and the downloaded
  // archive), never touch whatever was already at the install path.
  it('removes only the sibling temp file on extract failure, not the install path', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/rm -f "\$_dst" "\$_tmp"; echo "[^"]*fail=extract"/)
  })

  // Acceptance (c): dropping the smoke test (or the detached new-session
  // probe specifically) must fail this test.
  it('smoke-tests the installed binary with -V plus a detached new-session -d ... true', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toMatch(/"\$HOME\/\.claude\/bin\/tmux" -V >\/dev\/null 2>&1/)
    expect(cmd).toMatch(/new-session\s+-d\s+-s\s+"\$_smoke"\s+true/)
  })

  // Adversarial review round 2, BLOCKER: a chmod-755 tmux left in place at
  // the exact tier-2 probe path after a failed smoke test gets picked up
  // (X_OK-only probe, no run) by every LATER session to the same host,
  // which then wraps claude in it and never launches claude again. The
  // fail=terminfo branch must remove/de-executable the install path -- this
  // is the INVERSE of the old assertion (which locked the defect in by
  // asserting the branch must NOT call rm).
  it('emits a distinct fail=terminfo sentinel on smoke failure and removes the just-installed binary', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=terminfo`)
    const terminfoBranch = cmd.slice(cmd.indexOf('new-session'), cmd.indexOf('fail=terminfo') + 'fail=terminfo'.length)
    expect(terminfoBranch).toMatch(/rm -f "\$HOME\/\.claude\/bin\/tmux"/)
  })

  it('reports an absolute shell-expanded path on success, never a literal tilde', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
    expect(cmd).not.toMatch(/path=~/)
  })

  // #242 finding F1 (b): every sentinel this script can emit -- ok AND every
  // fail=* variant -- must carry the nonce. Mutation to prove this can fail:
  // drop `${nonce}` from any one of the six echo lines in
  // buildTmuxStageScript -- that specific assertion below fails while the
  // others (built off a DIFFERENT literal) stay green, proving each is
  // independently load-bearing rather than one shared false-positive.
  it('embeds the nonce in every sentinel literal this script can emit', () => {
    const cmd = buildTmuxStageScript(NONCE)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=arch`)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=download`)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=digest`)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=extract`)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} fail=terminfo`)
    expect(cmd).toContain(`${TMUX_STAGE_SENTINEL_PREFIX} ${NONCE} ok path=$HOME/.claude/bin/tmux`)
  })

  it('is syntactically balanced: equal if/fi and case/esac counts', () => {
    const cmd = buildTmuxStageScript(NONCE)
    const count = (re: RegExp) => (cmd.match(re) ?? []).length
    expect(count(/\bif\b/g)).toBe(count(/\bfi\b/g))
    expect(count(/\bcase\b/g)).toBe(count(/\besac\b/g))
  })

  it('returns a deterministic, side-effect-free single-line fragment', () => {
    const a = buildTmuxStageScript(NONCE)
    const b = buildTmuxStageScript(NONCE)
    expect(a).toBe(b)
    expect(a).not.toContain('\n')
  })
})

// M5 (adversarial review round 5): assertSafeTmuxStageConstants had ZERO
// tests, and writeTmuxStageCmd's call-site comment in pty-manager.ts claimed
// buildTmuxStageCommand "cannot throw" -- contradicting the guard's own doc
// comment and its throw sites. These prove the throw is real AND that the
// call site (verified separately in pty-manager-ssh-tmux.test.ts) degrades
// to the bare launch rather than propagating it.
describe('assertSafeTmuxStageConstants guard (M5)', () => {
  it('throws when the nonce fails the [A-Za-z0-9]+ charset guard', () => {
    expect(() => buildTmuxStageScript('has a space')).toThrow(/nonce/i)
    expect(() => buildTmuxStageScript('has;metachar')).toThrow(/nonce/i)
    expect(() => buildTmuxStageScript('')).toThrow()
  })

  // Mutation to prove this can fail: comment out the
  // `for (const [arch, sha] of ...)` loop inside assertSafeTmuxStageConstants
  // -- this test then throws NOTHING (buildTmuxStageScript happily embeds
  // the corrupted digest into the emitted fragment) and the assertion below
  // fails. TMUX_STAGE_SHA256 is declared `const` but is a plain object --
  // `const` only freezes the BINDING, not its contents -- so mutating one
  // entry and restoring it afterward is a legitimate way to exercise the
  // guard against a real corrupted-constant shape without touching the
  // module's source.
  it('throws when a TMUX_STAGE_SHA256 entry is corrupted to a non-hex/wrong-length value', () => {
    const original = TMUX_STAGE_SHA256['linux-x86_64']
    TMUX_STAGE_SHA256['linux-x86_64'] = 'not-a-real-digest'
    try {
      expect(() => buildTmuxStageScript(NONCE)).toThrow(/sha256/i)
    } finally {
      TMUX_STAGE_SHA256['linux-x86_64'] = original
    }
    // Restored: the guard no longer fires, proving the throw was caused by
    // the mutation and not some other, unrelated failure.
    expect(() => buildTmuxStageScript(NONCE)).not.toThrow()
  })

  it('assertSafeNonce is the same guard buildTmuxStageScript uses internally', () => {
    expect(() => assertSafeNonce(NONCE)).not.toThrow()
    expect(() => assertSafeNonce('bad nonce')).toThrow()
  })
})

// #242 round-3 adversarial review, MAJOR: buildTmuxStageScript's sentinel
// literals must never reach the PTY in plaintext, because the remote tty
// echoes back whatever line is typed BEFORE the shell has run a single byte
// of it -- and that echo can satisfy parseTmuxStageSentinel's own regex,
// latching `stagingDone` and firing writeClaudeCmd() while curl is still
// mid-download (see pty-manager-ssh-tmux.test.ts for the call-site half of
// this fix). buildTmuxStageCommand(NONCE) is the wire form pty-manager actually
// writes; these tests cover it directly.
describe('buildTmuxStageCommand (wire form written to the PTY)', () => {
  it('never contains the sentinel prefix or any fail=/ok literal in plaintext', () => {
    const wire = buildTmuxStageCommand(NONCE)
    // Mutation to prove this can fail: skip the base64 wrap and return
    // buildTmuxStageScript(NONCE) directly -- every one of these assertions then
    // fails, because the raw script contains the prefix and every fail=/ok
    // literal verbatim (see the implementer's report for the actual run).
    expect(wire).not.toContain(TMUX_STAGE_SENTINEL_PREFIX)
    expect(wire).not.toContain('fail=arch')
    expect(wire).not.toContain('fail=download')
    expect(wire).not.toContain('fail=digest')
    expect(wire).not.toContain('fail=extract')
    expect(wire).not.toContain('fail=terminfo')
    expect(wire).not.toContain('ok path=')
    // Nor the readable script internals a co-tenant reading over-the-shoulder
    // (or a terminal-scrollback grep) could otherwise recover pre-execution.
    expect(wire).not.toContain('uname -s')
    expect(wire).not.toContain('sha256sum')
    expect(wire).not.toContain(TMUX_STAGE_TAG)
  })

  it('wraps the base64 payload in an stty -echo / stty echo bracket', () => {
    const wire = buildTmuxStageCommand(NONCE)
    expect(wire).toMatch(/^stty -echo 2>\/dev\/null; echo '[A-Za-z0-9+\/=]+' \| base64 -d \| sh; stty echo 2>\/dev\/null$/)
  })

  it('base64-decodes back to EXACTLY buildTmuxStageScript(NONCE), byte for byte', () => {
    const wire = buildTmuxStageCommand(NONCE)
    const m = wire.match(/echo '([A-Za-z0-9+\/=]+)' \| base64 -d/)
    expect(m).not.toBeNull()
    const decoded = Buffer.from(m![1], 'base64').toString('utf8')
    expect(decoded).toBe(buildTmuxStageScript(NONCE))
  })

  it('is deterministic and single-line, same as the script it wraps', () => {
    const a = buildTmuxStageCommand(NONCE)
    const b = buildTmuxStageCommand(NONCE)
    expect(a).toBe(b)
    expect(a).not.toContain('\n')
  })

  // The column-wrapped-echo regression against the REAL parseTmuxStageSentinel
  // lives in pty-manager-ssh-tmux.test.ts (see "echo immunity" describe block
  // there) — it needs pty-manager's mocked node-pty/electron environment,
  // which this file intentionally does not pull in.
})
