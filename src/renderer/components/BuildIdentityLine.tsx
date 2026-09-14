// Settings → About: the build identity line (#384) —
// "v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22". The SAME string the
// boot splash prints (both go through shared/build-identity.ts from the same
// build-time defines), so a screenshot of either names the build exactly.
// Small, muted, selectable so it can be copied into a bug report.
import React from 'react'
import { formatBuildIdentity } from '../../shared/build-identity'

declare const __APP_VERSION__: string
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

/** The line for THIS build, from the esbuild defines (safe when absent: dev/tests). */
export function currentBuildIdentity(): string {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  const sha = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : undefined
  const buildTime = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : undefined
  return formatBuildIdentity({ version, sha, buildTime })
}

export function BuildIdentityLine({ className = '' }: { className?: string }) {
  return (
    <div
      data-testid="build-identity-line"
      className={`text-[11px] font-mono tabular-nums select-text ${className}`}
      style={{ color: 'var(--text-muted)' }}
      title="Build identity (also shown on the splash screen)"
    >
      {currentBuildIdentity()}
    </div>
  )
}
