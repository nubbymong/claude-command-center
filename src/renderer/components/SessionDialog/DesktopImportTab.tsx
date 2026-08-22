/**
 * DesktopImportTab.tsx — capture a Claude desktop conversation and turn it into a
 * handoff brief for the session about to be created (#209).
 *
 * Two capture paths, in the order they are worth trying:
 *   Paste       — always works, no auth, no network. This is the primary path.
 *   Share link  — https://claude.ai/share/<uuid>, publicly shared conversations.
 *
 * There is deliberately NO embedded claude.ai sign-in. That window loads no
 * browser extensions, so an environment whose compliance policy mandates an SSO
 * plugin can never complete a login in it — the page simply spins. Acquiring a
 * claude.ai web session is #216's job, through a handoff to the real system
 * browser, and there should be exactly one auth flow rather than two.
 *
 * The panel owns capture -> preview -> brief -> written file, then hands the
 * written path up. It deliberately does NOT create the session; the dialog does
 * that on submit, so the working directory, label, model, and everything else the
 * user set still apply.
 */

import React, { useState } from 'react'
import type {
  GeneratedBrief,
  ParsedTranscript,
  WrittenBrief,
} from '../../../shared/desktop-import'

type Mode = 'paste' | 'share'

interface Props {
  /** The working directory the brief will be written into. */
  workingDirectory: string
  /** Set when a brief has already been written for this dialog session. */
  written: WrittenBrief | null
  onWritten: (w: WrittenBrief | null) => void
  /**
   * Which entry point is hosting the panel. Only the two lines that describe
   * what happens NEXT differ — the capture and brief steps are identical, which
   * is the point of sharing this component between them.
   */
  target?: 'new-session' | 'running-session'
  /**
   * The account whose signed-in claude.ai session the share fetch should use
   * (#216). When set, an ORG-SCOPED share resolves as that member; undefined (the
   * default account) means public shares only. Drives the share-tab guidance too.
   */
  profileId?: string
}

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'paste', label: 'Paste', hint: 'Copy the chat in the Claude desktop app and paste it here.' },
  { id: 'share', label: 'Share link', hint: 'Paste a https://claude.ai/share/… link. Publicly shared conversations only, for now.' },
]

export function DesktopImportTab({ workingDirectory, written, onWritten, target = 'new-session', profileId }: Props) {
  const [mode, setMode] = useState<Mode>('paste')
  const [pasteText, setPasteText] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [transcript, setTranscript] = useState<ParsedTranscript | null>(null)
  const [brief, setBrief] = useState<GeneratedBrief | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const api = window.electronAPI.desktopImport
  const dirReady = workingDirectory.trim().length > 0

  const reset = (): void => {
    setTranscript(null)
    setBrief(null)
    onWritten(null)
    setError('')
  }

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(what)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError((err as Error)?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  const capturePaste = () =>
    run('Parsing…', async () => {
      reset()
      const res = await api.parsePaste(pasteText)
      if (!res.ok) { setError(res.error); return }
      setTranscript(res.transcript)
    })

  const captureShare = () =>
    run('Fetching…', async () => {
      reset()
      // #216: pass the account so an org-scoped share resolves on that member's
      // signed-in claude.ai session. Undefined (default account) => public only.
      const res = await api.fromShare(shareUrl.trim(), profileId)
      if (!res.ok) { setError(res.error); return }
      setTranscript(res.transcript)
    })

  const makeBrief = () =>
    run('Summarising…', async () => {
      if (!transcript) return
      setBrief(null)
      onWritten(null)
      const res = await api.buildBrief({ transcript })
      if (!res.ok) { setError(res.error); return }
      setBrief(res.brief)
    })

  const saveBrief = () =>
    run('Writing the brief…', async () => {
      if (!brief) return
      const res = await api.writeBrief({ workingDirectory, markdown: brief.markdown })
      if (!res.ok) { setError(res.error); return }
      onWritten(res.written)
    })

  const activeHint = MODES.find((m) => m.id === mode)?.hint ?? ''

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-overlay0 leading-snug">
        CCC distils the conversation into a short handoff brief — goal, decisions, constraints, next steps —
        {target === 'new-session'
          ? ' and the new session opens by reading that brief,'
          : ' and sends the session a prompt to read it,'}
        {' '}rather than replaying the whole chat into the context window.
      </p>

      {!dirReady && (
        <div className="rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-[11px] text-yellow">
          {target === 'new-session'
            ? 'Set the working directory first (left column).'
            : 'This session has no working directory set.'}
          {' '}The brief is written into <code className="mx-1">.claude/imports/</code> inside it.
        </div>
      )}

      {/* Capture mode */}
      <div className="flex items-center bg-crust rounded-md p-0.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => { setMode(m.id); reset() }}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              mode === m.id ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-overlay0 -mt-2">{activeHint}</p>

      {mode === 'paste' && (
        <div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={10}
            placeholder={'Paste the conversation here.\n\nRole markers like "Human:" / "Claude:" are used when present; without them the whole paste is treated as one block.'}
            className="w-full bg-base border border-surface1 rounded px-3 py-2 text-xs text-text placeholder:text-overlay0 font-mono focus:outline-none focus:border-blue"
          />
          <button
            type="button"
            disabled={!pasteText.trim() || !!busy}
            onClick={capturePaste}
            className="mt-2 px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 disabled:opacity-40 transition-colors"
          >
            Read the paste
          </button>
        </div>
      )}

      {mode === 'share' && (
        <div className="space-y-2">
        <div className="rounded border border-surface1 bg-mantle px-3 py-2 text-[11px] text-subtext0 leading-snug">
          A <span className="text-text">publicly</span> shared link works straight away.{' '}
          {profileId ? (
            <>
              An <span className="text-text">organisation-scoped</span> share works too when this account is
              signed in to claude.ai — if the fetch reports a sign-in page, authenticate this account
              (right-click the session → <span className="text-text">Authenticate claude.ai</span>) and retry.
            </>
          ) : (
            <>
              An organisation-scoped share needs a signed-in account; the default account cannot hold a
              claude.ai session, so use the <span className="text-text">Paste</span> tab for those — copy the
              conversation out of the Claude desktop app and paste it here. No sign-in needed.
            </>
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={shareUrl}
            onChange={(e) => setShareUrl(e.target.value)}
            placeholder="https://claude.ai/share/…"
            className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
          />
          <button
            type="button"
            disabled={!shareUrl.trim() || !!busy}
            onClick={captureShare}
            className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 disabled:opacity-40 transition-colors"
          >
            Fetch
          </button>
        </div>
        </div>
      )}

      {busy && <div className="text-[11px] text-blue">{busy}</div>}
      {error && (
        <div className="rounded border border-red/40 bg-red/10 px-3 py-2 text-[11px] text-red whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Captured */}
      {transcript && (
        <div className="rounded border border-surface1 bg-mantle px-3 py-2 space-y-1">
          <div className="text-xs text-text">
            Captured {transcript.messageCount} message{transcript.messageCount === 1 ? '' : 's'} ·{' '}
            {transcript.codeBlockCount} code block{transcript.codeBlockCount === 1 ? '' : 's'} ·{' '}
            {transcript.charCount.toLocaleString()} chars
            {transcript.title ? ` · "${transcript.title}"` : ''}
          </div>
          {!transcript.roleMarkersDetected && (
            <div className="text-[10px] text-yellow">
              No role markers found — the paste was kept as one block. The brief still works, it just cannot
              tell who said what.
            </div>
          )}
          {transcript.truncated && (
            <div className="text-[10px] text-yellow">Capture hit the size limit and was truncated.</div>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={makeBrief}
            className="mt-1 px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 disabled:opacity-40 transition-colors"
          >
            {brief ? 'Regenerate brief' : 'Generate the brief'}
          </button>
        </div>
      )}

      {/* Brief */}
      {brief && (
        <div className="space-y-2">
          <div className="text-[10px] text-overlay0">
            {brief.mode === 'llm'
              ? 'Summarised by a headless Claude pass.'
              : `Mechanical extract — the summariser was unavailable (${brief.fallbackReason ?? 'unknown reason'}).`}
          </div>
          <pre className="max-h-64 overflow-y-auto rounded border border-surface1 bg-base px-3 py-2 text-[11px] text-subtext0 whitespace-pre-wrap font-mono">
            {brief.markdown}
          </pre>
          <button
            type="button"
            disabled={!dirReady || !!busy}
            onClick={saveBrief}
            className="px-3 py-1.5 rounded text-xs bg-green text-crust font-medium hover:bg-green/90 disabled:opacity-40 transition-colors"
          >
            Use this brief
          </button>
        </div>
      )}

      {written && (
        <div className="rounded border border-green/40 bg-green/10 px-3 py-2 text-[11px] text-green">
          Brief saved to <code>{written.relativePath}</code>.{' '}
          {target === 'new-session'
            ? 'Create the config below — the first session it launches will open by reading it.'
            : 'Send it to the session below.'}
        </div>
      )}
    </div>
  )
}
