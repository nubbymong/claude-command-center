export const PR_CARD_QUERY = /* GraphQL */ `
  query PRCard($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequests(headRefName: $branch, states: [OPEN], first: 1) {
        nodes {
          number title body isDraft createdAt updatedAt
          url mergeable
          author { login avatarUrl }
          reviews(last: 30) {
            nodes {
              id state author { login avatarUrl }
              comments(last: 20) {
                nodes { id body path position originalPosition author { login } }
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(last: 50) {
                    nodes {
                      __typename
                      ... on CheckRun { name conclusion status detailsUrl }
                      ... on StatusContext { context state description targetUrl }
                    }
                  }
                }
              }
            }
          }
          closingIssuesReferences(first: 20) {
            nodes { number title state }
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
      limit
    }
  }
`

export interface PrCardVariables {
  owner: string
  name: string
  branch: string
}
