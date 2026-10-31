/**
 * 60 — SSE realtime (SPEC §5 `/stream`, §8 reconnect with afterSeq).
 *
 * Frames are `event: <name>\ndata: <json>\n\n`; a live message broadcast must
 * reach a connected client within 2s. `afterSeq` replay is best-effort and
 * bounded at 100 messages per channel (store.queryHistory limit).
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import { api, createChannel, openSse, register, send, uniqueChannel, uniqueHandle } from './_helpers.mjs'

const state = {}

before(async () => {
  state.participant = await register({ kind: 'external', handle: uniqueHandle('sse', 'snd'), displayName: 'QA SSE' })
  state.channel = uniqueChannel('sse')
  await createChannel(state.participant.token, state.channel, { name: 'QA sse' })
})

describe('60 SSE: realtime frames', () => {
  test('connect sends a hello frame (with channels) and authenticates via ?token=', async () => {
    const sse = await openSse({ token: state.participant.token })
    try {
      assert.equal(sse.response.status, 200)
      assert.match(sse.response.headers.get('content-type') ?? '', /text\/event-stream/)
      const frame = await sse.next(2_000)
      assert.equal(frame.event, 'hello')
      assert.equal(frame.data.type, 'hello')
      assert.equal(frame.data.participantId, state.participant.participantId)
      assert.ok(Array.isArray(frame.data.channels))
      const meta = frame.data.channels.find((channel) => channel.id === state.channel)
      assert.ok(meta !== undefined, 'hello must list the throwaway channel')
      assert.equal(meta.lastSeq, 0)
      assert.equal(typeof frame.data.lastSeq, 'number')
    } finally {
      sse.close()
    }
  })

  test('a sent message is broadcast to a connected client in under 2s', async () => {
    const sse = await openSse({ token: state.participant.token })
    try {
      await sse.next(2_000) // hello
      const started = Date.now()
      const sent = await send(state.participant.token, state.channel, 'live sse message')
      const frame = await sse.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === sent.message.id,
        2_000,
      )
      const latencyMs = Date.now() - started
      assert.ok(latencyMs < 2_000, `live message frame took ${latencyMs}ms (must be <2000ms)`)
      assert.equal(frame.data.message.text, 'live sse message')
      assert.equal(frame.data.message.channel, state.channel)
      assert.equal(frame.data.message.author.handle, state.participant.handle)
      state.liveSent = sent.message
    } finally {
      sse.close()
    }
  })

  test('afterSeq replay delivers messages missed while disconnected', async () => {
    const second = await send(state.participant.token, state.channel, 'missed message two')
    const third = await send(state.participant.token, state.channel, 'missed message three')

    const sse = await openSse({ token: state.participant.token, afterSeq: second.message.seq })
    try {
      const hello = await sse.next(2_000)
      assert.equal(hello.event, 'hello')
      const frame = await sse.waitFor(
        (candidate) =>
          candidate.event === 'message' &&
          candidate.data?.message?.id === third.message.id &&
          candidate.data?.message?.channel === state.channel,
        2_000,
      )
      assert.equal(frame.data.message.text, 'missed message three')

      // Anything at or before afterSeq must not be replayed for this channel.
      const ownReplayed = sse.frames.filter(
        (candidate) =>
          candidate.event === 'message' &&
          candidate.data?.message?.channel === state.channel &&
          candidate.data.message.seq <= second.message.seq,
      )
      assert.deepEqual(ownReplayed, [])
      state.lastSeq = third.message.seq
    } finally {
      sse.close()
    }
  })

  test('afterSeq at the current head replays nothing, then live frames continue', async () => {
    const head = await send(state.participant.token, state.channel, 'head message')
    const sse = await openSse({ token: state.participant.token, afterSeq: head.message.seq })
    try {
      const hello = await sse.next(2_000)
      assert.equal(hello.event, 'hello')

      const own = []
      const deadline = Date.now() + 500
      while (Date.now() < deadline) {
        try {
          const frame = await sse.next(Math.max(10, deadline - Date.now()))
          if (frame.event === 'message' && frame.data?.message?.channel === state.channel) own.push(frame)
        } catch {
          break
        }
      }
      assert.deepEqual(
        own.map((frame) => frame.data.message.seq),
        [],
        'messages at or before afterSeq must not be replayed',
      )

      const started = Date.now()
      const next = await send(state.participant.token, state.channel, 'live after replay scan')
      const frame = await sse.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === next.message.id,
        2_000,
      )
      assert.ok(Date.now() - started < 2_000, 'live frame after reconnect must arrive in <2s')
      assert.equal(frame.data.message.seq, next.message.seq)
    } finally {
      sse.close()
    }
  })

  test('invalid stream token → 401 unauthorized', async () => {
    const response = await api('/stream?token=not-a-real-token')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'unauthorized')
  })

  test('tokenless loopback SSE is read-allowed (v1 browser trust) with anonymous hello', async () => {
    const sse = await openSse()
    try {
      assert.equal(sse.response.status, 200)
      const hello = await sse.next(2_000)
      assert.equal(hello.event, 'hello')
      assert.equal(hello.data.participantId, '')
      assert.ok(Array.isArray(hello.data.channels))
      assert.ok(hello.data.channels.some((channel) => channel.id === 'general'))
    } finally {
      sse.close()
    }
  })
})
