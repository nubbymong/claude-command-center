import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function CISection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="ci" title="CI / Actions" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
