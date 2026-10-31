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
import { closeSync, openSync, readdirSync, unlinkSync, } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_CHANNEL, MAX_PAGE, SEARCH_LIMIT, messageId as makeMessageId, } from '../contract.js';
import { parseAttachment } from './attachments.js';
import { HostError, appendJsonLineSync, ensureDir, errMessage, isoNow, listJsonlFiles, readJsonFile, readJsonlFile, readLastSeqFromFile, readTextFile, SerialQueue, writeJsonAtomic, } from './util.js';
const MAX_LIMIT = MAX_PAGE;
const DEFAULT_LIMIT = 50;
/** Safe on-disk file stem for a channel id / participant id. */
function safeName(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned.slice(0, 96) : '_';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPinEntry(value) {
    if (!isRecord(value))
        return false;
    return typeof value.messageId === 'string' && typeof value.by === 'string' && typeof value.at === 'string';
}
function parseChannelMeta(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== 'string' || value.id.length === 0)
        return undefined;
    if (typeof value.name !== 'string' || value.name.length === 0)
        return undefined;
    const pins = Array.isArray(value.pins) ? value.pins.filter(isPinEntry) : [];
    const meta = {
        id: value.id,
        name: value.name,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : isoNow(),
        createdBy: typeof value.createdBy === 'string' ? value.createdBy : 'system',
        pins,
    };
    return {
        ...meta,
        ...(typeof value.topic === 'string' ? { topic: value.topic } : {}),
        ...(typeof value.category === 'string' ? { category: value.category } : {}),
        ...(typeof value.announcementId === 'string' ? { announcementId: value.announcementId } : {}),
        ...(value.archived === true ? { archived: true } : {}),
    };
}
function isParticipantKind(value) {
    return value === 'human' || value === 'dsh-agent' || value === 'external';
}
function isHarnessName(value) {
    return value === 'dsh' || value === 'claude-code' || value === 'codex' || value === 'opencode' || value === 'other';
}
function parseParticipant(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== 'string' || value.id.length === 0)
        return undefined;
    if (typeof value.handle !== 'string' || value.handle.length === 0)
        return undefined;
    if (!isParticipantKind(value.kind))
        return undefined;
    const bindingRaw = value.binding;
    let binding;
    if (isRecord(bindingRaw) && bindingRaw.kind === 'dsh-session' && typeof bindingRaw.sessionId === 'string' && bindingRaw.sessionId.length > 0) {
        binding = { kind: 'dsh-session', sessionId: bindingRaw.sessionId };
    }
    return {
        id: value.id,
        handle: value.handle,
        displayName: typeof value.displayName === 'string' && value.displayName.length > 0 ? value.displayName : value.handle,
        kind: value.kind,
        harness: isHarnessName(value.harness) ? value.harness : 'other',
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : isoNow(),
        lastSeen: typeof value.lastSeen === 'string' ? value.lastSeen : isoNow(),
        status: value.status === 'online' || value.status === 'idle' || value.status === 'offline' ? value.status : 'offline',
        ...(typeof value.tokenHash === 'string' && value.tokenHash.length > 0 ? { tokenHash: value.tokenHash } : {}),
        ...(binding !== undefined ? { binding } : {}),
    };
}
function parseChannelMessage(value, channel) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== 'string' || value.id.length === 0)
        return undefined;
    if (typeof value.seq !== 'number' || !Number.isFinite(value.seq) || value.seq < 1)
        return undefined;
    if (typeof value.text !== 'string')
        return undefined;
    if (value.channel !== channel)
        return undefined;
    if (value.kind !== 'chat' && value.kind !== 'announcement')
        return undefined;
    const authorRaw = value.author;
    if (!isRecord(authorRaw))
        return undefined;
    if (typeof authorRaw.participantId !== 'string' || typeof authorRaw.handle !== 'string')
        return undefined;
    if (!isParticipantKind(authorRaw.kind))
        return undefined;
    const mentions = Array.isArray(value.mentions)
        ? value.mentions.filter((entry) => typeof entry === 'string')
        : [];
    const replyRaw = value.replyTo;
    let replyTo;
    if (isRecord(replyRaw) && typeof replyRaw.id === 'string' && typeof replyRaw.seq === 'number' && typeof replyRaw.authorName === 'string') {
        replyTo = {
            id: replyRaw.id,
            seq: replyRaw.seq,
            authorName: replyRaw.authorName,
            excerpt: typeof replyRaw.excerpt === 'string' ? replyRaw.excerpt : '',
        };
    }
    const attachmentsRaw = Array.isArray(value.attachments) ? value.attachments : [];
    const attachments = [];
    for (const entry of attachmentsRaw) {
        const attachment = parseAttachment(entry);
        if (attachment !== undefined)
            attachments.push(attachment);
    }
    return {
        id: value.id,
        channel,
        seq: value.seq,
        ts: typeof value.ts === 'string' ? value.ts : isoNow(),
        author: {
            participantId: authorRaw.participantId,
            handle: authorRaw.handle,
            displayName: typeof authorRaw.displayName === 'string' && authorRaw.displayName.length > 0 ? authorRaw.displayName : authorRaw.handle,
            kind: authorRaw.kind,
            harness: isHarnessName(authorRaw.harness) ? authorRaw.harness : 'other',
        },
        text: value.text,
        mentions,
        ...(replyTo !== undefined ? { replyTo } : {}),
        kind: value.kind,
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}
// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------
/** Flatten a message body into one whitespace-collapsed line for snippets. */
function flattenForSnippet(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/**
 * Build a ±60 character snippet around the earliest matching term.
 * `undefined` when no term matches the body (author-only hits fall back to a
 * leading preview of the message).
 */
function buildSnippet(text, terms) {
    const flat = flattenForSnippet(text);
    const lower = flat.toLowerCase();
    let matchIndex = -1;
    let matchTermLength = 0;
    for (const term of terms) {
        const index = lower.indexOf(term);
        if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
            matchIndex = index;
            matchTermLength = term.length;
        }
    }
    if (matchIndex < 0)
        return undefined;
    const window = 60;
    const start = Math.max(0, matchIndex - window);
    const end = Math.min(flat.length, matchIndex + matchTermLength + window);
    return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
/** Split a query into lowercase terms (whitespace separated, deduplicated). */
export function searchTerms(query) {
    const terms = [];
    for (const raw of query.replace(/\s+/g, ' ').trim().split(' ')) {
        const term = raw.toLowerCase();
        if (term.length > 0 && !terms.includes(term))
            terms.push(term);
    }
    return terms;
}
function parseChannelEvent(value) {
    if (!isRecord(value))
        return undefined;
    const type = value.type;
    if (typeof value.channel !== 'string' || value.channel.length === 0)
        return undefined;
    const at = typeof value.at === 'string' ? value.at : isoNow();
    const by = typeof value.by === 'string' ? value.by : 'system';
    if (type === 'create') {
        return {
            type,
            channel: value.channel,
            name: typeof value.name === 'string' && value.name.length > 0 ? value.name : value.channel,
            at,
            by,
            ...(typeof value.topic === 'string' ? { topic: value.topic } : {}),
            ...(typeof value.category === 'string' ? { category: value.category } : {}),
        };
    }
    if (typeof value.messageId !== 'string' || value.messageId.length === 0)
        return undefined;
    if (type === 'pin' || type === 'unpin' || type === 'announce') {
        return { type, channel: value.channel, messageId: value.messageId, at, by };
    }
    return undefined;
}
/** Fold one channel's event log into its meta (pins / announcement / creation). */
function foldEvents(base, events) {
    let meta = base;
    for (const event of events) {
        if (event.type === 'create') {
            if (meta === undefined) {
                meta = {
                    id: event.channel,
                    name: event.name,
                    createdAt: event.at,
                    createdBy: event.by,
                    pins: [],
                    ...(event.topic !== undefined ? { topic: event.topic } : {}),
                    ...(event.category !== undefined ? { category: event.category } : {}),
                };
            }
            continue;
        }
        if (meta === undefined)
            continue;
        if (event.type === 'pin') {
            if (meta.pins.some((pin) => pin.messageId === event.messageId))
                continue;
            meta = { ...meta, pins: [...meta.pins, { messageId: event.messageId, by: event.by, at: event.at }] };
            continue;
        }
        if (event.type === 'unpin') {
            meta = { ...meta, pins: meta.pins.filter((pin) => pin.messageId !== event.messageId) };
            continue;
        }
        if (event.type === 'announce') {
            meta = { ...meta, announcementId: event.messageId };
        }
    }
    return meta;
}
/**
 * The durable channel store. One instance per hub; all mutations go through
 * this class (and are refused in read-only mode).
 */
export class ChannelStore {
    dataDir;
    channelsFile;
    participantsFile;
    endpointFile;
    lockFile;
    messagesDir;
    eventsDir;
    cursorsDir;
    readonlyMode;
    logger;
    channels = new Map();
    participants = new Map();
    lastSeq = new Map();
    fds = new Map();
    cursors = new Map();
    metaQueue = new SerialQueue();
    closed = false;
    constructor(options) {
        this.dataDir = options.dataDir;
        this.readonlyMode = options.readonly;
        this.logger = options.logger;
        this.channelsFile = join(this.dataDir, 'channels.json');
        this.participantsFile = join(this.dataDir, 'participants.json');
        this.endpointFile = join(this.dataDir, 'endpoint.json');
        this.lockFile = join(this.dataDir, 'hub.lock');
        this.messagesDir = join(this.dataDir, 'messages');
        this.eventsDir = join(this.dataDir, 'events');
        this.cursorsDir = join(this.dataDir, 'cursors');
    }
    // -- lifecycle ------------------------------------------------------------
    /** Load state, fold event logs, recover last seq values, ensure #general. */
    init() {
        ensureDir(this.dataDir);
        const rawChannels = readJsonFile(this.channelsFile);
        if (Array.isArray(rawChannels)) {
            for (const entry of rawChannels) {
                const meta = parseChannelMeta(entry);
                if (meta !== undefined)
                    this.channels.set(meta.id, meta);
            }
        }
        const rawParticipants = readJsonFile(this.participantsFile);
        if (Array.isArray(rawParticipants)) {
            for (const entry of rawParticipants) {
                const participant = parseParticipant(entry);
                if (participant !== undefined)
                    this.participants.set(participant.id, participant);
            }
        }
        // Event logs can rebuild channels.json (and always re-derive pins/announcement).
        for (const fileName of listJsonlFiles(this.eventsDir)) {
            const channel = basename(fileName, '.jsonl');
            const events = this.readEvents(channel);
            if (events.length === 0)
                continue;
            const folded = foldEvents(this.channels.get(channel), events);
            if (folded !== undefined)
                this.channels.set(channel, folded);
        }
        let changed = false;
        if (!this.channels.has(DEFAULT_CHANNEL)) {
            const now = isoNow();
            this.channels.set(DEFAULT_CHANNEL, {
                id: DEFAULT_CHANNEL,
                name: DEFAULT_CHANNEL,
                createdAt: now,
                createdBy: 'system',
                pins: [],
            });
            changed = true;
            if (!this.readonlyMode) {
                this.appendEvent(DEFAULT_CHANNEL, { type: 'create', channel: DEFAULT_CHANNEL, name: DEFAULT_CHANNEL, at: now, by: 'system' });
            }
        }
        if (changed && !this.readonlyMode)
            this.persistStateSync();
        for (const channel of this.channels.keys()) {
            this.lastSeq.set(channel, readLastSeqFromFile(this.messageFile(channel), channel));
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const fd of this.fds.values()) {
            try {
                closeSync(fd);
            }
            catch {
                /* ignore */
            }
        }
        this.fds.clear();
    }
    // -- paths ----------------------------------------------------------------
    messageFile(channel) {
        return join(this.messagesDir, `${safeName(channel)}.jsonl`);
    }
    eventFile(channel) {
        return join(this.eventsDir, `${safeName(channel)}.jsonl`);
    }
    cursorFile(participantId) {
        return join(this.cursorsDir, `${safeName(participantId)}.json`);
    }
    // -- channels -------------------------------------------------------------
    getChannel(channel) {
        return this.channels.get(channel);
    }
    hasChannel(channel) {
        return this.channels.has(channel);
    }
    listChannels() {
        return [...this.channels.values()];
    }
    /** Insert or replace a channel and persist the cache. */
    async putChannel(meta) {
        this.channels.set(meta.id, meta);
        if (!this.readonlyMode && !this.closed)
            await this.saveChannels();
    }
    /** Archive / unarchive a channel; history is always retained. */
    async setArchived(channel, archived) {
        const current = this.channels.get(channel);
        if (current === undefined)
            throw new HostError(404, 'not_found', `channel "${channel}" does not exist`);
        const next = archived ? { ...current, archived: true } : (({ archived: _drop, ...rest }) => rest)(current);
        this.channels.set(channel, next);
        if (!this.readonlyMode && !this.closed)
            await this.saveChannels();
        return next;
    }
    async saveChannels() {
        if (this.readonlyMode || this.closed)
            return;
        const snapshot = this.listChannels();
        await this.metaQueue.run('state', () => {
            writeJsonAtomic(this.channelsFile, snapshot);
        });
    }
    /** Create a channel: validate, record the create event, persist the cache. */
    async createChannel(input, by) {
        if (this.readonlyMode)
            throw new HostError(503, 'readonly', 'hub is read-only');
        if (this.channels.has(input.id))
            throw new HostError(409, 'conflict', `channel "${input.id}" already exists`);
        const now = isoNow();
        const meta = {
            id: input.id,
            name: input.name !== undefined && input.name.trim().length > 0 ? input.name.trim() : input.id,
            createdAt: now,
            createdBy: by,
            pins: [],
            ...(input.topic !== undefined && input.topic.length > 0 ? { topic: input.topic } : {}),
            ...(input.category !== undefined && input.category.length > 0 ? { category: input.category } : {}),
        };
        this.channels.set(meta.id, meta);
        this.lastSeq.set(meta.id, 0);
        this.appendEvent(meta.id, {
            type: 'create',
            channel: meta.id,
            name: meta.name,
            at: now,
            by,
            ...(meta.topic !== undefined ? { topic: meta.topic } : {}),
            ...(meta.category !== undefined ? { category: meta.category } : {}),
        });
        await this.saveChannels();
        return meta;
    }
    async pinMessage(channel, messageIdValue, by) {
        const meta = this.requireChannel(channel);
        if (meta.pins.some((pin) => pin.messageId === messageIdValue))
            return meta;
        const now = isoNow();
        const next = { ...meta, pins: [...meta.pins, { messageId: messageIdValue, by, at: now }] };
        this.channels.set(channel, next);
        this.appendEvent(channel, { type: 'pin', channel, messageId: messageIdValue, at: now, by });
        await this.saveChannels();
        return next;
    }
    async unpinMessage(channel, messageIdValue, by) {
        const meta = this.requireChannel(channel);
        const next = { ...meta, pins: meta.pins.filter((pin) => pin.messageId !== messageIdValue) };
        this.channels.set(channel, next);
        this.appendEvent(channel, { type: 'unpin', channel, messageId: messageIdValue, at: isoNow(), by });
        await this.saveChannels();
        return next;
    }
    async setAnnouncement(channel, messageIdValue, by) {
        const meta = this.requireChannel(channel);
        const next = { ...meta, announcementId: messageIdValue };
        this.channels.set(channel, next);
        this.appendEvent(channel, { type: 'announce', channel, messageId: messageIdValue, at: isoNow(), by });
        await this.saveChannels();
        return next;
    }
    requireChannel(channel) {
        const meta = this.channels.get(channel);
        if (meta === undefined)
            throw new HostError(404, 'not_found', `channel "${channel}" does not exist`);
        return meta;
    }
    // -- message log ----------------------------------------------------------
    lastSeqOf(channel) {
        return this.lastSeq.get(channel) ?? 0;
    }
    /** Next sequence number for a channel (call from inside that channel's queue). */
    nextSeq(channel) {
        return this.lastSeqOf(channel) + 1;
    }
    /** Record an appended seq in memory (call from inside that channel's queue). */
    commitSeq(channel, seq) {
        this.lastSeq.set(channel, seq);
    }
    fdFor(channel) {
        const cached = this.fds.get(channel);
        if (cached !== undefined)
            return cached;
        ensureDir(this.messagesDir);
        const fd = openSync(this.messageFile(channel), 'a+');
        this.fds.set(channel, fd);
        return fd;
    }
    /**
     * Append one message line. Exactly one `writeSync` per line; the caller has
     * already allocated `message.seq` inside the channel serial queue.
     */
    appendMessage(channel, message) {
        if (this.readonlyMode)
            throw new HostError(503, 'readonly', 'hub is read-only');
        if (this.closed)
            throw new HostError(500, 'storage_error', 'channel store is closed');
        try {
            appendJsonLineSync(this.fdFor(channel), message);
        }
        catch (error) {
            // Drop the (possibly poisoned) descriptor so the next append reopens it.
            const fd = this.fds.get(channel);
            if (fd !== undefined) {
                this.fds.delete(channel);
                try {
                    closeSync(fd);
                }
                catch {
                    /* ignore */
                }
            }
            throw new HostError(500, 'storage_error', `failed to append message: ${errMessage(error)}`);
        }
    }
    /** All complete messages in a channel, ascending by seq (partial tail tolerated). */
    readMessages(channel) {
        const text = readTextFile(this.messageFile(channel));
        if (text === undefined || text.length === 0)
            return [];
        const out = [];
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line.length === 0)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue; // trailing partial line from a crash
            }
            const message = parseChannelMessage(parsed, channel);
            if (message !== undefined)
                out.push(message);
        }
        out.sort((left, right) => left.seq - right.seq);
        return out;
    }
    findMessage(channel, idValue) {
        return this.readMessages(channel).find((message) => message.id === idValue);
    }
    /**
     * Full-text search over immutable message logs (SPEC.md §5/§7.5).
     *
     * Case-insensitive, multi-term AND: every whitespace-separated term must
     * appear in the message text, its author handle or the display name.
     * Archived channels are skipped unless the query names one explicitly.
     * Hits are ordered by timestamp descending (seq descending within a channel)
     * and each carries a ±60 character snippet around the earliest match.
     */
    searchMessages(query, options = {}) {
        const terms = searchTerms(query);
        if (terms.length === 0)
            return [];
        let targets;
        if (options.channel !== undefined) {
            targets = this.channels.has(options.channel) ? [options.channel] : [];
        }
        else {
            const allowed = options.channels !== undefined ? new Set(options.channels) : undefined;
            targets = this.listChannels()
                .filter((meta) => meta.archived !== true && (allowed === undefined || allowed.has(meta.id)))
                .map((meta) => meta.id);
        }
        const requested = options.limit ?? SEARCH_LIMIT;
        // Allow one extra row so Hub.search can compute `hasMore` exactly.
        const limit = Number.isFinite(requested)
            ? Math.min(SEARCH_LIMIT + 1, Math.max(1, Math.floor(requested)))
            : SEARCH_LIMIT;
        const hits = [];
        for (const channel of targets) {
            for (const message of this.readMessages(channel)) {
                if (options.beforeSeq !== undefined && message.seq >= options.beforeSeq)
                    continue;
                const haystack = `${message.text}\n${message.author.handle}\n${message.author.displayName}`.toLowerCase();
                if (!terms.every((term) => haystack.includes(term)))
                    continue;
                const snippet = buildSnippet(message.text, terms) ?? flattenForSnippet(message.text).slice(0, 120);
                hits.push({ channel, message, snippet });
            }
        }
        hits.sort((left, right) => {
            const byTime = Date.parse(right.message.ts) - Date.parse(left.message.ts);
            if (Number.isFinite(byTime) && byTime !== 0)
                return byTime;
            if (right.message.seq !== left.message.seq)
                return right.message.seq - left.message.seq;
            return left.channel.localeCompare(right.channel);
        });
        return hits.slice(0, limit);
    }
    /** Page through history with `beforeSeq` (older) / `afterSeq` (resume) / limit. */
    queryHistory(channel, query) {
        const all = this.readMessages(channel);
        let candidates = all;
        if (query.afterSeq !== undefined)
            candidates = candidates.filter((message) => message.seq > query.afterSeq);
        if (query.beforeSeq !== undefined)
            candidates = candidates.filter((message) => message.seq < query.beforeSeq);
        const requested = query.limit ?? DEFAULT_LIMIT;
        const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested))) : DEFAULT_LIMIT;
        let page;
        if (query.afterSeq !== undefined) {
            page = candidates.slice(0, limit);
        }
        else {
            page = candidates.slice(Math.max(0, candidates.length - limit));
        }
        return { channel, messages: page, hasMore: candidates.length > page.length };
    }
    // -- event log ------------------------------------------------------------
    appendEvent(channel, event) {
        if (this.readonlyMode)
            return;
        ensureDir(this.eventsDir);
        const fd = openSync(this.eventFile(channel), 'a+');
        try {
            appendJsonLineSync(fd, event);
        }
        finally {
            closeSync(fd);
        }
    }
    readEvents(channel) {
        const raw = readJsonlFile(this.eventFile(channel));
        const out = [];
        for (const entry of raw) {
            const event = parseChannelEvent(entry);
            if (event !== undefined)
                out.push(event);
        }
        return out;
    }
    // -- participants ---------------------------------------------------------
    getParticipant(idValue) {
        return this.participants.get(idValue);
    }
    getParticipantByHandle(handle) {
        const normalized = handle.trim().toLowerCase();
        for (const participant of this.participants.values()) {
            if (participant.handle === normalized)
                return participant;
        }
        return undefined;
    }
    listParticipants() {
        return [...this.participants.values()];
    }
    async putParticipant(participant) {
        this.participants.set(participant.id, participant);
        if (!this.readonlyMode && !this.closed)
            await this.saveParticipants();
    }
    /** Remove a participant registry row; message author snapshots stay untouched. */
    async removeParticipant(participantId) {
        const existed = this.participants.delete(participantId);
        if (existed && !this.readonlyMode && !this.closed)
            await this.saveParticipants();
        return existed;
    }
    async saveParticipants() {
        if (this.readonlyMode || this.closed)
            return;
        const snapshot = this.listParticipants();
        await this.metaQueue.run('state', () => {
            writeJsonAtomic(this.participantsFile, snapshot);
        });
    }
    // -- cursors --------------------------------------------------------------
    readCursor(participantId) {
        const cached = this.cursors.get(participantId);
        if (cached !== undefined)
            return cached;
        const raw = readJsonFile(this.cursorFile(participantId));
        const channels = {};
        if (raw !== undefined && isRecord(raw.channels)) {
            for (const [channel, seq] of Object.entries(raw.channels)) {
                if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0)
                    channels[channel] = seq;
            }
        }
        const state = {
            participantId,
            channels,
            updatedAt: raw !== undefined && typeof raw.updatedAt === 'string' ? raw.updatedAt : isoNow(),
        };
        this.cursors.set(participantId, state);
        return state;
    }
    async writeCursor(participantId, channels) {
        const state = { participantId, channels: { ...channels }, updatedAt: isoNow() };
        this.cursors.set(participantId, state);
        if (!this.readonlyMode && !this.closed) {
            await this.metaQueue.run('state', () => {
                writeJsonAtomic(this.cursorFile(participantId), state);
            });
        }
        return state;
    }
    // -- misc -----------------------------------------------------------------
    /** Serialized state-file persistence used by init(). */
    persistStateSync() {
        try {
            writeJsonAtomic(this.channelsFile, this.listChannels());
        }
        catch (error) {
            this.logger.warn(`dsh-channels: failed to persist channels.json: ${errMessage(error)}`);
        }
    }
    /** Remove the endpoint discovery file (used by dispose when we own it). */
    removeEndpointFile() {
        try {
            unlinkSync(this.endpointFile);
        }
        catch {
            /* missing is fine */
        }
    }
    /** Channel ids currently known (for diagnostics). */
    channelIds() {
        return [...this.channels.keys()];
    }
    /** Number of open message descriptors (for diagnostics/tests). */
    openFdCount() {
        return this.fds.size;
    }
    /** Directory listing for tests/debug: message files present on disk. */
    listMessageFiles() {
        try {
            return readdirSync(this.messagesDir);
        }
        catch {
            return [];
        }
    }
}
export { makeMessageId };
//# sourceMappingURL=store.js.map