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
import * as React from 'react';
/** 必须与 package.json 的 name 一致：browser 端按 id 注册到 __ModuleLoader__。 */
export declare const PLUGIN_ID = "dsh-channels";
/** Client 插件依赖 slots；layout 用来提供侧栏底部的快捷入口。 */
export declare const inject: string[];
interface PanelIconProps {
    /** 侧栏给的方形边长（宽栏 16 / 收起栏 18）。 */
    size?: number;
    /** 当前 main 面板是否选中。 */
    active?: boolean;
}
/**
 * 侧栏图标：内联 SVG（不依赖 UI 库的 icon 组件）。
 * @param props - 侧栏提供的 size / active。
 * @returns 固定尺寸的装饰性图形。
 */
export declare function ChannelsIcon({ size, active }: PanelIconProps): React.ReactElement;
/** Client 根上下文里本插件用到的部分（只声明用到的面，避免依赖 @deepseek-ai/* 类型）。 */
interface ClientContext {
    slots: {
        inject(key: string, callback: () => () => void): () => void;
        register(options: Record<string, unknown>, component: React.ComponentType<any>): () => void;
    };
    layout: {
        selectPanel(id: string): void;
    };
    effect(callback: () => (() => void) | void, label?: string): void;
    logger?: {
        warn?: (...args: unknown[]) => void;
    };
}
/** 侧栏底部 action 的 owner props。 */
interface FooterActionProps {
    /** true = 宽栏（可显示文字），false = 56px 收起栏（只显示图标）。 */
    wide?: boolean;
}
/**
 * 侧栏底部「频道」快捷入口：点击把主区域切到频道面板。
 * 与左侧图标行等价，但常驻在底部操作区，便于随时跳回。
 */
export declare function ChannelsFooterAction({ wide }: FooterActionProps): React.ReactElement;
/**
 * 注册侧栏图标与主面板。
 * @param ctx - browser plugin 根上下文。
 */
export declare function apply(ctx: ClientContext): void;
export {};
