/**
 * dsh-channels shared contract.
 *
 * Host, browser client and the external CLI/MCP bridge all speak these shapes.
 * Keep this file dependency-free (no `node:` import, no React) so both build
 * faces can import it.
 */

export const PLUGIN_ID = 'dsh-channels'
export const API_BASE = '/channels/api'
export const DEFAULT_CHANNEL = 'general'
export const MAX_TEXT_BYTES = 8 * 1024
export const MAX_PAGE = 100
export const WAKE_RATE_MS = 5_000
export const ANNOUNCE_RATE_MS = 10 * 60_000
export const CLAIM_TOKEN_BYTES = 32
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024
export const SEARCH_LIMIT = 50

/** Per-session channel preferences (persisted by session id). */
export interface SessionPrefs {
  /** Hide the whole channel feature from this session (tools masked + no wake). */
  readonly hidden?: boolean
  /** Do not wake this session on @mention / reply (messages are still stored). */
  readonly muted?: boolean
  readonly updatedAt?: string
  readonly updatedBy?: string
}

export interface SessionPrefsResponse {
  readonly sessionId: string
  readonly prefs: SessionPrefs
}

/** Host tools that make up the channel surface (used to mask a hidden session). */
export const CHANNEL_TOOL_NAMES = [
  'channel_list',
  'channel_history',
  'channel_send',
  'channel_create',
  'channel_members',
  'channel_whoami',
  'channel_claim',
  'channel_login',
  'channel_release',
  'channel_pin',
  'channel_unpin',
  'channel_announce',
  'channel_pins',
  'channel_archive',
  'channel_search',
  'channel_upload',
  'channel_join',
  'channel_leave',
] as const

export type ParticipantKind = 'human' | 'dsh-agent' | 'external'
export type HarnessName = 'dsh' | 'claude-code' | 'codex' | 'opencode' | 'other'
export type MessageKind = 'chat' | 'announcement'
export type ParticipantStatus = 'online' | 'idle' | 'offline'

export interface ParticipantBinding {
  readonly kind: 'dsh-session'
  readonly sessionId: string
}

export interface AuthorSnapshot {
  readonly participantId: string
  readonly handle: string
  readonly displayName: string
  readonly kind: ParticipantKind
  readonly harness: HarnessName
}

export interface ReplyRef {
  readonly id: string
  readonly seq: number
  readonly authorName: string
  readonly excerpt: string
}

/** One stored attachment referenced by a message. */
export interface Attachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly size: number
  /** Same-origin URL that serves the bytes (GET, loopback read trust). */
  readonly url: string
  readonly width?: number
  readonly height?: number
}

export interface ChannelMessage {
  readonly id: string
  readonly channel: string
  readonly seq: number
  readonly ts: string
  readonly author: AuthorSnapshot
  readonly text: string
  readonly mentions: readonly string[]
  readonly replyTo?: ReplyRef
  readonly kind: MessageKind
  readonly attachments?: readonly Attachment[]
}

export interface PinEntry {
  readonly messageId: string
  readonly by: string
  readonly at: string
}

export interface ChannelMeta {
  readonly id: string
  readonly name: string
  readonly topic?: string
  readonly category?: string
  readonly createdAt: string
  readonly createdBy: string
  readonly pins: readonly PinEntry[]
  readonly announcementId?: string
  /** Archived channels stay readable but are hidden from the normal list and reject new messages. */
  readonly archived?: boolean
}

/** Channel metadata plus the caller's view (unread + membership). */
export interface ChannelView extends ChannelMeta {
  readonly lastSeq: number
  readonly unread: number
  /** True when the caller may read/write this channel (humans always true). */
  readonly joined: boolean
  readonly memberCount: number
}

export interface MembershipResponse {
  readonly channel: string
  readonly joined: boolean
  readonly memberCount: number
}

export interface Participant {
  readonly id: string
  readonly handle: string
  readonly displayName: string
  readonly kind: ParticipantKind
  readonly harness: HarnessName
  readonly createdAt: string
  readonly lastSeen: string
  readonly status: ParticipantStatus
  /** SHA-256 of the bearer token; never returned by any API. */
  readonly tokenHash?: string
  readonly binding?: ParticipantBinding
}

export interface RegisterRequest {
  readonly kind: ParticipantKind
  readonly handle?: string
  readonly displayName?: string
  readonly harness?: HarnessName
}

export interface RegisterResponse {
  readonly participantId: string
  readonly handle: string
  readonly token: string
}

export interface SendRequest {
  readonly channel: string
  readonly text: string
  readonly replyTo?: string
  readonly mentions?: readonly string[]
  readonly attachments?: readonly string[]
  readonly clientMsgId?: string
}

export interface SendResponse {
  readonly message: ChannelMessage
}

/** Result of a raw attachment upload (POST /upload). */
export interface UploadResponse {
  readonly attachment: Attachment
}

/** One search hit: the full message plus a short match snippet. */
export interface SearchHit {
  readonly channel: string
  readonly message: ChannelMessage
  readonly snippet: string
}

export interface SearchResponse {
  readonly query: string
  readonly hits: readonly SearchHit[]
  readonly hasMore: boolean
}

export interface HistoryResponse {
  readonly channel: string
  readonly messages: readonly ChannelMessage[]
  readonly hasMore: boolean
}

export interface WhoAmIResponse {
  readonly participant: Participant | null
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export interface HelloFrame {
  readonly type: 'hello'
  readonly participantId: string
  readonly lastSeq: number
}

export interface MessageFrame {
  readonly type: 'message'
  readonly message: ChannelMessage
}

export interface ChannelFrame {
  readonly type: 'channel'
  readonly channel: ChannelMeta
}

export interface PresenceFrame {
  readonly type: 'presence'
  readonly participant: Participant
}

export type StreamFrame = HelloFrame | MessageFrame | ChannelFrame | PresenceFrame

const HANDLE_RE = /^[a-z0-9_-]{2,24}$/

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'all',
  'here',
  'channel',
  'system',
  'everyone',
])

/** True when the value is a legal channel id (slug). */
export function isValidChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value)
}

/** True when the value is a legal handle. */
export function isValidHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_RE.test(value) && !RESERVED_HANDLES.has(value)
}

/** Normalize a user-supplied handle (lowercase, trim). */
export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase()
}

/** Message id for a channel sequence. */
export function messageId(channel: string, seq: number): string {
  return `${channel}-${seq.toString().padStart(6, '0')}`
}

/** Parse `@handle` mentions out of a message body. */
export function parseMentions(text: string): string[] {
  const out: string[] = []
  const re = /@([a-z0-9_-]{2,24})/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const handle = normalizeHandle(match[1] ?? '')
    if (handle.length > 0 && !out.includes(handle)) out.push(handle)
  }
  return out
}

/** One-line preview used by reply quotes and notifications. */
export function excerpt(text: string, limit = 120): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Human-readable byte size (UI / CLI). */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** True when the mime type is a browser-inlineable raster image. */
export function isInlineImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(mime)
}

/** Byte length of a UTF-8 string. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Extract a short display name from a session/agent id. */
export function shortName(id: string): string {
  return id.replace(/^session-/, '').slice(0, 6)
}
