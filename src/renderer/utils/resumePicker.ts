// Track sessions that should use the resume picker (restored local sessions)
const resumePickerSessionIds = new Set<string>()

export function markSessionForResumePicker(sessionId: string) {
  resumePickerSessionIds.add(sessionId)
}

export function shouldUseResumePicker(sessionId: string): boolean {
  if (resumePickerSessionIds.has(sessionId)) {
    resumePickerSessionIds.delete(sessionId)
    return true
  }
  return false
}
