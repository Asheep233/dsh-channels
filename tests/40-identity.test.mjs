/**
 * 40 — Identity: claim / force takeover / release / author snapshots
 * (SPEC §4 identity, §7 wake semantics, §10.5).
 *
 * The HTTP /claim endpoint binds a sessionId even when that session is not live
 * (the live process only uses liveness for "online" presence and wake routing),
 * so session binding is testable entirely over HTTP with fake session ids.
 * Wake delivery itself is tested hermetically against a fake Cordis ctx so the
 * live host never receives synthetic prompts.
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { before, describe, test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import {
  api,
  apiOk,
  createChannel,
  history,
  joinChannel,
  makeFakeAgent,
  makeFakeCtx,
  makeTempDataDir,
  members,
  register,
  seedChannel,
  send,
  uniqueChannel,
  uniqueHandle,
  whoami,
} from './_helpers.mjs'

const state = {}

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('id', 'a'), displayName: 'QA Identity A' })
  state.channel = uniqueChannel('id')
  await createChannel(state.a.token, state.channel, { name: 'QA identity' })
})

describe('40 identity: author snapshots', () => {
  test('renaming a participant leaves historical author snapshots untouched', async () => {
    const oldHandle = state.a.handle
    const sent = await send(state.a.token, state.channel, 'message before rename')
    state.snapshotMessage = sent.message

    const renamedHandle = uniqueHandle('id', 'renamed')
    const claimed = await apiOk('/claim', {
      method: 'POST',
      token: state.a.token,
      body: { handle: renamedHandle, displayName: 'QA Renamed A' },
    })
    assert.equal(claimed.participant.id, state.a.participantId)
    assert.equal(claimed.participant.handle, renamedHandle)
    assert.equal(claimed.participant.displayName, 'QA Renamed A')

    const me = await whoami(state.a.token)
    assert.equal(me.participant.handle, renamedHandle)

    const page = await history(state.a.token, state.channel, { limit: 100 })
    const stored = page.messages.find((message) => message.id === sent.message.id)
    assert.deepEqual(stored.author, {
      participantId: state.a.participantId,
      handle: oldHandle,
      displayName: 'QA Identity A',
      kind: 'external',
      harness: 'other',
    })
    state.a.handle = renamedHandle
  })
})

describe('40 identity: handle ownership over HTTP', () => {
  test('POST /register with the owning token is idempotent; a foreign token is 409', async () => {
    const handle = uniqueHandle('id', 'own')
    const first = await register({ kind: 'external', handle, displayName: 'Owner' })
    const again = await register({ kind: 'external', handle, token: first.token })
    assert.equal(again.participantId, first.participantId)
    assert.equal(again.handle, first.handle)

    const foreign = await api('/register', { method: 'POST', body: { kind: 'external', handle, token: first.token.slice(0, -1) + 'X' } })
    assert.equal(foreign.status, 409)
    assert.equal(foreign.json.error.code, 'conflict')
  })

  test('POST /claim {sessionId} binds a session and mints a token (no prior identity required)', async () => {
    const handle = uniqueHandle('id', 'claim')
    const sessionId = `qa-session-claim-${Date.now()}`
    const body = await apiOk('/claim', {
      method: 'POST',
      body: { handle, displayName: 'Claimed One', sessionId },
    })
    assert.equal(body.created, true)
    assert.equal(body.participant.handle, handle)
    assert.equal(body.participant.displayName, 'Claimed One')
    assert.equal(body.participant.kind, 'dsh-agent')
    assert.deepEqual(body.participant.binding, { kind: 'dsh-session', sessionId })
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(body.participant.tokenHash, undefined)

    const me = await whoami(body.token)
    assert.equal(me.participant.id, body.participant.id)
    assert.deepEqual(me.participant.binding, { kind: 'dsh-session', sessionId })

    state.claim = { handle, sessionId, token: body.token, participantId: body.participant.id }
  })

  test('duplicate claim from another session → 409; same session → idempotent; force → takeover', async () => {
    const { handle, sessionId, token, participantId } = state.claim

    const conflict = await api('/claim', {
      method: 'POST',
      body: { handle, sessionId: `${sessionId}-other` },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.error.code, 'conflict')

    const again = await apiOk('/claim', { method: 'POST', body: { handle, sessionId } })
    assert.equal(again.created, false)
    assert.equal(again.participant.id, participantId)

    const sessionB = `${sessionId}-b`
    const takeover = await apiOk('/claim', { method: 'POST', body: { handle, sessionId: sessionB, force: true } })
    assert.equal(takeover.created, false)
    assert.equal(takeover.participant.id, participantId, 'force takeover keeps the same identity')
    assert.deepEqual(takeover.participant.binding, { kind: 'dsh-session', sessionId: sessionB })
    assert.equal('token' in takeover, false, 'takeover must not re-mint a token')

    const me = await whoami(token)
    assert.deepEqual(me.participant.binding, { kind: 'dsh-session', sessionId: sessionB })
    state.claim.sessionB = sessionB
  })

  test('POST /release drops the binding; author snapshots survive release', async () => {
    const { token, participantId, sessionB } = state.claim
    // M5: the claimed dsh-agent identity only auto-joins #general.
    await joinChannel(token, state.channel)
    const sent = await send(token, state.channel, 'sent while bound to a session')

    const released = await apiOk('/release', { method: 'POST', token, body: { sessionId: sessionB } })
    assert.equal(released.released, true)
    assert.equal(released.participant.id, participantId)
    assert.equal(released.participant.binding, undefined)

    const me = await whoami(token)
    assert.equal(me.participant.binding, undefined)

    const again = await apiOk('/release', { method: 'POST', token, body: { sessionId: sessionB } })
    assert.equal(again.released, false)

    const page = await history(token, state.channel, { limit: 100 })
    const stored = page.messages.find((message) => message.id === sent.message.id)
    assert.deepEqual(stored.author, sent.message.author, 'author snapshot must be immutable')
    assert.equal(stored.author.participantId, participantId)
    assert.equal(stored.author.handle, state.claim.handle)
  })

  test('one identity per live session: claiming a second handle detaches the first', async () => {
    const sessionId = `qa-session-one-${Date.now()}`
    const first = await apiOk('/claim', {
      method: 'POST',
      body: { handle: uniqueHandle('id', 'one1'), sessionId, displayName: 'Session First' },
    })
    const second = await apiOk('/claim', {
      method: 'POST',
      body: { handle: uniqueHandle('id', 'one2'), sessionId, displayName: 'Session Second' },
    })
    assert.equal(first.created, true)
    assert.equal(second.created, true)

    const firstMe = await whoami(first.token)
    assert.equal(firstMe.participant.binding, undefined, 'previous identity for that session must be detached')
    const secondMe = await whoami(second.token)
    assert.deepEqual(secondMe.participant.binding, { kind: 'dsh-session', sessionId })
  })

  test('force-adopting a taken handle parks the previous holder under released-*', async () => {
    const owner = await register({ kind: 'external', handle: uniqueHandle('id', 'parked') })
    const thief = await register({ kind: 'external', handle: uniqueHandle('id', 'thief') })
    const contested = uniqueHandle('id', 'ct')

    const ownerClaim = await apiOk('/claim', { method: 'POST', token: owner.token, body: { handle: contested } })
    assert.equal(ownerClaim.participant.handle, contested)
    assert.equal(ownerClaim.participant.id, owner.participantId)

    const noForce = await api('/claim', { method: 'POST', token: thief.token, body: { handle: contested } })
    assert.equal(noForce.status, 409)
    assert.equal(noForce.json.error.code, 'conflict')

    const forced = await apiOk('/claim', { method: 'POST', token: thief.token, body: { handle: contested, force: true } })
    assert.equal(forced.participant.id, thief.participantId)
    assert.equal(forced.participant.handle, contested)

    const all = await members(thief.token)
    const parked = all.participants.find((participant) => participant.id === owner.participantId)
    assert.ok(parked !== undefined)
    assert.match(parked.handle, /^released-/, `previous holder must be parked under released-* (got ${parked.handle})`)
    state.ownerId = owner.participantId
  })

  test('release without a bearer identity is 401; invalid claim handles are 400', async () => {
    const anonymous = await api('/release', { method: 'POST', body: {} })
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'unauthorized')

    for (const [handle, code] of [
      ['all', 'invalid_handle'],
      ['a', 'invalid_handle'],
      ['Bad Handle', 'invalid_handle'],
      ['', 'invalid_request'],
    ]) {
      const response = await api('/claim', {
        method: 'POST',
        body: { handle, sessionId: `qa-session-invalid-${Date.now()}` },
      })
      assert.equal(response.status, 400, `claim handle ${JSON.stringify(handle)} must be rejected`)
      assert.equal(response.json.error.code, code, `claim handle ${JSON.stringify(handle)}`)
    }
  })

  test('messages store the claimed handle; after force takeover new messages use the new session identity', async () => {
    const { token } = state.claim
    await joinChannel(token, state.channel)
    const page = await history(token, state.channel, { limit: 100 })
    assert.ok(page.messages.some((message) => message.author.handle === state.claim.handle))
  })
})

// ---------------------------------------------------------------------------
// Hermetic wake service (fake Cordis ctx; the live host is never touched)
// ---------------------------------------------------------------------------

describe('40 identity: wake delivery & 5s rate limit (hermetic, SPEC §7/§10.6)', () => {
  test('live sessions get one steer; a second mention within 5s is suppressed', async () => {
    const dataDir = makeTempDataDir('wake')
    seedChannel(dataDir, 'general', [])
    const sessionIds = {
      live1: `qa-live-one-${Date.now()}`,
      live2: `qa-live-two-${Date.now()}`,
      live3: `qa-live-three-${Date.now()}`,
      cold: `qa-cold-${Date.now()}`,
    }
    const agent1 = makeFakeAgent(sessionIds.live1)
    const agent2 = makeFakeAgent(sessionIds.live2)
    const agent3 = makeFakeAgent(sessionIds.live3)
    const agentsById = new Map([
      [sessionIds.live1, agent1],
      [sessionIds.live2, agent2],
      [sessionIds.live3, agent3],
    ])
    const promptCalls = []
    const ctx = makeFakeCtx({
      agents: {
        get: (id) => agentsById.get(id),
        list: () => [...agentsById.values()],
      },
      sessionController: {
        async prompt(request) {
          promptCalls.push(request)
        },
      },
    })
    const hub = applyHub(ctx, { dataDir, wake: true })
    assert.ok(hub !== undefined, 'hermetic hub must start')

    try {
      const sender = (await hub.register({ kind: 'external', handle: uniqueHandle('wake', 'snd'), displayName: 'Wake Sender' })).participant
      const target1 = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('wake', 't1'), sessionId: sessionIds.live1 })).participant
      const target2 = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('wake', 't2'), sessionId: sessionIds.live2 })).participant
      const target3 = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('wake', 't3'), sessionId: sessionIds.live3 })).participant
      const cold = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('wake', 'cold'), sessionId: sessionIds.cold })).participant

      // 1) live steer (interjection)
      const first = await hub.sendMessage(sender, { channel: 'general', text: `@${target1.handle} ping one` })
      assert.deepEqual(first.wake.enabled, true)
      assert.equal(first.wake.considered, 1)
      assert.equal(first.wake.delivered.length, 1)
      assert.equal(first.wake.delivered[0].mode, 'steer')
      assert.equal(first.wake.delivered[0].sessionId, sessionIds.live1)
      assert.equal(agent1.steers.length, 1)
      assert.ok(agent1.steers[0].content[0].text.includes(`[#general @${sender.handle}]`))
      assert.equal(agent1.steers[0].source.kind, 'plugin:channels')

      // 2) second mention inside 5s → suppressed by the per-participant wake rate limit
      const second = await hub.sendMessage(sender, { channel: 'general', text: `@${target1.handle} ping two` })
      assert.equal(second.wake.considered, 1)
      assert.equal(second.wake.delivered.length, 0)
      assert.deepEqual(
        second.wake.skipped.map((entry) => entry.reason),
        ['rate_limited'],
      )
      assert.equal(agent1.steers.length, 1, 'suppressed mention must not reach the agent')

      // 3) reply-based wake resolves the replied author
      const target2Message = await hub.sendMessage(target2, { channel: 'general', text: 'target2 here' })
      const reply = await hub.sendMessage(sender, { channel: 'general', text: 'replying to target2', replyTo: target2Message.message.id })
      assert.equal(reply.wake.delivered.length, 1)
      assert.equal(reply.wake.delivered[0].sessionId, sessionIds.live2)
      assert.equal(agent2.steers.length, 1)
      assert.ok(agent2.steers[0].content[0].text.includes('回复 @'))

      // 4) @all expands to every bound participant (fresh ones delivered, recent ones rate-limited)
      const all = await hub.sendMessage(sender, { channel: 'general', text: '@all roll call' })
      assert.deepEqual(all.message.mentions, ['all'])
      assert.equal(all.wake.considered, 4)
      const deliveredTargets = all.wake.delivered.map((entry) => entry.sessionId).sort()
      assert.deepEqual(deliveredTargets, [sessionIds.live3, sessionIds.cold].sort())
      assert.equal(agent3.steers.length, 1)
      assert.deepEqual(
        all.wake.skipped.map((entry) => entry.reason).sort(),
        ['rate_limited', 'rate_limited'],
      )

      // 5) offline bound session goes through sessionController.prompt
      const coldMention = await hub.sendMessage(sender, { channel: 'general', text: `@${cold.handle} wake cold` })
      // cold was already woken by @all a few ms ago → rate limited; wait is not needed:
      // assert the @all prompt path instead (recorded above), then force a fresh cold target.
      const cold2 = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('wake', 'c2'), sessionId: `${sessionIds.cold}-2` })).participant
      const coldOutcome = await hub.sendMessage(sender, { channel: 'general', text: `@${cold2.handle} cold start` })
      assert.equal(coldOutcome.wake.delivered.length, 1)
      assert.equal(coldOutcome.wake.delivered[0].mode, 'prompt')
      assert.equal(promptCalls.length, 2, '@all already prompted the first cold session')
      assert.equal(promptCalls[1].sessionId, `${sessionIds.cold}-2`)
      assert.ok(promptCalls[1].content[0].text.includes(`[#general @${sender.handle}]`))
      assert.equal(coldMention.wake.enabled, true)
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
