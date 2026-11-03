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

import type { ChannelPolicy } from '../contract.js'

import { MAX_CHANNEL_RATE_PER_MINUTE, MAX_CHANNEL_TEXT_CHARS } from '../contract.js'
import { errMessage, readJsonFile, writeJsonAtomic } from './util.js'
import type { LoggerLike } from './util.js'

export const CHANNEL_POLICIES_FILE = 'channel-policies.json'
export const CHANNEL_POLICIES_VERSION = 1

interface ChannelPoliciesFile {
  readonly version: number
  readonly channels: Record<string, ChannelPolicy>
}

export interface ChannelPolicyOptions {
  readonly dataDir: string
  readonly readonly: boolean
  readonly logger: LoggerLike
}

export function emptyChannelPolicy(): ChannelPolicy {
  return { admins: [], muted: [], mutedAll: false, maxChars: null, ratePerMinute: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || out.includes(id)) continue
    out.push(id)
  }
  return out
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return null
  const rounded = Math.round(parsed)
  if (rounded < min || rounded > max) return null
  return rounded
}

/** Tolerant normalization for on-disk and API-supplied values. */
export function normalizeChannelPolicy(raw: unknown): ChannelPolicy {
  if (!isRecord(raw)) return emptyChannelPolicy()
  return {
    admins: stringIds(raw.admins),
    muted: stringIds(raw.muted),
    mutedAll: raw.mutedAll === true,
    maxChars: intOrNull(raw.maxChars, 1, MAX_CHANNEL_TEXT_CHARS),
    ratePerMinute: intOrNull(raw.ratePerMinute, 1, MAX_CHANNEL_RATE_PER_MINUTE),
  }
}

function samePolicy(left: ChannelPolicy, right: ChannelPolicy): boolean {
  return (
    left.mutedAll === right.mutedAll &&
    left.maxChars === right.maxChars &&
    left.ratePerMinute === right.ratePerMinute &&
    left.admins.length === right.admins.length &&
    left.admins.every((id, index) => id === right.admins[index]) &&
    left.muted.length === right.muted.length &&
    left.muted.every((id, index) => id === right.muted[index])
  )
}

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
export class ChannelPolicyService {
  readonly file: string
  readonly readonlyMode: boolean

  private readonly logger: LoggerLike
  private readonly policies = new Map<string, ChannelPolicy>()
  private loaded = false

  constructor(options: ChannelPolicyOptions) {
    this.file = `${options.dataDir.replace(/[\\/]+$/, '')}/${CHANNEL_POLICIES_FILE}`
    this.readonlyMode = options.readonly
    this.logger = options.logger
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readJsonFile<unknown>(this.file)
    if (!isRecord(raw)) return
    if (raw.version !== undefined && raw.version !== CHANNEL_POLICIES_VERSION) {
      this.logger.warn(`dsh-channels: ignoring channel-policies.json with unsupported version ${String(raw.version)}`)
      return
    }
    if (!isRecord(raw.channels)) return
    for (const [channel, value] of Object.entries(raw.channels)) {
      const policy = normalizeChannelPolicy(value)
      if (isDefault(policy)) continue
      this.policies.set(channel, policy)
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  private persist(): void {
    if (this.readonlyMode) return
    const channels: Record<string, ChannelPolicy> = {}
    for (const [channel, policy] of [...this.policies.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (isDefault(policy)) continue
      channels[channel] = policy
    }
    const body: ChannelPoliciesFile = { version: CHANNEL_POLICIES_VERSION, channels }
    writeJsonAtomic(this.file, body)
  }

  /** Policy for one channel (empty defaults when none stored). */
  get(channel: string): ChannelPolicy {
    this.ensureLoaded()
    return this.policies.get(channel) ?? emptyChannelPolicy()
  }

  /** Replace one channel's policy; returns the normalized policy. */
  set(channel: string, raw: unknown): ChannelPolicy {
    this.ensureLoaded()
    const policy = normalizeChannelPolicy(raw)
    const current = this.get(channel)
    if (samePolicy(current, policy)) return current
    if (isDefault(policy)) this.policies.delete(channel)
    else this.policies.set(channel, policy)
    this.persist()
    return policy
  }

  /** Merge a partial patch into one channel's policy. */
  update(channel: string, patch: Partial<ChannelPolicy>): ChannelPolicy {
    const current = this.get(channel)
    const merged: ChannelPolicy = normalizeChannelPolicy({ ...current, ...patch })
    return this.set(channel, merged)
  }

  /** Drop policy for a channel that no longer exists. */
  removeChannel(channel: string): boolean {
    this.ensureLoaded()
    return this.policies.delete(channel)
  }

  /** Startup cleanup: drop policies for channels that no longer exist. */
  pruneChannels(keepChannelIds: ReadonlySet<string>): number {
    if (this.readonlyMode) return 0
    this.ensureLoaded()
    let dropped = 0
    for (const channel of [...this.policies.keys()]) {
      if (keepChannelIds.has(channel)) continue
      this.policies.delete(channel)
      dropped += 1
    }
    if (dropped > 0) this.persist()
    return dropped
  }

  /** Startup cleanup: drop admin/muted ids for participants that no longer exist. */
  pruneParticipants(knownIds: ReadonlySet<string>): number {
    if (this.readonlyMode) return 0
    this.ensureLoaded()
    let changed = 0
    for (const [channel, policy] of [...this.policies.entries()]) {
      const admins = policy.admins.filter((id) => knownIds.has(id))
      const muted = policy.muted.filter((id) => knownIds.has(id))
      if (admins.length === policy.admins.length && muted.length === policy.muted.length) continue
      this.policies.set(channel, normalizeChannelPolicy({ ...policy, admins, muted }))
      changed += 1
    }
    if (changed > 0) this.persist()
    return changed
  }

  /** Remove a participant from every admins/muted list (participant deleted). */
  removeParticipant(participantId: string): number {
    if (this.readonlyMode) return 0
    this.ensureLoaded()
    let changed = 0
    for (const [channel, policy] of [...this.policies.entries()]) {
      const admins = policy.admins.filter((id) => id !== participantId)
      const muted = policy.muted.filter((id) => id !== participantId)
      if (admins.length === policy.admins.length && muted.length === policy.muted.length) continue
      this.policies.set(channel, normalizeChannelPolicy({ ...policy, admins, muted }))
      changed += 1
    }
    if (changed > 0) this.persist()
    return changed
  }

  /** Remove one participant from one channel's admin/muted lists (on leave). */
  removeMember(channel: string, participantId: string): ChannelPolicy {
    const policy = this.get(channel)
    if (!policy.admins.includes(participantId) && !policy.muted.includes(participantId)) return policy
    return this.set(channel, {
      ...policy,
      admins: policy.admins.filter((id) => id !== participantId),
      muted: policy.muted.filter((id) => id !== participantId),
    })
  }
}

function isDefault(policy: ChannelPolicy): boolean {
  return (
    policy.admins.length === 0 &&
    policy.muted.length === 0 &&
    !policy.mutedAll &&
    policy.maxChars === null &&
    policy.ratePerMinute === null
  )
}
