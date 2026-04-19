import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function AgentIntentSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="agentIntent" title="Agent Intent" emptyIndicator>
      <div className="text-xs text-overlay0 italic">
        Deferred — activates with HTTP Hooks Gateway
      </div>
    </SectionFrame>
  )
}
