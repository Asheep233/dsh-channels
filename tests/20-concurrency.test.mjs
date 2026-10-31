/**
 * 20 — Concurrency / ordering (SPEC §3 per-channel serial queue, §10.1).
 *
 * 10 participants x 30 sends (the 30/min/participant rate limit means the
 * SPEC §10.1 "x50" wording is not reachable in one minute; see report.md) to a
 * single throwaway channel, then a cross-channel isolation pass.
 *
 * Asserts: every send accepted, per-channel seq contiguous with no gaps or
 * duplicates, ids unique, JSONL line count == max seq, file order == seq order,
 * history order == seq order.
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import {
  api,
  createChannel,
  history,
  joinChannel,
  readMessageFile,
  register,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const CLIENTS = 10
const SENDS_PER_CLIENT = 30 // == 30 msgs/min/participant rate limit (SPEC §11)
const CROSS_CHANNELS = 3
const CROSS_CLIENTS = 5
const CROSS_SENDS_PER_CLIENT = 6

const state = {}

before(async () => {
  state.clients = await Promise.all(
    Array.from({ length: CLIENTS }, (_, index) =>
      register({ kind: 'external', handle: uniqueHandle('conc', String(index)), displayName: `QA Conc ${index}` }),
    ),
  )
  state.channel = uniqueChannel('conc')
  await createChannel(state.clients[0].token, state.channel, { name: 'QA concurrency' })
  // M5 membership: every sender must be a member before the concurrent load.
  await Promise.all(state.clients.map((client) => joinChannel(client.token, state.channel)))
})

describe('20 concurrency: 10 clients x 30 sends to one channel', () => {
  test('all 300 sends are accepted and seq is contiguous 1..300', async () => {
    const tasks = []
    for (let client = 0; client < CLIENTS; client += 1) {
      for (let index = 0; index < SENDS_PER_CLIENT; index += 1) {
        tasks.push(
          api('/send', {
            method: 'POST',
            token: state.clients[client].token,
            body: { channel: state.channel, text: `c${client}-m${index}` },
          }),
        )
      }
    }

    const started = Date.now()
    const responses = await Promise.all(tasks)
    const elapsedMs = Date.now() - started
    state.elapsedMs = elapsedMs
    state.responses = responses

    const failures = responses.filter((response) => response.status !== 200)
    assert.deepEqual(
      failures.map((response) => ({ status: response.status, body: response.text.slice(0, 200) })),
      [],
      `every concurrent send must be accepted (${failures.length} failed)`,
    )
    assert.equal(responses.length, CLIENTS * SENDS_PER_CLIENT)
    assert.ok(elapsedMs < 30_000, `300 concurrent sends took ${elapsedMs}ms`)

    const messages = responses.map((response) => response.json.message)
    const seqs = messages.map((message) => message.seq).sort((left, right) => left - right)
    assert.equal(new Set(seqs).size, seqs.length, 'seq values must be unique')
    assert.deepEqual(
      seqs,
      Array.from({ length: CLIENTS * SENDS_PER_CLIENT }, (_, index) => index + 1),
      'seq must be contiguous 1..300 with no gaps',
    )

    const ids = messages.map((message) => message.id)
    assert.equal(new Set(ids).size, ids.length, 'message ids must be unique')
    for (const message of messages) {
      assert.equal(message.channel, state.channel)
      assert.match(message.id, new RegExp(`^${state.channel}-\\d{6}$`))
    }

    for (const response of responses) {
      assert.equal(response.json.duplicate, false, 'no send was a duplicate')
    }
  })

  test('JSONL line count == max seq and file order == seq order', async () => {
    const file = readMessageFile(state.channel)
    assert.equal(file.exists, true)
    assert.equal(file.rawLines.length, CLIENTS * SENDS_PER_CLIENT, 'one JSONL line per accepted message')
    assert.equal(file.invalid.length, 0, `no corrupt lines: ${JSON.stringify(file.invalid).slice(0, 500)}`)
    assert.equal(file.parsed.length, CLIENTS * SENDS_PER_CLIENT)

    const fileSeqs = file.parsed.map((message) => message.seq)
    assert.deepEqual(
      fileSeqs,
      Array.from({ length: CLIENTS * SENDS_PER_CLIENT }, (_, index) => index + 1),
      'file order must equal seq order',
    )
    for (let index = 1; index < file.parsed.length; index += 1) {
      assert.ok(file.parsed[index].seq > file.parsed[index - 1].seq, 'seq strictly increasing in file order')
    }
    const ids = new Set(file.parsed.map((message) => message.id))
    assert.equal(ids.size, file.parsed.length)
    const maxSeq = Math.max(...fileSeqs)
    assert.equal(file.rawLines.length, maxSeq)
  })

  test('history pagination returns seq order with correct hasMore', async () => {
    const collected = []
    let afterSeq = 0
    for (;;) {
      const page = await history(state.clients[0].token, state.channel, { afterSeq, limit: 100 })
      collected.push(...page.messages)
      if (!page.hasMore) break
      afterSeq = page.messages[page.messages.length - 1].seq
      assert.ok(page.messages.length > 0, 'hasMore must imply a non-empty page')
    }
    assert.deepEqual(
      collected.map((message) => message.seq),
      Array.from({ length: CLIENTS * SENDS_PER_CLIENT }, (_, index) => index + 1),
      'history order must equal seq order',
    )
    const upToDate = await history(state.clients[0].token, state.channel, { afterSeq: collected.length })
    assert.deepEqual(upToDate.messages, [])
    assert.equal(upToDate.hasMore, false)
  })
})

describe('20 concurrency: cross-channel isolation', () => {
  test('parallel sends to 3 channels keep per-channel seq contiguous', async () => {
    const channels = Array.from({ length: CROSS_CHANNELS }, (_, index) => uniqueChannel('concx', String(index)))
    const clients = await Promise.all(
      Array.from({ length: CROSS_CLIENTS }, (_, index) =>
        register({ kind: 'external', handle: uniqueHandle('concx', String(index)), displayName: `QA ConcX ${index}` }),
      ),
    )
    for (const channel of channels) {
      await createChannel(clients[0].token, channel, { name: `QA cross ${channel}` })
      // M5 membership: every client must join every channel it writes to.
      await Promise.all(clients.map((client) => joinChannel(client.token, channel)))
    }

    const tasks = []
    for (const channel of channels) {
      for (const client of clients) {
        for (let index = 0; index < CROSS_SENDS_PER_CLIENT; index += 1) {
          tasks.push(
            api('/send', {
              method: 'POST',
              token: client.token,
              body: { channel, text: `${channel} ${client.handle} ${index}` },
            }),
          )
        }
      }
    }
    const responses = await Promise.all(tasks)
    const failures = responses.filter((response) => response.status !== 200)
    assert.deepEqual(
      failures.map((response) => ({ status: response.status, body: response.text.slice(0, 200) })),
      [],
      'all cross-channel sends accepted',
    )

    const perChannel = new Map(channels.map((channel) => [channel, []]))
    for (const response of responses) {
      const message = response.json.message
      perChannel.get(message.channel).push(message)
    }

    for (const channel of channels) {
      const messages = perChannel.get(channel)
      assert.equal(messages.length, CROSS_CLIENTS * CROSS_SENDS_PER_CLIENT)
      const seqs = messages.map((message) => message.seq).sort((left, right) => left - right)
      assert.deepEqual(
        seqs,
        Array.from({ length: CROSS_CLIENTS * CROSS_SENDS_PER_CLIENT }, (_, index) => index + 1),
        `#${channel} seq must be contiguous`,
      )
      const file = readMessageFile(channel)
      assert.equal(file.rawLines.length, CROSS_CLIENTS * CROSS_SENDS_PER_CLIENT)
      assert.deepEqual(
        file.parsed.map((message) => message.seq),
        Array.from({ length: CROSS_CLIENTS * CROSS_SENDS_PER_CLIENT }, (_, index) => index + 1),
        `#${channel} file order must equal seq order`,
      )
    }
  })
})
