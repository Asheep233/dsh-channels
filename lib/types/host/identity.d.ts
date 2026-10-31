/**
 * dsh-channels identity layer.
 *
 * Three identity sources (SPEC.md §7):
 *  - automatic: every DSH session gets a deterministic `dsh-<short>` participant
 *    the first time it calls a channel tool;
 *  - claimed: a session claims a human handle (`channel_claim`) and keeps it
 *    across turns; `force` takes the handle over from another live session;
 *  - external: register/login with a bearer token (CLI / MCP).
 *
 * One identity is bound to at most one live DSH session at a time. Tokens are
 * stored as SHA-256 digests and never returned by any read API.
 */
import type { HarnessName, Participant, ParticipantKind } from '../contract.js';
import type { ChannelStore } from './store.js';
import type { LoggerLike } from './util.js';
/**
 * Minimal membership face used to auto-join `#general` on participant
 * creation (SPEC §7.8). Kept structural so identity has no runtime dependency
 * on the membership store.
 */
export interface DefaultMembershipJoiner {
    joinDefaults(subject: {
        readonly id: string;
        readonly kind: ParticipantKind;
    }): void;
}
export interface IdentityDeps {
    readonly store: ChannelStore;
    readonly logger: LoggerLike;
    /** True when the given session id is a live agent in this process. */
    isSessionLive(sessionId: string): boolean;
    /** Optional membership store: new participants always land in `#general`. */
    readonly memberships?: DefaultMembershipJoiner;
}
export interface ClaimInput {
    readonly handle: string;
    readonly displayName?: string;
    readonly force?: boolean;
    readonly sessionId: string;
}
export interface ClaimResult {
    readonly participant: Participant;
    /** Present only when this claim minted a fresh participant (and its token). */
    readonly token?: string;
    readonly created: boolean;
}
export interface LoginInput {
    readonly handle: string;
    readonly token?: string;
    /** When present, rebind the identity to this DSH session (tools); omitted for external login. */
    readonly sessionId?: string;
}
/** Adopt a handle for an already-authenticated (external) participant. */
export interface AdoptHandleInput {
    readonly participantId: string;
    readonly handle: string;
    readonly displayName?: string;
    readonly force?: boolean;
}
export interface RegisterInput {
    readonly kind: ParticipantKind;
    readonly handle?: string;
    readonly displayName?: string;
    readonly harness?: HarnessName;
    /** Optional existing token: proves the caller already owns a claimed handle. */
    readonly token?: string;
    readonly sessionId?: string;
}
export interface RegisterResult {
    readonly participant: Participant;
    readonly token: string;
    readonly created: boolean;
}
export declare class IdentityService {
    private readonly deps;
    constructor(deps: IdentityDeps);
    get(participantId: string): Participant | undefined;
    byHandle(handle: string): Participant | undefined;
    list(): Participant[];
    findBySession(sessionId: string): Participant | undefined;
    /**
     * Derived presence:
     *   online  — lastSeen within ONLINE_WINDOW (any kind: heartbeat / API activity / tool call)
     *   idle    — not fresh enough for online, but the DSH session is still live, or
     *             it was seen within IDLE_WINDOW
     *   offline — otherwise
     *
     * A loaded DSH session alone no longer means "online": loaded-but-quiet sessions
     * become idle, which matches what humans expect from the member list.
     */
    statusOf(participant: Participant): Participant['status'];
    /** Public participant shape with derived status and no token hash. */
    view(participant: Participant): Participant;
    members(): Participant[];
    /** Remove one participant row (used by maintenance endpoints; history keeps author snapshots). */
    remove(participantId: string): Promise<boolean>;
    /** Resolve a bearer token to its participant. */
    authenticate(token: string | undefined): Participant | undefined;
    /**
     * Ensure the DSH session driving a tool call has a participant.
     * Deterministic per session id, so it survives host restarts. A claimed
     * identity bound to the session always wins.
     */
    ensureSessionParticipant(sessionId: string, displayName?: string): Promise<Participant>;
    private autoHandle;
    private uniqueHandle;
    /** Claim a handle for a session, taking it over from another session with `force`. */
    claim(input: ClaimInput): Promise<ClaimResult>;
    /** Restore an external/claimed identity with its bearer token. */
    login(input: LoginInput): Promise<Participant>;
    /** Rename an authenticated participant to a requested handle (external claim). */
    adoptHandle(input: AdoptHandleInput): Promise<Participant>;
    /** Drop the binding held by one session (messages keep their author snapshot). */
    release(sessionId: string): Promise<Participant | undefined>;
    /** Register a human/external participant (and mint its bearer token). */
    register(input: RegisterInput): Promise<RegisterResult>;
    /** Update `lastSeen` (heartbeat / any authenticated action). */
    touch(participantId: string): Promise<Participant | undefined>;
    /** Best-effort `#general` membership for a freshly created participant. */
    private ensureDefaultMembership;
    private touchParticipant;
    /** Bind `participant` to `sessionId` (clearing any previous holder of that session). */
    private bind;
    /** Remove the session binding from every participant except `keepId`. */
    private detachSession;
}
