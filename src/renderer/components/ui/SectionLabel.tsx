import React from 'react'
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize:9.5, letterSpacing:'.12em', textTransform:'uppercase', fontWeight:700, color:'var(--text-muted)', marginBottom:9 }}>{children}</div>
}
