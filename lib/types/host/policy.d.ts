/**
 * dsh-channels per-channel admin policy (SPEC §7.10).
 *
 * Only the human operator may appoint/remove channel admins. A channel admin
 * (plus the human) may:
 *   - mute all non-admin members (`mutedAll`),
 *   - mute/unmute individual members (`muted`),
 *   - set a per-message character cap and a per-participant frequency cap.
 *
 * Stored separately from `channels.json` so policies survive metadata-cache
 * rebuilds: `<dataDir>/channel-policies.json`
 *
 *   { "version": 1, "channels": { "dev": { "admins": ["p_..."], ... } } }
 */
import type { ChannelPolicy } from '../contract.js';
import type { LoggerLike } from './util.js';
export declare const CHANNEL_POLICIES_FILE = "channel-policies.json";
export declare const CHANNEL_POLICIES_VERSION = 1;
export interface ChannelPolicyOptions {
    readonly dataDir: string;
    readonly readonly: boolean;
    readonly logger: LoggerLike;
}
export declare function emptyChannelPolicy(): ChannelPolicy;
/** Tolerant normalization for on-disk and API-supplied values. */
export declare function normalizeChannelPolicy(raw: unknown): ChannelPolicy;
/**
 * Policy table for every channel; one instance per hub.
 *
 * @example
 * ```ts
 * policy.load()
 * policy.update('dev', { mutedAll: true })
 * policy.get('dev').mutedAll // true
 * ```
 */
export declare class ChannelPolicyService {
    readonly file: string;
    readonly readonlyMode: boolean;
    private readonly logger;
    private readonly policies;
    private loaded;
    constructor(options: ChannelPolicyOptions);
    load(): void;
    private ensureLoaded;
    private persist;
    /** Policy for one channel (empty defaults when none stored). */
    get(channel: string): ChannelPolicy;
    /** Replace one channel's policy; returns the normalized policy. */
    set(channel: string, raw: unknown): ChannelPolicy;
    /** Merge a partial patch into one channel's policy. */
    update(channel: string, patch: Partial<ChannelPolicy>): ChannelPolicy;
    /** Drop policy for a channel that no longer exists. */
    removeChannel(channel: string): boolean;
    /** Startup cleanup: drop policies for channels that no longer exist. */
    pruneChannels(keepChannelIds: ReadonlySet<string>): number;
    /** Startup cleanup: drop admin/muted ids for participants that no longer exist. */
    pruneParticipants(knownIds: ReadonlySet<string>): number;
    /** Remove a participant from every admins/muted list (participant deleted). */
    removeParticipant(participantId: string): number;
    /** Remove one participant from one channel's admin/muted lists (on leave). */
    removeMember(channel: string, participantId: string): ChannelPolicy;
}
