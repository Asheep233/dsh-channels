/**
 * dsh-channels host utilities.
 *
 * Zero-dependency primitives shared by the host modules: paths, atomic state
 * writes, the single-writer hub lock, a keyed serial queue, append-only JSONL
 * helpers (tolerant of a trailing partial line), ids and token hashing.
 *
 * Only `node:` builtins and `../contract.js` may be imported here.
 */
import type { Participant } from '../contract.js';
/** Text-only content block shape accepted by `Agent.followup` / `prompt`. */
export interface TextBlockLike {
    readonly type: 'text';
    readonly text: string;
}
/** One durable user message accepted by `Agent.followup` / `Agent.steer`. */
export interface UserMessageLike {
    readonly id: string;
    readonly role: 'user';
    readonly content: readonly TextBlockLike[];
    readonly source: {
        readonly kind: string;
    };
}
/** The live-agent face this plugin uses (session ids double as agent ids). */
export interface AgentLike {
    readonly id: string;
    readonly session?: {
        readonly header?: {
            readonly cwd?: string;
        };
    };
    followup?(message: UserMessageLike): void;
    steer?(message: UserMessageLike): void;
}
/** A registered web route (see `@deepseek-ai/dsh-host-webserver`). */
export interface WebRouteLike {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>;
}
export interface WebServerLike {
    register(route: WebRouteLike): () => void;
    getOrigin?(): string;
    readonly port?: number;
    readonly host?: string;
}
export interface ToolsLike {
    register(definition: unknown): () => void;
}
export interface AgentsLike {
    list(): readonly AgentLike[];
    get?(id: string): AgentLike | undefined;
}
export interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
/** Cordis context subset used by the host half. */
export interface CtxLike {
    effect(execute: () => (() => unknown) | Iterable<() => unknown>, label?: string): unknown;
    get(name: string): any;
    logger: LoggerLike;
    /** Event bus (mixed onto Cordis contexts): returns the exact disposer. */
    on?(event: string, listener: (...args: any[]) => void): () => void;
}
/** Read one service defensively: an absent/renamed service must not throw. */
export declare function service(ctx: CtxLike, name: string): any;
/** DSH home directory: `$DSH_HOME` first, else `~/.dsh`. */
export declare function dshHome(): string;
/** Resolve the channels data directory from config (default `$DSH_HOME/channels`). */
export declare function resolveDataDir(configured?: unknown): string;
export declare function ensureDir(dir: string): void;
export declare function ensureParent(file: string): void;
/**
 * Expected, API-shaped failure. The HTTP layer maps `status`/`code`; the tool
 * layer turns it into `{ ok: false, error: { code, message } }` instead of
 * throwing out of a turn.
 */
export declare class HostError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(status: number, code: string, message: string);
}
/** Human-readable text for an unknown thrown value. */
export declare function errMessage(error: unknown): string;
/** Read and parse a JSON file; missing or malformed content yields undefined. */
export declare function readJsonFile<T>(file: string): T | undefined;
/** Read a text file, or undefined when it does not exist / is unreadable. */
export declare function readTextFile(file: string): string | undefined;
/** Write a file atomically: temp sibling + rename (same directory, same filesystem). */
export declare function writeFileAtomic(file: string, text: string): void;
/** Atomically replace a JSON state file. */
export declare function writeJsonAtomic(file: string, value: unknown): void;
/**
 * Append one JSON line. The caller owns a read/write descriptor opened with the
 * `'a+'` flag. If the file's tail is an unterminated partial line (a crash
 * during an earlier append), a separator newline is written first so the new
 * record never concatenates with the broken one.
 */
export declare function appendJsonLineSync(fd: number, value: unknown): void;
/** List `*.jsonl` basenames in a directory (empty when missing). */
export declare function listJsonlFiles(dir: string): string[];
/** Split JSONL text into parsed values, dropping a trailing partial line and corrupt lines. */
export declare function parseJsonlTolerant(text: string): unknown[];
/** Read a whole JSONL file tolerantly (missing file yields an empty list). */
export declare function readJsonlFile(file: string): unknown[];
/**
 * Last `seq` recoverable from an append-only message file.
 *
 * Reads at most the final 64 KiB and walks lines backwards, so a crash that
 * left a partial trailing line simply resolves to the previous complete line.
 */
export declare function readLastSeqFromFile(file: string, channel?: string): number;
export declare function isoNow(): string;
/** New opaque id with a prefix, e.g. `p_1a2b3c4d5e6f`. */
export declare function newId(prefix: string, bytes?: number): string;
/** New bearer token (base64url, 32 random bytes). */
export declare function newToken(): string;
/** SHA-256 hex digest used to persist tokens without keeping the secret. */
export declare function hashToken(token: string): string;
/** Stable id derived from an input (used for deterministic auto identities). */
export declare function stableId(prefix: string, input: string, chars?: number): string;
/** Public projection of a participant: never leaks `tokenHash`. */
export declare function publicParticipant(participant: Participant): Participant;
/**
 * One serial queue per key. Tasks run one at a time in submission order and a
 * rejected task does not poison the queue. This is the mechanism that makes
 * `seq` allocation, append, broadcast and wake observable in file order.
 */
export declare class SerialQueue {
    private readonly tails;
    run<T>(key: string, task: () => T | Promise<T>): Promise<T>;
    /** Wait until every queued task on every key has settled. */
    drain(): Promise<void>;
}
export declare const LOCK_STALE_MS = 60000;
export declare const LOCK_TOUCH_MS = 20000;
export interface HubLockFile {
    readonly pid: number;
    readonly startedAt: string;
}
export type HubLockAcquisition = {
    readonly writer: true;
    readonly staleTakenOver: boolean;
    readonly lockFile: string;
} | {
    readonly writer: false;
    readonly reason: string;
    readonly holder?: HubLockFile;
    readonly lockFile: string;
};
/** True when the pid is alive (or exists but is not signalable by us). */
export declare function isPidAlive(pid: number): boolean;
/**
 * Acquire the single-writer lock.
 *
 * - fresh `wx` create → writer
 * - EEXIST with a live pid and fresh mtime → read-only (never throws)
 * - stale holder (dead pid, or mtime older than 60s) → take over
 */
export declare function acquireHubLock(file: string): HubLockAcquisition;
/** Refresh the lock mtime so other instances see a live writer. */
export declare function touchFile(file: string): void;
/** Release the lock only when this pid still owns it. */
export declare function releaseHubLock(file: string): void;
