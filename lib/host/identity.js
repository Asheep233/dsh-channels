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
import { isValidHandle, normalizeHandle, shortName, } from '../contract.js';
import { HostError, errMessage, hashToken, isoNow, newId, newToken, publicParticipant, stableId, } from './util.js';
/** Activity window in which any participant reads as `online` (fresh lastSeen). */
const ONLINE_WINDOW_MS = 2 * 60_000;
/** Quiet-live / recently-seen window that still reads as `idle` instead of `offline`. */
const IDLE_WINDOW_MS = 30 * 60_000;
export class IdentityService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    // -- reads ----------------------------------------------------------------
    get(participantId) {
        return this.deps.store.getParticipant(participantId);
    }
    byHandle(handle) {
        return this.deps.store.getParticipantByHandle(handle);
    }
    list() {
        return this.deps.store.listParticipants();
    }
    findBySession(sessionId) {
        return this.deps.store.listParticipants().find((participant) => participant.binding?.sessionId === sessionId);
    }
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
    statusOf(participant) {
        const seen = Date.parse(participant.lastSeen);
        const age = Number.isFinite(seen) ? Date.now() - seen : Number.POSITIVE_INFINITY;
        if (age < ONLINE_WINDOW_MS)
            return 'online';
        const binding = participant.binding;
        if (binding !== undefined && binding.kind === 'dsh-session' && this.deps.isSessionLive(binding.sessionId))
            return 'idle';
        if (age < IDLE_WINDOW_MS)
            return 'idle';
        return 'offline';
    }
    /** Public participant shape with derived status and no token hash. */
    view(participant) {
        return { ...publicParticipant(participant), status: this.statusOf(participant) };
    }
    members() {
        return this.list().map((participant) => this.view(participant));
    }
    /** Remove one participant row (used by maintenance endpoints; history keeps author snapshots). */
    async remove(participantId) {
        return this.deps.store.removeParticipant(participantId);
    }
    /** Resolve a bearer token to its participant. */
    authenticate(token) {
        if (token === undefined || token.length === 0)
            return undefined;
        const digest = hashToken(token);
        for (const participant of this.deps.store.listParticipants()) {
            if (participant.tokenHash !== undefined && participant.tokenHash === digest)
                return participant;
        }
        return undefined;
    }
    // -- automatic session identity -------------------------------------------
    /**
     * Ensure the DSH session driving a tool call has a participant.
     * Deterministic per session id, so it survives host restarts. A claimed
     * identity bound to the session always wins.
     */
    async ensureSessionParticipant(sessionId, displayName) {
        const trimmed = sessionId.trim();
        if (trimmed.length === 0)
            throw new HostError(400, 'invalid_session', 'session id is empty');
        const bound = this.findBySession(trimmed);
        if (bound !== undefined)
            return this.touchParticipant(bound);
        const id = stableId('p', `dsh-session:${trimmed}`, 12);
        const existing = this.deps.store.getParticipant(id);
        if (existing !== undefined)
            return this.bind(existing, trimmed, displayName);
        const handle = this.uniqueHandle(this.autoHandle(trimmed));
        const now = isoNow();
        const participant = {
            id,
            handle,
            displayName: displayName !== undefined && displayName.trim().length > 0 ? displayName.trim() : handle,
            kind: 'dsh-agent',
            harness: 'dsh',
            createdAt: now,
            lastSeen: now,
            status: 'online',
            binding: { kind: 'dsh-session', sessionId: trimmed },
        };
        await this.detachSession(trimmed);
        await this.deps.store.putParticipant(participant);
        this.ensureDefaultMembership(participant);
        return participant;
    }
    autoHandle(sessionId) {
        const short = shortName(sessionId).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (short.length >= 2)
            return `dsh-${short.slice(0, 20)}`;
        const derived = stableId('', sessionId, 10).replace(/^_/, '');
        const fallback = `dsh-${derived}`;
        return fallback.length <= 24 ? fallback : fallback.slice(0, 24);
    }
    uniqueHandle(base) {
        const clean = base.slice(0, 24);
        if (this.deps.store.getParticipantByHandle(clean) === undefined)
            return clean;
        for (let index = 2; index < 100; index += 1) {
            const suffix = `-${index}`;
            const candidate = `${clean.slice(0, 24 - suffix.length)}${suffix}`;
            if (this.deps.store.getParticipantByHandle(candidate) === undefined)
                return candidate;
        }
        throw new HostError(409, 'conflict', 'could not allocate a unique handle');
    }
    // -- claim / login / release ----------------------------------------------
    /** Claim a handle for a session, taking it over from another session with `force`. */
    async claim(input) {
        const handle = normalizeHandle(input.handle);
        if (!isValidHandle(handle)) {
            throw new HostError(400, 'invalid_handle', 'handle must match /^[a-z0-9_-]{2,24}$/ and must not be reserved');
        }
        const sessionId = input.sessionId.trim();
        if (sessionId.length === 0)
            throw new HostError(400, 'invalid_session', 'session id is empty');
        const existing = this.deps.store.getParticipantByHandle(handle);
        if (existing === undefined) {
            const token = newToken();
            const now = isoNow();
            const participant = {
                id: newId('p'),
                handle,
                displayName: input.displayName !== undefined && input.displayName.trim().length > 0 ? input.displayName.trim() : handle,
                kind: 'dsh-agent',
                harness: 'dsh',
                createdAt: now,
                lastSeen: now,
                status: 'online',
                tokenHash: hashToken(token),
                binding: { kind: 'dsh-session', sessionId },
            };
            await this.detachSession(sessionId);
            await this.deps.store.putParticipant(participant);
            this.ensureDefaultMembership(participant);
            return { participant, token, created: true };
        }
        const boundSession = existing.binding?.sessionId;
        if (boundSession !== undefined && boundSession !== sessionId && input.force !== true) {
            throw new HostError(409, 'conflict', `handle "${handle}" is already bound to another session; pass force:true to take it over`);
        }
        const participant = await this.bind(existing, sessionId, input.displayName);
        return { participant, created: false };
    }
    /** Restore an external/claimed identity with its bearer token. */
    async login(input) {
        const handle = normalizeHandle(input.handle);
        const existing = this.deps.store.getParticipantByHandle(handle);
        if (existing === undefined)
            throw new HostError(401, 'unauthorized', `unknown handle "${handle}"`);
        if (input.token === undefined || input.token.length === 0) {
            throw new HostError(401, 'unauthorized', 'token is required to login');
        }
        if (existing.tokenHash === undefined || existing.tokenHash !== hashToken(input.token)) {
            throw new HostError(401, 'unauthorized', 'invalid token for this handle');
        }
        const sessionId = input.sessionId?.trim();
        if (sessionId === undefined || sessionId.length === 0)
            return this.touchParticipant(existing);
        const boundSession = existing.binding?.sessionId;
        if (boundSession !== undefined && boundSession !== sessionId && this.deps.isSessionLive(boundSession)) {
            throw new HostError(409, 'conflict', `identity "${handle}" is bound to a live session`);
        }
        return this.bind(existing, sessionId);
    }
    /** Rename an authenticated participant to a requested handle (external claim). */
    async adoptHandle(input) {
        const handle = normalizeHandle(input.handle);
        if (!isValidHandle(handle)) {
            throw new HostError(400, 'invalid_handle', 'handle must match /^[a-z0-9_-]{2,24}$/ and must not be reserved');
        }
        const caller = this.deps.store.getParticipant(input.participantId);
        if (caller === undefined)
            throw new HostError(401, 'unauthorized', 'unknown participant');
        const existing = this.deps.store.getParticipantByHandle(handle);
        if (existing !== undefined && existing.id !== caller.id) {
            if (input.force !== true)
                throw new HostError(409, 'conflict', `handle "${handle}" is already taken`);
            // Identities are never deleted: park the previous holder on a fresh handle.
            const suffix = stableId('', `${existing.id}:${isoNow()}:${Math.random()}`, 6).replace(/^_/, '');
            const parked = this.uniqueHandle(`released-${suffix}`);
            await this.deps.store.putParticipant({ ...existing, handle: parked });
        }
        const displayName = input.displayName?.trim();
        const next = {
            ...caller,
            handle,
            lastSeen: isoNow(),
            ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
        };
        await this.deps.store.putParticipant(next);
        return next;
    }
    /** Drop the binding held by one session (messages keep their author snapshot). */
    async release(sessionId) {
        const bound = this.findBySession(sessionId);
        if (bound === undefined)
            return undefined;
        const { binding: _binding, ...rest } = bound;
        const next = { ...rest, lastSeen: isoNow(), status: 'idle' };
        await this.deps.store.putParticipant(next);
        return next;
    }
    /** Register a human/external participant (and mint its bearer token). */
    async register(input) {
        const kind = input.kind;
        if (kind !== 'human' && kind !== 'external' && kind !== 'dsh-agent') {
            throw new HostError(400, 'invalid_request', 'kind must be one of human | dsh-agent | external');
        }
        let handle;
        if (input.handle !== undefined) {
            const normalized = normalizeHandle(input.handle);
            if (!isValidHandle(normalized)) {
                throw new HostError(400, 'invalid_handle', 'handle must match /^[a-z0-9_-]{2,24}$/ and must not be reserved');
            }
            handle = normalized;
        }
        if (handle !== undefined) {
            const existing = this.deps.store.getParticipantByHandle(handle);
            if (existing !== undefined) {
                // Re-registering an owned handle: the caller must prove it with its token.
                if (input.token !== undefined && existing.tokenHash !== undefined && existing.tokenHash === hashToken(input.token)) {
                    const participant = input.sessionId !== undefined
                        ? await this.bind(existing, input.sessionId, input.displayName)
                        : this.view(existing);
                    return { participant, token: input.token, created: false };
                }
                throw new HostError(409, 'conflict', `handle "${handle}" is already taken`);
            }
        }
        const token = newToken();
        const now = isoNow();
        const finalHandle = handle ?? this.uniqueHandle(`${kind === 'human' ? 'human' : 'ext'}-${hashToken(token).slice(0, 4)}`);
        const participant = {
            id: newId('p'),
            handle: finalHandle,
            displayName: input.displayName !== undefined && input.displayName.trim().length > 0 ? input.displayName.trim() : finalHandle,
            kind,
            harness: input.harness ?? (kind === 'dsh-agent' ? 'dsh' : 'other'),
            createdAt: now,
            lastSeen: now,
            status: 'idle',
            tokenHash: hashToken(token),
            ...(input.sessionId !== undefined && input.sessionId.trim().length > 0
                ? { binding: { kind: 'dsh-session', sessionId: input.sessionId.trim() } }
                : {}),
        };
        if (input.sessionId !== undefined && input.sessionId.trim().length > 0) {
            await this.detachSession(input.sessionId.trim());
        }
        await this.deps.store.putParticipant(participant);
        this.ensureDefaultMembership(participant);
        return { participant, token, created: true };
    }
    /** Update `lastSeen` (heartbeat / any authenticated action). */
    async touch(participantId) {
        const participant = this.deps.store.getParticipant(participantId);
        if (participant === undefined)
            return undefined;
        return this.touchParticipant(participant);
    }
    /** Best-effort `#general` membership for a freshly created participant. */
    ensureDefaultMembership(participant) {
        try {
            this.deps.memberships?.joinDefaults({ id: participant.id, kind: participant.kind });
        }
        catch (error) {
            this.deps.logger.warn(`dsh-channels: failed to join ${participant.handle} to #general: ${errMessage(error)}`);
        }
    }
    async touchParticipant(participant) {
        const next = { ...participant, lastSeen: isoNow() };
        try {
            await this.deps.store.putParticipant(next);
        }
        catch (error) {
            // Presence updates must never fail a read-only hub or a chat call.
            this.deps.logger.warn(`dsh-channels: failed to persist lastSeen: ${errMessage(error)}`);
        }
        return next;
    }
    // -- binding helpers ------------------------------------------------------
    /** Bind `participant` to `sessionId` (clearing any previous holder of that session). */
    async bind(participant, sessionId, displayName) {
        await this.detachSession(sessionId, participant.id);
        const next = {
            ...participant,
            lastSeen: isoNow(),
            status: 'online',
            binding: { kind: 'dsh-session', sessionId },
            ...(displayName !== undefined && displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
        };
        await this.deps.store.putParticipant(next);
        return next;
    }
    /** Remove the session binding from every participant except `keepId`. */
    async detachSession(sessionId, keepId) {
        const held = this.deps.store
            .listParticipants()
            .filter((participant) => participant.binding?.sessionId === sessionId && participant.id !== keepId);
        for (const participant of held) {
            const { binding: _binding, ...rest } = participant;
            await this.deps.store.putParticipant({ ...rest, status: 'idle', lastSeen: isoNow() });
        }
    }
}
//# sourceMappingURL=identity.js.map