// Input diagnostics for #145 — answers "what does this external tool ACTUALLY
// send?" instead of guessing.
//
// Two rounds of fixes for Aqua Voice failed because the injection mechanism was
// assumed rather than measured: first the xterm helper textarea's focus, then the
// document's focus. The third outcome — dictation producing NO text and NO paste
// hint — proves no paste chord arrives at all, which rules out the whole keyboard
// class and leaves possibilities that cannot be distinguished by reasoning
// (UI Automation value-set, posted WM_CHAR, synthesized typing that lands
// elsewhere).
//
// So: log every input-ish event with enough detail to identify the mechanism, and
// separately poll the helper textarea's value, because a PROGRAMMATIC `.value`
// assignment fires no event at all and would otherwise be invisible.
//
// Off unless CCC_INPUT_DEBUG=1 is set for the main process, so it costs nothing
// in normal use.

export interface DiagEvent {
  kind: string
  key?: string
  code?: string
  mods?: string
  isTrusted?: boolean
  inputType?: string
  data?: string | null
  target?: string
  active?: string
  valueLen?: number
  note?: string
}

/** Compact single-line rendering, so a dictation run is greppable in app.log. */
export function formatDiagEvent(e: DiagEvent): string {
  const parts: string[] = [e.kind]
  if (e.key !== undefined) parts.push(`key=${JSON.stringify(e.key)}`)
  if (e.code) parts.push(`code=${e.code}`)
  if (e.mods) parts.push(`mods=${e.mods}`)
  if (e.inputType) parts.push(`inputType=${e.inputType}`)
  if (e.data !== undefined && e.data !== null) parts.push(`data=${JSON.stringify(e.data)}`)
  if (e.isTrusted !== undefined) parts.push(`trusted=${e.isTrusted}`)
  if (e.target) parts.push(`target=${e.target}`)
  if (e.active) parts.push(`active=${e.active}`)
  if (e.valueLen !== undefined) parts.push(`valueLen=${e.valueLen}`)
  if (e.note) parts.push(`note=${e.note}`)
  return parts.join(' ')
}

/** `div.xterm-screen` / `textarea.xterm-helper-textarea` / `BODY` — enough to tell
 *  which surface an event hit without dumping the whole element. */
export function describeNode(n: EventTarget | null): string {
  const el = n as (Element & { tagName?: string }) | null
  if (!el) return 'null'
  if (!el.tagName) return String((n as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown')
  const tag = el.tagName.toLowerCase()
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
  return `${tag}${cls}`.slice(0, 120)
}

function mods(e: KeyboardEvent): string {
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta']
    .filter(Boolean)
    .join('+') || 'none'
}

/**
 * Attach diagnostics. Returns a disposer.
 *
 * @param container the terminal container element
 * @param log       sink for formatted lines (goes to main's app.log over IPC)
 * @param now       injectable clock so the poll is testable
 */
export function installInputDiagnostics(
  container: HTMLElement,
  log: (line: string) => void,
  opts: { pollMs?: number } = {},
): () => void {
  const emit = (e: DiagEvent) => {
    try { log(formatDiagEvent({ ...e, active: describeNode(document.activeElement) })) } catch { /* never break input */ }
  }

  const onKey = (ev: Event) => {
    const e = ev as KeyboardEvent
    emit({
      kind: e.type,
      key: e.key,
      code: e.code,
      mods: mods(e),
      isTrusted: e.isTrusted,
      target: describeNode(e.target),
    })
  }

  const onInput = (ev: Event) => {
    const e = ev as InputEvent & { target: HTMLTextAreaElement | null }
    emit({
      kind: e.type,
      inputType: (e as InputEvent).inputType,
      data: (e as InputEvent).data,
      isTrusted: e.isTrusted,
      target: describeNode(e.target),
      valueLen: typeof e.target?.value === 'string' ? e.target.value.length : undefined,
    })
  }

  const onComposition = (ev: Event) => {
    const e = ev as CompositionEvent
    emit({ kind: e.type, data: e.data, isTrusted: e.isTrusted, target: describeNode(e.target) })
  }

  const onPaste = (ev: Event) => {
    const e = ev as ClipboardEvent
    const text = e.clipboardData?.getData('text/plain') ?? ''
    emit({
      kind: 'paste',
      isTrusted: e.isTrusted,
      target: describeNode(e.target),
      valueLen: text.length,
      note: `types=${(e.clipboardData?.types ?? []).join(',') || 'none'}`,
    })
  }

  const onFocusEvt = (ev: Event) => emit({ kind: ev.type, target: describeNode(ev.target) })
  const onWindowFocus = () => emit({ kind: 'window:focus' })
  const onWindowBlur = () => emit({ kind: 'window:blur' })

  const KEY_EVENTS = ['keydown', 'keyup'] as const
  const INPUT_EVENTS = ['beforeinput', 'input'] as const
  const COMP_EVENTS = ['compositionstart', 'compositionupdate', 'compositionend'] as const
  const FOCUS_EVENTS = ['focusin', 'focusout'] as const

  // Capture phase on `document` so nothing can stop propagation before we see it.
  for (const t of KEY_EVENTS) document.addEventListener(t, onKey, true)
  for (const t of INPUT_EVENTS) document.addEventListener(t, onInput, true)
  for (const t of COMP_EVENTS) document.addEventListener(t, onComposition, true)
  for (const t of FOCUS_EVENTS) document.addEventListener(t, onFocusEvt, true)
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('textInput', onInput, true)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('blur', onWindowBlur)

  // Poll the helper textarea's value. A tool that assigns `.value` directly (or
  // via UI Automation's SetValue) can leave text sitting there having fired NO
  // event — the one mechanism the listeners above cannot see.
  let lastValue = ''
  const pollMs = opts.pollMs ?? 250
  const timer = setInterval(() => {
    const ta = container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null
    const v = ta?.value ?? ''
    if (v !== lastValue) {
      lastValue = v
      if (v) emit({ kind: 'poll:textareaValue', valueLen: v.length, data: v.slice(0, 80), note: 'value changed with no matching event above => programmatic set' })
    }
  }, pollMs)

  log('[input-diag] installed')

  return () => {
    clearInterval(timer)
    for (const t of KEY_EVENTS) document.removeEventListener(t, onKey, true)
    for (const t of INPUT_EVENTS) document.removeEventListener(t, onInput, true)
    for (const t of COMP_EVENTS) document.removeEventListener(t, onComposition, true)
    for (const t of FOCUS_EVENTS) document.removeEventListener(t, onFocusEvt, true)
    document.removeEventListener('paste', onPaste, true)
    document.removeEventListener('textInput', onInput, true)
    window.removeEventListener('focus', onWindowFocus)
    window.removeEventListener('blur', onWindowBlur)
  }
}
