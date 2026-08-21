import React, { useState } from 'react'
import { CustomCommand, CommandSection, useCommandStore } from '../stores/commandStore'
import { COLOR_SWATCHES } from './SessionDialog'
import { generateId } from '../utils/id'

/**
 * What a command button DOES. This is the first question the dialog asks,
 * because it is the one fact that explains everything else about a command:
 * the same text field is a shell line for one kind and an English sentence for
 * the other, and the old dialog showed one "Prompt" box with a placeholder that
 * only fitted one of them.
 *
 * Kind is NOT a stored field. It is the same axis as `target`: a prompt can
 * only go to Claude, and a shell line can only go to a shell. Storing it twice
 * would be two fields that must never disagree. The dialog derives it from the
 * target (and from whether this session's main pane is itself a shell) and
 * writes the target back on save.
 */
export type CommandKind = 'prompt' | 'shell'

interface Props {
  onConfirm: (command: Omit<CustomCommand, 'id'>) => void
  onCancel: () => void
  initial?: CustomCommand
  configId?: string
  /**
   * True when the session's MAIN pane is a plain shell (a terminal-only
   * config) rather than Claude. Then "send a prompt to Claude" is not a thing
   * this session can do, and a shell command may run in EITHER pane.
   */
  mainPaneIsShell?: boolean
}

/** Where a shell command runs when the main pane is itself a shell. */
type ShellWhere = 'main' | 'partner'

/** The kind a stored command has, read off its target. */
export function kindOf(cmd: Pick<CustomCommand, 'target'> | undefined, mainPaneIsShell: boolean): CommandKind {
  if (mainPaneIsShell) return 'shell'
  return cmd?.target === 'partner' ? 'shell' : 'prompt'
}

/** The target a (kind, where) pair resolves to. The row IS the target. */
export function targetFor(kind: CommandKind, mainPaneIsShell: boolean, shellWhere: ShellWhere): 'claude' | 'partner' {
  if (kind === 'prompt') return 'claude'
  if (!mainPaneIsShell) return 'partner'
  return shellWhere === 'partner' ? 'partner' : 'claude'
}

/**
 * The exact text the button will type, built by the SAME rule the command bar
 * uses (`prompt + ' ' + args.join(' ')`). Exported so the preview and the
 * bar cannot drift: a preview that showed one thing while the bar typed
 * another would be worse than no preview.
 */
export function previewLine(prompt: string, args: readonly string[]): string {
  const p = prompt.trim()
  if (!p) return ''
  return args.length > 0 ? `${p} ${args.join(' ')}` : p
}

export default function CommandDialog({ onConfirm, onCancel, initial, configId, mainPaneIsShell = false }: Props) {
  const isEdit = !!initial
  // A NEW command starts with no kind chosen and the dialog reveals itself once
  // it is answered; EDIT opens fully revealed with the kind read off the target.
  const [kind, setKind] = useState<CommandKind | null>(initial ? kindOf(initial, mainPaneIsShell) : null)
  const [shellWhere, setShellWhere] = useState<ShellWhere>(initial?.target === 'partner' ? 'partner' : 'main')

  const [label, setLabel] = useState(initial?.label || '')
  const [prompt, setPrompt] = useState(initial?.prompt || '')
  const [scope, setScope] = useState<'global' | 'config'>(initial?.scope || (configId ? 'config' : 'global'))
  const [color, setColor] = useState(initial?.color || COLOR_SWATCHES[0])
  const [defaultArgs, setDefaultArgs] = useState<string[]>(initial?.defaultArgs || [])
  const [argInput, setArgInput] = useState('')
  const [sectionId, setSectionId] = useState<string | undefined>(initial?.sectionId)
  const [newSectionName, setNewSectionName] = useState('')
  const [showNewSection, setShowNewSection] = useState(false)
  const [webViewEnabled, setWebViewEnabled] = useState<boolean>(!!initial?.webView?.enabled)
  const [webViewUrl, setWebViewUrl] = useState(initial?.webView?.url || '')
  const [webViewUrlError, setWebViewUrlError] = useState<string | null>(null)

  const { sections, addSection } = useCommandStore()
  const visibleSections = sections.filter(
    (s) => s.scope === 'global' || (s.scope === 'config' && s.configId === configId)
  )

  const target = kind ? targetFor(kind, mainPaneIsShell, shellWhere) : 'claude'
  // Where the text goes, in words the preview and the run-location line share.
  const destination =
    kind === 'prompt' ? 'Claude'
      : mainPaneIsShell ? (shellWhere === 'partner' ? 'the partner shell' : 'this shell')
        : 'the partner shell'

  const handleAddArg = () => {
    const arg = argInput.trim()
    if (arg && !defaultArgs.includes(arg)) {
      setDefaultArgs([...defaultArgs, arg])
      setArgInput('')
    }
  }

  const handleRemoveArg = (idx: number) => {
    setDefaultArgs(defaultArgs.filter((_, i) => i !== idx))
  }

  const handleArgKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddArg()
    }
  }

  const handleCreateSection = () => {
    const name = newSectionName.trim()
    if (!name) return
    const newSection: CommandSection = {
      id: generateId(),
      name,
      scope,
      configId: scope === 'config' ? configId : undefined,
    }
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
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Unsupported scheme "${parsed.protocol}" -- only http and https are allowed`
    }
    return null
  }

  const canSubmit = !!kind && !!label.trim() && !!prompt.trim()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    if (webViewEnabled) {
      const urlError = validateWebviewUrl(webViewUrl)
      if (urlError) {
        setWebViewUrlError(urlError)
        return
      }
    }
    setWebViewUrlError(null)
    onConfirm({
      label: label.trim(),
      prompt: prompt.trim(),
      scope,
      configId: scope === 'config' ? configId : undefined,
      color,
      target,
      defaultArgs: defaultArgs.length > 0 ? defaultArgs : undefined,
      sectionId,
      webView: webViewEnabled
        ? { enabled: true, url: webViewUrl.trim() }
        : undefined,
    })
  }

  // Copy that follows the kind. One field, two very different things typed
  // into it -- the label, helper and placeholder have to say which.
  const textField = kind === 'shell'
    ? {
        label: 'Command to run',
        helper: 'Typed into the terminal exactly as written, then Enter.',
        placeholder: 'npm test',
        mono: true,
      }
    : {
        label: 'Prompt to send',
        helper: 'Submitted to Claude as if you had typed it and pressed Enter.',
        placeholder: 'Fix all lint errors and run the linter again',
        mono: false,
      }

  const line = previewLine(prompt, defaultArgs)

  const kindCard = (value: CommandKind, title: string, sub: string) => {
    const active = kind === value
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={active}
        data-testid={`command-kind-${value}`}
        onClick={() => setKind(value)}
        className={`flex-1 text-left px-3 py-2 rounded-lg border transition-colors focus-ring ${
          active
            ? 'bg-blue/15 border-blue'
            : 'bg-surface0 border-surface1 hover:border-overlay0'
        }`}
      >
        <div className={`text-sm font-medium ${active ? 'text-blue' : 'text-text'}`}>{title}</div>
        <div className="text-[11px] text-overlay1 leading-snug mt-0.5">{sub}</div>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[440px] max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-text mb-1">
          {isEdit ? 'Edit command button' : 'New command button'}
        </h2>
        <p className="text-xs text-overlay1 mb-4">A button in the command bar that runs something for you.</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Kind FIRST. Everything below depends on the answer. */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">What should it do?</label>
            <div className="flex gap-2" role="radiogroup" aria-label="What the button does">
              {/* A terminal-only session has no Claude to prompt; offering the
                  card would be offering a button that cannot work. */}
              {!mainPaneIsShell && kindCard('prompt', 'Send a prompt', 'to Claude')}
              {kindCard('shell', 'Run a command', 'in a shell')}
            </div>
            {!kind && (
              <p className="mt-1 text-[10px] text-overlay0">
                Changes what the fields below ask for: a shell line is not a sentence, and the other way round.
              </p>
            )}
          </div>

          {kind && (
            <>
              <div>
                <label className="block text-xs text-subtext0 mb-1">Button label</label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
                  placeholder={kind === 'shell' ? 'e.g. Run tests' : 'e.g. Fix lint'}
                  maxLength={20}
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">{textField.label}</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className={`w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue resize-none ${textField.mono ? 'font-mono' : ''}`}
                  rows={kind === 'shell' ? 2 : 3}
                  placeholder={textField.placeholder}
                  data-testid="command-text"
                />
                <p className="mt-1 text-[10px] text-overlay0">{textField.helper}</p>
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">
                  Arguments <span className="text-overlay0">-- optional</span>
                </label>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {defaultArgs.map((arg, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface0 text-text text-xs rounded border border-surface1 font-mono"
                    >
                      {arg}
                      <button
                        type="button"
                        onClick={() => handleRemoveArg(idx)}
                        className="text-overlay0 hover:text-red ml-0.5"
                        aria-label={`Remove argument ${arg}`}
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="1" x2="7" y2="7"/><line x1="7" y1="1" x2="1" y2="7"/></svg>
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={argInput}
                    onChange={(e) => setArgInput(e.target.value)}
                    onKeyDown={handleArgKeyDown}
                    className="flex-1 px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue font-mono"
                    placeholder={kind === 'shell' ? 'e.g. -Port 8080' : 'e.g. --verbose'}
                  />
                  <button
                    type="button"
                    onClick={handleAddArg}
                    disabled={!argInput.trim()}
                    className="px-2 py-1.5 text-xs bg-surface0 text-overlay1 hover:text-text rounded border border-surface1 hover:bg-surface1 disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
                {/* Two things nobody could have known from this dialog. The first
                    is a correctness trap: arguments are concatenated onto the
                    command with single spaces and NOTHING is quoted, so a value
                    containing a space becomes two arguments. The chip UI implies
                    structure that does not exist. The second is a real feature
                    that was taught only by a tip -- which may never have fired. */}
                <p className="mt-1 text-[10px] text-overlay0">
                  Appended after the {kind === 'shell' ? 'command' : 'prompt'}, separated by spaces. Nothing is quoted
                  for you, so an argument containing a space arrives as two.
                </p>
                <p className="mt-1 text-[10px] text-overlay0">
                  <span className="text-subtext0">Ctrl+click the button</span> to change these for one run without editing the command.
                </p>
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">Where it runs</label>
                {kind === 'shell' && mainPaneIsShell ? (
                  <div className="flex gap-2" role="radiogroup" aria-label="Which shell">
                    {([['main', 'This shell'], ['partner', 'Partner shell']] as const).map(([val, lbl]) => (
                      <button
                        key={val}
                        type="button"
                        role="radio"
                        aria-checked={shellWhere === val}
                        onClick={() => setShellWhere(val)}
                        className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
                          shellWhere === val
                            ? 'bg-blue/20 border-blue text-blue'
                            : 'bg-surface0 border-surface1 text-overlay1'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-1.5 text-xs rounded border bg-surface0 border-surface1 text-text" data-testid="command-runs-in">
                    {kind === 'prompt' ? 'The Claude terminal' : 'The partner shell (opened for you if it is closed)'}
                  </div>
                )}
                {/* The retired third option, "Any", ran the button in whichever
                    pane happened to be showing while filing it in the Claude row
                    -- so the row could lie about where a command executed. Gone;
                    the row a button sits in is the row it runs in. */}
                <p className="mt-1 text-[10px] text-overlay0">
                  This is also the row the button appears in, so the bar always says where it runs.
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={webViewEnabled}
                    onChange={(e) => setWebViewEnabled(e.target.checked)}
                    className="accent-blue"
                  />
                  Watch for a page and open the browser when it responds
                </label>
                {webViewEnabled && (
                  <div className="mt-1.5">
                    <input
                      type="url"
                      value={webViewUrl}
                      onChange={(e) => {
                        setWebViewUrl(e.target.value)
                        if (webViewUrlError) setWebViewUrlError(null)
                      }}
                      className={`w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border outline-none font-mono ${
                        webViewUrlError ? 'border-red focus:border-red' : 'border-surface1 focus:border-blue'
                      }`}
                      placeholder="http://localhost:3000"
                      aria-invalid={!!webViewUrlError}
                      aria-describedby={webViewUrlError ? 'webview-url-error' : undefined}
                    />
                    {webViewUrlError ? (
                      <p id="webview-url-error" className="mt-1 text-[10px] text-red">{webViewUrlError}</p>
                    ) : (
                      <p className="mt-1 text-[10px] text-overlay0">
                        The poll starts when the command is SENT, not when it finishes -- which is the point: it is
                        watching for a server that is still starting up. Every second for up to 30 s; the browser
                        button turns green as soon as the page answers, red on timeout.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Item 18: the button, and the exact text it will type. Built by
                  the same rule the command bar uses, so it cannot drift. */}
              <div
                className="rounded-lg border border-surface1 bg-crust/60 px-3 py-2"
                data-testid="command-preview"
                aria-live="polite"
              >
                <div className="text-[10px] uppercase tracking-wide text-overlay0 mb-1.5">Preview</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-md border whitespace-nowrap"
                    style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden />
                    <span data-testid="command-preview-label">{label.trim() || 'Button'}</span>
                  </span>
                  <span className="text-[11px] text-overlay1">
                    {kind === 'prompt' ? 'sends to' : 'types into'} <span className="text-subtext0">{destination}</span>:
                  </span>
                </div>
                <div
                  className="mt-1.5 font-mono text-xs text-text whitespace-pre-wrap break-words"
                  data-testid="command-preview-line"
                >
                  {line ? <>{line} <span className="text-overlay0">{String.fromCodePoint(0x23ce)}</span></> : <span className="text-overlay0">(nothing yet)</span>}
                </div>
                {webViewEnabled && webViewUrl.trim() && (
                  <div className="mt-1 text-[11px] text-overlay1" data-testid="command-preview-watch">
                    then watches <span className="font-mono text-subtext0">{webViewUrl.trim()}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">Scope</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setScope('global')}
                    className={`flex-1 py-1.5 text-xs rounded border ${
                      scope === 'global'
                        ? 'bg-blue/20 border-blue text-blue'
                        : 'bg-surface0 border-surface1 text-overlay1'
                    }`}
                  >
                    Global
                  </button>
                  {configId && (
                    <button
                      type="button"
                      onClick={() => setScope('config')}
                      className={`flex-1 py-1.5 text-xs rounded border ${
                        scope === 'config'
                          ? 'bg-blue/20 border-blue text-blue'
                          : 'bg-surface0 border-surface1 text-overlay1'
                      }`}
                    >
                      This config only
                    </button>
                  )}
                </div>
                {scope === 'global' && (
                  <p className="mt-1 text-[10px] text-overlay0">
                    Appears in every config, with a dashed <span className="font-mono">global</span> mark. Editing or
                    deleting it changes all of them.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">Section</label>
                {!showNewSection ? (
                  <select
                    value={sectionId || ''}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '__new__') {
                        setShowNewSection(true)
                      } else {
                        setSectionId(val || undefined)
                      }
                    }}
                    className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
                  >
                    <option value="">No section</option>
                    {visibleSections.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                    <option value="__new__">+ New section</option>
                  </select>
                ) : (
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newSectionName}
                      onChange={(e) => setNewSectionName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                      className="flex-1 px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
                      placeholder="Section name"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleCreateSection}
                      disabled={!newSectionName.trim()}
                      className="px-2 py-1.5 text-xs bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowNewSection(false); setNewSectionName('') }}
                      className="px-2 py-1.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs text-subtext0 mb-1">Colour</label>
                <div className="flex gap-1.5">
                  {COLOR_SWATCHES.slice(0, 16).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      aria-label={`Colour ${c}`}
                      className={`w-6 h-6 rounded-full border-2 transition-all ${
                        color === c ? 'border-text scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="command-submit"
              className="px-4 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
            >
              {isEdit ? 'Save' : 'Create button'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
