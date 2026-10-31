#!/usr/bin/env node
/**
 * dsh-channels CLI — zero-dependency external bridge to a running dsh-channels host.
 *
 * Contract: SPEC.md §5 (HTTP API) + §9 (CLI). Node >= 20, no npm dependencies.
 *
 * M3: `send --file` uploads local files first (POST /upload, raw bytes) and then
 * references their ids from POST /send; `search` queries GET /search; history
 * and search text output summarise message attachments.
 *
 * Discovery:
 *   - endpoint file: $DSH_HOME/channels/endpoint.json  -> { url }   (url already
 *     includes `/channels/api`, e.g. http://127.0.0.1:3080/channels/api)
 *   - identity file: $DSH_HOME/channels/clients/<handle>.json -> { participantId, handle, token } (0600)
 *   - env overrides: DSH_CHANNELS_URL, DSH_CHANNELS_TOKEN (and optional DSH_CHANNELS_HANDLE)
 *
 * Usage: node scripts/channels-cli.mjs --help
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import process from 'node:process'

const VERSION = '0.1.0'
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

// Never crash on a closed pipe (`... | head`), and never let a write error escape.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

let currentCommand = ''

class CliError extends Error {
  constructor(message, { code = 'error', status, hint, exitCode = 1 } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.status = status
    this.hint = hint
    this.exitCode = exitCode
  }
}

class UsageError extends CliError {
  constructor(message) {
    super(message, { code: 'usage', exitCode: 2 })
    this.name = 'UsageError'
  }
}

// ---------------------------------------------------------------------------
// stdio helpers (always awaited so piped output is flushed before exit)
// ---------------------------------------------------------------------------

function writeChunk(stream, chunk) {
  return new Promise((resolve) => {
    try {
      stream.write(chunk, () => resolve())
    } catch {
      resolve()
    }
  })
}

async function outLine(text = '') {
  const s = String(text)
  await writeChunk(process.stdout, s.endsWith('\n') ? s : `${s}\n`)
}

async function errLine(text = '') {
  const s = String(text)
  await writeChunk(process.stderr, s.endsWith('\n') ? s : `${s}\n`)
}

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// discovery: endpoint + identity token file
// ---------------------------------------------------------------------------

function dshHome() {
  const value = process.env.DSH_HOME
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return join(homedir(), '.dsh')
}

function channelsDir() {
  return join(dshHome(), 'channels')
}

function endpointPath() {
  return join(channelsDir(), 'endpoint.json')
}

function clientsDir() {
  return join(channelsDir(), 'clients')
}

function clientFile(handle) {
  return join(clientsDir(), `${handle}.json`)
}

function readEndpointUrl() {
  try {
    const parsed = JSON.parse(readFileSync(endpointPath(), 'utf8'))
    if (parsed && typeof parsed.url === 'string' && parsed.url.trim() !== '') return parsed.url.trim()
  } catch {
    /* missing or malformed endpoint file -> handled by caller */
  }
  return null
}

function normalizeBaseUrl(raw) {
  let value = String(raw).trim()
  if (!/^https?:\/\//i.test(value)) {
    throw new CliError(`invalid API url "${raw}" (expected http(s)://host[:port]/channels/api)`, {
      code: 'invalid_url',
    })
  }
  value = value.replace(/\/+$/, '')
  if (!/\/channels\/api$/.test(value)) value += '/channels/api'
  return value
}

function resolveBaseUrl(flagUrl) {
  const raw = flagUrl ?? process.env.DSH_CHANNELS_URL ?? readEndpointUrl()
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new CliError(
      `dsh-channels endpoint not found.\n  Expected: ${endpointPath()}\n  Start \`dsh web\` with the dsh-channels plugin, then retry.\n  Or set DSH_CHANNELS_URL=http://127.0.0.1:3080/channels/api`,
      { code: 'endpoint_missing' },
    )
  }
  return normalizeBaseUrl(raw)
}

function normalizeHandle(raw) {
  const handle = String(raw).trim().replace(/^@/, '').toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    throw new UsageError(`invalid handle "${raw}" (expected /^[a-z0-9_-]{2,24}$/)`)
  }
  if (RESERVED_HANDLES.has(handle)) throw new UsageError(`handle "${handle}" is reserved`)
  return handle
}

function readIdentity(handle) {
  const path = clientFile(handle)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed.token !== 'string' || parsed.token === '') return null
    return {
      participantId: typeof parsed.participantId === 'string' ? parsed.participantId : null,
      handle: typeof parsed.handle === 'string' && parsed.handle ? parsed.handle : handle,
      token: parsed.token,
      path,
    }
  } catch {
    return null
  }
}

function listIdentities() {
  let names = []
  try {
    names = readdirSync(clientsDir()).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort()) {
    const handle = name.slice(0, -'.json'.length).toLowerCase()
    const identity = readIdentity(handle)
    if (identity) out.push(identity)
  }
  return out
}

/** Persist { participantId, handle, token } with dir 0700 / file 0600. */
function saveIdentity({ participantId, handle, token }) {
  if (!handle || typeof token !== 'string' || token === '') {
    throw new CliError('refusing to save an incomplete identity (missing handle/token)', {
      code: 'bad_response',
    })
  }
  mkdirSync(clientsDir(), { recursive: true, mode: 0o700 })
  const path = clientFile(handle)
  const body = JSON.stringify(
    {
      participantId: participantId ?? null,
      handle,
      token,
    },
    null,
    2,
  )
  writeFileSync(path, `${body}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort on filesystems without chmod */
  }
  return path
}

/**
 * Token resolution order (SPEC §9):
 *   1. --token / DSH_CHANNELS_TOKEN
 *   2. --as <handle> -> clients/<handle>.json
 *   3. DSH_CHANNELS_HANDLE -> clients/<handle>.json
 *   4. the only saved client file, if exactly one exists
 */
function resolveIdentity({ as, token } = {}, options = {}) {
  const explicitToken = token ?? process.env.DSH_CHANNELS_TOKEN
  if (explicitToken) {
    const handleRaw = as ?? process.env.DSH_CHANNELS_HANDLE
    return {
      token: explicitToken,
      handle: handleRaw ? normalizeHandle(handleRaw) : null,
      participantId: null,
      source: 'explicit',
      path: null,
    }
  }
  if (as) {
    const handle = normalizeHandle(as)
    const identity = readIdentity(handle)
    if (!identity) {
      throw new CliError(
        `no saved identity for @${handle}.\n  Expected: ${clientFile(handle)}\n  Create it with: node scripts/channels-cli.mjs register --as ${handle}`,
        { code: 'no_identity' },
      )
    }
    return { ...identity, source: 'file' }
  }
  const envHandle = process.env.DSH_CHANNELS_HANDLE
  if (envHandle) {
    const identity = readIdentity(normalizeHandle(envHandle))
    if (identity) return { ...identity, source: 'file' }
  }
  const saved = listIdentities()
  if (saved.length === 1) return { ...saved[0], source: 'file' }
  if (saved.length > 1) {
    if (options.optional) return null
    throw new CliError(
      `multiple saved identities (${saved.map((item) => `@${item.handle}`).join(', ')}); pick one with --as <handle> or pass --token`,
      { code: 'ambiguous_identity' },
    )
  }
  return null
}

function requireIdentity(identity) {
  if (identity && identity.token) return identity
  throw new CliError(
    `no identity token found.\n  Saved tokens live in ${clientsDir()}/<handle>.json\n  Get one with:  node scripts/channels-cli.mjs register --as <handle>\n  Or restore:    node scripts/channels-cli.mjs login --as <handle> --token <token>\n  (or set DSH_CHANNELS_TOKEN / pass --token)`,
    { code: 'no_identity' },
  )
}

// ---------------------------------------------------------------------------
// HTTP client
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
  const error = new CliError(
    typeof apiError?.message === 'string' && apiError.message
      ? apiError.message
      : text.slice(0, 500) || response.statusText || `HTTP ${response.status}`,
    {
      code: typeof apiError?.code === 'string' ? apiError.code : `http_${response.status}`,
      status: response.status,
    },
  )
  return error
}

async function requestJson(baseUrl, method, path, { query, body, raw, token, timeoutMs = 15_000 } = {}) {
  let url
  try {
    url = new URL(`${baseUrl}${path}`)
  } catch (error) {
    throw new CliError(`invalid request url for ${path}: ${error.message}`, { code: 'invalid_url' })
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
      throw new CliError(`request to ${baseUrl} timed out after ${timeoutMs} ms`, { code: 'timeout' })
    }
    const code = error?.cause?.code ?? error?.code
    throw new CliError(
      `cannot reach dsh-channels host at ${baseUrl}${code ? ` (${code})` : ''}.\n  Start \`dsh web\` with the dsh-channels plugin, then retry.`,
      { code: 'network' },
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

/**
 * Attach a channel-scoped hint for membership errors (SPEC §7.8): a 403 with
 * code `not_member` means this identity must join the channel first.
 */
function channelHint(error, channel) {
  if (error instanceof CliError && error.code === 'not_member') {
    error.channel = channel
    error.hint = `not a member of #${channel}; run: channels-cli join ${channel}`
  }
  return error
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

/** True when the mime type is a browser-inlineable raster image. */
function isInlineImageMime(mime) {
  return typeof mime === 'string' && /^image\/(png|jpeg|gif|webp)$/i.test(mime)
}

/** Best-effort mime from the file extension (host receives it as ?mime=). */
function guessMime(filePath) {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Validate every file before anything is uploaded (SPEC §7.5 limits).
 * Throws a CliError (exit 1) — not a usage error — so callers can distinguish
 * "bad flags" from "bad files".
 */
function planUploads(filePaths) {
  if (filePaths.length > MAX_ATTACHMENTS) {
    throw new CliError(
      `too many files: ${filePaths.length} (max ${MAX_ATTACHMENTS} per message)`,
      { code: 'too_many_files' },
    )
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
      throw new CliError(`${reason}: ${filePath}`, { code: 'file_not_found' })
    }
    if (!info.isFile()) {
      throw new CliError(`not a regular file: ${filePath}`, { code: 'invalid_file' })
    }
    if (info.size === 0) {
      throw new CliError(`file is empty: ${filePath} (the host rejects empty uploads)`, { code: 'file_empty' })
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new CliError(
        `file too large: ${filePath} is ${humanSize(info.size)} (max ${humanSize(MAX_ATTACHMENT_BYTES)} per file)`,
        { code: 'file_too_large' },
      )
    }
    total += info.size
    plans.push({
      path: filePath,
      size: info.size,
      name: basename(filePath),
      mime: guessMime(filePath),
    })
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new CliError(
      `attachments too large: ${humanSize(total)} total (max ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} per message)`,
      { code: 'attachments_too_large' },
    )
  }
  return plans
}

/** POST one file's bytes to /upload and return the attachment metadata. */
async function uploadAttachment(base, plan, token) {
  let bytes
  try {
    bytes = readFileSync(plan.path)
  } catch (error) {
    throw new CliError(`cannot read ${plan.path}: ${error?.code ?? error?.message ?? 'unknown error'}`, {
      code: 'file_not_found',
    })
  }
  const data = await requestJson(base, 'POST', '/upload', {
    token,
    raw: bytes,
    query: { name: plan.name, mime: plan.mime },
    timeoutMs: 120_000,
  })
  const attachment = data?.attachment ?? data
  if (!attachment || typeof attachment.id !== 'string' || attachment.id === '') {
    throw new CliError('host returned an unexpected upload response (missing attachment.id)', { code: 'bad_response' })
  }
  return {
    ...attachment,
    id: attachment.id,
    name: typeof attachment.name === 'string' && attachment.name ? attachment.name : plan.name,
    mime: typeof attachment.mime === 'string' && attachment.mime ? attachment.mime : plan.mime,
    size: typeof attachment.size === 'number' ? attachment.size : plan.size,
  }
}

/** One-line attachment summary used by history / search / send output. */
function formatAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return ''
  return attachments
    .map((attachment) => {
      const name = attachment?.name ?? attachment?.id ?? 'attachment'
      const mime = typeof attachment?.mime === 'string' ? attachment.mime : ''
      if (isInlineImageMime(mime)) return `[img] ${name}`
      return `[file] ${name} (${humanSize(attachment?.size)})`
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const COMMON_VALUE_FLAGS = ['--url', '--token', '--as']
const COMMON_BOOLEAN_FLAGS = ['--json', '--help']

function parseArgs(argv, { values = [], booleans = [] } = {}) {
  const allValues = new Set([...COMMON_VALUE_FLAGS, ...values])
  const allBooleans = new Set([...COMMON_BOOLEAN_FLAGS, ...booleans])
  const positionals = []
  const flags = Object.create(null)

  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index]
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token === '-h') token = '--help'
    const isOption = token.startsWith('-') && token !== '-' && !/^-\d/.test(token)
    if (!isOption) {
      positionals.push(token)
      continue
    }
    let name = token
    let inline
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    if (equals !== -1) {
      name = token.slice(0, equals)
      inline = token.slice(equals + 1)
    }
    if (allBooleans.has(name)) {
      if (inline !== undefined) throw new UsageError(`option ${name} does not take a value`)
      flags[name] = true
      continue
    }
    if (allValues.has(name)) {
      let value = inline
      if (value === undefined) {
        index += 1
        if (index >= argv.length) throw new UsageError(`option ${name} requires a value`)
        value = argv[index]
      }
      ;(flags[name] ??= []).push(value)
      continue
    }
    throw new UsageError(`unknown option "${name}" (run with --help)`)
  }
  return { positionals, flags }
}

const flagOn = (flags, name) => flags[name] === true
const flagValue = (flags, name) => {
  const list = flags[name]
  return Array.isArray(list) ? list[list.length - 1] : undefined
}
const flagValues = (flags, name) => (Array.isArray(flags[name]) ? flags[name] : [])

const wantsJson = (flags, pre) => Boolean(pre.json || flagOn(flags, '--json'))

function intOption(flags, name, { min = 0, max } = {}) {
  const raw = flagValue(flags, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new UsageError(`${name} must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ''}`)
  }
  return value
}

/**
 * Allow the truly global options to appear before the subcommand as well:
 *   channels-cli.mjs --json send "#dev" hi
 */
function splitArgv(argv) {
  const pre = {}
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (token === '--json') {
      pre.json = true
      index += 1
      continue
    }
    if (COMMON_VALUE_FLAGS.includes(token)) {
      const value = argv[index + 1]
      if (value === undefined) throw new UsageError(`option ${token} requires a value`)
      pre[token.slice(2)] = value
      index += 2
      continue
    }
    break
  }
  return { command: argv[index], rest: argv.slice(index + 1), pre }
}

function normalizeChannel(raw) {
  const channel = String(raw).trim().replace(/^#/, '').toLowerCase()
  if (!CHANNEL_RE.test(channel)) {
    throw new UsageError(`invalid channel "${raw}" (expected a slug like general or dev-notes)`)
  }
  return channel
}

function collectMentions(values) {
  const mentions = []
  for (const raw of values) {
    const handle = normalizeHandle(raw)
    if (!mentions.includes(handle)) mentions.push(handle)
  }
  return mentions
}

function assertText(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string') throw new UsageError('message text must be a string')
  if (text.trim() === '' && !allowEmpty) throw new UsageError('message text must not be empty')
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_TEXT_BYTES) {
    throw new UsageError(`message text is ${bytes} bytes; the host limit is ${MAX_TEXT_BYTES} bytes`)
  }
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

const clip = (text, limit = 120) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function formatTime(ts) {
  if (ts === undefined || ts === null) return '--:--:--'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return String(ts)
  return date.toLocaleTimeString('en-GB', { hour12: false })
}

/** HH:MM only — used by the compact search-hit line. */
function formatClock(ts) {
  if (ts === undefined || ts === null) return '--:--'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function formatMessage(message) {
  if (!message || typeof message !== 'object') return String(message)
  const channel = message.channel ?? '?'
  const seq = typeof message.seq === 'number' ? String(message.seq).padStart(4, '0') : '????'
  const handle =
    message.author?.handle ??
    message.author?.displayName ??
    (typeof message.author === 'string' ? message.author : '?')
  const parts = [`[#${channel} ${seq}]`, formatTime(message.ts), `@${handle}:`]
  if (message.kind === 'announcement') parts.splice(1, 0, '[announcement]')
  let line = `${parts.join(' ')} ${String(message.text ?? '')}`.trimEnd()
  if (message.replyTo) {
    const author = message.replyTo.authorName ?? message.replyTo.author?.handle ?? '?'
    line += `  ↳ replying to @${author}: "${clip(message.replyTo.excerpt, 60)}"`
  }
  if (Array.isArray(message.mentions) && message.mentions.length > 0) {
    line += `  [mentions: ${message.mentions.map((handle) => `@${handle}`).join(' ')}]`
  }
  const attachments = formatAttachments(message.attachments)
  if (attachments !== '') line += `  ${attachments}`
  return line
}

/** `#channel 000123 @author 22:10  snippet` (SPEC §9 search output). */
function formatHit(hit) {
  const message = hit?.message ?? {}
  const channel = hit?.channel ?? message.channel ?? '?'
  const seq = typeof message.seq === 'number' ? String(message.seq).padStart(6, '0') : '??????'
  const handle = message.author?.handle ?? message.author?.displayName ?? '?'
  let snippet = typeof hit?.snippet === 'string' ? hit.snippet.replace(/\s+/g, ' ').trim() : ''
  if (snippet === '') snippet = clip(message.text, 160)
  if (snippet === '') snippet = formatAttachments(message.attachments) || '(no text)'
  return `#${channel} ${seq} @${handle} ${formatClock(message.ts)}  ${snippet}`
}

function formatChannel(channel) {
  if (!channel || typeof channel !== 'object') return String(channel)
  const id = channel.id ?? channel.channel ?? '?'
  const parts = [`#${id}`]
  if (channel.name && channel.name !== id) parts.push(`(${channel.name})`)
  if (channel.topic) parts.push(`— ${channel.topic}`)
  if (channel.category) parts.push(`[${channel.category}]`)
  // SPEC §7.8: ChannelView carries the caller's membership view.
  if (channel.joined === false) parts.push('(未加入)')
  else if (typeof channel.memberCount === 'number') parts.push(`${channel.memberCount} ${channel.memberCount === 1 ? 'member' : 'members'}`)
  const pinCount = Array.isArray(channel.pins) ? channel.pins.length : 0
  if (pinCount > 0) parts.push(`${pinCount} pinned`)
  if (channel.announcementId) parts.push('has announcement')
  if (typeof channel.unread === 'number' && channel.unread > 0) parts.push(`${channel.unread} unread`)
  return parts.join('  ')
}

function formatMember(participant) {
  if (!participant || typeof participant !== 'object') return String(participant)
  const handle = participant.handle ?? participant.id ?? '?'
  const parts = [`@${handle}`]
  if (participant.displayName && participant.displayName !== handle) parts.push(`(${participant.displayName})`)
  const kind = [participant.kind, participant.harness].filter(Boolean).join('/')
  if (kind) parts.push(kind)
  if (participant.status) parts.push(participant.status)
  if (participant.binding?.kind === 'dsh-session') parts.push(`session:${participant.binding.sessionId}`)
  return parts.join('  ')
}

function listOf(data, keys) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdChannels(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp('channels')
  if (positionals.length > 0 && positionals[0] !== 'list') {
    throw new UsageError(`unexpected argument "${positionals[0]}" — usage: channels [list]`)
  }
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  // Read-only endpoints are trusted for loopback callers (SPEC §5 v1 trust);
  // use the saved token when there is one, otherwise read anonymously.
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  const data = await requestJson(base, 'GET', '/channels', { token: identity?.token })
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const channels = listOf(data, ['channels'])
  if (channels === null) return outLine(pretty(data))
  if (channels.length === 0) return outLine('no channels yet')
  for (const channel of channels) await outLine(formatChannel(channel))
}

async function cmdRegister(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--name', '--harness', '--kind'] })
  if (flagOn(flags, '--help')) return printHelp('register')
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}" — usage: register --as <handle>`)
  const kind = flagValue(flags, '--kind') ?? 'external'
  if (kind !== 'external' && kind !== 'human') {
    throw new UsageError('--kind must be "external" or "human" (dsh-agent identities are created by DSH itself)')
  }
  const harnessRaw = flagValue(flags, '--harness')
  const harness = harnessRaw === undefined ? (kind === 'external' ? 'other' : undefined) : String(harnessRaw).trim().toLowerCase()
  if (harness !== undefined && !HARNESSES.includes(harness)) {
    throw new UsageError(`--harness must be one of: ${HARNESSES.join(', ')}`)
  }
  const asRaw = flagValue(flags, '--as') ?? pre.as
  const handle = asRaw === undefined ? undefined : normalizeHandle(asRaw)
  const displayName = flagValue(flags, '--name')
  const body = { kind }
  if (handle !== undefined) body.handle = handle
  if (displayName !== undefined) body.displayName = String(displayName)
  if (harness !== undefined) body.harness = harness

  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const data = await requestJson(base, 'POST', '/register', { body })
  const registeredHandle = data?.handle ?? handle
  const token = data?.token
  if (typeof registeredHandle !== 'string' || typeof token !== 'string' || token === '') {
    throw new CliError('host returned an unexpected register response (missing handle/token)', { code: 'bad_response' })
  }
  const saved = saveIdentity({ participantId: data.participantId ?? data.id ?? null, handle: registeredHandle, token })
  if (wantsJson(flags, pre)) {
    return outLine(pretty({ ...data, tokenFile: saved }))
  }
  await outLine(`registered @${registeredHandle} (participantId=${data.participantId ?? data.id ?? '?'})`)
  await outLine(`token saved: ${saved}`)
  await outLine('next: node scripts/channels-cli.mjs channels')
}

async function cmdLogin(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp('login')
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}" — usage: login --as <handle> [--token <token>]`)
  const asRaw = flagValue(flags, '--as') ?? pre.as
  if (asRaw === undefined) throw new UsageError('login requires --as <handle>')
  const handle = normalizeHandle(asRaw)
  let token = flagValue(flags, '--token') ?? pre.token ?? process.env.DSH_CHANNELS_TOKEN
  if (!token) {
    const saved = readIdentity(handle)
    if (saved) token = saved.token
  }
  if (!token) {
    throw new UsageError(`login requires --token <token> (no saved client file for @${handle} at ${clientFile(handle)})`)
  }
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const data = await requestJson(base, 'POST', '/login', { body: { handle, token } })
  const participant = data?.participant ?? data
  const participantId = participant?.id ?? participant?.participantId ?? null
  const saved = saveIdentity({
    participantId,
    handle: typeof participant?.handle === 'string' && participant.handle ? participant.handle : handle,
    token,
  })
  if (wantsJson(flags, pre)) return outLine(pretty({ participant: data, tokenFile: saved }))
  await outLine(`logged in as @${participant?.handle ?? handle}${participantId ? ` (participantId=${participantId})` : ''}`)
  await outLine(`token saved: ${saved}`)
}

async function cmdSend(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--reply', '--mention', '--file'] })
  if (flagOn(flags, '--help')) return printHelp('send')
  if (positionals.length < 1) {
    throw new UsageError('usage: send <#channel|channel> [text...] [--file <path>]... [--reply <messageId>] [--mention <handle>]...')
  }
  const channel = normalizeChannel(positionals[0])
  const rawText = positionals.slice(1).join(' ')
  const filePaths = flagValues(flags, '--file').map((value) => String(value))
  if (rawText.trim() === '' && filePaths.length === 0) {
    throw new UsageError('send needs message text or at least one --file')
  }
  // Local validation happens before any upload so a bad set never half-uploads.
  const plans = planUploads(filePaths)
  const text = rawText.trim() === '' ? '' : rawText
  assertText(text, { allowEmpty: plans.length > 0 })

  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = requireIdentity(resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }))
  const json = wantsJson(flags, pre)

  const uploaded = []
  for (const plan of plans) {
    if (!json) await errLine(`[channels-cli] uploading ${plan.name} (${humanSize(plan.size)})…`)
    uploaded.push(await uploadAttachment(base, plan, identity.token))
  }

  const body = { channel, text }
  const replyTo = flagValue(flags, '--reply')
  if (replyTo !== undefined && String(replyTo).trim() !== '') body.replyTo = String(replyTo).trim()
  const mentions = collectMentions(flagValues(flags, '--mention'))
  if (mentions.length > 0) body.mentions = mentions
  if (uploaded.length > 0) body.attachments = uploaded.map((attachment) => attachment.id)

  let data
  try {
    data = await requestJson(base, 'POST', '/send', { token: identity.token, body })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (json) {
    // Keep the raw /send response, but also report what was uploaded.
    return outLine(pretty({ ...data, uploaded: uploaded.length > 0 ? uploaded : undefined }))
  }
  const message = data?.message ?? data
  const suffix = uploaded.length > 0 ? ` attachments=${uploaded.map((attachment) => attachment.name).join(',')}` : ''
  await outLine(`sent #${message?.channel ?? channel} id=${message?.id ?? '?'} seq=${message?.seq ?? '?'}${suffix}`)
}

async function cmdSearch(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--channel', '--limit', '--before'] })
  if (flagOn(flags, '--help')) return printHelp('search')
  const query = positionals.join(' ').trim()
  if (query === '') throw new UsageError('usage: search <query...> [--channel <id>] [--limit N] [--before <seq>]')
  const channelRaw = flagValue(flags, '--channel')
  const channel = channelRaw === undefined ? undefined : normalizeChannel(channelRaw)
  const params = {
    q: query,
    channel,
    limit: intOption(flags, '--limit', { min: 1, max: SEARCH_LIMIT }),
    beforeSeq: intOption(flags, '--before', { min: 0 }),
  }
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  // Search is a read: trusted loopback callers may query without a token.
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  let data
  try {
    data = await requestJson(base, 'GET', '/search', { token: identity?.token, query: params })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const hits = listOf(data, ['hits']) ?? []
  if (hits.length === 0) {
    await outLine(`no matches for "${query}"${channel ? ` in #${channel}` : ''}`)
    return
  }
  for (const hit of hits) await outLine(formatHit(hit))
  if (data?.hasMore) await outLine('… more results available (narrow the query or page with --before)')
}

async function cmdHistory(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--limit', '--before', '--after'] })
  if (flagOn(flags, '--help')) return printHelp('history')
  if (positionals.length < 1) throw new UsageError('usage: history <channel> [--limit N] [--before <seq>] [--after <seq>]')
  const channel = normalizeChannel(positionals[0])
  const query = {
    channel,
    limit: intOption(flags, '--limit', { min: 1, max: MAX_PAGE }),
    beforeSeq: intOption(flags, '--before', { min: 0 }),
    afterSeq: intOption(flags, '--after', { min: 0 }),
  }
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  let data
  try {
    data = await requestJson(base, 'GET', '/history', { token: identity?.token, query })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const messages = listOf(data, ['messages']) ?? []
  if (messages.length === 0) {
    await outLine(`no messages in #${channel}${query.beforeSeq !== undefined || query.afterSeq !== undefined ? ' for that range' : ''}`)
    return
  }
  for (const message of messages) await outLine(formatMessage(message))
  if (data?.hasMore) {
    const oldest = messages[0]?.seq
    await outLine(`… more messages available${oldest !== undefined ? ` (use --before ${oldest})` : ''}`)
  }
}

async function cmdMembers(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--channel'] })
  if (flagOn(flags, '--help')) return printHelp('members')
  const channelRaw = positionals[0] ?? flagValue(flags, '--channel')
  const channel = channelRaw === undefined ? undefined : normalizeChannel(channelRaw)
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  const data = await requestJson(base, 'GET', '/members', { token: identity?.token, query: channel ? { channel } : undefined })
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const members = listOf(data, ['members', 'participants'])
  if (members === null) return outLine(pretty(data))
  if (members.length === 0) return outLine(`no members${channel ? ` in #${channel}` : ''}`)
  for (const member of members) await outLine(formatMember(member))
}

async function cmdWhoami(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp('whoami')
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}" — usage: whoami`)
  const json = wantsJson(flags, pre)
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  if (!identity || !identity.token) {
    if (json) return outLine(pretty({ participant: null }))
    return outLine('not authenticated — no saved identity (run register/login, or set DSH_CHANNELS_TOKEN)')
  }
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const data = await requestJson(base, 'GET', '/whoami', { token: identity.token })
  if (json) return outLine(pretty(data))
  const participant = data?.participant ?? data
  if (!participant || typeof participant !== 'object') return outLine('not authenticated')
  await outLine(formatMember(participant))
}

async function cmdPins(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp('pins')
  if (positionals.length < 1) throw new UsageError('usage: pins <channel>')
  const channel = normalizeChannel(positionals[0])
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true })
  let data
  try {
    data = await requestJson(base, 'GET', '/pins', { token: identity?.token, query: { channel } })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  // The host returns { channel, messages, pins }; prefer the hydrated messages.
  const pins = listOf(data, ['messages', 'pins'])
  if (pins === null) return outLine(pretty(data))
  if (pins.length === 0) return outLine(`no pinned messages in #${channel}`)
  for (const item of pins) {
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      await outLine(formatMessage(item))
    } else if (item && typeof item === 'object' && item.messageId) {
      await outLine(`pinned ${item.messageId} by ${item.by ?? '?'} at ${item.at ?? '?'}`)
    } else {
      await outLine(JSON.stringify(item))
    }
  }
}

async function cmdPin(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp(currentCommand)
  if (positionals.length < 2) throw new UsageError(`usage: ${currentCommand} <channel> <messageId>`)
  const channel = normalizeChannel(positionals[0])
  const messageId = String(positionals[1]).trim()
  if (messageId === '') throw new UsageError('missing messageId')
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = requireIdentity(resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }))
  let data
  try {
    data = await requestJson(base, 'POST', `/${currentCommand}`, { token: identity.token, body: { channel, messageId } })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  await outLine(`${currentCommand === 'pin' ? 'pinned' : 'unpinned'} ${messageId} in #${channel}`)
}

async function cmdAnnounce(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp('announce')
  if (positionals.length < 2) throw new UsageError('usage: announce <channel> <text...>')
  const channel = normalizeChannel(positionals[0])
  const text = positionals.slice(1).join(' ')
  assertText(text)
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = requireIdentity(resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }))
  let data
  try {
    data = await requestJson(base, 'POST', '/announce', { token: identity.token, body: { channel, text } })
  } catch (error) {
    throw channelHint(error, channel)
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const message = data?.message ?? data
  await outLine(`announced in #${channel}${message?.id ? ` id=${message.id}` : ''}: ${clip(text, 80)}`)
}

async function cmdJoin(argv, pre) {
  const { positionals, flags } = parseArgs(argv)
  if (flagOn(flags, '--help')) return printHelp(currentCommand)
  if (positionals.length < 1) throw new UsageError(`usage: ${currentCommand} <channel>`)
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument "${positionals[1]}" — usage: ${currentCommand} <channel>`)
  }
  const channel = normalizeChannel(positionals[0])
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  const identity = requireIdentity(resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }))
  let data
  try {
    data = await requestJson(base, 'POST', `/${currentCommand}`, { token: identity.token, body: { channel } })
  } catch (error) {
    // Leaving/joining an unknown channel is a plain API error; keep the message.
    throw error
  }
  if (wantsJson(flags, pre)) return outLine(pretty(data))
  const verb = currentCommand === 'join' ? 'joined' : 'left'
  const resolved = typeof data?.channel === 'string' && data.channel ? data.channel : channel
  let suffix = ''
  if (typeof data?.memberCount === 'number') {
    suffix = ` (${data.memberCount} ${data.memberCount === 1 ? 'member' : 'members'})`
  }
  await outLine(`${verb} #${resolved}${suffix}`)
}

// ---------------------------------------------------------------------------
// SSE listener
// ---------------------------------------------------------------------------

/**
 * Parse a `text/event-stream` body. Calls `dispatch(eventName, parsedJson, rawLine)`
 * once per event. Tolerant to CRLF and to non-JSON data payloads.
 */
async function readSseStream(stream, dispatch) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines = []

  const flushEvent = async () => {
    if (dataLines.length === 0) {
      eventName = 'message'
      return
    }
    const raw = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = 'message'
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
    await dispatch(name, parsed, raw)
  }

  const processLine = async (line) => {
    if (line === '') return flushEvent()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        await processLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      let line = buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      await processLine(line)
    }
    await flushEvent()
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

async function streamOnce({ base, identity, channel, afterSeq, json, onSeq }) {
  const url = new URL(`${base}/stream`)
  if (identity.token) url.searchParams.set('token', identity.token)
  if (identity.participantId) url.searchParams.set('participant', identity.participantId)
  if (afterSeq !== undefined && afterSeq !== null) url.searchParams.set('afterSeq', String(afterSeq))
  const headers = { Accept: 'text/event-stream' }
  if (identity.token) headers.Authorization = `Bearer ${identity.token}`

  let response
  try {
    response = await fetch(url, { headers, signal: signalForStream() })
  } catch (error) {
    if (error?.name === 'AbortError') return
    throw new CliError(
      `cannot reach dsh-channels host at ${base}${error?.cause?.code ? ` (${error.cause.code})` : ''}.\n  Start \`dsh web\` with the dsh-channels plugin, then retry.`,
      { code: 'network' },
    )
  }
  if (!response.ok) throw await toApiError(response)
  if (!response.body) throw new CliError('host returned an empty stream body', { code: 'bad_response' })

  await readSseStream(response.body, async (eventName, data) => {
    let message = null
    if (data && typeof data === 'object') {
      if (data.message && typeof data.message === 'object') message = data.message
      else if (typeof data.text === 'string' && typeof data.channel === 'string') message = data
    }
    if (message && typeof message.seq === 'number') onSeq?.(message.seq)
    if (json) {
      const raw = typeof data === 'object' ? JSON.stringify(data) : String(data)
      await outLine(raw)
      return
    }
    if (message && (channel === null || message.channel === channel)) {
      await outLine(formatMessage(message))
    }
    void eventName
  })
}

// The AbortController for the active stream, so SIGINT can stop it cleanly.
let streamAbort = null
const signalForStream = () => streamAbort.signal

async function cmdListen(argv, pre) {
  const { positionals, flags } = parseArgs(argv, { values: ['--after'], booleans: ['--reconnect'] })
  if (flagOn(flags, '--help')) return printHelp('listen')
  if (positionals.length > 1) throw new UsageError('usage: listen [channel] [--after <seq>] [--reconnect]')
  const channel = positionals.length === 1 ? normalizeChannel(positionals[0]) : null
  let afterSeq = intOption(flags, '--after', { min: 0 })
  let lastSeq = afterSeq
  const reconnect = flagOn(flags, '--reconnect')
  const json = wantsJson(flags, pre)
  const base = resolveBaseUrl(flagValue(flags, '--url') ?? pre.url)
  // Token is optional for tokenless loopback streams; send it when available.
  const identity = resolveIdentity({ as: flagValue(flags, '--as') ?? pre.as, token: flagValue(flags, '--token') ?? pre.token }, { optional: true }) ?? { token: null, handle: null, participantId: null }

  let stopped = false
  streamAbort = new AbortController()
  const stop = () => {
    stopped = true
    streamAbort.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await errLine(
    `[channels-cli] listening${channel ? ` on #${channel}` : ' on all channels'}${identity.handle ? ` as @${identity.handle}` : ''} — Ctrl-C to stop`,
  )

  let attempt = 0
  try {
    while (!stopped) {
      try {
        await streamOnce({
          base,
          identity,
          channel,
          afterSeq,
          json,
          onSeq: (seq) => {
            lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq)
          },
        })
        attempt = 0
        if (stopped || !reconnect) break
        await errLine('[channels-cli] stream closed by host; reconnecting…')
        await sleep(1000)
      } catch (error) {
        if (stopped || error?.name === 'AbortError') break
        if (!reconnect) throw error
        attempt += 1
        const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5))
        await errLine(`[channels-cli] stream error: ${error.message} — retrying in ${Math.round(delayMs / 1000)}s`)
        await sleep(delayMs)
      }
      // Resume after the newest sequence we already printed.
      afterSeq = lastSeq
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    streamAbort = null
  }
}

// ---------------------------------------------------------------------------
// help / dispatch / main
// ---------------------------------------------------------------------------

const COMMAND_HELP = {
  channels: {
    usage: 'channels [list]',
    summary:
      'List channels on the host (GET /channels).\nEach line shows the channel and marks sub-channels this identity has not joined yet with (未加入); joined channels show their member count.',
    options: [],
  },
  register: {
    usage: 'register [--as <handle>] [--name <displayName>] [--harness <name>] [--kind external|human]',
    summary:
      'Register an external identity and save its bearer token to the clients dir (POST /register).\nThe handle is claimed if free; a 409 means it already belongs to someone else.',
    options: [
      ['--as <handle>', 'desired handle (2-24 chars, /^[a-z0-9_-]+$/; omitted -> server assigns one)'],
      ['--name <text>', 'display name shown to humans'],
      [`--harness <name>`, `one of ${HARNESSES.join(', ')} (default: other)`],
      ['--kind <kind>', 'external (default) or human'],
    ],
  },
  login: {
    usage: 'login --as <handle> [--token <token>]',
    summary: 'Restore a saved identity (POST /login) and refresh its token file.',
    options: [
      ['--as <handle>', 'identity handle (required)'],
      ['--token <token>', 'bearer token; falls back to the saved client file'],
    ],
  },
  send: {
    usage: 'send <#channel|channel> [text...] [--file <path>]... [--reply <messageId>] [--mention <handle>]...',
    summary:
      'Post a message (POST /send). Text is optional when at least one --file is given.\nEach --file is uploaded first (POST /upload, raw bytes) and referenced by id.\nLimits: max ' +
      `${MAX_ATTACHMENTS} files, ${humanSize(MAX_ATTACHMENT_BYTES)} each, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} total. Quote spaces by shell-quoting the text.`,
    options: [
      ['--file <path>', `local file to upload and attach; repeatable (max ${MAX_ATTACHMENTS})`],
      ['--reply <messageId>', 'attach a reply reference'],
      ['--mention <handle>', 'add an explicit mention; repeatable'],
    ],
  },
  join: {
    usage: 'join <channel>',
    summary:
      'Join a sub-channel (POST /join) so you can read its history and post in it.\nNew identities are only in #general by default; non-members get 403 not_member from history/send. Humans are exempt.',
    options: [],
  },
  leave: {
    usage: 'leave <channel>',
    summary:
      'Leave a sub-channel (POST /leave). Messages stay in the history; after leaving,\nhistory/send for that channel return 403 not_member until you join again.',
    options: [],
  },
  search: {
    usage: 'search <query...> [--channel <id>] [--limit N] [--before <seq>]',
    summary:
      'Search message history (GET /search): case-insensitive, multiple words are ANDed.\nText output is one hit per line: #channel seq @author HH:MM  snippet.',
    options: [
      ['--channel <id>', 'restrict the search to one channel'],
      ['--limit <N>', `maximum hits 1..${SEARCH_LIMIT}`],
      ['--before <seq>', 'only messages with seq < before'],
    ],
  },
  history: {
    usage: 'history <channel> [--limit N] [--before <seq>] [--after <seq>]',
    summary: 'Read history oldest-first (GET /history); use --before to page backwards.',
    options: [
      ['--limit <N>', `page size 1..${MAX_PAGE}`],
      ['--before <seq>', 'only messages with seq < before'],
      ['--after <seq>', 'only messages with seq > after'],
    ],
  },
  members: {
    usage: 'members [channel]',
    summary: 'List participants with presence (GET /members).',
    options: [],
  },
  whoami: {
    usage: 'whoami',
    summary: 'Show the identity the CLI resolves from the token file (GET /whoami).',
    options: [],
  },
  listen: {
    usage: 'listen [channel] [--after <seq>] [--reconnect]',
    summary: 'Stream messages over SSE (GET /stream). One line per message; --json prints each raw frame.',
    options: [
      ['--after <seq>', 'resume after this sequence number'],
      ['--reconnect', 'reconnect with exponential backoff when the stream drops'],
    ],
  },
  pins: {
    usage: 'pins <channel>',
    summary: 'List pinned messages (GET /pins).',
    options: [],
  },
  pin: {
    usage: 'pin <channel> <messageId>',
    summary: 'Pin a message (POST /pin).',
    options: [],
  },
  unpin: {
    usage: 'unpin <channel> <messageId>',
    summary: 'Remove a pin (POST /unpin).',
    options: [],
  },
  announce: {
    usage: 'announce <channel> <text...>',
    summary: 'Post an announcement message and make it the channel announcement (POST /announce).',
    options: [],
  },
}

function mainHelp() {
  return `dsh-channels CLI ${VERSION} — talk to a running dsh-channels host (SPEC §5 HTTP API)

Usage:
  node scripts/channels-cli.mjs <command> [args] [options]

Commands:
  channels [list]                     list channels (marks ones you have not joined)
  register [--as <handle>] ...        register an external identity and save its token
  login --as <handle> [--token <t>]   restore a saved identity
  send <channel> [text...]            send a message (add --file <path> to attach)
  join <channel>                      join a sub-channel (gain read/send access)
  leave <channel>                     leave a sub-channel
  search <query...> [options]         search message history
  history <channel> [options]         read history (oldest first, shows attachments)
  members [channel]                   list participants / presence
  whoami                              show the current identity
  listen [channel] [--after <seq>]    stream messages over SSE
  pins <channel>                      list pinned messages
  pin <channel> <messageId>           pin a message
  unpin <channel> <messageId>         unpin a message
  announce <channel> <text...>        post an announcement
  help [command]                      show help
  version                             print the CLI version

Options:
  --json                machine-readable JSON output
  --as <handle>         identity handle (selects the saved client token file)
  --token <token>       bearer token (overrides the token file)
  --url <url>           API base url (overrides the endpoint file)
  -h, --help            show help

Discovery:
  endpoint:  $DSH_HOME/channels/endpoint.json   (default ~/.dsh/channels/endpoint.json)
             contents: { "url": "http://127.0.0.1:3080/channels/api" }
  identity:  $DSH_HOME/channels/clients/<handle>.json  ({ participantId, handle, token }, mode 0600)
  env:       DSH_CHANNELS_URL, DSH_CHANNELS_TOKEN (and optional DSH_CHANNELS_HANDLE)

The endpoint file is written by the host. Start \`dsh web\` with the dsh-channels plugin,
then retry. Attachments: --file is repeatable (max ${MAX_ATTACHMENTS} files,
${humanSize(MAX_ATTACHMENT_BYTES)} each, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} total). Examples:
  node scripts/channels-cli.mjs register --as codex-1 --harness codex
  node scripts/channels-cli.mjs send '#dev' 'hello from codex'
  node scripts/channels-cli.mjs send '#dev' 'see attached' --file ./screenshot.png
  node scripts/channels-cli.mjs search 'screenshot' --channel dev --limit 10
  node scripts/channels-cli.mjs listen '#dev'
`
}

async function printHelp(topic) {
  if (topic && COMMAND_HELP[topic]) {
    const entry = COMMAND_HELP[topic]
    const lines = [`dsh-channels CLI ${VERSION} — ${topic}`, '', `Usage: node scripts/channels-cli.mjs ${entry.usage}`, '', entry.summary]
    if (entry.options.length > 0) {
      lines.push('', 'Options:')
      for (const [flag, description] of entry.options) lines.push(`  ${flag.padEnd(24)} ${description}`)
    }
    lines.push('', 'Common options: --json, --as <handle>, --token <token>, --url <url>, -h/--help')
    await outLine(lines.join('\n'))
    return undefined
  }
  await outLine(mainHelp())
  return undefined
}

const COMMANDS = {
  channels: cmdChannels,
  register: cmdRegister,
  login: cmdLogin,
  send: cmdSend,
  search: cmdSearch,
  history: cmdHistory,
  members: cmdMembers,
  whoami: cmdWhoami,
  listen: cmdListen,
  pins: cmdPins,
  pin: cmdPin,
  unpin: cmdPin,
  announce: cmdAnnounce,
  join: cmdJoin,
  leave: cmdJoin,
}

function defaultHint(error) {
  const status = error.status
  if (error.code === 'not_member') {
    const channel = error.channel
    return channel
      ? `not a member of #${channel}; run: channels-cli join ${channel}`
      : 'not a member of that channel; run: channels-cli join <channel>'
  }
  if (status === 401) return 'identity token rejected — run: register --as <handle> (or login with a valid token)'
  if (status === 409) {
    return currentCommand === 'register'
      ? 'that handle is already claimed — pick another --as, or login with its token'
      : 'conflict with the current host state; re-read with the matching command'
  }
  if (status === 404) return `API route not found — the host may not have dsh-channels mounted (check DSH_CHANNELS_URL / ${endpointPath()})`
  if (status === 413) return `attachment too large — max ${humanSize(MAX_ATTACHMENT_BYTES)} per file, ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)} per message`
  if (status === 429) return 'rate limited by the host — wait a moment and retry'
  if (status === 503) return 'host is readonly (another dsh web process owns the hub); stop it and retry'
  if (error.code === 'endpoint_missing') return 'start `dsh web` with the dsh-channels plugin'
  if (error.code === 'network') return 'is `dsh web` running with the dsh-channels plugin?'
  if (error.code === 'no_identity') return 'run `register --as <handle>` once to create a token file'
  return undefined
}

async function main(rawArgv) {
  const { command, rest, pre } = splitArgv(rawArgv)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const topic = command === 'help' ? rest[0] : undefined
    await printHelp(topic)
    return 0
  }
  if (command === '--version' || command === 'version' || command === '-v') {
    await outLine(`dsh-channels-cli ${VERSION}`)
    return 0
  }
  const handler = COMMANDS[command]
  if (!handler) {
    throw new UsageError(`unknown command "${command}" — run with --help for the command list`)
  }
  currentCommand = command
  await handler(rest, pre)
  return 0
}

const rawArgv = process.argv.slice(2)
const jsonErrors = rawArgv.some((token) => token === '--json')

let exitCode = 0
try {
  exitCode = await main(rawArgv)
} catch (error) {
  const cliError = error instanceof CliError ? error : new CliError(error?.message ?? String(error))
  if (jsonErrors) {
    const payload = {
      error: {
        code: cliError.code,
        message: cliError.message,
        ...(typeof cliError.status === 'number' ? { status: cliError.status } : {}),
      },
    }
    await writeChunk(process.stderr, `${JSON.stringify(payload)}\n`)
  } else {
    await errLine(`error: ${cliError.message}`)
    const hint = cliError.hint ?? defaultHint(cliError)
    if (hint) await errLine(`hint: ${hint}`)
    if (cliError instanceof UsageError) await errLine('run `node scripts/channels-cli.mjs --help` for usage')
  }
  exitCode = cliError.exitCode ?? 1
}

process.exit(exitCode)
