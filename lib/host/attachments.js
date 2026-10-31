/**
 * dsh-channels attachment store (SPEC.md §3/§7.5).
 *
 * Layout:
 *
 *   <dataDir>/attachments/<id>       raw bytes (written once, never modified)
 *   <dataDir>/attachments/<id>.json  metadata { id, name, mime, size, ownerId, createdAt }
 *
 * Attachments are immutable: the bytes are written to a temp sibling and
 * renamed into place, so a reader never observes a half-written file and a
 * crash leaves only an orphaned `.tmp-*` that no metadata points at.
 *
 * Security invariants:
 *  - ids are minted here and re-validated at every read (`/^att_[0-9a-f]{16}$/`),
 *    so a caller-supplied id can never escape the attachments directory;
 *  - displayed names are basenames with control characters removed and are
 *    truncated to 120 characters;
 *  - mime types are normalized to `type/subtype`; anything malformed is rejected
 *    by the caller (HTTP 415) instead of being echoed into response headers;
 *  - inline rendering is decided by {@link isInlineImageMime} only, never by the
 *    filename.
 */
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { API_BASE, MAX_ATTACHMENT_BYTES, isInlineImageMime } from '../contract.js';
import { HostError, ensureDir, errMessage, isoNow, readJsonFile, writeFileAtomic, writeJsonAtomic } from './util.js';
/** Minted attachment ids: `att_` + 16 lowercase hex characters. */
export const ATTACHMENT_ID_RE = /^att_[0-9a-f]{16}$/;
/** Maximum length of a stored (and displayed) filename. */
const MAX_NAME_LENGTH = 120;
/** True when a caller-supplied string is a legal attachment id. */
export function isAttachmentId(value) {
    return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}
/**
 * Sanitize a client-supplied filename into something safe to store and echo.
 * Keeps only the basename, drops control characters and leading dots, and
 * truncates the stem while preserving a short extension.
 */
export function sanitizeAttachmentName(raw) {
    const source = typeof raw === 'string' ? raw : '';
    let name = basename(source.replace(/\\/g, '/'));
    name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    name = name.replace(/^\.+/, '');
    if (name.length === 0)
        return 'file';
    if (name.length > MAX_NAME_LENGTH) {
        const extension = extname(name);
        const suffix = extension.length > 0 && extension.length <= 16 ? extension : '';
        const stem = suffix.length > 0 ? name.slice(0, name.length - suffix.length) : name;
        name = `${stem.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length))}${suffix}`;
    }
    return name;
}
/**
 * Normalize a declared mime type to lowercase `type/subtype`.
 *
 * @returns the normalized type, or `undefined` when the value is absent or
 *   malformed. Callers distinguish "absent" (fall back to octet-stream) from
 *   "malformed" (reject with 415) using the raw input.
 */
export function normalizeMime(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = (raw.split(';')[0] ?? '').trim().toLowerCase();
    if (value.length === 0)
        return undefined;
    return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(value) ? value : undefined;
}
const MIME_BY_EXTENSION = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.log': 'text/plain',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/plain',
};
/** Best-effort mime guess from a filename (falls back to octet-stream). */
export function guessMimeFromName(name) {
    const extension = extname(name).toLowerCase();
    return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}
/**
 * Mime types too generic to describe a file: a raw `fetch`/`curl` upload sends
 * one of these regardless of the payload, so a filename extension is a better
 * signal and wins over them.
 */
const LOW_CONFIDENCE_MIME = new Set([
    'application/octet-stream',
    'application/x-www-form-urlencoded',
]);
/** Pick the mime to store: an explicit specific type wins, generic headers lose to the extension. */
function resolveStoredMime(declared, name) {
    const guessed = guessMimeFromName(name);
    if (declared === undefined)
        return guessed;
    if (LOW_CONFIDENCE_MIME.has(declared) && guessed !== 'application/octet-stream')
        return guessed;
    return declared;
}
/**
 * Read PNG/GIF/JPEG/WebP dimensions from a header probe. Best effort: any
 * unexpected layout simply yields `undefined` rather than failing the upload.
 */
export function probeImageSize(bytes) {
    try {
        // PNG: 8-byte signature, then IHDR with big-endian width/height.
        if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            const width = bytes.readUInt32BE(16);
            const height = bytes.readUInt32BE(20);
            return width > 0 && height > 0 ? { width, height } : undefined;
        }
        // GIF: logical screen descriptor, little-endian.
        if (bytes.length >= 10 && bytes.toString('ascii', 0, 4) === 'GIF8') {
            const width = bytes.readUInt16LE(6);
            const height = bytes.readUInt16LE(8);
            return width > 0 && height > 0 ? { width, height } : undefined;
        }
        // JPEG: walk marker segments until a start-of-frame carries the dimensions.
        if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
            let offset = 2;
            while (offset + 9 <= bytes.length) {
                if (bytes[offset] !== 0xff) {
                    offset += 1;
                    continue;
                }
                const marker = bytes[offset + 1] ?? 0;
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    offset += 2;
                    continue;
                }
                const length = bytes.readUInt16BE(offset + 2);
                if (length < 2)
                    return undefined;
                const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
                if (isStartOfFrame) {
                    const height = bytes.readUInt16BE(offset + 5);
                    const width = bytes.readUInt16BE(offset + 7);
                    return width > 0 && height > 0 ? { width, height } : undefined;
                }
                offset += 2 + length;
            }
            return undefined;
        }
        // WebP: RIFF container with VP8X / VP8 / VP8L payloads.
        if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
            const kind = bytes.toString('ascii', 12, 16);
            if (kind === 'VP8X') {
                const width = 1 + bytes.readUIntLE(24, 3);
                const height = 1 + bytes.readUIntLE(27, 3);
                return { width, height };
            }
            if (kind === 'VP8 ') {
                const width = bytes.readUInt16LE(26) & 0x3fff;
                const height = bytes.readUInt16LE(28) & 0x3fff;
                return width > 0 && height > 0 ? { width, height } : undefined;
            }
            if (kind === 'VP8L') {
                const bits = bytes.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
            }
        }
    }
    catch {
        /* truncated/malformed header: no dimensions, still a valid upload */
    }
    return undefined;
}
/** Public wire projection of stored metadata (adds the serving URL). */
export function publicAttachment(meta) {
    return {
        id: meta.id,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        url: `${API_BASE}/attachments/${meta.id}`,
        ...(meta.width !== undefined && meta.height !== undefined ? { width: meta.width, height: meta.height } : {}),
    };
}
/** Parse one persisted attachment reference (tolerant: unknown shapes are dropped). */
export function parseAttachment(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const raw = value;
    if (!isAttachmentId(raw.id))
        return undefined;
    if (typeof raw.name !== 'string' || raw.name.length === 0)
        return undefined;
    if (typeof raw.mime !== 'string' || raw.mime.length === 0)
        return undefined;
    if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0)
        return undefined;
    const url = typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : `${API_BASE}/attachments/${raw.id}`;
    const width = typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0 ? Math.floor(raw.width) : undefined;
    const height = typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0 ? Math.floor(raw.height) : undefined;
    return {
        id: raw.id,
        name: sanitizeAttachmentName(raw.name),
        mime: normalizeMime(raw.mime) ?? 'application/octet-stream',
        size: Math.floor(raw.size),
        url,
        ...(width !== undefined && height !== undefined ? { width, height } : {}),
    };
}
function parseAttachmentMeta(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const raw = value;
    if (!isAttachmentId(raw.id))
        return undefined;
    if (typeof raw.name !== 'string' || raw.name.length === 0)
        return undefined;
    if (typeof raw.mime !== 'string' || raw.mime.length === 0)
        return undefined;
    if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0)
        return undefined;
    if (typeof raw.ownerId !== 'string' || raw.ownerId.length === 0)
        return undefined;
    const width = typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0 ? Math.floor(raw.width) : undefined;
    const height = typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0 ? Math.floor(raw.height) : undefined;
    return {
        id: raw.id,
        name: raw.name,
        mime: raw.mime,
        size: Math.floor(raw.size),
        ownerId: raw.ownerId,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : isoNow(),
        ...(width !== undefined && height !== undefined ? { width, height } : {}),
    };
}
/**
 * The immutable attachment blob store. One instance per hub; reads are always
 * allowed, writes only when the hub owns the data directory.
 */
export class AttachmentStore {
    dir;
    readonlyMode;
    /** Highest byte count accepted per upload (config override, default 25MB). */
    maxBytes;
    constructor(dataDir, readonlyMode, maxBytes = MAX_ATTACHMENT_BYTES) {
        this.dir = join(dataDir, 'attachments');
        this.readonlyMode = readonlyMode;
        this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_ATTACHMENT_BYTES;
    }
    // -- paths ----------------------------------------------------------------
    /** Absolute path of one attachment's bytes (id already validated by callers). */
    pathOf(id) {
        if (!isAttachmentId(id))
            throw new HostError(404, 'not_found', 'unknown attachment id');
        return join(this.dir, id);
    }
    metaPathOf(id) {
        if (!isAttachmentId(id))
            throw new HostError(404, 'not_found', 'unknown attachment id');
        return join(this.dir, `${id}.json`);
    }
    // -- writes ---------------------------------------------------------------
    /**
     * Store one immutable attachment and return its metadata.
     *
     * @throws HostError 503 when the hub is read-only, 413 when the payload is
     *   over the configured cap, 400 when the payload is empty.
     */
    save(input) {
        if (this.readonlyMode)
            throw new HostError(503, 'readonly', 'hub is read-only');
        const bytes = input.bytes;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
            throw new HostError(400, 'invalid_request', 'attachment payload is empty');
        }
        const maxBytes = input.maxBytes !== undefined && input.maxBytes > 0 ? Math.floor(input.maxBytes) : this.maxBytes;
        if (bytes.length > maxBytes) {
            throw new HostError(413, 'payload_too_large', `attachment is ${bytes.length} bytes; the limit is ${maxBytes} bytes`);
        }
        if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
            throw new HostError(400, 'invalid_request', 'attachment owner is required');
        }
        const id = `att_${randomBytes(8).toString('hex')}`;
        const name = sanitizeAttachmentName(input.name);
        const mime = resolveStoredMime(normalizeMime(input.mime), name);
        const dimensions = isInlineImageMime(mime) ? probeImageSize(bytes) : undefined;
        const meta = {
            id,
            name,
            mime,
            size: bytes.length,
            ownerId: input.ownerId,
            createdAt: isoNow(),
            ...(dimensions !== undefined ? { width: dimensions.width, height: dimensions.height } : {}),
        };
        ensureDir(this.dir);
        const path = join(this.dir, id);
        const tmp = join(this.dir, `.tmp-${id}-${process.pid}`);
        try {
            // Raw bytes: temp file + rename = immutable and crash-safe.
            writeFileSync(tmp, bytes);
            renameSync(tmp, path);
            writeJsonAtomic(this.metaPathOf(id), meta);
        }
        catch (error) {
            try {
                unlinkSync(tmp);
            }
            catch {
                /* temp may already be renamed */
            }
            try {
                rmSync(path, { force: true });
            }
            catch {
                /* nothing was written */
            }
            throw new HostError(500, 'storage_error', `failed to store attachment: ${errMessage(error)}`);
        }
        return meta;
    }
    // -- reads ----------------------------------------------------------------
    /** Metadata for one attachment, or undefined when unknown/unreadable. */
    meta(id) {
        if (!isAttachmentId(id))
            return undefined;
        return parseAttachmentMeta(readJsonFile(this.metaPathOf(id)));
    }
    /** True when both the bytes and the metadata exist. */
    has(id) {
        if (!isAttachmentId(id))
            return false;
        return this.meta(id) !== undefined && existsSync(this.pathOf(id));
    }
    /** Size on disk of the stored bytes (falls back to metadata). */
    sizeOf(id) {
        try {
            return statSync(this.pathOf(id)).size;
        }
        catch {
            return this.meta(id)?.size ?? 0;
        }
    }
    /** Open a read stream for serving (caller owns the stream). */
    createStream(id) {
        if (!isAttachmentId(id))
            return undefined;
        if (!existsSync(this.pathOf(id)))
            return undefined;
        return createReadStream(this.pathOf(id));
    }
    /** Read the whole payload (tools/tests only: bounded by the upload cap). */
    read(id) {
        if (!isAttachmentId(id))
            return undefined;
        try {
            return readFileSync(this.pathOf(id));
        }
        catch {
            return undefined;
        }
    }
    /** First `length` bytes of an attachment (header probes, diagnostics). */
    readHead(id, length = 64) {
        if (!isAttachmentId(id))
            return undefined;
        let fd;
        try {
            fd = openSync(this.pathOf(id), 'r');
            const buffer = Buffer.alloc(Math.max(1, Math.min(length, 4096)));
            const read = readSync(fd, buffer, 0, buffer.length, 0);
            return buffer.subarray(0, read);
        }
        catch {
            return undefined;
        }
        finally {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
}
/** Re-export the atomic writer used by tests that fabricate metadata. */
export { writeFileAtomic };
//# sourceMappingURL=attachments.js.map