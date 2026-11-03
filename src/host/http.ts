/**
 * dsh-channels HTTP/SSE API (SPEC.md §5), mounted under `/channels/api`.
 *
 * One `prefix` route owns the whole namespace: it knows no harness concepts,
 * bypasses the `/api/*` browser-trust fence (plugin routes are not fenced), and
 * owns the full response lifecycle — including long-lived SSE responses.
 *
 * Auth: `Authorization: Bearer <token>` (or `?token=` for EventSource), except
 * `/register` and `/health`. Same-origin loopback browser requests may omit the
 * token for read-only endpoints (v1 trust model); write endpoints still need an
 * identity.
 *
 * Errors are always `{ error: { code, message } }` with the status codes from
 * the spec: 400 invalid, 401 unauthorized, 404 not_found, 409 conflict,
 * 429 rate_limited, 503 readonly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { API_BASE, isInlineImageMime } from '../contract.js'
import type { HarnessName, Participant, ParticipantKind } from '../contract.js'

import type { ChannelsHub } from './hub.js'
import { normalizePrefsPatch, normalizeSessionId } from './session-prefs.js'
import { HostError, errMessage, service } from './util.js'
import type { CtxLike, WebServerLike } from './util.js'

interface Caller {
  readonly participant: Participant | null
  readonly trusted: boolean
}

const MAX_BODY_BYTES = 128 * 1024


function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  return undefined
}

function parseSeq(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

function parseHarness(value: unknown): HarnessName | undefined {
  if (value === 'dsh' || value === 'claude-code' || value === 'codex' || value === 'opencode' || value === 'other') return value
  return undefined
}

function parseKind(value: unknown): ParticipantKind {
  if (value === 'human' || value === 'dsh-agent' || value === 'external') return value
  throw new HostError(400, 'invalid_request', 'kind must be one of human | dsh-agent | external')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      /* socket already gone */
    }
    return
  }
  if (error instanceof HostError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  sendJson(res, 500, { error: { code: 'internal', message: errMessage(error) } })
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim()
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.') ||
    address === '::ffff:::1'
  )
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function resolveCaller(hub: ChannelsHub, req: IncomingMessage, url: URL): Caller {
  const token = bearerToken(req) ?? str(url.searchParams.get('token'))
  if (token !== undefined) {
    const participant = hub.identity.authenticate(token)
    if (participant === undefined) throw new HostError(401, 'unauthorized', 'invalid bearer token')
    hub.noteActivity(participant)
    return { participant, trusted: false }
  }
  if (isLoopbackRequest(req) && sameOrigin(req)) return { participant: null, trusted: true }
  throw new HostError(401, 'unauthorized', 'missing bearer token')
}

function requireCaller(caller: Caller): Participant {
  if (caller.participant === null) {
    throw new HostError(401, 'unauthorized', 'this endpoint requires a bearer token identity')
  }
  return caller.participant
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new HostError(400, 'invalid_request', `request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text) as unknown)
      } catch {
        reject(new HostError(400, 'invalid_request', 'request body must be JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HostError(400, 'invalid_request', 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/**
 * Read a raw (non-JSON) request body up to `maxBytes` — used by POST /upload.
 * Over-cap payloads fail with 413 while the rest of the body is drained.
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        settle(() => reject(new HostError(413, 'payload_too_large', `upload exceeds ${maxBytes} bytes`)))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (error) => settle(() => reject(error)))
  })
}

/** RFC 6266/5987 Content-Disposition: ASCII fallback plus a UTF-8 filename. */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'file'
  let encoded = ''
  for (const byte of Buffer.from(name, 'utf8')) {
    const char = String.fromCharCode(byte)
    encoded += /[A-Za-z0-9._~-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

async function handle(hub: ChannelsHub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname
  if (!pathname.startsWith(API_BASE)) {
    throw new HostError(404, 'not_found', `unknown channel API route "${pathname}"`)
  }

  let sub = pathname.slice(API_BASE.length)
  if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1)
  if (sub.length === 0 || sub === '/') sub = '/health'

  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'OPTIONS') {
    res.statusCode = 204
    res.setHeader('allow', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.end()
    return
  }

  const maxBodyBytes = hub.config.maxBodyBytes > 0 ? hub.config.maxBodyBytes : MAX_BODY_BYTES
  const bodyObject = async (): Promise<Record<string, unknown>> => bodyRecord(await readJsonBody(req, maxBodyBytes))

  // Attachment bytes are served by the same route family: /attachments/<id>.
  if (method === 'GET' && sub.startsWith('/attachments/')) {
    await handleAttachmentGet(hub, req, res, url, sub.slice('/attachments/'.length))
    return
  }

  switch (`${method} ${sub}`) {
    // -- public -------------------------------------------------------------
    case 'GET /health': {
      sendJson(res, 200, hub.health())
      return
    }
    case 'POST /register': {
      const body = await bodyObject()
      const result = await hub.register({
        kind: parseKind(body.kind),
        handle: str(body.handle),
        displayName: str(body.displayName),
        harness: parseHarness(body.harness),
        token: str(body.token),
        sessionId: str(body.sessionId),
      })
      sendJson(res, 200, {
        participantId: result.participant.id,
        handle: result.participant.handle,
        token: result.token,
        participant: hub.identity.view(result.participant),
      })
      return
    }

    // -- identity -----------------------------------------------------------
    case 'POST /login': {
      const body = await bodyObject()
      const participant = await hub.login({
        handle: str(body.handle) ?? '',
        token: str(body.token),
        ...(trimmedOrUndefined(body.sessionId) !== undefined ? { sessionId: trimmedOrUndefined(body.sessionId) as string } : {}),
      })
      sendJson(res, 200, { participant: hub.identity.view(participant) })
      return
    }
    case 'POST /heartbeat': {
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      sendJson(res, 200, { ok: true, participant: await hub.heartbeat(participant) })
      return
    }
    case 'GET /whoami': {
      const caller = resolveCaller(hub, req, url)
      sendJson(res, 200, { participant: hub.whoami(caller.participant) })
      return
    }
    case 'POST /claim': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const handle = str(body.handle)
      if (handle === undefined) throw new HostError(400, 'invalid_request', 'handle is required')
      const requestedSession = trimmedOrUndefined(body.sessionId)
      const callerSession =
        caller.participant !== null && caller.participant.binding !== undefined ? caller.participant.binding.sessionId : undefined
      const sessionId = requestedSession ?? callerSession
      if (sessionId !== undefined) {
        const result = await hub.claim({
          handle,
          displayName: str(body.displayName),
          force: bool(body.force) === true,
          sessionId,
        })
        sendJson(res, 200, {
          participant: hub.identity.view(result.participant),
          created: result.created,
          ...(result.token !== undefined ? { token: result.token } : {}),
        })
        return
      }
      // No session to bind: adopt the handle for the authenticated participant.
      const participant = requireCaller(caller)
      const adopted = await hub.identity.adoptHandle({
        participantId: participant.id,
        handle,
        displayName: str(body.displayName),
        force: bool(body.force) === true,
      })
      sendJson(res, 200, { participant: hub.identity.view(adopted), created: false })
      return
    }
    case 'POST /release': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const requestedSession = trimmedOrUndefined(body.sessionId)
      const sessionId =
        requestedSession ??
        (participant.binding !== undefined && participant.binding.sessionId !== undefined ? participant.binding.sessionId : undefined)
      if (sessionId === undefined) {
        sendJson(res, 200, { released: false, participant: hub.identity.view(participant) })
        return
      }
      const released = await hub.release(sessionId)
      sendJson(res, 200, {
        released: released !== undefined,
        ...(released !== undefined ? { participant: hub.identity.view(released) } : {}),
      })
      return
    }

    // -- per-session switches (SPEC §7.7) ------------------------------------
    case 'GET /session-prefs': {
      // Loopback read trust, same rule as history/pins.
      resolveCaller(hub, req, url)
      const sessionId = normalizeSessionId(url.searchParams.get('sessionId'))
      sendJson(res, 200, { sessionId, prefs: hub.sessionPrefsFor(sessionId) })
      return
    }
    case 'POST /session-prefs': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const sessionId = normalizeSessionId(body.sessionId)
      const prefs = hub.setSessionPrefs(
        sessionId,
        normalizePrefsPatch({ hidden: body.hidden, muted: body.muted }),
        participant.handle,
      )
      sendJson(res, 200, { sessionId, prefs })
      return
    }

    // -- channels -----------------------------------------------------------
    case 'GET /channels': {
      const caller = resolveCaller(hub, req, url)
      const includeArchived = url.searchParams.get('includeArchived') === '1'
      sendJson(res, 200, hub.listChannels(caller.participant, { includeArchived }))
      return
    }
    case 'POST /channels': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const id = str(body.id)
      if (id === undefined) throw new HostError(400, 'invalid_request', 'id is required')
      const channel = await hub.createChannel(participant, {
        id,
        name: str(body.name),
        topic: str(body.topic),
        category: str(body.category),
      })
      sendJson(res, 200, { channel })
      return
    }
    // -- channel membership (SPEC §7.8) -------------------------------------
    case 'POST /join': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      sendJson(res, 200, hub.joinChannel(participant, str(body.channel) ?? ''))
      return
    }
    case 'POST /leave': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      sendJson(res, 200, hub.leaveChannel(participant, str(body.channel) ?? ''))
      return
    }
    // -- channel administration (SPEC §7.10) --------------------------------
    case 'POST /channel-admins': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = hub.setChannelAdmins(participant, body.channel, {
        handle: body.handle,
        admin: body.admin,
      })
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /channel-mute': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = hub.setChannelMute(participant, body.channel, {
        handle: body.handle,
        all: body.all,
        muted: body.muted,
      })
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /channel-limits': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = hub.setChannelLimits(participant, body.channel, {
        maxChars: body.maxChars,
        ratePerMinute: body.ratePerMinute,
      })
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /channels/archive': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = await hub.archiveChannel(participant, body.channel, body.archived !== false)
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /participants/remove': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const result = await hub.removeParticipant(participant, body.participantId)
      sendJson(res, 200, result)
      return
    }
    case 'GET /history': {
      const caller = resolveCaller(hub, req, url)
      const channel = str(url.searchParams.get('channel'))
      const page = hub.history(caller.participant, {
        ...(channel !== undefined ? { channel } : {}),
        ...(parseSeq(url.searchParams.get('beforeSeq')) !== undefined ? { beforeSeq: parseSeq(url.searchParams.get('beforeSeq')) as number } : {}),
        ...(parseSeq(url.searchParams.get('afterSeq')) !== undefined ? { afterSeq: parseSeq(url.searchParams.get('afterSeq')) as number } : {}),
        ...(parseSeq(url.searchParams.get('limit')) !== undefined ? { limit: parseSeq(url.searchParams.get('limit')) as number } : {}),
      })
      sendJson(res, 200, page)
      return
    }
    case 'POST /send': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = str(body.channel)
      const text = str(body.text) ?? ''
      if (channel === undefined) throw new HostError(400, 'invalid_request', 'channel is required')
      const mentions = Array.isArray(body.mentions) ? body.mentions : undefined
      if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
        throw new HostError(400, 'invalid_request', 'attachments must be an array of attachment ids')
      }
      const attachments = Array.isArray(body.attachments) ? body.attachments : undefined
      const outcome = await hub.sendMessage(participant, {
        channel,
        text,
        replyTo: str(body.replyTo),
        mentions,
        attachments,
        clientMsgId: str(body.clientMsgId),
      })
      sendJson(res, 200, {
        message: outcome.message,
        duplicate: outcome.duplicate,
        wake: outcome.wake,
      })
      return
    }
    case 'POST /pin': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = await hub.pin(participant, {
        channel: str(body.channel) ?? '',
        messageId: str(body.messageId) ?? '',
      })
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /unpin': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const channel = await hub.unpin(participant, {
        channel: str(body.channel) ?? '',
        messageId: str(body.messageId) ?? '',
      })
      sendJson(res, 200, { channel })
      return
    }
    case 'POST /announce': {
      const body = await bodyObject()
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const outcome = await hub.announce(participant, {
        channel: str(body.channel) ?? '',
        text: str(body.text) ?? '',
      })
      sendJson(res, 200, { message: outcome.message, channel: outcome.channel, wake: outcome.wake })
      return
    }
    case 'GET /pins': {
      const caller = resolveCaller(hub, req, url)
      requireCallerOrReadAll(caller)
      const channel = str(url.searchParams.get('channel'))
      if (channel === undefined) throw new HostError(400, 'invalid_request', 'channel query parameter is required')
      sendJson(res, 200, hub.pins(caller.participant, channel))
      return
    }
    case 'GET /members': {
      const caller = resolveCaller(hub, req, url)
      const channel = str(url.searchParams.get('channel'))
      sendJson(res, 200, { participants: hub.members(channel, caller.participant) })
      return
    }

    // -- attachments --------------------------------------------------------
    case 'POST /upload': {
      const caller = resolveCaller(hub, req, url)
      const participant = requireCaller(caller)
      const maxBytes = hub.config.maxAttachmentBytes
      const declaredLength = Number(req.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new HostError(413, 'payload_too_large', `upload is ${declaredLength} bytes; the limit is ${maxBytes} bytes`)
      }
      const bytes = await readRawBody(req, maxBytes)
      const name = str(url.searchParams.get('name')) ?? str(req.headers['x-file-name'])
      const declaredMime = str(url.searchParams.get('mime')) ?? str(req.headers['content-type'])
      const attachment = await hub.uploadAttachment(participant, { name, mime: declaredMime, bytes })
      sendJson(res, 200, { attachment })
      return
    }

    // -- search -------------------------------------------------------------
    case 'GET /search': {
      const caller = resolveCaller(hub, req, url)
      const channel = str(url.searchParams.get('channel'))
      const limit = parseSeq(url.searchParams.get('limit'))
      const beforeSeq = parseSeq(url.searchParams.get('beforeSeq'))
      const result = hub.search(caller.participant, {
        query: url.searchParams.get('q') ?? '',
        ...(channel !== undefined ? { channel } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      })
      sendJson(res, 200, { query: result.query, hits: result.hits, hasMore: result.hasMore })
      return
    }

    // -- SSE ----------------------------------------------------------------
    case 'GET /stream': {
      await handleStream(hub, req, res, url)
      return
    }
    default: {
      throw new HostError(404, 'not_found', `unknown channel API route "${method} ${sub}"`)
    }
  }
}

/** GET /pins is public-read for a trusted same-origin browser without a token. */
function requireCallerOrReadAll(_caller: Caller): void {
  /* reads are allowed for trusted browser callers; nothing to enforce in v1 */
}

/** Write SSE headers, resolve the participant, and hand the socket to the hub. */
async function handleStream(hub: ChannelsHub, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = bearerToken(req) ?? str(url.searchParams.get('token'))
  let participant: Participant | undefined
  if (token !== undefined) {
    participant = hub.identity.authenticate(token)
    if (participant === undefined) throw new HostError(401, 'unauthorized', 'invalid bearer token')
  } else {
    if (!isLoopbackRequest(req) || !sameOrigin(req)) {
      throw new HostError(401, 'unauthorized', 'missing bearer token')
    }
    const participantId = str(url.searchParams.get('participant'))
    if (participantId !== undefined) participant = hub.identity.get(participantId) ?? hub.identity.byHandle(participantId)
  }

  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.setHeader('x-content-type-options', 'nosniff')
  res.flushHeaders()
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)

  const afterSeq = parseSeq(url.searchParams.get('afterSeq'))
  hub.addSseClient({
    req,
    res,
    ...(participant !== undefined ? { participant } : {}),
    ...(afterSeq !== undefined ? { afterSeq } : {}),
  })
}

// ---------------------------------------------------------------------------
// Attachment bytes
// ---------------------------------------------------------------------------

/**
 * Serve `GET /channels/api/attachments/<id>`.
 *
 * Read trust matches history: loopback same-origin browsers may omit the token,
 * anything else needs a bearer token. Only raster images are rendered inline;
 * every other type — SVG and HTML included — is forced to a download and served
 * with `nosniff` plus a restrictive CSP so it can never execute in the origin.
 */
async function handleAttachmentGet(
  hub: ChannelsHub,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawId: string,
): Promise<void> {
  resolveCaller(hub, req, url)
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    throw new HostError(404, 'not_found', 'unknown attachment')
  }
  const meta = hub.attachmentMeta(id)
  if (meta === undefined) throw new HostError(404, 'not_found', `attachment "${id}" does not exist`)
  const stream = hub.attachments.createStream(id)
  if (stream === undefined) throw new HostError(404, 'not_found', `attachment "${id}" has no stored bytes`)

  const inline = isInlineImageMime(meta.mime)
  res.statusCode = 200
  res.setHeader('content-type', meta.mime)
  res.setHeader('content-length', String(hub.attachments.sizeOf(id)))
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', "default-src 'none'; sandbox")
  res.setHeader('cache-control', 'private, max-age=31536000, immutable')
  res.setHeader('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', meta.name))
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {
      /* socket already gone */
    }
  })
  res.on('close', () => {
    try {
      stream.destroy()
    } catch {
      /* already closed */
    }
  })
  stream.pipe(res)
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Register the prefix route; returns nothing (disposal is wired via ctx.effect). */
export function installHttp(ctx: CtxLike, hub: ChannelsHub): void {
  const webServer = service(ctx, 'webServer') as WebServerLike | undefined
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-channels: webServer service unavailable; HTTP API not mounted')
    return
  }
  ctx.effect(
    () => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: API_BASE,
        handler: (req, res) => {
          void handle(hub, req, res).catch((error: unknown) => fail(res, error))
        },
      })
      return () => {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    },
    'dsh-channels: HTTP API',
  )
}

/** Exported for tests: same dispatcher the route handler uses. */
export { handle as handleChannelRequest }
