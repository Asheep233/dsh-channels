/**
 * 92 — M6 channel administration (SPEC §7.10): appoint channel admins (human
 * only), mute-all / per-member mute, per-channel character and frequency limits,
 * role cleanup on leave, and persistence across restarts.
 *
 * Hermetic: every case starts the hub in-process against a temp data dir.
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import {
  api,
  apiOk,
  assertApiError,
  createChannel,
  joinChannel,
  makeFakeCtx,
  makeTempDataDir,
  register,
  send,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const CHANNEL = 'qa-admin-room'

async function fixture(tag = 'admin') {
  const dataDir = makeTempDataDir(`m6-${tag}-${Date.now().toString(36)}`)
  const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
  assert.ok(hub !== undefined, 'hermetic hub must start')
  const human = (await hub.register({ kind: 'human', displayName: 'Operator' })).participant
  const admin = (await hub.register({ kind: 'external', handle: 'qa-admin-agent', harness: 'codex' })).participant
  const secondAdmin = (await hub.register({ kind: 'external', handle: 'qa-second-admin' })).participant
  const member = (await hub.register({ kind: 'external', handle: 'qa-member-agent' })).participant
  const stranger = (await hub.register({ kind: 'external', handle: 'qa-stranger' })).participant
  await hub.createChannel(human, { id: CHANNEL, name: 'QA admin room' })
  for (const participant of [admin, secondAdmin, member]) hub.joinChannel(participant, CHANNEL)
  const cleanup = () => {
    hub.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return { hub, dataDir, human, admin, secondAdmin, member, stranger, cleanup }
}

function assertHostError(fn, status, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

async function assertHostErrorAsync(fn, status, pattern) {
  await assert.rejects(async () => await fn(), (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

describe('92 channel admin: appointment & authority', () => {
  test('only the human can appoint admins; canManage flags follow the policy', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('appoint')
    try {
      assertHostError(() => hub.setChannelAdmins(admin, CHANNEL, { handle: member.handle, admin: true }), 403, /human operator/)

      const view = hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      assert.deepEqual(view.admins, [admin.handle])
      assert.equal(view.canManage, true, 'the human always manages')
      assert.equal(hub.channelView(admin, CHANNEL).canManage, true, 'appointed admin can manage')
      assert.equal(hub.channelView(member, CHANNEL).canManage, false, 'plain member cannot manage')
      assert.equal(hub.channelView(admin, CHANNEL).canAppointAdmins, false, 'admins cannot appoint')

      const members = hub.members(CHANNEL, human)
      assert.equal(members.find((entry) => entry.handle === admin.handle)?.admin, true)
      assert.notEqual(members.find((entry) => entry.handle === member.handle)?.admin, true)

      const removed = hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: false })
      assert.deepEqual(removed.admins, [])
      assert.equal(hub.channelView(admin, CHANNEL).canManage, false)
    } finally {
      cleanup()
    }
  })
})

describe('92 channel admin: mute all / mute member', () => {
  test('mutedAll blocks non-admin agents but not admins or the human', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('muteall')
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      const view = hub.setChannelMute(admin, CHANNEL, { all: true, muted: true })
      assert.equal(view.mutedAll, true)

      await assertHostErrorAsync(() => hub.sendMessage(member, { channel: CHANNEL, text: 'blocked' }), 403, /muted for all members/)
      const adminOutcome = await hub.sendMessage(admin, { channel: CHANNEL, text: 'admin may speak' })
      assert.equal(adminOutcome.message.text, 'admin may speak')
      const humanOutcome = await hub.sendMessage(human, { channel: CHANNEL, text: 'operator may speak' })
      assert.equal(humanOutcome.message.text, 'operator may speak')

      await assertHostErrorAsync(() => hub.sendMessage(member, { channel: CHANNEL, text: 'blocked again' }), 403)
      const lifted = hub.setChannelMute(admin, CHANNEL, { all: true, muted: false })
      assert.equal(lifted.mutedAll, false)
      const now = await hub.sendMessage(member, { channel: CHANNEL, text: 'allowed again' })
      assert.equal(now.message.text, 'allowed again')
    } finally {
      cleanup()
    }
  })

  test('per-member mute blocks only that member and is idempotent', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('muteone')
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      hub.setChannelMute(admin, CHANNEL, { handle: member.handle, muted: true })
      await assertHostErrorAsync(() => hub.sendMessage(member, { channel: CHANNEL, text: 'blocked' }), 403, /muted in #/)
      await hub.sendMessage(admin, { channel: CHANNEL, text: 'admin ok' })

      const members = hub.members(CHANNEL, human)
      assert.equal(members.find((entry) => entry.handle === member.handle)?.muted, true)

      hub.setChannelMute(admin, CHANNEL, { handle: member.handle, muted: true })
      hub.setChannelMute(admin, CHANNEL, { handle: member.handle, muted: false })
      const after = hub.members(CHANNEL, human)
      assert.notEqual(after.find((entry) => entry.handle === member.handle)?.muted, true)
      await hub.sendMessage(member, { channel: CHANNEL, text: 'allowed' })
    } finally {
      cleanup()
    }
  })

  test('admins cannot mute a fellow admin; the human can', async () => {
    const { hub, human, admin, secondAdmin, cleanup } = await fixture('muteadmin')
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      hub.setChannelAdmins(human, CHANNEL, { handle: secondAdmin.handle, admin: true })
      assertHostError(
        () => hub.setChannelMute(admin, CHANNEL, { handle: secondAdmin.handle, muted: true }),
        403,
        /another channel admin/,
      )
      hub.setChannelMute(human, CHANNEL, { handle: secondAdmin.handle, muted: true })
      await assertHostErrorAsync(() => hub.sendMessage(secondAdmin, { channel: CHANNEL, text: 'muted by owner' }), 403, /muted in #/)
    } finally {
      cleanup()
    }
  })

  test('non-admins cannot mute, and strangers cannot touch policy', async () => {
    const { hub, human, admin, member, stranger, cleanup } = await fixture('authz')
    try {
      assertHostError(() => hub.setChannelMute(member, CHANNEL, { handle: admin.handle, muted: true }), 403, /only a #/)
      assertHostError(() => hub.setChannelMute(stranger, CHANNEL, { all: true, muted: true }), 403, /only a #/)
      assertHostError(() => hub.setChannelLimits(member, CHANNEL, { maxChars: 10 }), 403, /only a #/)
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      assertHostError(() => hub.setChannelMute(admin, CHANNEL, { handle: stranger.handle, muted: true }), 400, /not a member/)
    } finally {
      cleanup()
    }
  })
})

describe('92 channel admin: posting limits', () => {
  test('maxChars is enforced per channel and can be reset', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('chars')
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      const view = hub.setChannelLimits(admin, CHANNEL, { maxChars: 5 })
      assert.equal(view.maxChars, 5)
      await assertHostErrorAsync(() => hub.sendMessage(member, { channel: CHANNEL, text: '123456' }), 400, /5-character limit/)
      const ok = await hub.sendMessage(member, { channel: CHANNEL, text: '12345' })
      assert.equal(ok.message.text, '12345')

      hub.setChannelLimits(admin, CHANNEL, { maxChars: null })
      const longer = await hub.sendMessage(member, { channel: CHANNEL, text: 'a much longer message is fine again' })
      assert.equal(longer.message.text, 'a much longer message is fine again')
    } finally {
      cleanup()
    }
  })

  test('per-channel frequency limit counts only that channel and exempts the human', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('rate')
    const other = 'qa-admin-other'
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      await hub.createChannel(human, { id: other, name: 'Other' })
      hub.joinChannel(member, other)
      hub.setChannelLimits(admin, CHANNEL, { ratePerMinute: 2 })

      await hub.sendMessage(member, { channel: CHANNEL, text: 'one' })
      await hub.sendMessage(member, { channel: CHANNEL, text: 'two' })
      await assertHostErrorAsync(() => hub.sendMessage(member, { channel: CHANNEL, text: 'three' }), 429, /rate limit/)

      // A different channel has no such limit for the same participant.
      const elsewhere = await hub.sendMessage(member, { channel: other, text: 'elsewhere' })
      assert.equal(elsewhere.message.text, 'elsewhere')
      // The human operator is exempt from per-channel limits.
      await hub.sendMessage(human, { channel: CHANNEL, text: 'human one' })
      await hub.sendMessage(human, { channel: CHANNEL, text: 'human two' })
      await hub.sendMessage(human, { channel: CHANNEL, text: 'human three' })
    } finally {
      cleanup()
    }
  })
})

describe('92 channel admin: lifecycle', () => {
  test('leaving a channel drops admin/muted roles', async () => {
    const { hub, human, admin, member, cleanup } = await fixture('leave')
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      hub.setChannelMute(human, CHANNEL, { handle: member.handle, muted: true })
      hub.leaveChannel(admin, CHANNEL)
      hub.leaveChannel(member, CHANNEL)
      const view = hub.channelView(human, CHANNEL)
      assert.deepEqual(view.admins, [])
      assert.deepEqual(view.muted, [])
      hub.joinChannel(admin, CHANNEL)
      assert.equal(hub.channelView(admin, CHANNEL).canManage, false, 'rejoining does not restore admin')
    } finally {
      cleanup()
    }
  })

  test('policy survives a hub restart', async () => {
    const { hub, dataDir, human, admin, member, cleanup } = await fixture('persist')
    let second
    try {
      hub.setChannelAdmins(human, CHANNEL, { handle: admin.handle, admin: true })
      hub.setChannelMute(human, CHANNEL, { handle: member.handle, muted: true })
      hub.setChannelLimits(human, CHANNEL, { maxChars: 42, ratePerMinute: 3 })
      hub.dispose()

      second = applyHub(makeFakeCtx(), { dataDir, wake: false })
      assert.ok(second !== undefined)
      const view = second.channelView(human, CHANNEL)
      assert.deepEqual(view.admins, [admin.handle])
      assert.deepEqual(view.muted, [member.handle])
      assert.equal(view.maxChars, 42)
      assert.equal(view.ratePerMinute, 3)
      await assertHostErrorAsync(() => second.sendMessage(member, { channel: CHANNEL, text: 'still muted' }), 403, /muted in #/)
    } finally {
      if (second !== undefined) second.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})


// ---------------------------------------------------------------------------
// Live HTTP: the same policies through the public API
// ---------------------------------------------------------------------------

describe('92 channel admin: live HTTP routes', () => {
  test('human appoints an admin, admin mutes all / mutes a member / sets limits', async () => {
    const human = await register({ kind: 'human', displayName: 'QA Admin Human' })
    const admin = await register({ kind: 'external', handle: uniqueHandle('qa', 'admx') })
    const member = await register({ kind: 'external', handle: uniqueHandle('qa', 'mbrx') })
    const channel = uniqueChannel('qa', 'adminx')
    try {
      await createChannel(human.token, channel, { name: 'QA admin live' })
      await joinChannel(admin.token, channel)
      await joinChannel(member.token, channel)

      const denied = await api('/channel-admins', {
        method: 'POST',
        token: admin.token,
        body: { channel, handle: member.handle, admin: true },
      })
      assertApiError(denied, 403, 'forbidden')

      const appointed = await apiOk('/channel-admins', {
        method: 'POST',
        token: human.token,
        body: { channel, handle: admin.handle, admin: true },
      })
      assert.ok(appointed.channel.admins.includes(admin.handle))
      assert.equal(appointed.channel.canAppointAdmins, true)

      const mutedAll = await apiOk('/channel-mute', {
        method: 'POST',
        token: admin.token,
        body: { channel, all: true, muted: true },
      })
      assert.equal(mutedAll.channel.mutedAll, true)
      assertApiError(await api('/send', { method: 'POST', token: member.token, body: { channel, text: 'blocked' } }), 403, 'channel_muted')
      const adminSend = await send(admin.token, channel, 'admin may speak')
      assert.equal(adminSend.message.text, 'admin may speak')
      await apiOk('/channel-mute', { method: 'POST', token: admin.token, body: { channel, all: true, muted: false } })

      await apiOk('/channel-mute', {
        method: 'POST',
        token: admin.token,
        body: { channel, handle: member.handle, muted: true },
      })
      assertApiError(await api('/send', { method: 'POST', token: member.token, body: { channel, text: 'blocked too' } }), 403, 'muted')
      const members = await apiOk(`/members?channel=${encodeURIComponent(channel)}`, { token: human.token })
      assert.equal(members.participants.find((entry) => entry.handle === member.handle)?.muted, true)
      await apiOk('/channel-mute', {
        method: 'POST',
        token: admin.token,
        body: { channel, handle: member.handle, muted: false },
      })

      const limited = await apiOk('/channel-limits', {
        method: 'POST',
        token: admin.token,
        body: { channel, maxChars: 4, ratePerMinute: 30 },
      })
      assert.equal(limited.channel.maxChars, 4)
      assert.equal(limited.channel.ratePerMinute, 30)
      const tooLong = await api('/send', { method: 'POST', token: member.token, body: { channel, text: '12345' } })
      assertApiError(tooLong, 400, 'text_too_long')
      const ok = await send(member.token, channel, '1234')
      assert.equal(ok.message.text, '1234')

      await apiOk('/channel-limits', {
        method: 'POST',
        token: admin.token,
        body: { channel, maxChars: null, ratePerMinute: null },
      })
      assertApiError(
        await api('/channel-limits', { method: 'POST', token: member.token, body: { channel, maxChars: 10 } }),
        403,
        'forbidden',
      )
    } finally {
      await api('/channels/archive', { method: 'POST', token: admin.token, body: { channel } }).catch(() => {})
    }
  })
})
