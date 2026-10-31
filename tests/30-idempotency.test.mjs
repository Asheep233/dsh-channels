/**
 * 30 — clientMsgId idempotency (SPEC §7: same participant + clientMsgId within
 * 10 minutes returns the original message; §10.2: retries store only one).
 *
 * The concurrency test fires the same clientMsgId 5x at once: exactly one
 * message may be appended, all five responses must carry the same message id,
 * and exactly one response may be flagged `duplicate:false`.
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
  send,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const state = {}

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('idem', 'a'), displayName: 'QA Idem A' })
  state.b = await register({ kind: 'external', handle: uniqueHandle('idem', 'b'), displayName: 'QA Idem B' })
  state.c = await register({ kind: 'external', handle: uniqueHandle('idem', 'c'), displayName: 'QA Idem C' })
  state.channel = uniqueChannel('idem')
  await createChannel(state.a.token, state.channel, { name: 'QA idempotency' })
  // M5 membership: A created the channel; B and C join so they may send.
  await joinChannel(state.b.token, state.channel)
  await joinChannel(state.c.token, state.channel)
  state.key = `qa-idem-key-${Date.now()}`
})

describe('30 idempotency: concurrent retries', () => {
  test('same clientMsgId 5x concurrently stores exactly one message and returns the same id', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('/send', {
          method: 'POST',
          token: state.a.token,
          body: { channel: state.channel, text: 'idempotent concurrent send', clientMsgId: state.key },
        }),
      ),
    )
    const failures = responses.filter((response) => response.status !== 200)
    assert.deepEqual(
      failures.map((response) => ({ status: response.status, body: response.text.slice(0, 200) })),
      [],
    )

    const ids = new Set(responses.map((response) => response.json.message.id))
    assert.equal(ids.size, 1, 'all duplicate retries must return the same message id')
    const duplicateFlags = responses.map((response) => response.json.duplicate)
    assert.equal(duplicateFlags.filter((flag) => flag === true).length, 4, 'exactly four retries are duplicates')
    assert.equal(duplicateFlags.filter((flag) => flag === false).length, 1, 'exactly one request stored the message')

    const page = await history(state.a.token, state.channel, { limit: 100 })
    assert.equal(page.messages.length, 1, 'only one message may be stored')
    assert.equal(page.messages[0].seq, 1)
    assert.equal(page.messages[0].id, [...ids][0])
    const file = readMessageFile(state.channel)
    assert.equal(file.rawLines.length, 1, 'only one JSONL line')
    assert.equal(file.parsed.length, 1)
    state.stored = page.messages[0]
  })

  test('sequential retry within the TTL (after 1s) returns the original message', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const replay = await send(state.a.token, state.channel, 'idempotent sequential retry', { clientMsgId: state.key })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.message.id, state.stored.id)
    assert.equal(replay.message.text, 'idempotent concurrent send', 'duplicate returns the ORIGINAL text')
    const page = await history(state.a.token, state.channel, { limit: 100 })
    assert.equal(page.messages.length, 1)
  })

  test('same clientMsgId with different text still returns the original stored message', async () => {
    const replay = await send(state.a.token, state.channel, 'completely different text', { clientMsgId: state.key })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.message.text, 'idempotent concurrent send')
    assert.equal((await history(state.a.token, state.channel, { limit: 100 })).messages.length, 1)
  })

  test('different clientMsgId (same text) stores a second message', async () => {
    const second = await send(state.a.token, state.channel, 'idempotent concurrent send', {
      clientMsgId: `${state.key}-other`,
    })
    assert.equal(second.duplicate, false)
    assert.equal(second.message.seq, 2)
    assert.notEqual(second.message.id, state.stored.id)
  })
})

describe('30 idempotency: scoping & quota', () => {
  test('idempotency is per participant: another participant with the same key is not deduped', async () => {
    const other = await send(state.b.token, state.channel, 'same key, different author', { clientMsgId: state.key })
    assert.equal(other.duplicate, false)
    assert.equal(other.message.seq, 3)
    assert.equal(other.message.author.participantId, state.b.participantId)
    const page = await history(state.a.token, state.channel, { limit: 100 })
    assert.deepEqual(
      page.messages.map((message) => message.seq),
      [1, 2, 3],
    )
  })

  test('idempotent retries do not consume the 30/min send quota', async () => {
    // 30 fresh messages use up C's full minute budget.
    const responses = []
    for (let index = 1; index <= 30; index += 1) {
      responses.push(
        await api('/send', {
          method: 'POST',
          token: state.c.token,
          body: { channel: state.channel, text: `quota message ${index}`, clientMsgId: `qa-quota-${state.key}-${index}` },
        }),
      )
    }
    assert.equal(responses.filter((response) => response.status === 200).length, 30)
    assert.equal(responses.filter((response) => response.status === 429).length, 0, '30 sends exactly at the limit must pass')

    // A duplicate retry must be answered from the idempotency cache, not 429.
    const retry = await send(state.c.token, state.channel, 'quota message 1', { clientMsgId: `qa-quota-${state.key}-1` })
    assert.equal(retry.duplicate, true)
    assert.equal(retry.message.seq, 4)

    // A genuinely new message is now over budget.
    const over = await api('/send', {
      method: 'POST',
      token: state.c.token,
      body: { channel: state.channel, text: 'one too many' },
    })
    assert.equal(over.status, 429)
    assert.equal(over.json.error.code, 'rate_limited')

    const file = readMessageFile(state.channel)
    assert.equal(file.rawLines.length, 33, '3 earlier messages + 30 quota messages, no duplicate writes')
  })
})
