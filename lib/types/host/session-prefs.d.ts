/**
 * dsh-channels per-session switches (SPEC.md §7.7).
 *
 * Two independent per-DSH-session preferences, keyed by **session id** and
 * persisted in `<dataDir>/session-prefs.json`:
 *
 *  - `hidden` — hide the whole channel feature from that session: every
 *    `channel_*` tool is masked in the agent scope via
 *    `agent.ctx.tools.restrict({ deny: CHANNEL_TOOL_NAMES })`, and the session is
 *    never woken. Masking is re-applied to every new/resumed agent because an
 *    agent scope is rebuilt per activation.
 *  - `muted` — tools stay usable, but `@mention` / reply delivery is skipped
 *    (`reason: 'muted'`); messages are still stored.
 *
 * Persistence is a single atomic (tmp + rename) JSON file, so a crash never
 * leaves a half-written preference table. Reads tolerate a corrupt file and
 * simply start from empty state.
 */
import type { SessionPrefs } from '../contract.js';
import type { CtxLike, LoggerLike } from './util.js';
/** Bump when the on-disk shape changes incompatibly. */
export declare const SESSION_PREFS_VERSION = 1;
/** File name inside the channels data dir. */
export declare const SESSION_PREFS_FILE = "session-prefs.json";
/** A patch accepted by {@link SessionPrefsService.set}. */
export interface SessionPrefsPatch {
    readonly hidden?: boolean;
    readonly muted?: boolean;
}
/** Minimal agent-scope tool registry shape used for masking. */
interface ToolRestrictionFilter {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}
interface AgentToolsScope {
    restrict?(filter: ToolRestrictionFilter): () => void;
}
/** Minimal live-agent shape: id plus the agent-scoped Cordis context. */
export interface MaskableAgent {
    readonly id: string;
    readonly ctx?: {
        readonly tools?: AgentToolsScope;
    };
}
export interface SessionPrefsOptions {
    readonly dataDir: string;
    /** Read-only hub: never persist (the hub already refuses writes first). */
    readonly readonly: boolean;
    readonly logger: LoggerLike;
}
/** Validate/normalize a caller-supplied session id (400 on anything unusable). */
export declare function normalizeSessionId(value: unknown): string;
/**
 * Validate a `{hidden?, muted?}` patch: every present field must be a boolean
 * and at least one field must be present (400 otherwise).
 */
export declare function normalizePrefsPatch(raw: {
    readonly hidden?: unknown;
    readonly muted?: unknown;
}): SessionPrefsPatch;
/**
 * Per-session hidden/muted preferences plus the live tool-mask bookkeeping.
 * One instance per hub.
 */
export declare class SessionPrefsService {
    readonly file: string;
    readonly readonlyMode: boolean;
    private readonly logger;
    private readonly sessions;
    private readonly masks;
    private loaded;
    constructor(options: SessionPrefsOptions);
    /** Load the preference table; a missing/corrupt file simply means empty state. */
    load(): void;
    private persist;
    /** Current preferences for one session (explicit booleans, never undefined). */
    get(sessionId: string): SessionPrefs;
    /** Do not wake this session? Hidden implies muted. */
    isMuted(sessionId: string): boolean;
    /** Is the whole channel feature hidden from this session? */
    isHidden(sessionId: string): boolean;
    /** Sessions that currently have at least one non-default switch (diagnostics). */
    listSessions(): string[];
    /**
     * Merge a patch into one session's preferences and persist atomically.
     * Both flags false removes the row entirely (the default state).
     */
    set(sessionId: string, patch: SessionPrefsPatch, by: string): SessionPrefs;
    /**
     * Apply or release the channel-tool mask for one live agent.
     *
     * Idempotent: a session already masked on the same agent object is left
     * alone; a different agent object with the same session id (resume) has the
     * stale restriction released first, because agent scopes are rebuilt.
     */
    applyToAgent(agent: MaskableAgent | undefined): void;
    /** Release one session's mask (agent disposed / preference cleared). */
    releaseAgent(sessionId: string): void;
    /** Release every mask (hub dispose / plugin unload). */
    releaseAll(): void;
    /** Number of currently applied masks (diagnostics/tests). */
    maskedCount(): number;
    /** Is a mask currently applied for this session in this process? */
    isMasked(sessionId: string): boolean;
    /**
     * Apply persisted prefs to every live agent, then keep following
     * `agent/created` / `agent/disposed` so new, resumed and cleared agents are
     * masked (or released) without a restart.
     *
     * @returns disposer that unregisters the listeners and releases every mask.
     */
    watch(ctx: CtxLike): () => void;
}
export {};
