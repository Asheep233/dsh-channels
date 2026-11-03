/**
 * dsh-channels hub: the single object that owns storage, identity, wake, SSE
 * fan-out and the per-channel serial queue.
 *
 * Ordering contract (SPEC.md §3/§7): `seq allocation → append → in-memory
 * update → SSE broadcast → wake` all happen inside one per-channel serial
 * queue, so the UI order always equals the file order.
 *
 * The hub is also the entry point for `applyHub(ctx, config)`, which installs
 * the HTTP API and the `channel_*` tools and wires every disposer through
 * `ctx.effect`.
 */
import type { Attachment, ChannelMessage, ChannelMeta, ChannelView, MembershipResponse, Participant, SearchHit, SessionPrefs } from '../contract.js';
import { ChannelStore } from './store.js';
import { AttachmentStore } from './attachments.js';
import type { AttachmentMeta } from './attachments.js';
import { IdentityService } from './identity.js';
import type { ClaimInput, ClaimResult, LoginInput, RegisterInput, RegisterResult } from './identity.js';
import { WakeService } from './wake.js';
import type { WakeReport } from './wake.js';
import { SessionPrefsService } from './session-prefs.js';
import type { SessionPrefsPatch } from './session-prefs.js';
import { MembershipService } from './memberships.js';
import { ChannelPolicyService } from './policy.js';
import type { AgentLike, CtxLike, HubLockAcquisition, LoggerLike, ToolsLike } from './util.js';
export interface ChannelsConfig {
    readonly dataDir: string;
    /** Force read-only even when the hub lock is free (tests / secondary view). */
    readonly readonly: boolean;
    /** Whether mentions/replies wake DSH sessions at all. */
    readonly wake: boolean;
    /** Live-session wake delivery: steer (interject, default) or followup (next turn). */
    readonly wakeDelivery: 'steer' | 'followup';
    readonly wakeRateMs: number;
    readonly sendRatePerMinute: number;
    readonly announceRateMs: number;
    readonly maxTextBytes: number;
    readonly maxBodyBytes: number;
    /** Per-file attachment upload cap (default 25MB, SPEC §7.5). */
    readonly maxAttachmentBytes: number;
    /** Per-message attachment total cap (default 50MB, SPEC §7.5). */
    readonly maxAttachmentTotalBytes: number;
    readonly streamKeepaliveMs: number;
    readonly idempotencyTtlMs: number;
    readonly lockTouchMs: number;
    /** Handles auto-joined to every channel (see `default-members.json` too). */
    readonly defaultMembers: readonly string[];
    /** Channels every agent joins by default (general always; this machine: general,lobby). */
    readonly defaultChannels: readonly string[];
}
/** Normalize the optional second `apply(ctx, config)` argument (plain object). */
export declare function normalizeConfig(raw: unknown, resolveDataDir: (configured?: unknown) => string): ChannelsConfig;
/** Channel meta plus per-participant view columns (contract `ChannelView`). */
export type { ChannelView } from '../contract.js';
export interface SendInput {
    readonly channel: string;
    readonly text: string;
    readonly replyTo?: string;
    readonly mentions?: readonly unknown[];
    /** Attachment ids minted by POST /upload; text may be empty when present. */
    readonly attachments?: readonly unknown[];
    readonly clientMsgId?: string;
}
export interface SendOutcome {
    readonly message: ChannelMessage;
    readonly duplicate: boolean;
    readonly wake: WakeReport;
}
export interface AnnounceInput {
    readonly channel: string;
    readonly text: string;
}
export interface PinInput {
    readonly channel: string;
    readonly messageId: string;
}
export interface HistoryInput {
    readonly channel?: string;
    readonly beforeSeq?: number;
    readonly afterSeq?: number;
    readonly limit?: number;
}
export interface HistoryOutcome {
    readonly channel: string;
    readonly messages: readonly ChannelMessage[];
    readonly hasMore: boolean;
}
export interface UploadInput {
    readonly name?: unknown;
    /** Declared mime; empty/absent falls back to the filename guess, malformed is rejected. */
    readonly mime?: unknown;
    readonly bytes: Buffer;
}
export interface SearchInput {
    readonly query: string;
    readonly channel?: string;
    readonly limit?: number;
    readonly beforeSeq?: number;
}
export interface SearchOutcome {
    readonly query: string;
    readonly hits: readonly SearchHit[];
    readonly hasMore: boolean;
}
export interface SseClientOptions {
    readonly req: import('node:http').IncomingMessage;
    readonly res: import('node:http').ServerResponse;
    readonly participant?: Participant;
    readonly afterSeq?: number;
}
export interface SseClientHandle {
    readonly participantId?: string;
    /** Remove the client and end its response. Idempotent. */
    readonly detach: () => void;
}
export declare class ChannelsHub {
    readonly ctx: CtxLike;
    readonly config: ChannelsConfig;
    readonly startedAt: string;
    readonly logger: LoggerLike;
    readonly store: ChannelStore;
    readonly identity: IdentityService;
    readonly wake: WakeService;
    /** Immutable attachment blob store (`<dataDir>/attachments`). */
    readonly attachments: AttachmentStore;
    /** Per-session hidden / muted switches (`<dataDir>/session-prefs.json`). */
    readonly sessionPrefs: SessionPrefsService;
    /** Per-participant channel membership (`<dataDir>/channel-memberships.json`). */
    readonly memberships: MembershipService;
    /** Per-channel admins / mutes / posting limits (`<dataDir>/channel-policies.json`). */
    readonly policy: ChannelPolicyService;
    readonly lock: HubLockAcquisition;
    /** False when another live hub owns the data directory (or config says so). */
    readonly writer: boolean;
    readonly readonlyReason?: string;
    private readonly channelQueues;
    private readonly clients;
    private readonly timers;
    /** participantId → last throttled activity touch (ms). */
    private readonly activityTouched;
    /** `${channel}\0${participantId}` → recent send timestamps for per-channel rate limits. */
    private readonly channelSendStamps;
    /** Handles auto-joined to every (non-archived) channel: config + default-members.json. */
    private readonly defaultMemberHandles;
    /** Unregisters the agent/created|disposed listeners installed by start(). */
    private prefsWatchStop;
    private disposed;
    private endpointOwned;
    constructor(ctx: CtxLike, config: ChannelsConfig);
    /** Config `defaultMembers` + `<dataDir>/default-members.json` `{version,handles[]}`. */
    private loadDefaultMembers;
    /** Backfill: every known default member joins every non-archived channel. */
    private applyDefaultMembersToExistingChannels;
    /** New default channel (general/lobby): every known agent joins right away. */
    private joinAllAgentsToChannel;
    private joinDefaultMembersToChannel;
    /** Write endpoint.json, start keepalive/lock timers. Called by applyHub once. */
    start(): void;
    /**
     * Apply persisted hidden prefs to every live agent and keep following
     * `agent/created` / `agent/disposed` (a new or resumed agent gets a fresh
     * scope). MUST run after `installTools()`: `tools.restrict({ deny })` rejects
     * names that are not registered in this scope yet, so masking before the
     * `channel_*` tools exist would silently fail for already-live agents.
     * Idempotent.
     */
    installSessionPrefs(): void;
    /** Install the agent lifecycle watcher once (idempotent). */
    private beginPrefsWatch;
    /** Stop the watcher and release every applied tool mask (idempotent). */
    endPrefsWatch(): void;
    /** Tear everything down: SSE clients, timers, fds, lock, endpoint file. */
    dispose(): void;
    health(): Record<string, unknown>;
    private endpointUrl;
    assertWritable(): void;
    liveAgent(sessionId: string): AgentLike | undefined;
    requireChannel(channel: unknown): string;
    /**
     * Membership gate (SPEC §7.8): non-human participants must join a channel
     * before reading, writing or being woken for it. Humans are exempt.
     * An unauthenticated loopback read (participant null) is not gated: there is
     * no identity to check, and it is covered by the v1 loopback read trust.
     */
    requireMembership(participant: Participant | null | undefined, channel: string): void;
    /**
     * Channel-admin policy gate for a normal message / announcement (SPEC §7.10).
     * The human operator is exempt from mutes and limits; admins are exempt from
     * `mutedAll` but can still be muted explicitly by the human operator.
     */
    private assertCanSend;
    /** Per-channel frequency limit (rolling 60s); humans are exempt. */
    private consumeChannelSendRate;
    /** True when `actor` may manage channel policy (human operator or channel admin). */
    isChannelAdmin(actor: Participant | null | undefined, channel: string): boolean;
    private requireChannelManager;
    /** Resolve an agent handle that must already be a member of `channel`. */
    private resolvePolicyTarget;
    /** Broadcast a policy change to every SSE subscriber. */
    private broadcastPolicy;
    /** Stored member count for one channel (humans are exempt, not counted). */
    memberCount(channel: string): number;
    listChannels(participant?: Participant | null, options?: {
        includeArchived?: boolean;
    }): ChannelView[];
    /** Policy columns for one channel view (handles, mute flags, caller abilities). */
    private policyView;
    /** One channel view (404 when unknown). */
    channelView(participant: Participant | null, channel: unknown): ChannelView;
    history(participant: Participant | null, input: HistoryInput): HistoryOutcome;
    /** Pinned messages. Legacy single-argument form treats the caller as anonymous. */
    pins(participant: Participant | null, channel: unknown): {
        channel: ChannelMeta;
        messages: ChannelMessage[];
        pins: ChannelMeta['pins'];
    };
    pins(channel: unknown): {
        channel: ChannelMeta;
        messages: ChannelMessage[];
        pins: ChannelMeta['pins'];
    };
    /**
     * Member list for one channel (or the global registry when `channel` is
     * omitted, used by diagnostics). Channel mode returns only stored members;
     * the calling human operator is appended when absent because humans are
     * exempt from membership and still see themselves in the list.
     */
    members(channel?: unknown, caller?: Participant | null): Participant[];
    whoami(participant: Participant | null): Participant | null;
    /** Advance a participant's read cursor (monotonic; failures are non-fatal). */
    markRead(participantId: string, channel: string, seq: number): void;
    createChannel(author: Participant, input: {
        id: string;
        name?: string;
        topic?: string;
        category?: string;
    }): Promise<ChannelMeta>;
    /** Archive or restore a channel (history retained; archived channels reject new messages). */
    archiveChannel(author: Participant, channel: unknown, archived: boolean): Promise<ChannelMeta>;
    /** Remove a participant registry row (maintenance; message author snapshots are retained). */
    removeParticipant(author: Participant, participantId: unknown): Promise<{
        removed: boolean;
        participantId: string;
    }>;
    sendMessage(author: Participant, input: SendInput): Promise<SendOutcome>;
    /**
     * Store one immutable attachment for `participant` (POST /upload, channel_upload).
     *
     * @throws HostError 400 when empty, 413 when over the per-file cap, 415 when
     *   the declared mime is malformed, 503 when the hub is read-only.
     */
    uploadAttachment(participant: Participant, input: UploadInput): Promise<Attachment>;
    /** Metadata for serving GET /attachments/<id> (404 shape handled by HTTP). */
    attachmentMeta(id: unknown): AttachmentMeta | undefined;
    /**
     * Validate and re-derive the attachment references for one outgoing message.
     * Client-supplied ids are re-resolved against the store so name/mime/size/url
     * can never be forged, and ownership + count + total-size limits are enforced.
     */
    private resolveAttachments;
    /**
     * Join one channel for the given participant (POST /join, channel_join).
     * Humans are always members, so this is a no-op that reports joined:true.
     */
    joinChannel(participant: Participant, channel: unknown): MembershipResponse;
    /** Leave one channel (#general is mandatory → 400). */
    leaveChannel(participant: Participant, channel: unknown): MembershipResponse;
    /**
     * Appoint/remove one channel admin. **Human operator only.** The target must
     * be a non-human member of the channel.
     *
     * @returns the updated channel view for `actor`.
     */
    setChannelAdmins(actor: Participant, channel: unknown, input: {
        readonly handle?: unknown;
        readonly admin?: unknown;
    }): ChannelView;
    /**
     * Mute/unmute every non-admin member (`all: true`) or one member. Allowed for
     * the human operator and channel admins; admins cannot mute another admin
     * (only the human can), and humans cannot be muted.
     *
     * @returns the updated channel view for `actor`.
     */
    setChannelMute(actor: Participant, channel: unknown, input: {
        readonly handle?: unknown;
        readonly all?: unknown;
        readonly muted?: unknown;
    }): ChannelView;
    /**
     * Set per-channel posting limits. `null` resets a field to the server default.
     * Allowed for the human operator and channel admins.
     */
    setChannelLimits(actor: Participant, channel: unknown, input: {
        readonly maxChars?: unknown;
        readonly ratePerMinute?: unknown;
    }): ChannelView;
    /**
     * Full-text search across channels; never advances read cursors.
     *
     * Non-human participants only search channels they joined (SPEC §7.8); an
     * explicitly named non-member channel is a 403, and the legacy anonymous
     * single-argument form keeps searching every non-archived channel.
     */
    search(participant: Participant | null, input: SearchInput): SearchOutcome;
    search(input: SearchInput): SearchOutcome;
    announce(author: Participant, input: AnnounceInput): Promise<{
        message: ChannelMessage;
        channel: ChannelMeta;
        wake: WakeReport;
    }>;
    pin(author: Participant, input: PinInput): Promise<ChannelMeta>;
    unpin(author: Participant, input: PinInput): Promise<ChannelMeta>;
    register(input: RegisterInput): Promise<RegisterResult>;
    claim(input: ClaimInput): Promise<ClaimResult>;
    login(input: LoginInput): Promise<Participant>;
    release(sessionId: string): Promise<Participant | undefined>;
    heartbeat(participant: Participant): Promise<Participant>;
    /**
     * Refresh `lastSeen` after an authenticated API action (send / upload / read
     * with a token …). Throttled per participant so chat traffic never turns into
     * a participants.json write per request; broadcasts at the same pace so the
     * member list flips to online without waiting for its 45s poll.
     */
    noteActivity(participant: Participant): void;
    /** Current hidden/muted switches for one session (defaults are explicit false). */
    sessionPrefsFor(sessionId: unknown): SessionPrefs;
    /**
     * Persist a hidden/muted patch and apply it to the live agent immediately:
     * hiding masks every `channel_*` tool in that agent scope, showing releases
     * the restriction, and both directions take effect for wake delivery at once
     * (WakeService reads the same service).
     */
    setSessionPrefs(sessionId: unknown, patch: SessionPrefsPatch, by: string): SessionPrefs;
    /**
     * Register one SSE client: write `hello`, replay `afterSeq` backlog, then
     * stream live frames until the socket closes or the hub disposes.
     */
    addSseClient(options: SseClientOptions): SseClientHandle;
    private maxLastSeq;
    /** Replay messages newer than `afterSeq` (bounded per channel) for reconnect. */
    private replay;
    /**
     * Whether one SSE subscriber may receive live/backlog messages from a channel.
     * Anonymous loopback subscribers keep the v1 read trust; identified non-human
     * participants must be channel members (humans are always members).
     */
    private canReceiveChannel;
    /** First-migration helper: re-join each legacy channel's creator (skip humans/general). */
    private seedLegacyCreatorMemberships;
    private writeFrame;
    private heartbeatClients;
    private dropClient;
    private broadcast;
    /** Number of live SSE clients (diagnostics/tests). */
    sseClientCount(): number;
    private buildReplyRef;
    private emptyWake;
    /** Services used by installTools/installHttp; kept here so installers stay thin. */
    toolsService(): ToolsLike | undefined;
}
/**
 * Wire the hub into a Cordis context: acquire the writer lock, load storage,
 * register the HTTP API and the native tools, and dispose everything through
 * `ctx.effect`.
 *
 * Never throws for ordinary startup failures: a read-only second instance is a
 * supported state, and a broken data directory is logged rather than failing
 * the whole web host.
 */
export declare function applyHub(ctx: unknown, config?: unknown): ChannelsHub | undefined;
