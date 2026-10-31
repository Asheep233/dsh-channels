/**
 * Shared helpers for the dsh-channels QA suite (node:test, zero dependencies).
 *
 * The live host is discovered through `~/.dsh/channels/endpoint.json` (falling
 * back to `DSH_CHANNELS_URL` / the default loopback URL). The suite must not
 * touch `src/`, `package.json` or `#general`; every write goes to a per-run
 * throwaway channel and every participant handle is unique per run.
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function readEndpoint() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const dataDir = process.env.DSH_CHANNELS_DATA_DIR?.trim() || join(dshHome, 'channels')
  const endpointFile = join(dataDir, 'endpoint.json')
  try {
    const raw = JSON.parse(readFileSync(endpointFile, 'utf8'))
    if (raw !== null && typeof raw === 'object' && typeof raw.url === 'string' && raw.url.length > 0) {
      return {
        url: raw.url.replace(/\/+$/, ''),
        dataDir: typeof raw.dataDir === 'string' && raw.dataDir.length > 0 ? raw.dataDir : dataDir,
        endpointFile,
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      }
    }
  } catch {
    /* fall through to env/default */
  }
  const fallback = (process.env.DSH_CHANNELS_URL?.trim() || 'http://127.0.0.1:3080/channels/api').replace(/\/+$/, '')
  return { url: fallback, dataDir, endpointFile }
}

export const ENDPOINT = readEndpoint()
/** Full API base, e.g. http://127.0.0.1:3080/channels/api (SPEC §5). */
export const API = ENDPOINT.url
/** Live data dir (`$DSH_HOME/channels`), used only for read/append on throwaway channels. */
export const DATA_DIR = ENDPOINT.dataDir
/** Short unique id shared by one test-file run. */
export const RUN = `${Date.now().toString(36).slice(-6)}${randomBytes(2).toString('hex')}`

export const HANDLE_RE = /^[a-z0-9_-]{2,24}$/
export const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Unique, spec-legal handle for this run: `qa-<tag>[-<suffix>]-<run>`. */
export function uniqueHandle(tag, suffix = '') {
  const value = `qa-${tag}${suffix === '' ? '' : `-${suffix}`}-${RUN}`.toLowerCase()
  assert.ok(HANDLE_RE.test(value), `helper produced an invalid handle: ${value}`)
  return value
}

/** Unique, spec-legal channel id for this run. */
export function uniqueChannel(tag, suffix = '') {
  const value = `qa-${tag}${suffix === '' ? '' : `-${suffix}`}-${RUN}`.toLowerCase()
  assert.ok(CHANNEL_RE.test(value), `helper produced an invalid channel id: ${value}`)
  return value
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// HTTP API (SPEC §5)
// ---------------------------------------------------------------------------

/**
 * Call the live channel API. Returns `{status, headers, text, json, method, path}`.
 * Never throws on HTTP error statuses (tests assert statuses explicitly).
 */
export async function api(path, options = {}) {
  const { method = 'GET', token, body, rawBody, headers = {}, timeoutMs = 30_000 } = options
  const requestHeaders = { ...headers }
  if (token !== undefined) requestHeaders.authorization = `Bearer ${token}`
  let payload
  if (rawBody !== undefined) {
    // Raw bytes (POST /upload): no JSON content-type unless the caller set one.
    payload = rawBody
  } else if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, text, json, method, path }
}

/** Assert an HTTP 200 JSON response and return the parsed body. */
export async function apiOk(path, options = {}) {
  const response = await api(path, options)
  assert.equal(
    response.status,
    200,
    `expected HTTP 200 from ${options.method ?? 'GET'} ${path}, got ${response.status}: ${response.text.slice(0, 500)}`,
  )
  assert.ok(response.json !== undefined, `expected JSON body from ${path}, got: ${response.text.slice(0, 500)}`)
  return response.json
}

/** Assert the SPEC §5 error envelope `{error:{code,message}}` + status. */
export function assertApiError(response, status, code) {
  assert.equal(
    response.status,
    status,
    `expected HTTP ${status} from ${response.method} ${response.path}, got ${response.status}: ${response.text.slice(0, 500)}`,
  )
  assert.ok(response.json !== undefined && typeof response.json === 'object', `expected JSON error body, got: ${response.text.slice(0, 500)}`)
  const error = response.json.error
  assert.ok(error !== undefined && typeof error === 'object', `expected {error:{code,message}}, got: ${response.text.slice(0, 500)}`)
  assert.equal(error.code, code, `expected error.code "${code}", got "${error.code}" (${error.message})`)
  assert.equal(typeof error.message, 'string')
  return error
}

export async function register(input = {}) {
  return apiOk('/register', { method: 'POST', body: { kind: 'external', ...input } })
}

export async function createChannel(token, id, extra = {}) {
  const body = await apiOk('/channels', { method: 'POST', token, body: { id, ...extra } })
  return body.channel
}

export async function send(token, channel, text, extra = {}) {
  return apiOk('/send', { method: 'POST', token, body: { channel, text, ...extra } })
}

export async function history(token, channel, query = {}) {
  const params = new URLSearchParams({ channel })
  for (const key of ['beforeSeq', 'afterSeq', 'limit']) {
    if (query[key] !== undefined) params.set(key, String(query[key]))
  }
  return apiOk(`/history?${params.toString()}`, { token })
}

export async function listChannels(token) {
  return apiOk('/channels', { token })
}

export async function members(token, channel) {
  const suffix = channel === undefined ? '' : `?channel=${encodeURIComponent(channel)}`
  return apiOk(`/members${suffix}`, { token })
}

export async function whoami(token) {
  return apiOk('/whoami', { token })
}

export async function health() {
  return apiOk('/health')
}

// ---------------------------------------------------------------------------
// On-disk message log helpers (JSONL is the source of truth, SPEC §3)
// ---------------------------------------------------------------------------

/** Path of a channel's append-only message log inside the live data dir. */
export function messagesFile(channel) {
  assert.ok(CHANNEL_RE.test(channel), `refusing to compute a JSONL path for a non-slug channel: ${channel}`)
  return join(DATA_DIR, 'messages', `${channel}.jsonl`)
}

/** Read one channel JSONL file tolerantly; reports invalid (partial/corrupt) lines. */
export function readMessageFile(channel) {
  const file = messagesFile(channel)
  const exists = existsSync(file)
  const raw = exists ? readFileSync(file, 'utf8') : ''
  const rawLines = raw === '' ? [] : raw.split('\n')
  if (raw.endsWith('\n')) rawLines.pop()
  const parsed = []
  const invalid = []
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      invalid.push({ line, reason: 'blank line' })
      continue
    }
    try {
      parsed.push(JSON.parse(trimmed))
    } catch (error) {
      invalid.push({ line, reason: error.message })
    }
  }
  return { file, exists, raw, rawLines, parsed, invalid, endsWithNewline: raw.endsWith('\n') }
}

/** Append raw bytes to a throwaway channel's JSONL (crash-tail simulation). */
export function appendRawToChannelFile(channel, text) {
  const file = messagesFile(channel)
  appendFileSync(file, text, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// SSE client (SPEC §5 `/stream`, frames written as `event: x\ndata: json\n\n`)
// ---------------------------------------------------------------------------

function parseSseBlock(block) {
  let event = 'message'
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue // comment / keepalive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const rawData = dataLines.join('\n')
  let data
  try {
    data = JSON.parse(rawData)
  } catch {
    data = rawData
  }
  return { event, data, raw: block }
}

/**
 * Open an SSE connection and expose an async frame iterator.
 * `waitFor(predicate, ms)` consumes frames until one matches (or throws).
 */
export async function openSse(options = {}) {
  const { token, afterSeq, participant, timeoutMs = 5_000 } = options
  const params = new URLSearchParams()
  if (token !== undefined) params.set('token', token)
  if (afterSeq !== undefined) params.set('afterSeq', String(afterSeq))
  if (participant !== undefined) params.set('participant', participant)
  const controller = new AbortController()
  const response = await fetch(`${API}/stream?${params.toString()}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })

  const queue = []
  const waiters = []
  const seen = []
  let ended = false
  let failure
  let buffer = ''
  const decoder = new TextDecoder()

  function push(frame) {
    seen.push(frame)
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    } else {
      queue.push(frame)
    }
  }

  function terminate(error) {
    ended = true
    if (failure === undefined) failure = error
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      clearTimeout(waiter.timer)
      waiter.reject(failure)
    }
  }

  const body = response.body
  const pump = (async () => {
    if (body === null) {
      terminate(new Error('SSE response has no body stream'))
      return
    }
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseSseBlock(block)
          if (frame !== undefined) push(frame)
        }
      }
      terminate(new Error('SSE stream ended'))
    } catch (error) {
      terminate(error)
    }
  })()

  function next(ms = timeoutMs) {
    if (queue.length > 0) return Promise.resolve(queue.shift())
    if (ended) return Promise.reject(failure ?? new Error('SSE stream ended'))
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(entry)
          if (index !== -1) waiters.splice(index, 1)
          reject(
            new Error(
              `SSE frame timeout after ${ms}ms; events seen: ${JSON.stringify(seen.map((frame) => frame.event)).slice(0, 800)}`,
            ),
          )
        }, ms),
      }
      waiters.push(entry)
    })
  }

  async function waitFor(predicate, ms = timeoutMs) {
    const deadline = Date.now() + ms
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(
          `SSE waitFor timeout after ${ms}ms; events seen: ${JSON.stringify(seen.map((frame) => frame.event)).slice(0, 800)}`,
        )
      }
      const frame = await next(remaining)
      if (predicate(frame)) return frame
    }
  }

  function close() {
    try {
      controller.abort()
    } catch {
      /* already closed */
    }
  }

  return {
    response,
    next,
    waitFor,
    close,
    pump,
    get ended() {
      return ended
    },
    get frames() {
      return seen
    },
  }
}

// ---------------------------------------------------------------------------
// Hermetic hub helpers (temp dataDir + fake Cordis ctx; never touches the live hub)
// ---------------------------------------------------------------------------

/**
 * Minimal fake Cordis context accepted by lib/host/hub.js `applyHub`.
 *
 * Supports `ctx.get(service)`, `ctx.effect`, and (M4) `ctx.on(event, listener)`
 * plus a test-only `ctx.emit(event, payload)` so session-prefs masking can be
 * driven through the same `agent/created` / `agent/disposed` lifecycle the real
 * host emits. `ctx.emitted` records every event for assertions.
 */
export function makeFakeCtx(services = {}) {
  const registry = new Map(Object.entries(services))
  const listeners = new Map()
  const emitted = []
  const effectCleanups = []
  return {
    logger: {
      info() {},
      warn() {},
    },
    get(name) {
      return registry.get(name)
    },
    effect(execute) {
      // Mirror Cordis: run the effect now, remember its disposer, return it.
      const cleanup = execute()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      return cleanup
    },
    /** Test-only: run plugin disposers in reverse order (like a plugin unload). */
    runEffects() {
      for (const cleanup of effectCleanups.reverse()) {
        try {
          cleanup()
        } catch {
          /* best effort, like Cordis */
        }
      }
      effectCleanups.length = 0
    },
    get effectCount() {
      return effectCleanups.length
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
      return () => {
        bucket.delete(listener)
      }
    },
    /** Test-only event bus driver (mirrors Cordis `agent/created` broadcasts). */
    emit(event, payload) {
      emitted.push({ event, payload })
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
    },
    get listenerCount() {
      return [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0)
    },
    emitted,
    services: registry,
  }
}

/** Fake command registry: captures `/channels` definitions and can invoke them. */
export function makeFakeCommands() {
  const definitions = []
  const errors = []
  return {
    definitions,
    errors,
    register(definition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index !== -1) definitions.splice(index, 1)
      }
    },
    /** Invoke a registered command like the real dispatcher would. */
    async invoke(name, rawInput, agent) {
      const definition = definitions.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`command "${name}" is not registered`)
      try {
        return await definition.handler({ agent, rawInput })
      } catch (error) {
        errors.push(error)
        throw error
      }
    },
  }
}

/**
 * A fake live agent whose `ctx.tools.restrict()` calls are recorded.
 * `denies` accumulates every deny list; `disposed` counts disposer calls.
 */
export function makeRestrictableAgent(id) {
  const denies = []
  const disposed = []
  const agent = {
    id,
    denies,
    disposed,
    disposerCalls: 0,
    followup(message) {
      agent.calls.push(message)
    },
    calls: [],
    ctx: {
      tools: {
        restrict(filter) {
          denies.push(filter)
          let released = false
          return () => {
            if (released) return
            released = true
            agent.disposerCalls += 1
            disposed.push(filter)
          }
        },
      },
    },
  }
  return agent
}

/** A fake live agent: `steer()`/`followup()` calls are recorded for wake assertions. */
export function makeFakeAgent(id) {
  const calls = []
  const steers = []
  return {
    id,
    calls,
    steers,
    followup(message) {
      calls.push(message)
    },
    steer(message) {
      steers.push(message)
    },
  }
}

/** One well-formed ChannelMessage for seeding a hermetic message log. */
export function makeSeedMessage(channel, seq, overrides = {}) {
  const handle = overrides.handle ?? 'seed-user'
  return {
    id: `${channel}-${String(seq).padStart(6, '0')}`,
    channel,
    seq,
    ts: new Date().toISOString(),
    author: {
      participantId: 'p_seed',
      handle,
      displayName: handle,
      kind: 'external',
      harness: 'other',
    },
    text: `seed message ${seq}`,
    mentions: [],
    kind: 'chat',
    ...overrides,
  }
}

/** Create a temp data dir seeded with one channel and its message log. */
export function seedChannel(dataDir, channel, messages, options = {}) {
  const { partialTail = '', extraTail = '' } = options
  const createdAt = new Date().toISOString()
  mkdirSync(join(dataDir, 'messages'), { recursive: true })
  mkdirSync(join(dataDir, 'events'), { recursive: true })
  const lines = messages.map((message) => JSON.stringify(message))
  const body = (lines.length > 0 ? `${lines.join('\n')}\n` : '') + extraTail + partialTail
  writeFileSync(join(dataDir, 'messages', `${channel}.jsonl`), body, 'utf8')
  writeFileSync(
    join(dataDir, 'events', `${channel}.jsonl`),
    `${JSON.stringify({ type: 'create', channel, name: channel, at: createdAt, by: 'system' })}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'channels.json'),
    `${JSON.stringify([{ id: channel, name: channel, createdAt, createdBy: 'system', pins: [] }])}\n`,
    'utf8',
  )
  writeFileSync(join(dataDir, 'participants.json'), '[]\n', 'utf8')
  return dataDir
}

/** Write a hub.lock claiming the given pid (for stale / live-lock tests). */
export function seedLock(dataDir, pid) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'hub.lock')
  writeFileSync(file, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
  return file
}

/** Unique temp dir for hermetic hub tests (cleaned up by the caller). */
export function makeTempDataDir(tag) {
  return join(tmpdir(), `dsh-channels-qa-${tag}-${randomBytes(4).toString('hex')}`)
}

// ---------------------------------------------------------------------------
// M3: attachments (POST /upload + GET /attachments/<id>) and search
// ---------------------------------------------------------------------------

/** 1x1 transparent PNG (70 bytes) — the canonical tiny upload fixture. */
export function smallPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

/** A minimal GIF87a (1x1) so inline-image decisions can be checked on a second type. */
export function smallGif() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
}

/** Upload raw bytes to POST /upload (SPEC §7.5). */
export async function upload(token, bytes, { name, mime, headers = {} } = {}) {
  const params = new URLSearchParams()
  if (name !== undefined) params.set('name', name)
  if (mime !== undefined) params.set('mime', mime)
  const suffix = params.toString().length > 0 ? `?${params.toString()}` : ''
  const response = await api(`/upload${suffix}`, { method: 'POST', token, rawBody: bytes, headers })
  return response
}

/** Fetch attachment bytes by id or absolute url (loopback read trust allows no token). */
export async function getAttachment(idOrUrl, { token } = {}) {
  const url = idOrUrl.startsWith('http') ? idOrUrl : `${API}/attachments/${encodeURIComponent(idOrUrl)}`
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, bytes, url }
}

/** Search the message history: GET /search?q=&channel=&limit=&beforeSeq= (SPEC §7.5). */
export async function search(token, query, options = {}) {
  const params = new URLSearchParams({ q: query })
  for (const key of ['channel', 'limit', 'beforeSeq']) {
    if (options[key] !== undefined) params.set(key, String(options[key]))
  }
  return apiOk(`/search?${params.toString()}`, { token })
}

/** Archive or restore one channel (POST /channels/archive). */
export async function archiveChannel(token, channel, archived = true) {
  const body = await apiOk('/channels/archive', { method: 'POST', token, body: { channel, archived } })
  return body.channel
}

/** List channels, optionally including archived ones (GET /channels?includeArchived=1). */
export async function listChannelsWithArchived(token, includeArchived = true) {
  return apiOk(`/channels${includeArchived ? '?includeArchived=1' : ''}`, { token })
}

/** Temp `DSH_HOME` skeleton so CLI/MCP tests never touch the real clients dir. */
export function makeTempHome(tag) {
  const home = join(tmpdir(), `dsh-channels-qa-home-${tag}-${randomBytes(4).toString('hex')}`)
  mkdirSync(join(home, 'channels', 'clients'), { recursive: true })
  return home
}

// ---------------------------------------------------------------------------
// M4/M5: session preferences + channel membership helpers
// ---------------------------------------------------------------------------

/** GET /session-prefs?sessionId= (loopback read trust: no token needed). */
export async function sessionPrefs(token, sessionId) {
  const params = new URLSearchParams({ sessionId })
  return apiOk(`/session-prefs?${params.toString()}`, token === undefined ? {} : { token })
}

/** PATCH-style POST /session-prefs (Bearer required). */
export async function setSessionPrefs(token, sessionId, patch) {
  return api(`/session-prefs`, { method: 'POST', token, body: { sessionId, ...patch } })
}

/** POST /join {channel} → {channel, joined, memberCount}. */
export async function joinChannel(token, channel) {
  return apiOk('/join', { method: 'POST', token, body: { channel } })
}

/** POST /leave {channel} → {channel, joined, memberCount}. */
export async function leaveChannel(token, channel) {
  return apiOk('/leave', { method: 'POST', token, body: { channel } })
}

/**
 * Seed a hermetic data dir that predates the membership file (for migration
 * tests): channels.json + participants.json + empty message logs, but no
 * channel-memberships.json / session-prefs.json.
 */
export function seedLegacyHub(dataDir, channels, participants) {
  mkdirSync(join(dataDir, 'messages'), { recursive: true })
  mkdirSync(join(dataDir, 'events'), { recursive: true })
  const createdAt = new Date().toISOString()
  writeFileSync(
    join(dataDir, 'channels.json'),
    `${JSON.stringify(
      channels.map((channel) => ({
        id: channel.id,
        name: channel.name ?? channel.id,
        createdAt: channel.createdAt ?? createdAt,
        createdBy: channel.createdBy ?? 'system',
        pins: [],
      })),
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(dataDir, 'participants.json'),
    `${JSON.stringify(
      participants.map((participant) => ({
        id: participant.id,
        handle: participant.handle,
        displayName: participant.displayName ?? participant.handle,
        kind: participant.kind ?? 'external',
        harness: participant.harness ?? 'other',
        createdAt: participant.createdAt ?? createdAt,
        lastSeen: participant.lastSeen ?? createdAt,
        status: participant.status ?? 'idle',
        ...(participant.tokenHash !== undefined ? { tokenHash: participant.tokenHash } : {}),
        ...(participant.binding !== undefined ? { binding: participant.binding } : {}),
      })),
    )}\n`,
    'utf8',
  )
  return dataDir
}
