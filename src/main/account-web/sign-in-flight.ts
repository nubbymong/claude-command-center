/**
 * sign-in-flight.ts: one web sign-in at a time ACROSS services (P4.6, row 58).
 *
 * Claude's claude.ai sign-in (sign-in.ts) has always run one at a time across
 * all its accounts. A Codex account's chatgpt.com sign-in (codex-web-session.ts)
 * joins that rule: while either service's sign-in is in flight, the other's is
 * refused. Each service registers a probe of its own state here; neither
 * module imports the other (sign-in.ts keeps its narrow module graph).
 *
 * Zero dependencies. No default export (project convention).
 */

const probes = new Map<string, () => boolean>()

/** Register (or replace) a service's "is a sign-in in flight" probe. */
export function registerSignInFlight(service: string, inFlight: () => boolean): void {
  probes.set(service, inFlight)
}

/** True while any OTHER service's sign-in is in flight. A probe that throws
 *  counts as in flight (fail closed: never two sign-ins at once). */
export function signInInFlightElsewhere(service: string): boolean {
  for (const [name, probe] of probes) {
    if (name === service) continue
    try { if (probe()) return true } catch { return true }
  }
  return false
}
