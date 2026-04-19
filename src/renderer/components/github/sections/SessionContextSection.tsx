import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function SessionContextSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="sessionContext" title="Session Context" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
