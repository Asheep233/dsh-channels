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
import { CHANNEL_TOOL_NAMES } from '../contract.js';
import { HostError, errMessage, isoNow, readJsonFile, service, writeJsonAtomic, } from './util.js';
/**
 * Tool names masked for a hidden session. `CHANNEL_TOOL_NAMES` is the contract
 * list of the channel surface; membership tools added later (join/leave) are
 * appended here so a hidden session cannot reach them either. Keep in sync with
 * `src/host/tools.ts`.
 */
const HIDDEN_TOOL_NAMES = [...CHANNEL_TOOL_NAMES];
/** Bump when the on-disk shape changes incompatibly. */
export const SESSION_PREFS_VERSION = 1;
/** File name inside the channels data dir. */
export const SESSION_PREFS_FILE = 'session-prefs.json';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Validate/normalize a caller-supplied session id (400 on anything unusable). */
export function normalizeSessionId(value) {
    if (typeof value !== 'string')
        throw new HostError(400, 'invalid_request', 'sessionId is required');
    const sessionId = value.trim();
    if (sessionId.length === 0)
        throw new HostError(400, 'invalid_request', 'sessionId is required');
    if (sessionId.length > 200)
        throw new HostError(400, 'invalid_request', 'sessionId is too long');
    if (/[\u0000-\u001f\u007f]/.test(sessionId)) {
        throw new HostError(400, 'invalid_request', 'sessionId contains control characters');
    }
    return sessionId;
}
/**
 * Validate a `{hidden?, muted?}` patch: every present field must be a boolean
 * and at least one field must be present (400 otherwise).
 */
export function normalizePrefsPatch(raw) {
    const patch = {};
    let fields = 0;
    if (raw.hidden !== undefined) {
        if (typeof raw.hidden !== 'boolean')
            throw new HostError(400, 'invalid_request', 'hidden must be a boolean');
        patch.hidden = raw.hidden;
        fields += 1;
    }
    if (raw.muted !== undefined) {
        if (typeof raw.muted !== 'boolean')
            throw new HostError(400, 'invalid_request', 'muted must be a boolean');
        patch.muted = raw.muted;
        fields += 1;
    }
    if (fields === 0)
        throw new HostError(400, 'invalid_request', 'at least one of hidden / muted is required');
    return patch;
}
/** Parse one persisted record (tolerant: malformed rows are dropped). */
function parseStoredPrefs(value) {
    if (!isRecord(value))
        return undefined;
    const hidden = value.hidden === true;
    const muted = value.muted === true;
    if (!hidden && !muted)
        return undefined;
    return {
        ...(hidden ? { hidden: true } : {}),
        ...(muted ? { muted: true } : {}),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : isoNow(),
        updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : 'unknown',
    };
}
/**
 * Per-session hidden/muted preferences plus the live tool-mask bookkeeping.
 * One instance per hub.
 */
export class SessionPrefsService {
    file;
    readonlyMode;
    logger;
    sessions = new Map();
    masks = new Map();
    loaded = false;
    constructor(options) {
        this.file = `${options.dataDir.replace(/[\\/]+$/, '')}/${SESSION_PREFS_FILE}`;
        this.readonlyMode = options.readonly;
        this.logger = options.logger;
    }
    // -- persistence ----------------------------------------------------------
    /** Load the preference table; a missing/corrupt file simply means empty state. */
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        const raw = readJsonFile(this.file);
        if (!isRecord(raw))
            return;
        if (raw.version !== undefined && raw.version !== SESSION_PREFS_VERSION) {
            this.logger.warn(`dsh-channels: ignoring session-prefs.json with unsupported version ${String(raw.version)}`);
            return;
        }
        const sessions = raw.sessions;
        if (!isRecord(sessions))
            return;
        for (const [sessionId, record] of Object.entries(sessions)) {
            const parsed = parseStoredPrefs(record);
            if (parsed === undefined)
                continue;
            this.sessions.set(sessionId, parsed);
        }
    }
    persist() {
        if (this.readonlyMode)
            return;
        const sessions = {};
        for (const [sessionId, record] of this.sessions)
            sessions[sessionId] = record;
        const body = { version: SESSION_PREFS_VERSION, sessions };
        writeJsonAtomic(this.file, body);
    }
    // -- reads ----------------------------------------------------------------
    /** Current preferences for one session (explicit booleans, never undefined). */
    get(sessionId) {
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return { hidden: false, muted: false };
        return {
            hidden: record.hidden === true,
            muted: record.muted === true,
            updatedAt: record.updatedAt,
            updatedBy: record.updatedBy,
        };
    }
    /** Do not wake this session? Hidden implies muted. */
    isMuted(sessionId) {
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return false;
        return record.muted === true || record.hidden === true;
    }
    /** Is the whole channel feature hidden from this session? */
    isHidden(sessionId) {
        return this.sessions.get(sessionId)?.hidden === true;
    }
    /** Sessions that currently have at least one non-default switch (diagnostics). */
    listSessions() {
        return [...this.sessions.keys()];
    }
    // -- writes ---------------------------------------------------------------
    /**
     * Merge a patch into one session's preferences and persist atomically.
     * Both flags false removes the row entirely (the default state).
     */
    set(sessionId, patch, by) {
        if (this.readonlyMode)
            throw new HostError(503, 'readonly', 'hub is read-only');
        const normalized = normalizeSessionId(sessionId);
        this.load();
        const current = this.sessions.get(normalized);
        const hidden = patch.hidden !== undefined ? patch.hidden : current?.hidden === true;
        const muted = patch.muted !== undefined ? patch.muted : current?.muted === true;
        const updatedBy = typeof by === 'string' && by.trim().length > 0 ? by.trim() : 'unknown';
        if (!hidden && !muted) {
            this.sessions.delete(normalized);
        }
        else {
            this.sessions.set(normalized, {
                ...(hidden ? { hidden: true } : {}),
                ...(muted ? { muted: true } : {}),
                updatedAt: isoNow(),
                updatedBy,
            });
        }
        try {
            this.persist();
        }
        catch (error) {
            this.logger.warn(`dsh-channels: failed to persist session preferences: ${errMessage(error)}`);
            throw new HostError(500, 'storage_error', `failed to persist session preferences: ${errMessage(error)}`);
        }
        return this.get(normalized);
    }
    // -- tool masking ---------------------------------------------------------
    /**
     * Apply or release the channel-tool mask for one live agent.
     *
     * Idempotent: a session already masked on the same agent object is left
     * alone; a different agent object with the same session id (resume) has the
     * stale restriction released first, because agent scopes are rebuilt.
     */
    applyToAgent(agent) {
        if (agent === undefined || typeof agent.id !== 'string' || agent.id.length === 0)
            return;
        const sessionId = agent.id;
        this.load();
        const hidden = this.isHidden(sessionId);
        const existing = this.masks.get(sessionId);
        if (!hidden) {
            if (existing !== undefined)
                this.releaseAgent(sessionId);
            return;
        }
        if (existing !== undefined && existing.agent === agent)
            return;
        if (existing !== undefined)
            this.releaseAgent(sessionId);
        const tools = agent.ctx?.tools;
        if (tools === undefined || typeof tools.restrict !== 'function') {
            // Agent scope without a tool registry (test doubles / older host): keep
            // the preference, skip the mask and re-applying happens on the next event.
            return;
        }
        try {
            const dispose = tools.restrict({ deny: [...HIDDEN_TOOL_NAMES] });
            this.masks.set(sessionId, { agent, dispose: typeof dispose === 'function' ? dispose : () => { } });
        }
        catch (error) {
            this.logger.warn(`dsh-channels: failed to mask channel tools for session ${sessionId}: ${errMessage(error)}`);
        }
    }
    /** Release one session's mask (agent disposed / preference cleared). */
    releaseAgent(sessionId) {
        const existing = this.masks.get(sessionId);
        if (existing === undefined)
            return;
        this.masks.delete(sessionId);
        try {
            existing.dispose();
        }
        catch {
            /* the agent scope may already be unwound; the restriction is gone with it */
        }
    }
    /** Release every mask (hub dispose / plugin unload). */
    releaseAll() {
        for (const sessionId of [...this.masks.keys()])
            this.releaseAgent(sessionId);
    }
    /** Number of currently applied masks (diagnostics/tests). */
    maskedCount() {
        return this.masks.size;
    }
    /** Is a mask currently applied for this session in this process? */
    isMasked(sessionId) {
        return this.masks.has(sessionId);
    }
    // -- agent lifecycle ------------------------------------------------------
    /**
     * Apply persisted prefs to every live agent, then keep following
     * `agent/created` / `agent/disposed` so new, resumed and cleared agents are
     * masked (or released) without a restart.
     *
     * @returns disposer that unregisters the listeners and releases every mask.
     */
    watch(ctx) {
        this.load();
        // 1) current live agents
        try {
            const agents = service(ctx, 'agents');
            const list = agents !== undefined && typeof agents.list === 'function' ? agents.list() : [];
            for (const entry of list)
                this.applyToAgent(asMaskableAgent(entry));
        }
        catch (error) {
            this.logger.warn(`dsh-channels: failed to apply session preferences to live agents: ${errMessage(error)}`);
        }
        // 2) future agents
        const offs = [];
        const on = ctx.on;
        if (typeof on === 'function') {
            const register = (event, listener, label) => {
                try {
                    const off = on.call(ctx, event, listener);
                    if (typeof off === 'function')
                        offs.push(off);
                }
                catch (error) {
                    this.logger.warn(`dsh-channels: failed to subscribe ${label}: ${errMessage(error)}`);
                }
            };
            register('agent/created', (...args) => {
                const agent = asMaskableAgent(agentFromEventPayload(args[0]));
                if (agent !== undefined)
                    this.applyToAgent(agent);
            }, 'agent/created');
            register('agent/disposed', (...args) => {
                const agent = asMaskableAgent(agentFromEventPayload(args[0]));
                if (agent !== undefined)
                    this.releaseAgent(agent.id);
            }, 'agent/disposed');
        }
        return () => {
            for (const off of offs.reverse()) {
                try {
                    off();
                }
                catch {
                    /* already disposed */
                }
            }
            this.releaseAll();
        };
    }
}
/** Read `payload.agent` from a Cordis event payload (also accepts a bare agent). */
function agentFromEventPayload(payload) {
    if (!isRecord(payload))
        return undefined;
    const agent = payload.agent;
    if (isRecord(agent) && typeof agent.id === 'string' && agent.id.length > 0)
        return agent;
    if (typeof payload.id === 'string' && payload.id.length > 0)
        return payload;
    return undefined;
}
/** Narrow an unknown value to the minimal agent shape (or undefined). */
function asMaskableAgent(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.id !== 'string' || value.id.length === 0)
        return undefined;
    return value;
}
//# sourceMappingURL=session-prefs.js.map