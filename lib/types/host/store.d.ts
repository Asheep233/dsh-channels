/**
 * dsh-channels storage layer.
 *
 * Layout (see SPEC.md §3):
 *
 *   <dataDir>/channels.json            ChannelMeta[] cache (rebuildable from events)
 *   <dataDir>/participants.json        Participant[] (token hash + binding)
 *   <dataDir>/messages/<channel>.jsonl append-only ChannelMessage lines
 *   <dataDir>/events/<channel>.jsonl   pin/unpin/announce/create events
 *   <dataDir>/cursors/<participant>.json
 *   <dataDir>/hub.lock                 single-writer lease
 *   <dataDir>/endpoint.json            { url, pid, startedAt }
 *
 * Messages are never edited or deleted. Every message line is written with one
 * `writeSync` on a descriptor opened with `'a'`, and readers tolerate a
 * trailing partial line left behind by a crash.
 */
import { messageId as makeMessageId } from '../contract.js';
import type { ChannelMessage, ChannelMeta, Participant, SearchHit } from '../contract.js';
import type { LoggerLike } from './util.js';
/** Channel-level append-only event (pins, announcement, creation). */
export type ChannelEvent = {
    readonly type: 'create';
    readonly channel: string;
    readonly name: string;
    readonly topic?: string;
    readonly category?: string;
    readonly at: string;
    readonly by: string;
} | {
    readonly type: 'pin';
    readonly channel: string;
    readonly messageId: string;
    readonly at: string;
    readonly by: string;
} | {
    readonly type: 'unpin';
    readonly channel: string;
    readonly messageId: string;
    readonly at: string;
    readonly by: string;
} | {
    readonly type: 'announce';
    readonly channel: string;
    readonly messageId: string;
    readonly at: string;
    readonly by: string;
};
/** Per-participant read cursor. */
export interface CursorState {
    readonly participantId: string;
    readonly channels: Record<string, number>;
    readonly updatedAt: string;
}
export interface HistoryQuery {
    readonly beforeSeq?: number;
    readonly afterSeq?: number;
    readonly limit?: number;
}
export interface HistoryPage {
    readonly channel: string;
    readonly messages: ChannelMessage[];
    readonly hasMore: boolean;
}
/** One search request; every filter is optional except the query itself. */
export interface SearchQuery {
    /** Single channel id, or undefined to search every non-archived channel. */
    readonly channel?: string;
    /** Additional scope: only these channels (membership-filtered search). */
    readonly channels?: readonly string[];
    /** Page size (clamped to 1..SEARCH_LIMIT, or SEARCH_LIMIT+1 for hasMore probes). */
    readonly limit?: number;
    /** Only messages with `seq < beforeSeq` (same channel paging convention). */
    readonly beforeSeq?: number;
}
export interface StoreOptions {
    readonly dataDir: string;
    /** Read-only mode: never write state files, never open message fds for append. */
    readonly readonly: boolean;
    readonly logger: LoggerLike;
}
/** Split a query into lowercase terms (whitespace separated, deduplicated). */
export declare function searchTerms(query: string): string[];
/**
 * The durable channel store. One instance per hub; all mutations go through
 * this class (and are refused in read-only mode).
 */
export declare class ChannelStore {
    readonly dataDir: string;
    readonly channelsFile: string;
    readonly participantsFile: string;
    readonly endpointFile: string;
    readonly lockFile: string;
    readonly messagesDir: string;
    readonly eventsDir: string;
    readonly cursorsDir: string;
    readonly readonlyMode: boolean;
    private readonly logger;
    private readonly channels;
    private readonly participants;
    private readonly lastSeq;
    private readonly fds;
    private readonly cursors;
    private readonly metaQueue;
    private closed;
    constructor(options: StoreOptions);
    /** Load state, fold event logs, recover last seq values, ensure #general. */
    init(): void;
    close(): void;
    messageFile(channel: string): string;
    private eventFile;
    private cursorFile;
    getChannel(channel: string): ChannelMeta | undefined;
    hasChannel(channel: string): boolean;
    listChannels(): ChannelMeta[];
    /** Insert or replace a channel and persist the cache. */
    putChannel(meta: ChannelMeta): Promise<void>;
    /** Archive / unarchive a channel; history is always retained. */
    setArchived(channel: string, archived: boolean): Promise<ChannelMeta>;
    saveChannels(): Promise<void>;
    /** Create a channel: validate, record the create event, persist the cache. */
    createChannel(input: {
        id: string;
        name?: string;
        topic?: string;
        category?: string;
    }, by: string): Promise<ChannelMeta>;
    pinMessage(channel: string, messageIdValue: string, by: string): Promise<ChannelMeta>;
    unpinMessage(channel: string, messageIdValue: string, by: string): Promise<ChannelMeta>;
    setAnnouncement(channel: string, messageIdValue: string, by: string): Promise<ChannelMeta>;
    private requireChannel;
    lastSeqOf(channel: string): number;
    /** Next sequence number for a channel (call from inside that channel's queue). */
    nextSeq(channel: string): number;
    /** Record an appended seq in memory (call from inside that channel's queue). */
    commitSeq(channel: string, seq: number): void;
    private fdFor;
    /**
     * Append one message line. Exactly one `writeSync` per line; the caller has
     * already allocated `message.seq` inside the channel serial queue.
     */
    appendMessage(channel: string, message: ChannelMessage): void;
    /** All complete messages in a channel, ascending by seq (partial tail tolerated). */
    readMessages(channel: string): ChannelMessage[];
    findMessage(channel: string, idValue: string): ChannelMessage | undefined;
    /**
     * Full-text search over immutable message logs (SPEC.md §5/§7.5).
     *
     * Case-insensitive, multi-term AND: every whitespace-separated term must
     * appear in the message text, its author handle or the display name.
     * Archived channels are skipped unless the query names one explicitly.
     * Hits are ordered by timestamp descending (seq descending within a channel)
     * and each carries a ±60 character snippet around the earliest match.
     */
    searchMessages(query: string, options?: SearchQuery): SearchHit[];
    /** Page through history with `beforeSeq` (older) / `afterSeq` (resume) / limit. */
    queryHistory(channel: string, query: HistoryQuery): HistoryPage;
    appendEvent(channel: string, event: ChannelEvent): void;
    readEvents(channel: string): ChannelEvent[];
    getParticipant(idValue: string): Participant | undefined;
    getParticipantByHandle(handle: string): Participant | undefined;
    listParticipants(): Participant[];
    putParticipant(participant: Participant): Promise<void>;
    /** Remove a participant registry row; message author snapshots stay untouched. */
    removeParticipant(participantId: string): Promise<boolean>;
    saveParticipants(): Promise<void>;
    readCursor(participantId: string): CursorState;
    writeCursor(participantId: string, channels: Record<string, number>): Promise<CursorState>;
    /** Serialized state-file persistence used by init(). */
    private persistStateSync;
    /** Remove the endpoint discovery file (used by dispose when we own it). */
    removeEndpointFile(): void;
    /** Channel ids currently known (for diagnostics). */
    channelIds(): string[];
    /** Number of open message descriptors (for diagnostics/tests). */
    openFdCount(): number;
    /** Directory listing for tests/debug: message files present on disk. */
    listMessageFiles(): string[];
}
export { makeMessageId };
