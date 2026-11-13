/**
 * 50 — Durability: crash-tail tolerance and recovery (SPEC §3, §10.3).
 *
 * Part A (live): append an incomplete JSON tail to a throwaway channel's JSONL
 * while the live hub runs, then send + read history. #general is untouched.
 *
 * Part B (hermetic): build a temp data dir with a crash tail, start a fresh hub
 * with a fake Cordis ctx (never the live host), and verify what a restart
 * recovers. Also covers the single-writer hub.lock rules from SPEC §3.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import { readLastSeqFromFile, releaseHubLock } from '../lib/host/util.js'
import {
  appendRawToChannelFile,
  createChannel,
  health,
  history,
  makeFakeCtx,
  makeSeedMessage,
  makeTempDataDir,
  readMessageFile,
  register,
  seedChannel,
  seedLock,
  send,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const state = {}
const tempDirs = []

function makeHermeticHub(dataDir) {
  const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
  return hub
}

function tempDir(tag) {
  const dir = makeTempDataDir(tag)
  tempDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Part A — live hub tolerates a partial tail on disk
// ---------------------------------------------------------------------------

describe('50 durability (live): partial JSONL tail', () => {
  before(async () => {
    state.participant = await register({ kind: 'external', handle: uniqueHandle('dur', 'snd'), displayName: 'QA Durability' })
    state.channelA = uniqueChannel('dur', 'a')
    state.channelB = uniqueChannel('dur', 'b')
    await createChannel(state.participant.token, state.channelA, { name: 'QA durability A' })
    await createChannel(state.participant.token, state.channelB, { name: 'QA durability B' })
    state.a1 = await send(state.participant.token, state.channelA, 'a-1')
    state.a2 = await send(state.participant.token, state.channelA, 'a-2')
    state.b1 = await send(state.participant.token, state.channelB, 'b-1')
    state.b2 = await send(state.participant.token, state.channelB, 'b-2')
  })

  test('a newline-terminated partial line is ignored and seq continues', async () => {
    // Simulates a crash that left a complete-but-corrupt JSON line at EOF.
    appendRawToChannelFile(state.channelA, `{"id":"partial","channel":${JSON.stringify(state.channelA)},"seq":\n`)
    const sent = await send(state.participant.token, state.channelA, 'after newline-terminated partial tail')
    assert.equal(sent.message.seq, 3)

    const page = await history(state.participant.token, state.channelA, { limit: 100 })
    assert.deepEqual(
      page.messages.map((message) => message.seq),
      [1, 2, 3],
      'the partial line must be skipped, not swallow the next message',
    )

    const file = readMessageFile(state.channelA)
    assert.deepEqual(
      file.parsed.map((message) => message.seq),
      [1, 2, 3],
    )
    assert.equal(file.invalid.length, 1, 'exactly the injected partial line is unparseable')
  })

  test('a partial line WITHOUT a trailing newline must not swallow the next message (SPEC §3)', async () => {
    // Simulates a crash mid-write: the file ends inside a JSON object, no \n.
    appendRawToChannelFile(state.channelB, `{"id":"crashed-write","channel":${JSON.stringify(state.channelB)},"seq":`)

    const sent = await send(state.participant.token, state.channelB, 'after unterminated partial tail')
    assert.equal(sent.message.seq, 3, 'the running hub still allocates seq 3')

    const page = await history(state.participant.token, state.channelB, { limit: 100 })
    const historySeqs = page.messages.map((message) => message.seq)
    const file = readMessageFile(state.channelB)

    assert.deepEqual(
      historySeqs,
      [1, 2, 3],
      'DEFECT (durability, high): a crash tail without a trailing newline concatenates with the next ' +
        `JSON line, so message seq ${sent.message.seq} was accepted (HTTP 200) but is unreadable. ` +
        `rawTail=${JSON.stringify(file.raw.slice(-220))} invalid=${JSON.stringify(file.invalid).slice(0, 300)}`,
    )
  })

  test('after the crash tail is repaired, seq continues without a gap', async () => {
    const sent = await send(state.participant.token, state.channelB, 'second message after corrupt tail')
    assert.equal(sent.message.seq, 4)
    const page = await history(state.participant.token, state.channelB, { limit: 100 })
    assert.deepEqual(
      page.messages.map((message) => message.seq),
      [1, 2, 3, 4],
      'the separator newline keeps the accepted seq-3 message readable; later appends continue at seq 4',
    )
  })

  test('live hub stays healthy and #general stays readable after tail injection', async () => {
    const body = await health()
    assert.equal(body.ok, true)
    assert.equal(body.readonly, false)
    const page = await history(undefined, 'general', { limit: 5 })
    assert.ok(page.messages.length > 0)
    assert.equal(page.messages[0].channel, 'general')
  })
})

// ---------------------------------------------------------------------------
// Part B — restart recovery on a hermetic hub (temp dir, fake ctx)
// ---------------------------------------------------------------------------

describe('50 durability (hermetic): restart recovery', () => {
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  test('newline-terminated crash tail: lastSeq recovers and next send continues', async () => {
    const channel = 'qa-crash-newline'
    const dataDir = tempDir('dur-newline')
    seedChannel(dataDir, channel, [makeSeedMessage(channel, 1), makeSeedMessage(channel, 2)], {
      partialTail: '{"id":"partial","seq":3\n',
    })
    let hub
    try {
      hub = makeHermeticHub(dataDir)
      assert.ok(hub !== undefined, 'hub must start despite the crash tail')
      assert.equal(hub.store.lastSeqOf(channel), 2, 'recovery reads the last complete line')
      const participant = (await hub.register({ kind: 'external', handle: 'qa-dur-recover-user' })).participant
      // M5: seeded channels have no membership rows; join before writing.
      await hub.joinChannel(participant, channel)
      const sent = await hub.sendMessage(participant, { channel, text: 'after recovery' })
      assert.equal(sent.message.seq, 3)
      assert.deepEqual(
        hub.history(null, { channel, limit: 100 }).messages.map((message) => message.seq),
        [1, 2, 3],
      )
      assert.equal(hub.health().ok, true)
    } finally {
      hub?.dispose()
    }
  })

  test('unterminated crash tail: recovery loses the accepted message and reuses its seq (DEFECT)', async () => {
    const channel = 'qa-crash-nonewline'
    const dataDir = tempDir('dur-nonewline')
    seedChannel(dataDir, channel, [makeSeedMessage(channel, 1), makeSeedMessage(channel, 2)], {
      partialTail: '{"id":"crashed-write","seq":',
    })
    const evidence = {}
    let hub1
    let hub2
    try {
      hub1 = makeHermeticHub(dataDir)
      assert.ok(hub1 !== undefined, 'hub must start despite the crash tail')
      const firstUser = (await hub1.register({ kind: 'external', handle: 'qa-dur-first-user' })).participant
      await hub1.joinChannel(firstUser, channel)
      const accepted = await hub1.sendMessage(firstUser, { channel, text: 'accepted before restart' })
      evidence.accepted = accepted.message
      evidence.historyBeforeRestart = hub1.history(null, { channel, limit: 100 }).messages.map((message) => message.seq)
      hub1.dispose()
      hub1 = undefined

      hub2 = makeHermeticHub(dataDir)
      assert.ok(hub2 !== undefined, 'restart must not crash')
      evidence.recoveredLastSeq = hub2.store.lastSeqOf(channel)
      const secondUser = (await hub2.register({ kind: 'external', handle: 'qa-dur-second-user' })).participant
      // M5: membership persisted across the restart, so the second hub can write
      // without another join.
      await hub2.joinChannel(secondUser, channel)
      const next = await hub2.sendMessage(secondUser, { channel, text: 'first message after restart' })
      evidence.nextSeq = next.message.seq
      evidence.nextId = next.message.id
      evidence.historyAfterRestart = hub2.history(null, { channel, limit: 100 }).messages.map((message) => message.seq)
    } finally {
      hub1?.dispose()
      hub2?.dispose()
    }

    assert.deepEqual(
      evidence.historyBeforeRestart,
      [1, 2, 3],
      'DEFECT (durability, high): an accepted message is invisible before restart ' +
        `because its JSON was appended after the unterminated crash tail. evidence=${JSON.stringify(evidence)}`,
    )
    assert.equal(
      evidence.recoveredLastSeq,
      3,
      'DEFECT (durability, high): restart recovery walks past the accepted seq and returns a lower lastSeq. ' +
        `evidence=${JSON.stringify(evidence)}`,
    )
    assert.equal(
      evidence.nextSeq,
      4,
      'DEFECT (durability, high): the recovered hub re-uses seq 3, so a previously accepted message id is reissued. ' +
        `evidence=${JSON.stringify(evidence)}`,
    )
  })

  test('readLastSeqFromFile tolerates missing/empty/partial files and reads large tails', () => {
    const dataDir = tempDir('dur-seq')
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'seq.jsonl')

    assert.equal(readLastSeqFromFile(file, 'x'), 0, 'missing file → 0')
    writeFileSync(file, '', 'utf8')
    assert.equal(readLastSeqFromFile(file, 'x'), 0, 'empty file → 0')

    const two = `${JSON.stringify(makeSeedMessage('x', 1))}\n${JSON.stringify(makeSeedMessage('x', 2))}\n`
    writeFileSync(file, `${two}{"id":"partial"`, 'utf8')
    assert.equal(readLastSeqFromFile(file, 'x'), 2, 'unterminated partial tail → last complete seq')
    writeFileSync(file, `${two}{"id":"partial"}\n`, 'utf8')
    assert.equal(readLastSeqFromFile(file, 'x'), 2, 'terminated corrupt tail → last complete seq')

    const many = Array.from({ length: 300 }, (_, index) => JSON.stringify(makeSeedMessage('x', index + 1))).join('\n')
    writeFileSync(file, `${many}\n`, 'utf8')
    assert.ok(readFileSync(file, 'utf8').length > 64 * 1024, 'test file must exceed the 64KiB tail window')
    assert.equal(readLastSeqFromFile(file, 'x'), 300, 'reads lastSeq from a >64KiB tail')
  })
})

// ---------------------------------------------------------------------------
// Part B — single-writer hub.lock (SPEC §3 / §10.4)
// ---------------------------------------------------------------------------

describe('50 durability (hermetic): hub.lock single-writer rules', () => {
  test('a stale lock (dead pid) is taken over by a new writer and released on dispose', () => {
    const dataDir = tempDir('dur-stale')
    seedChannel(dataDir, 'general', [])
    const lockFile = seedLock(dataDir, 999_999)
    const hub = makeHermeticHub(dataDir)
    try {
      assert.ok(hub !== undefined)
      assert.equal(hub.writer, true, 'dead-pid lock is stale and must be taken over')
      assert.equal(hub.health().readonly, false)
    } finally {
      hub?.dispose()
    }
    assert.equal(existsSync(lockFile), false, 'dispose must release the writer lock')
  })

  test('a same-process lock (hot reload) is taken over; the old instance cannot release the new lock', () => {
    const dataDir = tempDir('dur-reload-lock')
    seedChannel(dataDir, 'general', [])
    const lockFile = seedLock(dataDir, process.pid)
    const hub = makeHermeticHub(dataDir)
    try {
      assert.ok(hub !== undefined)
      assert.equal(hub.writer, true, 'a lock owned by this same process is a reload handoff')
      const holder = JSON.parse(readFileSync(lockFile, 'utf8'))
      assert.equal(holder.pid, process.pid)
      assert.equal(typeof holder.nonce, 'string', 'new writer must own the lock with a nonce')
      // The previous (disposed) instance releases with its own nonce: no-op.
      releaseHubLock(lockFile, 'old-instance-nonce')
      assert.equal(existsSync(lockFile), true, 'stale release must not remove the new lock')
    } finally {
      hub?.dispose()
    }
    assert.equal(existsSync(lockFile), false, 'the current owner releases on dispose')
  })

  test('a live lock makes a second hub read-only: writes return 503 readonly', async () => {
    const live = await health()
    const dataDir = tempDir('dur-live-lock')
    seedChannel(dataDir, 'general', [])
    const lockFile = seedLock(dataDir, live.pid)
    const lockBefore = readFileSync(lockFile, 'utf8')
    const hub = makeHermeticHub(dataDir)
    try {
      assert.ok(hub !== undefined)
      assert.equal(hub.writer, false, 'live writer pid must not be preempted')
      assert.equal(hub.health().readonly, true)
      await assert.rejects(
        () => hub.register({ kind: 'external', handle: 'qa-readonly-user' }),
        (error) => error.status === 503 && error.code === 'readonly',
      )
      await assert.rejects(
        () => hub.sendMessage({ id: 'p_x', handle: 'x' }, { channel: 'general', text: 'nope' }),
        (error) => error.status === 503 && error.code === 'readonly',
      )
    } finally {
      hub?.dispose()
    }
    assert.equal(existsSync(lockFile), true, 'read-only hub must not delete the live lock')
    assert.equal(readFileSync(lockFile, 'utf8'), lockBefore, 'read-only hub must not rewrite the live lock')
  })
})
