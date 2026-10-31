/**
 * 84 — M3 external bridges: CLI (`scripts/channels-cli.mjs`) and MCP stdio
 * (`scripts/mcp-stdio.mjs`) against the live host (SPEC §9).
 *
 * CLI: send --file uploads local files then sends attachment ids; search hits
 * GET /search; history renders `[file]`/`[img]` summaries; local pre-flight
 * validation (missing/empty/too many files) fails before any upload.
 * MCP: initialize / tools/list (channel_search present) / tools/call for
 * channel_search and channel_send --files, newline-delimited JSON-RPC only.
 *
 * Both bridges run with a throwaway `DSH_HOME`, so no real client token files
 * are created, and all writes go to a per-run throwaway channel.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, test } from 'node:test'

import { applyHub } from '../lib/host/hub.js'
import { buildChannelToolDefinitions } from '../lib/host/tools.js'
import {
  API,
  RUN,
  createChannel,
  getAttachment,
  history,
  makeFakeCtx,
  makeTempDataDir,
  makeTempHome,
  register,
  smallPng,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repoRoot, 'scripts', 'channels-cli.mjs')
const MCP = join(repoRoot, 'scripts', 'mcp-stdio.mjs')

const TOKEN = `cli${RUN}tok`

const state = {}

function runProcess(args, { home, timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...(home === undefined ? {} : { DSH_HOME: home }), ...env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: null, signal: 'timeout', stdout, stderr })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: 'spawn-error', stdout, stderr: `${stderr}${error.message}` })
    })
  })
}

function runCli(args, options = {}) {
  return runProcess([CLI, ...args], options)
}

/** Send newline-delimited JSON-RPC requests over MCP stdio and collect the response frames. */
function runMcp(requests, { home, token, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP, '--url', API], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: home, DSH_CHANNELS_TOKEN: token ?? '' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: null, signal: 'timeout', stdout, stderr })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const rawLines = stdout.split('\n').filter((line) => line.trim() !== '')
      const frames = []
      const parseErrors = []
      for (const line of rawLines) {
        try {
          frames.push(JSON.parse(line))
        } catch {
          parseErrors.push(line)
        }
      }
      resolve({ code, stdout, stderr, frames, rawLines, parseErrors })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: 'spawn-error', stdout, stderr: `${stderr}${error.message}`, frames: [], rawLines: [], parseErrors: [] })
    })
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`)
    child.stdin.end()
  })
}

const frameById = (result, id) => result.frames.find((frame) => frame.id === id)

before(async () => {
  state.home = makeTempHome(`m3cli-${RUN}`)
  state.handle = uniqueHandle('m3cli')
  state.channel = uniqueChannel('m3cli')
  state.filesDir = join(tmpdir(), `dsh-channels-qa-files-${RUN}`)
  mkdirSync(state.filesDir, { recursive: true })

  state.noteText = `CLI attachment body 你好\nsecond line\n${TOKEN}`
  state.notePath = join(state.filesDir, 'qa-m3-note.txt')
  writeFileSync(state.notePath, state.noteText, 'utf8')
  state.pngPath = join(state.filesDir, 'qa-m3-pixel.png')
  writeFileSync(state.pngPath, smallPng())
  state.emptyPath = join(state.filesDir, 'qa-m3-empty.txt')
  writeFileSync(state.emptyPath, '')

  // CLI registers an external identity (token saved under the throwaway DSH_HOME).
  state.register = await runCli(['register', '--as', state.handle, '--url', API], { home: state.home })
  assert.equal(state.register.code, 0, `CLI register failed: ${state.register.stderr}`)
  state.tokenFile = join(state.home, 'channels', 'clients', `${state.handle}.json`)
  state.identity = JSON.parse(readFileSync(state.tokenFile, 'utf8'))
  await createChannel(state.identity.token, state.channel, { name: 'QA M3 CLI/MCP' })
})

describe('84 M3 CLI: identity + send --file', () => {
  test('register saves a 0600 token file and works without a running host assumption', async () => {
    assert.equal(state.register.stdout.includes(state.handle), true, `register output: ${state.register.stdout}`)
    assert.equal(state.identity.handle, state.handle)
    assert.match(state.identity.token, /^[A-Za-z0-9_-]{43}$/)
    const mode = statSync(state.tokenFile).mode & 0o777
    assert.equal(mode, 0o600, `token file mode must be 0600, got ${mode.toString(8)}`)

    const whoami = await runCli(['whoami', '--as', state.handle, '--url', API], { home: state.home })
    assert.equal(whoami.code, 0, whoami.stderr)
    assert.ok(whoami.stdout.includes(state.handle), whoami.stdout)
  })

  test('CLI --help works without contacting the host', async () => {
    const help = await runProcess([CLI, '--help'], { home: state.home })
    assert.equal(help.code, 0)
    assert.ok(help.stdout.includes('send <channel> [text...]'))
    assert.ok(help.stdout.includes('search <query...>'))
    assert.ok(help.stdout.includes('--file'))
  })

  test('send text posts a message and prints id/seq', async () => {
    const result = await runCli(['send', state.channel, `CLI text ${TOKEN}`, '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`sent #${state.channel} id=${state.channel}-\\d{6} seq=1`))
    state.textMessage = (await history(state.identity.token, state.channel, { limit: 10 })).messages[0]
    assert.equal(state.textMessage.text, `CLI text ${TOKEN}`)
  })

  test('send --file (no text) uploads then attaches the file; bytes round-trip', async () => {
    const result = await runCli(['send', state.channel, '--file', state.notePath, '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`sent #${state.channel} id=${state.channel}-\\d{6} seq=2`))
    assert.ok(result.stdout.includes('attachments=qa-m3-note.txt'), `upload summary missing: ${result.stdout}`)
    assert.ok(result.stderr.includes('uploading qa-m3-note.txt'), `stderr should show upload progress: ${result.stderr}`)

    const page = await history(state.identity.token, state.channel, { limit: 10 })
    const message = page.messages.find((entry) => entry.seq === 2)
    assert.equal(message.text, '')
    assert.equal(message.attachments.length, 1)
    const [attachment] = message.attachments
    assert.equal(attachment.name, 'qa-m3-note.txt')
    assert.equal(attachment.size, Buffer.byteLength(state.noteText))
    assert.equal(attachment.mime, 'text/plain')
    const served = await getAttachment(attachment.id)
    assert.equal(served.bytes.toString('utf8'), state.noteText)
  })

  test('send --file with an image and text keeps both; history renders [file]/[img]', async () => {
    const result = await runCli(
      ['send', state.channel, 'pic attached', '--file', state.pngPath, '--as', state.handle, '--url', API],
      { home: state.home },
    )
    assert.equal(result.code, 0, result.stderr)
    const page = await history(state.identity.token, state.channel, { limit: 10 })
    const message = page.messages.find((entry) => entry.seq === 3)
    assert.equal(message.text, 'pic attached')
    assert.equal(message.attachments[0].mime, 'image/png')
    assert.equal(message.attachments[0].width, 1)

    const historyOut = await runCli(['history', state.channel, '--as', state.handle, '--url', API], { home: state.home })
    assert.equal(historyOut.code, 0, historyOut.stderr)
    assert.ok(historyOut.stdout.includes('[file] qa-m3-note.txt ('), `history must summarise the file: ${historyOut.stdout}`)
    assert.ok(historyOut.stdout.includes('[img] qa-m3-pixel.png'), `history must summarise the image: ${historyOut.stdout}`)
  })

  test('search --json returns hits; text mode matches the SPEC §9 line format', async () => {
    const json = await runCli(['search', TOKEN, '--channel', state.channel, '--json', '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.equal(json.code, 0, json.stderr)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.hits.length, 1)
    assert.equal(parsed.hits[0].channel, state.channel)
    assert.equal(parsed.hits[0].message.text, `CLI text ${TOKEN}`)
    assert.ok(parsed.hits[0].snippet.toLowerCase().includes(TOKEN))

    const text = await runCli(['search', TOKEN, '--channel', state.channel, '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.equal(text.code, 0, text.stderr)
    const line = text.stdout.trim().split('\n')[0]
    assert.match(
      line,
      new RegExp(`^#${state.channel} 000001 @${state.handle} \\d{2}:\\d{2}  .*${TOKEN}`),
      `unexpected search line: ${line}`,
    )
  })

  test('search option validation rejects a bad --limit before calling the host', async () => {
    const badLimit = await runCli(['search', TOKEN, '--limit', '0', '--as', state.handle, '--url', API], { home: state.home })
    assert.notEqual(badLimit.code, 0)
    assert.match(badLimit.stderr, /--limit/i)

    const tooBig = await runCli(['search', TOKEN, '--limit', '999', '--as', state.handle, '--url', API], { home: state.home })
    assert.notEqual(tooBig.code, 0)
    assert.match(tooBig.stderr, /--limit/i)
  })

  test('local pre-flight validation fails before uploading', async () => {
    const missing = await runCli(['send', state.channel, '--file', join(state.filesDir, 'nope.bin'), '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /file not found/i)

    const empty = await runCli(['send', state.channel, '--file', state.emptyPath, '--as', state.handle, '--url', API], {
      home: state.home,
    })
    assert.notEqual(empty.code, 0)
    assert.match(empty.stderr, /file is empty/i)

    const tooMany = await runCli(
      ['send', state.channel, ...Array.from({ length: 11 }, () => ['--file', state.notePath]).flat(), '--as', state.handle, '--url', API],
      { home: state.home },
    )
    assert.notEqual(tooMany.code, 0)
    assert.match(tooMany.stderr, /too many files/i)
    assert.match(tooMany.stderr, /max 10/)

    const noTextNoFile = await runCli(['send', state.channel, '--as', state.handle, '--url', API], { home: state.home })
    assert.notEqual(noTextNoFile.code, 0)
    assert.match(noTextNoFile.stderr, /needs message text or at least one --file/i)

    const noQuery = await runCli(['search', '--as', state.handle, '--url', API], { home: state.home })
    assert.notEqual(noQuery.code, 0)
    assert.match(noQuery.stderr, /usage: search/i)

    // None of the failed commands may have appended a message.
    const page = await history(state.identity.token, state.channel, { limit: 100 })
    assert.equal(page.messages.length, 3, 'only the three successful sends exist')
  })
})

describe('84 M3 MCP: stdio JSON-RPC', () => {
  test('initialize / tools/list / ping / unknown method are valid JSON-RPC', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'ping' },
        { jsonrpc: '2.0', id: 4, method: 'definitely/not-a-method' },
      ],
      { home: state.home, token: state.identity.token },
    )
    assert.deepEqual(result.parseErrors, [], 'stdout must only contain JSON-RPC frames')
    assert.equal(result.code, 0, `MCP must exit 0 on stdin EOF; stderr=${result.stderr}`)

    const init = frameById(result, 1)
    assert.ok(init !== undefined, `no initialize response: ${result.stdout.slice(0, 500)}`)
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'dsh-channels')
    assert.deepEqual(init.result.capabilities, { tools: {} })

    const tools = frameById(result, 2).result.tools
    const names = tools.map((tool) => tool.name)
    assert.equal(names.length, 12, `expected 12 tools (M5 added join/leave), got: ${names.join(',')}`)
    for (const expected of ['channel_search', 'channel_send', 'channel_history', 'channel_join', 'channel_leave']) {
      assert.ok(names.includes(expected), `tools/list must include ${expected}`)
    }
    assert.ok(!names.includes('channel_upload'), 'channel_upload is a host tool, not an MCP tool')

    const sendTool = tools.find((tool) => tool.name === 'channel_send')
    assert.equal(sendTool.inputSchema.properties.files?.type, 'array', 'channel_send.files schema missing')
    assert.deepEqual(sendTool.inputSchema.properties.files.items, { type: 'string' })
    const searchTool = tools.find((tool) => tool.name === 'channel_search')
    assert.deepEqual(searchTool.inputSchema.required, ['query'])

    assert.deepEqual(frameById(result, 3).result, {})
    const unknown = frameById(result, 4)
    assert.equal(unknown.error.code, -32601)
  })

  test('tools/call channel_search returns hits for the seeded message', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'channel_search', arguments: { query: TOKEN, channel: state.channel, limit: 5 } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'channel_search', arguments: { query: `zz${RUN}nomatch` } },
        },
      ],
      { home: state.home, token: state.identity.token },
    )
    assert.deepEqual(result.parseErrors, [])
    const call = frameById(result, 2)
    assert.equal(call.result.isError, undefined, JSON.stringify(call.result).slice(0, 400))
    assert.equal(call.result.content[0].type, 'text')
    const payload = JSON.parse(call.result.content[0].text)
    assert.equal(payload.query, TOKEN)
    assert.equal(payload.hits.length, 1)
    assert.equal(payload.hits[0].channel, state.channel)
    assert.equal(payload.hits[0].message.text, `CLI text ${TOKEN}`)
    assert.ok(payload.hits[0].snippet.toLowerCase().includes(TOKEN))

    const none = JSON.parse(frameById(result, 3).result.content[0].text)
    assert.deepEqual(none.hits, [])
    assert.equal(none.hasMore, false)
  })

  test('tools/call error paths are MCP isError results, not crashes', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'channel_send', arguments: { channel: state.channel, files: [join(state.filesDir, 'missing.bin')] } },
        },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'channel_search', arguments: {} } },
      ],
      { home: state.home, token: state.identity.token },
    )
    assert.deepEqual(result.parseErrors, [])
    assert.equal(result.code, 0)

    const unknown = frameById(result, 2).result
    assert.equal(unknown.isError, true)
    assert.equal(JSON.parse(unknown.content[0].text).error.code, 'unknown_tool')

    const missingFile = frameById(result, 3).result
    assert.equal(missingFile.isError, true)
    assert.match(JSON.parse(missingFile.content[0].text).error.message, /file not found/i)

    const missingArg = frameById(result, 4).result
    assert.equal(missingArg.isError, true)
    assert.match(JSON.parse(missingArg.content[0].text).error.message, /query/i)

    // None of the failing calls may have appended a message.
    const page = await history(state.identity.token, state.channel, { limit: 100 })
    assert.ok(page.messages.length <= 4, `unexpected message appended: ${page.messages.length}`)
  })

  test('tools/call channel_send with files uploads and attaches them', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'channel_send',
            arguments: { channel: state.channel, text: 'MCP files message', files: [state.notePath, state.pngPath] },
          },
        },
      ],
      { home: state.home, token: state.identity.token },
    )
    assert.deepEqual(result.parseErrors, [])
    const call = frameById(result, 2)
    assert.equal(call.result.isError, undefined, JSON.stringify(call.result).slice(0, 500))
    const payload = JSON.parse(call.result.content[0].text)
    assert.equal(payload.message.text, 'MCP files message')
    assert.equal(payload.message.attachments.length, 2)
    const names = payload.message.attachments.map((attachment) => attachment.name)
    assert.deepEqual(names.sort(), ['qa-m3-note.txt', 'qa-m3-pixel.png'].sort())

    // Cross-check against the host: the message really carries the attachments.
    const page = await history(state.identity.token, state.channel, { limit: 100 })
    const stored = page.messages.find((message) => message.id === payload.message.id)
    assert.equal(stored.seq, 4)
    assert.equal(stored.attachments.length, 2)
    const served = await getAttachment(stored.attachments.find((attachment) => attachment.mime === 'text/plain').id)
    assert.equal(served.bytes.toString('utf8'), state.noteText)
  })
})

describe('84 M3 host tools: channel_* definitions', () => {
  test('all 16 SPEC §6 tools are registered, including search/upload/archive', () => {
    const dataDir = makeTempDataDir(`m3tools-${RUN}`)
    const hub = applyHub(makeFakeCtx(), { dataDir, wake: false })
    assert.ok(hub !== undefined)
    try {
      const definitions = buildChannelToolDefinitions(hub)
      const names = definitions.map((definition) => definition.name).sort()
      const expected = [
        'channel_announce',
        'channel_archive',
        'channel_claim',
        'channel_create',
        'channel_history',
        'channel_join',
        'channel_leave',
        'channel_list',
        'channel_login',
        'channel_members',
        'channel_pin',
        'channel_pins',
        'channel_release',
        'channel_search',
        'channel_send',
        'channel_unpin',
        'channel_upload',
        'channel_whoami',
      ].sort()
      assert.deepEqual(names, expected, `registered tools differ from SPEC §6: ${names.join(',')}`)

      const byName = new Map(definitions.map((definition) => [definition.name, definition]))
      const requiredOf = (name) => byName.get(name).parameters.required ?? []
      assert.deepEqual(requiredOf('channel_search'), ['query'])
      assert.deepEqual(requiredOf('channel_upload'), ['path'])
      assert.deepEqual(requiredOf('channel_archive'), ['channel'])
      assert.deepEqual(requiredOf('channel_join'), ['channel'])
      assert.deepEqual(requiredOf('channel_leave'), ['channel'])
      assert.deepEqual(requiredOf('channel_send'), ['channel'], 'channel_send text is optional when attachments exist')

      const sendParams = byName.get('channel_send').parameters.properties
      assert.equal(sendParams.attachments.type, 'array')
      assert.equal(sendParams.attachments.items.type, 'string')
      for (const definition of definitions) {
        assert.equal(typeof definition.description, 'string')
        assert.equal(definition.parameters.type, 'object')
        assert.equal(typeof definition.execute, 'function')
        assert.equal(typeof definition.output.render, 'function')
      }
    } finally {
      hub.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
