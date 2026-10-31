/**
 * dsh-channels shared contract.
 *
 * Host, browser client and the external CLI/MCP bridge all speak these shapes.
 * Keep this file dependency-free (no `node:` import, no React) so both build
 * faces can import it.
 */
export const PLUGIN_ID = 'dsh-channels';
export const API_BASE = '/channels/api';
export const DEFAULT_CHANNEL = 'general';
export const MAX_TEXT_BYTES = 8 * 1024;
export const MAX_PAGE = 100;
export const WAKE_RATE_MS = 5_000;
export const ANNOUNCE_RATE_MS = 10 * 60_000;
export const CLAIM_TOKEN_BYTES = 32;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
export const SEARCH_LIMIT = 50;
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
];
const HANDLE_RE = /^[a-z0-9_-]{2,24}$/;
export const RESERVED_HANDLES = new Set([
    'all',
    'here',
    'channel',
    'system',
    'everyone',
]);
/** True when the value is a legal channel id (slug). */
export function isValidChannelId(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
}
/** True when the value is a legal handle. */
export function isValidHandle(value) {
    return typeof value === 'string' && HANDLE_RE.test(value) && !RESERVED_HANDLES.has(value);
}
/** Normalize a user-supplied handle (lowercase, trim). */
export function normalizeHandle(value) {
    return value.trim().toLowerCase();
}
/** Message id for a channel sequence. */
export function messageId(channel, seq) {
    return `${channel}-${seq.toString().padStart(6, '0')}`;
}
/** Parse `@handle` mentions out of a message body. */
export function parseMentions(text) {
    const out = [];
    const re = /@([a-z0-9_-]{2,24})/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
        const handle = normalizeHandle(match[1] ?? '');
        if (handle.length > 0 && !out.includes(handle))
            out.push(handle);
    }
    return out;
}
/** One-line preview used by reply quotes and notifications. */
export function excerpt(text, limit = 120) {
    return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** Human-readable byte size (UI / CLI). */
export function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '?';
    if (bytes < 1024)
        return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/** True when the mime type is a browser-inlineable raster image. */
export function isInlineImageMime(mime) {
    return /^image\/(png|jpeg|gif|webp)$/i.test(mime);
}
/** Byte length of a UTF-8 string. */
export function utf8Bytes(text) {
    return new TextEncoder().encode(text).length;
}
/** Extract a short display name from a session/agent id. */
export function shortName(id) {
    return id.replace(/^session-/, '').slice(0, 6);
}
//# sourceMappingURL=contract.js.map