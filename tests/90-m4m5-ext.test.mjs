/**
 * 90 — M4/M5 external bridges: CLI `join`/`leave`/list membership view and MCP
 * `channel_join` / `channel_leave` (SPEC §7.8 + §9).
 *
 * CLI runs with a throwaway `DSH_HOME` (never touches the real clients dir) and
 * writes only to a per-run throwaway channel. MCP is spoken over stdio with
 * newline-delimited JSON-RPC, using the same throwaway identity token.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, test } from 'node:test'

import {
  API,
  RUN,
  apiOk,
  createChannel,
  history,
  makeTempHome,
  register,
  uniqueChannel,
  uniqueHandle,
} from './_helpers.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repoRoot, 'scripts', 'channels-cli.mjs')
const MCP = join(repoRoot, 'scripts', 'mcp-stdio.mjs')

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

const runCli = (args, options = {}) => runProcess([CLI, ...args], options)

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
      resolve({ code: null, signal: 'timeout', stdout, stderr, frames: [], parseErrors: [] })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const frames = []
      const parseErrors = []
      for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue
        try {
          frames.push(JSON.parse(line))
        } catch {
          parseErrors.push(line)
        }
      }
      resolve({ code, stdout, stderr, frames, parseErrors })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: 'spawn-error', stdout, stderr: `${stderr}${error.message}`, frames: [], parseErrors: [] })
    })
    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`)
    child.stdin.end()
  })
}

const frameById = (result, id) => result.frames.find((frame) => frame.id === id)
const toolPayload = (frame) => JSON.parse(frame.result.content[0].text)

before(async () => {
  state.home = makeTempHome(`m4m5-${RUN}`)
  mkdirSync(state.home, { recursive: true })
  state.ownerHandle = uniqueHandle('m4m5', 'own')
  state.outsiderHandle = uniqueHandle('m4m5', 'out')
  state.channel = uniqueChannel('m4m5')
  state.messageToken = `cli-m5-${RUN}`

  const ownerReg = await runCli(['register', '--as', state.ownerHandle, '--url', API], { home: state.home })
  assert.equal(ownerReg.code, 0, ownerReg.stderr)
  state.owner = JSON.parse(readFileSync(join(state.home, 'channels', 'clients', `${state.ownerHandle}.json`), 'utf8'))

  const outsiderReg = await runCli(['register', '--as', state.outsiderHandle, '--url', API], { home: state.home })
  assert.equal(outsiderReg.code, 0, outsiderReg.stderr)
  state.outsider = JSON.parse(readFileSync(join(state.home, 'channels', 'clients', `${state.outsiderHandle}.json`), 'utf8'))

  await createChannel(state.owner.token, state.channel, { name: 'M4/M5 CLI+MCP' })
  // Live host may auto-join configured default members to every new channel.
  const ownerView = (await apiOk('/channels', { token: state.owner.token })).find(
    (channel) => channel.id === state.channel,
  )
  state.baseCount = ownerView.memberCount
})

/** `N member` / `N members` as printed by the CLI. */
const membersWord = (count) => `${count} member${count === 1 ? '' : 's'}`

describe('90 M4/M5 CLI: membership', () => {
  test('channels marks a non-joined sub-channel with (未加入), joined ones with member counts', async () => {
    const outsiderList = await runCli(['channels', '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.equal(outsiderList.code, 0, outsiderList.stderr)
    const outsiderLine = outsiderList.stdout.split('\n').find((line) => line.includes(`#${state.channel}`))
    assert.ok(outsiderLine !== undefined, outsiderList.stdout)
    assert.ok(outsiderLine.includes('(未加入)'), `non-member marker missing: ${outsiderLine}`)

    const ownerList = await runCli(['channels', '--as', state.ownerHandle, '--url', API], { home: state.home })
    assert.equal(ownerList.code, 0, ownerList.stderr)
    const ownerLine = ownerList.stdout.split('\n').find((line) => line.includes(`#${state.channel}`))
    assert.ok(ownerLine !== undefined)
    assert.equal(ownerLine.includes('(未加入)'), false)
    assert.ok(ownerLine.includes(membersWord(state.baseCount)), ownerLine)
  })

  test('send from a non-member fails with a not_member hint telling the CLI join command', async () => {
    const denied = await runCli(
      ['send', state.channel, `blocked ${state.messageToken}`, '--as', state.outsiderHandle, '--url', API],
      { home: state.home },
    )
    assert.notEqual(denied.code, 0)
    assert.match(denied.stderr, /not a member of #/)
    assert.ok(denied.stderr.includes(`run: channels-cli join ${state.channel}`), denied.stderr)
  })

  test('join unlocks the channel; send/history then work', async () => {
    const joined = await runCli(['join', state.channel, '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.equal(joined.code, 0, joined.stderr)
    assert.equal(joined.stdout.trim(), `joined #${state.channel} (${membersWord(state.baseCount + 1)})`)

    const list = await runCli(['channels', '--as', state.outsiderHandle, '--url', API], { home: state.home })
    const line = list.stdout.split('\n').find((entry) => entry.includes(`#${state.channel}`))
    assert.equal(line.includes('(未加入)'), false)
    assert.ok(line.includes(membersWord(state.baseCount + 1)), line)

    const sent = await runCli(
      ['send', state.channel, `after join ${state.messageToken}`, '--as', state.outsiderHandle, '--url', API],
      { home: state.home },
    )
    assert.equal(sent.code, 0, sent.stderr)
    assert.match(sent.stdout, new RegExp(`sent #${state.channel} id=`))

    const page = await history(state.outsider.token, state.channel, { limit: 10 })
    assert.ok(page.messages.some((message) => message.text.includes(`after join ${state.messageToken}`)))
  })

  test('join --json reports the membership payload', async () => {
    await runCli(['leave', state.channel, '--as', state.outsiderHandle, '--url', API], { home: state.home })
    const json = await runCli(['join', state.channel, '--json', '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.equal(json.code, 0, json.stderr)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.channel, state.channel)
    assert.equal(payload.joined, true)
    assert.equal(payload.memberCount, state.baseCount + 1)
  })

  test('leave locks the channel again and #general cannot be left', async () => {
    const left = await runCli(['leave', state.channel, '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.equal(left.code, 0, left.stderr)
    assert.equal(left.stdout.trim(), `left #${state.channel} (${membersWord(state.baseCount)})`)

    const denied = await runCli(
      ['send', state.channel, 'again blocked', '--as', state.outsiderHandle, '--url', API],
      { home: state.home },
    )
    assert.notEqual(denied.code, 0)
    assert.match(denied.stderr, /not a member of #/)

    const general = await runCli(['leave', 'general', '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.notEqual(general.code, 0)
    assert.match(general.stderr, /cannot leave #general/i)

    const unknown = await runCli(['join', `qa-nope-${RUN}`, '--as', state.outsiderHandle, '--url', API], { home: state.home })
    assert.notEqual(unknown.code, 0)
    assert.match(unknown.stderr, /does not exist|not_found|404/i)
  })
})

describe('90 M4/M5 MCP: channel_join / channel_leave', () => {
  test('tools/list exposes 12 tools including channel_join/channel_leave', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      { home: state.home, token: state.owner.token },
    )
    assert.deepEqual(result.parseErrors, [])
    const tools = frameById(result, 2).result.tools
    const names = tools.map((tool) => tool.name).sort()
    assert.equal(names.length, 12, names.join(','))
    assert.ok(names.includes('channel_join'))
    assert.ok(names.includes('channel_leave'))
    for (const name of ['channel_join', 'channel_leave']) {
      assert.deepEqual(tools.find((tool) => tool.name === name).inputSchema.required, ['channel'])
    }
    assert.ok(names.includes('channel_search'), 'M3 search tool still present')
  })

  test('tools/call join → send → history works; leave → send isError not_member', async () => {
    const result = await runMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'channel_join', arguments: { channel: state.channel } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'channel_send', arguments: { channel: state.channel, text: `mcp joined ${state.messageToken}` } },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'channel_history', arguments: { channel: state.channel, limit: 5 } },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'channel_leave', arguments: { channel: state.channel } },
        },
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'channel_send', arguments: { channel: state.channel, text: 'blocked after leave' } },
        },
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'channel_list', arguments: {} } },
      ],
      { home: state.home, token: state.outsider.token },
    )
    assert.deepEqual(result.parseErrors, [])

    // MCP proxies the raw HTTP payloads (no {ok:true} envelope).
    const joined = toolPayload(frameById(result, 2))
    assert.deepEqual(joined, { channel: state.channel, joined: true, memberCount: state.baseCount + 1 })

    const sent = toolPayload(frameById(result, 3))
    assert.equal(sent.message.channel, state.channel)
    assert.equal(sent.duplicate, false)

    const page = toolPayload(frameById(result, 4))
    assert.equal(page.channel, state.channel)
    assert.ok(page.messages.some((message) => message.text.includes(`mcp joined ${state.messageToken}`)))

    const left = toolPayload(frameById(result, 5))
    assert.deepEqual(left, { channel: state.channel, joined: false, memberCount: state.baseCount })

    const blockedFrame = frameById(result, 6)
    assert.equal(blockedFrame.result.isError, true)
    const blocked = toolPayload(blockedFrame)
    assert.equal(blocked.error.code, 'not_member')
    assert.match(blocked.error.message, /channel_join/)

    const list = toolPayload(frameById(result, 7))
    assert.ok(Array.isArray(list), 'channel_list proxies GET /channels (an array)')
    const view = list.find((channel) => channel.id === state.channel)
    assert.equal(view.joined, false)
    assert.equal(view.memberCount, state.baseCount)
    assert.equal(list.find((channel) => channel.id === 'general').joined, true)
  })
})
