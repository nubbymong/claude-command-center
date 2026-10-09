// Extra CLI arguments: the one field both assistants' configs have (claudeOptions
// and codexOptions `extraArgs`), and the rule each assistant's launch holds it
// to. Pure, so the session dialog (which says why a value is refused and holds
// Save back), the pty:spawn schema, the restore sanitizer and the Codex launch
// builder all read the same rule (src/main/sanitize-restored-spawn-options.ts
// re-exports it for main).

export const EXTRA_ARGS_MAX = 512
export const EXTRA_ARGS_CHARSET_RE = /^[A-Za-z0-9 _\-=.\/\\:@,+]*$/

/** The guard both rules start with: text, at most EXTRA_ARGS_MAX characters,
 *  the charset (no shell or cmd.exe metacharacter), and no trailing
 *  backslash. The reason it is refused, or null. */
export function extraArgsBaseProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'they are not text'
  if (v.length > EXTRA_ARGS_MAX) return `they are longer than ${EXTRA_ARGS_MAX} characters`
  if (!EXTRA_ARGS_CHARSET_RE.test(v)) return 'they hold a character other than letters, digits, spaces and _ - = . / \\ : @ , +'
  if (v.endsWith('\\')) return 'they end in a backslash'
  return null
}

// -- A Claude Code session's extra CLI arguments ------------------------------
// They are placed on the launch line a shell reads: PowerShell on Windows
// (each word single-quoted, so PowerShell reads nothing in it,
// spawn-claude-command.ts claudeUserArgsOnLine), a POSIX shell elsewhere and
// on an SSH host, cmd.exe on a Windows SSH host. A POSIX shell drops unquoted
// backslashes, so each word is matched with its backslashes removed and in
// lower case: no other spelling of a refused option or word passes. The same
// shape as Codex's rule below. Names checked against
// the Claude Code builds in use: every option of the main command, shown in its
// help or not (2.1.290 to 2.1.293), and every argument the CLI reads before its
// option parser runs (2.1.291 to 2.1.293), wherever the user's words stand on
// the line.

/** Long options the app sets for a Claude Code launch, or that change the
 *  conversation, where or how it runs, its permission mode or the settings it
 *  reads: refused in full, shortened (a leading part of one), or extended with
 *  a hyphen (`--model-x`). Stems: `permission` (--permission-mode,
 *  --permission-prompt-tool, --permission-prompts), `plugin` (--plugin-dir,
 *  --plugin-dir-no-mcp, --plugin-url), `dangerously`
 *  (--dangerously-skip-permissions, --dangerously-load-development-channels),
 *  `agent` (--agent, whose definition can carry its own tools and permission
 *  mode, and the teammate options --agent-id, --agent-name, --agent-type,
 *  --agent-color), `deep-link` (its -origin, -cwd-b64, -repo and -last-fetch),
 *  `await` (-claim, -initialize), `prefill` (and -b64), `watch-artifact` (and
 *  -no-autoreact), `init` (and -only), `bg` (`background`'s alias, and the
 *  -pty-host and -spare helpers). `resume` covers --resume-session-at and
 *  --resume-drops-turn; `remote` is the older name of `cloud`.
 *  Kept on purpose, a user's own choices that change none of these:
 *  --allowedTools, --disallowedTools and --tools (tool rules of the user's
 *  own; the app sets none on an interactive launch), --add-dir, --name, the
 *  system prompt options, --debug and --debug-file, --fallback-model. */
const CLAUDE_MANAGED_LONG = [
  // set by the app
  'model', 'effort', 'permission', 'settings', 'setting-sources', 'mcp-config', 'strict-mcp-config', 'agents', 'plugin',
  // the conversation a launch runs, its agent, a team it joins, and what is pushed into it or put in its input
  'resume', 'continue', 'session-id', 'fork-session', 'from-pr', 'teleport', 'rewind-files', 'reply-on-resume',
  'agent', 'team-name', 'teammate-mode', 'parent-session-id', 'channels', 'watch-artifact', 'messaging-socket-path', 'prefill',
  // where it runs: the folder, the terminal, the machine
  'worktree', 'tmux', 'cloud', 'remote', 'environment', 'pool', 'attach-serve', 'background', 'bg', 'routine', 'desktop',
  'deep-link', 'handle-uri',
  // permissions
  'dangerously', 'allow-dangerously-skip-permissions', 'inherit-permission-mode', 'enable-auto-mode', 'plan-mode-required',
  // where settings are read from, or which are read
  'managed-settings', 'project-config-root', 'client-data-url', 'bare', 'safe-mode', 'restricted',
  // how it runs: a program drives it instead of the terminal, or it answers once and exits
  'print', 'input-format', 'output-format', 'sdk-url', 'await', 'session-mirror', 'init', 'maintenance',
  // how it runs: a helper or a command in place of a conversation (read before the option parser)
  'preload', 'daemon-worker', 'eval-mock-server', 'claude-in-chrome-mcp', 'chrome-native-host', 'gh-standin', 'update', 'upgrade',
] as const
/** Real options the matching above also catches that change none of those
 *  things: Remote Control lets the user's own account drive this same session
 *  (Claude Code turns it on by default); without these, `remote` would refuse
 *  them by their hyphen while their alias --rc passed. --chrome turns on Claude
 *  in Chrome; `chrome-native-host` would refuse it as a shortened name. */
const CLAUDE_KEPT_LONG: ReadonlySet<string> = new Set(['remote-control', 'remote-control-session-name-prefix', 'chrome'])
/** Their one-letter forms: -c (--continue), -r (--resume), -p (--print) and
 *  -w (--worktree), matched in lower case. */
const CLAUDE_MANAGED_SHORT: ReadonlySet<string> = new Set(['c', 'r', 'p', 'w'])
/** A word Claude Code would read, in the first-argument place, as one of its
 *  commands (mcp, update, doctor, ...): the list grows between versions, so
 *  the shape is refused. With a leading slash, its opening prompt would be a
 *  slash command, named by everything up to the first space (/logout,
 *  /plugin:command, /mcp__server__prompt); a path with a second slash names
 *  none. */
const CLAUDE_COMMAND_WORD_RE = /^(?:[a-z][a-z0-9-]*|\/[^/]*)$/
/** A word that starts with an address: a scheme of two or more characters and
 *  a colon (name:, name://). Claude Code takes a word in its own schemes
 *  (cc://, cc+unix://) as a connect address, which selects the server the
 *  session runs on; every scheme is refused, so one a later build adds is too.
 *  A drive letter (one letter and a colon, C:\...) is a folder and passes; an
 *  option's value after an = sign is the option's, not a word of its own. */
const CLAUDE_ADDRESS_WORD_RE = /^[a-z][a-z0-9+.-]+:/

const CLAUDE_MANAGED_REASON = 'is set by the app, or changes the conversation, where or how it runs, its permission mode or the settings it reads'

/** Why the words of a Claude Code session's extra CLI arguments are refused,
 *  or null: a word that starts or ends with a comma (a comma belongs inside
 *  a word, such as --allowedTools=Bash,Edit); an option the app sets (or that
 *  changes the conversation, where or how it runs, its permission mode or the
 *  settings it reads), in any spelling; a short option that is not one letter
 *  alone; a word PowerShell would expand (a leading `@` splats a variable); a
 *  word that starts with an address; a word Claude would read as a command. */
function claudeExtraArgWordsProblem(v: string): string | null {
  for (const word of v.split(' ').filter((w) => w !== '')) {
    const w = word.replace(/\\/g, '').toLowerCase()
    if (w.startsWith(',') || w.endsWith(',')) {
      return `"${word}": a word may not start or end with a comma; give a comma only inside a word, such as --allowedTools=Bash,Edit`
    }
    if (w.startsWith('--')) {
      const name = w.slice(2).split('=')[0]
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return `"${word}" is not an option name`
      if (CLAUDE_KEPT_LONG.has(name)) continue
      if (CLAUDE_MANAGED_LONG.some((m) => m.startsWith(name) || name.startsWith(`${m}-`))) {
        return `"${word}" ${CLAUDE_MANAGED_REASON}`
      }
    } else if (w.startsWith('-')) {
      const letters = w.slice(1)
      if (!/^[a-z]$/.test(letters)) return `"${word}": give a short option on its own, such as -d, or use its long form`
      if (CLAUDE_MANAGED_SHORT.has(letters)) return `"${word}" ${CLAUDE_MANAGED_REASON}`
    } else if (w.startsWith('@')) {
      return `"${word}": PowerShell reads a word that starts with @ as a variable`
    } else if (CLAUDE_ADDRESS_WORD_RE.test(w)) {
      return `"${word}": a word that starts with an address (such as name://) can name a server for Claude to run the session on; give an option's value after an = sign (--option=value)`
    } else if (CLAUDE_COMMAND_WORD_RE.test(w)) {
      const asPath = w.startsWith('/') ? `${word}/` : `./${word}`
      return `"${word}": Claude would read this word as one of its commands, and a word that is not a flag or a flag's value is its opening prompt; give a folder as the value of --add-dir: --add-dir=${word}, or --add-dir ${asPath}`
    }
  }
  return null
}

/** The rule the pty:spawn schema refines a Claude Code session's extra CLI
 *  arguments with, after its cap and charset: no trailing backslash (on SSH
 *  it continues the line), and the words' rule above. */
export function extraArgsRefineOk(v: string): boolean {
  return !v.endsWith('\\') && claudeExtraArgWordsProblem(v) === null
}

/** Why a Claude Code session's extra CLI arguments are refused, or null: the
 *  base guard, then the words' rule. One rule for the dialog (which says why
 *  and holds Save back), the pty:spawn schema and the restore sanitizer (which
 *  drops a saved value it refuses, so the session starts without it). */
export function claudeExtraArgsProblem(v: unknown): string | null {
  const base = extraArgsBaseProblem(v)
  if (base) return base
  return claudeExtraArgWordsProblem(v as string)
}

// -- A Codex session's extra CLI arguments (P3.11, row 62) --------------------
// No shell reads a Codex launch (argv, or one verbatim cmd.exe line whose
// arguments carry no character cmd.exe gives a meaning), so each word is one
// argument, placed after every flag the app sets.

/** Long options the app sets for a Codex launch, or that change the account,
 *  provider, endpoint or config folder: refused in full, shortened (a leading
 *  part of one), or extended with a hyphen (`--model-x`). `config`, `enable`,
 *  `disable`: the app delivers its effort, MCP server and hooks through `-c`,
 *  and a `-c` key can set any other setting. `dangerously`:
 *  --dangerously-bypass-approvals-and-sandbox and
 *  --dangerously-bypass-hook-trust (the app's hooks rely on Codex's own
 *  review). `cd`, `worktree`: the app starts Codex in the configured folder,
 *  or in the resumed conversation's, and finds a new conversation by that
 *  folder; `--worktree` (0.155.1) starts it in a new one. `last`: the
 *  conversation a launch resumes is the app's. `codex-run-as`: the helper
 *  modes the CLI starts in when its first argument names one
 *  (--codex-run-as-apply-patch). The app's own flags always come first on a
 *  Codex launch; refused all the same, as Claude Code's helper modes are in
 *  the rule above. With every alias the supported CLIs give these (their tagged
 *  sources, rust-v0.153.4 and rust-v0.155.1): `yolo`
 *  (--dangerously-bypass-approvals-and-sandbox) and `not-so-yolo`
 *  (--approve-for-me). */
const CODEX_MANAGED_LONG = [
  'model', 'config', 'enable', 'disable',
  'sandbox', 'ask-for-approval', 'approve-for-me', 'not-so-yolo', 'full-auto', 'yolo', 'dangerously',
  'last', 'cd', 'worktree',
  'profile', 'oss', 'local-provider', 'remote',
  'codex-run-as',
] as const
/** Their one-letter forms: -m, -c, -p, -s, -a, and -C (the working folder),
 *  matched in lower case. */
const CODEX_MANAGED_SHORT = new Set(['m', 'c', 'p', 's', 'a'])
/** A word Codex would read, in the first-argument place, as one of its
 *  commands (login, logout, resume, mcp, exec, ...): the list differs between
 *  versions and holds names its help does not show, so the shape is refused.
 *  With a leading slash, the shape of one of its slash commands (/logout,
 *  /model, /permissions): a word that is not a flag or a flag's value is its
 *  opening prompt. */
const CODEX_COMMAND_WORD_RE = /^\/?[a-z][a-z0-9-]*$/
const CODEX_MANAGED_REASON = 'is set by the app, or changes the account, provider or endpoint, or how it runs'

/** The words of a Codex session's extra CLI arguments, each one argument. */
export function codexExtraArgWords(v: string): string[] {
  return v.split(' ').filter((w) => w !== '')
}

/** Why a Codex session's extra CLI arguments are refused, or null when they
 *  pass. One rule for the dialog, the pty:spawn schema, the restore sanitizer
 *  and the launch builder. Each word is matched with its backslashes removed
 *  and in lower case, so no other spelling of a refused flag or word passes. */
export function codexExtraArgsProblem(v: unknown): string | null {
  const base = extraArgsBaseProblem(v)
  if (base) return base
  for (const word of codexExtraArgWords(v as string)) {
    const w = word.replace(/\\/g, '').toLowerCase()
    if (w.startsWith('--')) {
      const name = w.slice(2).split('=')[0]
      if (!/^[a-z0-9]/.test(name)) return `"${word}" is not an option name`
      if (CODEX_MANAGED_LONG.some((m) => m.startsWith(name) || name.startsWith(`${m}-`))) {
        return `"${word}" ${CODEX_MANAGED_REASON}`
      }
    } else if (w.startsWith('-')) {
      const letters = w.slice(1)
      if (!/^[a-z]$/.test(letters)) return `"${word}": give a short option on its own, such as -i, or use its long form`
      if (CODEX_MANAGED_SHORT.has(letters)) return `"${word}" ${CODEX_MANAGED_REASON}`
    } else if (CODEX_COMMAND_WORD_RE.test(w)) {
      const asPath = w.startsWith('/') ? `${word}/` : `./${word}`
      return `"${word}": Codex would read this word as one of its commands, and a word that is not a flag or a flag's value is its opening prompt; give a folder as the value of --add-dir: --add-dir=${word}, or --add-dir ${asPath}`
    }
  }
  return null
}
