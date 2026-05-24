import React from 'react'
export function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily:"'JetBrains Mono', monospace", fontSize:10, padding:'2px 7px', borderRadius:6, background:'rgba(255,255,255,.06)', color:'var(--text-secondary)' }}>{children}</span>
}
