/**
 * dsh-channels 浏览器侧的传输层：同源 HTTP + SSE + 本地身份。
 *
 * 这里不依赖任何 @deepseek-ai/* 类型（浏览器 bundle 只能 import React 和
 * `../contract.js`），所以所有响应都先按 unknown 解析、再由本文件的
 * normalize* 函数宽松校验。契约以 `src/contract.ts` 为准，但 host 可能
 * 直接返回数组、也可能包一层 `{ channels }` / `{ messages }`，两种都吃。
 */

import {
  API_BASE,
  SEARCH_LIMIT,
  type Attachment,
  type ChannelMessage,
  type ChannelMeta,
  type HarnessName,
  type HistoryResponse,
  type Participant,
  type ParticipantKind,
  type ParticipantStatus,
  type RegisterResponse,
  type ReplyRef,
  type SearchHit,
  type SearchResponse,
  type WhoAmIResponse,
} from '../contract.js'

/* ------------------------------------------------------------------ */
/* 基础类型                                                            */
/* ------------------------------------------------------------------ */

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string }

export interface ApiInit {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 原始 body（上传附件时用；与 body 互斥，不会 JSON 序列化）。 */
  rawBody?: BodyInit
  /** 原始 body 的 content-type（默认 application/octet-stream）。 */
  contentType?: string
  token?: string
  signal?: AbortSignal
  /** 额外请求头（例如 Accept）。 */
  headers?: Record<string, string>
}

/** host 的 GET /channels 视图：ChannelMeta + 每参与者未读数（见 host/hub.ts ChannelView）。 */
export interface ChannelView extends ChannelMeta {
  readonly lastSeq?: number
  readonly unread?: number
  readonly memberCount?: number
  readonly admins?: readonly string[]
  readonly muted?: readonly string[]
  readonly mutedAll?: boolean
  readonly maxChars?: number | null
  readonly ratePerMinute?: number | null
  readonly canManage?: boolean
  readonly canAppointAdmins?: boolean
}

/** localStorage 里的浏览器身份（SPEC §8：{participantId, token, handle}）。 */
export interface StoredIdentity {
  participantId: string
  handle: string
  token: string
}

export const IDENTITY_KEY = 'dsh-channels.identity'

/* ------------------------------------------------------------------ */
/* 宽松解析工具                                                        */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 从数组中取第一个存在的数组字段：兼容裸数组与 `{ channels }` 包装。 */
function firstArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value)) {
    for (const key of keys) {
      const found = value[key]
      if (Array.isArray(found)) return found
    }
  }
  return []
}

function asKind(value: unknown): ParticipantKind {
  return value === 'human' || value === 'dsh-agent' || value === 'external' ? value : 'external'
}

function asHarness(value: unknown): HarnessName {
  return value === 'dsh' || value === 'claude-code' || value === 'codex' || value === 'opencode' || value === 'other'
    ? value
    : 'other'
}

function asStatus(value: unknown, lastSeen: string): ParticipantStatus {
  if (value === 'online' || value === 'idle' || value === 'offline') return value
  const at = Date.parse(lastSeen)
  if (Number.isFinite(at) && Date.now() - at < 120_000) return 'online'
  return 'offline'
}

/**
 * 单条附件的宽松转换；形状不认识（无 id 或 url）时返回 null。
 * @param value - 服务端返回的 Attachment 形状。
 * @returns 归一化后的附件，或 null。
 */
export function normalizeAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const url = str(value.url)
  if (id === '' || url === '') return null
  const name = str(value.name, id)
  const width = num(value.width)
  const height = num(value.height)
  return {
    id,
    name,
    mime: str(value.mime, 'application/octet-stream'),
    size: Math.max(0, num(value.size)),
    url,
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
  }
}

/** attachments 数组的宽松解析（容忍缺失 / 非数组 / 坏条目）。 */
export function toAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  const out: Attachment[] = []
  for (const item of value) {
    const attachment = normalizeAttachment(item)
    if (attachment !== null) out.push(attachment)
  }
  return out
}

/** 单条消息的宽松转换；形状不认识时返回 null。 */
export function normalizeMessage(value: unknown): ChannelMessage | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const channel = str(value.channel)
  // 只有附件、没有正文的消息，host 仍会给 text:''；text 缺失时按空串处理。
  const text = typeof value.text === 'string' ? value.text : ''
  if (id === '' || channel === '' || typeof value.seq !== 'number') return null
  const authorRaw = isRecord(value.author) ? value.author : {}
  const handle = str(authorRaw.handle, 'unknown')
  const mentions = Array.isArray(value.mentions)
    ? value.mentions.filter((item): item is string => typeof item === 'string')
    : []
  let replyTo: ReplyRef | undefined
  if (isRecord(value.replyTo)) {
    const replyRaw = value.replyTo
    const replyId = str(replyRaw.id)
    if (replyId !== '') {
      replyTo = {
        id: replyId,
        seq: num(replyRaw.seq),
        authorName: str(replyRaw.authorName),
        excerpt: str(replyRaw.excerpt),
      }
    }
  }
  const attachments = toAttachments(value.attachments)
  return {
    id,
    channel,
    seq: value.seq,
    ts: str(value.ts),
    author: {
      participantId: str(authorRaw.participantId),
      handle,
      displayName: str(authorRaw.displayName, handle),
      kind: asKind(authorRaw.kind),
      harness: asHarness(authorRaw.harness),
    },
    text,
    mentions,
    replyTo,
    kind: value.kind === 'announcement' ? 'announcement' : 'chat',
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

export function normalizeParticipant(value: unknown): Participant | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const handle = str(value.handle)
  if (id === '' || handle === '') return null
  const lastSeen = str(value.lastSeen)
  const bindingRaw = isRecord(value.binding) ? value.binding : undefined
  const binding =
    bindingRaw !== undefined && bindingRaw.kind === 'dsh-session' && typeof bindingRaw.sessionId === 'string'
      ? { kind: 'dsh-session' as const, sessionId: bindingRaw.sessionId }
      : undefined
  return {
    id,
    handle,
    displayName: str(value.displayName, handle),
    kind: asKind(value.kind),
    harness: asHarness(value.harness),
    createdAt: str(value.createdAt),
    lastSeen,
    status: asStatus(value.status, lastSeen),
    tokenHash: typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
    binding,
    ...(value.admin === true ? { admin: true } : {}),
    ...(value.muted === true ? { muted: true } : {}),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function nullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.round(value)) : null
}

export function normalizeChannel(value: unknown): ChannelMeta | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const name = str(value.name)
  if (id === '' || name === '') return null
  const pinsRaw = Array.isArray(value.pins) ? value.pins : []
  const pins = pinsRaw
    .filter(isRecord)
    .map((pin) => ({ messageId: str(pin.messageId), by: str(pin.by), at: str(pin.at) }))
    .filter((pin) => pin.messageId !== '')
  return {
    id,
    name,
    topic: typeof value.topic === 'string' ? value.topic : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    createdAt: str(value.createdAt),
    createdBy: str(value.createdBy),
    pins,
    announcementId: typeof value.announcementId === 'string' ? value.announcementId : undefined,
  }
}

/** GET /channels 的响应 → ChannelView[]（兼容 ChannelMeta[] 与带 unread 的视图）。 */
export function toChannelViews(value: unknown): ChannelView[] {
  const out: ChannelView[] = []
  for (const item of firstArray(value, ['channels', 'items', 'data'])) {
    const channel = normalizeChannel(item)
    if (channel === null) continue
    const record = isRecord(item) ? item : {}
    const lastSeq = typeof record.lastSeq === 'number' && Number.isFinite(record.lastSeq) ? record.lastSeq : undefined
    const unread =
      typeof record.unread === 'number' && Number.isFinite(record.unread) ? Math.max(0, Math.floor(record.unread)) : undefined
    out.push({
      ...channel,
      lastSeq,
      unread,
      ...(typeof record.memberCount === 'number' ? { memberCount: Math.max(0, Math.floor(record.memberCount)) } : {}),
      admins: stringArray(record.admins),
      muted: stringArray(record.muted),
      mutedAll: record.mutedAll === true,
      maxChars: nullableInt(record.maxChars),
      ratePerMinute: nullableInt(record.ratePerMinute),
      canManage: record.canManage === true,
      canAppointAdmins: record.canAppointAdmins === true,
    })
  }
  return out
}

/** GET /members 的响应 → Participant[]。 */
export function toMembers(value: unknown): Participant[] {
  return firstArray(value, ['participants', 'members', 'items', 'data'])
    .map(normalizeParticipant)
    .filter((participant): participant is Participant => participant !== null)
}

/** 置顶条目：可能是 PinEntry、可能直接是 ChannelMessage，也可能两者都带。 */
export interface PinWire {
  messageId: string
  by: string
  at: string
  message?: ChannelMessage
}

export function toPins(value: unknown): PinWire[] {
  const out: PinWire[] = []
  const messages = new Map<string, ChannelMessage>()
  for (const item of firstArray(value, ['messages'])) {
    const message = normalizeMessage(item)
    if (message !== null) messages.set(message.id, message)
  }
  // host 的 GET /pins 返回 { channel, messages, pins }：pins 决定顺序，messages 提供正文。
  const entries = firstArray(value, ['pins'])
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const ownMessage = normalizeMessage(entry)
    const messageId = str(entry.messageId) || ownMessage?.id || ''
    if (messageId === '') continue
    const message = messages.get(messageId) ?? ownMessage ?? undefined
    out.push({
      messageId,
      by: str(entry.by) || message?.author.participantId || '',
      at: str(entry.at) || message?.ts || '',
      message,
    })
  }
  if (out.length > 0) return out
  // 兜底：响应直接是消息数组（或 { messages }）。
  for (const item of firstArray(value, ['messages', 'items', 'data'])) {
    const message = normalizeMessage(isRecord(item) && item.message !== undefined ? item.message : item)
    if (message === null) continue
    out.push({ messageId: message.id, by: message.author.participantId, at: message.ts, message })
  }
  return out
}

/** GET /history 的响应 → HistoryResponse（按 seq 升序）。 */
export function toHistory(value: unknown, fallbackChannel: string): HistoryResponse {
  const messages = firstArray(value, ['messages', 'items', 'data'])
    .map(normalizeMessage)
    .filter((message): message is ChannelMessage => message !== null)
    .sort((a, b) => a.seq - b.seq)
  const channel = isRecord(value) && typeof value.channel === 'string' ? value.channel : fallbackChannel
  const hasMore = isRecord(value) ? bool(value.hasMore) : false
  return { channel, messages, hasMore }
}

/** /send 的响应 → ChannelMessage（兼容 {message} 与裸消息）。 */
export function toMessage(value: unknown): ChannelMessage | null {
  if (isRecord(value) && value.message !== undefined) return normalizeMessage(value.message)
  return normalizeMessage(value)
}

/** /register 的响应 → RegisterResponse。 */
export function toRegister(value: unknown): RegisterResponse | null {
  if (!isRecord(value)) return null
  const participantId = str(value.participantId)
  const handle = str(value.handle)
  const token = str(value.token)
  if (participantId === '' || handle === '' || token === '') return null
  return { participantId, handle, token }
}

function toWhoAmI(value: unknown): WhoAmIResponse {
  if (isRecord(value) && 'participant' in value) {
    return { participant: value.participant === null ? null : normalizeParticipant(value.participant) }
  }
  return { participant: normalizeParticipant(value) }
}

/* ------------------------------------------------------------------ */
/* SSE 帧（契约 StreamFrame，另外兼容 SPEC 里「裸 payload」的写法）      */
/* ------------------------------------------------------------------ */

export interface PolicyFrameData {
  channel: string
  admins: readonly string[]
  muted: readonly string[]
  mutedAll: boolean
  maxChars: number | null
  ratePerMinute: number | null
}

export type IncomingFrame =
  | { kind: 'hello'; channels: ChannelView[]; participant: Participant | null }
  | { kind: 'message'; message: ChannelMessage }
  | { kind: 'channel'; channel: ChannelMeta }
  | { kind: 'presence'; participant: Participant }
  | { kind: 'policy'; policy: PolicyFrameData }

/**
 * 解析一帧 SSE data（可能是 `{type:'message', message}`，也可能按 SPEC
 * 直接是 `ChannelMessage` / `ChannelMeta` / `Participant`）。
 * @param data - EventSource 的 data 字符串。
 * @returns 归一化后的帧；无法识别时 null。
 */
export function parseStreamFrame(data: string): IncomingFrame | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const type = str(value.type)
  if (type === 'hello') {
    const payload = isRecord(value.payload) ? value.payload : undefined
    return {
      kind: 'hello',
      channels: toChannelViews(value.channels ?? payload?.channels),
      participant: normalizeParticipant(value.participant ?? payload?.participant),
    }
  }
  if (type === 'message') {
    const message = normalizeMessage(value.message ?? (isRecord(value.payload) ? value.payload : value))
    return message === null ? null : { kind: 'message', message }
  }
  if (type === 'channel') {
    const channel = normalizeChannel(value.channel ?? value)
    return channel === null ? null : { kind: 'channel', channel }
  }
  if (type === 'presence') {
    const participant = normalizeParticipant(value.participant ?? value)
    return participant === null ? null : { kind: 'presence', participant }
  }
  if (type === 'policy') {
    const channel = str(value.channel)
    if (channel === '') return null
    return {
      kind: 'policy',
      policy: {
        channel,
        admins: stringArray(value.admins),
        muted: stringArray(value.muted),
        mutedAll: value.mutedAll === true,
        maxChars: nullableInt(value.maxChars),
        ratePerMinute: nullableInt(value.ratePerMinute),
      },
    }
  }
  // 没有 type：按形状猜。
  if (value.message !== undefined) {
    const message = normalizeMessage(value.message)
    return message === null ? null : { kind: 'message', message }
  }
  if (value.channel !== undefined && typeof value.seq === 'number' && typeof value.text === 'string') {
    const message = normalizeMessage(value)
    return message === null ? null : { kind: 'message', message }
  }
  if (value.announcementId !== undefined || value.pins !== undefined) {
    const channel = normalizeChannel(value)
    return channel === null ? null : { kind: 'channel', channel }
  }
  if (value.participantId !== undefined || value.status !== undefined) {
    const participant = normalizeParticipant(value)
    return participant === null ? null : { kind: 'presence', participant }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function failure(status: number, code: string, message: string): ApiResult<never> {
  return { ok: false, status, code, message }
}

function errorBodyToFailure(body: unknown, status: number): ApiResult<never> {
  if (isRecord(body) && isRecord(body.error)) {
    const code = str(body.error.code, 'http_error')
    const message = str(body.error.message, `HTTP ${status}`)
    return failure(status, code, message)
  }
  if (typeof body === 'string' && body.trim() !== '') return failure(status, 'http_error', body.trim())
  return failure(status, 'http_error', `HTTP ${status}`)
}

/** 同源 fetch，统一错误形状：非 2xx → `{ error: { code, message } }`。 */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  let response: Response
  const isRaw = init.rawBody !== undefined
  try {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (isRaw) {
      if (init.contentType !== undefined && init.contentType !== '') headers['content-type'] = init.contentType
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (init.token !== undefined && init.token !== '') headers.authorization = `Bearer ${init.token}`
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: isRaw ? init.rawBody : init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络请求失败'
    return failure(0, 'network_error', message)
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  let parsed: unknown
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (!response.ok) return errorBodyToFailure(parsed, response.status)
  return { ok: true, value: parsed as T }
}

export interface HistoryQuery {
  channel: string
  beforeSeq?: number
  afterSeq?: number
  limit?: number
}

export async function fetchChannels(token?: string): Promise<ApiResult<ChannelView[]>> {
  const result = await apiFetch<unknown>('/channels', { token })
  return result.ok ? { ok: true, value: toChannelViews(result.value) } : result
}

export async function fetchHistory(query: HistoryQuery, token?: string): Promise<ApiResult<HistoryResponse>> {
  const params = new URLSearchParams({ channel: query.channel })
  if (query.beforeSeq !== undefined) params.set('beforeSeq', String(query.beforeSeq))
  if (query.afterSeq !== undefined) params.set('afterSeq', String(query.afterSeq))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const result = await apiFetch<unknown>(`/history?${params.toString()}`, { token })
  return result.ok ? { ok: true, value: toHistory(result.value, query.channel) } : result
}

export async function fetchMembers(channel: string, token?: string): Promise<ApiResult<Participant[]>> {
  const params = new URLSearchParams({ channel })
  const result = await apiFetch<unknown>(`/members?${params.toString()}`, { token })
  return result.ok ? { ok: true, value: toMembers(result.value) } : result
}

function toChannelFromResponse(value: unknown): ChannelView | null {
  const item = isRecord(value) && value.channel !== undefined ? value.channel : value
  const views = toChannelViews([item])
  return views[0] ?? null
}

/** POST /channel-admins (human operator only). */
export async function setChannelAdmin(
  channel: string,
  handle: string,
  admin: boolean,
  token?: string,
): Promise<ApiResult<ChannelView>> {
  const result = await apiFetch<unknown>('/channel-admins', {
    method: 'POST',
    token,
    body: { channel, handle, admin },
  })
  if (!result.ok) return result
  const view = toChannelFromResponse(result.value)
  return view === null ? failure(200, 'bad_response', '响应缺少频道信息') : { ok: true, value: view }
}

export interface ChannelMuteInput {
  handle?: string
  all?: boolean
  muted: boolean
}

/** POST /channel-mute (human operator or channel admin). */
export async function setChannelMute(
  channel: string,
  input: ChannelMuteInput,
  token?: string,
): Promise<ApiResult<ChannelView>> {
  const result = await apiFetch<unknown>('/channel-mute', {
    method: 'POST',
    token,
    body: { channel, ...input },
  })
  if (!result.ok) return result
  const view = toChannelFromResponse(result.value)
  return view === null ? failure(200, 'bad_response', '响应缺少频道信息') : { ok: true, value: view }
}

export interface ChannelLimitsInput {
  maxChars?: number | null
  ratePerMinute?: number | null
}

/** POST /channel-limits (human operator or channel admin); null resets a field. */
export async function setChannelLimits(
  channel: string,
  input: ChannelLimitsInput,
  token?: string,
): Promise<ApiResult<ChannelView>> {
  const result = await apiFetch<unknown>('/channel-limits', {
    method: 'POST',
    token,
    body: { channel, ...input },
  })
  if (!result.ok) return result
  const view = toChannelFromResponse(result.value)
  return view === null ? failure(200, 'bad_response', '响应缺少频道信息') : { ok: true, value: view }
}

export async function fetchPins(channel: string, token?: string): Promise<ApiResult<PinWire[]>> {
  const params = new URLSearchParams({ channel })
  const result = await apiFetch<unknown>(`/pins?${params.toString()}`, { token })
  return result.ok ? { ok: true, value: toPins(result.value) } : result
}

export async function fetchWhoAmI(token?: string): Promise<ApiResult<WhoAmIResponse>> {
  const result = await apiFetch<unknown>('/whoami', { token })
  return result.ok ? { ok: true, value: toWhoAmI(result.value) } : result
}

/** POST /register；带 token 时等于「用现有身份认领新 handle」。 */
export async function registerHuman(token?: string, handle?: string): Promise<ApiResult<RegisterResponse>> {
  const body: Record<string, unknown> = { kind: 'human' }
  if (handle !== undefined && handle !== '') body.handle = handle
  // host/identity.ts 的 register 从 body.token 证明「这个 handle 是我的」；
  // Authorization 头只是传输层，不能替代 body.token。
  if (token !== undefined && token !== '') body.token = token
  const result = await apiFetch<unknown>('/register', { method: 'POST', body, token })
  if (!result.ok) return result
  const parsed = toRegister(result.value)
  if (parsed === null) return failure(200, 'bad_response', '注册响应缺少 participantId/handle/token')
  return { ok: true, value: parsed }
}

/** /claim 的结果：handle 已认领到当前 token 对应的参与者。 */
export interface ClaimResponse {
  participantId: string
  handle: string
}

/** POST /claim（不带 sessionId）：把 handle 认领给当前已认证的参与者（浏览器的「改名」）。 */
export async function claimHandle(handle: string, token?: string): Promise<ApiResult<ClaimResponse>> {
  const result = await apiFetch<unknown>('/claim', { method: 'POST', body: { handle }, token })
  if (!result.ok) return result
  const participant = normalizeParticipant(isRecord(result.value) ? (result.value.participant ?? result.value) : result.value)
  if (participant === null) return failure(200, 'bad_response', '认领响应缺少 participant')
  return { ok: true, value: { participantId: participant.id, handle: participant.handle } }
}

/* ------------------------------------------------------------------ */
/* 按会话开关（M4）：GET/POST /session-prefs                               */
/* ------------------------------------------------------------------ */

/** 浏览器侧用的精简偏好（缺省 false）。 */
export interface SessionPrefsState {
  hidden: boolean
  muted: boolean
}

function prefsRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  // host 返回 { sessionId, prefs }；也容忍裸 prefs。
  if (isRecord(value.prefs)) return value.prefs
  return value
}

/**
 * GET /session-prefs 的响应 → 完整偏好（缺省按 false）。
 * @param value - 服务端响应（{sessionId,prefs} 或裸 prefs）。
 * @returns 完整偏好；形状不认识时 null。
 */
export function toSessionPrefs(value: unknown): SessionPrefsState | null {
  const raw = prefsRecord(value)
  if (raw === null) return null
  const wrapped = isRecord(value) && isRecord(value.prefs)
  // 既没有 {prefs} 包装、也没有任一个布尔字段 → 视为形状不认识。
  if (!wrapped && typeof raw.hidden !== 'boolean' && typeof raw.muted !== 'boolean') return null
  return { hidden: raw.hidden === true, muted: raw.muted === true }
}

/**
 * POST /session-prefs 的响应 → 只包含显式出现的字段（用于合并进缓存，
 * 避免服务端返回部分字段时把另一个开关重置成 false）。
 */
export function toSessionPrefsPatch(value: unknown): Partial<SessionPrefsState> | null {
  const raw = prefsRecord(value)
  if (raw === null) return null
  const patch: { hidden?: boolean; muted?: boolean } = {}
  if (typeof raw.hidden === 'boolean') patch.hidden = raw.hidden
  if (typeof raw.muted === 'boolean') patch.muted = raw.muted
  return patch
}

/** GET /session-prefs?sessionId=（loopback 同源读信任，可不带 token）。 */
export async function fetchSessionPrefs(sessionId: string, token?: string): Promise<ApiResult<SessionPrefsState>> {
  if (sessionId === '') return failure(400, 'invalid_request', 'sessionId 不能为空')
  const params = new URLSearchParams({ sessionId })
  const result = await apiFetch<unknown>(`/session-prefs?${params.toString()}`, { token })
  if (!result.ok) return result
  const prefs = toSessionPrefs(result.value)
  if (prefs === null) return failure(200, 'bad_response', 'session-prefs 响应缺少 prefs')
  return { ok: true, value: prefs }
}

export interface SessionPrefsUpdate {
  sessionId: string
  hidden?: boolean
  muted?: boolean
}

/** POST /session-prefs {sessionId, hidden?, muted?}（需要 Bearer 身份）。 */
export async function updateSessionPrefs(
  update: SessionPrefsUpdate,
  token?: string,
): Promise<ApiResult<Partial<SessionPrefsState>>> {
  if (update.sessionId === '') return failure(400, 'invalid_request', 'sessionId 不能为空')
  const body: Record<string, unknown> = { sessionId: update.sessionId }
  if (update.hidden !== undefined) body.hidden = update.hidden
  if (update.muted !== undefined) body.muted = update.muted
  const result = await apiFetch<unknown>('/session-prefs', { method: 'POST', body, token })
  if (!result.ok) return result
  const patch = toSessionPrefsPatch(result.value)
  if (patch === null) return failure(200, 'bad_response', 'session-prefs 响应缺少 prefs')
  return { ok: true, value: patch }
}

/**
 * 复用 localStorage 里的浏览器身份；没有就注册一个 kind:'human'。
 * 供不经过面板的入口（会话菜单）使用。
 */
export async function ensureIdentity(): Promise<ApiResult<StoredIdentity>> {
  const cached = readIdentity()
  if (cached !== null) return { ok: true, value: cached }
  const registered = await registerHuman()
  if (!registered.ok) return registered
  writeIdentity(registered.value)
  return { ok: true, value: registered.value }
}

export async function heartbeat(token?: string): Promise<ApiResult<unknown>> {
  return apiFetch<unknown>('/heartbeat', { method: 'POST', body: {}, token })
}

export interface CreateChannelInput {
  id: string
  name: string
  topic?: string
  category?: string
}

export async function createChannel(input: CreateChannelInput, token?: string): Promise<ApiResult<ChannelMeta | null>> {
  const body: Record<string, unknown> = { id: input.id, name: input.name }
  if (input.topic !== undefined && input.topic !== '') body.topic = input.topic
  if (input.category !== undefined && input.category !== '') body.category = input.category
  const result = await apiFetch<unknown>('/channels', { method: 'POST', body, token })
  return result.ok ? { ok: true, value: normalizeChannel(isRecord(result.value) ? (result.value.channel ?? result.value) : result.value) } : result
}

export interface SendInput {
  channel: string
  /** 有附件时允许为空串。 */
  text: string
  clientMsgId: string
  replyTo?: string
  mentions?: readonly string[]
  /** 已上传附件的 id（POST /upload 的 attachment.id）。 */
  attachments?: readonly string[]
}

export async function sendMessage(input: SendInput, token?: string): Promise<ApiResult<ChannelMessage>> {
  const body: Record<string, unknown> = { channel: input.channel, text: input.text, clientMsgId: input.clientMsgId }
  if (input.replyTo !== undefined && input.replyTo !== '') body.replyTo = input.replyTo
  if (input.mentions !== undefined && input.mentions.length > 0) body.mentions = [...input.mentions]
  if (input.attachments !== undefined && input.attachments.length > 0) body.attachments = [...input.attachments]
  const result = await apiFetch<unknown>('/send', { method: 'POST', body, token })
  if (!result.ok) return result
  const message = toMessage(result.value)
  if (message === null) return failure(200, 'bad_response', '发送响应缺少 message')
  return { ok: true, value: message }
}

export async function pinMessage(channel: string, messageId: string, token?: string): Promise<ApiResult<unknown>> {
  return apiFetch<unknown>('/pin', { method: 'POST', body: { channel, messageId }, token })
}

export async function unpinMessage(channel: string, messageId: string, token?: string): Promise<ApiResult<unknown>> {
  return apiFetch<unknown>('/unpin', { method: 'POST', body: { channel, messageId }, token })
}

/* ------------------------------------------------------------------ */
/* 附件上传（M3）：POST /upload?name=&mime=，body 为原始字节              */
/* ------------------------------------------------------------------ */

export interface UploadInput {
  /** 浏览器 File/Blob；直接作为请求体。 */
  file: Blob
  /** 原始文件名（写进 query，host 会 sanitize）。 */
  name: string
  /** MIME；未知时用 application/octet-stream。 */
  mime: string
  signal?: AbortSignal
}

/**
 * 上传一个附件原始字节。
 * @param input - 文件、文件名、mime。
 * @param token - 身份 bearer token（host 要求 /upload 必须带身份）。
 * @returns 服务端登记后的 Attachment。
 */
export async function uploadAttachment(input: UploadInput, token?: string): Promise<ApiResult<Attachment>> {
  const params = new URLSearchParams({ name: input.name })
  if (input.mime !== '') params.set('mime', input.mime)
  const result = await apiFetch<unknown>(`/upload?${params.toString()}`, {
    method: 'POST',
    rawBody: input.file,
    contentType: input.mime !== '' ? input.mime : 'application/octet-stream',
    token,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })
  if (!result.ok) return result
  // host 返回 { attachment }；容忍裸 Attachment。
  const raw = isRecord(result.value) && result.value.attachment !== undefined ? result.value.attachment : result.value
  const attachment = normalizeAttachment(raw)
  if (attachment === null) return failure(200, 'bad_response', '上传响应缺少 attachment.id/url')
  return { ok: true, value: attachment }
}

/* ------------------------------------------------------------------ */
/* 检索（M3）：GET /search?q=&channel=&limit=                              */
/* ------------------------------------------------------------------ */

export interface SearchQuery {
  q: string
  /** 省略 = 全频道。 */
  channel?: string
  limit?: number
  beforeSeq?: number
}

/** GET /search 的响应 → SearchResponse（容忍裸数组与 {hits} 包装）。 */
export function toSearchResponse(value: unknown, query: string): SearchResponse {
  const hits: SearchHit[] = []
  for (const item of firstArray(value, ['hits', 'results', 'items', 'data'])) {
    if (!isRecord(item)) continue
    const nested = isRecord(item.message) ? item.message : undefined
    const message = normalizeMessage(nested ?? item)
    if (message === null) continue
    const channel = str(item.channel) || message.channel
    const snippet = str(item.snippet) || message.text
    hits.push({ channel, message, snippet })
  }
  const hasMore = isRecord(value) ? bool(value.hasMore) : false
  return { query, hits, hasMore }
}

export async function searchMessages(query: SearchQuery, token?: string): Promise<ApiResult<SearchResponse>> {
  const text = query.q.trim()
  if (text === '') return failure(400, 'invalid_query', '检索词不能为空')
  const params = new URLSearchParams({ q: text })
  if (query.channel !== undefined && query.channel !== '') params.set('channel', query.channel)
  params.set('limit', String(query.limit ?? SEARCH_LIMIT))
  if (query.beforeSeq !== undefined) params.set('beforeSeq', String(query.beforeSeq))
  const result = await apiFetch<unknown>(`/search?${params.toString()}`, { token })
  return result.ok ? { ok: true, value: toSearchResponse(result.value, text) } : result
}

/* ------------------------------------------------------------------ */
/* SSE URL / 身份存储 / 小工具                                          */
/* ------------------------------------------------------------------ */

/** EventSource 无法带 Authorization 头，所以身份走 query（SPEC §5）。 */
export function streamUrl(identity: StoredIdentity, afterSeq: number, channel: string): string {
  const params = new URLSearchParams({
    participant: identity.participantId,
    token: identity.token,
  })
  if (afterSeq > 0) params.set('afterSeq', String(afterSeq))
  if (channel !== '') params.set('channel', channel)
  return `${API_BASE}/stream?${params.toString()}`
}

/** 从 `${channel}-000123` 解析 seq；channel 本身可能带短横线。 */
export function seqFromMessageId(channel: string, id: string): number | null {
  const prefix = `${channel}-`
  if (!id.startsWith(prefix)) return null
  const suffix = id.slice(prefix.length)
  if (!/^\d+$/.test(suffix)) return null
  const seq = Number.parseInt(suffix, 10)
  return Number.isFinite(seq) && seq > 0 ? seq : null
}

export function readIdentity(): StoredIdentity | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY)
    if (raw === null || raw === '') return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const participantId = str(parsed.participantId)
    const handle = str(parsed.handle)
    const token = str(parsed.token)
    if (participantId === '' || handle === '' || token === '') return null
    return { participantId, handle, token }
  } catch {
    return null
  }
}

export function writeIdentity(identity: StoredIdentity): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ participantId: identity.participantId, handle: identity.handle, token: identity.token }),
    )
  } catch {
    /* 隐私模式 / 配额满：身份仅存活于内存，不影响使用 */
  }
}

export function clearIdentity(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(IDENTITY_KEY)
  } catch {
    /* ignore */
  }
}

/** 幂等键：crypto.randomUUID 优先，退化到时间戳 + 随机串。 */
export function newClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
