/**
 * 86 — M4 per-session switches: hidden / muted (SPEC §7.7).
 *
 * A) Live HTTP: `GET /session-prefs?sessionId=` (loopback read, defaults
 *    {hidden:false,muted:false}) and `POST /session-prefs` (Bearer only,
 *    boolean/field validation, merge, clear, updatedBy).
 * B) Hermetic: persistence across hub restart, corrupt/unsupported files,
 *    read-only hub.
 * C) Hermetic tool masking: `hidden` masks every `channel_*` name via
 *    `agent.ctx.tools.restrict({deny})`, idempotent, resumed agents re-masked,
 *    show/dispose/agent-disposed release, startup applies persisted prefs.
 * D) Hermetic wake: muted/hidden sessions are skipped (reason `muted`) without
 *    consuming the 5s wake window, and unmute takes effect immediately.
 * E) Hermetic `/channels status|hide|show|mute|unmute|join|leave` command.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { CHANNEL_TOOL_NAMES } from '../lib/contract.js'
import {
  applyChannelsCommand,
  CHANNELS_COMMAND_ACTIONS,
  CHANNELS_COMMAND_USAGE,
  parseCommandAction,
  parseCommandArgs,
  statusText,
} from '../lib/host/commands.js'
import { applyHub } from '../lib/host/hub.js'
import { normalizeSessionId, SESSION_PREFS_FILE, SESSION_PREFS_VERSION } from '../lib/host/session-prefs.js'
import {
  api,
  apiOk,
  assertApiError,
  joinChannel,
  makeFakeAgent,
  makeFakeCommands,
  makeFakeCtx,
  makeRestrictableAgent,
  makeTempDataDir,
  register,
  sessionPrefs,
  setSessionPrefs,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const RUN = `${Date.now().toString(36).slice(-6)}`
const tempDirs = []
const state = {}

before(async () => {
  state.sessionId = `qa-m4-live-${RUN}`
  state.participant = await register({ kind: 'external', handle: uniqueHandle('m4', 'http'), displayName: 'M4 HTTP' })
})

after(async () => {
  // Leave the live host's prefs table clean.
  try {
    await setSessionPrefs(state.participant.token, state.sessionId, { hidden: false, muted: false })
  } catch {
    /* host may be gone; nothing to clean */
  }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// A) Live HTTP
// ---------------------------------------------------------------------------

describe('86 M4 session-prefs: HTTP (live)', () => {
  test('GET defaults to {hidden:false, muted:false} and works tokenless on loopback', async () => {
    const body = await sessionPrefs(undefined, state.sessionId)
    assert.equal(body.sessionId, state.sessionId)
    assert.deepEqual(body.prefs, { hidden: false, muted: false })
  })

  test('GET validates sessionId: missing/blank/too long/control chars → 400', async () => {
    for (const query of ['', '?sessionId=', '?sessionId=%20%20', `?sessionId=${'x'.repeat(201)}`, '?sessionId=a%00b', '?sessionId=a%1Fb']) {
      const response = await api(`/session-prefs${query}`)
      assertApiError(response, 400, 'invalid_request')
    }
  })

  test('POST requires a Bearer identity (loopback trust is read-only)', async () => {
    assertApiError(
      await api('/session-prefs', { method: 'POST', body: { sessionId: state.sessionId, hidden: true } }),
      401,
      'unauthorized',
    )
    assertApiError(
      await api('/session-prefs', { method: 'POST', token: 'bogus-token', body: { sessionId: state.sessionId, muted: true } }),
      401,
      'unauthorized',
    )
  })

  test('POST validates the patch: at least one boolean field', async () => {
    const cases = [
      {},
      { hidden: 'yes' },
      { muted: 1 },
      { hidden: null, muted: null },
    ]
    for (const patch of cases) {
      const response = await setSessionPrefs(state.participant.token, state.sessionId, patch)
      assertApiError(response, 400, 'invalid_request')
    }
    const noSession = await api('/session-prefs', { method: 'POST', token: state.participant.token, body: { hidden: true } })
    assertApiError(noSession, 400, 'invalid_request')
  })

  test('clearing an unknown session is a no-op that returns defaults', async () => {
    const cleared = await setSessionPrefs(state.participant.token, `qa-m4-unknown-${RUN}`, { hidden: false, muted: false })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.json.prefs, { hidden: false, muted: false })
    const read = await sessionPrefs(undefined, `qa-m4-unknown-${RUN}`)
    assert.deepEqual(read.prefs, { hidden: false, muted: false })
  })

  test('set / merge / clear round-trip with updatedAt + updatedBy', async () => {
    const hidden = await apiOk('/session-prefs', {
      method: 'POST',
      token: state.participant.token,
      body: { sessionId: `  ${state.sessionId}  `, hidden: true },
    })
    assert.equal(hidden.sessionId, state.sessionId, 'sessionId must be trimmed')
    assert.equal(hidden.prefs.hidden, true)
    assert.equal(hidden.prefs.muted, false)
    assert.match(hidden.prefs.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(hidden.prefs.updatedBy, state.participant.handle)

    const merged = await setSessionPrefs(state.participant.token, state.sessionId, { muted: true })
    assert.equal(merged.status, 200)
    assert.equal(merged.json.prefs.hidden, true, 'merge keeps hidden')
    assert.equal(merged.json.prefs.muted, true)
    assert.ok(Date.parse(merged.json.prefs.updatedAt) >= Date.parse(hidden.prefs.updatedAt))

    const read = await sessionPrefs(state.participant.token, state.sessionId)
    assert.deepEqual(read.prefs, merged.json.prefs)

    const hiddenOnly = await setSessionPrefs(state.participant.token, state.sessionId, { muted: false })
    assert.equal(hiddenOnly.json.prefs.hidden, true)
    assert.equal(hiddenOnly.json.prefs.muted, false)

    const cleared = await setSessionPrefs(state.participant.token, state.sessionId, { hidden: false, muted: false })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.json.prefs, { hidden: false, muted: false }, 'clearing both removes the row')
  })
})

// ---------------------------------------------------------------------------
// B) Persistence (hermetic)
// ---------------------------------------------------------------------------

describe('86 M4 session-prefs: persistence (hermetic)', () => {
  test('hidden/muted survive a hub restart and are stored atomically', async () => {
    const dataDir = tempDir('m4-persist')
    const hub1 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub1 !== undefined)
    try {
      const prefs = await hub1.setSessionPrefs('qa-session-persist', { hidden: true, muted: true }, 'tester')
      assert.deepEqual({ hidden: prefs.hidden, muted: prefs.muted, by: prefs.updatedBy }, { hidden: true, muted: true, by: 'tester' })

      const file = JSON.parse(readFileSync(join(dataDir, SESSION_PREFS_FILE), 'utf8'))
      assert.equal(file.version, SESSION_PREFS_VERSION)
      assert.equal(file.sessions['qa-session-persist'].hidden, true)
      assert.equal(file.sessions['qa-session-persist'].muted, true)
    } finally {
      hub1.dispose()
    }

    const hub2 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub2 !== undefined)
    try {
      const prefs = hub2.sessionPrefsFor('qa-session-persist')
      assert.equal(prefs.hidden, true)
      assert.equal(prefs.muted, true)
      assert.equal(prefs.updatedBy, 'tester')

      await hub2.setSessionPrefs('qa-session-persist', { hidden: false, muted: false }, 'tester')
      assert.deepEqual(hub2.sessionPrefsFor('qa-session-persist'), { hidden: false, muted: false })
      const file = JSON.parse(readFileSync(join(dataDir, SESSION_PREFS_FILE), 'utf8'))
      assert.deepEqual(file.sessions, {}, 'cleared sessions disappear from disk')
    } finally {
      hub2.dispose()
    }
  })

  test('corrupt / unsupported-version prefs files are tolerated', async () => {
    const corruptDir = tempDir('m4-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, SESSION_PREFS_FILE), '{not json', 'utf8')
    const hubCorrupt = applyHub(makeFakeCtx(), { dataDir: corruptDir, wake: false })
    assert.ok(hubCorrupt !== undefined, 'a corrupt prefs file must not fail activation')
    try {
      assert.deepEqual(hubCorrupt.sessionPrefsFor('any'), { hidden: false, muted: false })
      await hubCorrupt.setSessionPrefs('any', { muted: true }, 'tester')
      const file = JSON.parse(readFileSync(join(corruptDir, SESSION_PREFS_FILE), 'utf8'))
      assert.equal(file.version, SESSION_PREFS_VERSION)
      assert.equal(file.sessions.any.muted, true)
    } finally {
      hubCorrupt.dispose()
    }

    const versionDir = tempDir('m4-version')
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(
      join(versionDir, SESSION_PREFS_FILE),
      JSON.stringify({ version: 99, sessions: { s1: { hidden: true, updatedAt: 'x', updatedBy: 'y' } } }),
      'utf8',
    )
    const hubVersion = applyHub(makeFakeCtx(), { dataDir: versionDir, wake: false })
    assert.ok(hubVersion !== undefined)
    try {
      assert.deepEqual(hubVersion.sessionPrefsFor('s1'), { hidden: false, muted: false }, 'unknown version is ignored')
    } finally {
      hubVersion.dispose()
    }
  })

  test('read-only hub refuses preference writes with 503 readonly', async () => {
    const dataDir = tempDir('m4-readonly')
    const { seedChannel, seedLock } = await import('./_helpers.mjs')
    seedChannel(dataDir, 'general', [])
    seedLock(dataDir, 1) // pid 1: alive, not us → read-only
    const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      assert.equal(hub.writer, false)
      assert.throws(
        () => hub.setSessionPrefs('qa-session-ro', { hidden: true }, 'tester'),
        (error) => error.status === 503 && error.code === 'readonly',
      )
    } finally {
      hub.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// C) Hidden masks tools (hermetic)
// ---------------------------------------------------------------------------

describe('86 M4 hidden: tool masking (hermetic)', () => {
  const SESSION = 'qa-session-mask'

  function makeAgents() {
    const agents = new Map()
    const list = () => [...agents.values()]
    return {
      agents,
      service: { list, get: (id) => agents.get(id) },
    }
  }

  test('hidden masks every channel_* tool on the live agent (deny = CHANNEL_TOOL_NAMES)', async () => {
    const live = makeAgents()
    const agent = makeRestrictableAgent(SESSION)
    live.agents.set(SESSION, agent)
    const { hub, ctx, cleanup } = makeHub('m4-mask', { services: { agents: live.service } })
    try {
      assert.equal(hub.sessionPrefs.maskedCount(), 0)
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')

      assert.equal(hub.sessionPrefs.isMasked(SESSION), true)
      assert.equal(agent.denies.length, 1)
      const deny = agent.denies[0].deny
      assert.ok(Array.isArray(deny))
      // Functionally all 18 contract tool names must be denied (the array may
      // contain join/leave twice; see OBS in the report).
      assert.equal(new Set(deny).size, CHANNEL_TOOL_NAMES.length)
      assert.deepEqual([...new Set(deny)].sort(), [...CHANNEL_TOOL_NAMES].sort())
      assert.equal(deny.includes('channel_join'), true)
      assert.equal(deny.includes('channel_leave'), true)
      assert.equal(ctx.listenerCount >= 2, true, 'agent/created + agent/disposed listeners registered')
    } finally {
      cleanup()
    }
  })

  test('re-setting hidden is idempotent; show releases the mask immediately', async () => {
    const live = makeAgents()
    const agent = makeRestrictableAgent(SESSION)
    live.agents.set(SESSION, agent)
    const { hub, cleanup } = makeHub('m4-mask-idem', { services: { agents: live.service } })
    try {
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')
      assert.equal(agent.denies.length, 1, 'the same agent object must not be restricted twice')
      assert.equal(hub.sessionPrefs.maskedCount(), 1)

      await hub.setSessionPrefs(SESSION, { hidden: false }, 'tester')
      assert.equal(hub.sessionPrefs.isMasked(SESSION), false)
      assert.equal(agent.disposerCalls, 1, 'show must call the restriction disposer')
    } finally {
      cleanup()
    }
  })

  test('a resumed agent (same session id, new object) is re-masked and the stale mask released', async () => {
    const live = makeAgents()
    const first = makeRestrictableAgent(SESSION)
    live.agents.set(SESSION, first)
    const { hub, cleanup } = makeHub('m4-mask-resume', { services: { agents: live.service } })
    try {
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')
      assert.equal(first.denies.length, 1)

      const resumed = makeRestrictableAgent(SESSION)
      live.agents.set(SESSION, resumed)
      hub.sessionPrefs.applyToAgent(resumed)
      assert.equal(first.disposerCalls, 1, 'stale mask for the previous agent scope must be released')
      assert.equal(resumed.denies.length, 1, 'resumed agent gets the mask again')
      assert.equal(hub.sessionPrefs.maskedCount(), 1)
    } finally {
      cleanup()
    }
  })

  test('agent/created applies the mask; agent/disposed releases it', async () => {
    const live = makeAgents()
    const { hub, ctx, cleanup } = makeHub('m4-mask-events', { services: { agents: live.service } })
    try {
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')
      // No live agent yet → nothing masked.
      assert.equal(hub.sessionPrefs.maskedCount(), 0)

      const created = makeRestrictableAgent(SESSION)
      live.agents.set(SESSION, created)
      ctx.emit('agent/created', { agent: created })
      assert.equal(created.denies.length, 1, 'agent/created must re-apply hidden masking')

      ctx.emit('agent/disposed', { agent: created })
      assert.equal(created.disposerCalls, 1, 'agent/disposed must release the mask')
      assert.equal(hub.sessionPrefs.isMasked(SESSION), false)
    } finally {
      cleanup()
    }
  })

  test('persisted hidden prefs mask live agents on hub startup', async () => {
    const dataDir = tempDir('m4-mask-startup')
    const hub1 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub1 !== undefined)
    try {
      await hub1.setSessionPrefs(SESSION, { hidden: true }, 'tester')
    } finally {
      hub1.dispose()
    }

    const live = makeAgents()
    const agent = makeRestrictableAgent(SESSION)
    live.agents.set(SESSION, agent)
    const hub2 = applyHub(makeFakeCtx({ agents: live.service }), { dataDir, wake: false })
    assert.ok(hub2 !== undefined)
    try {
      assert.equal(agent.denies.length, 1, 'startup must mask a persisted hidden session')
      assert.deepEqual([...new Set(agent.denies[0].deny)].sort(), [...CHANNEL_TOOL_NAMES].sort())
    } finally {
      hub2.dispose()
    }
    assert.equal(agent.disposerCalls, 1, 'hub dispose must release masks')
  })

  test('an agent without a tool registry keeps the preference and does not crash', async () => {
    const plain = makeFakeAgent(SESSION)
    const { hub, cleanup } = makeHub('m4-mask-noregistry', {
      services: { agents: { list: () => [plain], get: () => plain } },
    })
    try {
      await hub.setSessionPrefs(SESSION, { hidden: true }, 'tester')
      assert.equal(hub.sessionPrefsFor(SESSION).hidden, true)
      assert.equal(hub.sessionPrefs.maskedCount(), 0)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// D) Wake: muted / hidden (hermetic)
// ---------------------------------------------------------------------------

describe('86 M4 wake: muted / hidden (hermetic)', () => {
  async function makeWakeFixture(tag) {
    const live = new Map()
    const ctx = makeFakeCtx({
      agents: { list: () => [...live.values()], get: (id) => live.get(id) },
    })
    const dataDir = tempDir(tag)
    const hub = applyHub(ctx, { dataDir, wake: true })
    assert.ok(hub !== undefined)
    const sender = (await hub.register({ kind: 'external', handle: uniqueHandle('m4', 'snd') })).participant
    const sessionId = `qa-session-wake-${tag}`
    const agent = makeFakeAgent(sessionId)
    live.set(sessionId, agent)
    const target = (await hub.register({ kind: 'dsh-agent', handle: uniqueHandle('m4', 'tgt'), displayName: 'M4 Target', sessionId })).participant
    return { hub, agent, sender, target, sessionId, cleanup: () => hub.dispose() }
  }

  test('muted skips wake with reason muted; the message and mention are stored', async () => {
    const fixture = await makeWakeFixture('muted')
    try {
      await fixture.hub.setSessionPrefs(fixture.sessionId, { muted: true }, 'tester')
      const outcome = await fixture.hub.sendMessage(fixture.sender, {
        channel: 'general',
        text: `@${fixture.target.handle} please wake`,
      })
      assert.equal(outcome.wake.considered, 1)
      assert.deepEqual(outcome.wake.delivered, [])
      assert.deepEqual(outcome.wake.skipped.map((entry) => entry.reason), ['muted'])
      assert.equal(fixture.agent.steers.length, 0, 'muted session must not receive a steer')
      assert.equal(fixture.agent.calls.length, 0, 'muted session must not receive a followup')

      const page = fixture.hub.history(fixture.sender, { channel: 'general', limit: 10 })
      const stored = page.messages.find((message) => message.id === outcome.message.id)
      assert.equal(stored.text, `@${fixture.target.handle} please wake`)
      assert.deepEqual(stored.mentions, [fixture.target.handle], 'mention is still persisted')
    } finally {
      fixture.cleanup()
    }
  })

  test('unmuting takes effect immediately (the muted skip does not consume the 5s window)', async () => {
    const fixture = await makeWakeFixture('unmute')
    try {
      await fixture.hub.setSessionPrefs(fixture.sessionId, { muted: true }, 'tester')
      const muted = await fixture.hub.sendMessage(fixture.sender, { channel: 'general', text: `@${fixture.target.handle} one` })
      assert.deepEqual(muted.wake.skipped.map((entry) => entry.reason), ['muted'])

      const prefs = await fixture.hub.setSessionPrefs(fixture.sessionId, { muted: false }, 'tester')
      assert.equal(prefs.muted, false)

      const woken = await fixture.hub.sendMessage(fixture.sender, { channel: 'general', text: `@${fixture.target.handle} two` })
      assert.equal(woken.wake.delivered.length, 1, 'unmute must wake on the very next mention')
      assert.equal(woken.wake.delivered[0].sessionId, fixture.sessionId)
      assert.equal(fixture.agent.steers.length, 1)
    } finally {
      fixture.cleanup()
    }
  })

  test('hidden implies muted: a hidden session is never woken (reason muted)', async () => {
    const fixture = await makeWakeFixture('hidden')
    try {
      await fixture.hub.setSessionPrefs(fixture.sessionId, { hidden: true }, 'tester')
      const outcome = await fixture.hub.sendMessage(fixture.sender, {
        channel: 'general',
        text: `@${fixture.target.handle} hidden ping`,
      })
      assert.deepEqual(outcome.wake.skipped.map((entry) => entry.reason), ['muted'])
      assert.equal(fixture.agent.steers.length, 0)
      assert.equal(fixture.agent.calls.length, 0)

      const reply = await fixture.hub.sendMessage(fixture.target, { channel: 'general', text: 'target wrote this' })
      const replied = await fixture.hub.sendMessage(fixture.sender, {
        channel: 'general',
        text: 'replying to hidden target',
        replyTo: reply.message.id,
      })
      // The replied author is the hidden session itself; it must not be woken.
      assert.deepEqual(replied.wake.skipped.map((entry) => entry.reason), ['muted'])
    } finally {
      fixture.cleanup()
    }
  })

  test('muted affects wake only: a muted session can still read/write tools', async () => {
    const fixture = await makeWakeFixture('muted-tools')
    try {
      await fixture.hub.setSessionPrefs(fixture.sessionId, { muted: true }, 'tester')
      const sent = await fixture.hub.sendMessage(fixture.target, { channel: 'general', text: 'muted but writing' })
      assert.equal(sent.message.text, 'muted but writing')
      const page = fixture.hub.history(fixture.target, { channel: 'general', limit: 5 })
      assert.ok(page.messages.length > 0)
      assert.equal(fixture.hub.sessionPrefsFor(fixture.sessionId).muted, true)
    } finally {
      fixture.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// E) /channels command (hermetic)
// ---------------------------------------------------------------------------

describe('86 M4 /channels command (hermetic)', () => {
  test('parseCommandArgs splits action/argument and defaults to status', () => {
    assert.deepEqual(parseCommandArgs(undefined), { action: 'status', argument: '' })
    assert.deepEqual(parseCommandArgs('   '), { action: 'status', argument: '' })
    assert.deepEqual(parseCommandArgs('hide'), { action: 'hide', argument: '' })
    assert.deepEqual(parseCommandArgs('  MUTE  '), { action: 'mute', argument: '' })
    assert.deepEqual(parseCommandArgs('join lobby'), { action: 'join', argument: 'lobby' })
    assert.deepEqual(parseCommandArgs('leave   qa-chan'), { action: 'leave', argument: 'qa-chan' })
    assert.equal(parseCommandAction('status'), 'status')
    assert.ok(CHANNELS_COMMAND_ACTIONS.includes('join'))
    assert.ok(CHANNELS_COMMAND_ACTIONS.includes('leave'))
  })

  test('installCommands registers /channels with a hint and disposes cleanly', () => {
    const commands = makeFakeCommands()
    const dataDir = tempDir('m4-cmd-install')
    const ctx = makeFakeCtx({ commands })
    const hub = applyHub(ctx, { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      assert.equal(commands.definitions.length, 1)
      const definition = commands.definitions[0]
      assert.equal(definition.name, 'channels')
      assert.match(definition.description, /隐藏|免打扰/)
      assert.match(definition.input.hint, /status\|hide\|show\|mute\|unmute/)
      assert.equal(typeof definition.handler, 'function')
    } finally {
      ctx.runEffects() // plugin unload: run ctx.effect disposers
      hub.dispose()
    }
    assert.equal(commands.definitions.length, 0, 'dispose unregisters the command')
  })

  test('status/hide/show/mute/unmute return the exact SPEC §7.7 text', async () => {
    const commands = makeFakeCommands()
    const dataDir = tempDir('m4-cmd-text')
    const hub = applyHub(makeFakeCtx({ commands }), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    const sessionId = 'qa-session-cmd'
    const agent = { id: sessionId }
    try {
      const status = await commands.invoke('channels', '', agent)
      assert.deepEqual(status, { kind: 'success', text: '频道：正常；免打扰：关' })
      assert.equal(statusText(hub.sessionPrefsFor(sessionId)), '频道：正常；免打扰：关')

      const hidden = await commands.invoke('channels', 'hide', agent)
      assert.deepEqual(hidden, { kind: 'success', text: '频道：隐藏；免打扰：关' })
      assert.equal(hub.sessionPrefsFor(sessionId).hidden, true)

      const muted = await commands.invoke('channels', 'mute', agent)
      assert.deepEqual(muted, { kind: 'success', text: '频道：隐藏；免打扰：开' })

      const shown = await commands.invoke('channels', 'show', agent)
      assert.deepEqual(shown, { kind: 'success', text: '频道：正常；免打扰：开' })

      const unmuted = await commands.invoke('channels', 'unmute', agent)
      assert.deepEqual(unmuted, { kind: 'success', text: '频道：正常；免打扰：关' })
      assert.deepEqual(hub.sessionPrefsFor(sessionId), { hidden: false, muted: false })

      const statusReads = await applyChannelsCommand(hub, sessionId, 'status', 'command')
      assert.deepEqual(statusReads, { kind: 'success', text: '频道：正常；免打扰：关' })
    } finally {
      hub.dispose()
    }
  })

  test('unknown action / missing session produce readable errors, never throw', async () => {
    const commands = makeFakeCommands()
    const dataDir = tempDir('m4-cmd-errors')
    const hub = applyHub(makeFakeCtx({ commands }), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      const unknown = await commands.invoke('channels', 'explode', { id: 'qa-session-cmd-err' })
      assert.equal(unknown.kind, 'error')
      assert.ok(unknown.text.includes(CHANNELS_COMMAND_USAGE), unknown.text)

      const noAgent = await commands.invoke('channels', 'hide', undefined)
      assert.equal(noAgent.kind, 'error')
      assert.match(noAgent.text, /无法确定当前会话/)

      const joinNoChannel = await commands.invoke('channels', 'join', { id: 'qa-session-cmd-err' })
      assert.equal(joinNoChannel.kind, 'error')
      assert.match(joinNoChannel.text, /缺少频道 id/)
    } finally {
      hub.dispose()
    }
  })

  test('/channels join <id> and leave <id> change membership and report member counts', async () => {
    const commands = makeFakeCommands()
    const dataDir = tempDir('m4-cmd-join')
    const hub = applyHub(makeFakeCtx({ commands }), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      const owner = (await hub.register({ kind: 'external', handle: uniqueHandle('m4', 'own') })).participant
      const channel = uniqueChannel('m4', 'cmd')
      await hub.createChannel(owner, { id: channel, name: 'M4 cmd channel' })

      const sessionId = 'qa-session-cmd-join'
      const agent = { id: sessionId }

      const joined = await commands.invoke('channels', `join ${channel}`, agent)
      assert.equal(joined.kind, 'success')
      assert.equal(joined.text, `已加入 #${channel}（成员 2）`)
      const participant = hub.identity.findBySession(sessionId)
      assert.ok(participant !== undefined)
      assert.equal(hub.memberships.isMember(participant, channel), true)

      const leftAgain = await commands.invoke('channels', `leave ${channel}`, agent)
      assert.equal(leftAgain.kind, 'success')
      assert.equal(leftAgain.text, `已离开 #${channel}（成员 1）`)
      assert.equal(hub.memberships.isMember(participant, channel), false)

      const leaveGeneral = await commands.invoke('channels', 'leave general', agent)
      assert.equal(leaveGeneral.kind, 'error', '#general cannot be left')
      assert.match(leaveGeneral.text, /cannot leave #general/)

      const unknownChannel = await commands.invoke('channels', 'join qa-nope-channel', agent)
      assert.equal(unknownChannel.kind, 'error')
    } finally {
      hub.dispose()
    }
  })
})
