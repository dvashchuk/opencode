# Session Pull Request

## Goal

Let a session link to a GitHub pull request, show that PR's diff in the review
tab, and show the PR's review comments on the lines they belong to.

GitHub access uses the existing `gh` CLI login. No second credential, no token
stored on disk by opencode.

## Current state (verified)

- [`pr.ts`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/cli/cmd/pr.ts)
  — `opencode pr <number>` runs `gh pr checkout`, optionally imports a session
  from an `opncd.ai` link in the PR body, then spawns `opencode`. It never links
  the PR to the session, and never fetches the PR diff or comments.
- [`vcs.ts`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/project/vcs.ts#L235)
  — `Mode = "git" | "branch"`. `"git"` diffs against `HEAD`; `"branch"` diffs
  against the merge-base with the default branch. There is no PR mode and no
  notion of a PR base branch.
- Review tab
  ([`session.tsx`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/app/src/pages/session.tsx),
  [`review-tab.tsx`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/app/src/pages/session/review-tab.tsx))
  renders only `Vcs.FileDiff[]` from those two modes. No comment layer.
- PR comments are fetched only by
  [`github.handler.ts`](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/cli/cmd/github.handler.ts)
  (the `opencode github` CI runner) through `@octokit/graphql`. That code is
  process-local to CI and unavailable to a local session or the app.

So the feature does not exist. Everything below is new.

## Non-goals (v1)

- No write operations: no replying, resolving, approving, or merging.
- No CI check/log rendering (a single checks summary line is enough).
- No polling. Refresh is explicit, or once when the review tab opens.

## UX

1. Review tab gets a source selector: `Working tree | Branch | PR #1234`.
   `PR` only appears when the session has a linked PR or one can be detected
   from the current branch.
2. Selecting `PR` renders `Vcs.FileDiff[]` computed against the PR base, with
   the same file list, stats, and split/unified controls as today.
3. Each file row shows an unresolved-comment count. Unresolved review threads
   render inline at their anchored line; a collapsed `Outdated` group holds
   threads whose anchor no longer exists in the current diff.
4. A header strip shows `#1234 title · state · checks · updated 2m ago` with a
   refresh button.
5. `opencode pr <n>` links the resulting session automatically, so the tab
   starts in PR mode.

## Data model

New table in `packages/core/src/session/sql.ts`, migration generated with
`bun run db generate` from `packages/core`:

```ts
export const SessionPullRequestTable = sqliteTable(
  "session_pull_request",
  {
    session_id: text().$type<SessionSchema.ID>().primaryKey(),
    repository: text().notNull(), // "owner/name"
    number: integer().notNull(),
    base_ref: text().notNull(),
    head_ref: text().notNull(),
    base_sha: text().notNull(),
    head_sha: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index().on(table.repository, table.number)],
)
```

One PR per session (`session_id` is the primary key). Cascade delete with the
session. `base_sha` and `head_sha` are recorded at link time; a later refresh
updates them and bumps `time_updated`.

Session *binding* is durable state. Fetched PR content (title, comments) is
cache, never persisted.

## GitHub client

New module `packages/opencode/src/github/` following the repo's flat-export +
`export * as GitHub from "./github"` convention. `GitHub.Service` is a
`Context.Service` built with `Layer.effect`, registered as a `LayerNode` next to
`Vcs.node`.

```ts
export interface Interface {
  readonly token: () => Effect.Effect<string, GitHubAuthError>
  readonly currentRepository: () => Effect.Effect<string | undefined>   // from parseGitHubRemote
  readonly detect: () => Effect.Effect<PullRequest | undefined, GitHubError>  // by current branch
  readonly pullRequest: (input: { repository: string; number: number; refresh?: boolean }) => Effect.Effect<PullRequest, GitHubError>
  readonly threads: (input: { repository: string; number: number; refresh?: boolean }) => Effect.Effect<ReviewThread[], GitHubError>
}
```

### Authentication

Resolve the token in this order, once per process, cached in memory:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token` via `Process.text`, run with the instance directory as cwd.

Anything else is `GitHubAuthError`, whose message tells the user to run
`gh auth login`. The token is passed only to octokit headers. It is never
logged, never returned over HTTP, and never written to the database or a config
file.

Use `@octokit/graphql` with `auth: token` (already a dependency, already used by
`github.handler.ts`). Do not shell out to `gh api` per request: one token call
plus direct HTTPS is fewer processes and easier to test.

On any `401`/`403` with a bad-credentials body, drop the cached token and retry
once. On rate limiting (`x-ratelimit-remaining: 0`), return `GitHubRateLimited`
carrying `resetAt`.

### Queries

`pullRequest` — one GraphQL query for `number, url, title, state, isDraft,
mergeable, baseRefName, headRefName, baseRefOid, headRefOid, additions,
deletions, changedFiles, updatedAt`, `headRepository.nameWithOwner`,
`baseRepository.nameWithOwner`, `commits(last: 1).nodes.oid`, and, from
`statusCheckRollup`, a summary count of `{success, failure, pending}`. No diff
in this query: patch bodies go through git, not octokit.

`threads` — `reviewThreads(first: 100)` per page with `isResolved`,
`isOutdated`, `path`, `line`, `originalLine`, `diffSide`, `subjectType`, and
`comments(first: 50) { id, databaseId, author { login }, body, createdAt,
url }`, plus top-level `comments(first: 100)` for issue-style comments
(returned as threads with `path: undefined`). Follow `pageInfo` up to 10 pages,
then stop and mark the result `truncated`.

Cache keyed by `repository#number` inside `InstanceState` with a 30 second TTL.
`refresh: true` bypasses the TTL. This keeps tab switching and file clicks from
re-hitting the API.

### Repository resolution

`currentRepository` uses `parseGitHubRemote` from `@/util/repository` against
`git remote get-url origin` (fallback: the first GitHub remote). If no remote
parses, the feature is unavailable and the UI hides it — no guessing.

`detect` runs
`gh pr list --head <currentBranch> --state open --json number --jq '.[0].number'`
and then `pullRequest` with that number. Reuse `Process.text` with `nothrow` so
a missing `gh` binary degrades to "unavailable", not an error toast.

## Diff mode

Add `"pull_request"` to `Mode` in `packages/opencode/src/project/vcs.ts` and a
`pr` variant to the `diff` options:

```ts
export const Mode = Schema.Literals(["git", "branch", "pull_request"])
```

Resolution rules for `"pull_request"`, in order:

1. No linked PR → `[]` (the route returns `409` with `VcsNoPullRequest`).
2. `git cat-file -e <head_sha>` fails → fetch it:
   `git fetch <remote> +refs/pull/<number>/head:refs/opencode/pr/<number>`, then
   use that ref. `remote` is the remote that matches `repository`, else
   `origin`. Fetch is a single, user-initiated action, never on a timer.
3. `ref = git mergeBase(base_sha, head_ref)`. If undefined, fall back to
   `base_sha` and log a warning.
4. `yield* diffAgainstRef(git, ctx.directory, ref, options)` — the existing
   helper, so file list, stats, ordering, patch caps, and untracked handling are
   unchanged.

Untracked local files are excluded in this mode: they are not part of the PR.
That means passing an explicit flag to `diffAgainstRef`/`files` rather than
reusing the working-tree `??` merge.

Shallow clones and detached heads are the failure cases to test. If
`mergeBase` cannot resolve because the clone is shallow, the route returns a
typed `VcsShallowClone` error whose message tells the user to
`git fetch --unshallow`.

## HTTP API

Add to `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
and the matching handlers, then regenerate the client with `bun run generate`
from `packages/client`.

| Method | Path | Body/Query | Success |
| --- | --- | --- | --- |
| GET | `/session/:sessionID/pull-request` | `refresh?: boolean` | `PullRequestLink` (pr + thread counts + checks) |
| PUT | `/session/:sessionID/pull-request` | `{ repository?, number, refresh? }` | `PullRequestLink` |
| DELETE | `/session/:sessionID/pull-request` | — | `204` |
| GET | `/vcs/diff` (existing) | `mode=pull_request&sessionID=...` | `Vcs.FileDiff[]` |

`PUT` accepts `number` only when the repository resolves from the remote; an
explicit `repository` is required for forks being reviewed from another
checkout. Linking validates the PR exists before writing the row.

`GET /session/:id/pull-request` returns:

```ts
export const PullRequestLink = Schema.Struct({
  pullRequest: Schema.Struct({
    repository: Schema.String,
    number: Schema.Finite,
    url: Schema.String,
    title: Schema.String,
    state: Schema.Literals(["open", "closed", "merged"]),
    draft: Schema.Boolean,
    base_ref: Schema.String,
    head_ref: Schema.String,
    additions: Schema.Finite,
    deletions: Schema.Finite,
    changed_files: Schema.Finite,
    checks: Schema.Struct({
      success: Schema.Finite,
      failure: Schema.Finite,
      pending: Schema.Finite,
    }),
    updated: Schema.DateTimeUtc,
  }),
  threads: Schema.Array(PullRequestThread),
  truncated: Schema.Boolean,
})
```

`PullRequestThread` carries `id`, `path`, `line` (new side), `originalLine`,
`outdated`, `resolved`, `author`, `body`, `url`, `created`, and
`comments: { author, body, created }[]` for the reply chain.

Comment bodies are returned as text with no markdown execution. The server
never forwards them to a model implicitly.

## App

The review side tab already has a change-source dropdown that offers
`git`, `branch` (only off the default branch), and `turn`, so the PR view is a
fourth option in the same dropdown, not a new panel. The selected mode is
already persisted per session as `sessionView.reviewMode`.

Wiring, all in `packages/app`:

- `context/layout.tsx` — extend `ReviewChangeMode` (`"git" | "branch" | "turn"`)
  with `"pull_request"`. `setMode` and persistence need no other change.
- `pages/session.tsx` — extend the local `ChangeMode` and `VcsMode` unions;
  `changesOptions()` pushes `"pull_request"` when a PR is linked or detected and
  `project.vcs === "git"`; `changesLabel()` adds the
  `ui.sessionReview.title.pullRequest` string, rendered as `PR #<n>`;
  `vcsMode()` returns the new mode; `reviewDiffs()` and `reviewReady()` include
  it; the `vcsQuery` request sends `mode=pull_request` plus `sessionID`;
  `loadReviewDiff()` passes the same identity so per-file lazy loading,
  patch-validity checks, and split view are unchanged.
- `pages/session/review-tab.tsx` — pass `threads` into `SessionReview`
  alongside the existing `comments` prop.

`packages/session-ui/src/components/session-review.tsx` already renders
line-anchored annotations through `createLineCommentController` from
`line-comment-annotations.tsx`, keyed by `file` plus a `SelectedLineRange`. A
GitHub thread is the same shape, so map each thread to
`{ id: "gh:<databaseId>", file: path, selection: { start: line, end: line },
comment: "**author**\n\nbody", readOnly: true }` and feed it through a
`threads` prop rendered by the same controller with editing disabled. Two small
additions: a `readOnly` flag on the annotation shape, and a distinct style so
readers can tell a GitHub thread from a local draft.

`pages/session.tsx` gets a `pullRequestThreads` memo from the link query grouped
by `file → line`, recomputed on refresh only.

Header behavior:

- `PR #<n>` label with a state dot and a refresh button, disabled while the
  query is in flight.
- File list rows show an unresolved thread count.
- Threads whose `line` is gone from the current diff go into an `Outdated`
  group at the top of the file, not dropped.

The dropdown keeps `git` and `turn` untouched. `pull_request` shows the PR's
own diff, because comment anchors only line up with the PR head; if the local
tree is dirty, show one muted banner (`local changes not shown`) that switches
to `git`. Translation keys live in the app i18n files under
`session.review.pr.*` and `ui.sessionReview.title.pullRequest`.

## CLI

`packages/opencode/src/cli/cmd/pr.ts`: after a successful
`gh pr checkout`, call the `PUT /session/:id/pull-request` route through the
in-process client once the session exists, so the session opens in PR mode. If
the checkout imported a session, link that session instead of the new one.

Keep `opencode pr` working with no `gh` installed: linking is best-effort and
its failure only prints one line.

## Security and privacy

- Token: `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token`, in memory only.
- Never log the token, the `Authorization` header, or full response bodies on
  error. Log `status` and a message code instead.
- Comment and PR bodies are untrusted data. They are displayed, not executed,
  and not injected into any model prompt automatically. A later optional tool
  would wrap them in an explicit untrusted-data block, matching how
  `github.handler.ts` already labels fetched issue text.
- No write scopes are requested. `gh auth token` scopes are whatever the user
  already granted; v1 only reads.

## Failure behavior

| Case | Result |
| --- | --- |
| `gh` missing or not logged in | Feature hidden; typed `GitHubAuthError` in the API |
| No GitHub remote | Feature hidden; no detection attempt |
| PR not found / no access | `404` surfaced on the header strip, link is not written |
| Rate limited | Header shows reset time; cached data stays visible |
| Shallow clone | Typed error with the `git fetch --unshallow` hint |
| Fork PR | Fetch from the base repository's `refs/pull/<n>/head` |
| Force-pushed PR | `head_sha` mismatch on refresh updates the row; stale inline threads move to `Outdated` |
| More than 1000 threads | `truncated: true`, UI shows a notice |

## Testing

- `packages/opencode/test/github/` — token resolution precedence with a fake
  `Process`; `401` clears the cached token and retries once; GraphQL response
  parsing for threads, outdated threads, and page limits (fixture JSON, no
  network).
- `packages/opencode/test/project/vcs.test.ts` — `pull_request` mode against a
  temp repo: linked PR diff equals `git diff <merge-base>`, untracked files are
  excluded, missing head object triggers exactly one fetch, shallow clone
  returns the typed error. No mocks: real git commands in a temp directory.
- Server route test — link, unlink, and `409` for a diff request without a link.
- App — a small test for comment-to-line grouping and the `Outdated` fallback.

## Phases

1. `GitHub` service, `session_pull_request` table, link routes, `pull_request`
   diff mode. Feature usable from the API and CLI.
2. Review tab source selector, PR header, diff via PR base.
3. Inline review threads and the `Outdated` group.
4. `opencode pr` auto-link; optional read-only `pull_request` tool for the
   agent, gated behind the same auth and explicitly labelled untrusted.

Each phase must leave `bun typecheck` clean in the touched packages and keep
the existing `git` and `branch` modes byte-identical.

## Acceptance criteria

- Opening a session that has a linked PR shows the PR diff in the review tab
  without any local checkout of the PR branch.
- Review comments appear on their lines; out-of-date threads are grouped, not
  dropped.
- No credential is written to disk or returned by any route.
- `gh` unauthenticated → feature hidden, no crash, no repeated requests.
- Existing diff modes unchanged, existing tests green.

## Status

Implemented in the working tree, uncommitted. Where the code differs from the plan above, the code wins and this section records why.

Landed:

- `packages/core/src/session/sql.ts` table plus migration
  `20261115114955_add_session_pull_request`, with `schema.json`,
  `schema.gen.ts`, and `migration.gen.ts` regenerated.
- `packages/opencode/src/github/github.ts`: `gh` token chain, GraphQL read of
  the pull request and its threads, 30s cache, process-local token cache, and a
  60s detection cache for the current branch.
- `Vcs.Mode` gains `pull_request`, and `Git.diff`, `Git.stats`, `Git.patch`,
  `Git.patchAll` gained an optional `head` ref so the mode diffs
  merge-base(base, head) against head instead of the working tree. Untracked
  files are excluded. Existing modes are untouched; `test/project/vcs.test.ts`
  still passes unchanged.
- Routes `GET`, `PUT`, `DELETE /session/:sessionID/pull-request` and
  `mode=pull_request` on `/vcs/diff`, with the legacy SDK regenerated.
- App: `pull_request` in the change dropdown, PR diff through the new mode, a
  PR header strip, and a review-thread list in both the classic review tab and
  the V2 review sidebar. Threads are plain text with author, file, line,
  resolved and outdated markers.

Deviations from the plan:

- `checks` is one rollup state (`success | failure | pending | expected | error
  | unknown`), not success/failure/pending counts, because
  `statusCheckRollup` exposes a single state.
- Only the first 100 review threads are fetched; `truncated` reports the rest.
- Link routes surface GitHub failures as errors rather than typed 409/404
  payloads, and `pull_request` diff returns an empty list when the PR cannot be
  resolved, so the UI shows its normal empty state instead of a bespoke one.
- Auto-detection by current branch replaces manual linking for v1. `opencode pr`
  does not link the session yet, and there is no explicit link or unlink button
  in the UI; the routes exist for both.

Inline rendering is done too: `SessionReview` and the V2 file preview accept a
`threads` prop and merge GitHub threads into the existing line-comment
annotation controller as read-only entries, so a thread is drawn at its anchored
line with author, body, reply chain, and resolved/outdated markers, with no
edit or delete affordances. The review panel also keeps the flat thread list.

Unverified without a running server:

- First real call to GitHub, and the migration applying to an existing database.
