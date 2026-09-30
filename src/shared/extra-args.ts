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

/** The managed-flag refine, on a backslash-collapsed copy, plus the trailing-
 *  backslash ban -- byte-identical to the schema's refine (see pty-handlers for
 *  the shell-expansion analysis behind it). */
export function extraArgsRefineOk(v: string): boolean {
  return (
    !v.endsWith('\\') &&
    !/(^|\s)--(model|effort|permission-mode|settings|mcp-config|agents|resume)\b/.test(v.replace(/\\/g, ''))
  )
}

/** Why a Claude Code session's extra CLI arguments are refused, or null: the
 *  base guard, then the refine (what the pty:spawn schema holds them to). */
export function claudeExtraArgsProblem(v: unknown): string | null {
  const base = extraArgsBaseProblem(v)
  if (base) return base
  return extraArgsRefineOk(v as string) ? null : 'they include a flag the app sets itself (see the help)'
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
 *  conversation a launch resumes is the app's. With every alias the supported
 *  CLIs give these (their tagged sources, rust-v0.153.4 and rust-v0.155.1):
 *  `yolo` (--dangerously-bypass-approvals-and-sandbox) and `not-so-yolo`
 *  (--approve-for-me). */
const CODEX_MANAGED_LONG = [
  'model', 'config', 'enable', 'disable',
  'sandbox', 'ask-for-approval', 'approve-for-me', 'not-so-yolo', 'full-auto', 'yolo', 'dangerously',
  'last', 'cd', 'worktree',
  'profile', 'oss', 'local-provider', 'remote',
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
        return `"${word}" is set by the app, or changes the account, provider or endpoint`
      }
    } else if (w.startsWith('-')) {
      const letters = w.slice(1)
      if (!/^[a-z]$/.test(letters)) return `"${word}": give a short option on its own, such as -i, or use its long form`
      if (CODEX_MANAGED_SHORT.has(letters)) return `"${word}" is set by the app, or changes the account, provider or endpoint`
    } else if (CODEX_COMMAND_WORD_RE.test(w)) {
      const asPath = w.startsWith('/') ? `${word}/` : `./${word}`
      return `"${word}": Codex would read this word as one of its commands, and a word that is not a flag or a flag's value is its opening prompt; give a folder as the value of --add-dir: --add-dir=${word}, or --add-dir ${asPath}`
    }
  }
  return null
}
