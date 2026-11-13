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

import {
  API_BASE,
  DEFAULT_CHANNEL,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_CHANNEL_RATE_PER_MINUTE,
  MAX_CHANNEL_TEXT_CHARS,
  SEARCH_LIMIT,
  humanSize,
  isValidChannelId,
  isValidHandle,
  messageId as makeMessageId,
  normalizeHandle,
  utf8Bytes,
} from '../contract.js'
import type {
  Attachment,
  ChannelMessage,
  ChannelMeta,
  ChannelPolicy,
  ChannelView,
  MembershipResponse,
  Participant,
  ReplyRef,
  SearchHit,
  SessionPrefs,
} from '../contract.js'

import { ChannelStore } from './store.js'
import { AttachmentStore, normalizeMime, publicAttachment } from './attachments.js'
import type { AttachmentMeta } from './attachments.js'
import { IdentityService } from './identity.js'
import type { ClaimInput, ClaimResult, LoginInput, RegisterInput, RegisterResult } from './identity.js'
import { WakeService, resolveMentionHandles } from './wake.js'
import type { WakeReport } from './wake.js'
import { installHttp } from './http.js'
import { installTools } from './tools.js'
import { installCommands } from './commands.js'
import { SessionPrefsService, normalizePrefsPatch, normalizeSessionId } from './session-prefs.js'
import type { SessionPrefsPatch } from './session-prefs.js'
import { MembershipService } from './memberships.js'
import { ChannelPolicyService } from './policy.js'
import { join as joinPath } from 'node:path'
import {
  HostError,
  LOCK_TOUCH_MS as DEFAULT_LOCK_TOUCH_MS,
  SerialQueue,
  acquireHubLock,
  ensureDir,
  errMessage,
  isoNow,
  releaseHubLock,
  readJsonFile,
  resolveDataDir,
  service,
  touchFile,
  writeJsonAtomic,
} from './util.js'
import type { AgentLike, CtxLike, HubLockAcquisition, LoggerLike, ToolsLike } from './util.js'


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChannelsConfig {
  readonly dataDir: string
  /** Force read-only even when the hub lock is free (tests / secondary view). */
  readonly readonly: boolean
  /** Whether mentions/replies wake DSH sessions at all. */
  readonly wake: boolean
  /** Live-session wake delivery: steer (interject, default) or followup (next turn). */
  readonly wakeDelivery: 'steer' | 'followup'
  readonly wakeRateMs: number
  readonly sendRatePerMinute: number
  readonly announceRateMs: number
  readonly maxTextBytes: number
  readonly maxBodyBytes: number
  /** Per-file attachment upload cap (default 25MB, SPEC §7.5). */
  readonly maxAttachmentBytes: number
  /** Per-message attachment total cap (default 50MB, SPEC §7.5). */
  readonly maxAttachmentTotalBytes: number
  readonly streamKeepaliveMs: number
  readonly idempotencyTtlMs: number
  readonly lockTouchMs: number
  /** Handles auto-joined to every channel (see `default-members.json` too). */
  readonly defaultMembers: readonly string[]
  /** Channels every agent joins by default (general always; this machine: general,lobby). */
  readonly defaultChannels: readonly string[]
}

/** Channel named by a broadcast `message` frame payload (undefined for other events). */
function messageChannelOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const channel = (message as { channel?: unknown }).channel
  return typeof channel === 'string' && channel.length > 0 ? channel : undefined
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Normalize the optional second `apply(ctx, config)` argument (plain object). */
export function normalizeConfig(raw: unknown, resolveDataDir: (configured?: unknown) => string): ChannelsConfig {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key]
    }
    return undefined
  }
  return {
    dataDir: resolveDataDir(source.dataDir),
    readonly: boolValue(pick('readonly', 'readOnly'), false),
    wake: boolValue(pick('wake', 'wakeEnabled', 'mentions'), true),
    wakeDelivery: pick('wakeDelivery', 'wakeMode') === 'followup' ? 'followup' : 'steer',
    wakeRateMs: positiveNumber(pick('wakeRateMs'), 5_000),
    sendRatePerMinute: positiveNumber(pick('sendRatePerMinute', 'messagesPerMinute', 'rateLimitPerMinute'), 30),
    announceRateMs: positiveNumber(pick('announceRateMs'), 10 * 60_000),
    maxTextBytes: positiveNumber(pick('maxTextBytes'), 8 * 1024),
    maxBodyBytes: positiveNumber(pick('maxBodyBytes'), 128 * 1024),
    maxAttachmentBytes: positiveNumber(pick('maxAttachmentBytes'), MAX_ATTACHMENT_BYTES),
    maxAttachmentTotalBytes: positiveNumber(pick('maxAttachmentTotalBytes'), MAX_ATTACHMENT_TOTAL_BYTES),
    streamKeepaliveMs: positiveNumber(pick('streamKeepaliveMs', 'heartbeatMs'), 15_000),
    idempotencyTtlMs: positiveNumber(pick('idempotencyTtlMs'), 10 * 60_000),
    lockTouchMs: positiveNumber(pick('lockTouchMs'), DEFAULT_LOCK_TOUCH_MS),
    defaultMembers: normalizeDefaultMembers(pick('defaultMembers', 'autoJoinMembers')),
    defaultChannels: normalizeDefaultChannels(pick('defaultChannels', 'autoJoinChannels')),
  }
}

/** Default-joined channels for every agent (general is always included). */
function normalizeDefaultChannels(value: unknown): string[] {
  const source = Array.isArray(value) ? value : ['general', 'lobby']
  const out: string[] = ['general']
  for (const entry of source) {
    if (typeof entry !== 'string' || !isValidChannelId(entry) || out.includes(entry)) continue
    out.push(entry)
  }
  return out
}

/** Parse an optional per-channel posting limit: null/'' resets, numbers are validated. */
function normalizeLimit(value: unknown, min: number, max: number, name: string): number | null {
  if (value === null || value === '' || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HostError(400, 'invalid_request', `${name} must be an integer between ${min} and ${max}, or null to reset`)
  }
  return parsed
}

/** Validate/dedupe the optional `defaultMembers` handle list. */
function normalizeDefaultMembers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const handle = normalizeHandle(entry)
    if (!isValidHandle(handle) || out.includes(handle)) continue
    out.push(handle)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Channel meta plus per-participant view columns (contract `ChannelView`). */
export type { ChannelView } from '../contract.js'

export interface SendInput {
  readonly channel: string
  readonly text: string
  readonly replyTo?: string
  readonly mentions?: readonly unknown[]
  /** Attachment ids minted by POST /upload; text may be empty when present. */
  readonly attachments?: readonly unknown[]
  readonly clientMsgId?: string
}

export interface SendOutcome {
  readonly message: ChannelMessage
  readonly duplicate: boolean
  readonly wake: WakeReport
}

export interface AnnounceInput {
  readonly channel: string
  readonly text: string
}

export interface PinInput {
  readonly channel: string
  readonly messageId: string
}

export interface HistoryInput {
  readonly channel?: string
  readonly beforeSeq?: number
  readonly afterSeq?: number
  readonly limit?: number
}

export interface HistoryOutcome {
  readonly channel: string
  readonly messages: readonly ChannelMessage[]
  readonly hasMore: boolean
}

export interface UploadInput {
  readonly name?: unknown
  /** Declared mime; empty/absent falls back to the filename guess, malformed is rejected. */
  readonly mime?: unknown
  readonly bytes: Buffer
}

export interface SearchInput {
  readonly query: string
  readonly channel?: string
  readonly limit?: number
  readonly beforeSeq?: number
}

export interface SearchOutcome {
  readonly query: string
  readonly hits: readonly SearchHit[]
  readonly hasMore: boolean
}

export interface SseClientOptions {
  readonly req: import('node:http').IncomingMessage
  readonly res: import('node:http').ServerResponse
  readonly participant?: Participant
  readonly afterSeq?: number
}

export interface SseClientHandle {
  readonly participantId?: string
  /** Remove the client and end its response. Idempotent. */
  readonly detach: () => void
}

interface SseClientState {
  readonly res: import('node:http').ServerResponse
  readonly participantId?: string
  closed: boolean
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export class ChannelsHub {
  readonly ctx: CtxLike
  readonly config: ChannelsConfig
  readonly startedAt: string
  readonly logger: LoggerLike

  readonly store: ChannelStore
  readonly identity: IdentityService
  readonly wake: WakeService
  /** Immutable attachment blob store (`<dataDir>/attachments`). */
  readonly attachments: AttachmentStore
  /** Per-session hidden / muted switches (`<dataDir>/session-prefs.json`). */
  readonly sessionPrefs: SessionPrefsService
  /** Per-participant channel membership (`<dataDir>/channel-memberships.json`). */
  readonly memberships: MembershipService
  /** Per-channel admins / mutes / posting limits (`<dataDir>/channel-policies.json`). */
  readonly policy: ChannelPolicyService

  readonly lock: HubLockAcquisition
  /** False when another live hub owns the data directory (or config says so). */
  readonly writer: boolean
  readonly readonlyReason?: string
  /** This instance's lock owner id (guards release after a hot-reload takeover). */
  private readonly lockNonce: string | undefined

  private readonly channelQueues = new SerialQueue()
  private readonly clients = new Set<SseClientState>()
  private readonly timers: NodeJS.Timeout[] = []
  /** participantId → last throttled activity touch (ms). */
  private readonly activityTouched = new Map<string, number>()
  /** `${channel}\0${participantId}` → recent send timestamps for per-channel rate limits. */
  private readonly channelSendStamps = new Map<string, number[]>()
  /** Handles auto-joined to channels: config + default-members.json. */
  private readonly defaultMemberHandles: string[]
  /** When set, default members only join these channel ids (null = legacy "all"). */
  private readonly defaultMemberChannels: string[] | null
  /** Unregisters the agent/created|disposed listeners installed by start(). */
  private prefsWatchStop: (() => void) | undefined
  private disposed = false
  private endpointOwned = false

  constructor(ctx: CtxLike, config: ChannelsConfig) {
    this.ctx = ctx
    this.config = config
    this.startedAt = isoNow()
    this.logger = ctx.logger

    ensureDir(config.dataDir)
    const lock: HubLockAcquisition = config.readonly
      ? { writer: false, reason: 'configured readonly', lockFile: `${config.dataDir}/hub.lock` }
      : acquireHubLock(`${config.dataDir}/hub.lock`)
    this.lock = lock
    this.writer = lock.writer
    this.readonlyReason = lock.writer ? undefined : lock.reason
    this.lockNonce = lock.writer ? lock.nonce : undefined

    this.store = new ChannelStore({
      dataDir: config.dataDir,
      readonly: !this.writer,
      logger: this.logger,
    })
    this.store.init()

    this.attachments = new AttachmentStore(config.dataDir, !this.writer, config.maxAttachmentBytes)
    this.sessionPrefs = new SessionPrefsService({
      dataDir: config.dataDir,
      readonly: !this.writer,
      logger: this.logger,
    })
    this.sessionPrefs.load()

    this.memberships = new MembershipService({
      dataDir: config.dataDir,
      readonly: !this.writer,
      logger: this.logger,
      // Only channels that already exist are seeded; a later-created default
      // channel joins all known agents in createChannel().
      defaultChannels: config.defaultChannels.filter((channel) => this.store.hasChannel(channel)),
    })
    this.memberships.load()
    // Drop rows for archived/unknown channels, then prune removed participants.
    this.memberships.pruneChannels(
      new Set(this.store.listChannels().filter((meta) => meta.archived !== true).map((meta) => meta.id)),
    )
    // Cleanup rows for participants that were removed before this bookkeeping
    // existed, then migrate legacy participants into #general.
    this.memberships.pruneUnknown(new Set(this.store.listParticipants().map((participant) => participant.id)))
    // Migration: introduce general-only membership for participants that
    // predate the membership file; sub-channels are deliberately not seeded.
    this.memberships.seedMissing(this.store.listParticipants())

    this.policy = new ChannelPolicyService({
      dataDir: config.dataDir,
      readonly: !this.writer,
      logger: this.logger,
    })
    this.policy.load()
    this.policy.pruneChannels(new Set(this.store.listChannels().map((meta) => meta.id)))
    this.policy.pruneParticipants(new Set(this.store.listParticipants().map((participant) => participant.id)))

    this.identity = new IdentityService({
      store: this.store,
      logger: this.logger,
      isSessionLive: (sessionId) => this.liveAgent(sessionId) !== undefined,
      memberships: this.memberships,
    })
    // Legacy continuity: when the membership file is created for the first time,
    // also put each channel's creator back into the channel it created.
    if (this.memberships.wasStorageMissing()) this.seedLegacyCreatorMemberships()

    // Auto-join handles: config list + <dataDir>/default-members.json.
    const defaultMembers = this.loadDefaultMembers(config)
    this.defaultMemberHandles = defaultMembers.handles
    this.defaultMemberChannels = defaultMembers.channels
    this.applyDefaultMembersToExistingChannels()
    this.wake = new WakeService({
      store: this.store,
      identity: this.identity,
      ctx: this.ctx,
      logger: this.logger,
      enabled: config.wake,
      liveDelivery: config.wakeDelivery,
      wakeRateMs: config.wakeRateMs,
      sendRatePerMinute: config.sendRatePerMinute,
      announceRateMs: config.announceRateMs,
      idempotencyTtlMs: config.idempotencyTtlMs,
      liveAgent: (sessionId) => this.liveAgent(sessionId),
      isMuted: (sessionId) => this.sessionPrefs.isMuted(sessionId),
      isChannelMember: (participantId, channel) => {
        const participant = this.store.getParticipant(participantId)
        return participant !== undefined && this.memberships.isMember(participant, channel)
      },
    })
  }

  // -- default members ------------------------------------------------------

  /**
   * Config `defaultMembers` + `<dataDir>/default-members.json`:
   * `{version, handles[], channels?[]}`. When `channels` is present the handles
   * are only auto-joined to those channel ids (new channels stay creator-only);
   * omitting it preserves the legacy "join every channel" behavior.
   */
  private loadDefaultMembers(config: ChannelsConfig): { handles: string[]; channels: string[] | null } {
    const handles: string[] = []
    const add = (value: unknown): void => {
      if (typeof value !== 'string') return
      const handle = normalizeHandle(value)
      if (!isValidHandle(handle) || handles.includes(handle)) return
      handles.push(handle)
    }
    let channels: string[] | null = null
    for (const handle of config.defaultMembers) add(handle)
    try {
      const raw = readJsonFile<unknown>(joinPath(config.dataDir, 'default-members.json'))
      if (typeof raw === 'object' && raw !== null) {
        const record = raw as { handles?: unknown; channels?: unknown }
        if (Array.isArray(record.handles)) for (const handle of record.handles) add(handle)
        if (Array.isArray(record.channels)) {
          channels = record.channels.filter(
            (channel): channel is string => typeof channel === 'string' && isValidChannelId(channel),
          )
        }
      }
    } catch {
      /* optional file */
    }
    return { handles, channels }
  }

  /** Backfill: default members join the configured channels (or every channel in legacy mode). */
  private applyDefaultMembersToExistingChannels(): void {
    if (!this.writer || this.defaultMemberHandles.length === 0) return
    const scope = this.defaultMemberChannels
    const channels = this.store
      .listChannels()
      .filter((meta) => meta.archived !== true && (scope === null || scope.includes(meta.id)))
    let added = 0
    for (const handle of this.defaultMemberHandles) {
      const participant = this.identity.byHandle(handle)
      if (participant === undefined || participant.kind === 'human') continue
      for (const meta of channels) {
        try {
          if (this.memberships.join(participant, meta.id)) added += 1
        } catch (error) {
          this.logger.warn(`dsh-channels: default member ${handle} join #${meta.id} failed: ${errMessage(error)}`)
        }
      }
    }
    if (added > 0) this.logger.info(`dsh-channels: default members joined ${added} channel membership(s)`)
  }

  /** New default channel (general/lobby): every known agent joins right away. */
  private joinAllAgentsToChannel(channel: string): void {
    if (!this.writer) return
    for (const participant of this.store.listParticipants()) {
      if (participant.kind === 'human') continue
      try {
        this.memberships.join(participant, channel)
      } catch (error) {
        this.logger.warn(`dsh-channels: agent ${participant.handle} join default #${channel} failed: ${errMessage(error)}`)
      }
    }
  }

  private joinDefaultMembersToChannel(channel: string): void {
    if (!this.writer || this.defaultMemberHandles.length === 0) return
    if (this.defaultMemberChannels !== null && !this.defaultMemberChannels.includes(channel)) return
    for (const handle of this.defaultMemberHandles) {
      const participant = this.identity.byHandle(handle)
      if (participant === undefined || participant.kind === 'human') continue
      try {
        this.memberships.join(participant, channel)
      } catch (error) {
        this.logger.warn(`dsh-channels: default member ${handle} join #${channel} failed: ${errMessage(error)}`)
      }
    }
  }

  // -- lifecycle ------------------------------------------------------------

  /** Write endpoint.json, start keepalive/lock timers. Called by applyHub once. */
  start(): void {
    if (this.writer && !this.config.readonly) {
      try {
        writeJsonAtomic(this.store.endpointFile, {
          url: this.endpointUrl(),
          pid: process.pid,
          startedAt: this.startedAt,
          dataDir: this.config.dataDir,
        })
        this.endpointOwned = true
      } catch (error) {
        this.logger.warn(`dsh-channels: failed to write endpoint.json: ${errMessage(error)}`)
      }
    }

    if (this.writer) {
      const lockTimer = setInterval(() => touchFile(this.store.lockFile), this.config.lockTouchMs)
      lockTimer.unref?.()
      this.timers.push(lockTimer)
    }

    const streamTimer = setInterval(() => this.heartbeatClients(), this.config.streamKeepaliveMs)
    streamTimer.unref?.()
    this.timers.push(streamTimer)
  }

  /**
   * Apply persisted hidden prefs to every live agent and keep following
   * `agent/created` / `agent/disposed` (a new or resumed agent gets a fresh
   * scope). MUST run after `installTools()`: `tools.restrict({ deny })` rejects
   * names that are not registered in this scope yet, so masking before the
   * `channel_*` tools exist would silently fail for already-live agents.
   * Idempotent.
   */
  installSessionPrefs(): void {
    this.beginPrefsWatch()
  }

  /** Install the agent lifecycle watcher once (idempotent). */
  private beginPrefsWatch(): void {
    if (this.prefsWatchStop !== undefined) return
    try {
      this.prefsWatchStop = this.sessionPrefs.watch(this.ctx)
    } catch (error) {
      this.logger.warn(`dsh-channels: failed to watch agents for session preferences: ${errMessage(error)}`)
    }
  }

  /** Stop the watcher and release every applied tool mask (idempotent). */
  endPrefsWatch(): void {
    const stop = this.prefsWatchStop
    this.prefsWatchStop = undefined
    if (stop !== undefined) {
      try {
        stop()
      } catch (error) {
        this.logger.warn(`dsh-channels: failed to stop session-prefs watcher: ${errMessage(error)}`)
      }
    } else {
      this.sessionPrefs.releaseAll()
    }
  }

  /** Tear everything down: SSE clients, timers, fds, lock, endpoint file. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) {
      try {
        clearInterval(timer)
      } catch {
        /* ignore */
      }
    }
    this.timers.length = 0
    for (const client of [...this.clients]) this.dropClient(client, true)
    this.clients.clear()
    this.endPrefsWatch()
    this.store.close()
    if (this.writer) releaseHubLock(this.store.lockFile, this.lockNonce)
    if (this.endpointOwned) {
      this.store.removeEndpointFile()
      this.endpointOwned = false
    }
  }

  // -- diagnostics ----------------------------------------------------------

  health(): Record<string, unknown> {
    const lastSeq: Record<string, number> = {}
    for (const channel of this.store.channelIds()) lastSeq[channel] = this.store.lastSeqOf(channel)
    return {
      ok: true,
      plugin: 'dsh-channels',
      pid: process.pid,
      startedAt: this.startedAt,
      dataDir: this.config.dataDir,
      readonly: !this.writer,
      ...(this.readonlyReason !== undefined ? { readonlyReason: this.readonlyReason } : {}),
      wake: this.config.wake,
      apiBase: API_BASE,
      channels: this.store.channelIds(),
      participants: this.store.listParticipants().length,
      sseClients: this.clients.size,
      lastSeq,
    }
  }

  private endpointUrl(): string {
    const webServer = service(this.ctx, 'webServer')
    try {
      if (webServer !== undefined && typeof webServer.getOrigin === 'function') {
        const origin = webServer.getOrigin() as unknown
        if (typeof origin === 'string' && origin.length > 0) return `${origin}${API_BASE}`
      }
    } catch {
      /* not bound yet: fall through to port */
    }
    const port = webServer !== undefined && typeof webServer.port === 'number' ? (webServer.port as number) : 3080
    return `http://127.0.0.1:${port}${API_BASE}`
  }

  // -- shared guards --------------------------------------------------------

  assertWritable(): void {
    if (!this.writer) {
      throw new HostError(503, 'readonly', `dsh-channels is read-only: ${this.readonlyReason ?? 'another instance owns the data directory'}`)
    }
  }

  liveAgent(sessionId: string): AgentLike | undefined {
    const agents = service(this.ctx, 'agents')
    if (agents === undefined) return undefined
    try {
      if (typeof agents.get === 'function') return agents.get(sessionId) as AgentLike | undefined
      const list = typeof agents.list === 'function' ? (agents.list() as readonly AgentLike[]) : []
      return list.find((agent) => agent.id === sessionId)
    } catch {
      return undefined
    }
  }

  requireChannel(channel: unknown): string {
    if (typeof channel !== 'string' || !isValidChannelId(channel)) {
      throw new HostError(400, 'invalid_request', 'channel id must match /^[a-z0-9][a-z0-9-]{0,31}$/')
    }
    if (!this.store.hasChannel(channel)) throw new HostError(404, 'not_found', `channel "${channel}" does not exist`)
    return channel
  }

  /**
   * Membership gate (SPEC §7.8): non-human participants must join a channel
   * before reading, writing or being woken for it. Humans are exempt.
   * An unauthenticated loopback read (participant null) is not gated: there is
   * no identity to check, and it is covered by the v1 loopback read trust.
   */
  requireMembership(participant: Participant | null | undefined, channel: string): void {
    if (participant === null || participant === undefined) return
    if (this.memberships.isMember(participant, channel)) return
    throw new HostError(
      403,
      'not_member',
      `you are not a member of #${channel}; call channel_join first (POST /channels/api/join)`,
    )
  }

  /**
   * Channel-admin policy gate for a normal message / announcement (SPEC §7.10).
   * The human operator is exempt from mutes and limits; admins are exempt from
   * `mutedAll` but can still be muted explicitly by the human operator.
   */
  private assertCanSend(author: Participant, channel: string, text: string): void {
    if (author.kind === 'human') return
    const policy = this.policy.get(channel)
    if (policy.muted.includes(author.id)) {
      throw new HostError(403, 'muted', `you are muted in #${channel}; ask a channel admin to unmute you`)
    }
    if (policy.mutedAll && !policy.admins.includes(author.id)) {
      throw new HostError(
        403,
        'channel_muted',
        `#${channel} is muted for all members (全员禁言); only channel admins and the human operator can send`,
      )
    }
    if (policy.maxChars !== null) {
      const chars = Array.from(text).length
      if (chars > policy.maxChars) {
        throw new HostError(
          400,
          'text_too_long',
          `message exceeds the ${policy.maxChars}-character limit of #${channel} (got ${chars})`,
        )
      }
    }
  }

  /** Per-channel frequency limit (rolling 60s); humans are exempt. */
  private consumeChannelSendRate(author: Participant, channel: string): void {
    if (author.kind === 'human') return
    const limit = this.policy.get(channel).ratePerMinute
    if (limit === null) return
    const key = `${channel}\u0000${author.id}`
    const now = Date.now()
    const windowStart = now - 60_000
    const stamps = (this.channelSendStamps.get(key) ?? []).filter((stamp) => stamp > windowStart)
    if (stamps.length >= limit) {
      this.channelSendStamps.set(key, stamps)
      const oldest = stamps[0] ?? now
      throw new HostError(
        429,
        'rate_limited',
        `#${channel} rate limit exceeded (${limit} messages/minute per member); retry in ${Math.ceil((oldest + 60_000 - now) / 1000)}s`,
      )
    }
    stamps.push(now)
    this.channelSendStamps.set(key, stamps)
    if (this.channelSendStamps.size > 2_000) {
      for (const [entry, values] of this.channelSendStamps) {
        const last = values[values.length - 1]
        if (last === undefined || last <= windowStart) this.channelSendStamps.delete(entry)
      }
    }
  }

  /** True when `actor` may manage channel policy (human operator or channel admin). */
  isChannelAdmin(actor: Participant | null | undefined, channel: string): boolean {
    if (actor === null || actor === undefined) return false
    if (actor.kind === 'human') return true
    return this.policy.get(channel).admins.includes(actor.id)
  }

  private requireChannelManager(actor: Participant, channel: string): ChannelPolicy {
    const policy = this.policy.get(channel)
    if (actor.kind === 'human' || policy.admins.includes(actor.id)) return policy
    throw new HostError(403, 'forbidden', `only a #${channel} admin or the human operator can manage this channel`)
  }

  /** Resolve an agent handle that must already be a member of `channel`. */
  private resolvePolicyTarget(handle: unknown, channel: string): Participant {
    const value = typeof handle === 'string' ? normalizeHandle(handle) : ''
    if (value.length === 0 || !isValidHandle(value)) {
      throw new HostError(400, 'invalid_request', 'handle is required (2-24 chars: a-z 0-9 _ -)')
    }
    const target = this.identity.byHandle(value)
    if (target === undefined) throw new HostError(404, 'not_found', `participant "@${value}" does not exist`)
    if (target.kind === 'human') throw new HostError(400, 'invalid_request', 'humans cannot be muted or channel admins')
    if (!this.memberships.isMember(target, channel)) {
      throw new HostError(400, 'invalid_request', `@${value} is not a member of #${channel}; channel_join first`)
    }
    return target
  }

  /** Broadcast a policy change to every SSE subscriber. */
  private broadcastPolicy(channel: string): void {
    const policy = this.policy.get(channel)
    const handleOf = (id: string): string | undefined => this.store.getParticipant(id)?.handle
    this.broadcast('policy', {
      type: 'policy',
      channel,
      admins: policy.admins.map(handleOf).filter((handle): handle is string => handle !== undefined),
      muted: policy.muted.map(handleOf).filter((handle): handle is string => handle !== undefined),
      mutedAll: policy.mutedAll,
      maxChars: policy.maxChars,
      ratePerMinute: policy.ratePerMinute,
    })
  }

  /** Stored member count for one channel (humans are exempt, not counted). */
  memberCount(channel: string): number {
    return this.memberships.memberCount(channel)
  }

  // -- reads ----------------------------------------------------------------

  listChannels(participant?: Participant | null, options: { includeArchived?: boolean } = {}): ChannelView[] {
    const cursor = participant !== undefined && participant !== null ? this.store.readCursor(participant.id).channels : {}
    return this.store
      .listChannels()
      .filter((meta) => options.includeArchived === true || meta.archived !== true)
      .map((meta) => {
        const lastSeq = this.store.lastSeqOf(meta.id)
        const read = cursor[meta.id] ?? 0
        return {
          ...meta,
          lastSeq,
          unread: participant !== undefined && participant !== null ? Math.max(0, lastSeq - read) : 0,
          joined: participant !== undefined && participant !== null ? this.memberships.isMember(participant, meta.id) : false,
          memberCount: this.memberships.memberCount(meta.id),
          ...this.policyView(meta.id, participant),
        }
      })
  }

  /** Policy columns for one channel view (handles, mute flags, caller abilities). */
  private policyView(
    channel: string,
    participant?: Participant | null,
  ): Pick<
    ChannelView,
    'admins' | 'muted' | 'mutedAll' | 'maxChars' | 'ratePerMinute' | 'canManage' | 'canAppointAdmins'
  > {
    const policy = this.policy.get(channel)
    const handleOf = (id: string): string | undefined => this.store.getParticipant(id)?.handle
    const admins = policy.admins.map(handleOf).filter((handle): handle is string => handle !== undefined)
    const muted = policy.muted.map(handleOf).filter((handle): handle is string => handle !== undefined)
    const human = participant !== undefined && participant !== null && participant.kind === 'human'
    const admin = participant !== undefined && participant !== null && policy.admins.includes(participant.id)
    return {
      admins,
      muted,
      mutedAll: policy.mutedAll,
      maxChars: policy.maxChars,
      ratePerMinute: policy.ratePerMinute,
      canManage: human || admin,
      canAppointAdmins: human,
    }
  }

  /** One channel view (404 when unknown). */
  channelView(participant: Participant | null, channel: unknown): ChannelView {
    const channelId = this.requireChannel(channel)
    const views = this.listChannels(participant)
    const view = views.find((entry) => entry.id === channelId)
    if (view === undefined) {
      // Archived channels are not in the default list; build the view directly.
      const meta = this.store.getChannel(channelId) as ChannelMeta
      const lastSeq = this.store.lastSeqOf(channelId)
      return {
        ...meta,
        lastSeq,
        unread: 0,
        joined: participant !== null && this.memberships.isMember(participant, channelId),
        memberCount: this.memberships.memberCount(channelId),
        ...this.policyView(channelId, participant),
      }
    }
    return view
  }

  history(participant: Participant | null, input: HistoryInput): HistoryOutcome {
    const channel = input.channel === undefined ? DEFAULT_CHANNEL : this.requireChannel(input.channel)
    this.requireMembership(participant, channel)
    const page = this.store.queryHistory(channel, {
      ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
      ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
    const last = page.messages[page.messages.length - 1]
    if (participant !== null && last !== undefined) this.markRead(participant.id, channel, last.seq)
    return page
  }

  /** Pinned messages. Legacy single-argument form treats the caller as anonymous. */
  pins(participant: Participant | null, channel: unknown): { channel: ChannelMeta; messages: ChannelMessage[]; pins: ChannelMeta['pins'] }
  pins(channel: unknown): { channel: ChannelMeta; messages: ChannelMessage[]; pins: ChannelMeta['pins'] }
  pins(first: Participant | null | unknown, second?: unknown): { channel: ChannelMeta; messages: ChannelMessage[]; pins: ChannelMeta['pins'] } {
    const participant: Participant | null = second === undefined ? null : (first as Participant | null)
    const channel = second === undefined ? first : second
    const channelId = this.requireChannel(channel)
    this.requireMembership(participant, channelId)
    const meta = this.store.getChannel(channelId) as ChannelMeta
    const messages: ChannelMessage[] = []
    for (const pin of meta.pins) {
      const message = this.store.findMessage(channelId, pin.messageId)
      if (message !== undefined) messages.push(message)
    }
    return { channel: meta, messages, pins: meta.pins }
  }

  /**
   * Member list for one channel (or the global registry when `channel` is
   * omitted, used by diagnostics). Channel mode returns only stored members;
   * the calling human operator is appended when absent because humans are
   * exempt from membership and still see themselves in the list.
   */
  members(channel?: unknown, caller?: Participant | null): Participant[] {
    if (channel === undefined) return this.identity.members()
    const channelId = this.requireChannel(channel)
    const ids = new Set(this.memberships.membersOf(channelId))
    const policy = this.policy.get(channelId)
    const out: Participant[] = []
    for (const participantId of ids) {
      const participant = this.store.getParticipant(participantId)
      if (participant === undefined) continue
      out.push({
        ...this.identity.view(participant),
        ...(policy.admins.includes(participant.id) ? { admin: true } : {}),
        ...(policy.muted.includes(participant.id) ? { muted: true } : {}),
      })
    }
    if (caller !== undefined && caller !== null && caller.kind === 'human' && !ids.has(caller.id)) {
      out.push({
        ...this.identity.view(caller),
        ...(policy.admins.includes(caller.id) ? { admin: true } : {}),
        ...(policy.muted.includes(caller.id) ? { muted: true } : {}),
      })
    }
    out.sort((left, right) => left.handle.localeCompare(right.handle))
    return out
  }

  whoami(participant: Participant | null): Participant | null {
    return participant === null ? null : this.identity.view(participant)
  }

  /** Advance a participant's read cursor (monotonic; failures are non-fatal). */
  markRead(participantId: string, channel: string, seq: number): void {
    if (seq <= 0) return
    const cursor = this.store.readCursor(participantId)
    const current = cursor.channels[channel] ?? 0
    if (seq <= current) return
    const next = { ...cursor.channels, [channel]: seq }
    void this.store.writeCursor(participantId, next).catch((error: unknown) => {
      this.logger.warn(`dsh-channels: failed to persist cursor: ${errMessage(error)}`)
    })
  }

  // -- writes ---------------------------------------------------------------

  async createChannel(author: Participant, input: { id: string; name?: string; topic?: string; category?: string }): Promise<ChannelMeta> {
    this.assertWritable()
    if (typeof input.id !== 'string' || !isValidChannelId(input.id)) {
      throw new HostError(400, 'invalid_request', 'channel id must match /^[a-z0-9][a-z0-9-]{0,31}$/')
    }
    const meta = await this.store.createChannel(
      {
        id: input.id,
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.topic === 'string' ? { topic: input.topic } : {}),
        ...(typeof input.category === 'string' ? { category: input.category } : {}),
      },
      author.handle,
    )
    // The creator is a member of the channel it just made (no-op for humans,
    // who are exempt from membership and implicitly joined everywhere).
    try {
      this.memberships.join(author, meta.id)
    } catch (error) {
      this.logger.warn(`dsh-channels: failed to add channel creator to #${meta.id}: ${errMessage(error)}`)
    }
    this.joinDefaultMembersToChannel(meta.id)
    if (this.config.defaultChannels.includes(meta.id)) this.joinAllAgentsToChannel(meta.id)
    this.broadcast('channel', { type: 'channel', channel: meta })
    return meta
  }

  /** Archive or restore a channel (history retained; archived channels reject new messages). */
  async archiveChannel(author: Participant, channel: unknown, archived: boolean): Promise<ChannelMeta> {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    const meta = await this.store.setArchived(channelId, archived)
    // Restoring a channel brings the configured default members back (membership
    // rows for archived channels are pruned), so a real channel never comes back
    // empty by accident.
    if (!archived) this.joinDefaultMembersToChannel(meta.id)
    this.broadcast('channel', { type: 'channel', channel: meta })
    return meta
  }

  /** Remove a participant registry row (maintenance; message author snapshots are retained). */
  async removeParticipant(author: Participant, participantId: unknown): Promise<{ removed: boolean; participantId: string }> {
    this.assertWritable()
    if (typeof participantId !== 'string' || participantId.trim().length === 0) {
      throw new HostError(400, 'invalid_request', 'participantId is required')
    }
    const id = participantId.trim()
    const removed = await this.identity.remove(id)
    if (removed) {
      this.memberships.removeParticipant(id)
      this.policy.removeParticipant(id)
    }
    return { removed, participantId: id }
  }

  async sendMessage(author: Participant, input: SendInput): Promise<SendOutcome> {
    this.assertWritable()
    const channel = this.requireChannel(input.channel)
    if (this.store.getChannel(channel)?.archived === true) {
      throw new HostError(409, 'archived', `channel "${channel}" is archived`)
    }
    this.requireMembership(author, channel)
    const text = typeof input.text === 'string' ? input.text : ''

    // Idempotent replay answers before any new validation: a retried send must
    // return the original message even if the request body changed slightly.
    const immediate = this.wake.lookupIdempotent(author.id, input.clientMsgId)
    if (immediate !== undefined) {
      return { message: immediate, duplicate: true, wake: this.emptyWake() }
    }

    // Channel admin policy (SPEC §7.10): mutes and per-message character cap.
    this.assertCanSend(author, channel, text)

    const attachments = this.resolveAttachments(author, input.attachments)
    if (text.trim().length === 0 && attachments.length === 0) {
      throw new HostError(400, 'invalid_request', 'text is required unless the message has attachments')
    }
    if (utf8Bytes(text) > this.config.maxTextBytes) {
      throw new HostError(400, 'invalid_request', `message exceeds ${this.config.maxTextBytes} bytes`)
    }

    const mentions = resolveMentionHandles(input.mentions, text)
    const replyTo = input.replyTo !== undefined ? this.buildReplyRef(channel, input.replyTo) : undefined

    const outcome = await this.channelQueues.run(channel, (): { message: ChannelMessage; duplicate: boolean } => {
      const duplicate = this.wake.lookupIdempotent(author.id, input.clientMsgId)
      if (duplicate !== undefined) return { message: duplicate, duplicate: true }

      this.consumeChannelSendRate(author, channel)
      this.wake.noteSend(author.id)
      const seq = this.store.nextSeq(channel)
      const message: ChannelMessage = {
        id: makeMessageId(channel, seq),
        channel,
        seq,
        ts: isoNow(),
        author: {
          participantId: author.id,
          handle: author.handle,
          displayName: author.displayName,
          kind: author.kind,
          harness: author.harness,
        },
        text,
        mentions,
        ...(replyTo !== undefined ? { replyTo } : {}),
        kind: 'chat',
        ...(attachments.length > 0 ? { attachments } : {}),
      }
      this.store.appendMessage(channel, message)
      this.store.commitSeq(channel, seq)
      this.wake.rememberIdempotent(author.id, input.clientMsgId, message)
      // Broadcast before wake so every subscriber sees the message before the
      // agent reacts to it.
      this.broadcast('message', { type: 'message', message })
      return { message, duplicate: false }
    })

    this.markRead(author.id, channel, outcome.message.seq)
    if (outcome.duplicate) return { message: outcome.message, duplicate: true, wake: this.emptyWake() }
    const wake = await this.wake.deliver(outcome.message)
    return { message: outcome.message, duplicate: false, wake }
  }

  // -- attachments ----------------------------------------------------------

  /**
   * Store one immutable attachment for `participant` (POST /upload, channel_upload).
   *
   * @throws HostError 400 when empty, 413 when over the per-file cap, 415 when
   *   the declared mime is malformed, 503 when the hub is read-only.
   */
  async uploadAttachment(participant: Participant, input: UploadInput): Promise<Attachment> {
    this.assertWritable()
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
      throw new HostError(400, 'invalid_request', 'attachment payload is empty')
    }
    let mime: string | undefined
    if (input.mime !== undefined && input.mime !== null && String(input.mime).trim().length > 0) {
      mime = normalizeMime(input.mime)
      if (mime === undefined) {
        throw new HostError(415, 'unsupported_media_type', `declared mime type "${String(input.mime).slice(0, 80)}" is malformed`)
      }
    }
    const meta = this.attachments.save({
      name: input.name,
      ...(mime !== undefined ? { mime } : {}),
      bytes: input.bytes,
      ownerId: participant.id,
      maxBytes: this.config.maxAttachmentBytes,
    })
    return publicAttachment(meta)
  }

  /** Metadata for serving GET /attachments/<id> (404 shape handled by HTTP). */
  attachmentMeta(id: unknown): AttachmentMeta | undefined {
    return this.attachments.meta(id)
  }

  /**
   * Validate and re-derive the attachment references for one outgoing message.
   * Client-supplied ids are re-resolved against the store so name/mime/size/url
   * can never be forged, and ownership + count + total-size limits are enforced.
   */
  private resolveAttachments(author: Participant, raw: readonly unknown[] | undefined): Attachment[] {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) throw new HostError(400, 'invalid_request', 'attachments must be an array of attachment ids')
    if (raw.length > MAX_ATTACHMENTS) {
      throw new HostError(400, 'invalid_request', `at most ${MAX_ATTACHMENTS} attachments per message`)
    }
    const ids: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new HostError(400, 'invalid_request', 'attachments must be an array of attachment ids')
      }
      const id = entry.trim()
      if (!ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) return []
    const resolved: Attachment[] = []
    let total = 0
    for (const id of ids) {
      const meta = this.attachments.meta(id)
      if (meta === undefined) throw new HostError(404, 'not_found', `attachment "${id}" does not exist`)
      if (meta.ownerId !== author.id) {
        throw new HostError(403, 'forbidden', `attachment "${id}" belongs to another participant`)
      }
      total += meta.size
      resolved.push(publicAttachment(meta))
    }
    if (total > this.config.maxAttachmentTotalBytes) {
      throw new HostError(
        400,
        'invalid_request',
        `attachments total ${humanSize(total)}; the per-message limit is ${humanSize(this.config.maxAttachmentTotalBytes)}`,
      )
    }
    return resolved
  }

  // -- membership (SPEC §7.8) ----------------------------------------------

  /**
   * Join one channel for the given participant (POST /join, channel_join).
   * Humans are always members, so this is a no-op that reports joined:true.
   */
  joinChannel(participant: Participant, channel: unknown): MembershipResponse {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    this.memberships.join(participant, channelId)
    return {
      channel: channelId,
      joined: this.memberships.isMember(participant, channelId),
      memberCount: this.memberships.memberCount(channelId),
    }
  }

  /** Leave one channel (#general is mandatory → 400). */
  leaveChannel(participant: Participant, channel: unknown): MembershipResponse {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    this.memberships.leave(participant, channelId)
    // Leaving drops channel-local roles: no ghost admins/mutes for non-members.
    this.policy.removeMember(channelId, participant.id)
    this.broadcastPolicy(channelId)
    return {
      channel: channelId,
      joined: this.memberships.isMember(participant, channelId),
      memberCount: this.memberships.memberCount(channelId),
    }
  }

  // -- channel administration (SPEC §7.10) ----------------------------------

  /**
   * Appoint/remove one channel admin. **Human operator only.** The target must
   * be a non-human member of the channel.
   *
   * @returns the updated channel view for `actor`.
   */
  setChannelAdmins(
    actor: Participant,
    channel: unknown,
    input: { readonly handle?: unknown; readonly admin?: unknown },
  ): ChannelView {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    if (actor.kind !== 'human') {
      throw new HostError(403, 'forbidden', 'only the human operator can appoint or remove channel admins')
    }
    const target = this.resolvePolicyTarget(input.handle, channelId)
    const policy = this.policy.get(channelId)
    const add = input.admin !== false
    const admins = add
      ? [...new Set([...policy.admins, target.id])]
      : policy.admins.filter((id) => id !== target.id)
    this.policy.update(channelId, { admins })
    this.broadcastPolicy(channelId)
    return this.channelView(actor, channelId)
  }

  /**
   * Mute/unmute every non-admin member (`all: true`) or one member. Allowed for
   * the human operator and channel admins; admins cannot mute another admin
   * (only the human can), and humans cannot be muted.
   *
   * @returns the updated channel view for `actor`.
   */
  setChannelMute(
    actor: Participant,
    channel: unknown,
    input: { readonly handle?: unknown; readonly all?: unknown; readonly muted?: unknown },
  ): ChannelView {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    this.requireChannelManager(actor, channelId)
    const muted = input.muted !== false

    if (input.all === true) {
      this.policy.update(channelId, { mutedAll: muted })
      this.broadcastPolicy(channelId)
      return this.channelView(actor, channelId)
    }

    const target = this.resolvePolicyTarget(input.handle, channelId)
    const policy = this.policy.get(channelId)
    if (policy.admins.includes(target.id) && actor.kind !== 'human') {
      throw new HostError(403, 'forbidden', 'channel admins cannot mute another channel admin; ask the human operator')
    }
    const list = muted
      ? [...new Set([...policy.muted, target.id])]
      : policy.muted.filter((id) => id !== target.id)
    this.policy.update(channelId, { muted: list })
    this.broadcastPolicy(channelId)
    return this.channelView(actor, channelId)
  }

  /**
   * Set per-channel posting limits. `null` resets a field to the server default.
   * Allowed for the human operator and channel admins.
   */
  setChannelLimits(
    actor: Participant,
    channel: unknown,
    input: { readonly maxChars?: unknown; readonly ratePerMinute?: unknown },
  ): ChannelView {
    this.assertWritable()
    const channelId = this.requireChannel(channel)
    this.requireChannelManager(actor, channelId)
    const patch: { maxChars?: number | null; ratePerMinute?: number | null } = {}
    let touched = false
    if (input.maxChars !== undefined) {
      patch.maxChars = normalizeLimit(input.maxChars, 1, MAX_CHANNEL_TEXT_CHARS, 'maxChars')
      touched = true
    }
    if (input.ratePerMinute !== undefined) {
      patch.ratePerMinute = normalizeLimit(input.ratePerMinute, 1, MAX_CHANNEL_RATE_PER_MINUTE, 'ratePerMinute')
      touched = true
    }
    if (!touched) throw new HostError(400, 'invalid_request', 'maxChars and/or ratePerMinute is required')
    this.policy.update(channelId, patch)
    this.broadcastPolicy(channelId)
    return this.channelView(actor, channelId)
  }

  // -- search ---------------------------------------------------------------

  /**
   * Full-text search across channels; never advances read cursors.
   *
   * Non-human participants only search channels they joined (SPEC §7.8); an
   * explicitly named non-member channel is a 403, and the legacy anonymous
   * single-argument form keeps searching every non-archived channel.
   */
  search(participant: Participant | null, input: SearchInput): SearchOutcome
  search(input: SearchInput): SearchOutcome
  search(first: Participant | null | SearchInput, second?: SearchInput): SearchOutcome {
    const participant: Participant | null = second === undefined ? null : (first as Participant | null)
    const input = (second === undefined ? first : second) as SearchInput
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query.length === 0) throw new HostError(400, 'invalid_request', 'query is required')
    const requested = input.limit ?? SEARCH_LIMIT
    const limit = Number.isFinite(requested) ? Math.min(SEARCH_LIMIT, Math.max(1, Math.floor(requested))) : SEARCH_LIMIT

    let scope: { channel: string } | { channels: string[] }
    if (input.channel !== undefined) {
      const channel = this.requireChannel(input.channel)
      this.requireMembership(participant, channel)
      scope = { channel }
    } else {
      const allChannels = this.store
        .listChannels()
        .filter((meta) => meta.archived !== true)
        .map((meta) => meta.id)
      scope = { channels: participant === null ? allChannels : this.memberships.joinedChannels(participant, allChannels) }
    }
    if ('channels' in scope && scope.channels.length === 0) return { query, hits: [], hasMore: false }

    const rows = this.store.searchMessages(query, {
      ...scope,
      ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
      limit: limit + 1,
    })
    const hasMore = rows.length > limit
    return { query, hits: hasMore ? rows.slice(0, limit) : rows, hasMore }
  }

  async announce(author: Participant, input: AnnounceInput): Promise<{ message: ChannelMessage; channel: ChannelMeta; wake: WakeReport }> {
    this.assertWritable()
    const channel = this.requireChannel(input.channel)
    this.requireMembership(author, channel)
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim().length === 0) throw new HostError(400, 'invalid_request', 'text is required')
    if (utf8Bytes(text) > this.config.maxTextBytes) {
      throw new HostError(400, 'invalid_request', `message exceeds ${this.config.maxTextBytes} bytes`)
    }
    this.assertCanSend(author, channel, text)
    this.consumeChannelSendRate(author, channel)
    this.wake.noteAnnounce(author.id)
    const mentions = resolveMentionHandles(undefined, text)

    const outcome = await this.channelQueues.run(channel, async (): Promise<{ message: ChannelMessage; channel: ChannelMeta }> => {
      const seq = this.store.nextSeq(channel)
      const message: ChannelMessage = {
        id: makeMessageId(channel, seq),
        channel,
        seq,
        ts: isoNow(),
        author: {
          participantId: author.id,
          handle: author.handle,
          displayName: author.displayName,
          kind: author.kind,
          harness: author.harness,
        },
        text,
        mentions,
        kind: 'announcement',
      }
      this.store.appendMessage(channel, message)
      this.store.commitSeq(channel, seq)
      const meta = await this.store.setAnnouncement(channel, message.id, author.handle)
      this.broadcast('message', { type: 'message', message })
      this.broadcast('channel', { type: 'channel', channel: meta })
      return { message, channel: meta }
    })

    this.markRead(author.id, channel, outcome.message.seq)
    const wake = await this.wake.deliver(outcome.message)
    return { message: outcome.message, channel: outcome.channel, wake }
  }

  async pin(author: Participant, input: PinInput): Promise<ChannelMeta> {
    this.assertWritable()
    const channel = this.requireChannel(input.channel)
    this.requireMembership(author, channel)
    const messageId = typeof input.messageId === 'string' ? input.messageId : ''
    if (messageId.length === 0) throw new HostError(400, 'invalid_request', 'messageId is required')
    if (this.store.findMessage(channel, messageId) === undefined) {
      throw new HostError(404, 'not_found', `message "${messageId}" does not exist in #${channel}`)
    }
    const meta = await this.channelQueues.run(channel, () => this.store.pinMessage(channel, messageId, author.handle))
    this.broadcast('channel', { type: 'channel', channel: meta })
    return meta
  }

  async unpin(author: Participant, input: PinInput): Promise<ChannelMeta> {
    this.assertWritable()
    const channel = this.requireChannel(input.channel)
    this.requireMembership(author, channel)
    const messageId = typeof input.messageId === 'string' ? input.messageId : ''
    if (messageId.length === 0) throw new HostError(400, 'invalid_request', 'messageId is required')
    const meta = await this.channelQueues.run(channel, () => this.store.unpinMessage(channel, messageId, author.handle))
    this.broadcast('channel', { type: 'channel', channel: meta })
    return meta
  }

  // -- identity wrappers ----------------------------------------------------

  async register(input: RegisterInput): Promise<RegisterResult> {
    this.assertWritable()
    const result = await this.identity.register(input)
    this.broadcast('presence', { type: 'presence', participant: this.identity.view(result.participant) })
    return result
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    this.assertWritable()
    const result = await this.identity.claim(input)
    this.broadcast('presence', { type: 'presence', participant: this.identity.view(result.participant) })
    return result
  }

  async login(input: LoginInput): Promise<Participant> {
    this.assertWritable()
    const participant = await this.identity.login(input)
    this.broadcast('presence', { type: 'presence', participant: this.identity.view(participant) })
    return participant
  }

  async release(sessionId: string): Promise<Participant | undefined> {
    this.assertWritable()
    const participant = await this.identity.release(sessionId)
    if (participant !== undefined) {
      this.broadcast('presence', { type: 'presence', participant: this.identity.view(participant) })
    }
    return participant
  }

  async heartbeat(participant: Participant): Promise<Participant> {
    const touched = (await this.identity.touch(participant.id)) ?? participant
    return this.identity.view(touched)
  }

  /**
   * Refresh `lastSeen` after an authenticated API action (send / upload / read
   * with a token …). Throttled per participant so chat traffic never turns into
   * a participants.json write per request; broadcasts at the same pace so the
   * member list flips to online without waiting for its 45s poll.
   */
  noteActivity(participant: Participant): void {
    const now = Date.now()
    const last = this.activityTouched.get(participant.id) ?? 0
    if (now - last < 15_000) return
    this.activityTouched.set(participant.id, now)
    void this.identity
      .touch(participant.id)
      .then((touched) => {
        if (touched !== undefined) {
          this.broadcast('presence', { type: 'presence', participant: this.identity.view(touched) })
        }
      })
      .catch(() => {
        /* presence refresh is best-effort */
      })
  }

  // -- per-session prefs (SPEC §7.7) ----------------------------------------

  /** Current hidden/muted switches for one session (defaults are explicit false). */
  sessionPrefsFor(sessionId: unknown): SessionPrefs {
    return this.sessionPrefs.get(normalizeSessionId(sessionId))
  }

  /**
   * Persist a hidden/muted patch and apply it to the live agent immediately:
   * hiding masks every `channel_*` tool in that agent scope, showing releases
   * the restriction, and both directions take effect for wake delivery at once
   * (WakeService reads the same service).
   */
  setSessionPrefs(sessionId: unknown, patch: SessionPrefsPatch, by: string): SessionPrefs {
    this.assertWritable()
    const id = normalizeSessionId(sessionId)
    const prefs = this.sessionPrefs.set(id, normalizePrefsPatch(patch), by)
    const agent = this.liveAgent(id)
    if (agent !== undefined) this.sessionPrefs.applyToAgent(agent)
    return prefs
  }

  // -- SSE ------------------------------------------------------------------

  /**
   * Register one SSE client: write `hello`, replay `afterSeq` backlog, then
   * stream live frames until the socket closes or the hub disposes.
   */
  addSseClient(options: SseClientOptions): SseClientHandle {
    const { req, res, participant, afterSeq } = options
    const client: SseClientState = {
      res,
      closed: false,
      ...(participant !== undefined ? { participantId: participant.id } : {}),
    }

    const hello = {
      type: 'hello',
      participantId: participant?.id ?? '',
      lastSeq: this.maxLastSeq(),
      channels: this.listChannels(participant ?? null),
      participant: participant === undefined ? null : this.identity.view(participant),
    }
    this.writeFrame(client, 'hello', hello)
    if (afterSeq !== undefined && Number.isFinite(afterSeq)) this.replay(client, afterSeq)
    this.clients.add(client)

    const detach = (): void => this.dropClient(client, true)
    res.on('close', detach)
    res.on('error', detach)
    req.on('close', detach)
    req.on('error', detach)
    return { ...(participant !== undefined ? { participantId: participant.id } : {}), detach }
  }

  private maxLastSeq(): number {
    let max = 0
    for (const channel of this.store.channelIds()) max = Math.max(max, this.store.lastSeqOf(channel))
    return max
  }

  /** Replay messages newer than `afterSeq` (bounded per channel) for reconnect. */
  private replay(client: SseClientState, afterSeq: number): void {
    for (const channel of this.store.channelIds()) {
      if (!this.canReceiveChannel(client, channel)) continue
      const page = this.store.queryHistory(channel, { afterSeq, limit: 100 })
      for (const message of page.messages) this.writeFrame(client, 'message', { type: 'message', message })
    }
  }

  /**
   * Whether one SSE subscriber may receive live/backlog messages from a channel.
   * Anonymous loopback subscribers keep the v1 read trust; identified non-human
   * participants must be channel members (humans are always members).
   */
  private canReceiveChannel(client: SseClientState, channel: string): boolean {
    const participantId = client.participantId
    if (participantId === undefined) return true
    const participant = this.store.getParticipant(participantId)
    if (participant === undefined) return false
    return this.memberships.isMember(participant, channel)
  }

  /** First-migration helper: re-join each legacy channel's creator (skip humans/general). */
  private seedLegacyCreatorMemberships(): void {
    for (const meta of this.store.listChannels()) {
      if (meta.id === DEFAULT_CHANNEL) continue
      const creator = this.identity.byHandle(meta.createdBy)
      if (creator === undefined || creator.kind === 'human') continue
      try {
        this.memberships.join(creator, meta.id)
      } catch (error) {
        this.logger.warn(`dsh-channels: legacy creator membership seed failed for #${meta.id}: ${String(error)}`)
      }
    }
  }

  private writeFrame(client: SseClientState, event: string, data: unknown): boolean {
    if (client.closed) return false
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      return true
    } catch {
      this.dropClient(client, false)
      return false
    }
  }

  private heartbeatClients(): void {
    if (this.disposed) return
    const frame = `: hb ${Date.now()}\n\n`
    for (const client of [...this.clients]) {
      if (client.closed) {
        this.dropClient(client, false)
        continue
      }
      try {
        client.res.write(frame)
      } catch {
        this.dropClient(client, false)
      }
    }
  }

  private dropClient(client: SseClientState, endResponse: boolean): void {
    if (client.closed) return
    client.closed = true
    this.clients.delete(client)
    if (!endResponse) return
    try {
      if (!client.res.writableEnded) client.res.end()
    } catch {
      /* already dead */
    }
  }

  private broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const messageChannel = event === 'message' ? messageChannelOf(data) : undefined
    for (const client of [...this.clients]) {
      if (client.closed) {
        this.dropClient(client, false)
        continue
      }
      if (messageChannel !== undefined && !this.canReceiveChannel(client, messageChannel)) continue
      try {
        client.res.write(frame)
      } catch {
        this.dropClient(client, false)
      }
    }
  }

  /** Number of live SSE clients (diagnostics/tests). */
  sseClientCount(): number {
    return this.clients.size
  }

  // -- helpers --------------------------------------------------------------

  private buildReplyRef(channel: string, replyTo: unknown): ReplyRef {
    const targetId = typeof replyTo === 'string' ? replyTo : ''
    if (targetId.length === 0) throw new HostError(400, 'invalid_request', 'replyTo must be a message id')
    const target = this.store.findMessage(channel, targetId)
    if (target === undefined) throw new HostError(404, 'not_found', `message "${targetId}" does not exist in #${channel}`)
    return {
      id: target.id,
      seq: target.seq,
      // Handles are stable; wake resolution matches the replied author by handle.
      authorName: target.author.handle,
      excerpt: target.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    }
  }

  private emptyWake(): WakeReport {
    return { enabled: this.config.wake, considered: 0, delivered: [], skipped: [] }
  }

  // -- tools registration helper -------------------------------------------

  /** Services used by installTools/installHttp; kept here so installers stay thin. */
  toolsService(): ToolsLike | undefined {
    const tools = service(this.ctx, 'tools')
    return tools === undefined ? undefined : (tools as ToolsLike)
  }
}

// ---------------------------------------------------------------------------
// applyHub — the plugin entry point
// ---------------------------------------------------------------------------

/**
 * Wire the hub into a Cordis context: acquire the writer lock, load storage,
 * register the HTTP API and the native tools, and dispose everything through
 * `ctx.effect`.
 *
 * Never throws for ordinary startup failures: a read-only second instance is a
 * supported state, and a broken data directory is logged rather than failing
 * the whole web host.
 */
export function applyHub(ctx: unknown, config?: unknown): ChannelsHub | undefined {
  const root = ctx as CtxLike
  let hub: ChannelsHub | undefined
  try {
    const normalized = normalizeConfig(config, resolveDataDir)
    hub = new ChannelsHub(root, normalized)
    hub.start()
  } catch (error) {
    root.logger.warn(`dsh-channels: failed to start: ${errMessage(error)}`)
    try {
      hub?.dispose()
    } catch {
      /* ignore */
    }
    return undefined
  }

  const started = hub
  try {
    // Registered first so it unwinds last (Cordis runs disposers in reverse).
    root.effect(
      () => () => {
        started.dispose()
      },
      'dsh-channels: dispose hub',
    )
    installHttp(root, started)
    installTools(root, started)
    installCommands(root, started)
    // After installTools: hidden-session masking denies channel_* names, which
    // the tool registry only knows once they are registered.
    started.installSessionPrefs()
    // Explicit disposal scope for the agent listeners + tool masks.
    root.effect(
      () => () => {
        started.endPrefsWatch()
      },
      'dsh-channels: session prefs',
    )
  } catch (error) {
    root.logger.warn(`dsh-channels: failed to install routes/tools: ${errMessage(error)}`)
    try {
      started.dispose()
    } catch {
      /* ignore */
    }
    return undefined
  }

  root.logger.info(
    `dsh-channels: ${started.writer ? 'writer' : 'read-only'} hub ready (dataDir=${started.config.dataDir}, tools=channel_*, api=${API_BASE})`,
  )
  return started
}
