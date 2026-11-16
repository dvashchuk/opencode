import { Database } from "@opencode-ai/core/database/database"
import { SessionPullRequestTable } from "@opencode-ai/core/session/sql"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Process } from "@/util/process"
import { parseGitHubRemote } from "@/util/repository"
import { graphql } from "@octokit/graphql"
import { eq } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Option, Ref, Schema } from "effect"

const CACHE_TTL_MS = Duration.toMillis(Duration.seconds(30))
const DETECT_TTL_MS = Duration.toMillis(Duration.seconds(60))
const THREAD_LIMIT = 100

export const PullRequest = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  number: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  base_ref: Schema.String,
  base_sha: Schema.String,
  head_ref: Schema.String,
  head_sha: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  changed_files: Schema.Finite,
  checks: Schema.Literals(["success", "failure", "pending", "expected", "error", "unknown"]),
  updated: Schema.String,
})
export type PullRequest = Schema.Schema.Type<typeof PullRequest>

export const ThreadComment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  created: Schema.String,
  url: Schema.String,
})
export type ThreadComment = Schema.Schema.Type<typeof ThreadComment>

export const ReviewThread = Schema.Struct({
  id: Schema.String,
  path: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Finite),
  original_line: Schema.optional(Schema.Finite),
  outdated: Schema.Boolean,
  resolved: Schema.Boolean,
  comments: Schema.Array(ThreadComment),
})
export type ReviewThread = Schema.Schema.Type<typeof ReviewThread>

export const Link = Schema.Struct({
  pullRequest: PullRequest,
  threads: Schema.Array(ReviewThread),
  truncated: Schema.Boolean,
})
export type Link = Schema.Schema.Type<typeof Link>

export const Stored = Schema.Struct({
  repository: Schema.String,
  number: Schema.Finite,
  base_ref: Schema.String,
  head_ref: Schema.String,
  base_sha: Schema.String,
  head_sha: Schema.String,
})
export type Stored = Schema.Schema.Type<typeof Stored>

export const LinkInput = Schema.Struct({
  repository: Schema.optional(Schema.String),
  number: Schema.Finite,
  refresh: Schema.optional(Schema.Boolean),
})
export type LinkInput = Schema.Schema.Type<typeof LinkInput>

export const ReplyInput = Schema.Struct({
  threadID: Schema.String,
  body: Schema.String,
})
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export const CommentInput = Schema.Struct({
  path: Schema.String,
  line: Schema.Finite,
  body: Schema.String,
})
export type CommentInput = Schema.Schema.Type<typeof CommentInput>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("GitHubAuthError", {
  message: Schema.String,
}) {}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("GitHubRequestError", {
  message: Schema.String,
  status: Schema.optional(Schema.Finite),
}) {}

export interface Interface {
  readonly repository: () => Effect.Effect<string | undefined>
  readonly remote: (repository: string) => Effect.Effect<string | undefined>
  readonly stored: (sessionID: SessionSchema.ID) => Effect.Effect<Stored | undefined>
  readonly get: (
    sessionID: SessionSchema.ID,
    options?: { refresh?: boolean },
  ) => Effect.Effect<Link | undefined, AuthError | RequestError>
  readonly link: (sessionID: SessionSchema.ID, input: LinkInput) => Effect.Effect<Link, AuthError | RequestError>
  readonly unlink: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly detect: () => Effect.Effect<{ repository: string; number: number } | undefined>
  readonly reply: (input: ReplyInput) => Effect.Effect<ThreadComment, AuthError | RequestError>
  readonly comment: (
    sessionID: SessionSchema.ID,
    input: CommentInput,
  ) => Effect.Effect<ReviewThread, AuthError | RequestError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitHub") {}

const splitRepository = (repository: string) => {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo) return undefined
  return { owner, repo }
}

const decodeChecks = (state: string | null | undefined): PullRequest["checks"] => {
  if (state === "SUCCESS") return "success"
  if (state === "FAILURE") return "failure"
  if (state === "PENDING") return "pending"
  if (state === "EXPECTED") return "expected"
  if (state === "ERROR") return "error"
  return "unknown"
}

const decodeState = (state: string, merged: boolean): PullRequest["state"] => {
  if (merged) return "merged"
  return state.toLowerCase() === "open" ? "open" : "closed"
}

const pullRequestQuery = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      number
      url
      title
      state
      merged
      isDraft
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      additions
      deletions
      changedFiles
      updatedAt
      statusCheckRollup {
        state
      }
      reviewThreads(first: ${THREAD_LIMIT}) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 50) {
            nodes {
              databaseId
              author {
                login
              }
              body
              createdAt
              url
            }
          }
        }
      }
      comments(first: ${THREAD_LIMIT}) {
        nodes {
          author {
            login
          }
          body
          createdAt
          url
        }
      }
    }
  }
}`

type GqlComment = {
  author: { login: string } | null
  body: string
  createdAt: string
  url: string
}

type GqlResponse = {
  repository: {
    pullRequest: {
      id: string
      number: number
      url: string
      title: string
      state: string
      merged: boolean
      isDraft: boolean
      baseRefName: string
      baseRefOid: string
      headRefName: string
      headRefOid: string
      additions: number
      deletions: number
      changedFiles: number
      updatedAt: string
      statusCheckRollup: { state: string } | null
      reviewThreads: {
        pageInfo: { hasNextPage: boolean }
        nodes: {
          id: string
          isResolved: boolean
          isOutdated: boolean
          path: string | null
          line: number | null
          originalLine: number | null
          comments: { nodes: (GqlComment & { databaseId: number | null })[] }
        }[]
      }
      comments: { nodes: GqlComment[] }
    } | null
  } | null
}

const replyMutation = `
mutation($threadID: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadID, body: $body }) {
    comment {
      author {
        login
      }
      body
      createdAt
      url
    }
  }
}`

const commentMutation = `
mutation($pullRequestId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(
    input: { pullRequestId: $pullRequestId, path: $path, body: $body, line: $line, side: RIGHT }
  ) {
    thread {
      id
      isResolved
      isOutdated
      path
      line
      comments(first: 1) {
        nodes {
          author {
            login
          }
          body
          createdAt
          url
        }
      }
    }
  }
}`

type GqlCreatedThread = {
  addPullRequestReviewThread: {
    thread: {
      id: string
      isResolved: boolean
      isOutdated: boolean
      path: string | null
      line: number | null
      comments: { nodes: GqlComment[] }
    } | null
  } | null
}

type GqlReply = {
  addPullRequestReviewThreadReply: {
    comment: GqlComment | null
  } | null
}

const PrList = Schema.fromJsonString(Schema.Array(Schema.Struct({ number: Schema.Finite })))

const layer: Layer.Layer<Service, never, Database.Service | Git.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const { db } = yield* Database.Service
    const tokens = yield* Ref.make<string | undefined>(undefined)
    const cache = yield* Ref.make(new Map<string, { at: number; link: Link }>())
    const detected = yield* Ref.make(new Map<string, { at: number; value: { repository: string; number: number } | null }>())

    const readToken = Effect.fnUntraced(function* () {
      const current = yield* Ref.get(tokens)
      if (current) return current

      const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
      if (fromEnv) {
        yield* Ref.set(tokens, fromEnv)
        return fromEnv
      }

      const result = yield* Effect.promise(() =>
        Process.text(["gh", "auth", "token"], { nothrow: true, timeout: 15_000 }),
      )
      const token = result.code === 0 ? result.text.trim() : ""
      if (!token) return yield* new AuthError({ message: "GitHub CLI is not authenticated. Run `gh auth login`." })
      yield* Ref.set(tokens, token)
      return token
    })

    const remotes = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const result = yield* git.run(["remote", "-v"], { cwd: ctx.directory })
      const seen = new Map<string, { repository: string; remote: string }>()
      for (const line of result.text().split("\n")) {
        const [name, url] = line.trim().split(/\s+/)
        if (!name || !url || seen.has(name)) continue
        const parsed = parseGitHubRemote(url)
        if (!parsed) continue
        seen.set(name, { repository: `${parsed.owner}/${parsed.repo}`, remote: name })
      }
      return [...seen.values()]
    })

    const repository = Effect.fn("GitHub.repository")(function* () {
      const list = yield* remotes()
      return list.find((item) => item.remote === "origin")?.repository ?? list[0]?.repository
    })

    const request = Effect.fnUntraced(
      function* (query: string, variables: Record<string, string | number>) {
        const token = yield* readToken()
        return yield* Effect.tryPromise({
          try: () => graphql<GqlResponse>(query, { ...variables, headers: { authorization: `token ${token}` } }),
          catch: (error) => {
            const status = (error as { response?: { status?: number } }).response?.status
            return new RequestError({
              message: status === 404 ? "Pull request not found or not accessible" : "GitHub request failed",
              status,
            })
          },
        }).pipe(
          Effect.catch((error): Effect.Effect<GqlResponse, AuthError | RequestError> => {
            if (error.status !== 401) return Effect.fail<AuthError | RequestError>(error)
            return Ref.set(tokens, undefined).pipe(
              Effect.andThen(Effect.fail<AuthError | RequestError>(new AuthError({ message: "GitHub rejected the token" }))),
            )
          }),
        )
      },
      (effect) => effect,
    )

    const sendReply = Effect.fnUntraced(function* (input: ReplyInput) {
      const token = yield* readToken()
      const response = yield* Effect.tryPromise({
        try: () => graphql<GqlReply>(replyMutation, { ...input, headers: { authorization: `token ${token}` } }),
        catch: (error) => {
          const status = (error as { response?: { status?: number } }).response?.status
          return new RequestError({ message: "GitHub reply failed", status })
        },
      })
      const comment = response.addPullRequestReviewThreadReply?.comment
      if (!comment?.author?.login) return yield* new RequestError({ message: "GitHub reply was not created" })
      return {
        author: comment.author.login,
        body: comment.body,
        created: comment.createdAt,
        url: comment.url,
      } satisfies ThreadComment
    })

    const sendComment = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, input: CommentInput) {
      const row = yield* storedRow(sessionID)
      if (!row) return yield* new RequestError({ message: "No pull request linked to this session", status: 404 })
      const link = yield* cached(row.repository, row.number, true)
      const token = yield* readToken()
      const response = yield* Effect.tryPromise({
        try: () =>
          graphql<GqlCreatedThread>(commentMutation, {
            pullRequestId: link.pullRequest.id,
            path: input.path,
            line: input.line,
            body: input.body,
            headers: { authorization: `token ${token}` },
          }),
        catch: (error) => {
          const status = (error as { response?: { status?: number } }).response?.status
          return new RequestError({ message: "GitHub comment failed", status })
        },
      })
      const thread = response.addPullRequestReviewThread?.thread
      const comment = thread?.comments.nodes[0]
      if (!thread || !comment?.author?.login) {
        return yield* new RequestError({ message: "GitHub comment was not created" })
      }
      return {
        id: thread.id,
        path: thread.path ?? input.path,
        line: thread.line ?? input.line,
        outdated: thread.isOutdated,
        resolved: thread.isResolved,
        comments: [
          {
            author: comment.author.login,
            body: comment.body,
            created: comment.createdAt,
            url: comment.url,
          },
        ],
      } satisfies ReviewThread
    })

    const fetchLink = Effect.fnUntraced(function* (repository: string, number: number) {
      const split = splitRepository(repository)
      if (!split) return yield* new RequestError({ message: `Invalid repository ${repository}` })
      const response = yield* request(pullRequestQuery, { ...split, number })
      const pr = response.repository?.pullRequest
      if (!pr) return yield* new RequestError({ message: "Pull request not found", status: 404 })

      const threads: ReviewThread[] = pr.reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        path: thread.path ?? undefined,
        line: thread.line ?? undefined,
        original_line: thread.originalLine ?? undefined,
        outdated: thread.isOutdated,
        resolved: thread.isResolved,
        comments: thread.comments.nodes.flatMap((comment) => {
          const login = comment.author?.login
          if (!login) return []
          return [{ author: login, body: comment.body, created: comment.createdAt, url: comment.url }]
        }),
      }))

      for (const comment of pr.comments.nodes) {
        const login = comment.author?.login
        if (!login) continue
        threads.push({
          id: `comment:${comment.url}`,
          outdated: false,
          resolved: false,
          comments: [{ author: login, body: comment.body, created: comment.createdAt, url: comment.url }],
        })
      }

      return {
        pullRequest: {
          id: pr.id,
          repository,
          number: pr.number,
          url: pr.url,
          title: pr.title,
          state: decodeState(pr.state, pr.merged),
          draft: pr.isDraft,
          base_ref: pr.baseRefName,
          base_sha: pr.baseRefOid,
          head_ref: pr.headRefName,
          head_sha: pr.headRefOid,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changedFiles,
          checks: decodeChecks(pr.statusCheckRollup?.state),
          updated: pr.updatedAt,
        },
        threads,
        truncated: pr.reviewThreads.pageInfo.hasNextPage,
      } satisfies Link
    })

    const cached = Effect.fnUntraced(function* (repository: string, number: number, refresh?: boolean) {
      const key = `${repository}#${number}`
      if (!refresh) {
        const entries = yield* Ref.get(cache)
        const entry = entries.get(key)
        if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.link
      }
      const link = yield* fetchLink(repository, number)
      yield* Ref.update(cache, (entries) => new Map(entries).set(key, { at: Date.now(), link }))
      return link
    })

    const detect = Effect.fnUntraced(function* () {
      const target = yield* repository()
      if (!target) return
      const ctx = yield* InstanceState.context
      const branch = yield* git.branch(ctx.directory)
      if (!branch) return
      const result = yield* Effect.promise(() =>
        Process.text(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1"], {
          cwd: ctx.directory,
          nothrow: true,
          timeout: 15_000,
        }),
      )
      if (result.code !== 0) return
      const decoded = Schema.decodeUnknownOption(PrList)(result.text)
      if (Option.isNone(decoded)) return
      const number = decoded.value[0]?.number
      if (!number) return
      return { repository: target, number }
    })

    const storedRow = (sessionID: SessionSchema.ID) =>
      db.select().from(SessionPullRequestTable).where(eq(SessionPullRequestTable.session_id, sessionID)).get().pipe(
        Effect.orDie,
      )

    const writeLink = (sessionID: SessionSchema.ID, link: Link) => {
      const values = {
        session_id: sessionID,
        repository: link.pullRequest.repository,
        number: link.pullRequest.number,
        base_ref: link.pullRequest.base_ref,
        head_ref: link.pullRequest.head_ref,
        base_sha: link.pullRequest.base_sha,
        head_sha: link.pullRequest.head_sha,
      }
      return db
        .insert(SessionPullRequestTable)
        .values(values)
        .onConflictDoUpdate({ target: SessionPullRequestTable.session_id, set: values })
        .run()
        .pipe(Effect.orDie)
    }

    const detectCached = Effect.fnUntraced(function* (refresh?: boolean) {
      const ctx = yield* InstanceState.context
      const branch = yield* git.branch(ctx.directory)
      if (!branch) return null
      const key = `${ctx.directory}#${branch}`
      if (!refresh) {
        const entries = yield* Ref.get(detected)
        const entry = entries.get(key)
        if (entry && Date.now() - entry.at < DETECT_TTL_MS) return entry.value
      }
      const value = yield* detect().pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.map((result) => result ?? null),
      )
      yield* Ref.update(detected, (entries) => new Map(entries).set(key, { at: Date.now(), value }))
      return value
    })

    return Service.of({
      repository: Effect.fn("GitHub.repository")(function* () {
        return yield* repository()
      }),
      remote: Effect.fn("GitHub.remote")(function* (target) {
        const list = yield* remotes()
        return (
          list.find((item) => item.repository === target)?.remote ??
          list.find((item) => item.remote === "origin")?.remote ??
          list[0]?.remote
        )
      }),
      stored: Effect.fn("GitHub.stored")(function* (sessionID) {
        const row = yield* storedRow(sessionID)
        if (!row) return
        return {
          repository: row.repository,
          number: row.number,
          base_ref: row.base_ref,
          head_ref: row.head_ref,
          base_sha: row.base_sha,
          head_sha: row.head_sha,
        } satisfies Stored
      }),
      get: Effect.fn("GitHub.get")(function* (sessionID, options) {
        const row = yield* storedRow(sessionID)
        if (!row) {
          const found = yield* detectCached(options?.refresh)
          if (!found) return
          const link = yield* cached(found.repository, found.number, options?.refresh)
          yield* writeLink(sessionID, link)
          return link
        }
        const link = yield* cached(row.repository, row.number, options?.refresh)
        if (link.pullRequest.head_sha !== row.head_sha || link.pullRequest.base_sha !== row.base_sha) {
          yield* writeLink(sessionID, link)
        }
        return link
      }),
      link: Effect.fn("GitHub.link")(function* (sessionID, input) {
        const target =
          input.repository ??
          (yield* repository()) ??
          (yield* new RequestError({ message: "No GitHub remote found for this project" }))
        const link = yield* cached(target, input.number, input.refresh ?? true)
        yield* writeLink(sessionID, link)
        return link
      }),
      unlink: Effect.fn("GitHub.unlink")(function* (sessionID) {
        yield* db.delete(SessionPullRequestTable).where(eq(SessionPullRequestTable.session_id, sessionID)).run().pipe(
          Effect.orDie,
        )
      }),
      detect: Effect.fn("GitHub.detect")(function* () {
        return yield* detect()
      }),
      reply: Effect.fn("GitHub.reply")(function* (input) {
        const comment = yield* sendReply(input)
        yield* Ref.set(cache, new Map())
        return comment
      }),
      comment: Effect.fn("GitHub.comment")(function* (sessionID, input) {
        const thread = yield* sendComment(sessionID, input)
        yield* Ref.set(cache, new Map())
        return thread
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Git.node, Database.node] })

export * as GitHub from "./github"
