/**
 * dsh-channels shared contract.
 *
 * Host, browser client and the external CLI/MCP bridge all speak these shapes.
 * Keep this file dependency-free (no `node:` import, no React) so both build
 * faces can import it.
 */
export declare const PLUGIN_ID = "dsh-channels";
export declare const API_BASE = "/channels/api";
export declare const DEFAULT_CHANNEL = "general";
export declare const MAX_TEXT_BYTES: number;
export declare const MAX_PAGE = 100;
export declare const WAKE_RATE_MS = 5000;
export declare const ANNOUNCE_RATE_MS: number;
export declare const CLAIM_TOKEN_BYTES = 32;
export declare const MAX_ATTACHMENTS = 10;
export declare const MAX_ATTACHMENT_BYTES: number;
export declare const MAX_ATTACHMENT_TOTAL_BYTES: number;
export declare const SEARCH_LIMIT = 50;
/** Per-session channel preferences (persisted by session id). */
export interface SessionPrefs {
    /** Hide the whole channel feature from this session (tools masked + no wake). */
    readonly hidden?: boolean;
    /** Do not wake this session on @mention / reply (messages are still stored). */
    readonly muted?: boolean;
    readonly updatedAt?: string;
    readonly updatedBy?: string;
}
export interface SessionPrefsResponse {
    readonly sessionId: string;
    readonly prefs: SessionPrefs;
}
/** Host tools that make up the channel surface (used to mask a hidden session). */
export declare const CHANNEL_TOOL_NAMES: readonly ["channel_list", "channel_history", "channel_send", "channel_create", "channel_members", "channel_whoami", "channel_claim", "channel_login", "channel_release", "channel_pin", "channel_unpin", "channel_announce", "channel_pins", "channel_archive", "channel_search", "channel_upload", "channel_join", "channel_leave", "channel_mute", "channel_unmute", "channel_set_limits"];
export type ParticipantKind = 'human' | 'dsh-agent' | 'external';
export type HarnessName = 'dsh' | 'claude-code' | 'codex' | 'opencode' | 'other';
export type MessageKind = 'chat' | 'announcement';
export type ParticipantStatus = 'online' | 'idle' | 'offline';
export interface ParticipantBinding {
    readonly kind: 'dsh-session';
    readonly sessionId: string;
}
export interface AuthorSnapshot {
    readonly participantId: string;
    readonly handle: string;
    readonly displayName: string;
    readonly kind: ParticipantKind;
    readonly harness: HarnessName;
}
export interface ReplyRef {
    readonly id: string;
    readonly seq: number;
    readonly authorName: string;
    readonly excerpt: string;
}
/** One stored attachment referenced by a message. */
export interface Attachment {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    /** Same-origin URL that serves the bytes (GET, loopback read trust). */
    readonly url: string;
    readonly width?: number;
    readonly height?: number;
}
export interface ChannelMessage {
    readonly id: string;
    readonly channel: string;
    readonly seq: number;
    readonly ts: string;
    readonly author: AuthorSnapshot;
    readonly text: string;
    readonly mentions: readonly string[];
    readonly replyTo?: ReplyRef;
    readonly kind: MessageKind;
    readonly attachments?: readonly Attachment[];
}
export interface PinEntry {
    readonly messageId: string;
    readonly by: string;
    readonly at: string;
}
export interface ChannelMeta {
    readonly id: string;
    readonly name: string;
    readonly topic?: string;
    readonly category?: string;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly pins: readonly PinEntry[];
    readonly announcementId?: string;
    /** Archived channels stay readable but are hidden from the normal list and reject new messages. */
    readonly archived?: boolean;
}
/**
 * Per-channel admin policy (SPEC §7.10). `admins` / `muted` are participant ids
 * in the store; API views map them to handles.
 */
export interface ChannelPolicy {
    readonly admins: readonly string[];
    readonly muted: readonly string[];
    readonly mutedAll: boolean;
    /** Per-message character cap; null = server default. */
    readonly maxChars: number | null;
    /** Per-participant messages per rolling minute; null = server default. */
    readonly ratePerMinute: number | null;
}
/** Channel metadata plus the caller's view (unread + membership + policy). */
export interface ChannelView extends ChannelMeta {
    readonly lastSeq: number;
    readonly unread: number;
    /** True when the caller may read/write this channel (humans always true). */
    readonly joined: boolean;
    readonly memberCount: number;
    /** Channel admins as handles (only the human operator can appoint them). */
    readonly admins: readonly string[];
    /** Explicitly muted members as handles. */
    readonly muted: readonly string[];
    readonly mutedAll: boolean;
    readonly maxChars: number | null;
    readonly ratePerMinute: number | null;
    /** True when the caller is the human operator or an admin of this channel. */
    readonly canManage: boolean;
    /** True when the caller may appoint/remove admins (human operator only). */
    readonly canAppointAdmins: boolean;
}
/** Bounds accepted by POST /channel-limits and channel_set_limits. */
export declare const MAX_CHANNEL_TEXT_CHARS = 8192;
export declare const MAX_CHANNEL_RATE_PER_MINUTE = 600;
export interface MembershipResponse {
    readonly channel: string;
    readonly joined: boolean;
    readonly memberCount: number;
}
export interface Participant {
    readonly id: string;
    readonly handle: string;
    readonly displayName: string;
    readonly kind: ParticipantKind;
    readonly harness: HarnessName;
    readonly createdAt: string;
    readonly lastSeen: string;
    readonly status: ParticipantStatus;
    /** SHA-256 of the bearer token; never returned by any API. */
    readonly tokenHash?: string;
    readonly binding?: ParticipantBinding;
    /** Only set on per-channel member lists: this participant is a channel admin. */
    readonly admin?: boolean;
    /** Only set on per-channel member lists: this participant is muted here. */
    readonly muted?: boolean;
}
export interface RegisterRequest {
    readonly kind: ParticipantKind;
    readonly handle?: string;
    readonly displayName?: string;
    readonly harness?: HarnessName;
}
export interface RegisterResponse {
    readonly participantId: string;
    readonly handle: string;
    readonly token: string;
}
export interface SendRequest {
    readonly channel: string;
    readonly text: string;
    readonly replyTo?: string;
    readonly mentions?: readonly string[];
    readonly attachments?: readonly string[];
    readonly clientMsgId?: string;
}
export interface SendResponse {
    readonly message: ChannelMessage;
}
/** Result of a raw attachment upload (POST /upload). */
export interface UploadResponse {
    readonly attachment: Attachment;
}
/** One search hit: the full message plus a short match snippet. */
export interface SearchHit {
    readonly channel: string;
    readonly message: ChannelMessage;
    readonly snippet: string;
}
export interface SearchResponse {
    readonly query: string;
    readonly hits: readonly SearchHit[];
    readonly hasMore: boolean;
}
export interface HistoryResponse {
    readonly channel: string;
    readonly messages: readonly ChannelMessage[];
    readonly hasMore: boolean;
}
export interface WhoAmIResponse {
    readonly participant: Participant | null;
}
export interface ApiErrorBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
}
export interface HelloFrame {
    readonly type: 'hello';
    readonly participantId: string;
    readonly lastSeq: number;
}
export interface MessageFrame {
    readonly type: 'message';
    readonly message: ChannelMessage;
}
export interface ChannelFrame {
    readonly type: 'channel';
    readonly channel: ChannelMeta;
}
export interface PresenceFrame {
    readonly type: 'presence';
    readonly participant: Participant;
}
export interface PolicyFrame {
    readonly type: 'policy';
    readonly channel: string;
    readonly admins: readonly string[];
    readonly muted: readonly string[];
    readonly mutedAll: boolean;
    readonly maxChars: number | null;
    readonly ratePerMinute: number | null;
}
export type StreamFrame = HelloFrame | MessageFrame | ChannelFrame | PresenceFrame | PolicyFrame;
export declare const RESERVED_HANDLES: ReadonlySet<string>;
/** True when the value is a legal channel id (slug). */
export declare function isValidChannelId(value: unknown): value is string;
/** True when the value is a legal handle. */
export declare function isValidHandle(value: unknown): value is string;
/** Normalize a user-supplied handle (lowercase, trim). */
export declare function normalizeHandle(value: string): string;
/** Message id for a channel sequence. */
export declare function messageId(channel: string, seq: number): string;
/** Parse `@handle` mentions out of a message body. */
export declare function parseMentions(text: string): string[];
/** One-line preview used by reply quotes and notifications. */
export declare function excerpt(text: string, limit?: number): string;
/** Human-readable byte size (UI / CLI). */
export declare function humanSize(bytes: number): string;
/** True when the mime type is a browser-inlineable raster image. */
export declare function isInlineImageMime(mime: string): boolean;
/** Byte length of a UTF-8 string. */
export declare function utf8Bytes(text: string): number;
/** Extract a short display name from a session/agent id. */
export declare function shortName(id: string): string;
