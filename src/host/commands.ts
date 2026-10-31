/**
 * `dsh-channels` slash command (SPEC.md §7.7).
 *
 * `/channels status|hide|show|mute|unmute` reads and writes the **calling
 * session's** own switches (`invocation.agent.id` is the session id), so a
 * per-session toggle is reachable from the composer without the Web menu.
 *
 * The command never throws into the dispatch path: every expected failure is
 * returned as `{ kind: 'error', text }` so the UI shows it inline.
 */

import type { SessionPrefs } from '../contract.js'

import type { ChannelsHub } from './hub.js'
import { errMessage, service } from './util.js'
import type { CtxLike } from './util.js'

/** Actions accepted after `/channels`. */
export const CHANNELS_COMMAND_ACTIONS = ['status', 'hide', 'show', 'mute', 'unmute', 'join', 'leave'] as const
export type ChannelsCommandAction = (typeof CHANNELS_COMMAND_ACTIONS)[number]

/** Usage hint shown in the composer and on unknown actions. */
export const CHANNELS_COMMAND_USAGE = '用法：/channels status | hide | show | mute | unmute | join <频道> | leave <频道>'

/** Actions that need a channel id argument. */
const ACTIONS_WITH_CHANNEL = new Set<string>(['join', 'leave'])

/** Minimal command-service shapes (host half stays free of @deepseek-ai imports). */
interface CommandAgentLike {
  readonly id: string
}

interface CommandInvocationLike {
  readonly agent?: CommandAgentLike
  readonly rawInput?: unknown
}

type CommandResultLike = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

interface CommandsLike {
  register(definition: CommandDefinitionLike): () => void
}

/** One-line status text shared by the command and its tests. */
export function statusText(prefs: SessionPrefs): string {
  return `频道：${prefs.hidden === true ? '隐藏' : '正常'}；免打扰：${prefs.muted === true ? '开' : '关'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First whitespace-separated token of the raw input, lowercased. */
export function parseCommandAction(rawInput: unknown): string {
  return parseCommandArgs(rawInput).action
}

/** Split the raw input into `{action, argument}` (`argument` is the 2nd token). */
export function parseCommandArgs(rawInput: unknown): { action: string; argument: string } {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text.length === 0) return { action: 'status', argument: '' }
  const tokens = text.split(/\s+/)
  return { action: (tokens[0] ?? '').toLowerCase(), argument: tokens[1] ?? '' }
}

/** Apply one action to one session and return the resulting status text. */
export async function applyChannelsCommand(
  hub: ChannelsHub,
  sessionId: string,
  action: string,
  by: string,
  argument = '',
): Promise<CommandResultLike> {
  if (action === 'status') return { kind: 'success', text: statusText(hub.sessionPrefsFor(sessionId)) }
  if (action === 'hide') return { kind: 'success', text: statusText(await hub.setSessionPrefs(sessionId, { hidden: true }, by)) }
  if (action === 'show') return { kind: 'success', text: statusText(await hub.setSessionPrefs(sessionId, { hidden: false }, by)) }
  if (action === 'mute') return { kind: 'success', text: statusText(await hub.setSessionPrefs(sessionId, { muted: true }, by)) }
  if (action === 'unmute') return { kind: 'success', text: statusText(await hub.setSessionPrefs(sessionId, { muted: false }, by)) }
  if (ACTIONS_WITH_CHANNEL.has(action)) {
    const channel = argument.trim()
    if (channel.length === 0) return { kind: 'error', text: `缺少频道 id。${CHANNELS_COMMAND_USAGE}` }
    const participant =
      hub.identity.findBySession(sessionId) ?? (await hub.identity.ensureSessionParticipant(sessionId))
    if (action === 'join') {
      const membership = hub.joinChannel(participant, channel)
      return { kind: 'success', text: `已加入 #${membership.channel}（成员 ${membership.memberCount}）` }
    }
    const membership = hub.leaveChannel(participant, channel)
    if (membership.joined) {
      // Humans are exempt from membership, and #general is mandatory.
      return { kind: 'success', text: `仍保留对 #${membership.channel} 的访问（人类豁免或 #general 不可退出）` }
    }
    return { kind: 'success', text: `已离开 #${membership.channel}（成员 ${membership.memberCount}）` }
  }
  return { kind: 'error', text: `未知操作 "${action}"。${CHANNELS_COMMAND_USAGE}` }
}

/**
 * Register `/channels` on the host command registry.
 * @returns nothing (registration is owned by `ctx.effect`).
 */
export function installCommands(ctx: CtxLike, hub: ChannelsHub): void {
  const commands = service(ctx, 'commands') as CommandsLike | undefined
  if (commands === undefined || typeof commands.register !== 'function') {
    ctx.logger.warn('dsh-channels: commands service unavailable; /channels not registered')
    return
  }

  ctx.effect(
    () => {
      const dispose = commands.register({
        name: 'channels',
        description: '查看/切换本会话的频道功能（隐藏）与消息免打扰（按会话生效）',
        input: { hint: '<status|hide|show|mute|unmute|join <id>|leave <id>>' },
        handler: async (invocation: CommandInvocationLike): Promise<CommandResultLike> => {
          try {
            const payload: Record<string, unknown> = isRecord(invocation) ? invocation : {}
            const agent = payload.agent
            const sessionId = isRecord(agent) && typeof agent.id === 'string' ? agent.id.trim() : ''
            if (sessionId.length === 0) {
              return { kind: 'error', text: '无法确定当前会话（缺少 agent 上下文）；请从会话内使用该命令。' }
            }
            const { action, argument } = parseCommandArgs(invocation.rawInput)
            return await applyChannelsCommand(hub, sessionId, action, 'command', argument)
          } catch (error) {
            return { kind: 'error', text: `频道设置失败：${errMessage(error)}` }
          }
        },
      })
      return () => {
        try {
          dispose()
        } catch {
          /* already unregistered */
        }
      }
    },
    'dsh-channels: /channels command',
  )
}
