/**
 * 45 — Presence: activity-derived online / idle / offline (SPEC §4 + README).
 *
 * Hermetic: temp dataDir + fake Cordis ctx; never touches the live hub.
 * The semantics under test:
 *   online  — lastSeen within 2 minutes (any participant kind)
 *   idle    — not fresh, but the bound DSH session is live, or seen within 30 min
 *   offline — otherwise
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, describe, test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import { makeFakeAgent, makeFakeCtx, makeTempDataDir } from './_helpers.mjs'

const SIX_HOURS = 6 * 60 * 60_000

function staleIso(ms) {
  return new Date(Date.now() - ms).toISOString()
}

function makeHub() {
  const live = new Set()
  const ctx = makeFakeCtx({
    agents: {
      get(id) {
        return live.has(id) ? makeFakeAgent(id) : undefined
      },
    },
  })
  const dataDir = makeTempDataDir('presence')
  const hub = applyHub(ctx, { dataDir, wake: false })
  return { hub, live, dataDir }
}

async function ageParticipant(hub, participant, ms) {
  const current = hub.store.getParticipant(participant.id)
  const next = { ...current, lastSeen: staleIso(ms) }
  await hub.store.putParticipant(next)
  return next
}

describe('45 presence: derived status', () => {
  test('a fresh participant is online regardless of kind', async () => {
    const { hub, dataDir } = makeHub()
    try {
      const external = await hub.identity.register({
        kind: 'external',
        handle: 'presence-ext',
        harness: 'other',
      })
      assert.equal(hub.identity.view(external.participant).status, 'online')
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a loaded DSH session that has been quiet becomes idle, not online', async () => {
    const { hub, live, dataDir } = makeHub()
    try {
      const participant = await hub.identity.ensureSessionParticipant('sess-quiet')
      live.add('sess-quiet')
      assert.equal(hub.identity.view(participant).status, 'online', 'fresh activity is online')

      await ageParticipant(hub, participant, SIX_HOURS)
      const view = hub.identity.view(hub.store.getParticipant(participant.id))
      assert.equal(view.status, 'idle', 'live session + stale lastSeen → idle (not online)')
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('stale and not live is offline; recently seen and not live is idle', async () => {
    const { hub, dataDir } = makeHub()
    try {
      const participant = await hub.identity.ensureSessionParticipant('sess-closed')
      await ageParticipant(hub, participant, SIX_HOURS)
      assert.equal(hub.identity.view(hub.store.getParticipant(participant.id)).status, 'offline')

      await ageParticipant(hub, participant, 5 * 60_000)
      assert.equal(hub.identity.view(hub.store.getParticipant(participant.id)).status, 'idle')
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('noteActivity refreshes a stale participant to online', async () => {
    const { hub, dataDir } = makeHub()
    try {
      const participant = await hub.identity.ensureSessionParticipant('sess-activity')
      await ageParticipant(hub, participant, SIX_HOURS)
      const stale = hub.store.getParticipant(participant.id)
      assert.equal(hub.identity.view(stale).status, 'offline')

      hub.noteActivity(stale)
      await new Promise((resolve) => setTimeout(resolve, 80))
      const refreshed = hub.store.getParticipant(participant.id)
      assert.equal(hub.identity.view(refreshed).status, 'online')
      assert.notEqual(refreshed.lastSeen, stale.lastSeen)
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('heartbeat touches lastSeen and reports online', async () => {
    const { hub, dataDir } = makeHub()
    try {
      const participant = await hub.identity.ensureSessionParticipant('sess-heartbeat')
      await ageParticipant(hub, participant, SIX_HOURS)
      const stale = hub.store.getParticipant(participant.id)
      const view = await hub.heartbeat(stale)
      assert.equal(view.status, 'online')
      assert.notEqual(view.lastSeen, stale.lastSeen)
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
