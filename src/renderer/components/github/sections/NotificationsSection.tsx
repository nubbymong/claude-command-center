import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function NotificationsSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="notifications" title="Notifications" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
