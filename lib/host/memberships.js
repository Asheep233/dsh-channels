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
import { DEFAULT_CHANNEL, isValidChannelId } from '../contract.js';
import { HostError, errMessage, readJsonFile, writeJsonAtomic } from './util.js';
export const MEMBERSHIPS_FILE = 'channel-memberships.json';
export const MEMBERSHIPS_VERSION = 1;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Per-participant channel membership with a reverse channel→members index.
 * One instance per hub.
 */
export class MembershipService {
    file;
    readonlyMode;
    logger;
    defaultChannels;
    byParticipant = new Map();
    byChannel = new Map();
    loaded = false;
    /** True when no storage file existed at first load (used for migration logging). */
    wasMissing = false;
    constructor(options) {
        this.file = `${options.dataDir.replace(/[\\/]+$/, '')}/${MEMBERSHIPS_FILE}`;
        this.readonlyMode = options.readonly;
        this.logger = options.logger;
        const configured = (options.defaultChannels ?? []).filter((channel) => typeof channel === 'string' && channel.length > 0);
        this.defaultChannels = configured.length > 0
            ? [...new Set([DEFAULT_CHANNEL, ...configured])]
            : [DEFAULT_CHANNEL];
    }
    // -- persistence ----------------------------------------------------------
    /** Load the membership table; missing/corrupt files mean "no explicit rows". */
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        const raw = readJsonFile(this.file);
        if (raw === undefined) {
            this.wasMissing = true;
            return;
        }
        if (!isRecord(raw))
            return;
        if (raw.version !== undefined && raw.version !== MEMBERSHIPS_VERSION) {
            this.logger.warn(`dsh-channels: ignoring channel-memberships.json with unsupported version ${String(raw.version)}`);
            return;
        }
        const members = raw.members;
        if (!isRecord(members))
            return;
        for (const [participantId, channels] of Object.entries(members)) {
            if (participantId.length === 0 || !Array.isArray(channels))
                continue;
            for (const channel of channels) {
                if (typeof channel !== 'string' || !isValidChannelId(channel))
                    continue;
                this.addIndex(participantId, channel);
            }
        }
    }
    ensureLoaded() {
        if (!this.loaded)
            this.load();
    }
    persist() {
        if (this.readonlyMode)
            return;
        const members = {};
        for (const [participantId, channels] of this.byParticipant) {
            if (channels.size === 0)
                continue;
            members[participantId] = [...channels].sort();
        }
        const body = { version: MEMBERSHIPS_VERSION, members };
        writeJsonAtomic(this.file, body);
    }
    addIndex(participantId, channel) {
        let channels = this.byParticipant.get(participantId);
        if (channels === undefined) {
            channels = new Set();
            this.byParticipant.set(participantId, channels);
        }
        if (channels.has(channel))
            return false;
        channels.add(channel);
        let members = this.byChannel.get(channel);
        if (members === undefined) {
            members = new Set();
            this.byChannel.set(channel, members);
        }
        members.add(participantId);
        return true;
    }
    removeIndex(participantId, channel) {
        const channels = this.byParticipant.get(participantId);
        if (channels === undefined || !channels.has(channel))
            return false;
        channels.delete(channel);
        if (channels.size === 0)
            this.byParticipant.delete(participantId);
        const members = this.byChannel.get(channel);
        if (members !== undefined) {
            members.delete(participantId);
            if (members.size === 0)
                this.byChannel.delete(channel);
        }
        return true;
    }
    // -- reads ----------------------------------------------------------------
    /**
     * May this participant read/write/be-woken-for this channel?
     * Humans are always members; `#general` is mandatory for everyone.
     */
    isMember(subject, channel) {
        if (subject === null || subject === undefined)
            return false;
        if (subject.kind === 'human')
            return true;
        if (channel === DEFAULT_CHANNEL)
            return true;
        this.ensureLoaded();
        return this.byParticipant.get(subject.id)?.has(channel) === true;
    }
    /** True when a stored (explicit, non-human) row exists. */
    hasExplicitMembership(participantId, channel) {
        this.ensureLoaded();
        return this.byParticipant.get(participantId)?.has(channel) === true;
    }
    /**
     * Channels the subject may access. Humans get every channel when the caller
     * supplies the channel universe; `#general` is always included for agents.
     */
    joinedChannels(subject, allChannels) {
        if (subject === null || subject === undefined)
            return [];
        if (subject.kind === 'human')
            return allChannels !== undefined ? [...allChannels] : [];
        this.ensureLoaded();
        const out = [DEFAULT_CHANNEL];
        for (const channel of this.byParticipant.get(subject.id) ?? []) {
            if (channel !== DEFAULT_CHANNEL)
                out.push(channel);
        }
        if (allChannels === undefined)
            return out;
        const known = new Set(allChannels);
        return out.filter((channel) => known.has(channel));
    }
    /** Explicit (stored) member count of one channel. Humans are exempt and not stored. */
    memberCount(channel) {
        this.ensureLoaded();
        return this.byChannel.get(channel)?.size ?? 0;
    }
    /** Stored member participant ids of one channel. */
    membersOf(channel) {
        this.ensureLoaded();
        return [...(this.byChannel.get(channel) ?? [])];
    }
    /** Participant ids that have at least one stored row (diagnostics/tests). */
    knownParticipants() {
        this.ensureLoaded();
        return [...this.byParticipant.keys()];
    }
    /**
     * Drop every stored row for one participant (called when the participant is
     * removed, so `memberCount` never counts ghosts).
     *
     * @returns true when rows were removed.
     */
    removeParticipant(participantId) {
        if (this.readonlyMode)
            return false;
        this.ensureLoaded();
        if (!this.dropParticipant(participantId))
            return false;
        this.persist();
        return true;
    }
    /**
     * Migration/cleanup: drop rows whose participant no longer exists in the
     * registry (e.g. participants removed before removeParticipant existed).
     *
     * @returns number of participant rows removed.
     */
    pruneUnknown(knownIds) {
        if (this.readonlyMode)
            return 0;
        this.ensureLoaded();
        let removed = 0;
        for (const participantId of [...this.byParticipant.keys()]) {
            if (knownIds.has(participantId))
                continue;
            if (this.dropParticipant(participantId))
                removed += 1;
        }
        if (removed > 0) {
            this.persist();
            this.logger.warn(`dsh-channels: pruned ${removed} stale membership row(s) for removed participants`);
        }
        return removed;
    }
    /** Remove one participant from both indexes without persisting. */
    dropParticipant(participantId) {
        const channels = this.byParticipant.get(participantId);
        if (channels === undefined)
            return false;
        for (const channel of channels)
            this.byChannel.get(channel)?.delete(participantId);
        this.byParticipant.delete(participantId);
        return true;
    }
    // -- writes ---------------------------------------------------------------
    /**
     * Join a channel. Humans are always members, so this is an idempotent no-op
     * for them and nothing is stored.
     *
     * @returns true when a stored row was added.
     */
    join(subject, channel) {
        if (subject.kind === 'human')
            return false;
        this.ensureLoaded();
        if (this.readonlyMode)
            return false;
        const changed = this.addIndex(subject.id, channel);
        if (changed)
            this.persist();
        return changed;
    }
    /**
     * Leave a channel. `#general` is mandatory (400) and humans cannot leave
     * anything because they are exempt from membership.
     *
     * @returns true when a stored row was removed.
     */
    leave(subject, channel) {
        if (channel === DEFAULT_CHANNEL) {
            throw new HostError(400, 'invalid_request', `cannot leave #${DEFAULT_CHANNEL}: every participant is a member`);
        }
        if (subject.kind === 'human')
            return false;
        this.ensureLoaded();
        if (this.readonlyMode)
            return false;
        const changed = this.removeIndex(subject.id, channel);
        if (changed)
            this.persist();
        return changed;
    }
    /** Make sure a freshly created participant is in every default channel. */
    joinDefaults(subject) {
        if (subject.kind === 'human')
            return;
        for (const channel of this.defaultChannels) {
            try {
                this.join(subject, channel);
            }
            catch (error) {
                // Membership bookkeeping must never fail participant creation.
                this.logger.warn(`dsh-channels: failed to add ${subject.id} to #${channel}: ${errMessage(error)}`);
            }
        }
    }
    /**
     * Migration seed (SPEC §7.8): every existing non-human participant is added
     * to the configured default channels (`#general` + `#lobby` on this machine).
     * Other sub-channels are deliberately NOT auto-joined — agents must join them.
     */
    seedMissing(participants) {
        if (this.readonlyMode)
            return 0;
        this.ensureLoaded();
        let added = 0;
        for (const participant of participants) {
            if (participant.kind === 'human')
                continue;
            for (const channel of this.defaultChannels) {
                if (this.addIndex(participant.id, channel))
                    added += 1;
            }
        }
        if (added > 0) {
            try {
                this.persist();
            }
            catch (error) {
                this.logger.warn(`dsh-channels: failed to persist membership migration: ${errMessage(error)}`);
                return 0;
            }
            this.logger.info(`dsh-channels: membership migration seeded default channels (${this.defaultChannels.join(', ')}) for ${added} row(s)`);
        }
        return added;
    }
    /**
     * Drop membership rows for channels that no longer exist or are archived.
     * Keeps the memberships file from accumulating rows for throwaway channels.
     *
     * @returns number of channel rows dropped.
     */
    pruneChannels(keepChannelIds) {
        if (this.readonlyMode)
            return 0;
        this.ensureLoaded();
        let dropped = 0;
        for (const [channelId, members] of [...this.byChannel.entries()]) {
            if (keepChannelIds.has(channelId))
                continue;
            for (const participantId of [...members])
                this.byParticipant.get(participantId)?.delete(channelId);
            this.byChannel.delete(channelId);
            dropped += 1;
        }
        for (const [participantId, channels] of [...this.byParticipant.entries()]) {
            if (channels.size === 0)
                this.byParticipant.delete(participantId);
        }
        if (dropped > 0) {
            try {
                this.persist();
                this.logger.info(`dsh-channels: pruned membership rows for ${dropped} archived/unknown channel(s)`);
            }
            catch (error) {
                this.logger.warn(`dsh-channels: failed to persist channel membership prune: ${errMessage(error)}`);
                return 0;
            }
        }
        return dropped;
    }
    /** True when the storage file did not exist at first load. */
    wasStorageMissing() {
        return this.wasMissing;
    }
}
//# sourceMappingURL=memberships.js.map