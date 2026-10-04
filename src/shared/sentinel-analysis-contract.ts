// PR 4 (owner answers, the Sentinel chase): what an analysis runner's failure
// message says when its assistant never reached its service. The runners
// that say it and Sentinel's check that reads it share this one source, so a
// reworded message cannot quietly turn a prompt report back into a second
// attempt.

/** The words a runner's failure message carries when its assistant never
 *  reached its service. Sentinel then reports the failure as unreachable and
 *  does not try the analysis again. */
export const ANALYSIS_UNREACHABLE_WORDS = 'could not reach'
