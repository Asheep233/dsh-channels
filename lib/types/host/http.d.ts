/**
 * dsh-channels HTTP/SSE API (SPEC.md §5), mounted under `/channels/api`.
 *
 * One `prefix` route owns the whole namespace: it knows no harness concepts,
 * bypasses the `/api/*` browser-trust fence (plugin routes are not fenced), and
 * owns the full response lifecycle — including long-lived SSE responses.
 *
 * Auth: `Authorization: Bearer <token>` (or `?token=` for EventSource), except
 * `/register` and `/health`. Same-origin loopback browser requests may omit the
 * token for read-only endpoints (v1 trust model); write endpoints still need an
 * identity.
 *
 * Errors are always `{ error: { code, message } }` with the status codes from
 * the spec: 400 invalid, 401 unauthorized, 404 not_found, 409 conflict,
 * 429 rate_limited, 503 readonly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelsHub } from './hub.js';
import type { CtxLike } from './util.js';
declare function handle(hub: ChannelsHub, req: IncomingMessage, res: ServerResponse): Promise<void>;
/** Register the prefix route; returns nothing (disposal is wired via ctx.effect). */
export declare function installHttp(ctx: CtxLike, hub: ChannelsHub): void;
/** Exported for tests: same dispatcher the route handler uses. */
export { handle as handleChannelRequest };
