/**
 * dsh-channels —— Web 面板（Discord 式三栏）。
 *
 * 纯文本渲染、只用 React + fetch/EventSource，样式见 `./styles.ts`。
 * 所有网络调用都走 `./api.ts`，失败只显示内联错误，不允许把面板打崩；
 * host 没起来时降级成「离线 + 重试」状态。
 */

import * as React from 'react'
import {
  DEFAULT_CHANNEL,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_TEXT_BYTES,
  SEARCH_LIMIT,
  excerpt,
  humanSize,
  isInlineImageMime,
  isValidChannelId,
  isValidHandle,
  normalizeHandle,
  parseMentions,
  utf8Bytes,
  type Attachment,
  type AuthorSnapshot,
  type ChannelMessage,
  type ChannelMeta,
  type Participant,
  type ParticipantKind,
  type ParticipantStatus,
  type SearchHit,
} from '../contract.js'
import * as api from './api.js'

/* ------------------------------------------------------------------ */
/* 常量 / 类型                                                         */
/* ------------------------------------------------------------------ */

/** 每次翻页条数（GET /history 的 limit）。 */
const HISTORY_PAGE = 50
/** 距离底部多少像素算「贴在底部」。 */
const NEAR_BOTTOM_PX = 64
/** 连续同一作者多久内合并成一组（ms）。 */
const GROUP_WINDOW_MS = 5 * 60_000
/** 单频道内存里最多保留多少条消息（更早的靠 beforeSeq 再取）。 */
const MAX_MESSAGES = 1200
/** 跳转后高亮持续多久（task-7：2s）。 */
const HIGHLIGHT_MS = 2000
/** 搜索框输入去抖（ms）；Enter 立即查。 */
const SEARCH_DEBOUNCE_MS = 320
/** 单次粘贴/拖拽的并发上传上限（与契约数量上限一致，避免打爆浏览器连接数）。 */
const UPLOAD_CONCURRENCY = 4

type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting'

interface ChannelStore {
  messages: ChannelMessage[]
  hasMore: boolean
  loaded: boolean
  loading: boolean
  loadingOlder: boolean
  error: string | null
}

interface PendingMessage {
  clientMsgId: string
  channel: string
  text: string
  replyTo?: ChannelMessage
  mentions: string[]
  /** 发送时附带的已上传附件（乐观显示用；重试不再重传）。 */
  attachments: Attachment[]
  createdAt: string
  status: 'sending' | 'failed'
  error?: string
  author: AuthorSnapshot
}

/** Composer 里一个待发送附件的本地状态（上传前/中/失败/完成）。 */
export interface DraftAttachment {
  /** 本地 key（React key + 重试定位；与服务器 id 无关）。 */
  key: string
  /** 原始数据：重试时直接复用，不需要用户重选文件。 */
  blob: Blob
  name: string
  mime: string
  size: number
  status: 'uploading' | 'ready' | 'failed'
  /** status==='ready' 时的服务端附件。 */
  attachment?: Attachment
  error?: string
}

function emptyStore(): ChannelStore {
  return { messages: [], hasMore: false, loaded: false, loading: false, loadingOlder: false, error: null }
}

const EMPTY_MESSAGES: readonly ChannelMessage[] = []

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}

function toDate(ts: string): Date | null {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? null : date
}

/** YYYY-MM-DD HH:MM (local time): channel history spans days, so the date is always visible. */
function formatClock(ts: string): string {
  const date = toDate(ts)
  if (date === null) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatFull(ts: string): string {
  const date = toDate(ts)
  return date === null ? '' : date.toLocaleString()
}

function dayKey(ts: string): string {
  const date = toDate(ts)
  return date === null ? '' : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function dayLabel(ts: string): string {
  const date = toDate(ts)
  if (date === null) return ''
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfToday - startOfDay) / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

const KIND_LABEL: Record<ParticipantKind, string> = {
  human: '人类',
  'dsh-agent': 'DSH',
  external: '外部',
}

const STATUS_LABEL: Record<ParticipantStatus, string> = {
  online: '在线',
  idle: '空闲',
  offline: '离线',
}

function kindLabel(kind: ParticipantKind): string {
  return KIND_LABEL[kind]
}

function statusLabel(status: ParticipantStatus): string {
  return STATUS_LABEL[status]
}

/** Short relative age for quiet members ("5 分钟前", "6 小时前"). */
function relativeAge(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function kindClass(kind: ParticipantKind): string {
  return kind === 'human' ? 'is-human' : kind === 'dsh-agent' ? 'is-dsh-agent' : 'is-external'
}

function authorInitial(author: AuthorSnapshot): string {
  const source = author.displayName !== '' ? author.displayName : author.handle
  const first = source.trim().charAt(0)
  return first === '' ? '?' : first.toUpperCase()
}

function mergeMessages(existing: readonly ChannelMessage[], incoming: readonly ChannelMessage[]): ChannelMessage[] {
  const byId = new Map<string, ChannelMessage>()
  for (const message of existing) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)
  const merged = [...byId.values()].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts))
  if (merged.length > MAX_MESSAGES) merged.splice(0, merged.length - MAX_MESSAGES)
  return merged
}

interface ChannelGroup {
  category: string
  channels: api.ChannelView[]
}

function groupChannels(channels: readonly api.ChannelView[]): ChannelGroup[] {
  const groups = new Map<string, api.ChannelView[]>()
  for (const channel of channels) {
    const category = channel.category !== undefined && channel.category.trim() !== '' ? channel.category.trim() : '未分类'
    const bucket = groups.get(category)
    if (bucket === undefined) groups.set(category, [channel])
    else bucket.push(channel)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '未分类' ? 1 : 0) - (b === '未分类' ? 1 : 0) || a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      channels: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

/** 纯文本 + @提及高亮（不解释任何 HTML）。 */
function RichText({ text, mentions }: { text: string; mentions: readonly string[] }): React.ReactElement {
  const handles = mentions.length > 0 ? mentions : parseMentions(text)
  if (handles.length === 0) return <>{text}</>
  const wanted = new Set(handles.map((handle) => handle.toLowerCase()))
  const parts: React.ReactNode[] = []
  const pattern = /@([a-z0-9_-]{2,24})/gi
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const handle = (match[1] ?? '').toLowerCase()
    if (!wanted.has(handle)) continue
    if (match.index > consumed) parts.push(text.slice(consumed, match.index))
    parts.push(
      <span key={`${match.index}:${handle}`} className="dshch-mention">
        {match[0]}
      </span>,
    )
    consumed = match.index + match[0].length
  }
  if (consumed < text.length) parts.push(text.slice(consumed))
  return <>{parts}</>
}

/* ------------------------------------------------------------------ */
/* 附件渲染                                                            */
/* ------------------------------------------------------------------ */

interface AttachmentListProps {
  attachments: readonly Attachment[]
  /** 点击内联图片 → 打开 lightbox。 */
  onOpenImage: (attachment: Attachment) => void
}

/**
 * 一条消息里的附件：图片内联缩略（点击放大），其它文件显示名/大小/下载。
 * 纯 DOM 渲染，不拼接 HTML；非图片 mime 一律走下载链接（SPEC §7.5）。
 */
function AttachmentList({ attachments, onOpenImage }: AttachmentListProps): React.ReactElement | null {
  if (attachments.length === 0) return null
  const images = attachments.filter((attachment) => isInlineImageMime(attachment.mime))
  const files = attachments.filter((attachment) => !isInlineImageMime(attachment.mime))
  return (
    <div className="dshch-attachments">
      {images.length > 0 && (
        <div className="dshch-att-images">
          {images.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="dshch-att-image-btn"
              title={`${attachment.name} · ${humanSize(attachment.size)}（点击放大）`}
              aria-label={`查看图片 ${attachment.name}`}
              onClick={() => onOpenImage(attachment)}
            >
              <img className="dshch-att-image" src={attachment.url} alt={attachment.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {files.map((attachment) => (
        <div key={attachment.id} className="dshch-att-file" title={`${attachment.name} · ${attachment.mime}`}>
          <span className="dshch-att-file-icon" aria-hidden="true">
            📄
          </span>
          <span className="dshch-att-file-name">{attachment.name}</span>
          <span className="dshch-att-size">{humanSize(attachment.size)}</span>
          <a className="dshch-att-dl" href={attachment.url} download={attachment.name} target="_blank" rel="noreferrer">
            下载
          </a>
        </div>
      ))}
    </div>
  )
}

/** 待发送附件在 composer 里的 chips（上传中 / 失败重试 / 移除）。 */
interface DraftChipsProps {
  drafts: readonly DraftAttachment[]
  disabled: boolean
  onRemove: (key: string) => void
  onRetry: (key: string) => void
}

function DraftChips({ drafts, disabled, onRemove, onRetry }: DraftChipsProps): React.ReactElement | null {
  if (drafts.length === 0) return null
  return (
    <div className="dshch-chips" aria-label="待发送附件">
      {drafts.map((draft) => (
        <span
          key={draft.key}
          className={cx(
            'dshch-chip',
            draft.status === 'uploading' && 'is-uploading',
            draft.status === 'failed' && 'is-failed',
          )}
          title={draft.error !== undefined && draft.error !== '' ? draft.error : `${draft.name} · ${humanSize(draft.size)}`}
        >
          <span className="dshch-chip-icon" aria-hidden="true">
            {isInlineImageMime(draft.mime) ? '🖼' : '📄'}
          </span>
          <span className="dshch-chip-name">{draft.name}</span>
          <span className="dshch-chip-size">{humanSize(draft.size)}</span>
          {draft.status === 'uploading' && <span className="dshch-chip-state">上传中…</span>}
          {draft.status === 'failed' && (
            <button type="button" className="dshch-chip-retry" onClick={() => onRetry(draft.key)} disabled={disabled}>
              重试
            </button>
          )}
          <button type="button" className="dshch-chip-x" title="移除附件" aria-label={`移除 ${draft.name}`} onClick={() => onRemove(draft.key)}>
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}

/** 图片放大浮层：点击空白 / Esc 关闭，可另开新窗口看原图。 */
interface LightboxProps {
  attachment: Attachment
  onClose: () => void
}

function Lightbox({ attachment, onClose }: LightboxProps): React.ReactElement {
  return (
    <div className="dshch-lightbox" role="dialog" aria-modal="true" aria-label={`图片预览：${attachment.name}`} onClick={onClose}>
      <div className="dshch-lightbox-bar" onClick={(event) => event.stopPropagation()}>
        <span className="dshch-lightbox-name">{attachment.name}</span>
        <span className="dshch-att-size">{humanSize(attachment.size)}</span>
        <a className="dshch-link-btn" href={attachment.url} target="_blank" rel="noreferrer">
          新窗口打开
        </a>
        <button type="button" className="dshch-icon-btn" title="关闭（Esc）" aria-label="关闭图片预览" onClick={onClose}>
          ✕
        </button>
      </div>
      <img
        className="dshch-lightbox-img"
        src={attachment.url}
        alt={attachment.name}
        onClick={(event) => event.stopPropagation()}
      />
      <div className="dshch-lightbox-hint">点击空白处或按 Esc 关闭</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 检索文本高亮                                                        */
/* ------------------------------------------------------------------ */

/** 把查询词按空白切分成词（去重、忽略大小写），供高亮使用。 */
function searchTerms(query: string): string[] {
  const out: string[] = []
  for (const raw of query.split(/\s+/)) {
    const term = raw.trim()
    if (term === '') continue
    if (!out.some((item) => item.toLowerCase() === term.toLowerCase())) out.push(term)
  }
  return out
}

/** 片段里高亮查询词（纯文本分片，不注入 HTML）。 */
function HighlightedSnippet({ text, query }: { text: string; query: string }): React.ReactElement {
  const terms = searchTerms(query)
  if (terms.length === 0 || text === '') return <>{text}</>
  const escaped = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((term) => term !== '')
  if (escaped.length === 0) return <>{text}</>
  const lowered = new Set(terms.map((term) => term.toLowerCase()))
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'))
  return (
    <>
      {parts.map((part, index) =>
        lowered.has(part.toLowerCase()) ? (
          <mark key={`${index}:${part}`} className="dshch-hl">
            {part}
          </mark>
        ) : (
          <span key={`${index}:${part}`}>{part}</span>
        ),
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 消息行                                                              */
/* ------------------------------------------------------------------ */

interface MessageRowProps {
  message: ChannelMessage
  grouped: boolean
  pinned: boolean
  highlighted: boolean
  canModify: boolean
  onReply: (message: ChannelMessage) => void
  onTogglePin: (message: ChannelMessage) => void
  onJump: (messageId: string) => void
  onOpenImage: (attachment: Attachment) => void
}

function MessageRow(props: MessageRowProps): React.ReactElement {
  const { message } = props
  const author = message.author
  const replyTo = message.replyTo
  const attachments = message.attachments ?? []
  return (
    <div
      className={cx('dshch-msg', kindClass(author.kind), props.grouped && 'is-grouped', props.highlighted && 'is-highlighted')}
      data-dshch-msg={message.id}
    >
      <div className={cx('dshch-msg-avatar', kindClass(author.kind), props.grouped && 'is-ghost')} aria-hidden="true">
        {authorInitial(author)}
      </div>
      <div className="dshch-msg-body">
        {!props.grouped && (
          <div className="dshch-msg-head">
            <span className="dshch-author-name">{author.displayName}</span>
            <span className="dshch-author-handle">@{author.handle}</span>
            <span className="dshch-kind-tag">{kindLabel(author.kind)}</span>
            {message.kind === 'announcement' && <span className="dshch-pin-mark">📢 公告</span>}
            {props.pinned && (
              <span className="dshch-pin-mark" title="已置顶">
                📌
              </span>
            )}
            <time className="dshch-msg-time" dateTime={message.ts} title={formatFull(message.ts)}>
              {formatClock(message.ts)}
            </time>
          </div>
        )}
        {replyTo !== undefined && (
          <button
            type="button"
            className="dshch-reply-quote"
            title={`跳到 @${replyTo.authorName} 的消息`}
            onClick={() => props.onJump(replyTo.id)}
          >
            <span className="dshch-reply-bar" aria-hidden="true" />
            <span className="dshch-reply-author">{replyTo.authorName}</span>
            <span className="dshch-reply-text">{excerpt(replyTo.excerpt, 90)}</span>
          </button>
        )}
        {message.text !== '' && (
          <div className="dshch-msg-text">
            <RichText text={message.text} mentions={message.mentions} />
          </div>
        )}
        <AttachmentList attachments={attachments} onOpenImage={props.onOpenImage} />
      </div>
      {props.canModify && (
        <div className="dshch-msg-actions">
          <button type="button" className="dshch-action-btn" title="回复这条消息" onClick={() => props.onReply(message)}>
            回复
          </button>
          <button
            type="button"
            className="dshch-action-btn"
            title={props.pinned ? '取消置顶' : '置顶到本频道'}
            onClick={() => props.onTogglePin(message)}
          >
            {props.pinned ? '取消置顶' : '置顶'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 乐观发送中的消息                                                    */
/* ------------------------------------------------------------------ */

interface PendingRowProps {
  pending: PendingMessage
  onRetry: (clientMsgId: string) => void
  onOpenImage: (attachment: Attachment) => void
}

function PendingRow({ pending, onRetry, onOpenImage }: PendingRowProps): React.ReactElement {
  const failed = pending.status === 'failed'
  const replyTo = pending.replyTo
  return (
    <div className={cx('dshch-pending', failed && 'is-failed')}>
      <div className={cx('dshch-msg-avatar', kindClass(pending.author.kind))} aria-hidden="true">
        {authorInitial(pending.author)}
      </div>
      <div className="dshch-msg-body">
        <div className="dshch-msg-head">
          <span className="dshch-author-name">{pending.author.displayName}</span>
          <span className="dshch-author-handle">@{pending.author.handle}</span>
          <span className="dshch-kind-tag">我</span>
        </div>
        {replyTo !== undefined && (
          <div className="dshch-reply-quote">
            <span className="dshch-reply-bar" aria-hidden="true" />
            <span className="dshch-reply-author">{replyTo.author.handle}</span>
            <span className="dshch-reply-text">{excerpt(replyTo.text, 90)}</span>
          </div>
        )}
        {pending.text !== '' && (
          <div className="dshch-pending-text">
            <RichText text={pending.text} mentions={pending.mentions} />
          </div>
        )}
        <AttachmentList attachments={pending.attachments} onOpenImage={onOpenImage} />
        <div className="dshch-pending-note">
          {failed ? (
            <>
              <span>发送失败{pending.error !== undefined && pending.error !== '' ? `：${pending.error}` : ''}</span>
              <button type="button" className="dshch-retry" onClick={() => onRetry(pending.clientMsgId)}>
                重试
              </button>
            </>
          ) : (
            <span>发送中…</span>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 输入框（含 @ 自动补全 / 引用条 / Enter 发送）                        */
/* ------------------------------------------------------------------ */

export interface ComposerHandle {
  focus: () => void
  insertMention: (handle: string) => void
}

interface ComposerProps {
  channelName: string
  disabled: boolean
  disabledHint: string
  identityHandle: string
  replyTo: ChannelMessage | null
  members: readonly Participant[]
  maxBytes: number
  /** 待发送附件（上传中 / 就绪 / 失败）。 */
  drafts: readonly DraftAttachment[]
  /** 附件相关的内联错误（超限、上传失败等）。 */
  draftsError: string | null
  onCancelReply: () => void
  onSend: (text: string) => void
  /** 选择/拖拽/粘贴进来的文件交给面板去校验+上传。 */
  onPickFiles: (files: readonly File[]) => void
  onRemoveDraft: (key: string) => void
  onRetryDraft: (key: string) => void
}

interface MentionOption {
  handle: string
  label: string
  hint: string
}

const Composer = React.forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const [draft, setDraft] = React.useState('')
  const [mention, setMention] = React.useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = React.useState(0)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const bytes = utf8Bytes(draft)
  const overLimit = bytes > props.maxBytes
  const readyCount = props.drafts.filter((item) => item.status === 'ready').length
  const uploadingCount = props.drafts.filter((item) => item.status === 'uploading').length
  const failedCount = props.drafts.filter((item) => item.status === 'failed').length
  /** 还有附件没上传完/上传失败时不允许发送（失败项需重试或移除）。 */
  const attachmentsBlocking = uploadingCount > 0 || failedCount > 0
  const canSend = !props.disabled && !overLimit && !attachmentsBlocking && (draft.trim() !== '' || readyCount > 0)

  React.useImperativeHandle(
    ref,
    () => ({
      focus(): void {
        textareaRef.current?.focus()
      },
      insertMention(handle: string): void {
        setDraft((previous) => (previous === '' || /\s$/.test(previous) ? `${previous}@${handle} ` : `${previous} @${handle} `))
        setMention(null)
        window.requestAnimationFrame(() => textareaRef.current?.focus())
      },
    }),
    [],
  )

  React.useLayoutEffect(() => {
    const node = textareaRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [draft])

  const mentionOptions = React.useMemo<MentionOption[]>(() => {
    if (mention === null) return []
    const query = mention.query.toLowerCase()
    const options: MentionOption[] = []
    if (query === '' || 'all'.startsWith(query)) {
      options.push({ handle: 'all', label: '所有人', hint: '@all 会唤醒所有已绑定的 DSH 参与者' })
    }
    for (const participant of props.members) {
      if (participant.handle === props.identityHandle) continue
      const handle = participant.handle.toLowerCase()
      if (query !== '' && !handle.startsWith(query) && !participant.displayName.toLowerCase().includes(query)) continue
      options.push({
        handle: participant.handle,
        label: participant.displayName,
        hint: `@${participant.handle} · ${kindLabel(participant.kind)}`,
      })
      if (options.length >= 9) break
    }
    return options.slice(0, 9)
  }, [mention, props.members, props.identityHandle])

  const syncMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const matched = /(?:^|[\s([{])@([a-z0-9_-]{0,24})$/i.exec(before)
    if (matched === null) {
      if (mention !== null) setMention(null)
      return
    }
    const query = (matched[1] ?? '').toLowerCase()
    setMention({ start: caret - query.length - 1, query })
    setMentionIndex(0)
  }

  const applyMention = (handle: string): void => {
    if (mention === null) return
    const node = textareaRef.current
    const caret = node?.selectionStart ?? draft.length
    const start = mention.start
    const next = `${draft.slice(0, start)}@${handle} ${draft.slice(caret)}`
    setDraft(next)
    setMention(null)
    window.requestAnimationFrame(() => {
      const again = textareaRef.current
      if (again === null) return
      again.focus()
      const position = start + handle.length + 2
      again.setSelectionRange(position, position)
    })
  }

  /** 把一批 File 交给面板（面板负责数量/大小校验与上传）。 */
  const pickFiles = (files: readonly File[]): void => {
    if (files.length === 0) return
    props.onPickFiles(files)
  }

  const openFilePicker = (): void => {
    const input = fileInputRef.current
    if (input === null) return
    input.click()
  }

  const submit = (): void => {
    if (!canSend) return
    const text = draft.trim()
    props.onSend(text)
    setDraft('')
    setMention(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    const option = mentionOptions[mentionIndex]
    if (mention !== null && mentionOptions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => (index + 1) % mentionOptions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        if (option !== undefined) applyMention(option.handle)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    if (event.key === 'Escape' && props.replyTo !== null) {
      event.preventDefault()
      props.onCancelReply()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="dshch-composer-wrap">
      {mention !== null && mentionOptions.length > 0 && (
        <div className="dshch-mention-menu" role="listbox" aria-label="提及成员">
          {mentionOptions.map((option, index) => (
            <button
              key={option.handle}
              type="button"
              role="option"
              aria-selected={index === mentionIndex}
              className={cx('dshch-mention-item', index === mentionIndex && 'is-active')}
              onMouseDown={(event) => {
                event.preventDefault()
                applyMention(option.handle)
              }}
              onMouseEnter={() => setMentionIndex(index)}
            >
              <span className="dshch-mention-label">{option.label}</span>
              <span className="dshch-mention-handle" title={option.hint}>
                @{option.handle}
              </span>
            </button>
          ))}
        </div>
      )}
      {props.replyTo !== null && (
        <div className="dshch-reply-preview">
          <span className="dshch-reply-bar" aria-hidden="true" />
          <span className="dshch-reply-preview-main">
            回复 <strong>@{props.replyTo.author.handle}</strong>：{excerpt(props.replyTo.text, 100)}
          </span>
          <button type="button" className="dshch-icon-btn" title="取消引用" onClick={props.onCancelReply}>
            ✕
          </button>
        </div>
      )}
      <DraftChips drafts={props.drafts} disabled={props.disabled} onRemove={props.onRemoveDraft} onRetry={props.onRetryDraft} />
      {props.draftsError !== null && props.draftsError !== '' && <div className="dshch-attach-error">{props.draftsError}</div>}
      <div className="dshch-composer">
        <input
          ref={fileInputRef}
          className="dshch-file-input"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const input = event.currentTarget
            const files = Array.from(input.files ?? [])
            // 清空 value，保证连续选同一个文件也会触发 change。
            input.value = ''
            pickFiles(files)
          }}
        />
        <button
          type="button"
          className="dshch-attach-btn"
          title={`添加附件（最多 ${MAX_ATTACHMENTS} 个 · 单个 ≤ ${humanSize(MAX_ATTACHMENT_BYTES)} · 合计 ≤ ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)}）`}
          aria-label="添加附件"
          disabled={props.disabled || props.drafts.length >= MAX_ATTACHMENTS}
          onClick={openFilePicker}
        >
          📎
        </button>
        <span className="dshch-channel-tag" aria-hidden="true">
          #{props.channelName}
        </span>
        <textarea
          ref={textareaRef}
          className="dshch-textarea"
          rows={1}
          value={draft}
          disabled={props.disabled}
          placeholder={
            props.disabled
              ? props.disabledHint
              : `发消息到 #${props.channelName}（Enter 发送，Shift+Enter 换行，可粘贴图片）`
          }
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? [])
            if (files.length === 0) return
            // 只有剪贴板里真的有文件时才接管，普通文本粘贴不受影响。
            event.preventDefault()
            pickFiles(files)
          }}
          onChange={(event) => {
            const value = event.currentTarget.value
            const caret = event.currentTarget.selectionStart ?? value.length
            setDraft(value)
            syncMention(value, caret)
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === 'Tab') return
            const node = event.currentTarget
            syncMention(node.value, node.selectionStart ?? node.value.length)
          }}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
        />
        <button type="button" className="dshch-send" disabled={!canSend} onClick={submit}>
          {uploadingCount > 0 ? '上传中…' : '发送'}
        </button>
      </div>
      <div className="dshch-composer-hint">
        <span>
          {attachmentsBlocking
            ? uploadingCount > 0
              ? `附件上传中（${uploadingCount}）…`
              : `有 ${failedCount} 个附件上传失败，请重试或移除`
            : 'Enter 发送 · Shift+Enter 换行 · @ 提及成员 · 📎 拖拽/粘贴上传'}
        </span>
        {bytes > props.maxBytes * 0.85 && (
          <span className={cx('dshch-counter', overLimit && 'is-over')}>
            {bytes}/{props.maxBytes} 字节
          </span>
        )}
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* 成员栏                                                              */
/* ------------------------------------------------------------------ */

interface MemberListProps {
  members: readonly Participant[]
  loading: boolean
  currentHandle: string
  onMention: (handle: string) => void
  onRefresh: () => void
}

const STATUS_ORDER: readonly ParticipantStatus[] = ['online', 'idle', 'offline']

function MemberList(props: MemberListProps): React.ReactElement {
  const groups = React.useMemo(() => {
    const result: Array<{ status: ParticipantStatus; items: Participant[] }> = []
    for (const status of STATUS_ORDER) {
      const items = props.members
        .filter((member) => member.status === status)
        .sort((a, b) => a.handle.localeCompare(b.handle))
      if (items.length > 0) result.push({ status, items })
    }
    return result
  }, [props.members])

  return (
    <aside className="dshch-col-right">
      <div className="dshch-right-head">
        <span>成员 · {props.members.length}</span>
        <button type="button" className="dshch-icon-btn" title="刷新成员" aria-label="刷新成员" onClick={props.onRefresh}>
          {props.loading ? <span className="dshch-spinner" /> : '⟳'}
        </button>
      </div>
      <div className="dshch-right-scroll">
        {props.members.length === 0 && (
          <div className="dshch-empty">
            <span>{props.loading ? '成员加载中…' : '暂无成员'}</span>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.status}>
            <div className="dshch-member-group">
              {statusLabel(group.status)} — {group.items.length}
            </div>
            {group.items.map((member) => (
              <button
                key={member.id}
                type="button"
                className={cx('dshch-member', member.status === 'offline' && 'is-offline')}
                title={`@${member.handle} · ${kindLabel(member.kind)}${member.harness !== 'other' ? ` · ${member.harness}` : ''}${member.admin === true ? ' · 频道管理员' : ''}${member.muted === true ? ' · 已禁言' : ''}（点击插入 @提及）`}
                onClick={() => props.onMention(member.handle)}
              >
                <span className={cx('dshch-status-dot', `is-${member.status}`)} aria-hidden="true" />
                <span className="dshch-member-main">
                  {member.displayName}
                  {member.handle === props.currentHandle && <span className="dshch-member-handle">（我）</span>}
                  {member.admin === true && <span className="dshch-member-badge">管理员</span>}
                  {member.muted === true && <span className="dshch-member-badge is-muted">禁言</span>}
                </span>
                {member.status !== 'online' && <span className="dshch-member-seen">{relativeAge(member.lastSeen)}</span>}
                {member.harness !== 'other' && <span className="dshch-member-tag">{member.harness}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* 置顶抽屉                                                            */
/* ------------------------------------------------------------------ */

interface PinDrawerProps {
  pins: readonly api.PinWire[]
  loading: boolean
  onClose: () => void
  onJump: (messageId: string) => void
  onUnpin: (messageId: string) => void
}

function PinDrawer(props: PinDrawerProps): React.ReactElement {
  return (
    <>
      <div className="dshch-pins-backdrop" onClick={props.onClose} aria-hidden="true" />
      <div className="dshch-pins-drawer" role="dialog" aria-label="置顶消息">
        <div className="dshch-pins-head">
          <span>📌 置顶消息 · {props.pins.length}</span>
          <button type="button" className="dshch-icon-btn" title="关闭" aria-label="关闭置顶抽屉" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="dshch-pins-list">
          {props.loading && props.pins.length === 0 && (
            <div className="dshch-empty">
              <div className="dshch-spinner" />
              <span>加载置顶…</span>
            </div>
          )}
          {!props.loading && props.pins.length === 0 && (
            <div className="dshch-empty">
              <span className="dshch-empty-icon">📌</span>
              <span>还没有置顶消息</span>
              <span>鼠标移到消息上点「置顶」</span>
            </div>
          )}
          {props.pins.map((pin) => (
            <div key={pin.messageId} className="dshch-pin-item">
              <div className="dshch-pin-meta">
                <span className="dshch-pin-author">@{pin.message?.author.handle ?? pin.by ?? '未知'}</span>
                {pin.at !== '' && <span>{formatFull(pin.at)}</span>}
              </div>
              <div className="dshch-pin-text">
                {pin.message !== undefined ? <RichText text={pin.message.text} mentions={pin.message.mentions} /> : '（消息内容未加载）'}
              </div>
              <div className="dshch-pin-actions">
                <button type="button" className="dshch-action-btn" onClick={() => props.onJump(pin.messageId)}>
                  跳转
                </button>
                <button type="button" className="dshch-action-btn" onClick={() => props.onUnpin(pin.messageId)}>
                  取消置顶
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 建频道 / 改名 表单                                                   */
/* ------------------------------------------------------------------ */

interface CreateChannelFormProps {
  creating: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (id: string, name: string, category: string) => void
}

function CreateChannelForm(props: CreateChannelFormProps): React.ReactElement {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [localError, setLocalError] = React.useState<string | null>(null)

  const submit = (): void => {
    const slug = id.trim().toLowerCase()
    if (!isValidChannelId(slug)) {
      setLocalError('频道 id 需为 1-32 位小写字母/数字/短横线，且以字母或数字开头')
      return
    }
    setLocalError(null)
    props.onSubmit(slug, name.trim() === '' ? slug : name.trim(), category.trim())
  }

  return (
    <form
      className="dshch-left-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="dshch-form-row">
        <input
          className="dshch-input"
          value={id}
          placeholder="频道 id（如 dev-log）"
          aria-label="频道 id"
          onChange={(event) => setId(event.currentTarget.value)}
        />
      </div>
      <div className="dshch-form-row">
        <input
          className="dshch-input"
          value={name}
          placeholder="显示名（默认同 id）"
          aria-label="频道显示名"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </div>
      <div className="dshch-form-row">
        <input
          className="dshch-input"
          value={category}
          placeholder="分类（可选）"
          aria-label="频道分类"
          onChange={(event) => setCategory(event.currentTarget.value)}
        />
      </div>
      {(localError ?? props.error) !== null && <div className="dshch-form-error">{localError ?? props.error}</div>}
      <div className="dshch-form-actions">
        <button type="button" className="dshch-btn" onClick={props.onCancel}>
          取消
        </button>
        <button type="submit" className="dshch-btn dshch-btn-primary" disabled={props.creating || id.trim() === ''}>
          {props.creating ? '创建中…' : '创建'}
        </button>
      </div>
    </form>
  )
}

interface RenameFormProps {
  currentHandle: string
  saving: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (handle: string) => void
}

function RenameForm(props: RenameFormProps): React.ReactElement {
  const [handle, setHandle] = React.useState(props.currentHandle)
  const [localError, setLocalError] = React.useState<string | null>(null)

  const submit = (): void => {
    const normalized = normalizeHandle(handle)
    if (!isValidHandle(normalized)) {
      setLocalError('handle 需为 2-24 位小写字母/数字/下划线/短横线，且不能是保留字')
      return
    }
    setLocalError(null)
    props.onSubmit(normalized)
  }

  return (
    <form
      className="dshch-left-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="dshch-form-row">
        <input
          className="dshch-input"
          value={handle}
          placeholder="新 handle，如 alice-01"
          aria-label="新 handle"
          onChange={(event) => setHandle(event.currentTarget.value)}
        />
      </div>
      {(localError ?? props.error) !== null && <div className="dshch-form-error">{localError ?? props.error}</div>}
      <div className="dshch-form-actions">
        <button type="button" className="dshch-btn" onClick={props.onCancel}>
          取消
        </button>
        <button type="submit" className="dshch-btn dshch-btn-primary" disabled={props.saving}>
          {props.saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ */
/* 频道管理对话框                                                       */
/* ------------------------------------------------------------------ */

interface ChannelSettingsProps {
  channel: api.ChannelView
  members: readonly Participant[]
  busy: boolean
  error: string | null
  onClose: () => void
  onToggleAdmin: (handle: string, admin: boolean) => void
  onMuteAll: (muted: boolean) => void
  onMuteMember: (handle: string, muted: boolean) => void
  onSaveLimits: (maxChars: number | null, ratePerMinute: number | null) => void
}

/**
 * 频道管理面板：任命管理员（仅人类）、全员禁言、成员禁言、发言限制。
 * 服务端仍会做权限校验；这里只是操作入口。
 */
function ChannelSettingsDialog(props: ChannelSettingsProps): React.ReactElement {
  const [maxChars, setMaxChars] = React.useState<string>(
    props.channel.maxChars === null || props.channel.maxChars === undefined ? '' : String(props.channel.maxChars),
  )
  const [ratePerMinute, setRatePerMinute] = React.useState<string>(
    props.channel.ratePerMinute === null || props.channel.ratePerMinute === undefined
      ? ''
      : String(props.channel.ratePerMinute),
  )
  const [adminCandidate, setAdminCandidate] = React.useState('')
  const [localError, setLocalError] = React.useState<string | null>(null)

  const admins = props.channel.admins ?? []
  const muted = props.channel.muted ?? []
  const agents = props.members.filter((member) => member.kind !== 'human')
  const candidates = agents.filter((member) => !admins.includes(member.handle))

  const submitLimits = (event: React.FormEvent): void => {
    event.preventDefault()
    const parse = (raw: string, min: number, max: number, label: string): number | null | undefined => {
      const text = raw.trim()
      if (text === '') return null
      const parsed = Number(text)
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        setLocalError(`${label}需为 ${min}-${max} 的整数，留空恢复默认`)
        return undefined
      }
      return parsed
    }
    const nextMax = parse(maxChars, 1, 8192, '单条字数上限')
    if (nextMax === undefined) return
    const nextRate = parse(ratePerMinute, 1, 600, '每分钟条数')
    if (nextRate === undefined) return
    setLocalError(null)
    props.onSaveLimits(nextMax, nextRate)
  }

  return (
    <>
      <div className="dshch-settings-backdrop" onClick={props.onClose} aria-hidden="true" />
      <div className="dshch-settings" role="dialog" aria-label="频道管理">
        <div className="dshch-settings-head">
          <span>⚙ 频道管理 · #{props.channel.name}</span>
          <button type="button" className="dshch-icon-btn" title="关闭" aria-label="关闭频道管理" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="dshch-settings-body">
          <section className="dshch-settings-section">
            <h4>管理员</h4>
            <div className="dshch-settings-hint">
              只有人类操作者可以任命/撤销子频道管理员。管理员可以全员禁言、禁言指定成员、设置发言限制。
            </div>
            {admins.length === 0 ? (
              <div className="dshch-settings-empty">还没有管理员</div>
            ) : (
              admins.map((handle) => (
                <div className="dshch-settings-row" key={handle}>
                  <code>@{handle}</code>
                  {props.channel.canAppointAdmins === true && (
                    <button
                      type="button"
                      className="dshch-link-btn"
                      disabled={props.busy}
                      onClick={() => props.onToggleAdmin(handle, false)}
                    >
                      撤销管理员
                    </button>
                  )}
                </div>
              ))
            )}
            {props.channel.canAppointAdmins === true && (
              <div className="dshch-settings-row">
                <select
                  className="dshch-settings-select"
                  value={adminCandidate}
                  aria-label="选择频道成员"
                  onChange={(event) => setAdminCandidate(event.currentTarget.value)}
                >
                  <option value="">选择频道成员…</option>
                  {candidates.map((member) => (
                    <option key={member.id} value={member.handle}>
                      @{member.handle}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="dshch-btn dshch-btn-outline"
                  disabled={props.busy || adminCandidate === ''}
                  onClick={() => {
                    if (adminCandidate === '') return
                    props.onToggleAdmin(adminCandidate, true)
                    setAdminCandidate('')
                  }}
                >
                  设为管理员
                </button>
              </div>
            )}
          </section>

          <section className="dshch-settings-section">
            <h4>全员禁言</h4>
            <div className="dshch-settings-row">
              <button
                type="button"
                className={cx('dshch-btn', props.channel.mutedAll === true ? 'dshch-btn-primary' : 'dshch-btn-outline')}
                disabled={props.busy || props.channel.canManage !== true}
                onClick={() => props.onMuteAll(props.channel.mutedAll !== true)}
              >
                {props.channel.mutedAll === true ? '解除全员禁言' : '开启全员禁言'}
              </button>
              <span className="dshch-settings-hint">
                开启后只有管理员和人类操作者能发言；agent 仍可读历史、仍会被 @ 唤醒。
              </span>
            </div>
          </section>

          <section className="dshch-settings-section">
            <h4>成员禁言</h4>
            {agents.length === 0 ? (
              <div className="dshch-settings-empty">这个频道还没有 agent 成员</div>
            ) : (
              agents.map((member) => {
                const isMuted = muted.includes(member.handle)
                const isAdmin = admins.includes(member.handle)
                return (
                  <div className="dshch-settings-row" key={member.id}>
                    <span>
                      @{member.handle}
                      {isAdmin && <em className="dshch-settings-tag">管理员</em>}
                    </span>
                    <button
                      type="button"
                      className="dshch-link-btn"
                      disabled={props.busy || props.channel.canManage !== true}
                      onClick={() => props.onMuteMember(member.handle, !isMuted)}
                    >
                      {isMuted ? '解除禁言' : '禁言'}
                    </button>
                  </div>
                )
              })
            )}
          </section>

          <form className="dshch-settings-section" onSubmit={submitLimits}>
            <h4>发言限制</h4>
            <div className="dshch-settings-row">
              <label className="dshch-settings-field">
                单条字数上限
                <input
                  className="dshch-settings-input"
                  inputMode="numeric"
                  value={maxChars}
                  placeholder="默认"
                  onChange={(event) => setMaxChars(event.currentTarget.value)}
                />
              </label>
              <label className="dshch-settings-field">
                每分钟条数
                <input
                  className="dshch-settings-input"
                  inputMode="numeric"
                  value={ratePerMinute}
                  placeholder="默认"
                  onChange={(event) => setRatePerMinute(event.currentTarget.value)}
                />
              </label>
            </div>
            <div className="dshch-settings-row">
              <button type="submit" className="dshch-btn dshch-btn-primary" disabled={props.busy || props.channel.canManage !== true}>
                {props.busy ? '保存中…' : '保存限制'}
              </button>
              <button
                type="button"
                className="dshch-link-btn"
                disabled={props.busy || props.channel.canManage !== true}
                onClick={() => {
                  setMaxChars('')
                  setRatePerMinute('')
                  props.onSaveLimits(null, null)
                }}
              >
                恢复默认
              </button>
            </div>
            <div className="dshch-settings-hint">
              范围：字数 1-8192，频率 1-600 条/分钟；留空恢复默认。人类操作者不受限制。
            </div>
          </form>

          {(localError ?? props.error) !== null && <div className="dshch-form-error">{localError ?? props.error}</div>}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 主面板                                                              */
/* ------------------------------------------------------------------ */

/**
 * 频道主面板：注册到 `main` keyed 槽（key = 'dsh-channels'）。
 * 未选中时由 shell 卸载，重新选中会重新连 SSE（history 走缓存，无副作用）。
 */
export function ChannelsPanel(): React.ReactElement {
  /* ---------- 状态 ---------- */
  const [identity, setIdentity] = React.useState<api.StoredIdentity | null>(() => api.readIdentity())
  const [identityState, setIdentityState] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [identityError, setIdentityError] = React.useState<string | null>(null)
  const [channels, setChannels] = React.useState<api.ChannelView[]>([])
  const [channelsLoaded, setChannelsLoaded] = React.useState(false)
  const [channelsError, setChannelsError] = React.useState<string | null>(null)
  const [activeChannel, setActiveChannel] = React.useState<string>(DEFAULT_CHANNEL)
  const [store, setStore] = React.useState<Record<string, ChannelStore>>({})
  const [members, setMembers] = React.useState<Participant[]>([])
  const [membersLoading, setMembersLoading] = React.useState(false)
  const [pins, setPins] = React.useState<api.PinWire[]>([])
  const [pinsLoading, setPinsLoading] = React.useState(false)
  const [showPins, setShowPins] = React.useState(false)
  const [showMembers, setShowMembers] = React.useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 900,
  )
  const [connection, setConnection] = React.useState<ConnectionState>('idle')
  const [offline, setOffline] = React.useState(false)
  const [banner, setBanner] = React.useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [unread, setUnread] = React.useState<Record<string, number>>({})
  const [pending, setPending] = React.useState<PendingMessage[]>([])
  const [replyTo, setReplyTo] = React.useState<ChannelMessage | null>(null)
  const [highlightId, setHighlightId] = React.useState<string | null>(null)
  const [newBelow, setNewBelow] = React.useState(0)
  const [announcement, setAnnouncement] = React.useState<{ channel: string; message: ChannelMessage } | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [createError, setCreateError] = React.useState<string | null>(null)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renaming, setRenaming] = React.useState(false)
  const [renameError, setRenameError] = React.useState<string | null>(null)
  /* --- 频道管理（管理员 / 禁言 / 发言限制） --- */
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsBusy, setSettingsBusy] = React.useState(false)
  const [settingsError, setSettingsError] = React.useState<string | null>(null)
  /* --- M3：附件 --- */
  const [drafts, setDrafts] = React.useState<DraftAttachment[]>([])
  const [draftsError, setDraftsError] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [lightbox, setLightbox] = React.useState<Attachment | null>(null)
  /* --- M3：检索 --- */
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchScope, setSearchScope] = React.useState<'all' | 'channel'>('all')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchHits, setSearchHits] = React.useState<SearchHit[]>([])
  const [searchLoading, setSearchLoading] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [searchHasMore, setSearchHasMore] = React.useState(false)

  /* ---------- refs（给 SSE / 异步回调读最新值） ---------- */
  const identityRef = React.useRef<api.StoredIdentity | null>(identity)
  const activeChannelRef = React.useRef<string>(activeChannel)
  const channelsRef = React.useRef<api.ChannelView[]>(channels)
  const storeRef = React.useRef<Record<string, ChannelStore>>(store)
  const pendingRef = React.useRef<PendingMessage[]>(pending)
  const replyToRef = React.useRef<ChannelMessage | null>(replyTo)
  const lastSeqRef = React.useRef<Record<string, number>>({})
  /** 本会话里已经读过的频道：本地已知更好，忽略服务器可能滞后的 unread。 */
  const localReadRef = React.useRef<Set<string>>(new Set())
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const composerRef = React.useRef<ComposerHandle | null>(null)
  const stickRef = React.useRef(true)
  const prevScrollHeightRef = React.useRef(0)
  const prependRef = React.useRef(false)
  const handleFrameRef = React.useRef<(frame: api.IncomingFrame) => void>(() => {})
  const bootstrapRef = React.useRef<() => void>(() => {})
  const refreshChannelsRef = React.useRef<() => void>(() => {})
  const loadLatestRef = React.useRef<(channel: string) => void>(() => {})
  /** 附件草稿镜像（上传回调里读最新值，不进 effect 依赖）。 */
  const draftsRef = React.useRef<DraftAttachment[]>([])
  /** 频道切换代数：切换后丢弃旧频道的上传结果。 */
  const draftGenRef = React.useRef(0)
  /** 拖拽深度（dragenter/dragleave 会因冒泡多次触发，用计数器防抖）。 */
  const dragDepthRef = React.useRef(0)
  /** 检索请求序号：只接受最新一次查询的响应（防竞态）。 */
  const searchSeqRef = React.useRef(0)
  /** 最新一次查询词（结果面板标题用；避免输入框已改而结果还是旧的时错位）。 */
  const searchDoneRef = React.useRef('')
  /** 防止 StrictMode / 并发调用造成重复注册（每次注册都会在 host 建一个新参与者）。 */
  const bootstrapInFlightRef = React.useRef(false)

  React.useEffect(() => {
    identityRef.current = identity
  }, [identity])
  React.useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  React.useEffect(() => {
    storeRef.current = store
  }, [store])
  React.useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  React.useEffect(() => {
    replyToRef.current = replyTo
  }, [replyTo])
  React.useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  React.useEffect(() => {
    // 切频道时清空待发送附件（避免 A 频道的附件被发到 B 频道）。
    draftGenRef.current += 1
    draftsRef.current = []
    setDrafts([])
    setDraftsError(null)
    setSettingsOpen(false)
    setSettingsError(null)
  }, [activeChannel])

  /* ---------- 稳定的小工具 ---------- */
  const reportError = React.useCallback((text: string) => {
    setBanner({ kind: 'error', text })
  }, [])

  const handleAuthFailure = React.useCallback((status: number, usedToken?: string): void => {
    if (status !== 401) return
    // 只有「当前 token」被拒才重注册；旧 token 的迟到请求不要打断新的身份。
    if (usedToken !== undefined && usedToken !== identityRef.current?.token) return
    api.clearIdentity()
    bootstrapRef.current()
  }, [])

  /** 用 host 的 ChannelView[] 刷新频道列表，并把服务器未读数合并进本地未读。 */
  const applyChannelViews = React.useCallback((views: readonly api.ChannelView[]) => {
    setChannels([...views])
    const active = activeChannelRef.current
    const readChannels = localReadRef.current
    setUnread((previous) => {
      let next: Record<string, number> | null = null
      for (const view of views) {
        if (view.id === active || readChannels.has(view.id)) continue
        const unread = view.unread ?? 0
        const local = (next ?? previous)[view.id] ?? 0
        if (unread <= local) continue
        if (next === null) next = { ...previous }
        next[view.id] = unread
      }
      return next ?? previous
    })
  }, [])

  const updateStore = React.useCallback(
    (updater: (previous: Record<string, ChannelStore>) => Record<string, ChannelStore>) => {
      setStore((previous) => {
        const next = updater(previous)
        storeRef.current = next
        return next
      })
    },
    [],
  )

  const commitPending = React.useCallback((updater: (previous: PendingMessage[]) => PendingMessage[]) => {
    setPending((previous) => {
      const next = updater(previous)
      pendingRef.current = next
      return next
    })
  }, [])

  const mergeInto = React.useCallback(
    (channel: string, incoming: readonly ChannelMessage[]) => {
      if (incoming.length === 0) return
      updateStore((previous) => {
        const current = previous[channel] ?? emptyStore()
        return {
          ...previous,
          [channel]: { ...current, messages: mergeMessages(current.messages, incoming) },
        }
      })
    },
    [updateStore],
  )

  const noteSeq = React.useCallback((channel: string, messages: readonly ChannelMessage[]) => {
    let last = lastSeqRef.current[channel] ?? 0
    for (const message of messages) {
      if (message.seq > last) last = message.seq
    }
    if (last > 0) lastSeqRef.current[channel] = last
  }, [])

  const clearUnread = React.useCallback((channel: string) => {
    localReadRef.current.add(channel)
    setUnread((previous) => {
      if ((previous[channel] ?? 0) === 0) return previous
      return { ...previous, [channel]: 0 }
    })
  }, [])

  const upsertMember = React.useCallback((participant: Participant) => {
    setMembers((previous) => {
      const index = previous.findIndex((member) => member.id === participant.id)
      if (index < 0) return [...previous, participant]
      const next = [...previous]
      const current = previous[index]
      // Presence frames do not carry channel-local flags; keep the admin/muted
      // badges learned from GET /members or a policy frame.
      next[index] = {
        ...current,
        ...participant,
        admin: participant.admin ?? current.admin,
        muted: participant.muted ?? current.muted,
      }
      return next
    })
  }, [])

  const upsertChannel = React.useCallback((channel: ChannelMeta) => {
    setChannels((previous) => {
      const index = previous.findIndex((item) => item.id === channel.id)
      if (index < 0) return [...previous, channel]
      const next = [...previous]
      next[index] = channel
      return next
    })
  }, [])

  /** 把频道管理 API / SSE 返回的策略合并进频道列表与成员标记。 */
  const applyChannelPolicyView = React.useCallback((view: api.ChannelView) => {
    setChannels((previous) =>
      previous.map((channel) => (channel.id === view.id ? { ...channel, ...view } : channel)),
    )
    if (view.id === activeChannelRef.current) {
      const admins = new Set(view.admins ?? [])
      const muted = new Set(view.muted ?? [])
      setMembers((previous) =>
        previous.map((member) => ({
          ...member,
          admin: admins.has(member.handle),
          muted: muted.has(member.handle),
        })),
      )
    }
  }, [])

  const runChannelSettingsAction = React.useCallback(
    async (action: () => Promise<api.ApiResult<api.ChannelView>>): Promise<void> => {
      setSettingsBusy(true)
      setSettingsError(null)
      const result = await action()
      setSettingsBusy(false)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        setSettingsError(result.message)
        return
      }
      applyChannelPolicyView(result.value)
    },
    [applyChannelPolicyView],
  )

  const toggleChannelAdmin = React.useCallback(
    (handle: string, admin: boolean): void => {
      void runChannelSettingsAction(() =>
        api.setChannelAdmin(activeChannelRef.current, handle, admin, identityRef.current?.token),
      )
    },
    [runChannelSettingsAction],
  )

  const setChannelMutedAll = React.useCallback(
    (muted: boolean): void => {
      void runChannelSettingsAction(() =>
        api.setChannelMute(activeChannelRef.current, { all: true, muted }, identityRef.current?.token),
      )
    },
    [runChannelSettingsAction],
  )

  const setChannelMemberMuted = React.useCallback(
    (handle: string, muted: boolean): void => {
      void runChannelSettingsAction(() =>
        api.setChannelMute(activeChannelRef.current, { handle, muted }, identityRef.current?.token),
      )
    },
    [runChannelSettingsAction],
  )

  const saveChannelLimits = React.useCallback(
    (maxChars: number | null, ratePerMinute: number | null): void => {
      void runChannelSettingsAction(() =>
        api.setChannelLimits(activeChannelRef.current, { maxChars, ratePerMinute }, identityRef.current?.token),
      )
    },
    [runChannelSettingsAction],
  )

  /* ---------- 身份 ---------- */
  const bootstrapIdentity = React.useCallback(async (): Promise<void> => {
    if (bootstrapInFlightRef.current) return
    bootstrapInFlightRef.current = true
    try {
      setIdentityState('loading')
      setIdentityError(null)
      const cached = api.readIdentity()
      if (cached !== null) {
        const check = await api.fetchWhoAmI(cached.token)
        if (check.ok) {
          if (check.value.participant !== null) {
            setIdentity(cached)
            setIdentityState('ready')
            setOffline(false)
            return
          }
        } else if (check.status === 401) {
          api.clearIdentity()
        } else if (check.status === 0) {
          // host 暂时不可达：先乐观复用本地身份，等 SSE/心跳恢复。
          setIdentity(cached)
          setIdentityState('ready')
          setOffline(true)
          return
        }
      }
      const registered = await api.registerHuman()
      if (!registered.ok) {
        if (registered.status === 0) setOffline(true)
        setIdentityError(registered.message)
        setIdentityState('error')
        return
      }
      api.writeIdentity(registered.value)
      setIdentity(registered.value)
      setIdentityState('ready')
      setOffline(false)
    } finally {
      bootstrapInFlightRef.current = false
    }
  }, [])

  React.useEffect(() => {
    bootstrapRef.current = () => {
      void bootstrapIdentity()
    }
  }, [bootstrapIdentity])

  React.useEffect(() => {
    void bootstrapIdentity()
  }, [bootstrapIdentity])

  /* ---------- 频道列表 ---------- */
  const refreshChannels = React.useCallback(async (): Promise<void> => {
    const token = identityRef.current?.token
    const result = await api.fetchChannels(token)
    setChannelsLoaded(true)
    if (!result.ok) {
      if (result.status === 0) setOffline(true)
      else handleAuthFailure(result.status, token)
      setChannelsError(result.message)
      return
    }
    setChannelsError(null)
    setOffline(false)
    applyChannelViews(result.value)
    setActiveChannel((previous) => {
      if (result.value.some((channel) => channel.id === previous)) return previous
      return result.value[0]?.id ?? previous
    })
  }, [applyChannelViews, handleAuthFailure])

  React.useEffect(() => {
    refreshChannelsRef.current = () => {
      void refreshChannels()
    }
  }, [refreshChannels])

  React.useEffect(() => {
    // 不依赖身份：host 的读接口在浏览器同源下可用；身份失败时也应能看历史。
    void refreshChannels()
  }, [identityState, refreshChannels])

  /* ---------- 消息历史 ---------- */
  const loadLatest = React.useCallback(
    async (channel: string): Promise<void> => {
      updateStore((previous) => {
        const current = previous[channel] ?? emptyStore()
        return { ...previous, [channel]: { ...current, loading: true, error: null } }
      })
      const token = identityRef.current?.token
      const result = await api.fetchHistory({ channel, limit: HISTORY_PAGE }, token)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        else handleAuthFailure(result.status, token)
        updateStore((previous) => {
          const current = previous[channel] ?? emptyStore()
          return {
            ...previous,
            [channel]: { ...current, loading: false, loaded: true, error: result.message, hasMore: false },
          }
        })
        return
      }
      const messages = [...result.value.messages].sort((a, b) => a.seq - b.seq)
      noteSeq(channel, messages)
      updateStore((previous) => {
        const current = previous[channel] ?? emptyStore()
        return {
          ...previous,
          [channel]: {
            // 合并而不是替换：fetch 窗口内 SSE 已合并进来的消息不能被这次响应覆盖掉。
            messages: mergeMessages(current.messages, messages),
            hasMore: result.value.hasMore,
            loaded: true,
            loading: false,
            loadingOlder: false,
            error: null,
          },
        }
      })
      if (channel === activeChannelRef.current) stickRef.current = true
    },
    [handleAuthFailure, noteSeq, updateStore],
  )

  React.useEffect(() => {
    loadLatestRef.current = (channel: string) => {
      void loadLatest(channel)
    }
  }, [loadLatest])

  const loadOlder = React.useCallback(async (): Promise<void> => {
    const channel = activeChannelRef.current
    const entry = storeRef.current[channel]
    if (entry === undefined || !entry.loaded || entry.loadingOlder || !entry.hasMore) return
    const first = entry.messages[0]
    if (first === undefined) return
    prevScrollHeightRef.current = scrollRef.current?.scrollHeight ?? 0
    updateStore((previous) => {
      const current = previous[channel] ?? emptyStore()
      return { ...previous, [channel]: { ...current, loadingOlder: true } }
    })
    const result = await api.fetchHistory(
      { channel, beforeSeq: first.seq, limit: HISTORY_PAGE },
      identityRef.current?.token,
    )
    if (!result.ok) {
      if (result.status === 0) setOffline(true)
      updateStore((previous) => {
        const current = previous[channel] ?? emptyStore()
        return { ...previous, [channel]: { ...current, loadingOlder: false } }
      })
      reportError(`加载更早消息失败：${result.message}`)
      return
    }
    const older = result.value.messages.filter((message) => message.seq < first.seq)
    noteSeq(channel, older)
    prependRef.current = older.length > 0
    updateStore((previous) => {
      const current = previous[channel] ?? emptyStore()
      return {
        ...previous,
        [channel]: {
          ...current,
          messages: mergeMessages(current.messages, older),
          hasMore: result.value.hasMore,
          loadingOlder: false,
        },
      }
    })
  }, [noteSeq, reportError, updateStore])

  React.useEffect(() => {
    // 注册还没结束（loading）时先等；身份失败也尝试读历史（同源读接口通常仍可用）。
    if (identityState === 'loading') return
    const entry = storeRef.current[activeChannel]
    if (entry !== undefined && entry.loaded) return
    void loadLatest(activeChannel)
  }, [activeChannel, identityState, loadLatest])

  /* ---------- 成员 / 心跳 ---------- */
  const refreshMembers = React.useCallback(async (): Promise<void> => {
    setMembersLoading(true)
    const result = await api.fetchMembers(activeChannelRef.current, identityRef.current?.token)
    setMembersLoading(false)
    if (result.ok) setMembers(result.value)
    else if (result.status === 0) setOffline(true)
  }, [])

  React.useEffect(() => {
    if (identityState === 'loading') return
    let cancelled = false
    const load = async (): Promise<void> => {
      setMembersLoading(true)
      const result = await api.fetchMembers(activeChannel, identityRef.current?.token)
      if (cancelled) return
      setMembersLoading(false)
      if (result.ok) setMembers(result.value)
      else if (result.status === 0) setOffline(true)
    }
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 45_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeChannel, identityState])

  React.useEffect(() => {
    if (identityState !== 'ready') return
    const token = identityRef.current?.token
    if (token === undefined || token === '') return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const result = await api.heartbeat(token)
      if (cancelled) return
      if (result.ok) {
        setOffline(false)
        return
      }
      if (result.status === 0) setOffline(true)
      else if (result.status === 401) {
        api.clearIdentity()
        bootstrapRef.current()
      }
    }
    void tick()
    const timer = window.setInterval(() => {
      void tick()
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [identityState, identity?.token])

  /* ---------- 切换频道时重置视图状态 ---------- */
  React.useEffect(() => {
    activeChannelRef.current = activeChannel
    stickRef.current = true
    prevScrollHeightRef.current = 0
    prependRef.current = false
    setNewBelow(0)
    setReplyTo(null)
    setShowPins(false)
    clearUnread(activeChannel)
    // GET /history 会更新服务器读游标；切到已缓存的频道时补一次轻量读，
    // 避免「本地已读、服务器仍算未读」在重连后把 badge 弹回来。
    const cached = storeRef.current[activeChannel]
    const lastSeq = lastSeqRef.current[activeChannel] ?? 0
    if (cached !== undefined && cached.loaded && lastSeq > 0) {
      void api.fetchHistory({ channel: activeChannel, beforeSeq: lastSeq + 1, limit: 1 }, identityRef.current?.token)
    }
  }, [activeChannel, clearUnread])

  /* ---------- 置顶 ---------- */
  const activeMeta = channels.find((channel) => channel.id === activeChannel)
  const pinSignature = activeMeta?.pins.map((pin) => pin.messageId).join(',') ?? ''

  React.useEffect(() => {
    if (!showPins || identityState === 'loading') return
    let cancelled = false
    setPinsLoading(true)
    void (async () => {
      const result = await api.fetchPins(activeChannel, identityRef.current?.token)
      if (cancelled) return
      setPinsLoading(false)
      if (result.ok) setPins(result.value)
      else if (result.status === 0) setOffline(true)
    })()
    return () => {
      cancelled = true
    }
  }, [showPins, activeChannel, identityState, pinSignature])

  /* ---------- 公告解析（ChannelMeta 只带 announcementId） ---------- */
  React.useEffect(() => {
    const announcementId = activeMeta?.announcementId
    if (announcementId === undefined) {
      setAnnouncement(null)
      return
    }
    if (announcement !== null && announcement.channel === activeChannel && announcement.message.id === announcementId) {
      return
    }
    const cached = (store[activeChannel]?.messages ?? EMPTY_MESSAGES).find((message) => message.id === announcementId)
    if (cached !== undefined) {
      setAnnouncement({ channel: activeChannel, message: cached })
      return
    }
    const seq = api.seqFromMessageId(activeChannel, announcementId)
    if (seq === null) {
      setAnnouncement(null)
      return
    }
    let cancelled = false
    void (async () => {
      const result = await api.fetchHistory(
        { channel: activeChannel, afterSeq: seq - 1, limit: 1 },
        identityRef.current?.token,
      )
      if (cancelled || !result.ok) return
      const message = result.value.messages.find((item) => item.id === announcementId) ?? result.value.messages[0]
      if (message !== undefined) setAnnouncement({ channel: activeChannel, message })
    })()
    return () => {
      cancelled = true
    }
  }, [activeMeta?.announcementId, activeChannel, store, announcement])

  /* ---------- SSE ---------- */
  const handleFrame = React.useCallback(
    (frame: api.IncomingFrame): void => {
      if (frame.kind === 'hello') {
        if (frame.channels.length > 0) applyChannelViews(frame.channels)
        setConnection('open')
        setOffline(false)
        return
      }
      if (frame.kind === 'channel') {
        upsertChannel(frame.channel)
        return
      }
      if (frame.kind === 'presence') {
        upsertMember(frame.participant)
        return
      }
      if (frame.kind === 'policy') {
        const policy = frame.policy
        setChannels((previous) =>
          previous.map((channel) =>
            channel.id === policy.channel
              ? {
                  ...channel,
                  admins: policy.admins,
                  muted: policy.muted,
                  mutedAll: policy.mutedAll,
                  maxChars: policy.maxChars,
                  ratePerMinute: policy.ratePerMinute,
                }
              : channel,
          ),
        )
        if (policy.channel === activeChannelRef.current) {
          const admins = new Set(policy.admins)
          const muted = new Set(policy.muted)
          setMembers((previous) =>
            previous.map((member) => ({
              ...member,
              admin: admins.has(member.handle),
              muted: muted.has(member.handle),
            })),
          )
        }
        return
      }
      const message = frame.message
      const channel = message.channel
      const entry = storeRef.current[channel]
      if (entry !== undefined && entry.loaded) mergeInto(channel, [message])
      noteSeq(channel, [message])
      if (channel === activeChannelRef.current) {
        if (message.kind === 'announcement') setAnnouncement({ channel, message })
        if (!stickRef.current) setNewBelow((count) => count + 1)
      } else {
        setUnread((previous) => ({ ...previous, [channel]: (previous[channel] ?? 0) + 1 }))
      }
    },
    [applyChannelViews, mergeInto, noteSeq, upsertChannel, upsertMember],
  )

  React.useEffect(() => {
    handleFrameRef.current = handleFrame
  }, [handleFrame])

  React.useEffect(() => {
    if (identity === null) {
      setConnection('idle')
      return
    }
    const currentIdentity = identity
    let disposed = false
    let source: EventSource | null = null
    let retryTimer: number | undefined
    let attempt = 0

    const scheduleReconnect = (): void => {
      if (disposed) return
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 300)
      attempt += 1
      setConnection('reconnecting')
      retryTimer = window.setTimeout(() => {
        void reconnect()
      }, delay)
    }

    const catchUp = async (): Promise<void> => {
      refreshChannelsRef.current()
      // host 的 afterSeq 回放是「每频道按 seq 过滤」，所以逐频道补齐（只补已加载过的）。
      for (const channel of Object.keys(storeRef.current)) {
        const entry = storeRef.current[channel]
        if (entry === undefined || !entry.loaded) {
          if (channel === activeChannelRef.current) loadLatestRef.current(channel)
          continue
        }
        const afterSeq = lastSeqRef.current[channel] ?? 0
        if (afterSeq <= 0) continue
        const result = await api.fetchHistory({ channel, afterSeq, limit: 100 }, currentIdentity.token)
        if (disposed) return
        if (!result.ok || result.value.messages.length === 0) continue
        mergeInto(channel, result.value.messages)
        noteSeq(channel, result.value.messages)
      }
    }

    const handleData = (data: string): void => {
      const frame = api.parseStreamFrame(data)
      if (frame !== null) handleFrameRef.current(frame)
    }

    const reconnect = async (): Promise<void> => {
      if (disposed) return
      const who = await api.fetchWhoAmI(currentIdentity.token)
      if (disposed) return
      if (who.ok) {
        setOffline(false)
        connect()
        return
      }
      if (who.status === 401) {
        api.clearIdentity()
        setIdentityState('loading')
        bootstrapRef.current()
        return
      }
      setOffline(true)
      scheduleReconnect()
    }

    const connect = (): void => {
      if (disposed) return
      const channel = activeChannelRef.current
      const afterSeq = lastSeqRef.current[channel] ?? 0
      setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
      let nextSource: EventSource | null = null
      try {
        nextSource = new EventSource(api.streamUrl(currentIdentity, afterSeq, channel))
      } catch (error) {
        reportError(`实时连接创建失败：${error instanceof Error ? error.message : String(error)}`)
        scheduleReconnect()
        return
      }
      source = nextSource
      nextSource.onopen = () => {
        if (disposed) return
        attempt = 0
        setConnection('open')
        setOffline(false)
        void catchUp()
      }
      // 注意：'message' 既是 host 的命名事件、也是 EventSource 的默认事件类型。
      // addEventListener('message') 已经覆盖两种写法，绝不能再挂 onmessage，
      // 否则同一帧会被处理两次（消息去重了，但未读数会翻倍）。
      for (const eventName of ['hello', 'message', 'channel', 'presence', 'policy'] as const) {
        nextSource.addEventListener(eventName, (event) => {
          const data = (event as MessageEvent).data
          if (typeof data === 'string') handleData(data)
        })
      }
      nextSource.onerror = () => {
        if (disposed) return
        try {
          nextSource?.close()
        } catch {
          /* ignore */
        }
        if (source === nextSource) source = null
        scheduleReconnect()
      }
    }

    connect()
    return () => {
      disposed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (source !== null) {
        try {
          source.close()
        } catch {
          /* ignore */
        }
        source = null
      }
    }
  }, [identity, mergeInto, noteSeq, reportError])

  /* ---------- banner 自动消失 ---------- */
  React.useEffect(() => {
    if (banner === null) return
    const timer = window.setTimeout(() => setBanner(null), 8000)
    return () => window.clearTimeout(timer)
  }, [banner])

  /* ---------- 滚动位置 ---------- */
  React.useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (prependRef.current) {
      prependRef.current = false
      const delta = element.scrollHeight - prevScrollHeightRef.current
      if (delta > 0) element.scrollTop += delta
      return
    }
    if (stickRef.current) element.scrollTop = element.scrollHeight
  }, [store, activeChannel, pending])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const atBottom = distance < NEAR_BOTTOM_PX
    if (atBottom) {
      stickRef.current = true
      setNewBelow(0)
      clearUnread(activeChannelRef.current)
    } else {
      stickRef.current = false
    }
    if (element.scrollTop < 48) void loadOlder()
  }

  const scrollToBottom = (): void => {
    const element = scrollRef.current
    if (element === null) return
    stickRef.current = true
    element.scrollTop = element.scrollHeight
    setNewBelow(0)
    clearUnread(activeChannelRef.current)
  }

  /* ---------- 跳转 / 回复 / 置顶 ---------- */
  /**
   * 跳转到指定频道的某条消息：必要时先切频道 + 取该 seq 附近历史，
   * 然后滚动到它并高亮 2s（任务 §8 检索跳转 / 引用跳转共用）。
   */
  const jumpToIn = React.useCallback(
    async (channel: string, messageId: string): Promise<void> => {
      setShowPins(false)
      const entry = storeRef.current[channel]
      let target = entry?.messages.find((message) => message.id === messageId)
      if (target === undefined) {
        const seq = api.seqFromMessageId(channel, messageId)
        if (seq === null) {
          reportError('无法定位该消息')
          return
        }
        const result = await api.fetchHistory(
          { channel, beforeSeq: seq + 1, limit: HISTORY_PAGE },
          identityRef.current?.token,
        )
        if (!result.ok) {
          if (result.status === 0) setOffline(true)
          reportError(`定位消息失败：${result.message}`)
          return
        }
        // 先把目标附近的历史并进 store，再切频道，切过去就有内容可滚。
        mergeInto(channel, result.value.messages)
        noteSeq(channel, result.value.messages)
        target =
          result.value.messages.find((message) => message.id === messageId) ??
          result.value.messages[result.value.messages.length - 1]
      }
      if (target === undefined) {
        reportError('该消息不在已加载的历史里')
        return
      }
      const targetId = target.id
      const switching = channel !== activeChannelRef.current
      if (switching) setActiveChannel(channel)
      stickRef.current = false
      setHighlightId(targetId)
      window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS)
      // 切频道要多等一帧（新频道的消息列表挂载后节点才存在）。
      window.setTimeout(
        () => {
          const node = document.querySelector(`[data-dshch-msg="${targetId}"]`)
          if (node instanceof HTMLElement) node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        },
        switching ? 120 : 40,
      )
    },
    [mergeInto, noteSeq, reportError],
  )

  /** 当前频道内跳转（引用 / 置顶抽屉 / 公告共用）。 */
  const jumpTo = React.useCallback(
    (messageId: string): void => {
      void jumpToIn(activeChannelRef.current, messageId)
    },
    [jumpToIn],
  )


  const startReply = (message: ChannelMessage): void => {
    setReplyTo(message)
    composerRef.current?.focus()
  }

  const togglePin = React.useCallback(
    async (message: ChannelMessage): Promise<void> => {
      const meta = channelsRef.current.find((channel) => channel.id === message.channel)
      const pinned = meta?.pins.some((pin) => pin.messageId === message.id) ?? false
      const token = identityRef.current?.token
      const result = pinned
        ? await api.unpinMessage(message.channel, message.id, token)
        : await api.pinMessage(message.channel, message.id, token)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        reportError(`置顶操作失败：${result.message}`)
        return
      }
      const actor = identityRef.current?.participantId ?? ''
      const at = new Date().toISOString()
      setChannels((previous) =>
        previous.map((channel) =>
          channel.id !== message.channel
            ? channel
            : {
                ...channel,
                pins: pinned
                  ? channel.pins.filter((pin) => pin.messageId !== message.id)
                  : [...channel.pins, { messageId: message.id, by: actor, at }],
              },
        ),
      )
      setPins((previous) => {
        if (pinned) return previous.filter((pin) => pin.messageId !== message.id)
        if (previous.some((pin) => pin.messageId === message.id)) return previous
        return [{ messageId: message.id, by: actor, at, message }, ...previous]
      })
    },
    [reportError],
  )

  const unpinById = React.useCallback(
    async (messageId: string): Promise<void> => {
      const channel = activeChannelRef.current
      const result = await api.unpinMessage(channel, messageId, identityRef.current?.token)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        reportError(`取消置顶失败：${result.message}`)
        return
      }
      setChannels((previous) =>
        previous.map((item) =>
          item.id !== channel
            ? item
            : { ...item, pins: item.pins.filter((pin) => pin.messageId !== messageId) },
        ),
      )
      setPins((previous) => previous.filter((pin) => pin.messageId !== messageId))
    },
    [reportError],
  )

  /* ---------- M3：附件上传 ---------- */

  const patchDraft = React.useCallback((key: string, patch: Partial<DraftAttachment>): void => {
    setDrafts((previous) => {
      const next = previous.map((item) => (item.key === key ? { ...item, ...patch } : item))
      draftsRef.current = next
      return next
    })
  }, [])

  /** 上传一批已登记的草稿（带并发上限；失败逐条标记，可重试）。 */
  const runUploads = React.useCallback(
    async (entries: readonly DraftAttachment[], generation: number): Promise<void> => {
      const queue = [...entries]
      const token = identityRef.current?.token
      const worker = async (): Promise<void> => {
        for (;;) {
          const entry = queue.shift()
          if (entry === undefined) return
          const result = await api.uploadAttachment({ file: entry.blob, name: entry.name, mime: entry.mime }, token)
          if (generation !== draftGenRef.current) return
          if (result.ok) {
            patchDraft(entry.key, { status: 'ready', attachment: result.value, error: undefined })
            setOffline(false)
            continue
          }
          if (result.status === 0) setOffline(true)
          else handleAuthFailure(result.status, token)
          patchDraft(entry.key, { status: 'failed', error: result.message })
        }
      }
      const workers = Math.min(UPLOAD_CONCURRENCY, entries.length)
      await Promise.all(Array.from({ length: workers }, () => worker()))
    },
    [handleAuthFailure, patchDraft],
  )

  /**
   * 校验并接收用户选择/拖拽/粘贴的文件：
   * 数量 ≤ 10、单个 ≤ 25MB、合计 ≤ 50MB，超限只提示不发送。
   */
  const addFiles = React.useCallback(
    (files: readonly File[]): void => {
      const incoming = files.filter((file) => file !== null && typeof file === 'object' && typeof file.size === 'number')
      if (incoming.length === 0) return
      if (identityRef.current === null) {
        // 拖拽/粘贴不看按钮 disabled，这里补一道身份检查（/upload 需要 Bearer）。
        setDraftsError('身份尚未就绪，无法上传附件；请稍后重试')
        return
      }
      const existing = draftsRef.current
      const problems: string[] = []
      const accepted: File[] = []
      let count = existing.length
      let total = existing.reduce((sum, item) => sum + item.size, 0)
      for (const file of incoming) {
        if (count >= MAX_ATTACHMENTS) {
          problems.push(`最多 ${MAX_ATTACHMENTS} 个附件`)
          break
        }
        const size = file.size
        if (size > MAX_ATTACHMENT_BYTES) {
          problems.push(`「${file.name || '文件'}」超过单文件上限 ${humanSize(MAX_ATTACHMENT_BYTES)}`)
          continue
        }
        if (total + size > MAX_ATTACHMENT_TOTAL_BYTES) {
          problems.push(`附件合计超过 ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)}`)
          break
        }
        accepted.push(file)
        count += 1
        total += size
      }
      setDraftsError(problems.length > 0 ? problems.join('；') : null)
      if (accepted.length === 0) return
      const generation = draftGenRef.current
      const stamp = Date.now()
      const entries: DraftAttachment[] = accepted.map((file, index) => {
        const named = typeof file.name === 'string' && file.name !== '' ? file.name : `粘贴文件-${stamp}-${index + 1}`
        return {
          key: `draft_${stamp.toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
          blob: file,
          name: named,
          mime: typeof file.type === 'string' && file.type !== '' ? file.type : 'application/octet-stream',
          size: file.size,
          status: 'uploading',
        }
      })
      // 立即用 ref 落账：两次连续的粘贴/拖拽在同一个 tick 里也能算对数量与总大小。
      draftsRef.current = [...draftsRef.current, ...entries]
      setDrafts(draftsRef.current)
      void runUploads(entries, generation)
    },
    [runUploads],
  )

  const removeDraft = React.useCallback((key: string): void => {
    draftsRef.current = draftsRef.current.filter((item) => item.key !== key)
    setDrafts(draftsRef.current)
    setDraftsError(null)
  }, [])

  const retryDraft = React.useCallback(
    (key: string): void => {
      const entry = draftsRef.current.find((item) => item.key === key)
      if (entry === undefined) return
      const generation = draftGenRef.current
      patchDraft(key, { status: 'uploading', error: undefined })
      setDraftsError(null)
      void runUploads([{ ...entry, status: 'uploading' }], generation)
    },
    [patchDraft, runUploads],
  )

  const openImage = React.useCallback((attachment: Attachment): void => {
    setLightbox(attachment)
  }, [])

  /** 中心区域拖拽：拖文件进来显示蒙层，落下即走 addFiles。 */
  const dragHasFiles = (event: React.DragEvent): boolean => {
    const types = event.dataTransfer?.types
    return types !== undefined && Array.from(types).includes('Files')
  }

  const onCenterDragEnter = (event: React.DragEvent): void => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }

  const onCenterDragOver = (event: React.DragEvent): void => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'copy'
  }

  const onCenterDragLeave = (event: React.DragEvent): void => {
    if (!dragHasFiles(event)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  const onCenterDrop = (event: React.DragEvent): void => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    addFiles(Array.from(event.dataTransfer?.files ?? []))
  }

  /* ---------- M3：消息检索 ---------- */

  const closeSearch = React.useCallback((): void => {
    searchSeqRef.current += 1
    setSearchOpen(false)
    setSearchLoading(false)
  }, [])

  const runSearch = React.useCallback(
    async (rawQuery: string): Promise<void> => {
      const query = rawQuery.trim()
      if (query === '') {
        closeSearch()
        setSearchHits([])
        setSearchError(null)
        setSearchHasMore(false)
        return
      }
      const seq = ++searchSeqRef.current
      setSearchOpen(true)
      setSearchLoading(true)
      setSearchError(null)
      const result = await api.searchMessages(
        {
          q: query,
          ...(searchScope === 'channel' ? { channel: activeChannelRef.current } : {}),
          limit: SEARCH_LIMIT,
        },
        identityRef.current?.token,
      )
      if (seq !== searchSeqRef.current) return
      setSearchLoading(false)
      searchDoneRef.current = query
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        else handleAuthFailure(result.status, identityRef.current?.token)
        setSearchError(result.message)
        setSearchHits([])
        setSearchHasMore(false)
        return
      }
      setSearchHits([...result.value.hits])
      setSearchHasMore(result.value.hasMore)
    },
    [closeSearch, handleAuthFailure, searchScope],
  )

  // 输入去抖（Enter 会立即查询，不必等 320ms）。
  React.useEffect(() => {
    const query = searchQuery.trim()
    if (query === '') {
      closeSearch()
      setSearchHits([])
      setSearchError(null)
      setSearchHasMore(false)
      return
    }
    const timer = window.setTimeout(() => {
      void runSearch(query)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchQuery, searchScope, runSearch, closeSearch])

  /** 点击检索结果：关面板 → 切频道 → 定位并高亮。 */
  const openSearchHit = React.useCallback(
    (hit: SearchHit): void => {
      closeSearch()
      void jumpToIn(hit.channel, hit.message.id)
    },
    [closeSearch, jumpToIn],
  )

  const rewindSearch = React.useCallback((): void => {
    void runSearch(searchQuery)
  }, [runSearch, searchQuery])

  /* ---------- Esc 关闭浮层（lightbox / 检索结果） ---------- */
  React.useEffect(() => {
    if (lightbox === null && !searchOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (lightbox !== null) {
        event.preventDefault()
        setLightbox(null)
        return
      }
      if (searchOpen) {
        event.preventDefault()
        closeSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox, searchOpen, closeSearch])


  /* ---------- 发送 ---------- */
  const deliver = React.useCallback(
    async (message: PendingMessage): Promise<void> => {
      commitPending((previous) =>
        previous.map((item) =>
          item.clientMsgId === message.clientMsgId ? { ...item, status: 'sending', error: undefined } : item,
        ),
      )
      const result = await api.sendMessage(
        {
          channel: message.channel,
          text: message.text,
          clientMsgId: message.clientMsgId,
          replyTo: message.replyTo?.id,
          mentions: message.mentions,
          ...(message.attachments.length > 0 ? { attachments: message.attachments.map((item) => item.id) } : {}),
        },
        identityRef.current?.token,
      )
      if (result.ok) {
        commitPending((previous) => previous.filter((item) => item.clientMsgId !== message.clientMsgId))
        mergeInto(message.channel, [result.value])
        noteSeq(message.channel, [result.value])
        setOffline(false)
        if (message.channel === activeChannelRef.current) stickRef.current = true
        return
      }
      if (result.status === 0) setOffline(true)
      commitPending((previous) =>
        previous.map((item) =>
          item.clientMsgId === message.clientMsgId ? { ...item, status: 'failed', error: result.message } : item,
        ),
      )
    },
    [commitPending, mergeInto, noteSeq],
  )

  const handleSend = React.useCallback(
    (text: string): void => {
      if (utf8Bytes(text) > MAX_TEXT_BYTES) {
        reportError(`消息超过 ${MAX_TEXT_BYTES} 字节上限`)
        return
      }
      const current = draftsRef.current
      const ready = current
        .filter((item) => item.status === 'ready' && item.attachment !== undefined)
        .map((item) => item.attachment as Attachment)
      const unfinished = current.length - ready.length
      if (unfinished > 0) {
        setDraftsError('还有附件在上传或上传失败：请等待完成，或先重试/移除')
        return
      }
      if (text.trim() === '' && ready.length === 0) return
      const channel = activeChannelRef.current
      const me = identityRef.current
      const message: PendingMessage = {
        clientMsgId: api.newClientMsgId(),
        channel,
        text,
        replyTo: replyToRef.current ?? undefined,
        mentions: parseMentions(text),
        attachments: ready,
        createdAt: new Date().toISOString(),
        status: 'sending',
        author: {
          participantId: me?.participantId ?? '',
          handle: me?.handle ?? 'me',
          displayName: me?.handle ?? 'me',
          kind: 'human',
          harness: 'other',
        },
      }
      setReplyTo(null)
      replyToRef.current = null
      // 发送即清空草稿（重试时用 PendingMessage 里已固化的附件元数据，不重传）。
      draftsRef.current = []
      setDrafts([])
      setDraftsError(null)
      stickRef.current = true
      commitPending((previous) => [...previous, message])
      void deliver(message)
    },
    [commitPending, deliver, reportError],
  )

  const retryPending = (clientMsgId: string): void => {
    const message = pendingRef.current.find((item) => item.clientMsgId === clientMsgId)
    if (message !== undefined) void deliver(message)
  }

  /* ---------- 建频道 / 改名 ---------- */
  const submitCreate = React.useCallback(
    async (id: string, name: string, category: string): Promise<void> => {
      setCreating(true)
      setCreateError(null)
      const result = await api.createChannel(
        { id, name, category: category === '' ? undefined : category },
        identityRef.current?.token,
      )
      setCreating(false)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        setCreateError(result.message)
        return
      }
      setCreateOpen(false)
      await refreshChannels()
      setActiveChannel(id)
    },
    [refreshChannels],
  )

  const claimHandle = React.useCallback(
    async (handle: string): Promise<string | null> => {
      setRenaming(true)
      setRenameError(null)
      const current = identityRef.current
      // 注意：POST /register 带「新 handle」会创建一个新参与者；改名必须走 /claim，
      // 它把 handle 认领给当前 token 对应的参与者（id / token 不变）。
      const result = await api.claimHandle(handle, current?.token)
      setRenaming(false)
      if (!result.ok) {
        if (result.status === 0) setOffline(true)
        else handleAuthFailure(result.status, current?.token)
        return result.message
      }
      const next = {
        participantId: result.value.participantId,
        handle: result.value.handle,
        token: current?.token ?? '',
      }
      if (next.token !== '') api.writeIdentity(next)
      setIdentity(next)
      setRenameOpen(false)
      await refreshChannels()
      void refreshMembers()
      return null
    },
    [handleAuthFailure, refreshChannels, refreshMembers],
  )

  const mentionFromMember = (handle: string): void => {
    composerRef.current?.insertMention(handle)
  }

  /* ---------- 派生渲染数据 ---------- */
  const groupedChannels = React.useMemo(() => groupChannels(channels), [channels])
  const activeStore = store[activeChannel]
  const messages = activeStore?.messages ?? EMPTY_MESSAGES
  const pendingForChannel = pending.filter((item) => item.channel === activeChannel)
  const pinnedIds = React.useMemo(
    () => new Set((activeMeta?.pins ?? []).map((pin) => pin.messageId)),
    [activeMeta?.pins],
  )
  const pinCount = activeMeta?.pins.length ?? 0
  const connClass = offline ? 'is-offline' : connection === 'open' ? 'is-open' : 'is-connecting'
  const connLabel = offline
    ? '离线'
    : connection === 'open'
      ? '实时'
      : connection === 'reconnecting'
        ? '重连中'
        : connection === 'idle'
          ? '未连接'
          : '连接中'
  const activeName = activeMeta?.name ?? activeChannel
  const channelNames = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const channel of channels) map.set(channel.id, channel.name)
    return map
  }, [channels])
  const channelLabelOf = (id: string): string => channelNames.get(id) ?? id

  /* ---------- 渲染 ---------- */
  return (
    <div className="dshch-root">
      {/* ===== 左栏：频道列表 ===== */}
      <aside className="dshch-col-left">
        <div className="dshch-left-head">
          <span>频道管家</span>
          <button
            type="button"
            className="dshch-icon-btn"
            title="新建频道"
            aria-label="新建频道"
            onClick={() => {
              setCreateOpen((open) => !open)
              setCreateError(null)
            }}
          >
            ＋
          </button>
        </div>
        <div className="dshch-left-scroll">
          {!channelsLoaded && channels.length === 0 && (
            <div className="dshch-empty">
              <div className="dshch-spinner" />
              <span>正在加载频道…</span>
            </div>
          )}
          {channelsLoaded && channels.length === 0 && (
            <div className="dshch-empty">
              <span className="dshch-empty-icon">#</span>
              <span>{channelsError ?? '还没有任何频道'}</span>
              <button type="button" className="dshch-btn dshch-btn-outline" onClick={() => setCreateOpen(true)}>
                创建第一个频道
              </button>
              <button type="button" className="dshch-btn" onClick={() => void refreshChannels()}>
                重试
              </button>
            </div>
          )}
          {groupedChannels.map((group) => (
            <div key={group.category}>
              <div className="dshch-cat">{group.category}</div>
              {group.channels.map((channel) => {
                const count = unread[channel.id] ?? 0
                return (
                  <button
                    key={channel.id}
                    type="button"
                    className={cx('dshch-channel', channel.id === activeChannel && 'is-active')}
                    title={channel.topic ?? channel.name}
                    onClick={() => setActiveChannel(channel.id)}
                  >
                    <span className="dshch-hash">#</span>
                    <span className="dshch-channel-name">{channel.name}</span>
                    {channel.mutedAll === true && (
                      <span className="dshch-channel-mute" title="全员禁言中" aria-label="全员禁言中">
                        🔇
                      </span>
                    )}
                    {count > 0 && <span className="dshch-badge">{count > 99 ? '99+' : count}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {createOpen && (
          <CreateChannelForm
            creating={creating}
            error={createError}
            onCancel={() => {
              setCreateOpen(false)
              setCreateError(null)
            }}
            onSubmit={(id, name, category) => {
              void submitCreate(id, name, category)
            }}
          />
        )}
        {renameOpen && identity !== null && (
          <RenameForm
            currentHandle={identity.handle}
            saving={renaming}
            error={renameError}
            onCancel={() => {
              setRenameOpen(false)
              setRenameError(null)
            }}
            onSubmit={(handle) => {
              void claimHandle(handle).then((error) => {
                if (error !== null) setRenameError(error)
              })
            }}
          />
        )}
        <div className="dshch-left-foot">
          <span className={cx('dshch-conn-dot', connClass)} title={connLabel} aria-hidden="true" />
          <span className="dshch-me-handle">
            {identity !== null
              ? `@${identity.handle}`
              : identityState === 'error'
                ? '身份注册失败'
                : '正在注册身份…'}
          </span>
          {identity === null && identityState === 'error' && (
            <button type="button" className="dshch-link-btn" onClick={() => void bootstrapIdentity()}>
              重试
            </button>
          )}
          {identity !== null && (
            <button
              type="button"
              className="dshch-link-btn"
              title="修改 handle"
              onClick={() => {
                setRenameOpen((open) => !open)
                setRenameError(null)
              }}
            >
              改名
            </button>
          )}
        </div>
      </aside>

      {/* ===== 中栏：消息流 ===== */}
      <section
        className={cx('dshch-col-center', dragging && 'is-dragging')}
        onDragEnter={onCenterDragEnter}
        onDragOver={onCenterDragOver}
        onDragLeave={onCenterDragLeave}
        onDrop={onCenterDrop}
      >
        <header className="dshch-header">
          <div className="dshch-header-main">
            <div className="dshch-title">
              <span className="dshch-hash">#</span>
              <span className="dshch-title-name">{activeName}</span>
            </div>
            {activeMeta?.topic !== undefined && activeMeta.topic !== '' && (
              <div className="dshch-topic">{activeMeta.topic}</div>
            )}
          </div>
          <div className="dshch-search">
            <span className="dshch-search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              className="dshch-search-input"
              type="search"
              value={searchQuery}
              placeholder="检索消息…"
              aria-label="检索消息"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent?.isComposing === true) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  // 用输入框的实时值：避免「刚输入就回车」时闭包里的 state 还差一帧。
                  void runSearch(event.currentTarget.value)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                  event.currentTarget.blur()
                }
              }}
              onFocus={() => {
                if (searchQuery.trim() !== '' && (searchHits.length > 0 || searchError !== null)) setSearchOpen(true)
              }}
            />
            {searchQuery !== '' && (
              <button
                type="button"
                className="dshch-search-clear"
                title="清空检索"
                aria-label="清空检索"
                onClick={() => {
                  setSearchQuery('')
                  closeSearch()
                  setSearchHits([])
                  setSearchError(null)
                  setSearchHasMore(false)
                }}
              >
                ✕
              </button>
            )}
            <button
              type="button"
              className="dshch-search-scope"
              title={searchScope === 'all' ? '当前检索全部频道（点击只搜本频道）' : '当前只搜本频道（点击搜索全部频道）'}
              onClick={() => setSearchScope((scope) => (scope === 'all' ? 'channel' : 'all'))}
            >
              {searchScope === 'all' ? '全部' : '本频道'}
            </button>
          </div>
          <div className="dshch-header-actions">
            <span className="dshch-conn-pill" title={offline ? '与 host 的连接已断开' : connLabel}>
              <span className={cx('dshch-conn-dot', connClass)} aria-hidden="true" />
              {connLabel}
            </span>
            <button
              type="button"
              className={cx('dshch-icon-btn', showPins && 'is-active')}
              title="置顶消息"
              aria-label="置顶消息"
              onClick={() => setShowPins((open) => !open)}
            >
              📌{pinCount > 0 ? ` ${pinCount}` : ''}
            </button>
            {activeMeta !== undefined && activeMeta.canManage === true && (
              <button
                type="button"
                className="dshch-icon-btn"
                title="频道管理（管理员 / 禁言 / 发言限制）"
                aria-label="频道管理"
                onClick={() => {
                  setSettingsError(null)
                  setSettingsOpen(true)
                }}
              >
                ⚙️
              </button>
            )}
            <button
              type="button"
              className={cx('dshch-icon-btn', showMembers && 'is-active')}
              title={showMembers ? '收起成员列表' : '展开成员列表'}
              aria-label="成员列表"
              onClick={() => setShowMembers((open) => !open)}
            >
              👥
            </button>
          </div>
        </header>

        {searchOpen && (
          <>
            <div className="dshch-search-backdrop" onClick={closeSearch} aria-hidden="true" />
            <div className="dshch-search-panel" role="dialog" aria-label="消息检索结果">
              <div className="dshch-search-panel-head">
                <span className="dshch-search-panel-title">
                  检索「{searchDoneRef.current !== '' ? searchDoneRef.current : searchQuery.trim()}」
                  {searchScope === 'channel' ? ` · #${activeName}` : ' · 全部频道'}
                </span>
                <span className="dshch-search-count">
                  {searchLoading ? '…' : `${searchHits.length}${searchHasMore ? '+' : ''} 条`}
                </span>
                <button type="button" className="dshch-icon-btn" title="关闭（Esc）" aria-label="关闭检索结果" onClick={closeSearch}>
                  ✕
                </button>
              </div>
              <div className="dshch-search-list">
                {searchLoading && (
                  <div className="dshch-search-note">
                    <span className="dshch-spinner" aria-hidden="true" />
                    <span>检索中…</span>
                  </div>
                )}
                {!searchLoading && searchError !== null && (
                  <div className="dshch-search-note is-error">
                    <span>检索失败：{searchError}</span>
                    <button type="button" className="dshch-link-btn" onClick={rewindSearch}>
                      重试
                    </button>
                  </div>
                )}
                {!searchLoading && searchError === null && searchHits.length === 0 && (
                  <div className="dshch-search-note">没有匹配的消息</div>
                )}
                {searchHits.map((hit) => (
                  <button
                    key={`${hit.channel}:${hit.message.id}`}
                    type="button"
                    className="dshch-hit"
                    title={`跳到 #${hit.channel} 的 ${hit.message.id}`}
                    onClick={() => openSearchHit(hit)}
                  >
                    <span className="dshch-hit-head">
                      <span className="dshch-hit-channel">#{channelLabelOf(hit.channel)}</span>
                      <span className="dshch-hit-author">@{hit.message.author.handle}</span>
                      <span className="dshch-hit-time">{formatFull(hit.message.ts)}</span>
                    </span>
                    <span className="dshch-hit-snippet">
                      <HighlightedSnippet text={hit.snippet} query={searchDoneRef.current !== '' ? searchDoneRef.current : searchQuery} />
                    </span>
                  </button>
                ))}
                {!searchLoading && searchHits.length > 0 && searchHasMore && (
                  <div className="dshch-search-note">结果已达上限（{SEARCH_LIMIT} 条），请加更精确的检索词</div>
                )}
              </div>
            </div>
          </>
        )}

        {activeMeta?.announcementId !== undefined && (
          <div className="dshch-announce">
            <span className="dshch-announce-tag">📢 公告</span>
            {announcement !== null && announcement.channel === activeChannel ? (
              <>
                <span className="dshch-announce-author">@{announcement.message.author.handle}</span>
                <span className="dshch-announce-text">{excerpt(announcement.message.text, 240)}</span>
                <button
                  type="button"
                  className="dshch-link-btn"
                  onClick={() => void jumpTo(announcement.message.id)}
                >
                  查看
                </button>
              </>
            ) : (
              <span className="dshch-announce-text">本频道有公告</span>
            )}
          </div>
        )}

        {banner !== null && (
          <div className={cx('dshch-banner', banner.kind === 'error' ? 'is-error' : 'is-info')} role="status">
            <span className="dshch-banner-text">{banner.text}</span>
            {offline && (
              <button
                type="button"
                className="dshch-link-btn"
                onClick={() => {
                  void bootstrapIdentity()
                  void refreshChannels()
                }}
              >
                重试连接
              </button>
            )}
            <button
              type="button"
              className="dshch-icon-btn"
              title="关闭提示"
              aria-label="关闭提示"
              onClick={() => setBanner(null)}
            >
              ✕
            </button>
          </div>
        )}

        {identityState === 'error' && (
          <div className="dshch-banner is-error" role="status">
            <span className="dshch-banner-text">身份注册失败：{identityError ?? '未知错误'}（无法发送消息）</span>
            <button type="button" className="dshch-link-btn" onClick={() => void bootstrapIdentity()}>
              重试
            </button>
          </div>
        )}

        <div className="dshch-scroll" ref={scrollRef} onScroll={handleScroll}>
          {channelsLoaded && activeMeta === undefined ? (
            <div className="dshch-empty">
              <span className="dshch-empty-icon">#</span>
              <span>{channelsError !== null ? `频道列表加载失败：${channelsError}` : '还没有频道'}</span>
              <button type="button" className="dshch-btn dshch-btn-outline" onClick={() => setCreateOpen(true)}>
                新建频道
              </button>
            </div>
          ) : activeStore === undefined || (activeStore.loading && !activeStore.loaded) ? (
            <div className="dshch-empty">
              <div className="dshch-spinner" />
              <span>正在加载消息…</span>
            </div>
          ) : activeStore.error !== null && activeStore.messages.length === 0 ? (
            <div className="dshch-empty">
              <span>消息加载失败：{activeStore.error}</span>
              <button type="button" className="dshch-btn dshch-btn-outline" onClick={() => void loadLatest(activeChannel)}>
                重试
              </button>
            </div>
          ) : activeStore.messages.length === 0 && pendingForChannel.length === 0 ? (
            <div className="dshch-empty">
              <span className="dshch-empty-icon">💬</span>
              <span>#{activeName} 还没有消息</span>
              <span>在下方输入框发第一条消息吧</span>
            </div>
          ) : (
            <div className="dshch-msgs">
              {activeStore.hasMore && (
                <div className="dshch-older">
                  {activeStore.loadingOlder ? '正在加载更早的消息…' : '向上滚动加载更早的消息'}
                </div>
              )}
              {messages.map((message, index, list) => {
                const previous = index > 0 ? list[index - 1] : undefined
                const showDay = previous === undefined || dayKey(previous.ts) !== dayKey(message.ts)
                const grouped =
                  previous !== undefined &&
                  !showDay &&
                  previous.author.participantId === message.author.participantId &&
                  previous.kind === 'chat' &&
                  message.kind === 'chat' &&
                  message.replyTo === undefined &&
                  Date.parse(message.ts) - Date.parse(previous.ts) < GROUP_WINDOW_MS
                return (
                  <React.Fragment key={message.id}>
                    {showDay && (
                      <div className="dshch-day">
                        <span>{dayLabel(message.ts)}</span>
                      </div>
                    )}
                    <MessageRow
                      message={message}
                      grouped={grouped}
                      pinned={pinnedIds.has(message.id)}
                      highlighted={highlightId === message.id}
                      canModify={identity !== null}
                      onReply={startReply}
                      onTogglePin={(target) => void togglePin(target)}
                      onJump={jumpTo}
                      onOpenImage={openImage}
                    />
                  </React.Fragment>
                )
              })}
              {pendingForChannel.map((item) => (
                <PendingRow key={item.clientMsgId} pending={item} onRetry={retryPending} onOpenImage={openImage} />
              ))}
            </div>
          )}
        </div>

        {newBelow > 0 && (
          <button type="button" className="dshch-newbtn" onClick={scrollToBottom}>
            新消息 ↓ {newBelow}
          </button>
        )}

        {activeMeta?.mutedAll === true && (
          <div className="dshch-mute-banner" role="status">
            🔇 全员禁言进行中：只有频道管理员和人类操作者可以发言
            {activeMeta.canManage === true && (
              <button
                type="button"
                className="dshch-link-btn"
                onClick={() => setSettingsOpen(true)}
              >
                管理
              </button>
            )}
          </div>
        )}

        <Composer
          key={activeChannel}
          ref={composerRef}
          channelName={activeName}
          disabled={identity === null}
          disabledHint={identityState === 'error' ? '身份注册失败，无法发送' : '正在注册身份…'}
          identityHandle={identity?.handle ?? ''}
          replyTo={replyTo}
          members={members}
          maxBytes={MAX_TEXT_BYTES}
          onCancelReply={() => setReplyTo(null)}
          onSend={handleSend}
          drafts={drafts}
          draftsError={draftsError}
          onPickFiles={addFiles}
          onRemoveDraft={removeDraft}
          onRetryDraft={retryDraft}
        />

        {showPins && (
          <PinDrawer
            pins={pins}
            loading={pinsLoading}
            onClose={() => setShowPins(false)}
            onJump={(id) => void jumpTo(id)}
            onUnpin={(id) => void unpinById(id)}
          />
        )}

        {dragging && (
          <div className="dshch-drop-overlay" aria-hidden="true">
            <div className="dshch-drop-inner">
              <span className="dshch-drop-icon">📎</span>
              <span>松开即可上传附件</span>
              <span className="dshch-drop-hint">
                最多 {MAX_ATTACHMENTS} 个 · 单个 ≤ {humanSize(MAX_ATTACHMENT_BYTES)} · 合计 ≤ {humanSize(MAX_ATTACHMENT_TOTAL_BYTES)}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ===== 右栏：成员 ===== */}
      {showMembers && (
        <MemberList
          members={members}
          loading={membersLoading}
          currentHandle={identity?.handle ?? ''}
          onMention={mentionFromMember}
          onRefresh={() => void refreshMembers()}
        />
      )}

      {settingsOpen && activeMeta !== undefined && (
        <ChannelSettingsDialog
          key={activeMeta.id}
          channel={activeMeta}
          members={members}
          busy={settingsBusy}
          error={settingsError}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsError(null)
          }}
          onToggleAdmin={toggleChannelAdmin}
          onMuteAll={setChannelMutedAll}
          onMuteMember={setChannelMemberMuted}
          onSaveLimits={saveChannelLimits}
        />
      )}

      {lightbox !== null && <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
