/**
 * DesktopImportDialog.tsx — import a Claude desktop chat into a session that is
 * ALREADY RUNNING (#209).
 *
 * This is the primary entry point for the feature: most of the time the session
 * you want the chat in is already open, with its working directory, account,
 * model and git state settled. Nothing about a launch is involved — the brief is
 * written into the session's working directory and a prompt is typed into the
 * live prompt, exactly the way a screenshot attachment already does it
 * (`utils/imageTransfer.ts`).
 *
 * The capture + brief UI is the SAME component the New Session dialog embeds, so
 * the two entry points can never drift apart.
 */

import React, { useState } from 'react'
import { DesktopImportTab } from './SessionDialog/DesktopImportTab'
import { buildInjectPrompt, type WrittenBrief } from '../../shared/desktop-import'
import type { Session } from '../stores/sessionStore'

interface Props {
  session: Session
  onClose: () => void
}

export default function DesktopImportDialog({ session, onClose }: Props) {
  const [written, setWritten] = useState<WrittenBrief | null>(null)
  const [error, setError] = useState('')

  const sessionName = session.customName?.trim() || session.label

  const send = (): void => {
    if (!written) return
    const prompt = buildInjectPrompt(written.path)
    if (!prompt) {
      // Only reachable if the resolved path carries a control character. Refusing
      // beats sending a mangled path the session would fail to read.
      setError(`The brief path cannot be sent as a prompt: ${written.path}`)
      return
    }
    // NO trailing '\r'. The screenshot-attachment path auto-submits because its
    // payload is a file the user just captured themselves; this payload is
    // derived from text CCC did not author. Typing it WITHOUT submitting puts a
    // human between an imported brief and an agent that can run commands: the
    // prompt lands in the input box, the operator reads it, and presses Enter.
    // Together with the forced `plan` mode on a primed launch, that is the
    // difference between a boundary and a banner asking a model to behave.
    window.electronAPI.pty.write(session.id, prompt)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface0 rounded-lg p-6 w-[720px] max-h-[90vh] overflow-y-auto shadow-2xl border border-surface1">
        <h3 className="text-base font-semibold text-text mb-1">Import a Claude desktop chat</h3>
        <p className="text-[11px] text-overlay0 mb-4 leading-snug">
          Into the running session <span className="text-text">{sessionName}</span>. The brief is written
          into that session&apos;s working directory and sent as its next prompt.
        </p>

        {session.status === 'working' && (
          <div className="mb-4 rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-[11px] text-yellow">
            This session is mid-turn. The prompt will queue behind whatever it is doing — wait for it to
            finish if you want the brief read first.
          </div>
        )}

        <DesktopImportTab
          workingDirectory={session.workingDirectory}
          written={written}
          onWritten={(w) => { setWritten(w); setError('') }}
          target="running-session"
          profileId={session.profileId}
        />

        {error && (
          <div className="mt-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-[11px] text-red">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!written}
            onClick={send}
            className="px-4 py-1.5 rounded text-sm bg-blue text-crust font-medium hover:bg-blue/90 disabled:opacity-40 transition-colors"
          >
            Send to session
          </button>
        </div>

        <div className="text-[10px] text-overlay0 mt-2 text-right">
          The prompt is typed into the session but not submitted — read it, then press Enter there.
        </div>
      </div>
    </div>
  )
}
