/**
 * dsh-channels host entry.
 *
 * Discord-style channel IM for DeepSeek Harness. The host half owns storage,
 * identity, @mention wake, tools and the loopback HTTP/SSE API; the client half
 * (src/client) renders the Web panel. See SPEC.md for the full contract.
 *
 * Host code stays dependency-free: only `node:` builtins. Do NOT import
 * `@deepseek-ai/*` here — the profile cannot resolve those from a linked plugin.
 */
export declare const name = "dsh-channels";
export declare const inject: string[];
/**
 * @param ctx - Cordis root context (web profile).
 * @param config - optional user config from cordis.patch.yml.
 */
export declare function apply(ctx: any, config?: unknown): void;
