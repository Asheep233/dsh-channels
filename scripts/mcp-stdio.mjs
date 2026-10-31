#!/usr/bin/env node
/**
 * dsh-channels MCP stdio server — zero-dependency bridge for MCP clients
 * (Claude Code / Codex / opencode / any newline-delimited JSON-RPC 2.0 client).
 *
 * Contract: SPEC.md §5 (HTTP API) + §9 (MCP). Node >= 20, no npm dependencies.
 *
 * Protocol:
 *   - newline-delimited JSON-RPC 2.0 on stdin/stdout (stdout is protocol only)
 *   - initialize / notifications/initialized / ping / tools/list / tools/call
 *   - tools: channel_register, channel_send, channel_search, channel_history,
 *     channel_join, channel_leave, channel_list, channel_members, channel_whoami,
 *     channel_pin, channel_unpin, channel_announce
 *   - channel_send accepts `files` (local paths): each is uploaded to POST /upload
 *     first and then referenced by id from POST /send (M3)
 *   - unknown methods -> JSON-RPC error -32601
 *
 * Discovery / identity:
 *   - endpoint: $DSH_HOME/channels/endpoint.json -> { url } (or DSH_CHANNELS_URL / --url)
 *   - token: --token / DSH_CHANNELS_TOKEN / $DSH_HOME/channels/clients/<handle>.json
 *   - otherwise lazily registers an external identity on the first tool call
 *     (default handle `mcp-<pid>`, harness `other`)
 *
 * Usage: node scripts/mcp-stdio.mjs [--url <apiBase>] [--token <token>] [--handle <handle>] [--harness <name>]
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import process from 'node:process'

const SERVER_NAME = 'dsh-channels'
const SERVER_VERSION = '0.1.0'
const REQUEST_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 120_000
const MAX_TEXT_BYTES = 8 * 1024
const MAX_PAGE = 100
// Mirrors src/contract.ts (M3 attachments + search).
const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024
const SEARCH_LIMIT = 50
const HARNESSES = ['dsh', 'claude-code', 'codex', 'opencode', 'other']
const HANDLE_RE = /^[a-z0-9_-]{2,24}$/
const RESERVED_HANDLES = new Set(['all', 'here', 'channel', 'system', 'everyone'])
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Minimal extension -> mime map; the host only inlines png/jpeg/gif/webp. */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/json',
  ndjson: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  blend: 'application/x-blender',
  stl: 'model/stl',
  obj: 'model/obj',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
}

/**
 * Protocol revisions this server accepts in `initialize`. If the client asks
 * for one of these we echo it back (per MCP negotiation rules); any other
 * requested revision falls back to DEFAULT_PROTOCOL_VERSION.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

// ---------------------------------------------------------------------------
// stderr logging (stdout is reserved for JSON-RPC frames)
// ---------------------------------------------------------------------------

function log(message) {
  try {
    process.stderr.write(`[${SERVER_NAME}-mcp] ${message}\n`)
  } catch {
    /* ignore */
  }
}

// A closed stdout pipe means the client went away: exit cleanly, never crash.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0)
})
process.stderr.on('error', () => {})

// ---------------------------------------------------------------------------
// JSON-RPC / MCP errors
// ---------------------------------------------------------------------------

class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}

class ToolInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolInputError'
    this.code = 'invalid_params'
  }
}

/** Error raised by discovery + HTTP forwarding; surfaced as an isError tool result. */
class BridgeError extends Error {
  constructor(code, message, { status } = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (typeof status === 'number') this.status = status
  }
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function failCli(message) {
  process.stderr.write(`[${SERVER_NAME}-mcp] ${message}\n`)
  process.exit(2)
}

function parseCli(argv) {
  const out = { help: false, version: false, url: undefined, token: undefined, handle: undefined, harness: 'other' }
  const valueFlags = ['--url', '--token', '--handle', '--harness']
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      out.help = true
      continue
    }
    if (token === '--version' || token === '-v') {
      out.version = true
      continue
    }
    let name = token
    let inline
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals !== -1) {
        name = token.slice(0, equals)
        inline = token.slice(equals + 1)
      }
    }
    if (valueFlags.includes(name)) {
      let value = inline
      if (value === undefined) {
        index += 1
        if (index >= argv.length) failCli(`option ${name} requires a value`)
        value = argv[index]
      }
      out[name.slice(2)] = value
      continue
    }
    failCli(`unknown argument: ${token} (see --help)`)
  }
  return out
}

const cli = parseCli(process.argv.slice(2))

if (cli.help) {
  process.stderr.write(`dsh-channels MCP stdio server ${SERVER_VERSION}

Usage: node scripts/mcp-stdio.mjs [options]

Speaks newline-delimited JSON-RPC 2.0 MCP on stdin/stdout. Registers tools:
  channel_register, channel_send, channel_search, channel_history, channel_join,
  channel_leave, channel_list, channel_members, channel_whoami, channel_pin,
  channel_unpin, channel_announce

Sub-channels are membership-gated: new identities only join #general, so call
channel_join before reading/posting in one (non-members get 403 not_member).

channel_send accepts "files" (local file paths): each file is uploaded to
POST /upload first, then referenced by attachment id from POST /send.

Options:
  --url <apiBase>     dsh-channels API base (default: $DSH_HOME/channels/endpoint.json)
  --token <token>     bearer token (default: DSH_CHANNELS_TOKEN, then client token file)
  --handle <handle>   identity handle (default: mcp-<pid>, or DSH_CHANNELS_HANDLE)
  --harness <name>    harness tag for a lazy registration (default: other)
  -h, --help          show this help
  -v, --version       print the server version

Discovery:
  endpoint: $DSH_HOME/channels/endpoint.json -> { "url": "http://127.0.0.1:3080/channels/api" }
  token:    $DSH_HOME/channels/clients/<handle>.json -> { participantId, handle, token }
  Start \`dsh web\` with the dsh-channels plugin. Logs go to stderr only.
`)
  process.exit(0)
}

if (cli.version) {
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// discovery: endpoint + identity
// ---------------------------------------------------------------------------

function dshHome() {
  const value = process.env.DSH_HOME
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return join(homedir(), '.dsh')
}

const channelsDir = () => join(dshHome(), 'channels')
const clientsDir = () => join(channelsDir(), 'clients')
const endpointPath = () => join(channelsDir(), 'endpoint.json')
const clientFile = (handle) => join(clientsDir(), `${handle}.json`)

function readEndpointUrl() {
  try {
    const parsed = JSON.parse(readFileSync(endpointPath(), 'utf8'))
    if (parsed && typeof parsed.url === 'string' && parsed.url.trim() !== '') return parsed.url.trim()
  } catch {
    /* missing / malformed -> caller reports */
  }
  return null
}

function normalizeBaseUrl(raw) {
  let value = String(raw).trim()
  if (!/^https?:\/\//i.test(value)) {
    throw new BridgeError('invalid_url', `invalid API url "${raw}" (expected http(s)://host[:port]/channels/api)`)
  }
  value = value.replace(/\/+$/, '')
  if (!/\/channels\/api$/.test(value)) value += '/channels/api'
  return value
}

function normalizeHandle(raw) {
  const handle = String(raw).trim().replace(/^@/, '').toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    throw new BridgeError('invalid_handle', `invalid handle "${raw}" (expected /^[a-z0-9_-]{2,24}$/)`)
  }
  if (RESERVED_HANDLES.has(handle)) throw new BridgeError('invalid_handle', `handle "${handle}" is reserved`)
  return handle
}

function normalizeChannel(raw) {
  const channel = String(raw).trim().replace(/^#/, '').toLowerCase()
  if (!CHANNEL_RE.test(channel)) {
    throw new BridgeError('invalid_channel', `invalid channel "${raw}" (expected a slug like general or dev-notes)`)
  }
  return channel
}

function assertText(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string') throw new ToolInputError('message text must be a string')
  if (text.trim() === '' && !allowEmpty) throw new ToolInputError('message text must not be empty')
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_TEXT_BYTES) {
    throw new ToolInputError(`message text is ${bytes} bytes; the host limit is ${MAX_TEXT_BYTES} bytes`)
  }
}

function readIdentity(handle) {
  try {
    const parsed = JSON.parse(readFileSync(clientFile(handle), 'utf8'))
    if (!parsed || typeof parsed.token !== 'string' || parsed.token === '') return null
    return {
      participantId: typeof parsed.participantId === 'string' ? parsed.participantId : null,
      handle: typeof parsed.handle === 'string' && parsed.handle ? parsed.handle : handle,
      token: parsed.token,
      path: clientFile(handle),
    }
  } catch {
    return null
  }
}

function saveIdentity({ participantId, handle, token }) {
  if (!handle || typeof token !== 'string' || token === '') {
    throw new BridgeError('bad_response', 'refusing to save an incomplete identity (missing handle/token)')
  }
  mkdirSync(clientsDir(), { recursive: true, mode: 0o700 })
  const path = clientFile(handle)
  const body = JSON.stringify({ participantId: participantId ?? null, handle, token }, null, 2)
  writeFileSync(path, `${body}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
  return path
}

let defaultHandle
try {
  defaultHandle = normalizeHandle(cli.handle ?? process.env.DSH_CHANNELS_HANDLE ?? `mcp-${process.pid}`)
} catch (error) {
  failCli(error.message)
}
const harness = cli.harness ?? process.env.DSH_CHANNELS_HARNESS ?? 'other'
if (!HARNESSES.includes(harness)) failCli(`--harness must be one of: ${HARNESSES.join(', ')}`)

const state = {
  urlFlag: cli.url ?? null,
  cliToken: cli.token ?? process.env.DSH_CHANNELS_TOKEN ?? null,
  handle: defaultHandle,
  harness,
  baseUrl: null,
  credentials: null,
  credentialsPromise: null,
}

function baseUrl() {
  if (state.baseUrl !== null) return state.baseUrl
  const raw = state.urlFlag ?? process.env.DSH_CHANNELS_URL ?? readEndpointUrl()
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new BridgeError(
      'endpoint_missing',
      `dsh-channels endpoint not found at ${endpointPath()}. Start \`dsh web\` with the dsh-channels plugin, then retry (or set DSH_CHANNELS_URL / pass --url, e.g. http://127.0.0.1:3080/channels/api).`,
    )
  }
  state.baseUrl = normalizeBaseUrl(raw)
  return state.baseUrl
}

// ---------------------------------------------------------------------------
// HTTP forwarding
// ---------------------------------------------------------------------------

async function toApiError(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    /* ignore */
  }
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const apiError = parsed && typeof parsed.error === 'object' ? parsed.error : null
  return new BridgeError(
    typeof apiError?.code === 'string' ? apiError.code : `http_${response.status}`,
    typeof apiError?.message === 'string' && apiError.message
      ? apiError.message
      : text.slice(0, 500) || response.statusText || `HTTP ${response.status}`,
    { status: response.status },
  )
}

async function httpJson(method, path, { query, body, raw, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const base = baseUrl()
  let url
  try {
    url = new URL(`${base}${path}`)
  } catch (error) {
    throw new BridgeError('invalid_url', `invalid request url for ${path}: ${error.message}`)
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
  if (raw !== undefined) {
    // POST /upload takes the file bytes as the whole request body.
    headers['Content-Type'] = 'application/octet-stream'
    init.body = raw
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new BridgeError('timeout', `request to ${base} timed out after ${timeoutMs} ms`)
    }
    const code = error?.cause?.code ?? error?.code
    throw new BridgeError(
      'network',
      `cannot reach dsh-channels host at ${base}${code ? ` (${code})` : ''}. Start \`dsh web\` with the dsh-channels plugin.`,
    )
  }
  if (!response.ok) throw await toApiError(response)
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------
// attachments (M3): local validation + raw upload
// ---------------------------------------------------------------------------

/** Human-readable byte size (mirrors contract.ts humanSize). */
function humanSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** Best-effort mime from the file extension (host receives it as ?mime=). */
function guessMime(filePath) {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Validate every local file before uploading anything (SPEC §7.5 limits).
 * Throws ToolInputError so callers surface an isError tool result.
 */
function planUploads(filePaths) {
  if (filePaths.length > MAX_ATTACHMENTS) {
    throw new ToolInputError(`too many files: ${filePaths.length} (max ${MAX_ATTACHMENTS} per message)`)
  }
  const plans = []
  let total = 0
  for (const rawPath of filePaths) {
    const filePath = String(rawPath)
    let info
    try {
      info = statSync(filePath)
    } catch (error) {
      const reason = error?.code === 'EACCES' ? 'permission denied' : 'file not found'
      throw new ToolInputError(`${reason}: ${filePath}`)
    }
    if (!info.isFile()) throw new ToolInputError(`not a regular file: ${filePath}`)
    if (info.size === 0) throw new ToolInputError(`file is empty: ${filePath} (the host rejects empty uploads)`)
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new ToolInputError(
        `file too large: ${filePath} is ${humanSize(info.size)} (max ${humanSize(MAX_ATTACHMENT_BYTES)} per file)`,
      )
    }
    total += info.size
    plans.push({ path: filePath, size: info.size, name: basename(filePath), mime: guessMime(filePath) })
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new ToolInputError(
      `attachments too large: ${humanSize(total)} total (max ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} per message)`,
    )
  }
  return plans
}

/** POST one file's bytes to /upload and return the attachment metadata. */
async function uploadAttachment(plan, token) {
  let bytes
  try {
    bytes = readFileSync(plan.path)
  } catch (error) {
    throw new ToolInputError(`cannot read ${plan.path}: ${error?.code ?? error?.message ?? 'unknown error'}`)
  }
  log(`uploading ${plan.name} (${humanSize(plan.size)}, ${plan.mime})`)
  const data = await httpJson('POST', '/upload', {
    token,
    raw: bytes,
    query: { name: plan.name, mime: plan.mime },
    timeoutMs: UPLOAD_TIMEOUT_MS,
  })
  const attachment = data?.attachment ?? data
  if (!attachment || typeof attachment.id !== 'string' || attachment.id === '') {
    throw new BridgeError('bad_response', 'host returned an unexpected upload response (missing attachment.id)')
  }
  return {
    ...attachment,
    id: attachment.id,
    name: typeof attachment.name === 'string' && attachment.name ? attachment.name : plan.name,
    mime: typeof attachment.mime === 'string' && attachment.mime ? attachment.mime : plan.mime,
    size: typeof attachment.size === 'number' ? attachment.size : plan.size,
  }
}

// ---------------------------------------------------------------------------
// identity resolution (explicit token -> client file -> lazy register)
// ---------------------------------------------------------------------------

async function resolveCredentials() {
  if (state.cliToken) {
    return { token: state.cliToken, handle: state.handle, participantId: null, source: 'explicit' }
  }
  const saved = readIdentity(state.handle)
  if (saved) {
    log(`using saved identity @${saved.handle}`)
    return { ...saved, source: 'file' }
  }
  log(`no token for @${state.handle}; registering an external identity…`)
  let data
  try {
    data = await httpJson('POST', '/register', {
      body: { kind: 'external', handle: state.handle, harness: state.harness },
    })
  } catch (error) {
    if (error.status === 409) {
      log(`handle @${state.handle} is already claimed; registering with a server-assigned handle`)
      data = await httpJson('POST', '/register', { body: { kind: 'external', harness: state.harness } })
    } else {
      throw error
    }
  }
  if (!data || typeof data.token !== 'string' || typeof data.handle !== 'string') {
    throw new BridgeError('bad_response', 'host returned an unexpected register response (missing handle/token)')
  }
  const credentials = {
    participantId: typeof data.participantId === 'string' ? data.participantId : null,
    handle: data.handle,
    token: data.token,
    source: 'lazy',
  }
  try {
    credentials.path = saveIdentity(credentials)
  } catch (error) {
    log(`could not save the client token file: ${error.message}`)
  }
  state.credentials = credentials
  state.handle = data.handle
  log(
    `registered @${credentials.handle} (participantId=${credentials.participantId ?? '?'})${credentials.path ? `; token saved to ${credentials.path}` : ''}`,
  )
  return credentials
}

function getCredentials() {
  if (state.credentials) return Promise.resolve(state.credentials)
  if (!state.credentialsPromise) {
    state.credentialsPromise = resolveCredentials().catch((error) => {
      state.credentialsPromise = null
      throw error
    })
  }
  return state.credentialsPromise
}

/**
 * Run an authenticated request. A lazily-registered identity is re-registered
 * once if the host rejects it with 401 (e.g. the host restarted with a fresh
 * participants table). Explicit tokens are never silently replaced.
 */
async function withAuth(run) {
  let retried = false
  for (;;) {
    const credentials = await getCredentials()
    try {
      return await run(credentials)
    } catch (error) {
      if (!retried && error.status === 401 && credentials.source === 'lazy') {
        retried = true
        log('identity token was rejected (401); registering a fresh external identity')
        state.credentials = null
        state.credentialsPromise = null
        continue
      }
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`missing required string argument "${key}"`)
  }
  return value
}

function optionalInt(args, key, { min = 0, max } = {}) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) {
    throw new ToolInputError(
      `"${key}" must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ''}`,
    )
  }
  return number
}

async function toolRegister(args) {
  const kind = args.kind === undefined ? 'external' : String(args.kind)
  if (kind !== 'external' && kind !== 'human') {
    throw new ToolInputError('"kind" must be "external" or "human"')
  }
  const body = { kind }
  if (args.handle !== undefined) body.handle = normalizeHandle(args.handle)
  if (args.displayName !== undefined) body.displayName = String(args.displayName)
  if (args.harness !== undefined) {
    const harnessValue = String(args.harness)
    if (!HARNESSES.includes(harnessValue)) {
      throw new ToolInputError(`"harness" must be one of: ${HARNESSES.join(', ')}`)
    }
    body.harness = harnessValue
  } else if (kind === 'external') {
    body.harness = 'other'
  }
  const data = await httpJson('POST', '/register', { body })
  let tokenFile = null
  if (data && typeof data.token === 'string' && typeof data.handle === 'string') {
    const credentials = {
      participantId: typeof data.participantId === 'string' ? data.participantId : null,
      handle: data.handle,
      token: data.token,
      source: 'tool',
    }
    try {
      credentials.path = saveIdentity(credentials)
      tokenFile = credentials.path
    } catch (error) {
      log(`could not save the client token file: ${error.message}`)
    }
    state.credentials = credentials
    state.credentialsPromise = null
    state.handle = data.handle
    log(`channel_register: now using @${data.handle}${tokenFile ? ` (token saved to ${tokenFile})` : ''}`)
  }
  if (data && typeof data === 'object' && typeof data.token === 'string') {
    // Never hand the bearer secret to the model: it is persisted in the 0600
    // client file and used automatically by later tool calls.
    const { token: _bearerToken, ...safe } = data
    return {
      ...safe,
      tokenFile,
      note: 'bearer token saved to the local 0600 client file; it is not returned to the model',
    }
  }
  return data
}

async function toolSend(args) {
  const channel = normalizeChannel(requireString(args, 'channel'))
  let files = []
  if (args.files !== undefined) {
    if (!Array.isArray(args.files)) throw new ToolInputError('"files" must be an array of local file paths')
    files = args.files.map((value) => String(value))
    if (files.some((value) => value.trim() === '')) throw new ToolInputError('"files" must not contain empty paths')
  }
  const textValue = args.text === undefined || args.text === null ? '' : String(args.text)
  if (textValue.trim() === '' && files.length === 0) {
    throw new ToolInputError('channel_send needs "text" or at least one entry in "files"')
  }
  assertText(textValue, { allowEmpty: files.length > 0 })
  // Validate every local file before uploading any of them.
  const plans = planUploads(files)
  const body = { channel, text: textValue }
  if (args.replyTo !== undefined) body.replyTo = String(args.replyTo)
  if (args.mentions !== undefined) {
    if (!Array.isArray(args.mentions)) throw new ToolInputError('"mentions" must be an array of handles')
    const mentions = []
    for (const raw of args.mentions) {
      const handle = normalizeHandle(raw)
      if (!mentions.includes(handle)) mentions.push(handle)
    }
    if (mentions.length > 0) body.mentions = mentions
  }
  if (plans.length === 0) {
    return withAuth((credentials) => httpJson('POST', '/send', { token: credentials.token, body }))
  }
  const uploaded = await withAuth(async (credentials) => {
    const attachments = []
    for (const plan of plans) attachments.push(await uploadAttachment(plan, credentials.token))
    return attachments
  })
  body.attachments = uploaded.map((attachment) => attachment.id)
  const result = await withAuth((credentials) => httpJson('POST', '/send', { token: credentials.token, body }))
  // Report what was uploaded alongside the host's /send response.
  return { ...result, uploaded }
}

async function toolSearch(args) {
  const query = args.query === undefined || args.query === null ? '' : String(args.query).trim()
  if (query === '') throw new ToolInputError('missing required string argument "query"')
  const params = {
    q: query,
    channel: args.channel === undefined || args.channel === null ? undefined : normalizeChannel(args.channel),
    limit: optionalInt(args, 'limit', { min: 1, max: SEARCH_LIMIT }),
    beforeSeq: optionalInt(args, 'beforeSeq', { min: 0 }),
  }
  return withAuth((credentials) => httpJson('GET', '/search', { token: credentials.token, query: params }))
}

async function toolJoin(args, { leave = false } = {}) {
  const channel = normalizeChannel(requireString(args, 'channel'))
  return withAuth((credentials) =>
    httpJson('POST', leave ? '/leave' : '/join', { token: credentials.token, body: { channel } }),
  )
}

async function toolHistory(args) {
  const channel = normalizeChannel(requireString(args, 'channel'))
  const query = {
    channel,
    beforeSeq: optionalInt(args, 'beforeSeq', { min: 0 }),
    afterSeq: optionalInt(args, 'afterSeq', { min: 0 }),
    limit: optionalInt(args, 'limit', { min: 1, max: MAX_PAGE }),
  }
  return withAuth((credentials) => httpJson('GET', '/history', { token: credentials.token, query }))
}

async function toolList() {
  return withAuth((credentials) => httpJson('GET', '/channels', { token: credentials.token }))
}

async function toolMembers(args) {
  const channel = args.channel === undefined || args.channel === null ? undefined : normalizeChannel(args.channel)
  return withAuth((credentials) =>
    httpJson('GET', '/members', { token: credentials.token, query: channel ? { channel } : undefined }),
  )
}

async function toolWhoami() {
  return withAuth((credentials) => httpJson('GET', '/whoami', { token: credentials.token }))
}

async function toolPin(args, { unpin = false } = {}) {
  const channel = normalizeChannel(requireString(args, 'channel'))
  const messageId = requireString(args, 'messageId')
  return withAuth((credentials) =>
    httpJson('POST', unpin ? '/unpin' : '/pin', { token: credentials.token, body: { channel, messageId } }),
  )
}

async function toolAnnounce(args) {
  const channel = normalizeChannel(requireString(args, 'channel'))
  const text = requireString(args, 'text')
  assertText(text)
  return withAuth((credentials) => httpJson('POST', '/announce', { token: credentials.token, body: { channel, text } }))
}

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const channelProperty = {
  type: 'string',
  description: 'Channel id or #channel (lowercase slug, e.g. "general" or "dev").',
}
const textProperty = {
  type: 'string',
  description: `Message text (max ${MAX_TEXT_BYTES} bytes). @handle mentions are parsed by the host as well.`,
}
const handleProperty = {
  type: 'string',
  description: 'Handle: 2-24 chars, lowercase [a-z0-9_-], not a reserved word (all/here/channel/system/everyone).',
}
const harnessSchema = {
  type: 'string',
  enum: HARNESSES,
  description: 'Which external harness this identity belongs to.',
}
const messageIdProperty = {
  type: 'string',
  description: 'Message id, e.g. "general-000042".',
}

const TOOLS = [
  {
    name: 'channel_register',
    description:
      'Register (or re-register) an external identity with the local dsh-channels host and adopt it for later tool calls. Returns participantId, handle and token; the token is also saved to the client token file. Use this once to claim a stable handle across restarts.',
    inputSchema: objectSchema({
      handle: handleProperty,
      displayName: { type: 'string', description: 'Human-readable display name.' },
      harness: harnessSchema,
      kind: { type: 'string', enum: ['external', 'human'], description: 'Identity kind (default external).' },
    }),
  },
  {
    name: 'channel_send',
    description:
      'Send a message to a dsh-channels channel. Messages are immutable and append-only; use replyTo to quote a message. The host wakes DSH agents that are mentioned or replied to. Sub-channels require membership — call channel_join first if you get a not_member error. ' +
      `Text is optional when "files" is given. "files" are LOCAL file paths on the machine running this MCP server (absolute paths recommended; relative paths resolve against the server cwd): each one is uploaded first (max ${MAX_ATTACHMENTS} files, ${humanSize(MAX_ATTACHMENT_BYTES)} each, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} total), then attached to the message by id.`,
    inputSchema: objectSchema(
      {
        channel: channelProperty,
        text: textProperty,
        files: {
          type: 'array',
          items: { type: 'string' },
          description: `Local file paths to upload and attach (max ${MAX_ATTACHMENTS}; ${humanSize(MAX_ATTACHMENT_BYTES)} per file, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} total).`,
        },
        replyTo: messageIdProperty,
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional handles to mention explicitly (in addition to any @handle in the text).',
        },
      },
      ['channel'],
    ),
  },
  {
    name: 'channel_search',
    description:
      'Search message history on the local dsh-channels host. Matching is case-insensitive and multiple words are ANDed; results are newest-first with a short snippet and the full message, including any attachment metadata.',
    inputSchema: objectSchema(
      {
        query: { type: 'string', description: 'Search words (space separated; all must match).' },
        channel: channelProperty,
        limit: { type: 'integer', description: `Maximum hits, 1..${SEARCH_LIMIT}.` },
        beforeSeq: { type: 'integer', description: 'Only messages with seq < beforeSeq (>= 0).' },
      },
      ['query'],
    ),
  },
  {
    name: 'channel_join',
    description:
      'Join a sub-channel so this identity can read its history and post in it (POST /join). Membership is gated: a new identity is only in #general by default, and non-members get 403 not_member from channel_history/channel_send/channel_search. Humans are exempt. Returns { channel, joined, memberCount }.',
    inputSchema: objectSchema({ channel: channelProperty }, ['channel']),
  },
  {
    name: 'channel_leave',
    description:
      'Leave a sub-channel (POST /leave). Messages stay in the channel history; after leaving, channel_history/channel_send for it return 403 not_member until you call channel_join again. Returns { channel, joined, memberCount }.',
    inputSchema: objectSchema({ channel: channelProperty }, ['channel']),
  },
  {
    name: 'channel_history',
    description:
      'Read message history for a channel, oldest first. Use beforeSeq to page backwards (hasMore indicates older messages exist). Sub-channels require membership — call channel_join first if you get a not_member error.',
    inputSchema: objectSchema(
      {
        channel: channelProperty,
        // Keep to the JSON-Schema subset both MCP and DSH's tool registry
        // support (no minimum/maximum keywords — describe the bounds instead).
        beforeSeq: { type: 'integer', description: 'Return messages with seq < beforeSeq (>= 0).' },
        afterSeq: { type: 'integer', description: 'Return messages with seq > afterSeq (>= 0).' },
        limit: { type: 'integer', description: `Page size, 1..${MAX_PAGE}.` },
      },
      ['channel'],
    ),
  },
  {
    name: 'channel_list',
    description:
      'List the channels available on the local dsh-channels host. Each entry includes "joined" (whether this identity may read/write it) and "memberCount"; call channel_join for any sub-channel shown as joined:false.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'channel_members',
    description: 'List channel participants with their presence status, optionally filtered to one channel.',
    inputSchema: objectSchema({ channel: channelProperty }),
  },
  {
    name: 'channel_whoami',
    description: 'Show the identity this MCP server is currently using on the dsh-channels host.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'channel_pin',
    description: 'Pin an immutable message in a channel (pinning is an append-only event).',
    inputSchema: objectSchema({ channel: channelProperty, messageId: messageIdProperty }, ['channel', 'messageId']),
  },
  {
    name: 'channel_unpin',
    description: 'Remove a pin from a channel.',
    inputSchema: objectSchema({ channel: channelProperty, messageId: messageIdProperty }, ['channel', 'messageId']),
  },
  {
    name: 'channel_announce',
    description:
      "Post an announcement message and make it the channel's current announcement. The host rate-limits announcements (10 minutes per identity).",
    inputSchema: objectSchema({ channel: channelProperty, text: textProperty }, ['channel', 'text']),
  },
]

const TOOL_HANDLERS = {
  channel_register: (args) => toolRegister(args),
  channel_send: (args) => toolSend(args),
  channel_history: (args) => toolHistory(args),
  channel_search: (args) => toolSearch(args),
  channel_join: (args) => toolJoin(args),
  channel_leave: (args) => toolJoin(args, { leave: true }),
  channel_list: () => toolList(),
  channel_members: (args) => toolMembers(args),
  channel_whoami: () => toolWhoami(),
  channel_pin: (args) => toolPin(args, { unpin: false }),
  channel_unpin: (args) => toolPin(args, { unpin: true }),
  channel_announce: (args) => toolAnnounce(args),
}

function toolResult(value, isError) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

async function callTool(params) {
  if (!params || typeof params !== 'object') {
    throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: expected { name, arguments }')
  }
  const { name } = params
  if (typeof name !== 'string' || name === '') {
    throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: missing tool "name"')
  }
  const handler = TOOL_HANDLERS[name]
  if (!handler) {
    return toolResult({ error: { code: 'unknown_tool', message: `Unknown tool: ${name}` } }, true)
  }
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
  try {
    const result = await handler(args)
    return toolResult(result === undefined ? null : result, false)
  } catch (error) {
    const code = error?.code ?? 'error'
    const message = error?.message ?? String(error)
    log(`tool ${name} failed: ${code}: ${message}`)
    const channelFromArgs =
      typeof args.channel === 'string' && args.channel.trim() !== ''
        ? args.channel.trim().replace(/^#/, '').toLowerCase()
        : undefined
    const hint = hintForError(error, channelFromArgs)
    const payload = {
      error: {
        code,
        message,
        ...(typeof error?.status === 'number' ? { status: error.status } : {}),
        ...(hint === undefined ? {} : { hint }),
      },
    }
    return toolResult(payload, true)
  }
}

/**
 * Channel-aware tool error hint. SPEC §7.8: 403 not_member means this identity
 * must call channel_join for that channel first.
 */
function hintForError(error, channel) {
  if (error?.code === 'not_member') {
    return channel === undefined
      ? 'not a member of that channel; call channel_join first (or run: channels-cli join <channel>)'
      : `not a member of #${channel}; call channel_join { "channel": "${channel}" } first (or run: channels-cli join ${channel})`
  }
  return typeof error?.status === 'number' ? hintForStatus(error.status) : undefined
}

function hintForStatus(status) {
  if (status === 401) return 'identity token rejected — call channel_register to claim a handle, or pass --token.'
  if (status === 409) return 'that handle is already claimed — use channel_register without a handle, or login with its token.'
  if (status === 403) return 'forbidden by the host — check channel membership (channel_join).'
  if (status === 404) return 'API route not found — check the endpoint url / DSH_CHANNELS_URL.'
  if (status === 413) {
    return `attachment too large — max ${humanSize(MAX_ATTACHMENT_BYTES)} per file, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} per message.`
  }
  if (status === 429) return 'rate limited by the host — wait and retry.'
  if (status === 503) return 'host is readonly (another dsh web process owns the hub).'
  return undefined
}

// ---------------------------------------------------------------------------
// MCP methods
// ---------------------------------------------------------------------------

function initializeResult(params) {
  const requested = params && typeof params === 'object' ? params.protocolVersion : undefined
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION
  if (requested !== undefined && requested !== protocolVersion) {
    log(`client requested protocol ${requested}; negotiated down to ${protocolVersion}`)
  }
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      'Talk to the local dsh-channels host (Discord-style channel IM). Call channel_list first to discover channels (each entry shows "joined"), channel_join to join a sub-channel before reading/posting in it, channel_history to read context, channel_search to find older messages, and channel_send to post (pass local file paths in "files" to attach them). Messages are immutable; @handle mentions and replyTo wake DSH agents that are bound to those handles.',
  }
}

function toolsListResult() {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return initializeResult(params)
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'ping':
      return {}
    case 'tools/list':
      return toolsListResult()
    case 'tools/call':
      return callTool(params)
    default:
      throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// stdio loop
// ---------------------------------------------------------------------------

function sendFrame(frame) {
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  } catch (error) {
    log(`stdout write failed: ${error.message}`)
  }
}

function sendResult(id, result) {
  sendFrame({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
}

function sendError(id, code, message, data) {
  sendFrame({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  })
}

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    sendError(null, PARSE_ERROR, `Parse error: ${error.message}`)
    return
  }
  if (Array.isArray(message)) {
    sendError(null, INVALID_REQUEST, 'Invalid Request: batch requests are not supported')
    return
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = message && typeof message === 'object' && 'id' in message ? message.id : null
    sendError(id, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 request object')
    return
  }
  const hasId =
    Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null && message.id !== undefined
  try {
    const result = await dispatch(message.method, message.params)
    if (hasId) sendResult(message.id, result)
  } catch (error) {
    if (error instanceof JsonRpcError) {
      if (hasId) sendError(message.id, error.code, error.message, error.data)
      else log(`notification ${message.method} failed: ${error.message}`)
    } else {
      log(`internal error handling ${message.method}: ${error?.stack ?? error}`)
      if (hasId) sendError(message.id, INTERNAL_ERROR, `Internal error: ${error?.message ?? String(error)}`)
    }
  }
}

let queue = Promise.resolve()

function shutdown(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.write('', () => process.exit(code))
    return
  }
  process.exitCode = code
  setImmediate(() => process.exit(code))
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  queue = queue
    .then(() => handleLine(trimmed))
    .catch((error) => log(`unexpected error in request queue: ${error?.stack ?? error}`))
})

rl.on('close', () => {
  log('stdin closed; shutting down')
  queue = queue.then(() => shutdown(0))
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error?.stack ?? error}`)
  shutdown(1)
})

process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error?.stack ?? error}`)
})
