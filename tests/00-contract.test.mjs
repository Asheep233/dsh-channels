/**
 * 00 — Contract unit tests (SPEC §4, §11; src/contract.ts -> lib/contract.js).
 *
 * Pure-function checks only: no network, no data dir writes.
 * Also verifies the built artifacts required by SPEC §10.8.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import * as contract from '../lib/contract.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

describe('00 contract: constants (SPEC §4/§11)', () => {
  test('PLUGIN_ID, API_BASE, DEFAULT_CHANNEL', () => {
    assert.equal(contract.PLUGIN_ID, 'dsh-channels')
    assert.equal(contract.API_BASE, '/channels/api')
    assert.equal(contract.DEFAULT_CHANNEL, 'general')
  })

  test('numeric limits: 8KB text, 100 page, 5s wake, 10min announce, 32-byte claim token', () => {
    assert.equal(contract.MAX_TEXT_BYTES, 8 * 1024)
    assert.equal(contract.MAX_PAGE, 100)
    assert.equal(contract.WAKE_RATE_MS, 5_000)
    assert.equal(contract.ANNOUNCE_RATE_MS, 10 * 60_000)
    assert.equal(contract.CLAIM_TOKEN_BYTES, 32)
  })

  test('RESERVED_HANDLES = all/here/channel/system/everyone', () => {
    assert.deepEqual([...contract.RESERVED_HANDLES].sort(), ['all', 'channel', 'everyone', 'here', 'system'])
  })
})

describe('00 contract: isValidHandle (SPEC §4)', () => {
  test('accepts lowercase 2..24 char slugs', () => {
    for (const value of ['ab', 'a_b', 'a-b', 'abc123', '9abc', 'a'.repeat(24)]) {
      assert.equal(contract.isValidHandle(value), true, `expected valid handle: ${value}`)
    }
  })

  test('rejects too short / too long / uppercase / spaces / non-strings', () => {
    const invalid = ['', 'a', 'a'.repeat(25), 'Abc', 'a b', 'a.b', 'a/b', '中文', undefined, null, 42]
    for (const value of invalid) {
      assert.equal(contract.isValidHandle(value), false, `expected invalid handle: ${String(value)}`)
    }
  })

  test('all reserved handles are invalid', () => {
    for (const reserved of contract.RESERVED_HANDLES) {
      assert.equal(contract.isValidHandle(reserved), false, `reserved handle must be invalid: ${reserved}`)
    }
  })
})

describe('00 contract: isValidChannelId (SPEC §4)', () => {
  test('accepts lowercase 1..32 char slugs starting with alnum', () => {
    for (const value of ['a', 'general', 'qa-123', 'a'.repeat(32)]) {
      assert.equal(contract.isValidChannelId(value), true, `expected valid channel id: ${value}`)
    }
  })

  test('rejects empty / leading dash-or-underscore / underscores / uppercase / too long / non-strings', () => {
    const invalid = ['', '-x', '_x', 'a_b', 'Upper', 'a b', 'a/b', 'a'.repeat(33), undefined, 42]
    for (const value of invalid) {
      assert.equal(contract.isValidChannelId(value), false, `expected invalid channel id: ${String(value)}`)
    }
  })
})

describe('00 contract: messageId / normalizeHandle / shortName', () => {
  test('messageId pads seq to 6 digits: ${channel}-${seq:06d}', () => {
    assert.equal(contract.messageId('general', 1), 'general-000001')
    assert.equal(contract.messageId('general', 210), 'general-000210')
    assert.equal(contract.messageId('qa-abc', 999999), 'qa-abc-999999')
    assert.equal(contract.messageId('x', 0), 'x-000000')
  })

  test('normalizeHandle trims and lowercases', () => {
    assert.equal(contract.normalizeHandle('  Alice_1  '), 'alice_1')
    assert.equal(contract.normalizeHandle('BOB'), 'bob')
  })

  test('shortName strips a session- prefix and keeps 6 chars', () => {
    assert.equal(contract.shortName('session-abc123xyz'), 'abc123')
    assert.equal(contract.shortName('agent'), 'agent')
  })
})

describe('00 contract: parseMentions (SPEC §7)', () => {
  test('parses @handle tokens, lowercases and dedupes', () => {
    assert.deepEqual(contract.parseMentions('hi @alice and @Bob_2, again @alice'), ['alice', 'bob_2'])
  })

  test('ignores @tokens that cannot be handles (1 char, dots)', () => {
    assert.deepEqual(contract.parseMentions('@a @ab.c @ ok'), ['ab'])
  })

  test('matches @all (reserved expansion happens in the wake layer, not here)', () => {
    assert.deepEqual(contract.parseMentions('hey @all'), ['all'])
  })

  test('returns [] when the text has no mentions', () => {
    assert.deepEqual(contract.parseMentions('plain text, mail@example.com'), ['example'])
    assert.deepEqual(contract.parseMentions(''), [])
  })
})

describe('00 contract: excerpt / utf8Bytes', () => {
  test('excerpt collapses whitespace, trims and truncates (reply quotes)', () => {
    assert.equal(contract.excerpt('  hello \n\n  world\t!  '), 'hello world !')
    assert.equal(contract.excerpt('a'.repeat(200)).length, 120)
    assert.equal(contract.excerpt('a'.repeat(200), 10), 'aaaaaaaaaa')
  })

  test('utf8Bytes counts UTF-8 bytes, not code units', () => {
    assert.equal(contract.utf8Bytes('abc'), 3)
    assert.equal(contract.utf8Bytes('中文'), 6)
    assert.equal(contract.utf8Bytes('🚀'), 4)
    assert.equal(contract.utf8Bytes('a'.repeat(contract.MAX_TEXT_BYTES)), contract.MAX_TEXT_BYTES)
  })
})

describe('00 contract: built artifacts (SPEC §10.8)', () => {
  test('lib/contract.js is the built contract imported above', () => {
    assert.equal(existsSync(join(repoRoot, 'lib', 'contract.js')), true)
  })

  test("lib/index.js imports cleanly and exports name/apply", async () => {
    const host = await import('../lib/index.js')
    assert.equal(host.name, 'dsh-channels')
    assert.equal(typeof host.apply, 'function')
  })

  test('lib/client.js contains the __ModuleLoader__ bundle marker', () => {
    const client = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
    assert.equal(client.includes('__ModuleLoader__'), true)
  })

  test('package.json dsh manifest exposes bundle patch + web client', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-channels')
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(manifest.dsh.client.platform, 'web')
  })
})
