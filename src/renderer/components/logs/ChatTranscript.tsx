// src/renderer/components/logs/ChatTranscript.tsx
//
// CONTAINER for Layout C. It instantiates the GB-safe windowing hook EXACTLY
// ONCE for a scope and renders the presentational <ChatTranscriptView/> with the
// hook's outputs. All scroll DOM, sentinels and rendering live in the view.
//
// Why split: a shared hook must be a SINGLE instance. Earlier this component
// always called useWindowedTurns(scope) even when an external instance was
// passed, which double-mounted the hook (a second readMessages('tail') + a
// second onNewMessages subscription + a divergent window). T14/T15 share one
// useWindowedTurns and render <ChatTranscriptView {...sharedWin}/> directly, so
// the rail and the transcript drive ONE window. This container is the
// convenience wrapper for the standalone (own-its-window) case.
import { useWindowedTurns, type Logs2Scope } from '../../hooks/useWindowedTurns'
import ChatTranscriptView from './ChatTranscriptView'

export interface ChatTranscriptProps {
  scope: Logs2Scope
  className?: string
}

export function ChatTranscript({ scope, className }: ChatTranscriptProps) {
  const win = useWindowedTurns(scope)
  return (
    <ChatTranscriptView
      messages={win.messages}
      follow={win.follow}
      setFollow={win.setFollow}
      loading={win.loading}
      loadingOlder={win.loadingOlder}
      error={win.error}
      loadOlder={win.loadOlder}
      prependToken={win.prependToken}
      jumpTarget={win.jumpTarget}
      className={className}
    />
  )
}

export default ChatTranscript
