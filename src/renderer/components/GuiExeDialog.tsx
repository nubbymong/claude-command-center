/**
 * "This program will paint over the terminal" — the warning a command button
 * shows when its target is a GUI-subsystem exe (#379).
 *
 * The choice is real, not rhetorical, so both answers are offered plainly:
 * capture the log (the program runs from the console-less main process and its
 * output appears in a panel) or run it in the terminal anyway (the old
 * behaviour, bleed and all — which is what you want if the tool's own GUI is the
 * point, or you want to watch it live).
 *
 * House rules followed here: no `onClick` on the backdrop (Ctrl+C fires click
 * events — see .github/copilot-instructions.md), Escape cancels, the panel
 * carries the dialog role, and the recommended action is autofocused.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { shellOperatorsIn } from '../../shared/gui-exe'

export interface GuiExeDialogProps {
  /** The button's label, for the title. */
  label: string
  /** The command line that would be typed. */
  command: string
  /** The absolute path the first token resolved to. */
  exePath: string
  onChoose: (choice: 'capture' | 'terminal', remember: boolean) => void
  onCancel: () => void
}

export default function GuiExeDialog({ label, command, exePath, onChoose, onCancel }: GuiExeDialogProps) {
  const [remember, setRemember] = useState(false)
  const captureRef = useRef<HTMLButtonElement>(null)
  // Capturing runs the program directly, with no shell, so anything the shell
  // would have interpreted becomes a literal argument. Say which ones (MAJOR-5).
  const operators = useMemo(() => shellOperatorsIn(command), [command])

  useEffect(() => {
    captureRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const choose = (choice: 'capture' | 'terminal') => onChoose(choice, remember)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--color-base) 80%, transparent)' }}
      data-ux-id="gui-exe-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gui-exe-title"
        data-ux-id="gui-exe-dialog"
        className="bg-[var(--surface-raised)] border border-[var(--border-subtle)] rounded-lg shadow-2xl p-6 max-w-md w-full mx-4"
      >
        <h2 id="gui-exe-title" className="text-lg font-semibold text-[var(--text-primary)] mb-2">
          {label} is a Windows GUI program
        </h2>
        <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
          Programs like this one print by attaching to whatever console started them — this
          terminal. Their output goes straight to the screen, over the top of whatever is
          drawn here, and it cannot be redirected or captured from inside the terminal.
        </p>
        <p className="text-xs mb-3 font-mono break-all" style={{ color: 'var(--text-muted)' }}>
          {exePath}
        </p>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
          Capturing runs it from the app instead, where there is no console to attach to, so its
          output can be shown to you. Any window the program opens still appears either way.
        </p>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }} data-ux-id="gui-exe-noshell">
          Captured runs start the program directly, without a shell.
          {operators.length > 0 ? (
            <>
              {' '}This line uses{' '}
              <span className="font-mono text-[var(--status-warning)]">{operators.join(' ')}</span>
              , which {operators.length === 1 ? 'will be passed through as a literal argument' : 'will be passed through as literal arguments'} rather than
              interpreted — so it will not do the same thing as running it in the terminal.
            </>
          ) : (
            <> Redirects and operators like <span className="font-mono">&gt;</span>,{' '}
            <span className="font-mono">|</span>, <span className="font-mono">&amp;&amp;</span> and{' '}
            <span className="font-mono">;</span> would be passed through as literal arguments.</>
          )}
        </p>

        <label className="flex items-center gap-2 mb-4 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-ux-id="gui-exe-remember"
            className="accent-[var(--brand)]"
          />
          Remember this choice for this button
        </label>

        <div className="flex flex-col gap-2">
          <button
            ref={captureRef}
            type="button"
            onClick={() => choose('capture')}
            data-ux-id="gui-exe-capture"
            className="w-full py-2 px-4 text-sm font-medium rounded bg-[var(--brand)] hover:brightness-110 text-[var(--text-on-brand)] transition-colors focus-ring"
          >
            Capture the output
          </button>
          <button
            type="button"
            onClick={() => choose('terminal')}
            data-ux-id="gui-exe-terminal"
            className="w-full py-2 px-4 text-sm font-medium rounded bg-[var(--surface-overlay)] hover:bg-[var(--surface-raised)] text-[var(--text-primary)] transition-colors focus-ring"
          >
            Run in the terminal anyway
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-ux-id="gui-exe-cancel"
            className="w-full py-1.5 px-4 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring"
          >
            Cancel
          </button>
        </div>

        <p className="mt-3 text-[11px] font-mono break-all" style={{ color: 'var(--text-muted)' }}>
          {command}
        </p>
      </div>
    </div>
  )
}
