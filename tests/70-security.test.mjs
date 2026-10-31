/**
 * 70 — Security & abuse limits (SPEC §5 auth, §11).
 *
 * - write endpoints require a bearer identity (loopback trust is read-only)
 * - message/announce size cap = 8KB UTF-8
 * - unknown channels → 404, invalid ids → 400
 * - HTML/script text round-trips verbatim (plain text, no mangling)
 * - 30 messages/min/participant and one announcement/10min → 429
 * - tokenHash never exposed over HTTP; participants.json stores only the digest
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'

import {
  DATA_DIR,
  api,
  assertApiError,
  createChannel,
  history,
  register,
  send,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const state = {}

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('sec', 'a'), displayName: 'QA Security A' })
  state.channel = uniqueChannel('sec')
  await createChannel(state.a.token, state.channel, { name: 'QA security' })
})

describe('70 security: authentication', () => {
  test('write endpoints reject tokenless loopback requests (401)', async () => {
    const cases = [
      ['/send', { channel: state.channel, text: 'anonymous' }],
      ['/channels', { id: uniqueChannel('sec', 'anon'), name: 'anon' }],
      ['/pin', { channel: state.channel, messageId: `${state.channel}-000001` }],
      ['/unpin', { channel: state.channel, messageId: `${state.channel}-000001` }],
      ['/announce', { channel: state.channel, text: 'anon announcement' }],
    ]
    for (const [path, body] of cases) {
      const response = await api(path, { method: 'POST', body })
      assertApiError(response, 401, 'unauthorized')
    }
    const heartbeat = await api('/heartbeat', { method: 'POST', body: {} })
    assertApiError(heartbeat, 401, 'unauthorized')
  })

  test('invalid bearer token is rejected (401) on read and write routes', async () => {
    assertApiError(await api('/whoami', { token: 'bogus-token' }), 401, 'unauthorized')
    assertApiError(
      await api('/send', { method: 'POST', token: 'bogus-token', body: { channel: state.channel, text: 'x' } }),
      401,
      'unauthorized',
    )
    assertApiError(await api('/history?channel=general', { token: 'bogus-token' }), 401, 'unauthorized')
  })

  test('trusted loopback reads are still allowed tokenless (v1 trust)', async () => {
    const response = await api('/channels')
    assert.equal(response.status, 200)
    assert.ok(Array.isArray(response.json))
  })

  test('cross-origin tokenless request is rejected (401)', async () => {
    const response = await api('/history?channel=general', { headers: { origin: 'http://evil.example' } })
    assertApiError(response, 401, 'unauthorized')
  })
})

describe('70 security: input validation', () => {
  test('message text > 8KB UTF-8 bytes is rejected; exactly 8KB is accepted', async () => {
    const tooBig = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'a'.repeat(8 * 1024 + 1) },
    })
    assertApiError(tooBig, 400, 'invalid_request')
    assert.match(tooBig.json.error.message, /8192/)

    const multibyte = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: '中'.repeat(2_731) }, // 8193 bytes
    })
    assertApiError(multibyte, 400, 'invalid_request')

    const boundary = await send(state.a.token, state.channel, 'a'.repeat(8 * 1024))
    assert.equal(boundary.message.seq, 1, 'exactly MAX_TEXT_BYTES (8192) must be accepted')

    const announceBig = await api('/announce', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'b'.repeat(8 * 1024 + 1) },
    })
    assertApiError(announceBig, 400, 'invalid_request')
  })

  test('unknown channel → 404; invalid channel id → 400', async () => {
    const unknown = await api('/history?channel=qa-no-such-channel', { token: state.a.token })
    assertApiError(unknown, 404, 'not_found')

    const unknownSend = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: 'qa-no-such-channel', text: 'hello' },
    })
    assertApiError(unknownSend, 404, 'not_found')

    for (const channel of ['Bad Channel', '../etc', 'a_b', '']) {
      const response = await api('/send', {
        method: 'POST',
        token: state.a.token,
        body: { channel, text: 'hello' },
      })
      assert.equal(response.status, 400, `channel id ${JSON.stringify(channel)} must be rejected`)
      assert.equal(response.json.error.code, 'invalid_request')
    }
  })

  test('reserved / malformed handles are rejected at register (400 invalid_handle)', async () => {
    for (const handle of ['all', 'here', 'channel', 'system', 'everyone', 'a', 'Bad Handle', 'x'.repeat(25)]) {
      const response = await api('/register', { method: 'POST', body: { kind: 'external', handle } })
      assert.equal(response.status, 400, `handle ${JSON.stringify(handle)} must be rejected`)
      assert.equal(response.json.error.code, 'invalid_handle')
    }
  })

  test('path traversal cannot escape the messages dir (channel id is a slug)', async () => {
    for (const id of ['../../etc/passwd', '..', '.', 'a/b', '%2e%2e%2f']) {
      const response = await api('/channels', { method: 'POST', token: state.a.token, body: { id, name: 'escape' } })
      assert.equal(response.status, 400, `channel id ${JSON.stringify(id)} must be rejected`)
    }
  })

  test('malformed JSON / non-object bodies / unknown routes → documented errors', async () => {
    assertApiError(await api('/send', { method: 'POST', body: '{oops' }), 400, 'invalid_request')
    assertApiError(await api('/send', { method: 'POST', body: '[]' }), 400, 'invalid_request')
    assertApiError(await api('/register', { method: 'POST', body: {} }), 400, 'invalid_request')
    assertApiError(await api('/nope'), 404, 'not_found')
    const wrongMethod = await api('/channels', { method: 'DELETE' })
    assert.equal(wrongMethod.status, 404)
    assert.equal(wrongMethod.json.error.code, 'not_found')
  })
})

describe('70 security: plain-text integrity', () => {
  test('HTML/script text round-trips verbatim (no escaping, no mangling)', async () => {
    const text = `<script>alert("x")</script><img src=x onerror=alert(1)> & "double" 'single' <b>中文</b>`
    const sent = await send(state.a.token, state.channel, text)
    assert.equal(sent.message.text, text)
    const page = await history(state.a.token, state.channel, { limit: 100 })
    const stored = page.messages.find((message) => message.id === sent.message.id)
    assert.equal(stored.text, text, 'stored text must be byte-for-byte identical')
  })

  test('multi-line / unicode text round-trips verbatim', async () => {
    const text = 'line1\n\tline2 🚀 émoji 中文 \r\nline4'
    const sent = await send(state.a.token, state.channel, text)
    assert.equal(sent.message.text, text)
    const page = await history(state.a.token, state.channel, { limit: 100 })
    assert.equal(page.messages.find((message) => message.id === sent.message.id).text, text)
    const rawLine = readFileSync(join(DATA_DIR, 'messages', `${state.channel}.jsonl`), 'utf8')
      .split('\n')
      .find((line) => line.includes(sent.message.id))
    assert.ok(rawLine !== undefined)
    assert.equal(JSON.parse(rawLine).text, text, 'JSONL round-trip must preserve newlines/tabs')
  })

  test('a message cannot be HTML-executed by the API: content-type is JSON + nosniff', async () => {
    const response = await api('/history?channel=' + encodeURIComponent(state.channel), { token: state.a.token })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
})

describe('70 security: rate limits', () => {
  test('31st message within a minute → 429 rate_limited; duplicate retry stays 200', async () => {
    const participant = await register({ kind: 'external', handle: uniqueHandle('sec', 'rl'), displayName: 'QA Rate Limit' })
    const channel = uniqueChannel('sec', 'rl')
    await createChannel(participant.token, channel, { name: 'QA rate limit' })

    const statuses = []
    for (let index = 1; index <= 30; index += 1) {
      const body = { channel, text: `rate message ${index}` }
      if (index === 1) body.clientMsgId = `qa-rate-key-${index}`
      const response = await api('/send', { method: 'POST', token: participant.token, body })
      statuses.push(response.status)
    }
    assert.deepEqual(statuses, Array.from({ length: 30 }, () => 200), 'the full 30/min budget is accepted')

    const retry = await api('/send', {
      method: 'POST',
      token: participant.token,
      body: { channel, text: 'rate message 1', clientMsgId: 'qa-rate-key-1' },
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.json.duplicate, true, 'idempotent retries bypass the quota')

    const over = await api('/send', { method: 'POST', token: participant.token, body: { channel, text: 'one too many' } })
    const error = assertApiError(over, 429, 'rate_limited')
    assert.match(error.message, /30 messages\/minute/)
  })

  test('second announcement within 10 minutes → 429 rate_limited', async () => {
    const participant = await register({ kind: 'external', handle: uniqueHandle('sec', 'ann'), displayName: 'QA Announcer' })
    const channel = uniqueChannel('sec', 'ann')
    await createChannel(participant.token, channel, { name: 'QA announce limit' })

    const first = await api('/announce', { method: 'POST', token: participant.token, body: { channel, text: 'one' } })
    assert.equal(first.status, 200)
    assert.equal(first.json.message.kind, 'announcement')

    const second = await api('/announce', { method: 'POST', token: participant.token, body: { channel, text: 'two' } })
    const error = assertApiError(second, 429, 'rate_limited')
    assert.match(error.message, /one per 10 minutes/)

    const page = await history(participant.token, channel, { limit: 100 })
    assert.deepEqual(
      page.messages.map((message) => message.kind),
      ['announcement'],
      'the rejected announcement must not be stored',
    )
  })
})

describe('70 security: token storage', () => {
  test('HTTP views never expose tokenHash; participants.json stores only the SHA-256 digest', async () => {
    const whoami = await api('/whoami', { token: state.a.token })
    assert.equal(whoami.status, 200)
    assert.equal(JSON.stringify(whoami.json).includes('tokenHash'), false)

    const members = await api('/members', { token: state.a.token })
    assert.equal(JSON.stringify(members.json).includes('tokenHash'), false)

    const raw = readFileSync(join(DATA_DIR, 'participants.json'), 'utf8')
    const digest = createHash('sha256').update(state.a.token, 'utf8').digest('hex')
    assert.equal(raw.includes(state.a.token), false, 'plaintext token must never be persisted')
    assert.equal(raw.includes(digest), true, 'the stored tokenHash is the SHA-256 digest of the token')
  })
})
