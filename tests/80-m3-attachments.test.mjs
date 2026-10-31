/**
 * 80 — M3 attachments (SPEC §3/§4/§5/§7.5/§11).
 *
 * Upload: raw `POST /upload` (Bearer, name/mime query, 25MB cap, 413/415/401).
 * Serve: `GET /attachments/<id>` (bytes identical, nosniff + CSP, inline only
 * for png/jpeg/gif/webp, Content-Disposition attachment otherwise, 404 on
 * unknown/traversal ids).
 * Messages: attachment metadata re-derived server-side, empty text allowed,
 * ownership/count/total-size limits, immutable author snapshots.
 *
 * Live-host writes go to a per-run throwaway channel; #general is untouched.
 * Size caps that would need a real 25MB payload are exercised hermetically with
 * a small config override (fast and deterministic).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, isInlineImageMime } from '../lib/contract.js'
import {
  ATTACHMENT_ID_RE,
  guessMimeFromName,
  isAttachmentId,
  normalizeMime,
  probeImageSize,
  publicAttachment,
  sanitizeAttachmentName,
} from '../lib/host/attachments.js'
import { applyHub } from '../lib/host/hub.js'
import {
  DATA_DIR,
  api,
  assertApiError,
  createChannel,
  getAttachment,
  history,
  joinChannel,
  makeFakeCtx,
  makeTempDataDir,
  openSse,
  readMessageFile,
  register,
  send,
  smallGif,
  smallPng,
  uniqueChannel,
  uniqueHandle,
  upload,
  whoami,
} from './_helpers.mjs'

const state = {}
const tempDirs = []

before(async () => {
  state.a = await register({ kind: 'external', handle: uniqueHandle('att', 'a'), displayName: 'QA Attach A' })
  state.b = await register({ kind: 'external', handle: uniqueHandle('att', 'b'), displayName: 'QA Attach B' })
  state.channel = uniqueChannel('att')
  await createChannel(state.a.token, state.channel, { name: 'QA attachments' })
  // M5: A is the creator; B must join before it can send or reference own files.
  await joinChannel(state.b.token, state.channel)
})

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag) {
  const dir = makeTempDataDir(tag)
  tempDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Unit: attachment helpers (pure functions, no network)
// ---------------------------------------------------------------------------

describe('80 M3 attachments: id/name/mime helpers', () => {
  test('isAttachmentId only accepts att_ + 16 lowercase hex', () => {
    assert.equal(ATTACHMENT_ID_RE.source, '^att_[0-9a-f]{16}$')
    assert.equal(isAttachmentId('att_0123456789abcdef'), true)
    for (const value of [
      'att_0123456789ABCDEF',
      'att_0123456789abcde',
      'att_0123456789abcdef0',
      'att-0123456789abcdef',
      '../etc/passwd',
      'att_0123456789abcdef/..',
      '',
      undefined,
      42,
    ]) {
      assert.equal(isAttachmentId(value), false, `expected invalid attachment id: ${String(value)}`)
    }
  })

  test('sanitizeAttachmentName strips paths/control chars and caps at 120 chars', () => {
    assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeAttachmentName('C:\\Users\\qa\\note.txt'), 'note.txt')
    assert.equal(sanitizeAttachmentName('dir/sub/report.pdf'), 'report.pdf')
    assert.equal(sanitizeAttachmentName('bad\u0000name\u001f.txt'), 'badname.txt')
    assert.equal(sanitizeAttachmentName('...hidden.txt'), 'hidden.txt')
    assert.equal(sanitizeAttachmentName(''), 'file')
    assert.equal(sanitizeAttachmentName(undefined), 'file')
    assert.equal(sanitizeAttachmentName(42), 'file')

    const long = `${'a'.repeat(300)}.png`
    const sanitized = sanitizeAttachmentName(long)
    assert.ok(sanitized.length <= 120, `name must be <=120 chars, got ${sanitized.length}`)
    assert.ok(sanitized.endsWith('.png'), `extension must survive truncation: ${sanitized}`)
  })

  test('normalizeMime lowercases, drops parameters, rejects malformed values', () => {
    assert.equal(normalizeMime('IMAGE/PNG'), 'image/png')
    assert.equal(normalizeMime('text/plain; charset=utf-8'), 'text/plain')
    assert.equal(normalizeMime('application/octet-stream'), 'application/octet-stream')
    for (const value of ['not a mime', '/png', 'image', 'image/', '', 'a/b/c', undefined, null, 42]) {
      assert.equal(normalizeMime(value), undefined, `expected undefined mime for ${String(value)}`)
    }
  })

  test('guessMimeFromName + isInlineImageMime (SPEC §7.5: only png/jpeg/gif/webp inline)', () => {
    assert.equal(guessMimeFromName('a.PNG'), 'image/png')
    assert.equal(guessMimeFromName('b.jpeg'), 'image/jpeg')
    assert.equal(guessMimeFromName('c.txt'), 'text/plain')
    assert.equal(guessMimeFromName('no-ext'), 'application/octet-stream')
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      assert.equal(isInlineImageMime(mime), true, `${mime} must be inline`)
    }
    for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'text/plain', 'application/octet-stream']) {
      assert.equal(isInlineImageMime(mime), false, `${mime} must NOT be inline`)
    }
  })

  test('probeImageSize reads PNG/GIF headers and tolerates garbage', () => {
    assert.deepEqual(probeImageSize(smallPng()), { width: 1, height: 1 })
    assert.deepEqual(probeImageSize(smallGif()), { width: 1, height: 1 })
    assert.equal(probeImageSize(Buffer.from('not an image')), undefined)
    assert.equal(probeImageSize(Buffer.alloc(0)), undefined)
  })

  test('publicAttachment exposes the API url and never the owner id', () => {
    const meta = { id: 'att_0123456789abcdef', name: 'a.png', mime: 'image/png', size: 70, ownerId: 'p_secret', createdAt: 'x' }
    const wire = publicAttachment(meta)
    assert.deepEqual(wire, {
      id: 'att_0123456789abcdef',
      name: 'a.png',
      mime: 'image/png',
      size: 70,
      url: '/channels/api/attachments/att_0123456789abcdef',
    })
    assert.equal('ownerId' in wire, false)
    assert.equal('createdAt' in wire, false)
  })

  test('contract constants match SPEC §7.5 limits', () => {
    assert.equal(MAX_ATTACHMENTS, 10)
    assert.equal(MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024)
    assert.equal(MAX_ATTACHMENT_TOTAL_BYTES, 50 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// Live: POST /upload
// ---------------------------------------------------------------------------

describe('80 M3 attachments: POST /upload (live)', () => {
  test('raw PNG upload returns the public attachment shape with probed dimensions', async () => {
    const png = smallPng()
    const response = await upload(state.a.token, png, { name: 'pixel.png', mime: 'image/png' })
    assert.equal(response.status, 200, response.text.slice(0, 300))
    const attachment = response.json.attachment
    assert.match(attachment.id, /^att_[0-9a-f]{16}$/)
    assert.equal(attachment.name, 'pixel.png')
    assert.equal(attachment.mime, 'image/png')
    assert.equal(attachment.size, png.length)
    assert.equal(attachment.url, `/channels/api/attachments/${attachment.id}`)
    assert.equal(attachment.width, 1)
    assert.equal(attachment.height, 1)
    assert.equal('ownerId' in attachment, false, 'owner id must not leak on the wire')
    assert.equal('createdAt' in attachment, false)
    state.png = { attachment, bytes: png }

    // The blob + metadata are really on disk under <dataDir>/attachments.
    const dir = join(DATA_DIR, 'attachments')
    assert.equal(existsSync(join(dir, attachment.id)), true)
    assert.equal(existsSync(join(dir, `${attachment.id}.json`)), true)
    const meta = JSON.parse(readFileSync(join(dir, `${attachment.id}.json`), 'utf8'))
    assert.equal(meta.ownerId, state.a.participantId)
    assert.equal(meta.size, png.length)
  })

  test('filename is sanitized to a basename and low-confidence mime loses to the extension', async () => {
    const text = Buffer.from('qa attachment text 你好\nsecond line', 'utf8')
    const up = await upload(state.a.token, text, { name: '../evil dir/note.txt', mime: 'text/plain' })
    assert.equal(up.status, 200)
    assert.equal(up.json.attachment.name, 'note.txt')

    const guessed = await upload(state.a.token, smallPng(), { name: 'pic.png', mime: 'application/octet-stream' })
    assert.equal(guessed.status, 200)
    assert.equal(guessed.json.attachment.mime, 'image/png', 'generic octet-stream must lose to the .png extension')
    assert.equal(guessed.json.attachment.width, 1)

    const noName = await upload(state.a.token, Buffer.from('x'), {})
    assert.equal(noName.status, 200)
    assert.equal(noName.json.attachment.name, 'file')
    assert.equal(noName.json.attachment.mime, 'application/octet-stream')

    state.text = { attachment: up.json.attachment, bytes: text }
  })

  test('unicode filename is stored verbatim and served with an RFC 5987 header', async () => {
    const up = await upload(state.a.token, Buffer.from('hi'), { name: '报告 最终.txt', mime: 'text/plain' })
    assert.equal(up.status, 200)
    assert.equal(up.json.attachment.name, '报告 最终.txt')
    state.unicode = up.json.attachment
  })

  test('POST /upload rejects unauthenticated, empty, malformed-mime and oversized requests', async () => {
    const noAuth = await api('/upload?name=x.png&mime=image%2Fpng', { method: 'POST', rawBody: smallPng() })
    assertApiError(noAuth, 401, 'unauthorized')

    const empty = await api('/upload?name=e.txt', { method: 'POST', token: state.a.token, rawBody: Buffer.alloc(0) })
    assertApiError(empty, 400, 'invalid_request')

    const badMime = await api(`/upload?name=x.png&mime=${encodeURIComponent('not a mime')}`, {
      method: 'POST',
      token: state.a.token,
      rawBody: smallPng(),
    })
    assertApiError(badMime, 415, 'unsupported_media_type')

    const badToken = await api('/upload?name=x.png', { method: 'POST', token: 'bogus', rawBody: smallPng() })
    assertApiError(badToken, 401, 'unauthorized')
  })

  test('concurrent uploads mint unique ids and every blob is readable', async () => {
    const payloads = Array.from({ length: 10 }, (_, index) => Buffer.from(`concurrent upload ${index} ${'x'.repeat(index * 7)}`))
    const responses = await Promise.all(
      payloads.map((bytes, index) => upload(state.a.token, bytes, { name: `parallel-${index}.txt`, mime: 'text/plain' })),
    )
    for (const response of responses) assert.equal(response.status, 200, response.text.slice(0, 200))
    const ids = responses.map((response) => response.json.attachment.id)
    assert.equal(new Set(ids).size, 10, 'attachment ids must be unique under concurrency')
    for (let index = 0; index < ids.length; index += 1) {
      assert.equal(responses[index].json.attachment.name, `parallel-${index}.txt`)
      const served = await getAttachment(ids[index])
      assert.equal(served.bytes.equals(payloads[index]), true, `blob ${index} must round-trip`)
    }
  })

  test('>25MB is rejected with 413 via the Content-Length pre-check (no body sent)', async () => {
    const http = await import('node:http')
    const declared = MAX_ATTACHMENT_BYTES + 1
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: new URL(`${DATA_DIR}`).port || undefined, // placeholder, replaced below
          path: '/channels/api/upload?name=big.bin',
          method: 'POST',
          headers: { authorization: `Bearer ${state.a.token}`, 'content-length': String(declared) },
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode, body }))
        },
      )
      req.on('error', (error) => {
        // The server may reset the socket after answering; a 413 still wins when it arrives.
        resolve({ error })
      })
      req.end()
    }).catch((error) => ({ error }))

    // Fill in the real host:port from the discovered API base.
    const apiUrl = new URL((await import('./_helpers.mjs')).API)
    const retry = await new Promise((resolve) => {
      const req = http.request(
        {
          host: apiUrl.hostname,
          port: apiUrl.port,
          path: '/channels/api/upload?name=big.bin',
          method: 'POST',
          headers: { authorization: `Bearer ${state.a.token}`, 'content-length': String(declared) },
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode, body }))
        },
      )
      req.on('error', (error) => resolve({ error }))
      req.end()
    })

    assert.equal(retry.status, 413, `expected 413 pre-check, got ${JSON.stringify(retry)} (first: ${JSON.stringify(result)})`)
    const payload = JSON.parse(retry.body)
    assert.equal(payload.error.code, 'payload_too_large')
    assert.match(payload.error.message, /26214400/)
  })
})

// ---------------------------------------------------------------------------
// Live: GET /attachments/<id>
// ---------------------------------------------------------------------------

describe('80 M3 attachments: GET /attachments/<id> (live)', () => {
  test('serves the exact bytes with nosniff + CSP; images inline', async () => {
    const { attachment, bytes } = state.png
    const served = await getAttachment(attachment.id)
    assert.equal(served.status, 200)
    assert.equal(served.bytes.equals(bytes), true, 'served bytes must be byte-identical')
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal(served.headers.get('content-length'), String(bytes.length))
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.match(served.headers.get('cache-control') ?? '', /immutable/)
    const disposition = served.headers.get('content-disposition') ?? ''
    assert.ok(disposition.startsWith('inline;'), `PNG must be inline, got: ${disposition}`)
    assert.match(disposition, /filename="pixel\.png"/)
  })

  test('non-image attachment is served as a download (Content-Disposition: attachment)', async () => {
    const { attachment, bytes } = state.text
    const served = await getAttachment(attachment.id)
    assert.equal(served.status, 200)
    assert.equal(served.bytes.equals(bytes), true)
    assert.equal(served.headers.get('content-type'), 'text/plain')
    const disposition = served.headers.get('content-disposition') ?? ''
    assert.ok(disposition.startsWith('attachment;'), `text file must download, got: ${disposition}`)
    assert.match(disposition, /filename="note\.txt"/)
  })

  test('SVG/HTML are never inline (SPEC §7.5)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const up = await upload(state.a.token, svg, { name: 'evil.svg', mime: 'image/svg+xml' })
    assert.equal(up.status, 200)
    assert.equal(up.json.attachment.mime, 'image/svg+xml')
    const served = await getAttachment(up.json.attachment.id)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/svg+xml')
    assert.ok((served.headers.get('content-disposition') ?? '').startsWith('attachment;'), 'SVG must download, never inline')
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff')

    const html = Buffer.from('<html><script>alert(1)</script></html>')
    const htmlUp = await upload(state.a.token, html, { name: 'evil.html', mime: 'text/html' })
    const htmlServed = await getAttachment(htmlUp.json.attachment.id)
    assert.ok((htmlServed.headers.get('content-disposition') ?? '').startsWith('attachment;'))
    assert.equal(htmlServed.headers.get('x-content-type-options'), 'nosniff')
  })

  test('unicode filename uses filename*=UTF-8 in Content-Disposition', async () => {
    const served = await getAttachment(state.unicode.id)
    const disposition = served.headers.get('content-disposition') ?? ''
    assert.match(disposition, /filename\*=UTF-8''/)
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), '报告 最终.txt')
  })

  test('unknown / malformed / traversal ids → 404 not_found', async () => {
    const unknown = await getAttachment('att_0000000000000000')
    assert.equal(unknown.status, 404)
    assert.equal(JSON.parse(unknown.bytes.toString('utf8')).error.code, 'not_found')

    for (const id of ['..%2F..%2Fetc%2Fpasswd', 'att_ZZZZZZZZZZZZZZZZ', 'att_0123456789abcdef', 'att_0123456789abcdef/..', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
      const response = await api(`/attachments/${id}`)
      assert.equal(response.status, 404, `attachment id ${JSON.stringify(id)} must 404`)
      assert.equal(response.json.error.code, 'not_found')
    }
  })

  test('serving needs no bearer token on loopback (v1 read trust) and works with one', async () => {
    const anonymous = await getAttachment(state.png.attachment.id)
    assert.equal(anonymous.status, 200)
    const withToken = await getAttachment(state.png.attachment.id, { token: state.a.token })
    assert.equal(withToken.status, 200)
    assert.equal(withToken.bytes.equals(state.png.bytes), true)
  })
})

// ---------------------------------------------------------------------------
// Live: messages carrying attachments
// ---------------------------------------------------------------------------

describe('80 M3 attachments: message attachments (live)', () => {
  test('send with two attachment ids stores public metadata; empty text + attachment is valid', async () => {
    const sent = await send(state.a.token, state.channel, 'two files attached', {
      attachments: [state.png.attachment.id, state.text.attachment.id],
    })
    assert.equal(sent.message.seq, 1)
    assert.equal(sent.message.text, 'two files attached')
    assert.deepEqual(sent.message.attachments, [state.png.attachment, state.text.attachment])
    assert.equal('ownerId' in sent.message.attachments[0], false, 'stored metadata must not leak ownership')

    const attachmentOnly = await send(state.a.token, state.channel, '', {
      attachments: [state.png.attachment.id],
    })
    assert.equal(attachmentOnly.message.seq, 2)
    assert.equal(attachmentOnly.message.text, '')
    assert.deepEqual(attachmentOnly.message.attachments, [state.png.attachment])

    state.message = sent.message
  })

  test('history re-parses attachments from the append-only JSONL', async () => {
    const page = await history(state.a.token, state.channel, { limit: 100 })
    const stored = page.messages.find((message) => message.id === state.message.id)
    assert.deepEqual(stored.attachments, state.message.attachments)

    const file = readMessageFile(state.channel)
    const line = file.rawLines.find((raw) => raw.includes(state.message.id))
    const parsed = JSON.parse(line)
    assert.equal(parsed.attachments.length, 2)
    assert.equal(parsed.attachments[0].id, state.png.attachment.id)
    assert.equal('ownerId' in parsed.attachments[0], false)
  })

  test('SSE message frame carries the attachments', async () => {
    const sse = await openSse({ token: state.a.token })
    try {
      await sse.next(2_000) // hello
      const sent = await send(state.a.token, state.channel, 'sse with attachment', {
        attachments: [state.text.attachment.id],
      })
      const frame = await sse.waitFor(
        (candidate) => candidate.event === 'message' && candidate.data?.message?.id === sent.message.id,
        2_000,
      )
      assert.deepEqual(frame.data.message.attachments, [state.text.attachment])
    } finally {
      sse.close()
    }
  })

  test('duplicate ids are de-duplicated; unknown id 404; empty text without attachments 400', async () => {
    const deduped = await send(state.a.token, state.channel, 'dedupe test', {
      attachments: [state.png.attachment.id, state.png.attachment.id],
    })
    assert.equal(deduped.message.attachments.length, 1)

    const emptyNoAttachments = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: '   ' },
    })
    assertApiError(emptyNoAttachments, 400, 'invalid_request')

    const unknown = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'x', attachments: ['att_0000000000000000'] },
    })
    assertApiError(unknown, 404, 'not_found')

    // An empty attachments array is equivalent to "no attachments".
    const emptyArrayWithText = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'no attachments here', attachments: [] },
    })
    assert.equal(emptyArrayWithText.status, 200)
    assert.equal('attachments' in emptyArrayWithText.json.message, false)

    const emptyArrayNoText = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: '   ', attachments: [] },
    })
    assertApiError(emptyArrayNoText, 400, 'invalid_request')

    // A non-array `attachments` field is a client error: the HTTP layer rejects
    // it instead of silently dropping the field (fixed after the M3 QA review).
    const nonArray = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'attachments as a string', attachments: 'att_0123456789abcdef' },
    })
    assertApiError(nonArray, 400, 'invalid_request')

    for (const bad of [[42], [''], [{ id: state.png.attachment.id }]]) {
      const response = await api('/send', {
        method: 'POST',
        token: state.a.token,
        body: { channel: state.channel, text: 'x', attachments: bad },
      })
      assert.equal(response.status, 400, `attachments ${JSON.stringify(bad)} must be rejected`)
      assert.equal(response.json.error.code, 'invalid_request')
    }
  })

  test('>10 attachments rejected before resolution; another participant\'s attachment → 403', async () => {
    const eleven = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `att_${String(index).padStart(16, '0')}`)
    const tooMany = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'x', attachments: eleven },
    })
    assertApiError(tooMany, 400, 'invalid_request')
    assert.match(tooMany.json.error.message, /at most 10 attachments/)

    const foreign = await upload(state.b.token, smallPng(), { name: 'b.png', mime: 'image/png' })
    assert.equal(foreign.status, 200)
    const stolen = await api('/send', {
      method: 'POST',
      token: state.a.token,
      body: { channel: state.channel, text: 'steal', attachments: [foreign.json.attachment.id] },
    })
    assertApiError(stolen, 403, 'forbidden')
    assert.match(stolen.json.error.message, /another participant/)

    const ownerOk = await send(state.b.token, state.channel, 'mine', { attachments: [foreign.json.attachment.id] })
    assert.equal(ownerOk.message.attachments[0].id, foreign.json.attachment.id)
  })

  test('Content-Disposition cannot be header-injected through the filename', async () => {
    const hostile = 'evil"name\r\nX-Injected: 1.txt'
    const up = await upload(state.a.token, Buffer.from('injection probe'), { name: hostile, mime: 'text/plain' })
    assert.equal(up.status, 200)
    assert.equal(/[\u0000-\u001f\u007f]/.test(up.json.attachment.name), false, 'control chars must be stripped')
    assert.equal(up.json.attachment.name.includes('"'), true, 'quotes may be stored but must be escaped on the wire')

    const served = await getAttachment(up.json.attachment.id)
    const disposition = served.headers.get('content-disposition') ?? ''
    assert.equal(/[\r\n]/.test(disposition), false, `header must not contain CRLF: ${JSON.stringify(disposition)}`)
    assert.equal(served.headers.get('x-injected'), null, 'no injected header may appear')
    assert.ok(disposition.startsWith('attachment;'))
    assert.ok(disposition.includes('filename="evil_name'), `ASCII fallback must escape quotes: ${disposition}`)
  })

  test('idempotent retry returns the original message including its attachments', async () => {
    const key = `qa-att-idem-${Date.now()}`
    const first = await send(state.a.token, state.channel, 'idempotent attachment send', {
      attachments: [state.png.attachment.id],
      clientMsgId: key,
    })
    const replay = await send(state.a.token, state.channel, 'idempotent attachment send', {
      attachments: [state.text.attachment.id],
      clientMsgId: key,
    })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.message.id, first.message.id)
    assert.deepEqual(replay.message.attachments, [state.png.attachment], 'replay keeps the original attachments')

    const file = readMessageFile(state.channel)
    assert.equal(
      file.rawLines.filter((line) => line.includes(first.message.id)).length,
      1,
      'the retry must not append a second JSONL line',
    )
  })

  test('reply + attachments keep the reply snapshot intact', async () => {
    const reply = await send(state.a.token, state.channel, 'reply with file', {
      replyTo: state.message.id,
      attachments: [state.text.attachment.id],
    })
    assert.equal(reply.message.replyTo.id, state.message.id)
    assert.equal(reply.message.replyTo.authorName, state.a.handle)
    assert.equal(reply.message.attachments.length, 1)
  })
})

// ---------------------------------------------------------------------------
// Hermetic: size caps, total-size limit, restart durability (temp dataDir)
// ---------------------------------------------------------------------------

describe('80 M3 attachments: limits & durability (hermetic)', () => {
  test('per-file cap boundary and per-message total cap are enforced', async () => {
    const dataDir = tempDir('att-caps')
    const hub = applyHub(makeFakeCtx(), {
      dataDir,
      wake: false,
      maxAttachmentBytes: 1024,
      maxAttachmentTotalBytes: 1500,
    })
    assert.ok(hub !== undefined)
    try {
      const participant = (await hub.register({ kind: 'external', handle: 'qa-att-caps-user' })).participant
      await hub.createChannel(participant, { id: 'qa-att-caps' })

      const exactly = await hub.uploadAttachment(participant, { name: 'a.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(1024, 1) })
      assert.equal(exactly.size, 1024)
      await assert.rejects(
        () => hub.uploadAttachment(participant, { name: 'b.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(1025, 1) }),
        (error) => error.status === 413 && error.code === 'payload_too_large',
      )

      const first = await hub.uploadAttachment(participant, { name: 'c.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(900, 2) })
      const second = await hub.uploadAttachment(participant, { name: 'd.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(900, 3) })
      await assert.rejects(
        () => hub.sendMessage(participant, { channel: 'qa-att-caps', text: '', attachments: [first.id, second.id] }),
        (error) => error.status === 400 && error.code === 'invalid_request' && /per-message limit/.test(error.message),
      )

      const ok = await hub.sendMessage(participant, { channel: 'qa-att-caps', text: '', attachments: [first.id] })
      assert.equal(ok.message.attachments.length, 1)
      const messages = hub.history(null, { channel: 'qa-att-caps', limit: 10 }).messages
      assert.deepEqual(messages.map((message) => message.text), [''])
      assert.equal(messages[0].attachments[0].id, first.id)
    } finally {
      hub.dispose()
    }
  })

  test('read-only hub rejects uploads with 503 readonly', async () => {
    const dataDir = tempDir('att-ro')
    // Use a live foreign pid so this hub cannot become the writer.
    const { seedChannel, seedLock } = await import('./_helpers.mjs')
    seedChannel(dataDir, 'general', [])
    seedLock(dataDir, process.pid === 1 ? 2 : 1) // pid 1 is init: alive, not us
    const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      assert.equal(hub.writer, false)
      await assert.rejects(
        () => hub.uploadAttachment({ id: 'p_x', handle: 'x', displayName: 'x', kind: 'external', harness: 'other', createdAt: '', lastSeen: '', status: 'idle' }, { bytes: smallPng() }),
        (error) => error.status === 503 && error.code === 'readonly',
      )
    } finally {
      hub.dispose()
    }
  })

  test('attachments and message references survive a host restart', async () => {
    const dataDir = tempDir('att-restart')
    const channel = 'qa-att-restart'
    let hub1 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub1 !== undefined)
    let attachment
    let messageId
    let handle
    let token
    try {
      const registered = await hub1.register({ kind: 'external', handle: 'qa-att-restart-user' })
      const participant = registered.participant
      handle = participant.handle
      token = registered.token
      await hub1.createChannel(participant, { id: channel })
      attachment = await hub1.uploadAttachment(participant, { name: 'persist.png', mime: 'image/png', bytes: smallPng() })
      const sent = await hub1.sendMessage(participant, { channel, text: 'persisted attachment', attachments: [attachment.id] })
      messageId = sent.message.id
    } finally {
      hub1.dispose()
    }

    const hub2 = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub2 !== undefined)
    try {
      const meta = hub2.attachmentMeta(attachment.id)
      assert.equal(meta.name, 'persist.png')
      assert.equal(hub2.attachments.read(attachment.id).equals(smallPng()), true)

      const page = hub2.history(null, { channel, limit: 10 })
      assert.equal(page.messages[0].id, messageId)
      assert.deepEqual(page.messages[0].attachments, [attachment])

      const again = await hub2.register({ kind: 'external', handle, token })
      const sent = await hub2.sendMessage(again.participant, { channel, text: 'after restart', attachments: [attachment.id] })
      assert.equal(sent.message.seq, 2)
      assert.equal(sent.message.attachments[0].id, attachment.id)
    } finally {
      hub2.dispose()
    }
  })
})
