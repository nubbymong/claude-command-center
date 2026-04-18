import type {
  SessionContextResult,
  ToolCallFileSignal,
  TranscriptReference,
} from '../../../shared/github-types'
import { BRANCH_ISSUE_REGEXES } from '../../../shared/github-constants'

/**
 * Extracts an issue number from a branch name using the patterns from
 * spec §6. Returns the first match, or null when no pattern matches.
 * Common matches: `fix-247-login`, `feat/99-xyz`, `100-x`, `issue/42`.
 */
export function extractBranchIssueNumber(branchName: string): number | null {
  for (const re of BRANCH_ISSUE_REGEXES) {
    const m = branchName.match(re)
    if (m) return Number(m[1])
  }
  return null
}

export interface BuildContextInput {
  branchName: string | undefined
  transcriptRefs: TranscriptReference[]
  prBodyRefs: number[]
  recentFiles: ToolCallFileSignal[]
  sessionRepo: string | undefined
  /**
   * Fetches issue metadata for display. May throw / return null — the
   * primary issue number will still be surfaced without enrichment if this
   * fails (e.g. no access, rate-limited).
   */
  enrichIssue: (
    repo: string,
    issueNumber: number,
  ) => Promise<
    { title?: string; state?: 'open' | 'closed'; assignee?: string } | null
  >
  activePR?: { number: number; state: 'open' | 'closed' | 'merged'; draft: boolean }
}

/**
 * Combines session signals into a single `SessionContextResult` per the
 * priority algorithm in spec §6.1:
 *
 *   1. Branch-name issue match (highest)
 *   2. Most-recent transcript-referenced issue
 *   3. First PR-body-referenced issue
 *
 * Non-winning references fall into `otherSignals` so the UI can show
 * "Possibly related: #2, #3".
 */
export async function buildSessionContext(
  input: BuildContextInput,
): Promise<SessionContextResult> {
  const branchNum = input.branchName ? extractBranchIssueNumber(input.branchName) : null

  const transcriptNum =
    input.transcriptRefs.length > 0
      ? input.transcriptRefs[input.transcriptRefs.length - 1].number
      : null

  const prBodyNum = input.prBodyRefs[0] ?? null

  const primaryNum = branchNum ?? transcriptNum ?? prBodyNum

  const otherSignals: SessionContextResult['otherSignals'] = []
  if (branchNum !== null && branchNum !== primaryNum) {
    otherSignals.push({ source: 'branch', number: branchNum })
  }
  for (const t of input.transcriptRefs) {
    if (t.number !== primaryNum) {
      otherSignals.push({ source: 'transcript', number: t.number, repo: t.repo })
    }
  }
  for (const n of input.prBodyRefs) {
    if (n !== primaryNum) {
      otherSignals.push({ source: 'pr-body', number: n })
    }
  }

  let primaryIssue: SessionContextResult['primaryIssue']
  if (primaryNum !== null && input.sessionRepo) {
    const enriched = await input.enrichIssue(input.sessionRepo, primaryNum).catch(() => null)
    primaryIssue = {
      number: primaryNum,
      repo: input.sessionRepo,
      ...(enriched ?? {}),
    }
  } else if (primaryNum !== null) {
    primaryIssue = { number: primaryNum }
  }

  return {
    primaryIssue,
    otherSignals,
    recentFiles: input.recentFiles,
    activePR: input.activePR,
  }
}
