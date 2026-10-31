/**
 * dsh-channels 浏览器侧的传输层：同源 HTTP + SSE + 本地身份。
 *
 * 这里不依赖任何 @deepseek-ai/* 类型（浏览器 bundle 只能 import React 和
 * `../contract.js`），所以所有响应都先按 unknown 解析、再由本文件的
 * normalize* 函数宽松校验。契约以 `src/contract.ts` 为准，但 host 可能
 * 直接返回数组、也可能包一层 `{ channels }` / `{ messages }`，两种都吃。
 */
import { type Attachment, type ChannelMessage, type ChannelMeta, type HistoryResponse, type Participant, type RegisterResponse, type SearchResponse, type WhoAmIResponse } from '../contract.js';
export type ApiResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    status: number;
    code: string;
    message: string;
};
export interface ApiInit {
    method?: 'GET' | 'POST';
    body?: unknown;
    /** 原始 body（上传附件时用；与 body 互斥，不会 JSON 序列化）。 */
    rawBody?: BodyInit;
    /** 原始 body 的 content-type（默认 application/octet-stream）。 */
    contentType?: string;
    token?: string;
    signal?: AbortSignal;
    /** 额外请求头（例如 Accept）。 */
    headers?: Record<string, string>;
}
/** host 的 GET /channels 视图：ChannelMeta + 每参与者未读数（见 host/hub.ts ChannelView）。 */
export interface ChannelView extends ChannelMeta {
    readonly lastSeq?: number;
    readonly unread?: number;
}
/** localStorage 里的浏览器身份（SPEC §8：{participantId, token, handle}）。 */
export interface StoredIdentity {
    participantId: string;
    handle: string;
    token: string;
}
export declare const IDENTITY_KEY = "dsh-channels.identity";
/**
 * 单条附件的宽松转换；形状不认识（无 id 或 url）时返回 null。
 * @param value - 服务端返回的 Attachment 形状。
 * @returns 归一化后的附件，或 null。
 */
export declare function normalizeAttachment(value: unknown): Attachment | null;
/** attachments 数组的宽松解析（容忍缺失 / 非数组 / 坏条目）。 */
export declare function toAttachments(value: unknown): Attachment[];
/** 单条消息的宽松转换；形状不认识时返回 null。 */
export declare function normalizeMessage(value: unknown): ChannelMessage | null;
export declare function normalizeParticipant(value: unknown): Participant | null;
export declare function normalizeChannel(value: unknown): ChannelMeta | null;
/** GET /channels 的响应 → ChannelView[]（兼容 ChannelMeta[] 与带 unread 的视图）。 */
export declare function toChannelViews(value: unknown): ChannelView[];
/** GET /members 的响应 → Participant[]。 */
export declare function toMembers(value: unknown): Participant[];
/** 置顶条目：可能是 PinEntry、可能直接是 ChannelMessage，也可能两者都带。 */
export interface PinWire {
    messageId: string;
    by: string;
    at: string;
    message?: ChannelMessage;
}
export declare function toPins(value: unknown): PinWire[];
/** GET /history 的响应 → HistoryResponse（按 seq 升序）。 */
export declare function toHistory(value: unknown, fallbackChannel: string): HistoryResponse;
/** /send 的响应 → ChannelMessage（兼容 {message} 与裸消息）。 */
export declare function toMessage(value: unknown): ChannelMessage | null;
/** /register 的响应 → RegisterResponse。 */
export declare function toRegister(value: unknown): RegisterResponse | null;
export type IncomingFrame = {
    kind: 'hello';
    channels: ChannelView[];
    participant: Participant | null;
} | {
    kind: 'message';
    message: ChannelMessage;
} | {
    kind: 'channel';
    channel: ChannelMeta;
} | {
    kind: 'presence';
    participant: Participant;
};
/**
 * 解析一帧 SSE data（可能是 `{type:'message', message}`，也可能按 SPEC
 * 直接是 `ChannelMessage` / `ChannelMeta` / `Participant`）。
 * @param data - EventSource 的 data 字符串。
 * @returns 归一化后的帧；无法识别时 null。
 */
export declare function parseStreamFrame(data: string): IncomingFrame | null;
/** 同源 fetch，统一错误形状：非 2xx → `{ error: { code, message } }`。 */
export declare function apiFetch<T>(path: string, init?: ApiInit): Promise<ApiResult<T>>;
export interface HistoryQuery {
    channel: string;
    beforeSeq?: number;
    afterSeq?: number;
    limit?: number;
}
export declare function fetchChannels(token?: string): Promise<ApiResult<ChannelView[]>>;
export declare function fetchHistory(query: HistoryQuery, token?: string): Promise<ApiResult<HistoryResponse>>;
export declare function fetchMembers(channel: string, token?: string): Promise<ApiResult<Participant[]>>;
export declare function fetchPins(channel: string, token?: string): Promise<ApiResult<PinWire[]>>;
export declare function fetchWhoAmI(token?: string): Promise<ApiResult<WhoAmIResponse>>;
/** POST /register；带 token 时等于「用现有身份认领新 handle」。 */
export declare function registerHuman(token?: string, handle?: string): Promise<ApiResult<RegisterResponse>>;
/** /claim 的结果：handle 已认领到当前 token 对应的参与者。 */
export interface ClaimResponse {
    participantId: string;
    handle: string;
}
/** POST /claim（不带 sessionId）：把 handle 认领给当前已认证的参与者（浏览器的「改名」）。 */
export declare function claimHandle(handle: string, token?: string): Promise<ApiResult<ClaimResponse>>;
/** 浏览器侧用的精简偏好（缺省 false）。 */
export interface SessionPrefsState {
    hidden: boolean;
    muted: boolean;
}
/**
 * GET /session-prefs 的响应 → 完整偏好（缺省按 false）。
 * @param value - 服务端响应（{sessionId,prefs} 或裸 prefs）。
 * @returns 完整偏好；形状不认识时 null。
 */
export declare function toSessionPrefs(value: unknown): SessionPrefsState | null;
/**
 * POST /session-prefs 的响应 → 只包含显式出现的字段（用于合并进缓存，
 * 避免服务端返回部分字段时把另一个开关重置成 false）。
 */
export declare function toSessionPrefsPatch(value: unknown): Partial<SessionPrefsState> | null;
/** GET /session-prefs?sessionId=（loopback 同源读信任，可不带 token）。 */
export declare function fetchSessionPrefs(sessionId: string, token?: string): Promise<ApiResult<SessionPrefsState>>;
export interface SessionPrefsUpdate {
    sessionId: string;
    hidden?: boolean;
    muted?: boolean;
}
/** POST /session-prefs {sessionId, hidden?, muted?}（需要 Bearer 身份）。 */
export declare function updateSessionPrefs(update: SessionPrefsUpdate, token?: string): Promise<ApiResult<Partial<SessionPrefsState>>>;
/**
 * 复用 localStorage 里的浏览器身份；没有就注册一个 kind:'human'。
 * 供不经过面板的入口（会话菜单）使用。
 */
export declare function ensureIdentity(): Promise<ApiResult<StoredIdentity>>;
export declare function heartbeat(token?: string): Promise<ApiResult<unknown>>;
export interface CreateChannelInput {
    id: string;
    name: string;
    topic?: string;
    category?: string;
}
export declare function createChannel(input: CreateChannelInput, token?: string): Promise<ApiResult<ChannelMeta | null>>;
export interface SendInput {
    channel: string;
    /** 有附件时允许为空串。 */
    text: string;
    clientMsgId: string;
    replyTo?: string;
    mentions?: readonly string[];
    /** 已上传附件的 id（POST /upload 的 attachment.id）。 */
    attachments?: readonly string[];
}
export declare function sendMessage(input: SendInput, token?: string): Promise<ApiResult<ChannelMessage>>;
export declare function pinMessage(channel: string, messageId: string, token?: string): Promise<ApiResult<unknown>>;
export declare function unpinMessage(channel: string, messageId: string, token?: string): Promise<ApiResult<unknown>>;
export interface UploadInput {
    /** 浏览器 File/Blob；直接作为请求体。 */
    file: Blob;
    /** 原始文件名（写进 query，host 会 sanitize）。 */
    name: string;
    /** MIME；未知时用 application/octet-stream。 */
    mime: string;
    signal?: AbortSignal;
}
/**
 * 上传一个附件原始字节。
 * @param input - 文件、文件名、mime。
 * @param token - 身份 bearer token（host 要求 /upload 必须带身份）。
 * @returns 服务端登记后的 Attachment。
 */
export declare function uploadAttachment(input: UploadInput, token?: string): Promise<ApiResult<Attachment>>;
export interface SearchQuery {
    q: string;
    /** 省略 = 全频道。 */
    channel?: string;
    limit?: number;
    beforeSeq?: number;
}
/** GET /search 的响应 → SearchResponse（容忍裸数组与 {hits} 包装）。 */
export declare function toSearchResponse(value: unknown, query: string): SearchResponse;
export declare function searchMessages(query: SearchQuery, token?: string): Promise<ApiResult<SearchResponse>>;
/** EventSource 无法带 Authorization 头，所以身份走 query（SPEC §5）。 */
export declare function streamUrl(identity: StoredIdentity, afterSeq: number, channel: string): string;
/** 从 `${channel}-000123` 解析 seq；channel 本身可能带短横线。 */
export declare function seqFromMessageId(channel: string, id: string): number | null;
export declare function readIdentity(): StoredIdentity | null;
export declare function writeIdentity(identity: StoredIdentity): void;
export declare function clearIdentity(): void;
/** 幂等键：crypto.randomUUID 优先，退化到时间戳 + 随机串。 */
export declare function newClientMsgId(): string;
