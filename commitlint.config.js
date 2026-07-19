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
