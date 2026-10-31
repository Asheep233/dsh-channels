/**
 * 10 — HTTP API smoke test (SPEC §5).
 *
 * register human + external, channel creation, send/history ordering, whoami,
 * members, pins, announce, reply, channel metadata, unread counters, error
 * envelope. Writes only to a per-run throwaway channel; #general is only read.
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import {
  assertApiError,
  api,
  apiOk,
  createChannel,
  health,
  history,
  joinChannel,
  listChannels,
  members,
  register,
  send,
  uniqueChannel,
  uniqueHandle,
  whoami,
} from './_helpers.mjs'

const state = {}

before(async () => {
  state.generalBefore = await history(undefined, 'general', { limit: 5 })
  state.human = await register({ kind: 'human' })
  state.a = await register({
    kind: 'external',
    handle: uniqueHandle('api', 'a'),
    displayName: 'QA API A',
    harness: 'codex',
  })
  state.b = await register({ kind: 'external', handle: uniqueHandle('api', 'b'), displayName: 'QA API B' })
  state.c = await register({ kind: 'external', handle: uniqueHandle('api', 'c'), displayName: 'QA API C' })
  state.channel = uniqueChannel('api')
  state.meta = await createChannel(state.a.token, state.channel, {
    name: 'QA API channel',
    topic: 'api smoke topic',
    category: 'qa',
  })
  // M5 membership: only the creator is auto-joined; B and C must join explicitly.
  await joinChannel(state.b.token, state.channel)
  await joinChannel(state.c.token, state.channel)
})

describe('10 API: registers & identity', () => {
  test('GET /health is public and reports the live hub', async () => {
    const body = await health()
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-channels')
    assert.equal(body.apiBase, '/channels/api')
    assert.equal(body.readonly, false)
    assert.equal(typeof body.pid, 'number')
    assert.ok(Array.isArray(body.channels) && body.channels.includes('general'))
    assert.equal(typeof body.lastSeq.general, 'number')
  })

  test('POST /register human mints an auto handle + 32-byte token', async () => {
    assert.equal(state.human.participant.kind, 'human')
    assert.match(state.human.handle, /^human-[a-z0-9]{4}$/)
    assert.match(state.human.token, /^[A-Za-z0-9_-]{43}$/, 'token must be base64url(32 bytes) = 43 chars')
    assert.equal(state.human.participant.handle, state.human.handle)
    assert.equal(state.human.participant.tokenHash, undefined, 'read APIs must not leak tokenHash')
  })

  test('POST /register honors handle/displayName/harness for external callers', async () => {
    assert.equal(state.a.participant.kind, 'external')
    assert.equal(state.a.participant.displayName, 'QA API A')
    assert.equal(state.a.participant.harness, 'codex')
    assert.equal(state.a.handle, state.a.participant.handle)
  })

  test('handle ownership: same token re-registers idempotently, wrong token → 409', async () => {
    const again = await register({ kind: 'external', handle: state.a.handle, token: state.a.token })
    assert.equal(again.participantId, state.a.participantId)
    assert.equal(again.handle, state.a.handle)
    assert.equal(again.participant.tokenHash, undefined)

    const stolen = await api('/register', {
      method: 'POST',
      body: { kind: 'external', handle: state.a.handle, token: 'x'.repeat(43) },
    })
    assertApiError(stolen, 409, 'conflict')
  })

  test('GET /whoami resolves bearer token; tokenless loopback read returns null (v1 trust)', async () => {
    const mine = await whoami(state.a.token)
    assert.equal(mine.participant.id, state.a.participantId)
    assert.equal(mine.participant.handle, state.a.handle)
    assert.equal(mine.participant.tokenHash, undefined)

    const anonymous = await whoami()
    assert.equal(anonymous.participant, null)

    const bogus = await api('/whoami', { token: 'definitely-not-a-token' })
    assertApiError(bogus, 401, 'unauthorized')
  })

  test('POST /heartbeat refreshes lastSeen', async () => {
    const before = await whoami(state.a.token)
    const body = await apiOk('/heartbeat', { method: 'POST', token: state.a.token, body: {} })
    assert.equal(body.ok, true)
    assert.equal(body.participant.id, state.a.participantId)
    assert.ok(Date.parse(body.participant.lastSeen) >= Date.parse(before.participant.lastSeen))
  })

  test('POST /login restores an external identity with its token', async () => {
    const body = await apiOk('/login', {
      method: 'POST',
      body: { handle: state.a.handle, token: state.a.token },
    })
    assert.equal(body.participant.id, state.a.participantId)

    const wrong = await api('/login', { method: 'POST', body: { handle: state.a.handle, token: 'nope' } })
    assertApiError(wrong, 401, 'unauthorized')
    const unknown = await api('/login', { method: 'POST', body: { handle: 'qa-does-not-exist', token: 'nope' } })
    assertApiError(unknown, 401, 'unauthorized')
  })
})

describe('10 API: channels', () => {
  test('GET /channels lists #general and the new channel metadata', async () => {
    const channels = await listChannels(state.a.token)
    const general = channels.find((channel) => channel.id === 'general')
    assert.ok(general !== undefined, '#general must always exist')
    assert.ok(Array.isArray(general.pins))
    assert.equal(typeof general.lastSeq, 'number')

    const mine = channels.find((channel) => channel.id === state.channel)
    assert.ok(mine !== undefined, 'new channel must be listed')
    assert.equal(mine.name, 'QA API channel')
    assert.equal(mine.topic, 'api smoke topic')
    assert.equal(mine.category, 'qa')
    assert.equal(mine.createdBy, state.a.handle)
    assert.equal(mine.lastSeq, 0)
    assert.equal(mine.unread, 0)
  })

  test('POST /channels validates ids and rejects duplicates (409)', async () => {
    const dup = await api('/channels', { method: 'POST', token: state.a.token, body: { id: state.channel, name: 'again' } })
    assertApiError(dup, 409, 'conflict')

    for (const bad of ['', 'UPPER', 'a_b', '../etc', 'x'.repeat(33)]) {
      const response = await api('/channels', { method: 'POST', token: state.a.token, body: { id: bad, name: 'bad' } })
      assert.equal(response.status, 400, `channel id ${JSON.stringify(bad)} must be rejected`)
      assert.equal(response.json.error.code, 'invalid_request')
    }

    const general = await api('/channels', { method: 'POST', token: state.a.token, body: { id: 'general' } })
    assertApiError(general, 409, 'conflict')
  })
})

describe('10 API: send / history / reply', () => {
  test('POST /send stores a chat message with author snapshot + parsed mentions', async () => {
    const body = await send(state.a.token, state.channel, `hello from A, cc @${state.b.handle}`)
    const message = body.message
    assert.equal(body.duplicate, false)
    assert.equal(message.channel, state.channel)
    assert.equal(message.seq, 1)
    assert.equal(message.id, `${state.channel}-000001`)
    assert.match(message.id, new RegExp(`^${state.channel}-\\d{6}$`))
    assert.equal(message.kind, 'chat')
    assert.match(message.ts, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(message.author, {
      participantId: state.a.participantId,
      handle: state.a.handle,
      displayName: 'QA API A',
      kind: 'external',
      harness: 'codex',
    })
    assert.deepEqual(message.mentions, [state.b.handle])
    assert.equal(body.wake.enabled, true)
    state.m1 = message
  })

  test('POST /send accepts explicit mentions + replyTo snapshots excerpt/author', async () => {
    const explicit = await send(state.a.token, state.channel, 'explicit mention without at-sign', {
      mentions: [state.b.handle, 'not a handle'],
    })
    assert.equal(explicit.message.seq, 2)
    assert.deepEqual(explicit.message.mentions, [state.b.handle])

    const reply = await send(state.b.token, state.channel, 'replying to m1', { replyTo: state.m1.id })
    assert.equal(reply.message.seq, 3)
    assert.deepEqual(reply.message.replyTo, {
      id: state.m1.id,
      seq: 1,
      authorName: state.a.handle,
      excerpt: `hello from A, cc @${state.b.handle}`,
    })

    const missing = await api('/send', {
      method: 'POST',
      token: state.b.token,
      body: { channel: state.channel, text: 'x', replyTo: `${state.channel}-000999` },
    })
    assertApiError(missing, 404, 'not_found')
    state.m3 = reply.message
  })

  test('GET /history returns ascending seq and honors beforeSeq/afterSeq/limit', async () => {
    const all = await history(state.a.token, state.channel, { limit: 100 })
    assert.deepEqual(
      all.messages.map((message) => message.seq),
      [1, 2, 3],
    )
    assert.equal(all.hasMore, false)

    const after = await history(state.a.token, state.channel, { afterSeq: 1 })
    assert.deepEqual(
      after.messages.map((message) => message.seq),
      [2, 3],
    )

    const beforePage = await history(state.a.token, state.channel, { beforeSeq: 3 })
    assert.deepEqual(
      beforePage.messages.map((message) => message.seq),
      [1, 2],
    )

    const latest = await history(state.a.token, state.channel, { limit: 1 })
    assert.deepEqual(
      latest.messages.map((message) => message.seq),
      [3],
    )
    assert.equal(latest.hasMore, true)

    const first = await history(state.a.token, state.channel, { afterSeq: 0, limit: 1 })
    assert.deepEqual(
      first.messages.map((message) => message.seq),
      [1],
    )
    assert.equal(first.hasMore, true)
  })

  test('unread counters follow the read cursor (markRead on history)', async () => {
    // C never sent nor read in this channel, so its cursor stays at 0.
    const listingBefore = await listChannels(state.c.token)
    const mineBefore = listingBefore.find((channel) => channel.id === state.channel)
    assert.equal(mineBefore.lastSeq, 3)
    assert.equal(mineBefore.unread, 3, 'C has not read the channel yet')

    await history(state.c.token, state.channel, { limit: 100 })

    const listingAfter = await listChannels(state.c.token)
    const mineAfter = listingAfter.find((channel) => channel.id === state.channel)
    assert.equal(mineAfter.unread, 0, 'reading history must advance the cursor')
  })

  test('GET /members returns participants with presence, never tokenHash', async () => {
    const body = await members(state.a.token, state.channel)
    const ids = body.participants.map((participant) => participant.id)
    assert.ok(ids.includes(state.a.participantId))
    assert.ok(ids.includes(state.b.participantId))
    for (const participant of body.participants) {
      assert.equal(participant.tokenHash, undefined)
      assert.ok(['online', 'idle', 'offline'].includes(participant.status))
    }
    assert.equal(JSON.stringify(body).includes('tokenHash'), false)
  })
})

describe('10 API: pins & announcements', () => {
  test('pin/unpin are reflected in GET /pins and channel meta', async () => {
    const pinned = await apiOk('/pin', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, messageId: state.m1.id },
    })
    assert.deepEqual(
      pinned.channel.pins.map((pin) => pin.messageId),
      [state.m1.id],
    )
    assert.equal(pinned.channel.pins[0].by, state.a.handle)

    const pins = await apiOk(`/pins?channel=${encodeURIComponent(state.channel)}`)
    assert.deepEqual(
      pins.pins.map((pin) => pin.messageId),
      [state.m1.id],
    )
    assert.deepEqual(
      pins.messages.map((message) => message.id),
      [state.m1.id],
    )

    const listing = await listChannels(state.a.token)
    assert.deepEqual(
      listing.find((channel) => channel.id === state.channel).pins.map((pin) => pin.messageId),
      [state.m1.id],
    )

    const unpinned = await apiOk('/unpin', {
      method: 'POST',
      token: state.b.token,
      body: { channel: state.channel, messageId: state.m1.id },
    })
    assert.deepEqual(unpinned.channel.pins, [])
    const pinsAfter = await apiOk(`/pins?channel=${encodeURIComponent(state.channel)}`)
    assert.deepEqual(pinsAfter.pins, [])

    const missing = await api('/pin', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, messageId: `${state.channel}-000999` },
    })
    assertApiError(missing, 404, 'not_found')

    const noId = await api('/pin', { method: 'POST', token: state.a.token, body: { channel: state.channel } })
    assertApiError(noId, 400, 'invalid_request')
  })

  test('announce appends kind:announcement, updates meta, keeps old announcements in history', async () => {
    const first = await apiOk('/announce', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'first announcement' },
    })
    assert.equal(first.message.kind, 'announcement')
    assert.equal(first.message.seq, 4)
    assert.equal(first.channel.announcementId, first.message.id)

    const listing = await listChannels(state.a.token)
    assert.equal(listing.find((channel) => channel.id === state.channel).announcementId, first.message.id)

    const second = await apiOk('/announce', {
      method: 'POST',
      token: state.b.token,
      body: { channel: state.channel, text: 'second announcement' },
    })
    assert.equal(second.message.seq, 5)
    assert.equal(second.channel.announcementId, second.message.id)

    const page = await history(state.a.token, state.channel, { limit: 100 })
    const announcements = page.messages.filter((message) => message.kind === 'announcement')
    assert.deepEqual(
      announcements.map((message) => message.text),
      ['first announcement', 'second announcement'],
      'append-only history keeps the old announcement',
    )

    const tooSoon = await api('/announce', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'third announcement' },
    })
    assertApiError(tooSoon, 429, 'rate_limited')
  })
})

describe('10 API: error envelope & #general read-only', () => {
  test('malformed bodies / kinds / missing params use {error:{code,message}}', async () => {
    const badJson = await api('/register', { method: 'POST', body: '{not json' })
    assertApiError(badJson, 400, 'invalid_request')

    const arrayBody = await api('/register', { method: 'POST', body: '[]' })
    assertApiError(arrayBody, 400, 'invalid_request')

    const badKind = await api('/register', { method: 'POST', body: { kind: 'robot' } })
    assertApiError(badKind, 400, 'invalid_request')

    const reserved = await api('/register', { method: 'POST', body: { kind: 'external', handle: 'all' } })
    assertApiError(reserved, 400, 'invalid_handle')

    const noText = await api('/send', { method: 'POST', token: state.a.token, body: { channel: state.channel } })
    assertApiError(noText, 400, 'invalid_request')

    const blankText = await api('/send', { method: 'POST', token: state.a.token, body: { channel: state.channel, text: '   ' } })
    assertApiError(blankText, 400, 'invalid_request')

    const noChannelParam = await api('/pins', { token: state.a.token })
    assertApiError(noChannelParam, 400, 'invalid_request')

    const unknownRoute = await api('/nope')
    assertApiError(unknownRoute, 404, 'not_found')
  })

  test('#general is intact: read-only history is ascending, ids match channel-NNNNNN', async () => {
    const before = state.generalBefore
    assert.ok(Array.isArray(before.messages) && before.messages.length > 0, 'existing #general data must be present')
    const seqs = before.messages.map((message) => message.seq)
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right))
    for (const message of before.messages) {
      assert.equal(message.channel, 'general')
      assert.match(message.id, /^general-\d{6}$/)
    }
    const after = await history(undefined, 'general', { limit: 5 })
    assert.ok(after.messages.length > 0)
    assert.equal(after.messages[0].channel, 'general')
  })
})
