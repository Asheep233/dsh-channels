/**
 * dsh-channels native tools (SPEC.md §6).
 *
 * Registered globally through `ctx.tools.register(...)` as hand-written plain
 * objects: the host profile cannot resolve `@deepseek-ai/dsh-tools`, so no
 * `defineTool` import is possible and none is needed — the registry only
 * validates the declared `output` schema at registration time.
 *
 * Identity comes from `exec.agent` (the session driving the call). Every tool
 * catches its own expected failures and returns readable `{ ok:false, error }`
 * JSON instead of throwing and failing the turn.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { humanSize, MAX_ATTACHMENTS, MAX_PAGE, SEARCH_LIMIT } from '../contract.js'
import type { ChannelMessage, Participant } from '../contract.js'

import type { ChannelsHub } from './hub.js'
import { HostError, errMessage, service } from './util.js'
import type { AgentLike, CtxLike, ToolsLike } from './util.js'

/** Minimal execution-context shape (`exec.agent` drives tool identity). */
interface ToolExecLike {
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

type ToolArgs = Record<string, unknown>

/** One hand-written tool definition accepted by `ctx.tools.register`. */
interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Ensure the value crossing the tool boundary is lossless JSON. */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Readable failure payload; also used by every tool's catch path. */
function failure(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (error instanceof HostError) return { ok: false, error: { code: error.code, message: error.message } }
  return { ok: false, error: { code: 'internal', message: errMessage(error) } }
}

function asArgs(args: unknown): ToolArgs {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as ToolArgs) : {}
}

function argString(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireString(args: ToolArgs, key: string): string {
  const value = argString(args, key)
  if (value === undefined) throw new HostError(400, 'invalid_request', `${key} is required`)
  return value
}

function argNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  return undefined
}

function argStringArray(args: ToolArgs, key: string): unknown[] | undefined {
  const value = args[key]
  return Array.isArray(value) ? value : undefined
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** Resolve (or lazily create) the participant behind the executing agent. */
/** Compact policy fields for tool responses. */
function summariseChannelPolicy(channel: {
  readonly id: string
  readonly admins: readonly string[]
  readonly muted: readonly string[]
  readonly mutedAll: boolean
  readonly maxChars: number | null
  readonly ratePerMinute: number | null
}): Record<string, unknown> {
  return {
    channel: channel.id,
    admins: channel.admins,
    muted: channel.muted,
    mutedAll: channel.mutedAll,
    maxChars: channel.maxChars,
    ratePerMinute: channel.ratePerMinute,
  }
}

async function participantFor(hub: ChannelsHub, exec: ToolExecLike): Promise<Participant> {
  const agent = exec.agent
  if (agent === undefined || typeof agent.id !== 'string' || agent.id.length === 0) {
    throw new HostError(400, 'no_agent', 'channel tools must run inside a DSH agent session')
  }
  return hub.identity.ensureSessionParticipant(agent.id)
}

function sessionFor(exec: ToolExecLike): string {
  const agent = exec.agent
  if (agent === undefined || typeof agent.id !== 'string' || agent.id.length === 0) {
    throw new HostError(400, 'no_agent', 'channel tools must run inside a DSH agent session')
  }
  return agent.id
}

function summariseMessage(message: ChannelMessage): Record<string, unknown> {
  return {
    id: message.id,
    channel: message.channel,
    seq: message.seq,
    ts: message.ts,
    author: message.author,
    text: message.text,
    mentions: message.mentions,
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    kind: message.kind,
    ...(message.attachments !== undefined && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const OBJECT = 'object' as const

/** Empty argument object schema. */
const NO_ARGS: Record<string, unknown> = { type: OBJECT, properties: {}, additionalProperties: false }

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: OBJECT,
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function buildDefinitions(hub: ChannelsHub): ToolDefinitionLike[] {
  /** Wrap one tool body: JSON-safe success, readable failure, never throws. */
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (args: ToolArgs, exec: ToolExecLike) => Promise<Record<string, unknown>>,
  ): ToolDefinitionLike => ({
    name,
    description,
    parameters,
    output: {
      schema: { type: OBJECT },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (rawArgs: unknown, exec: ToolExecLike) => {
      try {
        const value = await run(asArgs(rawArgs), exec)
        return jsonClone({ ok: true, ...value })
      } catch (error) {
        return failure(error)
      }
    },
  })

  return [
    tool(
      'channel_list',
      'List dsh-channels channels with the last sequence number, unread count, and membership (joined/memberCount) for the calling agent. Channels with joined:false are visible but cannot be read, written or woken for until you call channel_join. Start here to discover channels before reading history.',
      NO_ARGS,
      async (_args, exec) => {
        const participant = await participantFor(hub, exec)
        const channels = hub.listChannels(participant)
        return {
          channels: channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            ...(channel.topic !== undefined ? { topic: channel.topic } : {}),
            ...(channel.category !== undefined ? { category: channel.category } : {}),
            createdAt: channel.createdAt,
            createdBy: channel.createdBy,
            lastSeq: channel.lastSeq,
            unread: channel.unread,
            joined: channel.joined,
            memberCount: channel.memberCount,
            admins: channel.admins,
            muted: channel.muted,
            mutedAll: channel.mutedAll,
            maxChars: channel.maxChars,
            ratePerMinute: channel.ratePerMinute,
            canManage: channel.canManage,
            pins: channel.pins,
            ...(channel.announcementId !== undefined ? { announcementId: channel.announcementId } : {}),
          })),
        }
      },
    ),

    tool(
      'channel_history',
      'Read messages from one channel in ascending seq order. Use beforeSeq to page older messages (e.g. beforeSeq=lowest seq seen) and limit (max 100). Reading marks the channel as read for the calling agent. Sub-channels require channel_join first (membership; humans are exempt): a non-member gets an error telling it to join.',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id, e.g. "general"' },
          beforeSeq: { type: 'integer', description: 'Return messages with seq < beforeSeq (paging backwards)' },
          afterSeq: { type: 'integer', description: 'Return messages with seq > afterSeq (resume)' },
          limit: { type: 'integer', description: `Page size, 1-${MAX_PAGE} (default 50)` },
        },
        ['channel'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const page = hub.history(participant, {
          channel: requireString(args, 'channel'),
          ...(argNumber(args, 'beforeSeq') !== undefined ? { beforeSeq: argNumber(args, 'beforeSeq') as number } : {}),
          ...(argNumber(args, 'afterSeq') !== undefined ? { afterSeq: argNumber(args, 'afterSeq') as number } : {}),
          ...(argNumber(args, 'limit') !== undefined ? { limit: argNumber(args, 'limit') as number } : {}),
        })
        return {
          channel: page.channel,
          messages: page.messages.map(summariseMessage),
          hasMore: page.hasMore,
          count: page.messages.length,
        }
      },
    ),

    tool(
      'channel_search',
      'Full-text search across channel history. Case-insensitive; every whitespace-separated word must match the message text, author handle or display name. Only channels you have joined are searched (humans see all); naming a channel you are not a member of returns an error telling you to channel_join. Archived channels are skipped unless `channel` names one. Returns the newest hits first, each with a short snippet around the match and the full message; use channel_history for surrounding context.',
      objectSchema(
        {
          query: { type: 'string', description: 'Words to search for (space-separated; all must match)' },
          channel: { type: 'string', description: 'Optional channel id to search only that channel' },
          limit: { type: 'integer', description: `Max hits, 1-${SEARCH_LIMIT} (default ${SEARCH_LIMIT})` },
          beforeSeq: { type: 'integer', description: 'Only messages with seq < beforeSeq (paging older hits)' },
        },
        ['query'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const result = hub.search(participant, {
          query: requireString(args, 'query'),
          ...(argString(args, 'channel') !== undefined ? { channel: argString(args, 'channel') as string } : {}),
          ...(argNumber(args, 'limit') !== undefined ? { limit: argNumber(args, 'limit') as number } : {}),
          ...(argNumber(args, 'beforeSeq') !== undefined ? { beforeSeq: argNumber(args, 'beforeSeq') as number } : {}),
        })
        return {
          query: result.query,
          hits: result.hits.map((hit) => ({
            channel: hit.channel,
            snippet: hit.snippet,
            message: summariseMessage(hit.message),
          })),
          hasMore: result.hasMore,
          count: result.hits.length,
        }
      },
    ),

    tool(
      'channel_send',
      'Send a message to a channel. Text is plain text; `@handle` mentions (including `@all` for every bound DSH agent) are parsed server-side and wake the mentioned sessions. Messages are append-only: no edit or delete. Limit: 30 messages/minute per participant and 8KB text. Attach files by uploading them first (channel_upload or POST /upload) and passing the returned attachment ids in `attachments`; text may then be empty. Sub-channels require channel_join first (membership; humans are exempt).',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id, e.g. "general"' },
          text: { type: 'string', description: 'Message body (plain text, max 8KB); optional when attachments are present' },
          replyTo: { type: 'string', description: 'Message id to quote-reply; the replied author is notified' },
          mentions: { type: 'array', items: { type: 'string' }, description: 'Additional handles to mention (text @handles are merged in)' },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: `Attachment ids from channel_upload / POST /upload (max ${MAX_ATTACHMENTS}); they must belong to the caller`,
          },
          clientMsgId: { type: 'string', description: 'Optional idempotency key: retrying with the same id within 10 minutes returns the original message' },
        },
        ['channel'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const outcome = await hub.sendMessage(participant, {
          channel: requireString(args, 'channel'),
          text: argString(args, 'text') ?? '',
          replyTo: argString(args, 'replyTo'),
          mentions: argStringArray(args, 'mentions'),
          attachments: argStringArray(args, 'attachments'),
          clientMsgId: argString(args, 'clientMsgId'),
        })
        return { message: summariseMessage(outcome.message), duplicate: outcome.duplicate, wake: outcome.wake }
      },
    ),

    tool(
      'channel_upload',
      'Upload a local file as a channel attachment and return its id, url and metadata. The host process reads the bytes, so the path must be readable on this machine (absolute paths recommended). Limits: 25MB per file; send the returned id via channel_send `attachments`. Content is immutable once uploaded.',
      objectSchema(
        {
          path: { type: 'string', description: 'Path of a local file to upload (absolute recommended)' },
          name: { type: 'string', description: 'Display filename (defaults to the file basename)' },
          mime: { type: 'string', description: 'Optional mime type; guessed from the extension when omitted' },
        },
        ['path'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const path = requireString(args, 'path')
        let size: number
        try {
          const stat = statSync(path)
          if (!stat.isFile()) throw new HostError(400, 'invalid_path', `"${path}" is not a regular file`)
          size = stat.size
        } catch (error) {
          if (error instanceof HostError) throw error
          throw new HostError(400, 'invalid_path', `cannot read "${path}": ${errMessage(error)}`)
        }
        if (size === 0) throw new HostError(400, 'invalid_request', `"${path}" is empty`)
        const maxBytes = hub.config.maxAttachmentBytes
        if (size > maxBytes) {
          throw new HostError(413, 'payload_too_large', `file is ${humanSize(size)}; the limit is ${humanSize(maxBytes)}`)
        }
        const bytes = readFileSync(path)
        const attachment = await hub.uploadAttachment(participant, {
          name: argString(args, 'name') ?? basename(path),
          ...(argString(args, 'mime') !== undefined ? { mime: argString(args, 'mime') as string } : {}),
          bytes,
        })
        return { attachment }
      },
    ),

    tool(
      'channel_create',
      'Create a new public channel. The id is a slug (/^[a-z0-9][a-z0-9-]{0,31}$/) and must be unique; the name defaults to the id.',
      objectSchema(
        {
          id: { type: 'string', description: 'Channel slug, e.g. "build-alerts"' },
          name: { type: 'string', description: 'Display name (defaults to id)' },
          topic: { type: 'string', description: 'Optional topic line' },
          category: { type: 'string', description: 'Optional grouping label' },
        },
        ['id'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const channel = await hub.createChannel(participant, {
          id: requireString(args, 'id'),
          name: argString(args, 'name'),
          topic: argString(args, 'topic'),
          category: argString(args, 'category'),
        })
        return { channel }
      },
    ),

    tool(
      'channel_archive',
      'Archive or restore a channel. Archived channels are hidden from the normal list and reject new messages, but their full history is retained.',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id' },
          archived: { type: 'boolean', description: 'true to archive (default), false to restore' },
        },
        ['channel'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const archived = args.archived === false ? false : true
        const channel = await hub.archiveChannel(participant, requireString(args, 'channel'), archived)
        return { channel }
      },
    ),

    tool(
      'channel_members',
      'List the members of one channel (defaults to #general) with presence status plus channel-local flags: admin:true for channel admins, muted:true for members muted in this channel. Humans are exempt from membership and may see the roster of any channel.',
      objectSchema({ channel: { type: 'string', description: 'Channel id (defaults to #general)' } }),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        return { participants: hub.members(argString(args, 'channel') ?? 'general', participant) }
      },
    ),

    tool(
      'channel_whoami',
      'Show the dsh-channels identity bound to the current DSH session (auto identity unless the session claimed a handle).',
      NO_ARGS,
      async (_args, exec) => {
        const participant = await participantFor(hub, exec)
        return { participant: hub.identity.view(participant) }
      },
    ),

    tool(
      'channel_claim',
      'Claim a stable handle (2-24 chars: lowercase letters, digits, _ or -) for the current DSH session so humans and other agents can @mention it. A handle can be bound to only one live session; pass force:true to take it over. Returns the participant and, when newly created, its token.',
      objectSchema(
        {
          handle: { type: 'string', description: 'Handle to claim, e.g. "build-bot"' },
          displayName: { type: 'string', description: 'Optional display name' },
          force: { type: 'boolean', description: 'Take the handle over from another live session' },
        },
        ['handle'],
      ),
      async (args, exec) => {
        const sessionId = sessionFor(exec)
        const result = await hub.claim({
          handle: requireString(args, 'handle'),
          displayName: argString(args, 'displayName'),
          force: args.force === true,
          sessionId,
        })
        return {
          participant: hub.identity.view(result.participant),
          created: result.created,
          ...(result.token !== undefined ? { token: result.token } : {}),
        }
      },
    ),

    tool(
      'channel_login',
      'Restore an existing (claimed or external) identity with its token and bind it to the current DSH session.',
      objectSchema(
        {
          handle: { type: 'string', description: 'Handle to log in as' },
          token: { type: 'string', description: 'Bearer token minted when the handle was claimed/registered' },
        },
        ['handle'],
      ),
      async (args, exec) => {
        const sessionId = sessionFor(exec)
        const participant = await hub.login({
          handle: requireString(args, 'handle'),
          token: argString(args, 'token'),
          sessionId,
        })
        return { participant: hub.identity.view(participant) }
      },
    ),

    tool(
      'channel_release',
      'Release the identity currently bound to the current DSH session. Existing messages keep their author snapshot.',
      NO_ARGS,
      async (_args, exec) => {
        const sessionId = sessionFor(exec)
        const released = await hub.release(sessionId)
        return {
          released: released !== undefined,
          ...(released !== undefined ? { participant: hub.identity.view(released) } : {}),
        }
      },
    ),

    tool(
      'channel_pin',
      'Pin a message in a channel (visible in the pinned drawer).',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id' },
          messageId: { type: 'string', description: 'Message id, e.g. "general-000012"' },
        },
        ['channel', 'messageId'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const channel = await hub.pin(participant, {
          channel: requireString(args, 'channel'),
          messageId: requireString(args, 'messageId'),
        })
        return { channel }
      },
    ),

    tool(
      'channel_unpin',
      'Remove a pin from a channel.',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id' },
          messageId: { type: 'string', description: 'Message id to unpin' },
        },
        ['channel', 'messageId'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const channel = await hub.unpin(participant, {
          channel: requireString(args, 'channel'),
          messageId: requireString(args, 'messageId'),
        })
        return { channel }
      },
    ),

    tool(
      'channel_announce',
      'Post a channel announcement: appends a kind:"announcement" message and makes it the channel announcement. A participant may announce once per 10 minutes.',
      objectSchema(
        {
          channel: { type: 'string', description: 'Channel id' },
          text: { type: 'string', description: 'Announcement text (plain text, max 8KB)' },
        },
        ['channel', 'text'],
      ),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const outcome = await hub.announce(participant, {
          channel: requireString(args, 'channel'),
          text: requireString(args, 'text'),
        })
        return { message: summariseMessage(outcome.message), channel: outcome.channel, wake: outcome.wake }
      },
    ),

    tool(
      'channel_join',
      'Join a sub-channel so you can read/write it and be woken by @mentions there. Every participant is always a member of #general; other channels are opt-in. After joining, channel_history/channel_send/channel_search work for that channel.',
      objectSchema({ channel: { type: 'string', description: 'Channel id to join, e.g. "lobby"' } }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const membership = hub.joinChannel(participant, requireString(args, 'channel'))
        return { ...membership }
      },
    ),

    tool(
      'channel_leave',
      'Leave a sub-channel: stop seeing its messages and stop being woken by mentions there. #general cannot be left.',
      objectSchema({ channel: { type: 'string', description: 'Channel id to leave' } }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const membership = hub.leaveChannel(participant, requireString(args, 'channel'))
        return { ...membership }
      },
    ),

    tool(
      'channel_mute',
      'Mute a channel member (handle) or every non-admin member (all:true) in one channel. Allowed for the human operator and channel admins; admins cannot mute another admin (only the human can), and humans cannot be muted. Muting affects sending only: the target can still read history and be woken by @mentions. Idempotent.',
      objectSchema({
        channel: { type: 'string', description: 'Channel id' },
        handle: { type: 'string', description: 'Agent handle to mute (required unless all:true)' },
        all: { type: 'boolean', description: 'true = mute all non-admin members (全员禁言)' },
      }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const view = hub.setChannelMute(participant, requireString(args, 'channel'), {
          ...(argString(args, 'handle') !== undefined ? { handle: argString(args, 'handle') } : {}),
          ...(args.all !== undefined ? { all: args.all } : {}),
          muted: true,
        })
        return summariseChannelPolicy(view)
      },
    ),

    tool(
      'channel_unmute',
      'Lift a per-member mute or the all-members mute (全员禁言) in one channel. Allowed for the human operator and channel admins. Idempotent.',
      objectSchema({
        channel: { type: 'string', description: 'Channel id' },
        handle: { type: 'string', description: 'Agent handle to unmute (required unless all:true)' },
        all: { type: 'boolean', description: 'true = lift the all-members mute' },
      }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const view = hub.setChannelMute(participant, requireString(args, 'channel'), {
          ...(argString(args, 'handle') !== undefined ? { handle: argString(args, 'handle') } : {}),
          ...(args.all !== undefined ? { all: args.all } : {}),
          muted: false,
        })
        return summariseChannelPolicy(view)
      },
    ),

    tool(
      'channel_set_limits',
      'Set per-channel posting limits (allowed for the human operator and channel admins): maxChars = per-message character cap (1-8192), ratePerMinute = per-member messages per rolling minute (1-600). Pass 0 to reset a field to the server default. Only agents are limited; the human operator is exempt. Admins can still send while mutedAll is on.',
      objectSchema({
        channel: { type: 'string', description: 'Channel id' },
        maxChars: { type: 'integer', description: 'Max characters per message (1-8192); 0 resets to default' },
        ratePerMinute: { type: 'integer', description: 'Max messages per member per minute (1-600); 0 resets to default' },
      }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const maxChars = argNumber(args, 'maxChars')
        const ratePerMinute = argNumber(args, 'ratePerMinute')
        if (maxChars === undefined && ratePerMinute === undefined) {
          throw new HostError(400, 'invalid_request', 'maxChars and/or ratePerMinute is required')
        }
        const view = hub.setChannelLimits(participant, requireString(args, 'channel'), {
          ...(maxChars !== undefined ? { maxChars: maxChars === 0 ? null : maxChars } : {}),
          ...(ratePerMinute !== undefined ? { ratePerMinute: ratePerMinute === 0 ? null : ratePerMinute } : {}),
        })
        return summariseChannelPolicy(view)
      },
    ),

    tool(
      'channel_pins',
      'List pinned messages of a channel in pin order (sub-channels require channel_join first).',
      objectSchema({ channel: { type: 'string', description: 'Channel id' } }, ['channel']),
      async (args, exec) => {
        const participant = await participantFor(hub, exec)
        const result = hub.pins(participant, requireString(args, 'channel'))
        return {
          channel: result.channel,
          messages: result.messages.map(summariseMessage),
          pins: result.pins,
        }
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Register every `channel_*` tool globally. A duplicate registration (e.g. a
 * double-mounted plugin) is logged and skipped rather than failing activation.
 */
export function installTools(ctx: CtxLike, hub: ChannelsHub): void {
  const tools = (service(ctx, 'tools') ?? hub.toolsService()) as ToolsLike | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger.warn('dsh-channels: tools service unavailable; channel_* tools not registered')
    return
  }

  ctx.effect(
    () => {
      const disposers: Array<() => void> = []
      for (const definition of buildDefinitions(hub)) {
        try {
          disposers.push(tools.register(definition))
        } catch (error) {
          ctx.logger.warn(`dsh-channels: failed to register tool "${definition.name}": ${errMessage(error)}`)
        }
      }
      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            /* already disposed */
          }
        }
      }
    },
    'dsh-channels: tools',
  )
}

/** Exported for tests/doc generation. */
export { buildDefinitions as buildChannelToolDefinitions }
