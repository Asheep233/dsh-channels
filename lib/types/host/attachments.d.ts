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
import type { ReadStream } from 'node:fs';
import type { Attachment } from '../contract.js';
import { writeFileAtomic } from './util.js';
/** Minted attachment ids: `att_` + 16 lowercase hex characters. */
export declare const ATTACHMENT_ID_RE: RegExp;
/** Stored metadata for one attachment (superset of the wire shape). */
export interface AttachmentMeta {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly ownerId: string;
    readonly createdAt: string;
    readonly width?: number;
    readonly height?: number;
}
export interface SaveAttachmentInput {
    readonly name?: unknown;
    readonly mime?: string;
    readonly bytes: Buffer;
    readonly ownerId: string;
    /** Reject payloads above this size (defaults to the contract cap). */
    readonly maxBytes?: number;
}
/** True when a caller-supplied string is a legal attachment id. */
export declare function isAttachmentId(value: unknown): value is string;
/**
 * Sanitize a client-supplied filename into something safe to store and echo.
 * Keeps only the basename, drops control characters and leading dots, and
 * truncates the stem while preserving a short extension.
 */
export declare function sanitizeAttachmentName(raw: unknown): string;
/**
 * Normalize a declared mime type to lowercase `type/subtype`.
 *
 * @returns the normalized type, or `undefined` when the value is absent or
 *   malformed. Callers distinguish "absent" (fall back to octet-stream) from
 *   "malformed" (reject with 415) using the raw input.
 */
export declare function normalizeMime(raw: unknown): string | undefined;
/** Best-effort mime guess from a filename (falls back to octet-stream). */
export declare function guessMimeFromName(name: string): string;
/**
 * Read PNG/GIF/JPEG/WebP dimensions from a header probe. Best effort: any
 * unexpected layout simply yields `undefined` rather than failing the upload.
 */
export declare function probeImageSize(bytes: Buffer): {
    width: number;
    height: number;
} | undefined;
/** Public wire projection of stored metadata (adds the serving URL). */
export declare function publicAttachment(meta: AttachmentMeta): Attachment;
/** Parse one persisted attachment reference (tolerant: unknown shapes are dropped). */
export declare function parseAttachment(value: unknown): Attachment | undefined;
/**
 * The immutable attachment blob store. One instance per hub; reads are always
 * allowed, writes only when the hub owns the data directory.
 */
export declare class AttachmentStore {
    readonly dir: string;
    private readonly readonlyMode;
    /** Highest byte count accepted per upload (config override, default 25MB). */
    readonly maxBytes: number;
    constructor(dataDir: string, readonlyMode: boolean, maxBytes?: number);
    /** Absolute path of one attachment's bytes (id already validated by callers). */
    pathOf(id: string): string;
    metaPathOf(id: string): string;
    /**
     * Store one immutable attachment and return its metadata.
     *
     * @throws HostError 503 when the hub is read-only, 413 when the payload is
     *   over the configured cap, 400 when the payload is empty.
     */
    save(input: SaveAttachmentInput): AttachmentMeta;
    /** Metadata for one attachment, or undefined when unknown/unreadable. */
    meta(id: unknown): AttachmentMeta | undefined;
    /** True when both the bytes and the metadata exist. */
    has(id: unknown): boolean;
    /** Size on disk of the stored bytes (falls back to metadata). */
    sizeOf(id: string): number;
    /** Open a read stream for serving (caller owns the stream). */
    createStream(id: unknown): ReadStream | undefined;
    /** Read the whole payload (tools/tests only: bounded by the upload cap). */
    read(id: unknown): Buffer | undefined;
    /** First `length` bytes of an attachment (header probes, diagnostics). */
    readHead(id: unknown, length?: number): Buffer | undefined;
}
/** Re-export the atomic writer used by tests that fabricate metadata. */
export { writeFileAtomic };
