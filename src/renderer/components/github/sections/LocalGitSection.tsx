import SectionFrame from '../SectionFrame'

interface Props {
  sessionId: string
}

export default function LocalGitSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
