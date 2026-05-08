import { useEffect, useState } from 'react'
import type { CodexReviewUsageRecord } from '../../shared/types'

/** Subscribe a single Claude session's Codex review usage record.
 *  Returns null when sessionId is null/undefined OR when the session
 *  hasn't recorded any reviews yet. Updates pushed via IPC. */
export function useCodexReviewUsage(sessionId: string | null): CodexReviewUsageRecord | null {
  const [record, setRecord] = useState<CodexReviewUsageRecord | null>(null)

  useEffect(() => {
    if (!sessionId) { setRecord(null); return }

    let active = true
    window.electronAPI.codexReview
      .getUsage(sessionId)
      .then((r) => { if (active) setRecord(r) })
      .catch(() => { /* IPC can reject during teardown */ })

    const off = window.electronAPI.codexReview.onUsageUpdated(({ sessionId: id, record: r }) => {
      if (active && id === sessionId) setRecord(r)
    })

    return () => {
      active = false
      off()
    }
  }, [sessionId])

  return record
}
