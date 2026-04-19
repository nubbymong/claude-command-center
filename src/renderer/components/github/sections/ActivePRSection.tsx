import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function ActivePRSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
