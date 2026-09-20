// WP1 provider core, shared layer: provider-neutral ids, capability
// descriptors, data contracts, the session-binding shape check and the realm
// environment patch. Imported by main core, renderer core and the concrete
// provider packages; imports no concrete provider itself (enforced by
// tests/wp1/dependency-boundaries.test.ts).
export * from './ids'
export * from './capabilities'
export * from './model'
export * from './binding'
export * from './realm-env'
