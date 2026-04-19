import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function ReviewsSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="reviews" title="Reviews & Comments" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
