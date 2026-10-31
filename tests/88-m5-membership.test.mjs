/**
 * 88 — M5 channel membership: join / leave (SPEC §7.8).
 *
 * A) Live defaults & gating: agents auto-join #general only; the channel creator
 *    is auto-joined; humans are exempt (always joined, never counted).
 *    Non-members can see the channel (`joined:false`, `memberCount`) but
 *    history/send/pin/announce/pins/explicit search → 403 `not_member`.
 * B) Live join/leave: POST /join /leave shapes, idempotency, #general 400,
 *    unknown channel 404; membership unlocks reads/writes and leaving locks
 *    them again; search scope follows membership.
 * C) Live SSE: hello carries joined/memberCount; live message frames and
 *    afterSeq replay are filtered by membership for identified subscribers
 *    (anonymous loopback keeps the v1 read trust).
 * D) Hermetic: persistence across restart, first-run migration (general seed +
 *    legacy creator seed), wake membership (`not_member` skip), channel_* tool
 *    behaviour (list joined flags, history 403 then join), human exemption.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DEFAULT_CHANNEL } from '../lib/contract.js'
import { applyHub } from '../lib/host/hub.js'
import { buildChannelToolDefinitions } from '../lib/host/tools.js'
import {
  MEMBERSHIPS_FILE,
  MEMBERSHIPS_VERSION,
} from '../lib/host/memberships.js'
import {
  api,
  apiOk,
  assertApiError,
  createChannel,
  history,
  joinChannel,
  leaveChannel,
  makeFakeAgent,
  makeFakeCtx,
  makeTempDataDir,
  openSse,
  register,
  search,
  seedLegacyHub,
  send,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const RUN = `${Date.now().toString(36).slice(-6)}`
const tempDirs = []
const state = {}

const MESSAGE_TOKEN = `m5tok${RUN}`

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('m5', 'a'), displayName: 'M5 A' })
  state.b = await register({ kind: 'external', handle: uniqueHandle('m5', 'b'), displayName: 'M5 B' })
  state.h = await register({ kind: 'human', displayName: 'M5 Human' })
  state.channel = uniqueChannel('m5')
  await createChannel(state.a.token, state.channel, { name: 'M5 membership' })
  // Live host may auto-join configured default members to every new channel;
  // capture that baseline instead of hard-coding counts.
  state.baseCount = (await channelView(state.a.token, state.channel)).memberCount
  // A (creator) can write immediately; B is not a member yet.
  state.aMessage = (await send(state.a.token, state.channel, `creator message ${MESSAGE_TOKEN}`)).message
})

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag) {
  const dir = makeTempDataDir(tag)
  tempDirs.push(dir)
  return dir
}

function makeHub(tag, { services = {}, config = {} } = {}) {
  const dataDir = tempDir(tag)
  const ctx = makeFakeCtx(services)
  const hub = applyHub(ctx, { dataDir, wake: false, ...config })
  assert.ok(hub !== undefined, `hermetic hub ${tag} must start`)
  return { hub, ctx, dataDir, cleanup: () => hub.dispose() }
}

/** `channels` view for one live participant (Bearer token). */
async function channelView(token, channelId) {
  const channels = await apiOk('/channels', { token })
  return channels.find((channel) => channel.id === channelId)
}

/** Consume SSE frames for `ms` and return those matching `predicate`. */
async function drainFor(sse, ms, predicate = () => true) {
  const matched = []
  const deadline = Date.now() + ms
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const frame = await sse.next(Math.max(10, remaining))
      if (predicate(frame)) matched.push(frame)
    } catch {
      break
    }
  }
  return matched
}

const isChannelMessage = (channel) => (frame) =>
  frame.event === 'message' && frame.data?.message?.channel === channel

// ---------------------------------------------------------------------------
// A) Live defaults & gating
// ---------------------------------------------------------------------------

describe('88 M5 membership: defaults & gating (live)', () => {
  test('new participants join #general only; the creator is auto-joined', async () => {
    const aView = await channelView(state.a.token, state.channel)
    assert.equal(aView.joined, true, 'creator auto-joins the channel')
    assert.equal(aView.memberCount, state.baseCount)

    const bChannels = await apiOk('/channels', { token: state.b.token })
    const general = bChannels.find((channel) => channel.id === DEFAULT_CHANNEL)
    assert.equal(general.joined, true, 'every participant is always joined to #general')
    const bView = bChannels.find((channel) => channel.id === state.channel)
    assert.equal(bView.joined, false, 'sub-channels are opt-in')
    assert.equal(bView.memberCount, state.baseCount)
    assert.equal(typeof bView.unread, 'number')
    assert.equal(typeof bView.lastSeq, 'number')

    // #general cannot be left: mandatory for every participant.
    const leaveGeneral = await api('/leave', { method: 'POST', token: state.b.token, body: { channel: DEFAULT_CHANNEL } })
    const generalError = assertApiError(leaveGeneral, 400, 'invalid_request')
    assert.match(generalError.message, /cannot leave #general/)
  })

  test('non-members are gated on history/send/pin/unpin/announce/pins/search with 403 not_member', async () => {
    const messageId = state.aMessage.id
    const calls = [
      ['/history?channel=' + encodeURIComponent(state.channel), {}],
      ['/send', { method: 'POST', body: { channel: state.channel, text: 'blocked' } }],
      ['/pin', { method: 'POST', body: { channel: state.channel, messageId } }],
      ['/unpin', { method: 'POST', body: { channel: state.channel, messageId } }],
      ['/announce', { method: 'POST', body: { channel: state.channel, text: 'blocked announcement' } }],
      ['/pins?channel=' + encodeURIComponent(state.channel), {}],
      [`/search?q=${MESSAGE_TOKEN}&channel=${encodeURIComponent(state.channel)}`, {}],
    ]
    for (const [path, options] of calls) {
      const response = await api(path, { ...options, token: state.b.token })
      const error = assertApiError(response, 403, 'not_member')
      assert.ok(error.message.includes(state.channel), `error should name the channel: ${error.message}`)
      assert.ok(/channel_join/.test(error.message), `error should suggest joining: ${error.message}`)
    }
  })

  test('a non-member still sees the channel in GET /channels (joined:false, memberCount)', async () => {
    const view = await channelView(state.b.token, state.channel)
    assert.ok(view !== undefined, 'channel_list stays visible to non-members')
    assert.equal(view.joined, false)
    assert.equal(view.memberCount, state.baseCount)
    assert.equal(typeof view.lastSeq, 'number')
    // OBS: unread is derived from the read cursor, so a non-member can see an
    // unread badge for a channel it cannot open. Harmless UI noise (reported).
    assert.equal(typeof view.unread, 'number')
  })

  test('unfiltered search only covers joined channels for identified callers', async () => {
    const result = await search(state.b.token, MESSAGE_TOKEN)
    assert.deepEqual(result.hits, [], 'non-member search must not leak the sub-channel')
    assert.equal(result.hasMore, false)

    const creatorSearch = await search(state.a.token, MESSAGE_TOKEN)
    assert.equal(creatorSearch.hits.length, 1)
    assert.equal(creatorSearch.hits[0].channel, state.channel)
  })

  test('humans are exempt: always joined, may write without join, not counted as members', async () => {
    const view = await channelView(state.h.token, state.channel)
    assert.equal(view.joined, true, 'humans are implicitly joined everywhere')
    assert.equal(view.memberCount, state.baseCount, 'humans are not stored/counted')

    const humanSend = await send(state.h.token, state.channel, 'human writes without joining')
    assert.equal(humanSend.message.seq, 2)

    const afterHuman = await channelView(state.a.token, state.channel)
    assert.equal(afterHuman.memberCount, state.baseCount, 'a human message does not change memberCount')

    const noopLeave = await apiOk('/leave', { method: 'POST', token: state.h.token, body: { channel: state.channel } })
    assert.equal(noopLeave.joined, true, 'a human leave is a no-op')
    assert.equal(noopLeave.memberCount, state.baseCount)

    const noopJoin = await apiOk('/join', { method: 'POST', token: state.h.token, body: { channel: state.channel } })
    assert.equal(noopJoin.joined, true)
    assert.equal(noopJoin.memberCount, state.baseCount, 'human join stores nothing')
  })

  test('anonymous loopback reads keep the v1 read trust (no membership gate)', async () => {
    const page = await apiOk(`/history?channel=${encodeURIComponent(state.channel)}`)
    assert.ok(page.messages.length >= 2)
    const pins = await apiOk(`/pins?channel=${encodeURIComponent(state.channel)}`)
    assert.ok(Array.isArray(pins.pins))
    const hits = await apiOk(`/search?q=${MESSAGE_TOKEN}&channel=${encodeURIComponent(state.channel)}`)
    assert.equal(hits.hits.length, 1)
  })
})

// ---------------------------------------------------------------------------
// B) Live join / leave
// ---------------------------------------------------------------------------

describe('88 M5 membership: join / leave (live)', () => {
  test('POST /join returns {channel, joined, memberCount} and unlocks reads/writes', async () => {
    const joined = await joinChannel(state.b.token, state.channel)
    assert.deepEqual(joined, { channel: state.channel, joined: true, memberCount: state.baseCount + 1 })

    const view = await channelView(state.b.token, state.channel)
    assert.equal(view.joined, true)
    assert.equal(view.memberCount, state.baseCount + 1)

    const page = await history(state.b.token, state.channel, { limit: 10 })
    assert.ok(page.messages.length >= 2, 'member can now read history')

    const sent = await send(state.b.token, state.channel, `B joined message ${MESSAGE_TOKEN}`)
    assert.equal(sent.message.channel, state.channel)

    const pin = await apiOk('/pin', {
      method: 'POST',
      token: state.b.token,
      body: { channel: state.channel, messageId: state.aMessage.id },
    })
    assert.deepEqual(pin.channel.pins.map((entry) => entry.messageId), [state.aMessage.id])
    await apiOk('/unpin', { method: 'POST', token: state.b.token, body: { channel: state.channel, messageId: state.aMessage.id } })

    const announcement = await apiOk('/announce', { method: 'POST', token: state.b.token, body: { channel: state.channel, text: 'member announcement' } })
    assert.equal(announcement.message.kind, 'announcement')

    const hits = await search(state.b.token, MESSAGE_TOKEN, { channel: state.channel })
    assert.equal(hits.hits.length >= 2, true)
    const unfiltered = await search(state.b.token, MESSAGE_TOKEN)
    assert.equal(unfiltered.hits.length >= 2, true, 'joined channels are searched')
  })

  test('joining is idempotent and unknown/invalid channels are rejected', async () => {
    const again = await joinChannel(state.b.token, state.channel)
    assert.deepEqual(again, { channel: state.channel, joined: true, memberCount: state.baseCount + 1 })

    const unknown = await api('/join', { method: 'POST', token: state.b.token, body: { channel: `qa-m5-nope-${RUN}` } })
    assertApiError(unknown, 404, 'not_found')

    for (const bad of ['', 'UPPER', 'a_b', 'x'.repeat(33)]) {
      const response = await api('/join', { method: 'POST', token: state.b.token, body: { channel: bad } })
      assert.equal(response.status, 400, `invalid channel id ${JSON.stringify(bad)} must be 400`)
      assert.equal(response.json.error.code, 'invalid_request')
    }
  })

  test('POST /leave locks the channel again; #general is mandatory', async () => {
    const left = await leaveChannel(state.b.token, state.channel)
    assert.deepEqual(left, { channel: state.channel, joined: false, memberCount: state.baseCount })

    assertApiError(await api('/send', { method: 'POST', token: state.b.token, body: { channel: state.channel, text: 'x' } }), 403, 'not_member')
    assertApiError(await api(`/history?channel=${encodeURIComponent(state.channel)}`, { token: state.b.token }), 403, 'not_member')

    const leftAgain = await leaveChannel(state.b.token, state.channel)
    assert.deepEqual(leftAgain, { channel: state.channel, joined: false, memberCount: state.baseCount }, 'leave is idempotent')

    const general = await api('/leave', { method: 'POST', token: state.b.token, body: { channel: DEFAULT_CHANNEL } })
    const error = assertApiError(general, 400, 'invalid_request')
    assert.match(error.message, /cannot leave #general/)
  })
})

describe('88 M5 membership: maintenance endpoints (live)', () => {
  test('removing a participant also clears its membership rows (memberCount stays exact)', async () => {
    const owner = await register({ kind: 'external', handle: uniqueHandle('m5', 'gown') })
    const ghost = await register({ kind: 'external', handle: uniqueHandle('m5', 'ghst') })
    const channel = uniqueChannel('m5', 'ghost')
    await createChannel(owner.token, channel, { name: 'QA ghost members' })
    const joined = await joinChannel(ghost.token, channel)
    assert.equal(joined.memberCount, state.baseCount + 1)

    const removed = await apiOk('/participants/remove', {
      method: 'POST',
      token: owner.token,
      body: { participantId: ghost.participantId },
    })
    assert.equal(removed.removed, true)

    // The participant row is gone from /members and its token is dead...
    const members = await apiOk('/members', { token: owner.token })
    assert.equal(members.participants.some((participant) => participant.id === ghost.participantId), false)
    assertApiError(await api('/whoami', { token: ghost.token }), 401, 'unauthorized')

    // ...and the membership row is gone too: memberCount no longer counts a ghost.
    const view = await channelView(owner.token, channel)
    assert.equal(view.memberCount, state.baseCount, 'memberCount must not include the removed participant')
  })

  test('OBS repro: archive/restore has no membership authorization (any Bearer may archive)', async () => {
    const owner = await register({ kind: 'external', handle: uniqueHandle('m5', 'aown') })
    const stranger = await register({ kind: 'external', handle: uniqueHandle('m5', 'astr') })
    const channel = uniqueChannel('m5', 'arch-auth')
    await createChannel(owner.token, channel, { name: 'QA archive auth' })

    const archived = await apiOk('/channels/archive', {
      method: 'POST',
      token: stranger.token,
      body: { channel, archived: true },
    })
    assert.equal(archived.channel.archived, true, 'OBS: a non-member may archive the channel')
    await apiOk('/channels/archive', {
      method: 'POST',
      token: stranger.token,
      body: { channel, archived: false },
    })
  })
})

// ---------------------------------------------------------------------------
// C) Live SSE membership filtering
// ---------------------------------------------------------------------------

describe('88 M5 membership: SSE filtering (live)', () => {
  test('hello channels carry joined/memberCount', async () => {
    const nonMember = await openSse({ token: state.b.token })
    try {
      const hello = await nonMember.next(2_000)
      const view = hello.data.channels.find((channel) => channel.id === state.channel)
      assert.equal(view.joined, false)
      assert.equal(view.memberCount, state.baseCount)
    } finally {
      nonMember.close()
    }

    await joinChannel(state.b.token, state.channel)
    const member = await openSse({ token: state.b.token })
    try {
      const hello = await member.next(2_000)
      const view = hello.data.channels.find((channel) => channel.id === state.channel)
      assert.equal(view.joined, true)
      assert.equal(view.memberCount, state.baseCount + 1)
    } finally {
      member.close()
    }
  })

  test('a non-member subscriber receives no live message frames; joining starts the stream', async () => {
    // B is a member at this point (previous test joined); leave to test filtering.
    await leaveChannel(state.b.token, state.channel)

    const sse = await openSse({ token: state.b.token })
    try {
      await sse.next(2_000) // hello
      const first = await send(state.a.token, state.channel, 'while B is not a member')
      const second = await send(state.a.token, state.channel, 'still not a member')
      const leaked = await drainFor(sse, 700, isChannelMessage(state.channel))
      assert.deepEqual(
        leaked.map((frame) => frame.data.message.id),
        [],
        'non-member must not receive live message frames (including its own channel activity)',
      )
      assert.ok(first.message.seq > 0 && second.message.seq > 0)

      await joinChannel(state.b.token, state.channel)
      const third = await send(state.a.token, state.channel, 'after B joined')
      const frame = await sse.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === third.message.id,
        2_000,
      )
      assert.equal(frame.data.message.text, 'after B joined')
    } finally {
      sse.close()
    }
  })

  test('afterSeq replay is filtered by membership and restored after joining', async () => {
    await leaveChannel(state.b.token, state.channel)
    const missed = await send(state.a.token, state.channel, `replay target ${MESSAGE_TOKEN}`)
    const afterSeq = missed.message.seq - 1

    const nonMember = await openSse({ token: state.b.token, afterSeq })
    try {
      const hello = await nonMember.next(2_000)
      assert.equal(hello.event, 'hello')
      const replayed = await drainFor(nonMember, 900, isChannelMessage(state.channel))
      assert.deepEqual(replayed.map((frame) => frame.data.message.id), [], 'non-member replay must skip the channel')
    } finally {
      nonMember.close()
    }

    await joinChannel(state.b.token, state.channel)
    const member = await openSse({ token: state.b.token, afterSeq })
    try {
      const hello = await member.next(2_000)
      assert.equal(hello.event, 'hello')
      const frame = await member.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === missed.message.id,
        3_000,
      )
      assert.equal(frame.data.message.text, `replay target ${MESSAGE_TOKEN}`)
    } finally {
      member.close()
    }
  })

  test('anonymous loopback subscribers keep the read trust (receive any channel)', async () => {
    const sse = await openSse()
    try {
      const hello = await sse.next(2_000)
      assert.equal(hello.data.participantId, '')
      const sent = await send(state.a.token, state.channel, 'anonymous may see this')
      const frame = await sse.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === sent.message.id,
        2_000,
      )
      assert.equal(frame.data.message.channel, state.channel)
    } finally {
      sse.close()
    }
  })
})

// ---------------------------------------------------------------------------
// D) Hermetic: persistence, migration, wake, tools
// ---------------------------------------------------------------------------

describe('88 M5 membership: persistence & migration (hermetic)', () => {
  test('memberships persist across a hub restart', async () => {
    const dataDir = tempDir('m5-persist')
    const hub1 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub1 !== undefined)
    let a
    let b
    const channel = 'qa-m5-persist-chan'
    try {
      a = (await hub1.register({ kind: 'external', handle: 'qa-m5-persist-a' })).participant
      b = (await hub1.register({ kind: 'external', handle: 'qa-m5-persist-b' })).participant
      await hub1.createChannel(a, { id: channel })
      hub1.joinChannel(b, channel)
      assert.equal(hub1.memberCount(channel), 2)
    } finally {
      hub1.dispose()
    }

    const hub2 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub2 !== undefined)
    try {
      const a2 = hub2.identity.byHandle(a.handle)
      const b2 = hub2.identity.byHandle(b.handle)
      assert.ok(a2 !== undefined && b2 !== undefined)
      assert.equal(hub2.memberships.isMember(a2, channel), true, 'creator membership persisted')
      assert.equal(hub2.memberships.isMember(b2, channel), true, 'join persisted')
      assert.equal(hub2.memberCount(channel), 2)

      const c = (await hub2.register({ kind: 'external', handle: 'qa-m5-persist-c' })).participant
      assert.equal(hub2.memberships.isMember(c, channel), false, 'a new participant does not inherit channels')
      assert.equal(hub2.memberships.isMember(c, DEFAULT_CHANNEL), true)

      const file = JSON.parse(readFileSync(join(dataDir, MEMBERSHIPS_FILE), 'utf8'))
      assert.equal(file.version, MEMBERSHIPS_VERSION)
      assert.deepEqual(file.members[b.id].slice().sort(), [DEFAULT_CHANNEL, channel].sort())
      assert.equal(file.members[c.id].includes(channel), false)
    } finally {
      hub2.dispose()
    }
  })

  test('first-run migration seeds #general for existing agents and re-joins legacy channel creators', async () => {
    const dataDir = tempDir('m5-migrate')
    seedLegacyHub(
      dataDir,
      [
        { id: 'general', createdBy: 'system' },
        { id: 'lobby', createdBy: 'legacy-agent' },
        { id: 'qa-legacy-sub', createdBy: 'ext-creator' },
      ],
      [
        { id: 'p_legacy_agent', handle: 'legacy-agent', kind: 'dsh-agent', binding: { kind: 'dsh-session', sessionId: 'legacy-session' } },
        { id: 'p_ext_creator', handle: 'ext-creator', kind: 'external' },
        { id: 'p_plain_agent', handle: 'plain-agent', kind: 'external' },
        { id: 'p_human_one', handle: 'human-one', kind: 'human' },
      ],
    )
    assert.equal(existsSync(join(dataDir, MEMBERSHIPS_FILE)), false, 'fixture starts without a membership file')

    const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      const legacy = hub.identity.byHandle('legacy-agent')
      const creator = hub.identity.byHandle('ext-creator')
      const plain = hub.identity.byHandle('plain-agent')
      const human = hub.identity.byHandle('human-one')
      assert.ok(legacy !== undefined && creator !== undefined && plain !== undefined && human !== undefined)

      assert.equal(hub.memberships.isMember(legacy, 'general'), true, 'migration seeds #general for existing agents')
      assert.equal(hub.memberships.isMember(legacy, 'lobby'), true, 'legacy creator is re-joined to its channel')
      assert.equal(hub.memberships.isMember(creator, 'general'), true)
      assert.equal(hub.memberships.isMember(creator, 'qa-legacy-sub'), true, 'creator seed for a second legacy channel')
      assert.equal(hub.memberships.isMember(plain, 'general'), true)
      assert.equal(hub.memberships.isMember(plain, 'lobby'), true, 'lobby is a default channel for every agent')
      assert.equal(hub.memberships.hasExplicitMembership(human.id, 'lobby'), false, 'humans are never stored')
      assert.equal(hub.memberships.isMember(human, 'qa-legacy-sub'), true, 'humans are implicitly joined')

      assert.equal(hub.memberships.memberCount('general'), 3, 'memberCount excludes the human')
      assert.equal(hub.memberships.memberCount('lobby'), 3, 'default lobby holds every agent')
      assert.equal(hub.memberships.memberCount('qa-legacy-sub'), 1)

      const file = JSON.parse(readFileSync(join(dataDir, MEMBERSHIPS_FILE), 'utf8'))
      assert.equal(file.version, MEMBERSHIPS_VERSION)
      assert.deepEqual(Object.keys(file.members).sort(), ['p_ext_creator', 'p_legacy_agent', 'p_plain_agent'])
      assert.equal(file.members.p_human_one, undefined)
    } finally {
      hub.dispose()
    }
  })

  test('creator seeding only happens on first migration (an existing file is not re-seeded)', async () => {
    const dataDir = tempDir('m5-migrate-once')
    seedLegacyHub(
      dataDir,
      [{ id: 'general', createdBy: 'system' }, { id: 'qa-legacy-sub', createdBy: 'legacy-agent' }],
      [{ id: 'p_legacy_agent', handle: 'legacy-agent', kind: 'dsh-agent' }],
    )
    const hub1 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub1 !== undefined)
    try {
      const legacy = hub1.identity.byHandle('legacy-agent')
      assert.equal(hub1.memberships.isMember(legacy, 'qa-legacy-sub'), true, 'first-run creator seed')
    } finally {
      hub1.dispose()
    }

    // Simulate an operator row change: remove the non-default creator channel, keep general.
    const file = JSON.parse(readFileSync(join(dataDir, MEMBERSHIPS_FILE), 'utf8'))
    file.members.p_legacy_agent = ['general']
    writeFileSync(join(dataDir, MEMBERSHIPS_FILE), `${JSON.stringify(file)}\n`, 'utf8')

    const hub2 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub2 !== undefined)
    try {
      const legacy = hub2.identity.byHandle('legacy-agent')
      assert.equal(hub2.memberships.isMember(legacy, 'general'), true)
      assert.equal(hub2.memberships.isMember(legacy, 'qa-legacy-sub'), false, 'no creator re-seed when the file already existed')
    } finally {
      hub2.dispose()
    }
  })
})

describe('88 M5 membership: wake gating (hermetic)', () => {
  async function wakeFixture(tag) {
    const live = new Map()
    const ctx = makeFakeCtx({ agents: { list: () => [...live.values()], get: (id) => live.get(id) } })
    const dataDir = tempDir(tag)
    const hub = applyHub(ctx, { dataDir, wake: true })
    assert.ok(hub !== undefined)
    const sender = (await hub.register({ kind: 'external', handle: uniqueHandle('m5', 'snd') })).participant
    const channel = uniqueChannel('m5', 'wake')
    await hub.createChannel(sender, { id: channel })
    const memberAgent = makeFakeAgent(`qa-m5-member-${tag}`)
    const outsiderAgent = makeFakeAgent(`qa-m5-outsider-${tag}`)
    live.set(memberAgent.id, memberAgent)
    live.set(outsiderAgent.id, outsiderAgent)
    const member = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('m5', 'mem'), sessionId: memberAgent.id })).participant
    const outsider = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('m5', 'out'), sessionId: outsiderAgent.id })).participant
    hub.joinChannel(member, channel)
    return {
      hub,
      sender,
      channel,
      member,
      outsider,
      memberAgent,
      outsiderAgent,
      cleanup: () => hub.dispose(),
    }
  }

  test('a non-member mention is stored but skipped with reason not_member', async () => {
    const fixture = await wakeFixture('not-member')
    try {
      const outcome = await fixture.hub.sendMessage(fixture.sender, {
        channel: fixture.channel,
        text: `@${fixture.member.handle} @${fixture.outsider.handle} hello`,
      })
      assert.deepEqual(outcome.message.mentions.sort(), [fixture.member.handle, fixture.outsider.handle].sort())
      assert.equal(outcome.wake.considered, 2)
      assert.deepEqual(outcome.wake.delivered.map((entry) => entry.participantId), [fixture.member.id])
      assert.deepEqual(
        outcome.wake.skipped.map((entry) => ({ id: entry.participantId, reason: entry.reason })),
        [{ id: fixture.outsider.id, reason: 'not_member' }],
      )
      assert.equal(fixture.memberAgent.steers.length, 1)
      assert.equal(fixture.outsiderAgent.steers.length, 0, 'non-member is never woken')
      assert.equal(fixture.outsiderAgent.calls.length, 0, 'non-member is never woken')

      const stored = fixture.hub.history(fixture.sender, { channel: fixture.channel, limit: 5 }).messages[0]
      assert.deepEqual(stored.mentions.sort(), [fixture.member.handle, fixture.outsider.handle].sort(), 'mentions still persist')
    } finally {
      fixture.cleanup()
    }
  })

  test('joining then mentioning wakes immediately (the not_member skip does not consume the 5s window)', async () => {
    const fixture = await wakeFixture('join-wake')
    try {
      const blocked = await fixture.hub.sendMessage(fixture.sender, {
        channel: fixture.channel,
        text: `@${fixture.outsider.handle} before join`,
      })
      assert.deepEqual(blocked.wake.skipped.map((entry) => entry.reason), ['not_member'])

      fixture.hub.joinChannel(fixture.outsider, fixture.channel)
      const woken = await fixture.hub.sendMessage(fixture.sender, {
        channel: fixture.channel,
        text: `@${fixture.outsider.handle} after join`,
      })
      assert.equal(woken.wake.delivered.length, 1)
      assert.equal(woken.wake.delivered[0].sessionId, fixture.outsiderAgent.id)
      assert.equal(fixture.outsiderAgent.steers.length, 1)
    } finally {
      fixture.cleanup()
    }
  })

  test('@all expands only to members: non-members are skipped with not_member', async () => {
    const fixture = await wakeFixture('all-wake')
    try {
      const outcome = await fixture.hub.sendMessage(fixture.sender, { channel: fixture.channel, text: '@all roll call' })
      assert.deepEqual(outcome.message.mentions, ['all'])
      assert.equal(outcome.wake.considered, 2, 'both bound sessions are considered')
      assert.deepEqual(outcome.wake.delivered.map((entry) => entry.participantId), [fixture.member.id])
      assert.deepEqual(
        outcome.wake.skipped.map((entry) => ({ id: entry.participantId, reason: entry.reason })),
        [{ id: fixture.outsider.id, reason: 'not_member' }],
      )
    } finally {
      fixture.cleanup()
    }
  })
})

describe('88 M5 membership: channel_* tools (hermetic)', () => {
  test('channel_list marks joined/memberCount; channel_history is gated until channel_join', async () => {
    const { hub, cleanup } = makeHub('m5-tools')
    try {
      const owner = (await hub.register({ kind: 'external', handle: uniqueHandle('m5', 'own') })).participant
      const channel = uniqueChannel('m5', 'tool')
      await hub.createChannel(owner, { id: channel })
      const definitions = new Map(buildChannelToolDefinitions(hub).map((definition) => [definition.name, definition]))
      const agent = { id: 'qa-m5-tool-session' }

      const list = await definitions.get('channel_list').execute({}, { agent })
      assert.equal(list.ok, true)
      const general = list.channels.find((entry) => entry.id === DEFAULT_CHANNEL)
      assert.equal(general.joined, true)
      const sub = list.channels.find((entry) => entry.id === channel)
      assert.equal(sub.joined, false, 'channel_list exposes joined:false to non-members')
      assert.equal(sub.memberCount, 1)

      const blocked = await definitions.get('channel_history').execute({ channel }, { agent })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.error.code, 'not_member')

      const joined = await definitions.get('channel_join').execute({ channel }, { agent })
      assert.deepEqual(joined, { ok: true, channel, joined: true, memberCount: 2 })

      const readable = await definitions.get('channel_history').execute({ channel }, { agent })
      assert.equal(readable.ok, true)
      assert.equal(readable.channel, channel)

      const sent = await definitions.get('channel_send').execute({ channel, text: 'tool member message' }, { agent })
      assert.equal(sent.ok, true)
      assert.equal(sent.message.channel, channel)

      const left = await definitions.get('channel_leave').execute({ channel }, { agent })
      assert.deepEqual(left, { ok: true, channel, joined: false, memberCount: 1 })
      const blockedAgain = await definitions.get('channel_history').execute({ channel }, { agent })
      assert.equal(blockedAgain.ok, false)
      assert.equal(blockedAgain.error.code, 'not_member')
    } finally {
      cleanup()
    }
  })
})
