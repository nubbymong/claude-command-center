// What a surface says when a check did not find a tool its publisher's
// installer put in its own folder (main's path hint; ADR-024). Shown on the
// first-run setup screen, the assistant setup pages, Settings, Accounts and
// the footer's CLI help, the same everywhere.
//
//   - Windows, `add-to-path`: the tool is installed in that folder, which is
//     not on PATH yet. "Add it to PATH for me" (the commit, primary) asks
//     main to add that one folder; main computes the folder itself, and this
//     sends only the provider id. "Not now" leaves PATH as it is and says
//     what that means and how to do it by hand; the surface's own ways on
//     (Check again, Back and the rest) stay.
//   - macOS and Linux, `shell-profile`: the shell file the login shell reads
//     and the exact line to add, with Copy. The app never edits that file.
//   - `restart`: the only place the app advises quitting and starting again.
//
// The buttons follow BUTTON_RULE (InstallRecipeList.tsx): Not now, then Add
// it to PATH for me, right-aligned, small, the commit the only primary.
import { useEffect, useRef, useState } from 'react'
import type { PathHintView, ProviderId } from '../../shared/providers'
import { DialogButton, DialogCallout } from '../components/ui/Dialog'
import { providerAccountActions } from '../stores/providerAccountsStore'

/** Where a user adds a folder to PATH by hand on Windows. */
const BY_HAND = 'in Windows, search for "Edit environment variables for your account", open Path and add it with New'

export function pathHintText(hint: PathHintView, toolName: string): string {
  switch (hint.kind) {
    case 'add-to-path':
      return `${toolName} is installed in ${hint.folder}, but that folder is not on your PATH yet, so this app and your terminals cannot find it. Add it to PATH for me adds that one folder to the end of your PATH for your Windows account; nothing else in it changes.`
    case 'shell-profile':
      return `${toolName} is installed in ${hint.folder}, but the PATH your login shell builds does not include that folder, so this app cannot find it. Add this line to ${hint.file}, then press Check again. The app does not change that file.`
    case 'restart':
      return `${toolName} is in a folder that your PATH in Windows names, but this app could not pick that folder up while it runs. Quit AI Code Conductor and start it again so it starts with that PATH.`
  }
}

/** Where the footer's CLI help says the app looks for Claude Code, and what
 *  it does when Anthropic's installer left it off PATH. */
export function cliHelpLooksText(platform: string | undefined): string {
  return platform === 'win32'
    ? 'Press Check again. The app looks in the folders on your PATH, including any added since it started, and in %USERPROFILE%\\.local\\bin, where Anthropic\'s installer puts Claude Code. If it is there but that folder is not on your PATH, the app offers to add it.'
    : 'Press Check again. The app asks your login shell for claude, and looks in ~/.local/bin, where Anthropic\'s installer puts it. If it is there but your login shell\'s PATH does not include that folder, the app shows the line to add.'
}

/** After Not now: PATH is unchanged, and how to add the folder by hand. */
export function notNowText(folder: string, toolName: string): string {
  return `Your PATH was not changed, so ${toolName} cannot be used from this app yet. To use it, add ${folder} to your PATH yourself (${BY_HAND}), then press Check again. Or add it here.`
}

export function PathHintNotice({ hint, toolName, providerId, testIdPrefix: P, onAdded }: {
  hint: PathHintView
  toolName: string
  providerId: ProviderId
  testIdPrefix: string
  /** The folder was added (or was there already) and main checked again:
   *  the hint that check left, if any. */
  onAdded?: (after: { pathHint?: PathHintView }) => void
}) {
  const [phase, setPhase] = useState<'offer' | 'adding' | 'declined'>('offer')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const live = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const add = async () => {
    setPhase('adding')
    setError(null)
    const r = await providerAccountActions.addToPath(providerId)
    if (!live.current) return
    setPhase('offer')
    if (!r.ok) { setError(r.message); return }
    onAdded?.({ ...(r.pathHint ? { pathHint: r.pathHint } : {}) })
  }

  if (hint.kind === 'restart') {
    return (
      <DialogCallout tone="warning" role="status" testId={`${P}-path-restart`}>
        {pathHintText(hint, toolName)}
      </DialogCallout>
    )
  }

  if (hint.kind === 'shell-profile') {
    const copy = () => {
      void navigator.clipboard?.writeText(hint.line).then(() => {
        if (!live.current) return
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => { timer.current = null; setCopied(false) }, 1500)
      }).catch(() => { /* clipboard blocked: the line is selectable */ })
    }
    return (
      <DialogCallout tone="warning" role="status" testId={`${P}-path-hint`}>
        <p data-testid={`${P}-path-hint-text`}>{pathHintText(hint, toolName)}</p>
        <div className="flex items-center gap-2 mt-2">
          <code
            className="flex-1 min-w-0 px-2 py-1 rounded border font-mono text-[11.5px] select-all"
            style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}
            data-testid={`${P}-path-line`}
          >
            {hint.line}
          </code>
          <DialogButton variant="secondary" className="shrink-0" onClick={copy} testId={`${P}-path-copy`}>
            {copied ? 'Copied' : 'Copy'}
          </DialogButton>
        </div>
      </DialogCallout>
    )
  }

  const adding = phase === 'adding'
  const addButton = (variant: 'primary' | 'secondary') => (
    <DialogButton variant={variant} onClick={() => { void add() }} disabled={adding} testId={`${P}-path-add`}>
      {adding ? 'Adding…' : 'Add it to PATH for me'}
    </DialogButton>
  )
  return (
    <DialogCallout tone="warning" role="status" testId={`${P}-path-hint`}>
      <p data-testid={`${P}-path-hint-text`}>
        {phase === 'declined' ? notNowText(hint.folder, toolName) : pathHintText(hint, toolName)}
      </p>
      {error && (
        <p className="mt-1.5" style={{ color: 'var(--status-danger)' }} data-testid={`${P}-path-error`}>
          {error} You can add {hint.folder} to your PATH yourself ({BY_HAND}), then press Check again.
        </p>
      )}
      <div className="flex items-center justify-end gap-2 mt-2">
        {phase === 'declined' ? addButton('secondary') : (
          <>
            <DialogButton variant="secondary" onClick={() => { setError(null); setPhase('declined') }} disabled={adding} testId={`${P}-path-not-now`}>
              Not now
            </DialogButton>
            {addButton('primary')}
          </>
        )}
      </div>
    </DialogCallout>
  )
}
