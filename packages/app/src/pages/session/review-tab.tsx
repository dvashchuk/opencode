import { createEffect, For, onCleanup, Show, type JSX } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { SessionReview } from "@opencode-ai/session-ui/session-review"
import type {
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
} from "@opencode-ai/session-ui/session-review"
import type { SelectedLineRange } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import type { LineComment } from "@/context/comments"

export type DiffStyle = "unified" | "split"

export type SessionReviewPullRequest = {
  number: number
  title: string
  url: string
  state: string
  checks: string
}

export type SessionReviewThread = {
  id: string
  file: string
  line?: number
  author: string
  body: string
  url: string
  outdated: boolean
  resolved: boolean
  replies: { author: string; body: string }[]
}

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

export interface SessionReviewTabProps {
  title?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  diffStyle: DiffStyle
  onDiffStyleChange?: (style: DiffStyle) => void
  onViewFile?: (file: string) => void
  onLineComment?: (comment: { file: string; selection: SelectedLineRange; comment: string; preview?: string }) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: LineComment[]
  focusedComment?: { file: string; id: string } | null
  onFocusedCommentChange?: (focus: { file: string; id: string } | null) => void
  focusedFile?: string
  onScrollRef?: (el: HTMLDivElement | undefined) => void
  commentMentions?: {
    items: (query: string) => string[] | Promise<string[]>
  }
  classes?: {
    root?: string
    header?: string
    container?: string
  }
  pullRequest?: SessionReviewPullRequest
  threads?: SessionReviewThread[]
}

export function SessionReviewTab(props: SessionReviewTabProps) {
  let scroll: HTMLDivElement | undefined
  let restoreFrame: number | undefined
  let userInteracted = false
  let restored: { x: number; y: number } | undefined

  const sdk = useSDK()
  const layout = useLayout()
  const language = useLanguage()

  const readFile = async (path: string) => {
    return sdk()
      .client.file.read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review] failed to read file", { path, error })
        return undefined
      })
  }

  const handleInteraction = () => {
    userInteracted = true

    if (restoreFrame !== undefined) {
      cancelAnimationFrame(restoreFrame)
      restoreFrame = undefined
    }
  }

  const doRestore = () => {
    restoreFrame = undefined
    const el = scroll
    if (!el || !layout.ready() || userInteracted) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    const s = props.view().scroll("review")
    if (!s || (s.x === 0 && s.y === 0)) return

    const maxY = Math.max(0, el.scrollHeight - el.clientHeight)
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth)

    const targetY = Math.min(s.y, maxY)
    const targetX = Math.min(s.x, maxX)

    if (el.scrollTop === targetY && el.scrollLeft === targetX) return

    if (el.scrollTop !== targetY) el.scrollTop = targetY
    if (el.scrollLeft !== targetX) el.scrollLeft = targetX
    restored = { x: el.scrollLeft, y: el.scrollTop }
  }

  const queueRestore = () => {
    if (userInteracted || restoreFrame !== undefined) return
    restoreFrame = requestAnimationFrame(doRestore)
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget
    const prev = restored
    if (prev && el.scrollTop === prev.y && el.scrollLeft === prev.x) {
      restored = undefined
      return
    }

    restored = undefined
    handleInteraction()
    if (!layout.ready()) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    props.view().setScroll("review", {
      x: el.scrollLeft,
      y: el.scrollTop,
    })
  }

  createEffect(() => {
    props.diffs().length
    props.diffStyle
    if (!layout.ready()) return
    queueRestore()
  })

  onCleanup(() => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    props.onScrollRef?.(undefined)
  })

  const threads = () => props.threads ?? []

  return (
    <div class="flex flex-col h-full min-h-0">
      <Show when={props.pullRequest}>
        {(pr) => (
          <div class="flex items-center gap-2 border-b border-border-weaker-base px-3 py-2">
            <span class="text-12-medium text-text-strong">#{pr().number}</span>
            <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{pr().title}</span>
            <span class="text-12-regular text-text-weak">{pr().state}</span>
          </div>
        )}
      </Show>
      <Show when={threads().length > 0}>
        <div class="flex max-h-40 flex-col gap-2 overflow-auto border-b border-border-weaker-base px-3 py-2">
          <span class="text-12-medium text-text-weak">{language.t("session.review.pr.comments")}</span>
          <For each={threads()}>
            {(thread) => (
              <button
                type="button"
                class="flex flex-col gap-1 text-left"
                onClick={() => props.onViewFile?.(thread.file)}
              >
                <span class="text-12-regular text-text-weak">
                  {thread.file}
                  {thread.line ? `:${thread.line}` : ""} · {thread.author}
                </span>
                <span class="whitespace-pre-wrap break-words text-12-regular text-text-base">{thread.body}</span>
                <Show when={thread.resolved || thread.outdated}>
                  <span class="text-12-regular text-text-weak">
                    {thread.resolved
                      ? language.t("session.review.pr.resolved")
                      : language.t("session.review.pr.outdated")}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="min-h-0 flex-1">
        <SessionReview
      title={props.title}
      empty={props.empty}
      scrollRef={(el) => {
        scroll = el
        makeEventListener(el, "wheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "mousewheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "pointerdown", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "touchstart", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "keydown", handleInteraction, { capture: true })
        props.onScrollRef?.(el)
        queueRestore()
      }}
      onScroll={handleScroll}
      onDiffRendered={queueRestore}
      open={props.view().review.open()}
      onOpenChange={props.view().review.setOpen}
      classes={{
        root: props.classes?.root ?? "pr-3",
        header: props.classes?.header ?? "px-3",
        container: props.classes?.container ?? "pl-3",
      }}
      diffs={props.diffs()}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      onViewFile={props.onViewFile}
      focusedFile={props.focusedFile}
      readFile={readFile}
      onLineComment={props.onLineComment}
      onLineCommentUpdate={props.onLineCommentUpdate}
      onLineCommentDelete={props.onLineCommentDelete}
      lineCommentActions={props.lineCommentActions}
      lineCommentMention={props.commentMentions}
      comments={props.comments}
      focusedComment={props.focusedComment}
        onFocusedCommentChange={props.onFocusedCommentChange}
      />
      </div>
    </div>
  )
}
