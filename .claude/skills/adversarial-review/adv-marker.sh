#!/usr/bin/env sh
# Print the machine-readable ADVERSARIAL-REVIEW marker line for the current
# branch / PR. Copy the output verbatim as the FIRST line of the PR verdict
# comment, then append the severity tail (e.g. "0 blockers, 0 majors open").
#
#   sh .claude/skills/adversarial-review/adv-marker.sh [PASS|FINDINGS] [base]
#
# The content= field content-addresses the verdict to the POST-IMAGE CONTENT of
# every reviewed (non-generated) changed file on the current head -- not to the
# diff text. A rebase, or a regen of a generated file, leaves it unchanged, so a
# PASS carries forward. Any real content change to a reviewed file changes it and
# forces a fresh adversarial pass.
#
# GENERATED-FILE REGISTRY (closed -- do not widen to a docs/*.md glob):
#   CONTEXT.md    aggregate rendered from CONTEXT.d/ fragments (gitignored)
#   CHANGELOG.md  generated from src/renderer/changelog.ts by `npm run changelog`
set -eu

VERDICT="${1:-PASS}"
BASE="${2:-origin/beta}"

HEAD_SHA="$(git rev-parse HEAD)"
PR="$(gh pr view --json number -q .number 2>/dev/null || echo '-')"

CONTENT="$(
  git diff --name-only "$BASE...HEAD" \
    | grep -vE '^(CONTEXT\.md|CHANGELOG\.md)$' \
    | LC_ALL=C sort \
    | while IFS= read -r f; do
        printf '%s %s\n' "$f" "$(git rev-parse "HEAD:$f" 2>/dev/null || echo DELETED)"
      done \
    | sha256sum | cut -d' ' -f1
)"

printf 'ADVERSARIAL-REVIEW v1 | %s | pr=#%s | head=%s | content=%s | ' \
  "$VERDICT" "$PR" "$HEAD_SHA" "$CONTENT"
echo
