/**
 * dsh-channels channel membership (SPEC.md §7.8).
 *
 * Every participant is a member of `#general` for ever; other channels are
 * opt-in (`join`/`leave`). Membership gates reads/writes for non-human
 * participants and is checked again before waking a session, so a non-member
 * can still be @mentioned and see the mention in history later — it is simply
 * not woken.
 *
 * Humans (`kind: 'human'`, the Web operator) are exempt: they are always
 * treated as a member of every channel and never get a stored row, so a human
 * can never lose access to history by forgetting to join.
 *
 * Storage: `<dataDir>/channel-memberships.json`
 *
 *   { "version": 1, "members": { "<participantId>": ["general", "lobby"] } }
 *
 * written atomically (tmp + rename) and read tolerantly.
 */
import type { ParticipantKind } from '../contract.js';
import type { LoggerLike } from './util.js';
export declare const MEMBERSHIPS_FILE = "channel-memberships.json";
export declare const MEMBERSHIPS_VERSION = 1;
/** The only fields membership needs from a participant. */
export interface MembershipSubject {
    readonly id: string;
    readonly kind: ParticipantKind;
}
export interface MembershipOptions {
    readonly dataDir: string;
    /** Read-only hub: membership changes are refused/no-op; reads still work. */
    readonly readonly: boolean;
    readonly logger: LoggerLike;
    /** Channels every agent joins on creation/migration (default: [general]). */
    readonly defaultChannels?: readonly string[];
}
/**
 * Per-participant channel membership with a reverse channel→members index.
 * One instance per hub.
 */
export declare class MembershipService {
    readonly file: string;
    readonly readonlyMode: boolean;
    private readonly logger;
    private readonly defaultChannels;
    private readonly byParticipant;
    private readonly byChannel;
    private loaded;
    /** True when no storage file existed at first load (used for migration logging). */
    private wasMissing;
    constructor(options: MembershipOptions);
    /** Load the membership table; missing/corrupt files mean "no explicit rows". */
    load(): void;
    private ensureLoaded;
    private persist;
    private addIndex;
    private removeIndex;
    /**
     * May this participant read/write/be-woken-for this channel?
     * Humans are always members; `#general` is mandatory for everyone.
     */
    isMember(subject: MembershipSubject | null | undefined, channel: string): boolean;
    /** True when a stored (explicit, non-human) row exists. */
    hasExplicitMembership(participantId: string, channel: string): boolean;
    /**
     * Channels the subject may access. Humans get every channel when the caller
     * supplies the channel universe; `#general` is always included for agents.
     */
    joinedChannels(subject: MembershipSubject | null | undefined, allChannels?: readonly string[]): string[];
    /** Explicit (stored) member count of one channel. Humans are exempt and not stored. */
    memberCount(channel: string): number;
    /** Stored member participant ids of one channel. */
    membersOf(channel: string): string[];
    /** Participant ids that have at least one stored row (diagnostics/tests). */
    knownParticipants(): string[];
    /**
     * Drop every stored row for one participant (called when the participant is
     * removed, so `memberCount` never counts ghosts).
     *
     * @returns true when rows were removed.
     */
    removeParticipant(participantId: string): boolean;
    /**
     * Migration/cleanup: drop rows whose participant no longer exists in the
     * registry (e.g. participants removed before removeParticipant existed).
     *
     * @returns number of participant rows removed.
     */
    pruneUnknown(knownIds: ReadonlySet<string>): number;
    /** Remove one participant from both indexes without persisting. */
    private dropParticipant;
    /**
     * Join a channel. Humans are always members, so this is an idempotent no-op
     * for them and nothing is stored.
     *
     * @returns true when a stored row was added.
     */
    join(subject: MembershipSubject, channel: string): boolean;
    /**
     * Leave a channel. `#general` is mandatory (400) and humans cannot leave
     * anything because they are exempt from membership.
     *
     * @returns true when a stored row was removed.
     */
    leave(subject: MembershipSubject, channel: string): boolean;
    /** Make sure a freshly created participant is in every default channel. */
    joinDefaults(subject: MembershipSubject): void;
    /**
     * Migration seed (SPEC §7.8): every existing non-human participant is added
     * to the configured default channels (`#general` + `#lobby` on this machine).
     * Other sub-channels are deliberately NOT auto-joined — agents must join them.
     */
    seedMissing(participants: readonly MembershipSubject[]): number;
    /**
     * Drop membership rows for channels that no longer exist or are archived.
     * Keeps the memberships file from accumulating rows for throwaway channels.
     *
     * @returns number of channel rows dropped.
     */
    pruneChannels(keepChannelIds: ReadonlySet<string>): number;
    /** True when the storage file did not exist at first load. */
    wasStorageMissing(): boolean;
}
