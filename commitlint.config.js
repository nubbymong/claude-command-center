// Conventional Commits enforcement (commitlint).
//
// Applied two ways:
//   - locally via the .husky/commit-msg hook (blocks a bad `git commit`)
//   - in CI via .github/workflows/pr-title.yml (checks the PR *title*, which
//     becomes the squash-merge commit subject)
//
// Kept deliberately close to the project's existing habits so enforcement
// documents reality rather than fighting it.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes its own titles, and when `commit-message.prefix` is set to
  // something it does not recognise as a Conventional type (`deps`, per
  // .github/dependabot.yml) it capitalises the description: `deps: Bump x from a
  // to b`. That trips config-conventional's `subject-case` rule, so EVERY npm
  // bump opened here fails the PR Title check on arrival and has to be retitled
  // by hand before it can merge — five at a time, every week (#302-#306).
  //
  // Exempt exactly that generated shape and nothing else. Deliberately anchored
  // and fully specified (`from X to Y`) rather than a loose /^deps:/ match, so a
  // hand-written `deps:` subject is still held to every rule a human commit is.
  // The github-actions ecosystem needs no exemption: it runs with no custom
  // prefix, so Dependabot emits `build(deps): bump …` in lower case already.
  ignores: [
    // Single-package npm bump, e.g. `deps: Bump electron from 43.2.0 to 43.4.0`.
    (message) => /^deps: Bump \S+ from \S+ to \S+$/.test(message),
    // Grouped bump, e.g. `build(deps): Bump the npm_and_yarn group across 1
    // directory with 6 updates` (#187) — same capitalisation, different shape.
    // The `across N director(y|ies)` clause appears only for a multi-directory
    // group, hence optional. Everything else is fixed text or a bare integer, so
    // there is no free-form run in the middle for an arbitrary subject to ride
    // in on — `Bump the x group and also Add Support with 2 updates` is rejected.
    (message) =>
      /^(?:deps|build\(deps\)): Bump the \S+ group (?:across \d+ director(?:y|ies) )?with \d+ updates?$/
        .test(message),
  ],
  rules: {
    // Allowed types. Standard Conventional set plus `deps` — Dependabot is
    // configured (.github/dependabot.yml) to prefix its PRs with `deps`.
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'deps',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    // This repo's subjects run long and descriptive (often with trailing PR
    // refs). 120 keeps them honest without rejecting the established style;
    // aim for ~72 per CONTRIBUTING.md.
    'header-max-length': [2, 'always', 120],
    // Commit bodies here carry detailed rationale with long lines and URLs.
    // Don't hard-wrap-police them.
    'body-max-line-length': [0, 'always', Infinity],
    'footer-max-line-length': [0, 'always', Infinity],
  },
}
