// The one helper that reads the PATH Windows keeps in the registry and that
// appends one folder to the user's PATH there (ADR-024; owner decision D4 and
// the PATH finding of the first-run test, 2026-10-10).
//
// Both go through ONE fixed Windows PowerShell script, started by its full
// path in the system folder with no profile (owner-only-folders.ts
// runWindowsPowerShell, its only runner), never through a shell. What the
// script works on reaches it only through its environment: the mode, and for
// an append the value it read, the value to write and that value's registry
// type. No value is ever written into the script's text.
//
// Unicode-safe both ways. The script prints each value as its registry type
// and its UTF-16 text in base64, so every character arrives intact whatever
// the console code page is (reg.exe printed in that code page, and every
// character outside ASCII came back damaged). An appended value goes in the
// same way, base64 of its UTF-16 text.
//
// A value is read as stored, its %VARIABLES% left unexpanded
// (DoNotExpandEnvironmentNames), so an append writes back exactly what was
// there with the one folder after it, in the same registry type: a
// REG_EXPAND_SZ Path stays REG_EXPAND_SZ and keeps every %VARIABLE% it had.
// The append is refused when the value changed between the read and the
// write (the script compares what it reads then with what was read before),
// and is then tried once more from a fresh read. After a write, the script
// tells running programs that the environment changed (WM_SETTINGCHANGE,
// "Environment"), so a terminal opened from the Start menu sees it too.
import { runWindowsPowerShell, type PowerShellRunner } from './owner-only-folders'
import { windowsEnvValue } from './windows-programs'
import { windowsPathFolderIsFullyQualified } from './providers/windows-path-names'

/** A PATH value as the registry stores it: its type (RegistryValueKind's
 *  name: `String` is REG_SZ, `ExpandString` REG_EXPAND_SZ) and its text,
 *  %VARIABLES% unexpanded. */
export interface RegistryPathValue {
  kind: string
  data: string
}

/** The two values Windows builds a new program's PATH from, system first;
 *  null where there is none. */
export interface RegistryPaths {
  machine: RegistryPathValue | null
  user: RegistryPathValue | null
}

/** The registry types a PATH value is read from and appended to. */
export const PATH_VALUE_KINDS: readonly string[] = Object.freeze(['String', 'ExpandString'])

/** The environment names the script reads its work from. */
export const REGISTRY_PATH_ENV = Object.freeze({
  mode: 'CCC_REGISTRY_PATH_MODE',
  was: 'CCC_REGISTRY_PATH_WAS',
  next: 'CCC_REGISTRY_PATH_NEXT',
  kind: 'CCC_REGISTRY_PATH_KIND',
})

const E = REGISTRY_PATH_ENV

/** The one script. `read`: prints `machine=<token>` and `user=<token>`.
 *  `append`: writes the user Path only when it still reads as the token it
 *  was given, then prints `result=written` and `broadcast=sent|failed`, or
 *  `result=changed` and writes nothing. A token is `none` or
 *  `<kind>:<base64 of the UTF-16 text>`. */
export const REGISTRY_PATH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'function Token($k) {',
  "  if ($null -eq $k) { return 'none' }",
  "  if (-not ($k.GetValueNames() -contains 'Path')) { return 'none' }",
  "  $kind = $k.GetValueKind('Path').ToString()",
  "  $v = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "  return $kind + ':' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))",
  '}',
  `$mode = $env:${E.mode}`,
  "if ($mode -eq 'read') {",
  "  $m = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', $false)",
  "  try { 'machine=' + (Token $m) } finally { if ($null -ne $m) { $m.Close() } }",
  "  $u = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  "  try { 'user=' + (Token $u) } finally { if ($null -ne $u) { $u.Close() } }",
  '  exit 0',
  '}',
  "if ($mode -eq 'append') {",
  "  $u = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  '  try {',
  `    if ((Token $u) -cne $env:${E.was}) { 'result=changed'; exit 0 }`,
  `    $next = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:${E.next}))`,
  `    $kind = [Microsoft.Win32.RegistryValueKind]$env:${E.kind}`,
  "    $u.SetValue('Path', $next, $kind)",
  '  } finally { $u.Close() }',
  "  'result=written'",
  '  try {',
  "    Add-Type -Namespace CccRegistryPath -Name Native -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
  '    $r = [UIntPtr]::Zero',
  "    if ([CccRegistryPath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) -eq [IntPtr]::Zero) { 'broadcast=failed' } else { 'broadcast=sent' }",
  "  } catch { 'broadcast=failed' }",
  '  exit 0',
  '}',
  "'result=unknown-mode'",
  'exit 2',
].join('\n')

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const KIND_NAME = /^[A-Za-z]+$/

function utf16Base64(text: string): string {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/** A value as the script prints it. */
export function registryPathToken(v: RegistryPathValue | null): string {
  return v === null ? 'none' : `${v.kind}:${utf16Base64(v.data)}`
}

/** What the script printed for one value: the value, null for none, or
 *  undefined when the token is not one the script prints. */
export function parseRegistryPathToken(token: string): RegistryPathValue | null | undefined {
  if (token === 'none') return null
  const at = token.indexOf(':')
  if (at <= 0) return undefined
  const kind = token.slice(0, at)
  const b64 = token.slice(at + 1)
  if (!KIND_NAME.test(kind) || !BASE64.test(b64) || b64.length % 4 !== 0) return undefined
  return { kind, data: Buffer.from(b64, 'base64').toString('utf16le') }
}

/** `name=value` lines of what the script printed. */
function answerLines(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of String(stdout).split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return out
}

/** The two values out of what a `read` printed. Throws when either is not
 *  there or not one the script prints. */
export function parseRegistryPathRead(stdout: string): RegistryPaths {
  const lines = answerLines(stdout)
  const machine = parseRegistryPathToken(lines.get('machine') ?? '')
  const user = parseRegistryPathToken(lines.get('user') ?? '')
  if (machine === undefined || user === undefined) throw new Error('the registry read gave no answer it could use')
  return { machine, user }
}

/** The system and user PATH values, as stored. Throws when Windows
 *  PowerShell cannot be run or answers nothing usable. */
export async function readRegistryPaths(run: PowerShellRunner = runWindowsPowerShell): Promise<RegistryPaths> {
  return parseRegistryPathRead(await run(REGISTRY_PATH_SCRIPT, { [E.mode]: 'read' }))
}

/** `value` with each %NAME% the environment defines (any case) replaced by
 *  its value, as Windows expands a REG_EXPAND_SZ; any other left as written. */
export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const v = windowsEnvValue(env, name)
    return typeof v === 'string' ? v : whole
  })
}

/** One PATH entry as a folder to compare: quotes off, either slash, no
 *  trailing separator below a root, any case. */
export function windowsFolderKey(entry: string): string {
  let s = entry.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim()
  s = s.replace(/\//g, '\\')
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** A value's folders as Windows reads them: a REG_EXPAND_SZ expanded
 *  against `env`, a REG_SZ as written. */
export function registryPathFolders(v: RegistryPathValue | null, env: NodeJS.ProcessEnv): string[] {
  if (!v) return []
  const data = v.kind === 'ExpandString' ? expandWindowsVariables(v.data, env) : v.data
  return data.split(';')
}

const REPLACEMENT = String.fromCodePoint(0xfffd)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** A folder the append may write: fully qualified (a drive or a share), and
 *  nothing that would read as more than one entry or as a variable. */
export function appendableFolder(folder: unknown): folder is string {
  return typeof folder === 'string' && folder.trim() === folder && folder !== ''
    && !/[;%"]/.test(folder) && !folder.includes(REPLACEMENT) && !CONTROL.test(folder)
    && windowsPathFolderIsFullyQualified(folder)
}

export type UserPathAppendPlan =
  | { kind: 'already' }
  | { kind: 'unsupported'; why: string }
  | { kind: 'append'; was: string; next: RegistryPathValue }

/** What appending `folder` to the user Path means for `paths`: nothing when
 *  the system or the user Path already has it (case, a trailing backslash,
 *  quotes and %VARIABLES% read as Windows reads them); otherwise the user
 *  value as stored with `folder` after it, separated by one `;`, in the type
 *  it has (REG_EXPAND_SZ when there is none yet). Nothing else in the value
 *  changes: no entry is dropped, moved or rewritten. */
export function planUserPathAppend(paths: RegistryPaths, folder: string, env: NodeJS.ProcessEnv): UserPathAppendPlan {
  if (!appendableFolder(folder)) return { kind: 'unsupported', why: 'not a folder the app adds' }
  const user = paths.user
  if (user && !PATH_VALUE_KINDS.includes(user.kind)) return { kind: 'unsupported', why: `the user PATH is stored as ${user.kind}` }
  const key = windowsFolderKey(folder)
  const have = [...registryPathFolders(paths.machine, env), ...registryPathFolders(user, env)].map(windowsFolderKey)
  if (have.includes(key)) return { kind: 'already' }
  const base = user?.data ?? ''
  const sep = base === '' || base.endsWith(';') ? '' : ';'
  return { kind: 'append', was: registryPathToken(user), next: { kind: user?.kind ?? 'ExpandString', data: `${base}${sep}${folder}` } }
}

export type UserPathAppendResult =
  | { outcome: 'added'; broadcast: boolean }
  | { outcome: 'already' }
  | { outcome: 'unsupported'; why: string }
  | { outcome: 'changed' }

/** Append `folder` to the user's PATH in the registry (HKCU\Environment),
 *  unless the system or user Path already has it; the value as stored,
 *  then `folder`, in its own registry type. Tried from a fresh read once
 *  more when the value changed between the read and the write. Throws when
 *  Windows PowerShell cannot be run or answers nothing usable. */
export async function appendFolderToUserPath(
  folder: string,
  opts: { run?: PowerShellRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<UserPathAppendResult> {
  const run = opts.run ?? runWindowsPowerShell
  const env = opts.env ?? process.env
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = planUserPathAppend(await readRegistryPaths(run), folder, env)
    if (plan.kind === 'already') return { outcome: 'already' }
    if (plan.kind === 'unsupported') return { outcome: 'unsupported', why: plan.why }
    const answer = answerLines(await run(REGISTRY_PATH_SCRIPT, {
      [E.mode]: 'append', [E.was]: plan.was, [E.next]: utf16Base64(plan.next.data), [E.kind]: plan.next.kind,
    }))
    const result = answer.get('result')
    if (result === 'written') return { outcome: 'added', broadcast: answer.get('broadcast') === 'sent' }
    if (result !== 'changed') throw new Error('the PATH write gave no answer it could use')
  }
  return { outcome: 'changed' }
}
