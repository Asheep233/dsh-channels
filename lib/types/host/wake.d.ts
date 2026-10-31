/**
 * dsh-channels wake layer (SPEC.md §7).
 *
 * A DSH session is woken only when a message mentions it or replies to it, and
 * only when that session's identity is bound (`binding.kind === 'dsh-session'`).
 *
 *   live session   → `agent.steer(...)` (interject at the nearest step boundary;
 *                    config `wakeDelivery: 'followup'` restores the old queued-turn behavior)
 *   cold session   → `ctx.sessionController.prompt({ mode:'queue' }, signal)`
 *
 * Also owns the v1 rate limits (5s/wake per participant, 30 messages/minute,
 * one announcement per 10 minutes) and the 10-minute `clientMsgId` idempotency
 * cache.
 */
import type { ChannelMessage, Participant } from '../contract.js';
import type { ChannelStore } from './store.js';
import type { IdentityService } from './identity.js';
import type { AgentLike, CtxLike, LoggerLike } from './util.js';
export interface WakeOptions {
    readonly store: ChannelStore;
    readonly identity: IdentityService;
    readonly ctx: CtxLike;
    readonly logger: LoggerLike;
    /** Wake delivery can be disabled through config (messages still persist). */
    readonly enabled: boolean;
    /** Minimum ms between two wakes of the same participant. */
    readonly wakeRateMs: number;
    /** Messages allowed per participant per rolling minute. */
    readonly sendRatePerMinute: number;
    /** Minimum ms between two announcements by the same participant. */
    readonly announceRateMs: number;
    /** `clientMsgId` idempotency window. */
    readonly idempotencyTtlMs: number;
    /** Live-session delivery: steer (interject, default) or followup (next turn). */
    readonly liveDelivery: 'steer' | 'followup';
    /** Resolve a session id to a live agent in this host process (if any). */
    liveAgent(sessionId: string): AgentLike | undefined;
    /** Per-session switch (SPEC §7.7): muted (or hidden) sessions are never woken. */
    isMuted(sessionId: string): boolean;
    /** Channel membership (SPEC §7.8): non-members of the message channel are not woken. */
    isChannelMember(participantId: string, channel: string): boolean;
}
export interface WakeDelivery {
    readonly participantId: string;
    readonly handle: string;
    readonly sessionId: string;
    readonly mode: 'steer' | 'followup' | 'prompt';
}
export interface WakeSkip {
    readonly participantId: string;
    readonly handle: string;
    readonly reason: string;
}
export interface WakeReport {
    readonly enabled: boolean;
    readonly considered: number;
    readonly delivered: WakeDelivery[];
    readonly skipped: WakeSkip[];
}
/** Merge explicit `mentions` with `@handle` tokens parsed out of the body. */
export declare function resolveMentionHandles(explicit: readonly unknown[] | undefined, text: string): string[];
/**
 * Attachment summary appended to a wake line, e.g. ` [附件: a.png, b.pdf]`.
 * Wake text is plain text, so names are clipped and control characters dropped.
 */
export declare function attachmentNote(message: ChannelMessage): string;
export declare class WakeService {
    private readonly options;
    private readonly lastWake;
    private readonly sendStamps;
    private readonly announceStamps;
    private readonly idempotent;
    constructor(options: WakeOptions);
    /** Count one message for a participant; throws 429 past 30/minute. */
    noteSend(participantId: string): void;
    /** Count one announcement for a participant; throws 429 inside the 10-minute window. */
    noteAnnounce(participantId: string): void;
    rememberIdempotent(participantId: string, clientMsgId: string | undefined, message: ChannelMessage): void;
    lookupIdempotent(participantId: string, clientMsgId: string | undefined): ChannelMessage | undefined;
    private idempotencyKey;
    /** Resolve mention/reply targets and wake each bound session once (5s/participant). */
    deliver(message: ChannelMessage): Promise<WakeReport>;
    /** Text injected into the target session: header, last 5 context lines, hint. */
    buildText(message: ChannelMessage): string;
    /** Resolve participants that a message would wake (diagnostics/tests). */
    resolveTargets(message: ChannelMessage): Participant[];
    /** Largest accepted message body (kept here so HTTP and tools share one check). */
    maxTextBytes(): number;
    private maybePrune;
}
