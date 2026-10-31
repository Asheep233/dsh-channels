/**
 * dsh-channels —— client 半边（浏览器 bundle，tsdown 打成 `lib/client.js`）。
 *
 * 注册两处槽位：
 *   - `sidebar.panellist`：侧栏图标行（id 同时是 main 面板的 key）；
 *   - `main`（keyed）：key = 'dsh-channels' 的主面板。
 *
 * Client 半边也是 cordis 插件：只声明 `slots`。浏览器 bundle 只允许 import
 * React（external）和 `../contract.js`，不引入任何 UI 库 / @deepseek-ai/*。
 */

import * as React from 'react'
import * as api from './api.js'
import { ChannelsPanel } from './panel.js'
import { ensureStyles } from './styles.js'

/** 必须与 package.json 的 name 一致：browser 端按 id 注册到 __ModuleLoader__。 */
export const PLUGIN_ID = 'dsh-channels'

/** 侧栏图标行 id；main 面板的 key 必须与它相同，侧栏按钮才会选中本面板。 */
const PANEL_ID = PLUGIN_ID

/** apply 时捕获的 layout 服务；供 footer action 组件切换主面板。 */
let layoutService: { selectPanel(id: string): void } | undefined

/** 会话行「⋯」菜单项所在的槽位（与 dsh-forum 同一个）。 */
const SESSION_MENU_SLOT = 'sidebar.workspaces.session.menu.item'

/** 每个 sessionId 的已知偏好；菜单打开时刷新，点击后按服务端响应更新。 */
const prefsCache = new Map<string, api.SessionPrefsState>()

/** 同一会话的并发刷新合并成一个请求（hide/mute 两个菜单项同时挂载）。 */
const prefsInFlight = new Map<string, Promise<api.SessionPrefsState | null>>()

/** 读取缓存（缺省两项都关）。 */
function cachedPrefs(sessionId: string): api.SessionPrefsState {
  return prefsCache.get(sessionId) ?? { hidden: false, muted: false }
}

/** 合并写回缓存：POST 响应可能只带被改的那一项。 */
function mergePrefs(sessionId: string, patch: Partial<api.SessionPrefsState>): api.SessionPrefsState {
  const next: api.SessionPrefsState = { ...cachedPrefs(sessionId), ...patch }
  prefsCache.set(sessionId, next)
  return next
}

/**
 * 用一个可用身份执行请求：身份来自 localStorage；401 时清掉重新注册后重试一次。
 * @param run - 拿到 token 后要执行的请求。
 */
async function withIdentity<T>(
  run: (token: string) => Promise<api.ApiResult<T>>,
): Promise<api.ApiResult<T>> {
  const identity = await api.ensureIdentity()
  if (!identity.ok) return identity
  const first = await run(identity.value.token)
  if (first.ok || first.status !== 401) return first
  api.clearIdentity()
  const fresh = await api.ensureIdentity()
  if (!fresh.ok) return fresh
  return run(fresh.value.token)
}

/** Client 插件依赖 slots；layout 用来提供侧栏底部的快捷入口。 */
export const inject = ['slots', 'layout']

interface PanelIconProps {
  /** 侧栏给的方形边长（宽栏 16 / 收起栏 18）。 */
  size?: number
  /** 当前 main 面板是否选中。 */
  active?: boolean
}

/**
 * 侧栏图标：内联 SVG（不依赖 UI 库的 icon 组件）。
 * @param props - 侧栏提供的 size / active。
 * @returns 固定尺寸的装饰性图形。
 */
export function ChannelsIcon({ size = 16, active = false }: PanelIconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', opacity: active ? 1 : 0.78 }}
    >
      <path
        d="M4 6.2A2.7 2.7 0 0 1 6.7 3.5h10.6A2.7 2.7 0 0 1 20 6.2v6.9a2.7 2.7 0 0 1-2.7 2.7H9.9l-4.5 3.6a1 1 0 0 1-1.6-.8v-2.4a2.7 2.7 0 0 1-.2-1V6.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8.2 8.4h7.6M8.2 11.4h4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** Client 根上下文里本插件用到的部分（只声明用到的面，避免依赖 @deepseek-ai/* 类型）。 */
interface ClientContext {
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: React.ComponentType<any>): () => void
  }
  layout: {
    selectPanel(id: string): void
  }
  effect(callback: () => (() => void) | void, label?: string): void
  logger?: { warn?: (...args: unknown[]) => void }
}

/** 侧栏底部 action 的 owner props。 */
interface FooterActionProps {
  /** true = 宽栏（可显示文字），false = 56px 收起栏（只显示图标）。 */
  wide?: boolean
}

/**
 * 侧栏底部「频道」快捷入口：点击把主区域切到频道面板。
 * 与左侧图标行等价，但常驻在底部操作区，便于随时跳回。
 */
export function ChannelsFooterAction({ wide = true }: FooterActionProps): React.ReactElement {
  return (
    <button
      type="button"
      aria-label="频道"
      title="频道"
      data-dsh-channels-footer="true"
      onClick={() => {
        layoutService?.selectPanel(PANEL_ID)
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: wide ? '0 8px' : 0,
        width: wide ? undefined : 28,
        justifyContent: 'center',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: 6,
        fontSize: 12,
        opacity: 0.82,
      }}
    >
      <ChannelsIcon size={16} />
      {wide ? <span>频道</span> : null}
    </button>
  )
}

/**
 * 注册侧栏图标与主面板。
 * @param ctx - browser plugin 根上下文。
 */
export function apply(ctx: ClientContext): void {
  layoutService = ctx.layout
  /**
   * 注册失败（例如同一插件被热重载成两份时槽位已存在）只记 warning，
   * 不允许冒泡把整份插件激活打挂；返回空 disposer 保持 ctx.effect 协议。
   */
  const guarded = (label: string, run: () => () => void): void => {
    ctx.effect(
      () => {
        try {
          return run()
        } catch (error) {
          ctx.logger?.warn?.(`dsh-channels: ${label} 注册失败 %s`, String(error))
          return () => {}
        }
      },
      `dsh-channels: ${label}`,
    )
  }

  guarded('panel styles', ensureStyles)

  guarded('sidebar panellist', () =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: '频道',
        },
        ChannelsIcon,
      ),
    ),
  )

  guarded('main panel', () =>
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
        },
        ChannelsPanel,
      ),
    ),
  )

  guarded('sidebar footer action', () =>
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'dsh-channels-footer',
          order: 40,
          label: '频道',
        },
        ChannelsFooterAction,
      ),
    ),
  )

  /**
   * 会话行「⋯」菜单项：菜单打开时拉一次当前偏好，点击时写回并关闭菜单。
   * 失败只 warn（标签保持旧值），绝不让菜单报错。
   */
  const menuLogger = ctx.logger
  const warn = (message: string, error?: unknown): void => {
    if (message === '') return
    menuLogger?.warn?.(`dsh-channels: ${message}`, error === undefined ? '' : String(error))
  }

  /** 打开菜单时刷新（并发合并）；返回值只用于更新本地 state。 */
  const refreshPrefs = (sessionId: string): Promise<api.SessionPrefsState | null> => {
    const existing = prefsInFlight.get(sessionId)
    if (existing !== undefined) return existing
    const task = (async (): Promise<api.SessionPrefsState | null> => {
      try {
        // 同源 loopback 读信任：先不带 token；若该 host 版本要求 Bearer 则用身份重试一次。
        let result = await api.fetchSessionPrefs(sessionId)
        if (!result.ok && result.status === 401) {
          result = await withIdentity((token) => api.fetchSessionPrefs(sessionId, token))
        }
        if (!result.ok) {
          // 404 = host 还没部署 M4；离线（status 0）时也不要刷屏。
          if (result.status !== 404 && result.status !== 0) {
            warn(`读取会话偏好失败（${sessionId}）：${result.message}`)
          }
          return null
        }
        prefsCache.set(sessionId, result.value)
        return result.value
      } finally {
        prefsInFlight.delete(sessionId)
      }
    })()
    prefsInFlight.set(sessionId, task)
    return task
  }

  /** 点击后写回；成功返回合并后的偏好，失败返回 null（调用方保持旧标签）。 */
  const savePrefs = async (
    sessionId: string,
    patch: { hidden?: boolean; muted?: boolean },
  ): Promise<api.SessionPrefsState | null> => {
    const result = await withIdentity((token) => api.updateSessionPrefs({ sessionId, ...patch }, token))
    if (!result.ok) {
      warn(`保存会话偏好失败（${sessionId}）：${result.message}`, result.code)
      return null
    }
    return mergePrefs(sessionId, result.value)
  }

  /** 会话行「⋯」菜单里的一个开关（hide / mute 共用）。 */
  interface SessionSwitchProps {
    sessionId: string
    useMenuOpenState?: () => readonly [boolean, (open: boolean) => void]
  }

  interface SessionSwitchOptions {
    /** 读取当前值。 */
    read: (prefs: api.SessionPrefsState) => boolean
    /** 生成写回补丁。 */
    patch: (next: boolean) => { hidden?: boolean; muted?: boolean }
    /** 关闭态 / 开启态文案。 */
    labelOff: string
    labelOn: string
    titleOff: string
    titleOn: string
  }

  const makeSessionSwitch = (options: SessionSwitchOptions): React.ComponentType<SessionSwitchProps> => {
    function SessionSwitch(props: SessionSwitchProps): React.ReactElement {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // dsh 的「⋯」菜单会注入 useMenuOpenState；缺失时退化成「不会自动刷新」而不是崩掉。
      const useOpen = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : undefined
      const openState = useOpen === undefined ? undefined : useOpen()
      const open = openState !== undefined && openState[0] === true
      const setMenuOpen = openState === undefined ? undefined : openState[1]
      const [prefs, setPrefs] = React.useState<api.SessionPrefsState>(() => cachedPrefs(sessionId))
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!open || sessionId === '') return
        let cancelled = false
        void refreshPrefs(sessionId).then((next) => {
          if (!cancelled && next !== null) setPrefs(next)
        })
        return () => {
          cancelled = true
        }
      }, [open, sessionId])

      const on = options.read(prefs)
      const label = on ? options.labelOn : options.labelOff
      const title = on ? options.titleOn : options.titleOff

      const onClick = async (): Promise<void> => {
        if (busy || sessionId === '') return
        setBusy(true)
        // 菜单项是动作语义：点了就收起菜单，结果只体现在缓存/下次打开。
        setMenuOpen?.(false)
        try {
          const next = await savePrefs(sessionId, options.patch(!on))
          if (next !== null) setPrefs(next)
        } finally {
          setBusy(false)
        }
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          'data-dsh-channels-session-switch': sessionId,
          title,
          disabled: busy,
          onClick: () => {
            void onClick()
          },
        },
        label,
      )
    }
    return SessionSwitch
  }

  const HideSessionItem = makeSessionSwitch({
    read: (prefs) => prefs.hidden,
    patch: (next) => ({ hidden: next }),
    labelOff: '🙈 隐藏频道功能',
    labelOn: '👁 显示频道功能',
    titleOff: '本会话看不到任何 channel_* 工具，也不会被频道 @唤醒',
    titleOn: '恢复本会话的频道工具与 @唤醒',
  })

  const MuteSessionItem = makeSessionSwitch({
    read: (prefs) => prefs.muted,
    patch: (next) => ({ muted: next }),
    labelOff: '🔕 开启消息免打扰',
    labelOn: '🔔 关闭消息免打扰',
    titleOff: '频道消息照常入库，但 @提及 / 被回复不唤醒本会话',
    titleOn: '恢复 @提及 / 被回复时唤醒本会话',
  })

  guarded('session menu: hide channel feature', () =>
    ctx.slots.inject(SESSION_MENU_SLOT, () =>
      ctx.slots.register(
        {
          name: SESSION_MENU_SLOT,
          id: 'dsh-channels-hide',
          order: 55,
        },
        HideSessionItem,
      ),
    ),
  )

  guarded('session menu: mute', () =>
    ctx.slots.inject(SESSION_MENU_SLOT, () =>
      ctx.slots.register(
        {
          name: SESSION_MENU_SLOT,
          id: 'dsh-channels-mute',
          order: 56,
        },
        MuteSessionItem,
      ),
    ),
  )
}
