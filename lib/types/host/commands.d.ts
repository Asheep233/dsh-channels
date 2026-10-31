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
import type { SessionPrefs } from '../contract.js';
import type { ChannelsHub } from './hub.js';
import type { CtxLike } from './util.js';
/** Actions accepted after `/channels`. */
export declare const CHANNELS_COMMAND_ACTIONS: readonly ["status", "hide", "show", "mute", "unmute", "join", "leave"];
export type ChannelsCommandAction = (typeof CHANNELS_COMMAND_ACTIONS)[number];
/** Usage hint shown in the composer and on unknown actions. */
export declare const CHANNELS_COMMAND_USAGE = "\u7528\u6CD5\uFF1A/channels status | hide | show | mute | unmute | join <\u9891\u9053> | leave <\u9891\u9053>";
type CommandResultLike = {
    kind: 'success';
    text?: string;
} | {
    kind: 'error';
    text: string;
};
/** One-line status text shared by the command and its tests. */
export declare function statusText(prefs: SessionPrefs): string;
/** First whitespace-separated token of the raw input, lowercased. */
export declare function parseCommandAction(rawInput: unknown): string;
/** Split the raw input into `{action, argument}` (`argument` is the 2nd token). */
export declare function parseCommandArgs(rawInput: unknown): {
    action: string;
    argument: string;
};
/** Apply one action to one session and return the resulting status text. */
export declare function applyChannelsCommand(hub: ChannelsHub, sessionId: string, action: string, by: string, argument?: string): Promise<CommandResultLike>;
/**
 * Register `/channels` on the host command registry.
 * @returns nothing (registration is owned by `ctx.effect`).
 */
export declare function installCommands(ctx: CtxLike, hub: ChannelsHub): void;
export {};
