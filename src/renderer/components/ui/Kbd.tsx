import React from 'react'
export function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily:"'JetBrains Mono', monospace", fontSize:10, padding:'2px 7px', borderRadius:6, background:'color-mix(in srgb, var(--text-muted) 15%, transparent)', color:'var(--text-secondary)' }}>{children}</span>
}
