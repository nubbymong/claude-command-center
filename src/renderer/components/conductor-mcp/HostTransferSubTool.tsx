import React from 'react'
import SubToolCard from './SubToolCard'

const transferIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

export default function HostTransferSubTool() {
  return (
    <SubToolCard
      title="Host transfer"
      icon={transferIcon}
      statusLabel="Available"
      statusColor="green"
      description="Used by snap, storyboard, and clipboard paste over SSH to ferry images from the host into the session."
      toolList={['fetch_host_screenshot']}
    />
  )
}
