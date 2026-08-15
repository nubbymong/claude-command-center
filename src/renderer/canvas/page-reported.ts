// One wording for "the page under review said this, and the app cannot check
// it" — used wherever page-supplied identity or page-asserted re-anchoring is
// shown to the reviewer.
//
// The review loop's whole job is to tell a person whether the artifact in front
// of them does what it claims. Every label on a locked element, and every
// "re-anchored" on the resolution checklist, is assembled BY THAT ARTIFACT: the
// host asks the frame what is at a point, or whether an anchor still resolves,
// and the frame answers whatever it likes. Presenting those answers in the
// app's own voice let a page mark its reviewer's open issues as tracked while
// pointing the highlight anywhere it chose (adversarial review, 2026-08-14).
//
// The marker is short because it sits inside dense chrome; the title carries
// the sentence.

/** Visible marker. Kept lowercase and unpunctuated so it reads as a source
 *  attribution rather than as a warning the user must act on. */
export const PAGE_REPORTED_MARK = 'page-reported'

/** Tooltip for anything carrying the marker. */
export const PAGE_REPORTED_TITLE =
  'Reported by the page under review. The app cannot verify it — treat it as the page’s claim about itself.'
