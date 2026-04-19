import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function IssuesSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="issues" title="Issues" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
