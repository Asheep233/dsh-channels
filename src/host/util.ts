/**
 * dsh-channels host utilities.
 *
 * Zero-dependency primitives shared by the host modules: paths, atomic state
 * writes, the single-writer hub lock, a keyed serial queue, append-only JSONL
 * helpers (tolerant of a trailing partial line), ids and token hashing.
 *
 * Only `node:` builtins and `../contract.js` may be imported here.
 */

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { Participant } from '../contract.js'

// ---------------------------------------------------------------------------
// Minimal host shapes: declare only what this plugin touches so the host half
// has ZERO runtime dependency on @deepseek-ai/*.
// ---------------------------------------------------------------------------

/** Text-only content block shape accepted by `Agent.followup` / `prompt`. */
export interface TextBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** One durable user message accepted by `Agent.followup` / `Agent.steer`. */
export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly TextBlockLike[]
  readonly source: { readonly kind: string }
}

/** The live-agent face this plugin uses (session ids double as agent ids). */
export interface AgentLike {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
  followup?(message: UserMessageLike): void
  steer?(message: UserMessageLike): void
}

/** A registered web route (see `@deepseek-ai/dsh-host-webserver`). */
export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebRouteLike): () => void
  getOrigin?(): string
  readonly port?: number
  readonly host?: string
}

export interface ToolsLike {
  register(definition: unknown): () => void
}

export interface AgentsLike {
  list(): readonly AgentLike[]
  get?(id: string): AgentLike | undefined
}

export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** Cordis context subset used by the host half. */
export interface CtxLike {
  effect(execute: () => (() => unknown) | Iterable<() => unknown>, label?: string): unknown
  get(name: string): any
  logger: LoggerLike
  /** Event bus (mixed onto Cordis contexts): returns the exact disposer. */
  on?(event: string, listener: (...args: any[]) => void): () => void
}

/** Read one service defensively: an absent/renamed service must not throw. */
export function service(ctx: CtxLike, name: string): any {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** DSH home directory: `$DSH_HOME` first, else `~/.dsh`. */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** Resolve the channels data directory from config (default `$DSH_HOME/channels`). */
export function resolveDataDir(configured?: unknown): string {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const fromEnv = process.env.DSH_CHANNELS_DATA_DIR?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(dshHome(), 'channels')
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function ensureParent(file: string): void {
  ensureDir(dirname(file))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Expected, API-shaped failure. The HTTP layer maps `status`/`code`; the tool
 * layer turns it into `{ ok: false, error: { code, message } }` instead of
 * throwing out of a turn.
 */
export class HostError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HostError'
    this.code = code
    this.status = status
  }
}

/** Human-readable text for an unknown thrown value. */
export function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}

// ---------------------------------------------------------------------------
// JSON / file helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON file; missing or malformed content yields undefined. */
export function readJsonFile<T>(file: string): T | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return undefined
  }
}

/** Read a text file, or undefined when it does not exist / is unreadable. */
export function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Write a file atomically: temp sibling + rename (same directory, same filesystem). */
export function writeFileAtomic(file: string, text: string): void {
  ensureParent(file)
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort cleanup */
    }
    throw error
  }
}

/** Atomically replace a JSON state file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value)}\n`)
}

/**
 * Append one JSON line. The caller owns a read/write descriptor opened with the
 * `'a+'` flag. If the file's tail is an unterminated partial line (a crash
 * during an earlier append), a separator newline is written first so the new
 * record never concatenates with the broken one.
 */
export function appendJsonLineSync(fd: number, value: unknown): void {
  try {
    const size = fstatSync(fd).size
    if (size > 0) {
      const last = Buffer.alloc(1)
      const read = readSync(fd, last, 0, 1, size - 1)
      if (read === 1 && last[0] !== 0x0a) writeSync(fd, '\n')
    }
  } catch {
    // Positional read unsupported on this descriptor: append anyway.
  }
  const line = `${JSON.stringify(value)}\n`
  const buffer = Buffer.from(line, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset)
  }
}

/** List `*.jsonl` basenames in a directory (empty when missing). */
export function listJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
}

/** Split JSONL text into parsed values, dropping a trailing partial line and corrupt lines. */
export function parseJsonlTolerant(text: string): unknown[] {
  const out: unknown[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as unknown)
    } catch {
      // A crash can leave a partial trailing line; tolerate it and keep going.
    }
  }
  return out
}

/** Read a whole JSONL file tolerantly (missing file yields an empty list). */
export function readJsonlFile(file: string): unknown[] {
  const text = readTextFile(file)
  return text === undefined ? [] : parseJsonlTolerant(text)
}

/**
 * Last `seq` recoverable from an append-only message file.
 *
 * Reads at most the final 64 KiB and walks lines backwards, so a crash that
 * left a partial trailing line simply resolves to the previous complete line.
 */
export function readLastSeqFromFile(file: string, channel?: string): number {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
  } catch {
    return 0
  }
  try {
    const size = fstatSync(fd).size
    if (size <= 0) return 0
    const cap = 64 * 1024
    const start = size > cap ? size - cap : 0
    const length = size - start
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, start + read)
      if (got <= 0) break
      read += got
    }
    const text = buffer.subarray(0, read).toString('utf8')
    const lines = text.split('\n')
    // Started mid-file: the first entry is a partial record, drop it.
    if (start > 0) lines.shift()
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line === undefined || line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as { seq?: unknown; channel?: unknown }
        if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
          if (channel === undefined || parsed.channel === undefined || parsed.channel === channel) return parsed.seq
        }
      } catch {
        // Trailing partial line / corrupt tail: keep walking backwards.
        continue
      }
    }
    return 0
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Ids / tokens
// ---------------------------------------------------------------------------

export function isoNow(): string {
  return new Date().toISOString()
}

/** New opaque id with a prefix, e.g. `p_1a2b3c4d5e6f`. */
export function newId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

/** New bearer token (base64url, 32 random bytes). */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 hex digest used to persist tokens without keeping the secret. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Stable id derived from an input (used for deterministic auto identities). */
export function stableId(prefix: string, input: string, chars = 12): string {
  return `${prefix}_${createHash('sha1').update(input, 'utf8').digest('hex').slice(0, chars)}`
}

/** Public projection of a participant: never leaks `tokenHash`. */
export function publicParticipant(participant: Participant): Participant {
  const { tokenHash: _tokenHash, ...rest } = participant
  return rest
}

// ---------------------------------------------------------------------------
// Keyed serial queue
// ---------------------------------------------------------------------------

/**
 * One serial queue per key. Tasks run one at a time in submission order and a
 * rejected task does not poison the queue. This is the mechanism that makes
 * `seq` allocation, append, broadcast and wake observable in file order.
 */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the chain alive regardless of this task's outcome.
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }

  /** Wait until every queued task on every key has settled. */
  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()])
    }
  }
}

// ---------------------------------------------------------------------------
// Single-writer hub lock
// ---------------------------------------------------------------------------

export const LOCK_STALE_MS = 60_000
export const LOCK_TOUCH_MS = 20_000

export interface HubLockFile {
  readonly pid: number
  readonly startedAt: string
  /** Random owner id: a newer keeper in the same process may take over the lock. */
  readonly nonce?: string
}

export type HubLockAcquisition =
  | { readonly writer: true; readonly staleTakenOver: boolean; readonly lockFile: string; readonly nonce: string }
  | { readonly writer: false; readonly reason: string; readonly holder?: HubLockFile; readonly lockFile: string }

/** True when the pid is alive (or exists but is not signalable by us). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM'
  }
}

function readLockFile(file: string): HubLockFile | undefined {
  const raw = readJsonFile<{ pid?: unknown; startedAt?: unknown; nonce?: unknown }>(file)
  if (raw === undefined) return undefined
  if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid)) return undefined
  return {
    pid: raw.pid,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    ...(typeof raw.nonce === 'string' ? { nonce: raw.nonce } : {}),
  }
}

function tryCreateLock(file: string, body: HubLockFile): boolean {
  try {
    writeFileSync(file, `${JSON.stringify(body)}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function lockIsStale(file: string, holder: HubLockFile | undefined): boolean {
  if (holder === undefined) return true
  if (!isPidAlive(holder.pid)) return true
  // A lock owned by *this* process is a hot-reload handoff: the new module
  // instance takes over and the old instance's releaseHubLock() is a no-op
  // because the nonce no longer matches. Cross-process locks are still strict.
  if (holder.pid === process.pid) return true
  // A live writer refreshes the file's mtime every LOCK_TOUCH_MS; an mtime
  // older than LOCK_STALE_MS means that writer is wedged.
  try {
    const age = Date.now() - statSync(file).mtimeMs
    return age > LOCK_STALE_MS
  } catch {
    return true
  }
}

/**
 * Acquire the single-writer lock.
 *
 * - fresh `wx` create → writer
 * - EEXIST with a live pid and fresh mtime → read-only (never throws)
 * - stale holder (dead pid, or mtime older than 60s) → take over
 */
export function acquireHubLock(file: string): HubLockAcquisition {
  ensureParent(file)
  const nonce = randomUUID()
  const self: HubLockFile = { pid: process.pid, startedAt: isoNow(), nonce }
  if (tryCreateLock(file, self)) return { writer: true, staleTakenOver: false, lockFile: file, nonce }

  let holder = readLockFile(file)
  if (!lockIsStale(file, holder)) {
    return { writer: false, reason: 'another live dsh-channels hub holds the lock', holder, lockFile: file }
  }
  // Stale: remove and retry. The unlink-then-create window is tiny and the
  // loser of that race simply re-reads the fresh lock as read-only.
  try {
    unlinkSync(file)
  } catch {
    /* someone else already cleaned it up */
  }
  if (tryCreateLock(file, self)) return { writer: true, staleTakenOver: true, lockFile: file, nonce }
  holder = readLockFile(file)
  return { writer: false, reason: 'lost the stale-lock takeover race', holder, lockFile: file }
}

/** Refresh the lock mtime so other instances see a live writer. */
export function touchFile(file: string): void {
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    /* best effort: a missed heartbeat is repaired by the next tick */
  }
}

/**
 * Release the lock only when this hub instance still owns it. `nonce` guards
 * the hot-reload case where a newer instance already took over.
 */
export function releaseHubLock(file: string, nonce?: string): void {
  const holder = readLockFile(file)
  if (holder !== undefined && holder.pid !== process.pid) return
  if (holder !== undefined && nonce !== undefined && holder.nonce !== undefined && holder.nonce !== nonce) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}
