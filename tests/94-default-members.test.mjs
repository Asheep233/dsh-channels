/**
 * 94 — default-members scoping: when `default-members.json` lists explicit
 * `channels`, those handles only auto-join those channels. Brand-new channels
 * stay creator-only, so an agent nobody invited is not silently added.
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import { makeFakeCtx, makeTempDataDir } from './_helpers.mjs'

test('default members only join the scoped channels; new channels stay creator-only', async () => {
  const dataDir = makeTempDataDir(`m6-defaults-${Date.now().toString(36)}`)
  const handles = ['qa-default-bot']
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'default-members.json'),
    JSON.stringify({ version: 1, handles, channels: ['qa-scoped-room'] }),
    'utf8',
  )
  const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
  assert.ok(hub !== undefined)
  try {
    const owner = (await hub.register({ kind: 'external', handle: 'qa-default-owner' })).participant
    const bot = (await hub.register({ kind: 'external', handle: 'qa-default-bot' })).participant
    assert.ok(bot !== undefined)

    // A scoped channel gets the default member on creation (explicit allowlist).
    await hub.createChannel(owner, { id: 'qa-scoped-room' })
    assert.equal(hub.memberCount('qa-scoped-room'), 2, 'owner + scoped default member')

    // Any other new channel is creator-only: not invited => not added.
    await hub.createChannel(owner, { id: 'qa-uninvited-room' })
    assert.equal(hub.memberCount('qa-uninvited-room'), 1, 'new channels must stay creator-only')
    assert.equal(hub.channelView(bot, 'qa-uninvited-room').joined, false)

    // A restart also does not backfill the default member into uninvited channels.
    hub.dispose()
    const again = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(again !== undefined)
    try {
      assert.equal(again.memberCount('qa-uninvited-room'), 1)
      assert.equal(again.channelView(bot, 'qa-uninvited-room').joined, false)
    } finally {
      again.dispose()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
