/**
 * No remote command line CCC builds may carry an UNQUOTED word that begins
 * with `=` (WP2 final fix batch, found by the Mac T6 live run).
 *
 * zsh, the macOS default login shell, expands such a word to the path of the
 * command named by the rest of it (its EQUALS option, on by default). The tmux
 * exact-match target `-t =ccc-<sid>` therefore failed with
 * `zsh: ccc-<sid> not found`, and zsh aborts the WHOLE command line on that
 * error: claude never started in a tmux-wrapped SSH session on a Mac, and the
 * End path's `kill-session` (plus the sidecar `rm` after it) never ran. bash
 * and sh pass the word through literally, which is why every Linux lane stayed
 * green. Single quotes are literal in the POSIX-family shells (sh, bash, dash,
 * zsh), so a quoted `'=ccc-<sid>'` reaches tmux as the same bytes in each.
 *
 * The check is a small shell tokenizer, not a real shell (no real shell runs
 * here). What it models, and nothing more:
 *   - words end at blanks, newline, CR (a line typed through a PTY ends at CR)
 *     and the control operators `; | & ( ) < >`;
 *   - single quotes are literal; double quotes and a backslash quote what
 *     they cover;
 *   - `$( )` and backtick bodies, unquoted or inside double quotes, are
 *     scripts in their own right and are checked again; `${ }` is opaque
 *     (its body is not checked);
 *   - scripts handed to another shell are checked again: the word after `-c`,
 *     tmux's `new-session -s <name> <cmd>` (tmux runs it with the user's
 *     default shell, which may be zsh), and the arguments of `eval`.
 * Flagged: a word whose first character is an unquoted `=`, and a word shaped
 * like an assignment (`NAME=value`) whose value starts with an unquoted `=` or
 * contains an unquoted `:=` (zsh expands `=` there too: an assignment value is
 * treated as a colon-separated list). Not modelled: here-documents, aliases,
 * comments (a `#` is scanned like any other text, which can only over-report),
 * the `typeset` family's arguments, MAGIC_EQUAL_SUBST (off by default), and
 * anything a variable expands to at run time.
 *
 * Mutation to prove this can fail: drop the singleQuote around `target` /
 * `windowTarget` in buildTmuxLaunchCommand (ssh-tmux.ts), or the
 * quoteArgForShell around `target` in buildRemoteTmuxKillCommand (ssh-shim.ts).
 */
import { describe, it, expect, vi } from 'vitest'

// ssh-shim.ts imports the conductor MCP server for its setup-script helpers;
// none of the builders below reach it. Stubbed so this stays a pure test.
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))

import { buildTmuxLaunchCommand } from '../../../src/main/ssh-tmux'
import { buildRemoteTmuxKillCommand, buildContainerKillCommand, buildRemoteSessionCleanupCommand } from '../../../src/main/providers/claude/ssh-shim'
import { buildTmuxListCommand } from '../../../src/main/ssh-liveness'
import { buildTmuxStageCommand } from '../../../src/main/ssh-tmux-stage'
import { buildArchProbeCommandBracketed } from '../../../src/main/ssh-tmux-push'
import type { SshRuntime } from '../../../src/shared/types'

/** One character of a word, and whether any quoting covered it. */
interface Ch { c: string; quoted: boolean }
interface Word { value: string; chars: Ch[] }
interface Tokens {
  /** Words grouped by simple command (split at `; | & ( )`, newline, CR). */
  commands: Word[][]
  /** Bodies of `$( )` and backtick substitutions: scripts of their own. */
  substitutions: string[]
}

/** End a word (and, for these, the simple command too). */
const COMMAND_END = new Set([';', '|', '&', '(', ')'])
/** End a word only. */
const REDIRECT = new Set(['<', '>'])
const BACKSLASH = String.fromCharCode(92)
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** From just after an opening `(`, the index of its matching `)`, skipping
 *  quoted text; -1 when unbalanced. */
function matchParen(line: string, from: number): number {
  let depth = 1
  let q: string | null = null
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (q === "'") { if (c === "'") q = null; continue }
    if (c === BACKSLASH) { i++; continue }
    if (q === '"') { if (c === '"') q = null; continue }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** From just after an opening `{`, the index of its matching `}`. */
function matchBrace(line: string, from: number): number {
  let depth = 1
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === BACKSLASH) { i++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** From just after an opening backtick, the index of the closing one. */
function matchBacktick(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === BACKSLASH) { i++; continue }
    if (line[i] === '`') return i
  }
  return -1
}

/** Inside backticks a backslash quotes only `$`, a backtick and itself. */
function unescapeBacktickBody(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === BACKSLASH && i + 1 < body.length && ['$', '`', BACKSLASH].includes(body[i + 1])) out += body[++i]
    else out += body[i]
  }
  return out
}

function tokenize(line: string): Tokens {
  const commands: Word[][] = [[]]
  const substitutions: string[] = []
  let chars: Ch[] | null = null
  let quote: string | null = null
  const push = (c: string, quoted: boolean): void => { (chars ??= []).push({ c, quoted }) }
  const pushAll = (s: string): void => { for (const c of s.split('')) push(c, true) }
  const endWord = (): void => {
    if (chars) commands[commands.length - 1].push({ value: chars.map((x) => x.c).join(''), chars })
    chars = null
  }
  const endCommand = (): void => {
    endWord()
    if (commands[commands.length - 1].length > 0) commands.push([])
  }
  /** A `$(`, `${` or backtick at `i`: consumed as part of the current word
   *  (never an unquoted `=`); returns the index of its last character, or
   *  null when `i` does not start one. */
  const expansion = (i: number): number | null => {
    if (line[i] === '`') {
      const e = matchBacktick(line, i + 1)
      if (e < 0) return null
      substitutions.push(unescapeBacktickBody(line.slice(i + 1, e)))
      pushAll(line.slice(i, e + 1))
      return e
    }
    if (line[i] === '$' && line[i + 1] === '(') {
      const e = matchParen(line, i + 2)
      if (e < 0) return null
      substitutions.push(line.slice(i + 2, e))
      pushAll(line.slice(i, e + 1))
      return e
    }
    if (line[i] === '$' && line[i + 1] === '{') {
      const e = matchBrace(line, i + 2)
      if (e < 0) return null
      pushAll(line.slice(i, e + 1))
      return e
    }
    return null
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else push(c, true)
      continue
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue }
      if (c === BACKSLASH && i + 1 < line.length && ['$', '`', '"', BACKSLASH].includes(line[i + 1])) { push(line[++i], true); continue }
      if (c === '$' || c === '`') {
        const e = expansion(i)
        if (e !== null) { i = e; continue }
      }
      push(c, true)
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); continue }
    if (c === '\r' || c === '\n') { endCommand(); continue }
    if (COMMAND_END.has(c)) { endCommand(); continue }
    if (REDIRECT.has(c)) { endWord(); continue }
    if (c === "'" || c === '"') { chars ??= []; quote = c; continue }
    if (c === BACKSLASH) {
      if (i + 1 < line.length) push(line[++i], true)
      else chars ??= []
      continue
    }
    if (c === '$' || c === '`') {
      const e = expansion(i)
      if (e !== null) { i = e; continue }
    }
    push(c, false)
  }
  endCommand()
  return { commands: commands.filter((cmd) => cmd.length > 0), substitutions }
}

/** The word itself when a shell with EQUALS on would expand an `=` in it. */
function equalsHazard(w: Word): string | null {
  const ch = w.chars
  if (ch.length > 0 && ch[0].c === '=' && !ch[0].quoted) return w.value
  const eq = ch.findIndex((x) => x.c === '=' && !x.quoted)
  if (eq > 0 && ch.slice(0, eq).every((x) => !x.quoted) && NAME_RE.test(w.value.slice(0, eq))) {
    const v = ch.slice(eq + 1)
    if (v.length > 0 && v[0].c === '=' && !v[0].quoted) return w.value
    for (let k = 0; k + 1 < v.length; k++) {
      if (v[k].c === ':' && !v[k].quoted && v[k + 1].c === '=' && !v[k + 1].quoted) return w.value
    }
  }
  return null
}

/** The scripts another shell will parse: the word after `-c`, tmux's
 *  `new-session -s <name> <cmd>`, and the arguments of `eval`. */
function handedOnScripts(cmd: Word[]): string[] {
  const out: string[] = []
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i].value === '-c' && cmd[i + 1]) out.push(cmd[i + 1].value)
    if (cmd[i].value === 'new-session' && cmd[i + 1]?.value === '-s' && cmd[i + 3]) out.push(cmd[i + 3].value)
    if (cmd[i].value === 'eval' && cmd[i + 1]) out.push(cmd.slice(i + 1).map((w) => w.value).join(' '))
  }
  return out
}

/** Every word in `line`, and in every script it hands on or substitutes, that
 *  a shell with EQUALS on would expand. Empty means none. */
function bareEqualsWords(line: string, depth = 0): string[] {
  const { commands, substitutions } = tokenize(line)
  const found: string[] = []
  for (const cmd of commands) {
    for (const w of cmd) {
      const hazard = equalsHazard(w)
      if (hazard !== null) found.push(hazard)
    }
  }
  if (depth < 6) {
    const inner = [...substitutions, ...commands.flatMap(handedOnScripts)]
    for (const script of inner) found.push(...bareEqualsWords(script, depth + 1))
  }
  return found
}

/** Every word that follows `-t` (a tmux target operand), quotes removed. */
function tmuxTargets(line: string): Word[] {
  const out: Word[] = []
  for (const cmd of tokenize(line).commands) {
    cmd.forEach((w, i) => { if (i > 0 && cmd[i - 1].value === '-t') out.push(w) })
  }
  return out
}
const startsWithBareEquals = (w: Word): boolean => w.chars.length > 0 && w.chars[0].c === '=' && !w.chars[0].quoted

const SESSION_IDS = ['sid-1', 'a', '1a2b3c4d5e6f7890', `sid with 'quote' and space`, 'a; tmux kill-server; #']
const INNER = 'CLAUDE_CODE_DISABLE_MOUSE=1 COLORFGBG=' + "'0;15'" + ' claude --settings ~/.claude/settings-x.json --model ' + "'opus[1m]'"

describe('the checker itself (so a green run means something)', () => {
  it('flags an unquoted =word, wherever the previous word ended', () => {
    expect(bareEqualsWords('tmux has-session -t =ccc-x 2>/dev/null')).toEqual(['=ccc-x'])
    expect(bareEqualsWords('a;=b')).toEqual(['=b'])
    expect(bareEqualsWords('a&&=b||=c')).toEqual(['=b', '=c'])
    expect(bareEqualsWords('if x; then =y; fi')).toEqual(['=y'])
    expect(bareEqualsWords('a>=b')).toEqual(['=b'])
  })

  // Each line below is one word boundary the tokenizer must honour. Mutation
  // to prove these can fail: drop `(` and `)` from COMMAND_END, or stop
  // treating CR / LF (or tab) as a separator -- the `=x` then rides inside the
  // previous word and is never seen as a word of its own.
  it('splits at ( and ) and at newline, CR and tab', () => {
    expect(bareEqualsWords('(=x)')).toEqual(['=x'])
    expect(bareEqualsWords('(true)=x')).toEqual(['=x'])
    expect(bareEqualsWords('true\n=x')).toEqual(['=x'])
    expect(bareEqualsWords('true\r=x')).toEqual(['=x'])
    expect(bareEqualsWords('true\t=x')).toEqual(['=x'])
  })

  it('flags an assignment whose value zsh would expand: a leading = or a := in the list', () => {
    expect(bareEqualsWords('FOO==x')).toEqual(['FOO==x'])
    expect(bareEqualsWords('PATH=/a:=x claude')).toEqual(['PATH=/a:=x'])
    expect(bareEqualsWords('A=1 B==y cmd')).toEqual(['B==y'])
  })

  it('looks inside $( ), backticks and eval, quoted or not', () => {
    expect(bareEqualsWords('echo `=x`')).toEqual(['=x'])
    expect(bareEqualsWords('echo "`=x`"')).toEqual(['=x'])
    expect(bareEqualsWords('echo "$(=x)"')).toEqual(['=x'])
    expect(bareEqualsWords('echo $(true; =x)')).toEqual(['=x'])
    expect(bareEqualsWords('v=$(echo $(=x))')).toEqual(['=x'])
    expect(bareEqualsWords('eval "=x"')).toEqual(['=x'])
    expect(bareEqualsWords(`eval 'tmux kill-session -t =ccc-x'`)).toEqual(['=ccc-x'])
  })

  // Mutation to prove this can fail: stop matchParen skipping quoted text (the
  // quoted `)` then closes the substitution early), or stop un-escaping a
  // backtick body (the inner escaped backtick pair then never becomes a
  // substitution of its own).
  it('finds the right end of a substitution and un-escapes a nested backtick', () => {
    expect(bareEqualsWords(`echo $(echo ')'; =x)`)).toEqual(['=x'])
    expect(bareEqualsWords('echo `echo ' + BACKSLASH + '`=x' + BACKSLASH + '``')).toEqual(['=x'])
  })

  it('looks inside the scripts a nested shell will parse', () => {
    expect(bareEqualsWords(`tmux new-session -s ccc-x 'tmux set-option -t =ccc-x mouse off; claude'`)).toEqual(['=ccc-x'])
    expect(bareEqualsWords(`docker exec n bash -c 'rm -f x; =y'`)).toEqual(['=y'])
    // The POSIX '\'' idiom inside a single-quoted script round-trips.
    expect(bareEqualsWords(`tmux new-session -s ccc-x 'A='${BACKSLASH}''x'${BACKSLASH}'' =z'`)).toEqual(['=z'])
  })

  it('does not flag a quoted or escaped =, or an = no shell expands', () => {
    expect(bareEqualsWords(`tmux has-session -t '=ccc-x'`)).toEqual([])
    expect(bareEqualsWords(`tmux has-session -t "=ccc-x"`)).toEqual([])
    expect(bareEqualsWords(`tmux has-session -t ${BACKSLASH}=ccc-x`)).toEqual([])
    expect(bareEqualsWords(`tmux set-option -w -t '=ccc-x':`)).toEqual([])
    expect(bareEqualsWords('FOO=bar claude --flag=x --other==y a:=b')).toEqual([])
    expect(bareEqualsWords(`FOO='=x' BAR="a:=b" claude`)).toEqual([])
    expect(bareEqualsWords('X=${Y:=z} claude')).toEqual([])
    expect(bareEqualsWords(`echo '$(=x)' '\`=x\`'`)).toEqual([])
  })
})

describe('the tmux launch line (typed into the remote login shell)', () => {
  const cases: Array<{ staged: boolean; reconnect: boolean; innerCmd: string }> = []
  for (const staged of [false, true]) {
    for (const reconnect of [false, true]) {
      cases.push({ staged, reconnect, innerCmd: INNER })
      // A long inner command drops the wheel bindings (TMUX_LAUNCH_LINE_BUDGET);
      // the degraded shape must hold the same property.
      cases.push({ staged, reconnect, innerCmd: `${INNER} ${'x'.repeat(512)}` })
    }
  }

  it('has no unquoted =word, in the outer line or in the fresh pane command', () => {
    for (const sessionId of SESSION_IDS) {
      for (const c of cases) {
        const line = buildTmuxLaunchCommand({ sessionId, ...c })
        expect(bareEqualsWords(line), `${sessionId} ${JSON.stringify({ staged: c.staged, reconnect: c.reconnect, long: c.innerCmd.length > 400 })}`).toEqual([])
      }
    }
  })

  it('still hands tmux the =-exact target (session and window form) after quote removal', () => {
    const line = buildTmuxLaunchCommand({ sessionId: 'a', staged: false, reconnect: false, innerCmd: INNER })
    const targets = tmuxTargets(line)
    // has-session, attach, four session options, the window option and the
    // copy-mode cancel.
    expect(targets.length).toBe(8)
    for (const t of targets) {
      expect(['=ccc-a', '=ccc-a:']).toContain(t.value)
      expect(startsWithBareEquals(t)).toBe(false)
    }
  })
})

describe('the End command (a separate ssh exec, parsed by the remote account`s shell)', () => {
  it('pins the exact tmux kill + sidecar command, every target single-quoted', () => {
    const t = `'=ccc-sess-1'`
    expect(buildRemoteTmuxKillCommand('sess-1')).toBe(
      `tmux kill-session -t ${t} 2>/dev/null; ` +
      `/opt/homebrew/bin/tmux kill-session -t ${t} 2>/dev/null; ` +
      `/usr/local/bin/tmux kill-session -t ${t} 2>/dev/null; ` +
      `/usr/bin/tmux kill-session -t ${t} 2>/dev/null; ` +
      `"$HOME/.claude/bin/tmux" kill-session -t ${t} 2>/dev/null; ` +
      'rm -f ~/.claude/settings-sess-1.json ~/.claude/mcp-sess-1.json ~/.claude/ccc-status-sess-1.url 2>/dev/null; ' +
      'true',
    )
  })

  it('has no unquoted =word for any session id, alone or behind a container kill', () => {
    const runtimes: Array<{ runtime: SshRuntime; hasSudoPassword: boolean; sudoProbeNonce?: string }> = [
      { runtime: { type: 'container', engine: 'podman', container: 'ccc-test' }, hasSudoPassword: false },
      { runtime: { type: 'container', engine: 'docker', container: 'ccc-test', sudo: true }, hasSudoPassword: true },
      { runtime: { type: 'container', engine: 'docker', container: 'ccc-test', sudo: true }, hasSudoPassword: false },
      // T24: rootful with no saved sudo password, as End sends it (the sudo
      // probe and its sentinel printf around the kill).
      { runtime: { type: 'container', engine: 'podman', container: 'ccc-test', sudo: true }, hasSudoPassword: false, sudoProbeNonce: 'a1b2c3d4e5f60718a1b2c3d4' },
    ]
    for (const sessionId of SESSION_IDS) {
      const kill = buildRemoteTmuxKillCommand(sessionId)
      expect(bareEqualsWords(kill), sessionId).toEqual([])
      for (const t of tmuxTargets(kill)) expect(t.value.startsWith('=ccc-'), sessionId).toBe(true)
      for (const r of runtimes) {
        const containerKill = buildContainerKillCommand(sessionId, r.runtime, { hasSudoPassword: r.hasSudoPassword, sudoProbeNonce: r.sudoProbeNonce })
        if (r.sudoProbeNonce) expect(containerKill).toContain('CCC_END_SUDO_NEEDED')
        expect(containerKill).not.toBe('')
        // The composition endSshRemote (pty-manager.ts) sends.
        expect(bareEqualsWords(`${containerKill}; ${kill}`), `${sessionId} ${JSON.stringify(r)}`).toEqual([])
      }
    }
  })
})

describe('the other remote lines the SSH flow sends (same class, guarded here)', () => {
  it('the liveness probe, the in-band cleanup, the tier-3 stage and the arch probe', () => {
    expect(bareEqualsWords(buildTmuxListCommand())).toEqual([])
    expect(bareEqualsWords(buildTmuxStageCommand('a1b2c3d4e5f60718'))).toEqual([])
    expect(bareEqualsWords(buildArchProbeCommandBracketed())).toEqual([])
    for (const sessionId of SESSION_IDS) {
      expect(bareEqualsWords(buildRemoteSessionCleanupCommand(sessionId)), sessionId).toEqual([])
    }
  })
})
