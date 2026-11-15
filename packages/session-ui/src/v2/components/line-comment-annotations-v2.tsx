import { type SelectedLineRange } from "@pierre/diffs"
import { For, Show, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import {
  createLineCommentAnnotations,
  createLineCommentGutterRenderer,
  createLineCommentState,
  createManagedLineCommentAnnotationRenderer,
  type LineCommentShape,
  type LineCommentStateProps,
} from "../../components/line-comment-annotations"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { cloneSelectedLineRange, formatSelectedLineLabel } from "../../pierre/selection-bridge"
import { LineCommentEditorV2, LineCommentV2 } from "@opencode-ai/ui/v2/line-comment-v2"
import { ThreadReply, type SessionReviewThreadReply } from "../../components/session-review"
import type { LineCommentEditorV2Mention } from "@opencode-ai/ui/v2/line-comment-v2"

type ReviewThreadShape = LineCommentShape & {
  author?: string
  replies?: { author: string; body: string }[]
  readOnly?: boolean
  resolved?: boolean
  outdated?: boolean
}

type LineCommentControllerV2Props<T extends ReviewThreadShape> = {
  comments: Accessor<T[]>
  draftKey: Accessor<string>
  label: string
  state: LineCommentStateProps<string>
  getSide: (range: SelectedLineRange) => "additions" | "deletions"
  onSubmit: (input: { comment: string; selection: SelectedLineRange }) => void
  onGitHubSubmit?: (input: { comment: string; selection: SelectedLineRange }) => void
  onUpdate?: (input: { id: string; comment: string; selection: SelectedLineRange }) => void
  onDelete?: (comment: T) => void
  renderCommentActions?: (comment: T, controls: { edit: VoidFunction; remove: VoidFunction }) => JSX.Element
  editSubmitLabel?: string
  mention?: LineCommentEditorV2Mention
  onThreadReply?: (input: SessionReviewThreadReply) => void | Promise<void>
}

type CommentProps = {
  id?: string
  comment: JSX.Element
  selection: JSX.Element
  actions?: JSX.Element
  editor?: DraftProps
  onClick?: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent>
  onMouseEnter?: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent>
}

type DraftProps = {
  value: string
  selection: JSX.Element
  onInput: (value: string) => void
  onCancel: VoidFunction
  onSubmit: (value: string) => void
  cancelLabel?: string
  submitLabel?: string
  mention?: LineCommentEditorV2Mention
}

function lineCommentElementV2(view: Accessor<CommentProps>) {
  return (
    <Show
      when={view().editor}
      fallback={
        <div
          data-prevent-autofocus=""
          data-comment-id={view().id}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={view().onClick}
          onMouseEnter={view().onMouseEnter}
        >
          <LineCommentV2 comment={view().comment} selection={view().selection} actions={view().actions} />
        </div>
      }
    >
      <div data-prevent-autofocus="" data-comment-id={view().id} onMouseDown={(event) => event.stopPropagation()}>
        <LineCommentEditorV2
          value={view().editor!.value}
          selection={view().editor!.selection}
          onInput={view().editor!.onInput}
          onCancel={view().editor!.onCancel}
          onSubmit={view().editor!.onSubmit}
          cancelLabel={view().editor!.cancelLabel}
          submitLabel={view().editor!.submitLabel}
          mention={view().editor!.mention}
        />
      </div>
    </Show>
  )
}

function lineCommentDraftElementV2(view: Accessor<DraftProps>) {
  return (
    <div data-prevent-autofocus="" onMouseDown={(event) => event.stopPropagation()}>
      <LineCommentEditorV2
        value={view().value}
        selection={view().selection}
        onInput={view().onInput}
        onCancel={view().onCancel}
        onSubmit={view().onSubmit}
        cancelLabel={view().cancelLabel}
        submitLabel={view().submitLabel}
        mention={view().mention}
      />
    </div>
  )
}

export function createLineCommentControllerV2<T extends ReviewThreadShape>(props: LineCommentControllerV2Props<T>) {
  const i18n = useI18n()
  const note = createLineCommentState<string>(props.state)

  const annotations = createLineCommentAnnotations({
    comments: props.comments,
    getCommentId: (comment) => comment.id,
    getCommentSelection: (comment) => comment.selection,
    draftRange: note.commenting,
    draftKey: props.draftKey,
    getSide: props.getSide,
  })

  const { renderAnnotation } = createManagedLineCommentAnnotationRenderer<T, CommentProps, DraftProps>({
    annotations,
    commentElement: lineCommentElementV2,
    draftElement: lineCommentDraftElementV2,
    renderComment: (comment) => {
      if (comment.readOnly) {
        return {
          id: comment.id,
          comment: (
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <Icon name="github" size="small" />
                <span class="text-12-medium text-text-strong">{comment.author}</span>
                <Show when={comment.outdated}>
                  <span class="text-11-regular text-text-weak">{i18n.t("ui.sessionReview.pr.outdated")}</span>
                </Show>
                <Show when={comment.resolved}>
                  <span class="text-11-regular text-text-weak">{i18n.t("ui.sessionReview.pr.resolved")}</span>
                </Show>
              </div>
              <div class="whitespace-pre-wrap break-words text-12-regular">{comment.comment}</div>
              <For each={comment.replies ?? []}>
                {(reply) => (
                  <div class="flex flex-col gap-1 border-l border-border-weak-base pl-2">
                    <span class="text-12-medium text-text-strong">{reply.author}</span>
                    <div class="whitespace-pre-wrap break-words text-12-regular">{reply.body}</div>
                  </div>
                )}
              </For>
              <Show when={props.onThreadReply}>
                <ThreadReply threadID={comment.id} onReply={props.onThreadReply} />
              </Show>
            </div>
          ),
          selection: formatSelectedLineLabel(comment.selection, i18n.t),
        }
      }

      const edit = () => note.openEditor(comment.id, comment.selection, comment.comment)
      const remove = () => {
        note.reset()
        props.onDelete?.(comment)
      }

      return {
        id: comment.id,
        comment: comment.comment,
        selection: formatSelectedLineLabel(comment.selection, i18n.t),
        get actions() {
          return props.renderCommentActions?.(comment, { edit, remove })
        },
        get editor() {
          return note.isEditing(comment.id)
            ? {
                get value() {
                  return note.draft()
                },
                selection: formatSelectedLineLabel(comment.selection, i18n.t),
                onInput: note.setDraft,
                onCancel: note.cancelDraft,
                onSubmit: (value: string) => {
                  props.onUpdate?.({
                    id: comment.id,
                    comment: value,
                    selection: cloneSelectedLineRange(comment.selection),
                  })
                  note.cancelDraft()
                },
                cancelLabel: i18n.t("ui.lineComment.cancel"),
                submitLabel: props.editSubmitLabel,
                mention: props.mention,
              }
            : undefined
        },
        onMouseEnter: () => {
          if (note.commenting()) return
          note.hoverComment(comment.selection)
        },
        onClick: () => {
          if (note.isEditing(comment.id)) return
          note.toggleComment(comment.id, comment.selection)
        },
      }
    },
    renderDraft: (range) => ({
      get value() {
        return note.draft()
      },
      selection: formatSelectedLineLabel(range, i18n.t),
      onInput: note.setDraft,
      onCancel: () => {
        note.cancelDraft()
        note.select(null)
      },
      onSubmit: (comment) => {
        props.onSubmit({ comment, selection: cloneSelectedLineRange(range) })
        note.cancelDraft()
        note.select(null)
      },
      cancelLabel: i18n.t("ui.lineComment.cancel"),
      submitLabel: i18n.t("ui.lineComment.submit"),
      mention: props.mention,
    }),
  })

  const renderGutterUtility = createLineCommentGutterRenderer({
    label: props.label,
    getSelectedRange: () => {
      if (note.opened()) return null
      return note.selected()
    },
    onOpenDraft: note.openDraft,
  })

  const onLineSelected = (range: SelectedLineRange | null) => {
    if (!range) {
      note.select(null)
      note.cancelDraft()
      return
    }

    note.select(range)
  }

  const onLineSelectionEnd = (range: SelectedLineRange | null) => {
    if (!range) {
      note.cancelDraft()
      return
    }

    note.openDraft(range)
  }

  const onLineNumberSelectionEnd = (range: SelectedLineRange | null) => {
    if (!range) return
    note.openDraft(range)
  }

  return {
    note,
    annotations,
    renderAnnotation,
    renderGutterUtility,
    onLineSelected,
    onLineSelectionEnd,
    onLineNumberSelectionEnd,
  }
}
