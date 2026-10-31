/**
 * dsh-channels native tools (SPEC.md §6).
 *
 * Registered globally through `ctx.tools.register(...)` as hand-written plain
 * objects: the host profile cannot resolve `@deepseek-ai/dsh-tools`, so no
 * `defineTool` import is possible and none is needed — the registry only
 * validates the declared `output` schema at registration time.
 *
 * Identity comes from `exec.agent` (the session driving the call). Every tool
 * catches its own expected failures and returns readable `{ ok:false, error }`
 * JSON instead of throwing and failing the turn.
 */
import type { ChannelsHub } from './hub.js';
import type { AgentLike, CtxLike } from './util.js';
/** Minimal execution-context shape (`exec.agent` drives tool identity). */
interface ToolExecLike {
    readonly agent?: AgentLike;
    readonly signal?: AbortSignal;
}
/** One hand-written tool definition accepted by `ctx.tools.register`. */
interface ToolDefinitionLike {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly output: {
        readonly schema: Record<string, unknown>;
        render(args: unknown, value: unknown): Array<{
            type: 'text';
            text: string;
        }>;
    };
    execute(args: unknown, exec: ToolExecLike): Promise<unknown>;
}
declare function buildDefinitions(hub: ChannelsHub): ToolDefinitionLike[];
/**
 * Register every `channel_*` tool globally. A duplicate registration (e.g. a
 * double-mounted plugin) is logged and skipped rather than failing activation.
 */
export declare function installTools(ctx: CtxLike, hub: ChannelsHub): void;
/** Exported for tests/doc generation. */
export { buildDefinitions as buildChannelToolDefinitions };
