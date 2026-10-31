/**
 * 82 — M3 message search (SPEC §7.5): case-insensitive, multi-word AND, optional
 * channel filter, ±60 char snippet, newest first, limit/hasMore, archived
 * channels excluded unless named explicitly.
 *
 * Every assertion uses per-run unique tokens so the shared live server's other
 * channels cannot contribute hits. Writes stay in throwaway `qa-m3s-*` channels.
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

import {
  RUN,
  api,
  apiOk,
  archiveChannel,
  assertApiError,
  createChannel,
  history,
  joinChannel,
  listChannels,
  listChannelsWithArchived,
  register,
  search,
  send,
  uniqueChannel,
  uniqueHandle,
  upload,
} from './_helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TOKEN = `zq${RUN}tok`
const NDL = `ndl${RUN}`
const ARCH_TOKEN = `zq${RUN}arc`
const UNICODE = `中文搜索${RUN}`

const state = {}

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('m3s', 'a'), displayName: 'QA Search A' })
  state.b = await register({ kind: 'external', handle: uniqueHandle('m3s', 'b'), displayName: 'QA Search B' })

  state.c1 = uniqueChannel('m3s', 'one')
  state.c2 = uniqueChannel('m3s', 'two')
  state.cArch = uniqueChannel('m3s', 'arch')
  for (const channel of [state.c1, state.c2, state.cArch]) {
    await createChannel(state.a.token, channel, { name: `QA search ${channel}` })
    // M5: A created every channel (auto-joined); B must join the two it writes to.
    if (channel !== state.cArch) await joinChannel(state.b.token, channel)
  }

  // c1: four messages with distinct timestamps (5ms gaps) so ordering is stable.
  state.m1 = (await send(state.a.token, state.c1, `Alpha ${TOKEN} ${NDL} ${UNICODE}`)).message
  await sleep(5)
  state.m2 = (await send(state.b.token, state.c1, `beta ${TOKEN} ${NDL.toUpperCase()}`)).message
  await sleep(5)
  state.m3 = (await send(state.a.token, state.c1, `${TOKEN} ${NDL} only`)).message
  await sleep(5)
  state.mLong = (
    await send(state.a.token, state.c1, `${'x'.repeat(200)} ${TOKEN} ${'y'.repeat(200)}`)
  ).message
  await sleep(5)

  // c2: cross-channel message carrying an attachment (SearchHit carries the full message).
  const uploaded = await upload(state.b.token, Buffer.from('search attachment body'), { name: 'search.txt', mime: 'text/plain' })
  state.c2Message = (
    await send(state.b.token, state.c2, `${TOKEN} ${NDL} cross-channel`, { attachments: [uploaded.json.attachment.id] })
  ).message
  await sleep(5)

  // Archived candidate (unique token so only this channel can match).
  state.archMessage = (await send(state.a.token, state.cArch, `archived ${ARCH_TOKEN} ${NDL}`)).message
})

const seqs = (hits) => hits.map((hit) => hit.message.seq)
const seqsDesc = (hits) => hits.map((hit) => hit.message.seq)

describe('82 M3 search: basic matching', () => {
  test('single term is case-insensitive and spans channels, newest first', async () => {
    const result = await search(state.a.token, TOKEN.toUpperCase())
    assert.equal(result.query, TOKEN.toUpperCase())
    // m1,m2,m3,mLong in c1 + c2Message = 5 hits.
    assert.equal(result.hits.length, 5)
    assert.equal(result.hasMore, false)

    for (const hit of result.hits) {
      assert.equal(typeof hit.snippet, 'string')
      assert.ok(hit.snippet.toLowerCase().includes(TOKEN), `snippet must contain the term: ${hit.snippet}`)
      assert.equal(hit.message.channel, hit.channel)
      assert.ok([state.c1, state.c2].includes(hit.channel))
    }

    // Timestamps descend across the whole result set.
    for (let index = 1; index < result.hits.length; index += 1) {
      assert.ok(
        Date.parse(result.hits[index - 1].message.ts) >= Date.parse(result.hits[index].message.ts),
        'hits must be sorted newest first',
      )
    }
    // In c1 the newest matching message is mLong (last sent).
    const c1Seqs = result.hits.filter((hit) => hit.channel === state.c1).map((hit) => hit.message.seq)
    assert.deepEqual(c1Seqs, [state.mLong.seq, state.m3.seq, state.m2.seq, state.m1.seq])
    assert.equal(result.hits[0].channel, state.c2, 'the cross-channel message was sent last')
  })

  test('multi-word queries are ANDed; whitespace is normalized', async () => {
    // 4 of the 5 token hits also contain NDL (mLong has only TOKEN).
    const both = await search(state.a.token, `${TOKEN} ${NDL}`)
    assert.equal(both.hits.length, 4, 'every hit must contain both terms')
    for (const hit of both.hits) {
      assert.ok(hit.message.text.toLowerCase().includes(NDL), 'AND semantics: every term must match')
    }

    const collapsed = await search(state.a.token, `  ${TOKEN}    ${NDL}  `)
    assert.equal(collapsed.hits.length, 4, 'extra whitespace must be collapsed')

    const missing = await search(state.a.token, `${TOKEN} zz${RUN}notaterm`)
    assert.deepEqual(missing.hits, [])
    assert.equal(missing.hasMore, false)
  })

  test('unicode query matches unicode text', async () => {
    const result = await search(state.a.token, UNICODE)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].message.id, state.m1.id)
    assert.equal(result.hits[0].channel, state.c1)
  })

  test('author handle / displayName are part of the haystack', async () => {
    const byHandle = await search(state.a.token, state.b.handle)
    for (const hit of byHandle.hits) {
      assert.equal(hit.message.author.participantId, state.b.participantId)
    }
    assert.ok(byHandle.hits.some((hit) => hit.message.id === state.m2.id))
    assert.ok(byHandle.hits.some((hit) => hit.message.id === state.c2Message.id))

    const byDisplayName = await search(state.a.token, 'QA Search B')
    assert.ok(byDisplayName.hits.length >= 2)
  })

  test('snippet is a ±60 char window with ellipses for long messages', async () => {
    const result = await search(state.a.token, TOKEN, { channel: state.c1 })
    const longHit = result.hits.find((hit) => hit.message.id === state.mLong.id)
    assert.ok(longHit !== undefined)
    assert.ok(longHit.snippet.startsWith('…'), `long snippet must start with an ellipsis: ${longHit.snippet.slice(0, 20)}`)
    assert.ok(longHit.snippet.endsWith('…'), 'long snippet must end with an ellipsis')
    assert.ok(longHit.snippet.length <= 60 + TOKEN.length + 60 + 2, `snippet too long: ${longHit.snippet.length}`)
    assert.ok(longHit.snippet.includes(TOKEN))

    const shortHit = result.hits.find((hit) => hit.message.id === state.m3.id)
    assert.equal(shortHit.snippet, `${TOKEN} ${NDL} only`, 'short messages are returned without ellipses')
  })

  test('SearchHit carries the full message including attachments', async () => {
    const result = await search(state.a.token, TOKEN, { channel: state.c2 })
    assert.equal(result.hits.length, 1)
    const hit = result.hits[0]
    assert.deepEqual(hit.message, (await history(state.a.token, state.c2, { limit: 10 })).messages[0])
    assert.equal(hit.message.attachments.length, 1)
    assert.equal(hit.message.attachments[0].name, 'search.txt')
  })
})

describe('82 M3 search: filters, paging and limits', () => {
  test('channel filter restricts hits to that channel', async () => {
    const result = await search(state.a.token, TOKEN, { channel: state.c1 })
    assert.equal(result.hits.length, 4)
    for (const hit of result.hits) assert.equal(hit.channel, state.c1)
    assert.deepEqual(seqs(result.hits), [state.mLong.seq, state.m3.seq, state.m2.seq, state.m1.seq])
  })

  test('limit clamps to 1..50 and reports hasMore exactly', async () => {
    const two = await search(state.a.token, TOKEN, { limit: 2 })
    assert.equal(two.hits.length, 2)
    assert.equal(two.hasMore, true)

    const zero = await search(state.a.token, TOKEN, { limit: 0 })
    assert.equal(zero.hits.length, 1, 'limit=0 is clamped up to 1')
    assert.equal(zero.hasMore, true)

    const negative = await search(state.a.token, TOKEN, { limit: -5 })
    assert.equal(negative.hits.length, 5, 'an invalid negative limit falls back to the default')

    const huge = await search(state.a.token, TOKEN, { limit: 999 })
    assert.equal(huge.hits.length, 5)
    assert.equal(huge.hasMore, false, 'limit above 50 clamps to SEARCH_LIMIT without inventing hasMore')
  })

  test('beforeSeq pages older hits only', async () => {
    const older = await search(state.a.token, TOKEN, { channel: state.c1, beforeSeq: state.m3.seq })
    assert.deepEqual(seqs(older.hits), [state.m2.seq, state.m1.seq])
    assert.equal(older.hasMore, false)

    const pageOne = await search(state.a.token, TOKEN, { channel: state.c1, limit: 2 })
    assert.deepEqual(seqs(pageOne.hits), [state.mLong.seq, state.m3.seq])
    const pageTwo = await search(state.a.token, TOKEN, { channel: state.c1, limit: 2, beforeSeq: pageOne.hits[1].message.seq })
    assert.deepEqual(seqs(pageTwo.hits), [state.m2.seq, state.m1.seq])
  })

  test('no match → empty hits; invalid queries → documented errors', async () => {
    const none = await search(state.a.token, `zz${RUN}definitely-not-present`)
    assert.deepEqual(none.hits, [])
    assert.equal(none.hasMore, false)

    assertApiError(await api('/search'), 400, 'invalid_request')
    assertApiError(await api('/search?q='), 400, 'invalid_request')
    assertApiError(await api('/search?q=%20%20%20'), 400, 'invalid_request')

    const unknownChannel = await api(`/search?q=${TOKEN}&channel=qa-m3s-nope-${RUN}`, { token: state.a.token })
    assertApiError(unknownChannel, 404, 'not_found')
  })

  test('search rejects a bad bearer token and tolerates regex-special queries', async () => {
    assertApiError(await api(`/search?q=${TOKEN}`, { token: 'not-a-real-token' }), 401, 'unauthorized')

    // Queries are plain substrings, not regexes: metacharacters must not crash or 500.
    for (const query of ['.*', '(', '[a-z]+', '$^', '\\\\', '%00']) {
      const response = await api(`/search?q=${encodeURIComponent(query)}`, { token: state.a.token })
      assert.equal(response.status, 200, `query ${JSON.stringify(query)} must not fail`)
      assert.ok(Array.isArray(response.json.hits))
    }
  })

  test('searching an empty channel returns an empty page, not an error', async () => {
    const empty = uniqueChannel('m3s', 'empty')
    await createChannel(state.a.token, empty, { name: 'QA empty search' })
    const result = await search(state.a.token, TOKEN, { channel: empty })
    assert.deepEqual(result.hits, [])
    assert.equal(result.hasMore, false)
  })

  test('search does not advance the read cursor (unread stays unread)', async () => {
    const observer = await register({ kind: 'external', handle: uniqueHandle('m3s', 'obs'), displayName: 'QA Search Observer' })
    // M5: search only covers joined channels; the observer joins c1 first.
    await joinChannel(observer.token, state.c1)
    const before = (await listChannels(observer.token)).find((channel) => channel.id === state.c1)
    assert.equal(before.unread, before.lastSeq, 'a fresh participant has all messages unread')

    const result = await search(observer.token, TOKEN, { channel: state.c1 })
    assert.equal(result.hits.length, 4)

    const after = (await listChannels(observer.token)).find((channel) => channel.id === state.c1)
    assert.equal(after.unread, before.unread, 'search must not mark messages as read')
  })
})

describe('82 M3 search: archived channels', () => {
  test('archiving hides the channel from search/list and blocks new messages', async () => {
    state.archived = await archiveChannel(state.a.token, state.cArch, true)
    assert.equal(state.archived.archived, true)

    const defaultList = await listChannels(state.a.token)
    assert.equal(defaultList.some((channel) => channel.id === state.cArch), false, 'archived channels are hidden by default')

    const withArchived = await listChannelsWithArchived(state.a.token, true)
    const archivedEntry = withArchived.find((channel) => channel.id === state.cArch)
    assert.ok(archivedEntry !== undefined)
    assert.equal(archivedEntry.archived, true)

    const hidden = await search(state.a.token, ARCH_TOKEN)
    assert.deepEqual(hidden.hits, [], 'archived channels must be excluded from unfiltered search')

    const explicit = await search(state.a.token, ARCH_TOKEN, { channel: state.cArch })
    assert.equal(explicit.hits.length, 1, 'naming an archived channel explicitly still searches it')
    assert.equal(explicit.hits[0].message.id, state.archMessage.id)

    const archiveUnknown = await api('/channels/archive', {
      method: 'POST',
      token: state.a.token,
      body: { channel: `qa-m3s-nope-${RUN}` },
    })
    assertApiError(archiveUnknown, 404, 'not_found')

    const archiveNoChannel = await api('/channels/archive', { method: 'POST', token: state.a.token, body: {} })
    assertApiError(archiveNoChannel, 400, 'invalid_request')

    const blocked = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.cArch, text: 'into the archive' },
    })
    assertApiError(blocked, 409, 'archived')

    const historyStillReadable = await history(state.a.token, state.cArch, { limit: 10 })
    assert.equal(historyStillReadable.messages.length, 1, 'archived history stays readable')
  })

  test('unarchiving restores search and sends', async () => {
    const restored = await archiveChannel(state.a.token, state.cArch, false)
    assert.equal(restored.archived, undefined)

    const found = await search(state.a.token, ARCH_TOKEN)
    assert.equal(found.hits.length, 1)
    assert.equal(found.hits[0].channel, state.cArch)

    const sent = await send(state.a.token, state.cArch, `${ARCH_TOKEN} after restore`)
    assert.equal(sent.message.seq, 2)
  })
})
