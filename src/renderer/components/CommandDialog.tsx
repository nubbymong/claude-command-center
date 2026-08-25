import React, { useState } from 'react'
import { CustomCommand, CommandSection, CommandReviewReason, useCommandStore } from '../stores/commandStore'
import { generateId } from '../utils/id'
import { buildCommandLine, commandSecretRef, COMMAND_SECRET_TOKEN, secretValueProblem, secretPlacementProblem } from '../../shared/command-secret'
import { normaliseBrowserInput } from '../../shared/browser-url'
import { sessionCapabilities, describeTarget, type SessionCapabilities, type CommandTarget } from '../lib/session-capabilities'
import { swatchesFor, DEFAULT_COMMAND_COLOR } from '../lib/command-swatches'
import { describeReviewReason, planSecretMove } from '../lib/command-upgrade'
import { CommandChip, TargetMark } from './command-bar/chips'
import { clusterOf, effectiveKind } from './command-bar/layout'
import { IconColourPicker } from './command-bar/menus'
import { CommandIcon } from './command-icons'
import { ON_BRAND } from './ui/Dialog'

/**
 * What a command button DOES. This is the first question the dialog asks,
 * because it is the one fact that explains everything else about a command:
 * the same text field is a shell line for one kind and an English sentence for
 * the other, and the old dialog showed one "Prompt" box with a placeholder that
 * only fitted one of them.
 *
 * From 2.1.0-beta.17 the kind IS stored (`CustomCommand.kind`, ADR-018 D6):
 * once a Global button can be seen from a terminal-only session, `target`
 * alone cannot say whether a claude-target button is a prompt or that shell's
 * own line. Old records without it are read by `effectiveKind` (layout.ts).
 */
export type CommandKind = 'prompt' | 'shell' | 'page'

interface Props {
  /** `argSecret` is a NEW secret value to store for this command, handed to
   *  the caller so it can be written to the OS keychain under the command's
   *  id. It is never part of the command record. Undefined on edit means
   *  "keep whatever is stored"; `command.hasSecretArg` false means delete it. */
  onConfirm: (command: Omit<CustomCommand, 'id'>, argSecret?: string) => void
  onCancel: () => void
  initial?: CustomCommand
  configId?: string
  /** What THIS session can do (ADR-018 D2, D12): which agent, where each pane
   *  runs, whether a secret can reach the destination. The dialog reads this
   *  and nothing else about the session. */
  capabilities?: SessionCapabilities
  /** Legacy: true when the session's MAIN pane is a plain shell. Used only when
   *  `capabilities` is not given (older callers and tests). */
  mainPaneIsShell?: boolean
  /** A NEW command opened from a band / section: start in that scope and section. */
  presetScope?: 'global' | 'config'
  presetSectionId?: string
  /** The config's name, for the Session wording. */
  configName?: string
}

/** Where a shell command runs: the main pane (when it IS a shell) or the partner shell. */
type ShellWhere = 'main' | 'partner'

/** The kind a stored command has, for THIS session (legacy records inferred -- D6). */
export function kindOf(cmd: Pick<CustomCommand, 'target' | 'kind' | 'scope' | 'hasSecretArg'> | undefined, caps: SessionCapabilities): CommandKind {
  if (!cmd) return 'prompt'
  return effectiveKind({ kind: cmd.kind, target: cmd.target, scope: cmd.scope ?? 'global', hasSecretArg: cmd.hasSecretArg }, caps)
}

/** The target a (kind, where) pair resolves to. A page button runs in the
 *  browser, not a terminal; it is FILED with the main pane's buttons. */
export function targetFor(kind: CommandKind, caps: SessionCapabilities, shellWhere: ShellWhere): CommandTarget {
  if (kind === 'prompt' || kind === 'page') return 'claude'
  if (!caps.mainPaneIsShell) return 'partner'
  return shellWhere === 'partner' ? 'partner' : 'claude'
}

/**
 * The exact text the button will type, built by the SAME rule the command bar
 * uses (`prompt + ' ' + args.join(' ')`). Exported so the preview and the
 * bar cannot drift: a preview that showed one thing while the bar typed
 * another would be worse than no preview.
 */
export function previewLine(prompt: string, args: readonly string[], secretRef?: string | null): string {
  return buildCommandLine(prompt, args, secretRef)
}

export interface WhereOption {
  id: ShellWhere | 'browser'
  /** The machine, in words: "On this PC" / "On build-box" / "From this PC". */
  place: string
  /** What runs there: "partner shell", "Claude terminal", "the browser pane"… */
  detail: string
  enabled: boolean
  /** Why it cannot be chosen, when it cannot. */
  reason?: string
}

/**
 * "Where it runs", machine-explicit on every kind (ADR-018 D12). Where only
 * one answer exists the other chip is still drawn, disabled, with the reason:
 * on an SSH agent session a shell line cannot run on the host because there is
 * no remote shell pane -- the partner shell is on THIS PC -- and the dialog
 * says so instead of letting "the partner shell" imply the host.
 */
export function whereOptions(kind: CommandKind, caps: SessionCapabilities): WhereOption[] {
  const mainPlace = caps.mainRunsOn === 'remote' ? `On ${caps.remoteHost ?? 'the host'}` : 'On this PC'
  if (kind === 'page') return [{ id: 'browser', place: 'From this PC', detail: 'the browser pane', enabled: true }]
  if (kind === 'prompt') return [{ id: 'main', place: mainPlace, detail: `${caps.agentName || 'the agent'} terminal`, enabled: true }]
  const main: WhereOption = caps.mainPaneIsShell
    ? { id: 'main', place: mainPlace, detail: 'this shell', enabled: true }
    : caps.mainRunsOn === 'remote'
      ? { id: 'main', place: mainPlace, detail: 'no remote shell in this session', enabled: false, reason: 'This session has no remote shell pane. A remote shell line belongs in the SSH config\'s "After connecting, run".' }
      : { id: 'main', place: mainPlace, detail: `${caps.agentName} terminal — not a shell`, enabled: false, reason: `The main pane is ${caps.agentName}; it reads prompts, not shell lines.` }
  const partner: WhereOption = { id: 'partner', place: 'On this PC', detail: 'partner shell', enabled: true }
  return [main, partner]
}

const noop = () => {}

// ---- E5 look: the tokens the new dialogs share --------------------------------
const INPUT_CLASS = 'w-full h-8 px-2.5 rounded-lg border text-[12.5px] outline-none focus-ring'
const INPUT_STYLE: React.CSSProperties = { background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }
const LABEL_CLASS = 'block text-[12.5px] font-medium mb-1.5'
const LABEL_STYLE: React.CSSProperties = { color: 'var(--text-primary)' }
const HINT_CLASS = 'text-[11px] mt-1 leading-snug'
const HINT_STYLE: React.CSSProperties = { color: 'var(--text-muted)' }
const SEG_CHIP = 'h-[30px] px-3 rounded-md border text-xs inline-flex items-center gap-1.5 whitespace-nowrap focus-ring transition-colors'
const segStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
  background: selected ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'var(--surface-raised)',
  borderColor: selected ? 'color-mix(in srgb, var(--brand) 55%, transparent)' : 'var(--border-subtle)',
  color: selected ? '#5cb0ff' : 'var(--text-secondary)',
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
})

function Field({ label, small, children, hint, right, testId }: { label: React.ReactNode; small?: string; children: React.ReactNode; hint?: React.ReactNode; right?: React.ReactNode; testId?: string }) {
  return (
    <div className="mb-3" data-testid={testId}>
      <label className={`${LABEL_CLASS} flex items-center`} style={LABEL_STYLE}>
        <span>{label}{small && <span className="ml-1.5 font-normal" style={{ color: 'var(--text-muted)' }}>{small}</span>}</span>
        {right && <span className="ml-auto">{right}</span>}
      </label>
      {children}
      {hint && <p className={HINT_CLASS} style={HINT_STYLE}>{hint}</p>}
    </div>
  )
}

export default function CommandDialog({ onConfirm, onCancel, initial, configId, capabilities, mainPaneIsShell = false, presetScope, presetSectionId, configName }: Props) {
  const isEdit = !!initial
  const caps = capabilities ?? sessionCapabilities({ provider: 'claude', sessionType: 'local', shellOnly: mainPaneIsShell, configId } as never)
  const agentName = caps.agentName || 'Claude'

  // A NEW command starts with no kind chosen and the dialog reveals itself once
  // it is answered; EDIT opens fully revealed with the stored (or inferred) kind.
  const [kind, setKind] = useState<CommandKind | null>(initial ? kindOf(initial, caps) : null)
  const [shellWhere, setShellWhere] = useState<ShellWhere>(initial?.target === 'partner' ? 'partner' : initial ? 'main' : caps.mainPaneIsShell ? 'main' : 'partner')

  const [label, setLabel] = useState(initial?.label || '')
  const [prompt, setPrompt] = useState(initial?.prompt || '')
  const [scope, setScope] = useState<'global' | 'config'>(configId ? (initial?.scope || presetScope || 'config') : 'global')
  const [color, setColor] = useState(initial?.color || DEFAULT_COMMAND_COLOR)
  const [icon, setIcon] = useState<string | undefined>(initial?.icon)
  const [defaultArgs, setDefaultArgs] = useState<string[]>(initial?.defaultArgs || [])
  const [argInput, setArgInput] = useState('')
  const [sectionId, setSectionId] = useState<string | undefined>(initial?.sectionId ?? presetSectionId)
  const [newSectionName, setNewSectionName] = useState('')
  const [showNewSection, setShowNewSection] = useState(false)
  const [webViewEnabled, setWebViewEnabled] = useState<boolean>(!!initial?.webView?.enabled)
  const [webViewUrl, setWebViewUrl] = useState(initial?.webView?.url || '')
  const [webViewUrlError, setWebViewUrlError] = useState<string | null>(null)
  // The page an "Open a page" button goes to. Normalised on save by the same
  // rule as the address bar (scheme-less localhost:5173 becomes http://...).
  const [pageUrl, setPageUrl] = useState(initial?.pageUrl || '')
  const [pageUrlError, setPageUrlError] = useState<string | null>(null)
  // Secret argument (shell kind only). `storedSecret` is whether the keychain
  // holds one already; `secretValue` is a NEW value typed now. On edit with a
  // stored secret and nothing typed, the stored one is kept.
  const storedSecret = !!initial?.hasSecretArg
  const [hasSecret, setHasSecret] = useState<boolean>(storedSecret)
  const [secretValue, setSecretValue] = useState('')
  // The upgrade review banner (D13): reasons fixed here, or the whole thing dismissed.
  const [fixedReasons, setFixedReasons] = useState<CommandReviewReason[]>([])
  const [reviewDismissed, setReviewDismissed] = useState(false)
  /** The value the one-click fix moved to the keychain (so remembered args holding it are forgotten on save). */
  const [movedValue, setMovedValue] = useState<string | null>(null)
  const isWin = typeof window !== 'undefined' && (window as unknown as { electronPlatform?: string }).electronPlatform === 'win32'

  const store = useCommandStore()
  const { sections, addSection } = store
  // The sections a button can join are those of the band it will sit in (D9):
  // Global sections for a Global button, this config's for a Session button.
  const sectionsFor = (s: 'global' | 'config'): CommandSection[] =>
    sections.filter((x) => (s === 'global' ? x.scope === 'global' : (x.scope === 'config' && x.configId === configId)))
  const visibleSections = sectionsFor(scope)

  // On an agent session the main pane cannot take a shell line, so "partner"
  // is the only answer however the state was seeded.
  const effectiveWhere: ShellWhere = kind === 'shell' && !caps.mainPaneIsShell ? 'partner' : shellWhere
  const target: CommandTarget = kind ? targetFor(kind, caps, effectiveWhere) : 'claude'
  const options = kind ? whereOptions(kind, caps) : []
  const selectedWhere: WhereOption['id'] = kind === 'page' ? 'browser' : kind === 'prompt' ? 'main' : effectiveWhere
  // Where the text goes, in words the preview and the run-location line share.
  const destination = kind === 'page' ? 'the browser pane (from this PC)' : describeTarget(caps, target)

  const handleAddArg = () => {
    const arg = argInput.trim()
    if (arg && !defaultArgs.includes(arg)) {
      setDefaultArgs([...defaultArgs, arg])
      setArgInput('')
    }
  }
  const handleRemoveArg = (idx: number) => setDefaultArgs(defaultArgs.filter((_, i) => i !== idx))
  const handleArgKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleAddArg() } }

  /** Flip the scope: the chosen section must exist in the NEW band, or it goes. */
  const changeScope = (next: 'global' | 'config') => {
    if (next === 'config' && !configId) return
    setScope(next)
    if (sectionId && !sectionsFor(next).some((s) => s.id === sectionId)) setSectionId(undefined)
    if (showNewSection) { setShowNewSection(false); setNewSectionName('') }
  }

  const handleCreateSection = () => {
    const name = newSectionName.trim()
    if (!name) return
    // Created in the band the button will sit in (D9).
    const newSection: CommandSection = { id: generateId(), name, scope, configId: scope === 'config' ? configId : undefined }
    addSection(newSection)
    setSectionId(newSection.id)
    setNewSectionName('')
    setShowNewSection(false)
  }

  // Mirror the main-process webview IPC's allowlist (see webview-handlers.ts
  // urlSchema). Validating here means a typo / file:// / missing scheme
  // surfaces inline instead of being saved-then-failed at runtime.
  const validateWebviewUrl = (raw: string): string | null => {
    const trimmed = raw.trim()
    if (!trimmed) return 'URL is required when the page watch is on'
    let parsed: URL
    try { parsed = new URL(trimmed) } catch { return 'Invalid URL -- must include http:// or https://' }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `Unsupported scheme "${parsed.protocol}" -- only http and https are allowed`
    return null
  }

  // A secret can only be OFFERED where its value can arrive: a local shell
  // (ADR-018 D12). Main sets the env var when a local shell starts; the SSH
  // branch never does, and a reference typed into an agent's TUI is just text.
  const secretAllowed = kind === 'shell' && caps.canDeliverSecret(target)
  const secretOn = kind === 'shell' && hasSecret && (secretAllowed || storedSecret)
  // A value PowerShell 5.1 cannot pass to a command intact (a double quote, a
  // trailing backslash, cmd metacharacters for .cmd-based tools) is refused
  // here, because the app cannot rewrite a secret. One rule, shared with the
  // terminal config's secret argument: shared/command-secret.secretValueProblem.
  const secretProblem = secretOn && secretValue.length > 0 ? secretValueProblem(secretValue, isWin) : null
  // Where the token SITS matters as much as what the value is: a {secret} just
  // outside a closed quote, inside single quotes, or in the command position has
  // no safe reference form, so it is left literal at launch rather than
  // substituted (the ADR-009 pass measured the alternative putting the value in
  // its own argv entry). Tell the user here instead of letting the command fail
  // mysteriously. (#371)
  const placementProblem = secretOn
    ? secretPlacementProblem(prompt, { isCommandLine: true }) ?? defaultArgs.map((a) => secretPlacementProblem(a)).find(Boolean) ?? null
    : null
  // A secret that is switched on must HAVE a value: stored already, or typed now
  // (not whitespace), and a typed value must be one the shell can carry.
  const typedSecret = secretValue.trim().length > 0
  const secretReady = !secretOn || ((storedSecret || typedSecret) && !secretProblem && !placementProblem)
  const canSubmit = !!kind && !!label.trim() && secretReady && (kind === 'page' ? !!pageUrl.trim() : !!prompt.trim())

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !kind) return
    const base = {
      label: label.trim(),
      scope,
      configId: scope === 'config' ? configId : undefined,
      color,
      icon,
      sectionId,
    }
    if (kind === 'page') {
      // The one kind that types nothing. No prompt, no args, no secret, no
      // watch -- a label, a page, and where it is filed. The typing-kind fields
      // are cleared EXPLICITLY: the store merges, so a shell button turned into
      // a page would otherwise keep `hasSecretArg: true` while the caller
      // deletes its keychain value (ADR-009 pass on #386).
      const result = normaliseBrowserInput(pageUrl)
      if (!result.ok) { setPageUrlError(result.error); return }
      setPageUrlError(null)
      onConfirm({ ...base, prompt: '', target: 'claude', kind: 'page', pageUrl: result.url, defaultArgs: undefined, lastCustomArgs: undefined, hasSecretArg: undefined, webView: undefined })
      return
    }
    if (webViewEnabled) {
      const urlError = validateWebviewUrl(webViewUrl)
      if (urlError) { setWebViewUrlError(urlError); return }
    }
    setWebViewUrlError(null)
    onConfirm({
      ...base,
      prompt: prompt.trim(),
      target,
      kind,
      defaultArgs: defaultArgs.length > 0 ? defaultArgs : undefined,
      // The REMEMBERED (Ctrl+click) arguments are typed too. Once a secret is
      // on, or a value was just moved to the keychain, they may hold that value
      // in plain text -- they are forgotten rather than re-typed.
      lastCustomArgs: secretOn || movedValue !== null ? undefined : initial?.lastCustomArgs,
      hasSecretArg: secretOn ? true : undefined,
      webView: webViewEnabled ? { enabled: true, url: webViewUrl.trim() } : undefined,
    }, secretOn && typedSecret ? secretValue : undefined)
  }

  // Copy that follows the kind. One field, two very different things typed
  // into it -- the label, helper and placeholder have to say which.
  const textField = kind === 'shell'
    ? { label: 'Command to run', helper: 'Typed into the terminal exactly as written, then Enter.', placeholder: 'e.g. npm test', mono: true }
    : { label: 'Prompt to send', helper: `Submitted to ${agentName} as if you had typed it and pressed Enter.`, placeholder: 'Fix all lint errors and run the linter again', mono: false }

  // The preview shows the REFERENCE the shell will see, never a value. On
  // create the id does not exist yet, so the name is shown with a placeholder.
  const previewRef = secretOn
    ? (initial?.id ? commandSecretRef(initial.id, isWin) : (isWin ? '${env:CCC_CMD_SECRET_<id>}' : '"$CCC_CMD_SECRET_<id>"'))
    : undefined
  const line = previewLine(prompt, defaultArgs, previewRef)
  const pageNormalised = kind === 'page' ? normaliseBrowserInput(pageUrl) : null

  // The preview draws the REAL chip (D12): the same component the bar uses,
  // fed a draft record, so the first time you see your icon is not after Create.
  const draft: CustomCommand = {
    id: initial?.id ?? '__preview',
    label: label.trim() || 'Button',
    prompt,
    scope,
    configId: scope === 'config' ? configId : undefined,
    color,
    icon,
    target,
    kind: kind ?? 'prompt',
    pageUrl: pageNormalised?.ok ? pageNormalised.url : undefined,
    defaultArgs: defaultArgs.length ? defaultArgs : undefined,
    hasSecretArg: secretOn || undefined,
    webView: webViewEnabled && webViewUrl.trim() ? { enabled: true, url: webViewUrl.trim() } : undefined,
    pinned: initial?.pinned,
  }

  // ---- the upgrade review banner (D13) ----------------------------------------
  const pendingReasons = (initial?.needsReview ?? []).filter((r) => !fixedReasons.includes(r))
  const showReview = isEdit && !reviewDismissed && pendingReasons.length > 0
  // What the one-click fix WOULD move (null = nothing movable, button withheld).
  const secretMove = planSecretMove(defaultArgs)
  const markFixed = (r: CommandReviewReason) => setFixedReasons((f) => (f.includes(r) ? f : [...f, r]))
  /** One click: the value leaves the argument for the keychain and `{secret}`
   *  takes its place in the line (planSecretMove decides which). Saving writes both. */
  const makeArgSecret = () => {
    if (!secretMove) return
    setDefaultArgs(secretMove.args)
    setHasSecret(true)
    setSecretValue(secretMove.value)
    setMovedValue(secretMove.value)
    markFixed('secret-like-arg')
  }
  const dismissReview = () => {
    if (initial) store.clearReview?.(initial.id)
    setReviewDismissed(true)
  }

  const askConductor = () => {
    // Loaded on click so the dialog has no import-time dependency on the help
    // session's module (it is never needed until someone asks).
    const q = kind
      ? `I'm editing a command-bar button of kind "${kind}". What can it do, and how should I fill in the dialog?`
      : 'I\'m adding a command-bar button. Should it send a prompt, run a command, or open a page — and what does each do?'
    void import('../lib/askConductor').then((m) => m.launchAskConductor(q)).catch((err: unknown) => console.warn('[CommandDialog] Ask Conductor failed:', err))
  }

  // Escape closes wherever focus is -- a one-click fix in the review banner
  // unmounts the button that had focus, and a dialog that only listens on
  // itself goes deaf the moment focus falls to the body (VM proof 2026-08-22).
  const escapeRef = React.useRef<() => void>(() => {})
  escapeRef.current = () => {
    if (showNewSection) { setShowNewSection(false); setNewSectionName('') } else onCancel()
  }
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); escapeRef.current() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const kindTile = (value: CommandKind, glyph: string, title: string, sub: string) => {
    const active = kind === value
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={active}
        data-testid={`command-kind-${value}`}
        onClick={() => setKind(value)}
        className="flex flex-col items-center gap-1 rounded-[10px] border px-2 py-2.5 text-center focus-ring transition-colors"
        style={{
          background: active ? 'color-mix(in srgb, var(--brand) 15%, var(--surface-base))' : 'var(--surface-base)',
          borderColor: active ? 'var(--brand)' : 'var(--border-subtle)',
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}
      >
        <CommandIcon icon={glyph} color={active ? 'var(--brand)' : 'currentColor'} label={title} size={15} />
        <span className="text-[12.5px] font-semibold">{title}</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sub}</span>
      </button>
    )
  }

  const promptSub = caps.mainRunsOn === 'remote' ? `to ${agentName} on ${caps.remoteHost ?? 'the host'}` : `to ${agentName}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="command-dialog">
      <div
        className="rounded-[14px] shadow-2xl w-[560px] max-w-[94vw] max-h-[88vh] overflow-y-auto flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-dialog-title"
      >
        <div className="px-[18px] pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 id="command-dialog-title" className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isEdit ? 'Edit command button' : 'New command button'}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>A button in the command bar that runs something for you.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
          <div className="px-[18px] pt-3.5 pb-1 overflow-y-auto">
            {/* The upgrade review (D13): what clashed with the new model, with
                one-click fixes. Nothing was changed without this click. */}
            {showReview && (
              <div className="mb-3 rounded-[9px] border px-3 py-2.5 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)', color: 'var(--text-secondary)' }} data-testid="command-review-banner" role="status">
                <div className="flex items-center gap-1.5 font-semibold mb-1.5" style={{ color: 'var(--status-warning)' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                  This button needs a look after the command-bar update
                </div>
                <ul className="space-y-1.5">
                  {pendingReasons.map((r) => (
                    <li key={r} className="flex items-start gap-2" data-testid={`command-review-reason-${r}`}>
                      <span className="flex-1 leading-snug">{describeReviewReason(r)}</span>
                      {r === 'secret-like-arg' && kind === 'shell' && secretAllowed && secretMove && (
                        <button type="button" onClick={makeArgSecret} className="shrink-0 h-6 px-2 rounded-md text-[11px] font-medium" style={{ background: 'var(--brand)', color: ON_BRAND }} title={`Moves the value of "${defaultArgs[secretMove.index]}" to the keychain`} data-testid="command-review-fix-secret">Make this argument a secret</button>
                      )}
                      {r === 'prompt-inert-on-shell-configs' && configId && scope === 'global' && (
                        <button type="button" onClick={() => { changeScope('config'); markFixed('prompt-inert-on-shell-configs') }} className="shrink-0 h-6 px-2 rounded-md text-[11px] font-medium" style={{ background: 'var(--brand)', color: ON_BRAND }} data-testid="command-review-fix-session">Make it Session-only</button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Saving clears this. Or:</span>
                  <button type="button" onClick={dismissReview} className="h-6 px-2 rounded-md text-[11px]" style={{ background: 'var(--surface-overlay)', color: 'var(--text-primary)' }} data-testid="command-review-dismiss">Keep as is</button>
                </div>
              </div>
            )}

            {/* Kind FIRST. Everything below depends on the answer. */}
            <Field
              label="What should it do?"
              testId="command-field-kind"
              right={!caps.isAsk && (
                <button type="button" onClick={askConductor} className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[11px] font-semibold focus-ring" style={{ color: 'var(--brand)', borderColor: 'color-mix(in srgb, var(--brand) 45%, transparent)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }} title="Open Ask Conductor with this question" data-testid="command-ask-conductor">
                  <CommandIcon icon="chat" color="currentColor" label="Ask" size={11} />
                  Ask Conductor
                </button>
              )}
              hint={!kind ? 'Changes what the fields below ask for: a shell line is not a sentence, and a page is neither.' : undefined}
            >
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${caps.agent ? 3 : 2}, minmax(0, 1fr))` }} role="radiogroup" aria-label="What the button does">
                {/* A terminal-only session has no agent to prompt; offering the
                    tile would be offering a button that cannot work. */}
                {caps.agent && kindTile('prompt', 'chat', 'Send a prompt', promptSub)}
                {kindTile('shell', 'terminal', 'Run a command', 'in a shell')}
                {kindTile('page', 'globe', 'Open a page', 'in the browser')}
              </div>
            </Field>

            {kind && (
              <>
                {storedSecret && kind !== 'shell' && (
                  <p className="mb-3 rounded-[9px] border px-3 py-2 text-[11.5px] leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)', color: 'var(--text-secondary)' }} data-testid="command-secret-dropped">
                    This button stores a secret. A secret rides a shell line only, so saving it as {kind === 'page' ? 'a page' : 'a prompt'} removes the stored value from the keychain.
                  </p>
                )}
                <Field label="Button label">
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                    placeholder={kind === 'shell' ? 'e.g. Run tests' : kind === 'page' ? 'e.g. Docs' : 'e.g. Fix lint'}
                    maxLength={20}
                    autoFocus
                    data-testid="command-label"
                  />
                </Field>

                {kind === 'page' ? (
                  <Field
                    label="Page to open"
                    hint={pageUrlError
                      ? <span id="page-url-error" style={{ color: 'var(--status-danger)' }} role="alert">{pageUrlError}</span>
                      : 'http and https only. Nothing is typed into any terminal: the button sends this session\'s browser pane to the page, fetched from this PC.'}
                  >
                    <input
                      type="text"
                      value={pageUrl}
                      onChange={(e) => { setPageUrl(e.target.value); if (pageUrlError) setPageUrlError(null) }}
                      className={`${INPUT_CLASS} font-mono`}
                      style={{ ...INPUT_STYLE, borderColor: pageUrlError ? 'var(--status-danger)' : INPUT_STYLE.borderColor }}
                      placeholder="localhost:5173, or https://docs.example.com"
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!pageUrlError}
                      aria-describedby={pageUrlError ? 'page-url-error' : undefined}
                      data-testid="command-page-url"
                    />
                  </Field>
                ) : (
                  <>
                    <Field label={textField.label} hint={textField.helper}>
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        className={`w-full px-2.5 py-1.5 rounded-lg border text-[12.5px] outline-none focus-ring resize-none ${textField.mono ? 'font-mono' : ''}`}
                        style={INPUT_STYLE}
                        rows={kind === 'shell' ? 2 : 3}
                        placeholder={textField.placeholder}
                        spellCheck={kind !== 'shell'}
                        data-testid="command-text"
                      />
                    </Field>

                    <Field label="Arguments" small="optional">
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {defaultArgs.map((arg, idx) => (
                          <span key={idx} className="inline-flex items-center gap-1 px-2 h-6 text-xs rounded-md border font-mono" style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                            {arg}
                            <button type="button" onClick={() => handleRemoveArg(idx)} className="ml-0.5" style={{ color: 'var(--text-muted)' }} aria-label={`Remove argument ${arg}`}>
                              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" /></svg>
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={argInput}
                          onChange={(e) => setArgInput(e.target.value)}
                          onKeyDown={handleArgKeyDown}
                          className={`${INPUT_CLASS} flex-1 font-mono`}
                          style={INPUT_STYLE}
                          placeholder={kind === 'shell' ? 'e.g. -Port 8080' : 'e.g. --verbose'}
                          data-testid="command-arg-input"
                        />
                        <button type="button" onClick={handleAddArg} disabled={!argInput.trim()} className="h-8 px-2.5 text-xs rounded-lg border disabled:opacity-40" style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                          Add
                        </button>
                      </div>
                      {/* Two things nobody could have known from this dialog. The first
                          is a correctness trap: arguments are concatenated onto the
                          command with single spaces and NOTHING is quoted, so a value
                          containing a space becomes two arguments. The second is a real
                          feature that was taught only by a tip -- which may never have fired. */}
                      <p className={HINT_CLASS} style={HINT_STYLE}>
                        Appended after the {kind === 'shell' ? 'command' : 'prompt'}, separated by spaces. Nothing is quoted for you, so an argument containing a space arrives as two.
                        {' '}<span style={{ color: 'var(--text-secondary)' }}>Ctrl+click the button</span> to change these for one run without editing the command.
                      </p>
                    </Field>

                    {kind === 'shell' && (
                      <div className="mb-3">
                        {secretAllowed ? (
                          <>
                            <label className="flex items-center gap-2 text-[12.5px] font-medium cursor-pointer select-none" style={LABEL_STYLE}>
                              <input type="checkbox" checked={hasSecret} onChange={(e) => setHasSecret(e.target.checked)} className="accent-[var(--brand)]" data-testid="command-secret-toggle" />
                              One of the arguments is a secret
                            </label>
                            {hasSecret && (
                              <div className="mt-1.5">
                                <input
                                  type="password"
                                  value={secretValue}
                                  onChange={(e) => setSecretValue(e.target.value)}
                                  className={`${INPUT_CLASS} font-mono`}
                                  style={{ ...INPUT_STYLE, borderColor: secretProblem ? 'var(--status-danger)' : INPUT_STYLE.borderColor }}
                                  placeholder={storedSecret ? 'Stored -- type here to replace it' : 'The secret value'}
                                  autoComplete="off"
                                  aria-invalid={!!secretProblem}
                                  data-testid="command-secret-value"
                                />
                                {secretProblem && <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-danger)' }} role="alert" data-testid="command-secret-problem">{secretProblem}</p>}
                                {placementProblem && <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-danger)' }} role="alert" data-testid="command-secret-placement-problem">{placementProblem}</p>}
                                {/* Same mechanism a terminal config's secret argument already
                                    uses, and for the same reason: the shell writes every
                                    submitted line to disk (PSReadLine), so the value must
                                    never be in the line. It rides the shell's ENVIRONMENT
                                    from the keychain, and the button types the reference. */}
                                <div className="mt-1.5 flex items-start gap-2 rounded-[9px] border px-2.5 py-2 text-[11.5px] leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--status-warning) 35%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', color: 'var(--text-secondary)' }} data-testid="command-secret-callout">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--status-warning)" strokeWidth="2" className="shrink-0 mt-px" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                                  <span>
                                    <b style={{ color: 'var(--text-primary)' }}>Mark an argument secret</b> and its value goes to the OS keychain. The button passes a reference the shell expands, so the value never appears in the command line and never reaches your shell history. Write <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{COMMAND_SECRET_TOKEN}</span> where the value belongs, e.g. <span className="font-mono" style={{ color: 'var(--text-primary)' }}>-Token {COMMAND_SECRET_TOKEN}</span>.
                                    {' '}The button types {isWin ? <span className="font-mono">{'${env:NAME}'}</span> : <span className="font-mono">"$NAME"</span>} ({isWin ? 'PowerShell' : 'bash, zsh'}); a shell of another kind, such as {isWin ? 'cmd.exe or WSL' : 'PowerShell or nushell'}, will not expand it.
                                    {' '}A shell that is already open does not have it yet -- restart the shell after saving.
                                    {isWin && <> On Windows the value cannot contain a double quote or <span className="font-mono">&amp; | ^ &lt; &gt; %</span>, or end with a backslash -- PowerShell cannot pass those to a command intact. A value longer than about 8,000 characters will not reach a tool launched through a <span className="font-mono">.cmd</span> wrapper (most <span className="font-mono">npm</span>-installed tools), which is a limit of the Windows command line itself.</>}
                                  </span>
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-[11px] leading-snug" style={HINT_STYLE} data-testid="command-secret-unavailable">
                            Secret values reach shells on this PC only{storedSecret ? ' -- this button carries one, and it will not arrive where this runs.' : ', so no secret argument is offered here.'}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Where it runs: the machine AND the pane, on every kind (D12). */}
                <Field
                  label="Where it runs"
                  testId="command-field-runs"
                  hint={kind === 'page'
                    ? 'The page is fetched from this computer and shown in this session\'s browser pane.'
                    : caps.panesOnDifferentMachines
                      ? <>This is an SSH session: {caps.mainPaneIsShell ? 'the main shell' : agentName} runs on {caps.remoteHost ?? 'the host'}, the partner shell runs on this computer. A remote shell line belongs in the SSH config's "After connecting, run".</>
                      : 'This is also the cluster the button sits in on the bar, so the bar always says where it runs.'}
                >
                  <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="Where it runs" data-testid="command-runs-in">
                    {options.map((o) => {
                      const selected = selectedWhere === o.id
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-disabled={!o.enabled || undefined}
                          disabled={!o.enabled}
                          title={o.reason}
                          onClick={() => { if (o.enabled && kind === 'shell' && (o.id === 'main' || o.id === 'partner')) setShellWhere(o.id) }}
                          className={SEG_CHIP}
                          style={segStyle(selected, !o.enabled)}
                          data-testid={`command-where-${o.id}`}
                        >
                          <span>{o.place}</span>
                          <span style={{ color: selected ? 'inherit' : 'var(--text-muted)' }}>— {o.detail}</span>
                        </button>
                      )
                    })}
                  </div>
                </Field>

                {kind !== 'page' && (
                  <div className="mb-3">
                    <label className="flex items-center gap-2 text-[12.5px] font-medium cursor-pointer select-none" style={LABEL_STYLE}>
                      <input type="checkbox" checked={webViewEnabled} onChange={(e) => setWebViewEnabled(e.target.checked)} className="accent-[var(--brand)]" data-testid="command-watch-toggle" />
                      Watch for a page and open the browser when it responds
                    </label>
                    {webViewEnabled && (
                      <div className="mt-1.5">
                        <input
                          type="url"
                          value={webViewUrl}
                          onChange={(e) => { setWebViewUrl(e.target.value); if (webViewUrlError) setWebViewUrlError(null) }}
                          className={`${INPUT_CLASS} font-mono`}
                          style={{ ...INPUT_STYLE, borderColor: webViewUrlError ? 'var(--status-danger)' : INPUT_STYLE.borderColor }}
                          placeholder="http://localhost:3000"
                          aria-invalid={!!webViewUrlError}
                          aria-describedby={webViewUrlError ? 'webview-url-error' : undefined}
                          data-testid="command-watch-url"
                        />
                        {webViewUrlError ? (
                          <p id="webview-url-error" className="mt-1 text-[10.5px]" style={{ color: 'var(--status-danger)' }}>{webViewUrlError}</p>
                        ) : (
                          <p className={HINT_CLASS} style={HINT_STYLE}>
                            Polled from this PC from the moment the command is SENT -- it is watching for a server that is still starting up. Every second for up to 30 s; the Browser button turns green as soon as the page answers, red on timeout.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <Field label="Icon" small="optional — the first letter is used if you pick none" testId="command-field-icon">
                  <IconColourPicker icon={icon} color={color} label={label || 'Button'} onIcon={setIcon} onColor={setColor} compact showColours={false} />
                </Field>

                <Field label="Colour" testId="command-field-colour" hint="The eleven section pastels; an existing colour outside the set stays as an extra swatch.">
                  <div className="flex flex-wrap gap-1.5" data-testid="command-colours">
                    {swatchesFor(initial?.color).map((c) => {
                      const on = c.toUpperCase() === color.toUpperCase()
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setColor(c)}
                          aria-label={`Colour ${c}`}
                          aria-pressed={on}
                          className={`w-4 h-4 rounded-full border-2 transition-all focus-ring ${on ? 'scale-110' : ''}`}
                          style={{ backgroundColor: c, borderColor: on ? '#fff' : 'transparent', boxShadow: on ? '0 0 0 1px var(--border-strong)' : undefined }}
                          title={swatchesFor(undefined).includes(c) ? c : `${c} — your existing colour, kept`}
                        />
                      )
                    })}
                  </div>
                </Field>

                {/* Scope, in the bar's own words (D6): the band the button sits in. */}
                <Field
                  label="Where it shows"
                  testId="command-field-scope"
                  hint={!configId
                    ? 'This session has no saved config, so there is no "this config" to scope to -- the button is Global.'
                    : scope === 'global'
                      ? 'Appears in every config\'s Global band. Editing or deleting it changes all of them.'
                      : `Appears only in this config's Session band${configName ? ` (${configName})` : ''}.`}
                >
                  <div className="flex gap-1.5" role="radiogroup" aria-label="Where it shows" data-testid="command-scope">
                    <button type="button" role="radio" aria-checked={scope === 'global'} onClick={() => changeScope('global')} className={SEG_CHIP} style={segStyle(scope === 'global')} data-testid="command-scope-global">Global — every config</button>
                    <button type="button" role="radio" aria-checked={scope === 'config'} aria-disabled={!configId || undefined} disabled={!configId} onClick={() => changeScope('config')} className={SEG_CHIP} style={segStyle(scope === 'config', !configId)} title={!configId ? 'This session has no saved config' : undefined} data-testid="command-scope-config">Session — this config only</button>
                  </div>
                </Field>

                <Field label="Section" hint={`…or "New section…" — created in the ${scope === 'global' ? 'Global' : 'Session'} band.`} testId="command-field-section">
                  {!showNewSection ? (
                    <select
                      value={sectionId || ''}
                      onChange={(e) => { const val = e.target.value; if (val === '__new__') setShowNewSection(true); else setSectionId(val || undefined) }}
                      className={INPUT_CLASS}
                      style={INPUT_STYLE}
                      data-testid="command-section"
                    >
                      <option value="">No section</option>
                      {visibleSections.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                      <option value="__new__">New section…</option>
                    </select>
                  ) : (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={newSectionName}
                        onChange={(e) => setNewSectionName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                        className={`${INPUT_CLASS} flex-1`}
                        style={INPUT_STYLE}
                        placeholder="Section name"
                        autoFocus
                        data-testid="command-new-section-name"
                      />
                      <button type="button" onClick={handleCreateSection} disabled={!newSectionName.trim()} className="h-8 px-2.5 text-xs rounded-lg font-semibold disabled:opacity-40" style={{ background: 'var(--brand)', color: ON_BRAND }} data-testid="command-new-section-create">Create</button>
                      <button type="button" onClick={() => { setShowNewSection(false); setNewSectionName('') }} className="h-8 px-2.5 text-xs rounded-lg" style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}>Cancel</button>
                    </div>
                  )}
                </Field>

                {/* The button, drawn by the bar's own component, and the exact text
                    it will type -- built by the same rule the bar uses. */}
                <div className="rounded-[9px] border px-2.5 py-2 mb-1" style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)' }} data-testid="command-preview" aria-live="polite">
                  <div className="text-[9.5px] font-semibold uppercase tracking-[.09em] mb-1.5" style={{ color: 'var(--text-muted)' }}>Preview · on the bar</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[9.5px] font-semibold uppercase tracking-[.09em] px-0.5" style={{ color: 'var(--text-muted)' }} data-testid="command-preview-band">{scope === 'global' ? 'Global' : 'Session'}</span>
                    <TargetMark kind={clusterOf(draft, caps)} caps={caps} />
                    <CommandChip cmd={draft} caps={caps} onClick={noop} onContextMenu={noop} tabIndex={-1} />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {kind === 'page' ? 'opens in' : kind === 'prompt' ? 'sends to' : 'types into'} <span style={{ color: 'var(--text-secondary)' }}>{destination}</span>
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono text-[11.5px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }} data-testid="command-preview-line">
                    {kind === 'page'
                      ? (pageNormalised?.ok ? <>{pageNormalised.url} <span style={{ color: 'var(--text-muted)' }}>(types nothing)</span></> : <span style={{ color: 'var(--text-muted)' }}>(no page yet)</span>)
                      : line
                        ? <>{line} <span style={{ color: 'var(--text-muted)' }}>{String.fromCodePoint(0x23ce)} — {destination}</span></>
                        : <span style={{ color: 'var(--text-muted)' }}>(nothing yet)</span>}
                  </div>
                  {webViewEnabled && webViewUrl.trim() && kind !== 'page' && (
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="command-preview-watch">
                      then watches <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{webViewUrl.trim()}</span> from this PC
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="px-[18px] pt-3 pb-3.5 mt-2 flex justify-end gap-2 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button type="button" onClick={onCancel} className="h-7 px-3 rounded-[7px] text-xs" style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} data-testid="command-submit" className="h-7 px-3 rounded-[7px] text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: 'var(--brand)', color: ON_BRAND }}>
              {isEdit ? 'Save' : 'Create button'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
