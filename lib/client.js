window.__ModuleLoader__.load({
	id: "dsh-channels",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/contract.ts
		const API_BASE = "/channels/api";
		const DEFAULT_CHANNEL = "general";
		const MAX_TEXT_BYTES = 8192;
		const MAX_ATTACHMENT_BYTES = 26214400;
		const MAX_ATTACHMENT_TOTAL_BYTES = 52428800;
		const HANDLE_RE = /^[a-z0-9_-]{2,24}$/;
		const RESERVED_HANDLES = /* @__PURE__ */ new Set([
			"all",
			"here",
			"channel",
			"system",
			"everyone"
		]);
		/** True when the value is a legal channel id (slug). */
		function isValidChannelId(value) {
			return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
		}
		/** True when the value is a legal handle. */
		function isValidHandle(value) {
			return typeof value === "string" && HANDLE_RE.test(value) && !RESERVED_HANDLES.has(value);
		}
		/** Normalize a user-supplied handle (lowercase, trim). */
		function normalizeHandle(value) {
			return value.trim().toLowerCase();
		}
		/** Parse `@handle` mentions out of a message body. */
		function parseMentions(text) {
			const out = [];
			const re = /@([a-z0-9_-]{2,24})/gi;
			let match;
			while ((match = re.exec(text)) !== null) {
				const handle = normalizeHandle(match[1] ?? "");
				if (handle.length > 0 && !out.includes(handle)) out.push(handle);
			}
			return out;
		}
		/** One-line preview used by reply quotes and notifications. */
		function excerpt(text, limit = 120) {
			return text.replace(/\s+/g, " ").trim().slice(0, limit);
		}
		/** Human-readable byte size (UI / CLI). */
		function humanSize(bytes) {
			if (!Number.isFinite(bytes) || bytes < 0) return "?";
			if (bytes < 1024) return `${Math.round(bytes)} B`;
			if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / 1048576).toFixed(1)} MB`;
		}
		/** True when the mime type is a browser-inlineable raster image. */
		function isInlineImageMime(mime) {
			return /^image\/(png|jpeg|gif|webp)$/i.test(mime);
		}
		/** Byte length of a UTF-8 string. */
		function utf8Bytes(text) {
			return new TextEncoder().encode(text).length;
		}
		// src/client/api.ts
		/**
		* dsh-channels 浏览器侧的传输层：同源 HTTP + SSE + 本地身份。
		*
		* 这里不依赖任何 @deepseek-ai/* 类型（浏览器 bundle 只能 import React 和
		* `../contract.js`），所以所有响应都先按 unknown 解析、再由本文件的
		* normalize* 函数宽松校验。契约以 `src/contract.ts` 为准，但 host 可能
		* 直接返回数组、也可能包一层 `{ channels }` / `{ messages }`，两种都吃。
		*/
		const IDENTITY_KEY = "dsh-channels.identity";
		function isRecord(value) {
			return typeof value === "object" && value !== null;
		}
		function str(value, fallback = "") {
			return typeof value === "string" ? value : fallback;
		}
		function num(value, fallback = 0) {
			return typeof value === "number" && Number.isFinite(value) ? value : fallback;
		}
		function bool(value, fallback = false) {
			return typeof value === "boolean" ? value : fallback;
		}
		/** 从数组中取第一个存在的数组字段：兼容裸数组与 `{ channels }` 包装。 */
		function firstArray(value, keys) {
			if (Array.isArray(value)) return value;
			if (isRecord(value)) for (const key of keys) {
				const found = value[key];
				if (Array.isArray(found)) return found;
			}
			return [];
		}
		function asKind(value) {
			return value === "human" || value === "dsh-agent" || value === "external" ? value : "external";
		}
		function asHarness(value) {
			return value === "dsh" || value === "claude-code" || value === "codex" || value === "opencode" || value === "other" ? value : "other";
		}
		function asStatus(value, lastSeen) {
			if (value === "online" || value === "idle" || value === "offline") return value;
			const at = Date.parse(lastSeen);
			if (Number.isFinite(at) && Date.now() - at < 12e4) return "online";
			return "offline";
		}
		/**
		* 单条附件的宽松转换；形状不认识（无 id 或 url）时返回 null。
		* @param value - 服务端返回的 Attachment 形状。
		* @returns 归一化后的附件，或 null。
		*/
		function normalizeAttachment(value) {
			if (!isRecord(value)) return null;
			const id = str(value.id);
			const url = str(value.url);
			if (id === "" || url === "") return null;
			const name = str(value.name, id);
			const width = num(value.width);
			const height = num(value.height);
			return {
				id,
				name,
				mime: str(value.mime, "application/octet-stream"),
				size: Math.max(0, num(value.size)),
				url,
				...width > 0 ? { width } : {},
				...height > 0 ? { height } : {}
			};
		}
		/** attachments 数组的宽松解析（容忍缺失 / 非数组 / 坏条目）。 */
		function toAttachments(value) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const item of value) {
				const attachment = normalizeAttachment(item);
				if (attachment !== null) out.push(attachment);
			}
			return out;
		}
		/** 单条消息的宽松转换；形状不认识时返回 null。 */
		function normalizeMessage(value) {
			if (!isRecord(value)) return null;
			const id = str(value.id);
			const channel = str(value.channel);
			const text = typeof value.text === "string" ? value.text : "";
			if (id === "" || channel === "" || typeof value.seq !== "number") return null;
			const authorRaw = isRecord(value.author) ? value.author : {};
			const handle = str(authorRaw.handle, "unknown");
			const mentions = Array.isArray(value.mentions) ? value.mentions.filter((item) => typeof item === "string") : [];
			let replyTo;
			if (isRecord(value.replyTo)) {
				const replyRaw = value.replyTo;
				const replyId = str(replyRaw.id);
				if (replyId !== "") replyTo = {
					id: replyId,
					seq: num(replyRaw.seq),
					authorName: str(replyRaw.authorName),
					excerpt: str(replyRaw.excerpt)
				};
			}
			const attachments = toAttachments(value.attachments);
			return {
				id,
				channel,
				seq: value.seq,
				ts: str(value.ts),
				author: {
					participantId: str(authorRaw.participantId),
					handle,
					displayName: str(authorRaw.displayName, handle),
					kind: asKind(authorRaw.kind),
					harness: asHarness(authorRaw.harness)
				},
				text,
				mentions,
				replyTo,
				kind: value.kind === "announcement" ? "announcement" : "chat",
				...attachments.length > 0 ? { attachments } : {}
			};
		}
		function normalizeParticipant(value) {
			if (!isRecord(value)) return null;
			const id = str(value.id);
			const handle = str(value.handle);
			if (id === "" || handle === "") return null;
			const lastSeen = str(value.lastSeen);
			const bindingRaw = isRecord(value.binding) ? value.binding : void 0;
			const binding = bindingRaw !== void 0 && bindingRaw.kind === "dsh-session" && typeof bindingRaw.sessionId === "string" ? {
				kind: "dsh-session",
				sessionId: bindingRaw.sessionId
			} : void 0;
			return {
				id,
				handle,
				displayName: str(value.displayName, handle),
				kind: asKind(value.kind),
				harness: asHarness(value.harness),
				createdAt: str(value.createdAt),
				lastSeen,
				status: asStatus(value.status, lastSeen),
				tokenHash: typeof value.tokenHash === "string" ? value.tokenHash : void 0,
				binding,
				...value.admin === true ? { admin: true } : {},
				...value.muted === true ? { muted: true } : {}
			};
		}
		function stringArray(value) {
			if (!Array.isArray(value)) return [];
			return value.filter((entry) => typeof entry === "string");
		}
		function nullableInt(value) {
			return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : null;
		}
		function normalizeChannel(value) {
			if (!isRecord(value)) return null;
			const id = str(value.id);
			const name = str(value.name);
			if (id === "" || name === "") return null;
			const pins = (Array.isArray(value.pins) ? value.pins : []).filter(isRecord).map((pin) => ({
				messageId: str(pin.messageId),
				by: str(pin.by),
				at: str(pin.at)
			})).filter((pin) => pin.messageId !== "");
			return {
				id,
				name,
				topic: typeof value.topic === "string" ? value.topic : void 0,
				category: typeof value.category === "string" ? value.category : void 0,
				createdAt: str(value.createdAt),
				createdBy: str(value.createdBy),
				pins,
				announcementId: typeof value.announcementId === "string" ? value.announcementId : void 0
			};
		}
		/** GET /channels 的响应 → ChannelView[]（兼容 ChannelMeta[] 与带 unread 的视图）。 */
		function toChannelViews(value) {
			const out = [];
			for (const item of firstArray(value, [
				"channels",
				"items",
				"data"
			])) {
				const channel = normalizeChannel(item);
				if (channel === null) continue;
				const record = isRecord(item) ? item : {};
				const lastSeq = typeof record.lastSeq === "number" && Number.isFinite(record.lastSeq) ? record.lastSeq : void 0;
				const unread = typeof record.unread === "number" && Number.isFinite(record.unread) ? Math.max(0, Math.floor(record.unread)) : void 0;
				out.push({
					...channel,
					lastSeq,
					unread,
					...typeof record.memberCount === "number" ? { memberCount: Math.max(0, Math.floor(record.memberCount)) } : {},
					admins: stringArray(record.admins),
					muted: stringArray(record.muted),
					mutedAll: record.mutedAll === true,
					maxChars: nullableInt(record.maxChars),
					ratePerMinute: nullableInt(record.ratePerMinute),
					canManage: record.canManage === true,
					canAppointAdmins: record.canAppointAdmins === true
				});
			}
			return out;
		}
		/** GET /members 的响应 → Participant[]。 */
		function toMembers(value) {
			return firstArray(value, [
				"participants",
				"members",
				"items",
				"data"
			]).map(normalizeParticipant).filter((participant) => participant !== null);
		}
		function toPins(value) {
			const out = [];
			const messages = /* @__PURE__ */ new Map();
			for (const item of firstArray(value, ["messages"])) {
				const message = normalizeMessage(item);
				if (message !== null) messages.set(message.id, message);
			}
			const entries = firstArray(value, ["pins"]);
			for (const entry of entries) {
				if (!isRecord(entry)) continue;
				const ownMessage = normalizeMessage(entry);
				const messageId = str(entry.messageId) || ownMessage?.id || "";
				if (messageId === "") continue;
				const message = messages.get(messageId) ?? ownMessage ?? void 0;
				out.push({
					messageId,
					by: str(entry.by) || message?.author.participantId || "",
					at: str(entry.at) || message?.ts || "",
					message
				});
			}
			if (out.length > 0) return out;
			for (const item of firstArray(value, [
				"messages",
				"items",
				"data"
			])) {
				const message = normalizeMessage(isRecord(item) && item.message !== void 0 ? item.message : item);
				if (message === null) continue;
				out.push({
					messageId: message.id,
					by: message.author.participantId,
					at: message.ts,
					message
				});
			}
			return out;
		}
		/** GET /history 的响应 → HistoryResponse（按 seq 升序）。 */
		function toHistory(value, fallbackChannel) {
			const messages = firstArray(value, [
				"messages",
				"items",
				"data"
			]).map(normalizeMessage).filter((message) => message !== null).sort((a, b) => a.seq - b.seq);
			return {
				channel: isRecord(value) && typeof value.channel === "string" ? value.channel : fallbackChannel,
				messages,
				hasMore: isRecord(value) ? bool(value.hasMore) : false
			};
		}
		/** /send 的响应 → ChannelMessage（兼容 {message} 与裸消息）。 */
		function toMessage(value) {
			if (isRecord(value) && value.message !== void 0) return normalizeMessage(value.message);
			return normalizeMessage(value);
		}
		/** /register 的响应 → RegisterResponse。 */
		function toRegister(value) {
			if (!isRecord(value)) return null;
			const participantId = str(value.participantId);
			const handle = str(value.handle);
			const token = str(value.token);
			if (participantId === "" || handle === "" || token === "") return null;
			return {
				participantId,
				handle,
				token
			};
		}
		function toWhoAmI(value) {
			if (isRecord(value) && "participant" in value) return { participant: value.participant === null ? null : normalizeParticipant(value.participant) };
			return { participant: normalizeParticipant(value) };
		}
		/**
		* 解析一帧 SSE data（可能是 `{type:'message', message}`，也可能按 SPEC
		* 直接是 `ChannelMessage` / `ChannelMeta` / `Participant`）。
		* @param data - EventSource 的 data 字符串。
		* @returns 归一化后的帧；无法识别时 null。
		*/
		function parseStreamFrame(data) {
			let value;
			try {
				value = JSON.parse(data);
			} catch {
				return null;
			}
			if (!isRecord(value)) return null;
			const type = str(value.type);
			if (type === "hello") {
				const payload = isRecord(value.payload) ? value.payload : void 0;
				return {
					kind: "hello",
					channels: toChannelViews(value.channels ?? payload?.channels),
					participant: normalizeParticipant(value.participant ?? payload?.participant)
				};
			}
			if (type === "message") {
				const message = normalizeMessage(value.message ?? (isRecord(value.payload) ? value.payload : value));
				return message === null ? null : {
					kind: "message",
					message
				};
			}
			if (type === "channel") {
				const channel = normalizeChannel(value.channel ?? value);
				return channel === null ? null : {
					kind: "channel",
					channel
				};
			}
			if (type === "presence") {
				const participant = normalizeParticipant(value.participant ?? value);
				return participant === null ? null : {
					kind: "presence",
					participant
				};
			}
			if (type === "policy") {
				const channel = str(value.channel);
				if (channel === "") return null;
				return {
					kind: "policy",
					policy: {
						channel,
						admins: stringArray(value.admins),
						muted: stringArray(value.muted),
						mutedAll: value.mutedAll === true,
						maxChars: nullableInt(value.maxChars),
						ratePerMinute: nullableInt(value.ratePerMinute)
					}
				};
			}
			if (value.message !== void 0) {
				const message = normalizeMessage(value.message);
				return message === null ? null : {
					kind: "message",
					message
				};
			}
			if (value.channel !== void 0 && typeof value.seq === "number" && typeof value.text === "string") {
				const message = normalizeMessage(value);
				return message === null ? null : {
					kind: "message",
					message
				};
			}
			if (value.announcementId !== void 0 || value.pins !== void 0) {
				const channel = normalizeChannel(value);
				return channel === null ? null : {
					kind: "channel",
					channel
				};
			}
			if (value.participantId !== void 0 || value.status !== void 0) {
				const participant = normalizeParticipant(value);
				return participant === null ? null : {
					kind: "presence",
					participant
				};
			}
			return null;
		}
		function failure(status, code, message) {
			return {
				ok: false,
				status,
				code,
				message
			};
		}
		function errorBodyToFailure(body, status) {
			if (isRecord(body) && isRecord(body.error)) return failure(status, str(body.error.code, "http_error"), str(body.error.message, `HTTP ${status}`));
			if (typeof body === "string" && body.trim() !== "") return failure(status, "http_error", body.trim());
			return failure(status, "http_error", `HTTP ${status}`);
		}
		/** 同源 fetch，统一错误形状：非 2xx → `{ error: { code, message } }`。 */
		async function apiFetch(path, init = {}) {
			let response;
			const isRaw = init.rawBody !== void 0;
			try {
				const headers = { ...init.headers ?? {} };
				if (isRaw) {
					if (init.contentType !== void 0 && init.contentType !== "") headers["content-type"] = init.contentType;
				} else if (init.body !== void 0) headers["content-type"] = "application/json";
				if (init.token !== void 0 && init.token !== "") headers.authorization = `Bearer ${init.token}`;
				response = await fetch(`${API_BASE}${path}`, {
					method: init.method ?? "GET",
					headers,
					body: isRaw ? init.rawBody : init.body === void 0 ? void 0 : JSON.stringify(init.body),
					signal: init.signal,
					credentials: "same-origin",
					cache: "no-store"
				});
			} catch (error) {
				return failure(0, "network_error", error instanceof Error ? error.message : "网络请求失败");
			}
			let text = "";
			try {
				text = await response.text();
			} catch {
				text = "";
			}
			let parsed;
			if (text !== "") try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
			if (!response.ok) return errorBodyToFailure(parsed, response.status);
			return {
				ok: true,
				value: parsed
			};
		}
		async function fetchChannels(token) {
			const result = await apiFetch("/channels", { token });
			return result.ok ? {
				ok: true,
				value: toChannelViews(result.value)
			} : result;
		}
		async function fetchHistory(query, token) {
			const params = new URLSearchParams({ channel: query.channel });
			if (query.beforeSeq !== void 0) params.set("beforeSeq", String(query.beforeSeq));
			if (query.afterSeq !== void 0) params.set("afterSeq", String(query.afterSeq));
			if (query.limit !== void 0) params.set("limit", String(query.limit));
			const result = await apiFetch(`/history?${params.toString()}`, { token });
			return result.ok ? {
				ok: true,
				value: toHistory(result.value, query.channel)
			} : result;
		}
		async function fetchMembers(channel, token) {
			const result = await apiFetch(`/members?${new URLSearchParams({ channel }).toString()}`, { token });
			return result.ok ? {
				ok: true,
				value: toMembers(result.value)
			} : result;
		}
		function toChannelFromResponse(value) {
			return toChannelViews([isRecord(value) && value.channel !== void 0 ? value.channel : value])[0] ?? null;
		}
		/** POST /channel-admins (human operator only). */
		async function setChannelAdmin(channel, handle, admin, token) {
			const result = await apiFetch("/channel-admins", {
				method: "POST",
				token,
				body: {
					channel,
					handle,
					admin
				}
			});
			if (!result.ok) return result;
			const view = toChannelFromResponse(result.value);
			return view === null ? failure(200, "bad_response", "响应缺少频道信息") : {
				ok: true,
				value: view
			};
		}
		/** POST /channel-mute (human operator or channel admin). */
		async function setChannelMute(channel, input, token) {
			const result = await apiFetch("/channel-mute", {
				method: "POST",
				token,
				body: {
					channel,
					...input
				}
			});
			if (!result.ok) return result;
			const view = toChannelFromResponse(result.value);
			return view === null ? failure(200, "bad_response", "响应缺少频道信息") : {
				ok: true,
				value: view
			};
		}
		/** POST /channel-limits (human operator or channel admin); null resets a field. */
		async function setChannelLimits(channel, input, token) {
			const result = await apiFetch("/channel-limits", {
				method: "POST",
				token,
				body: {
					channel,
					...input
				}
			});
			if (!result.ok) return result;
			const view = toChannelFromResponse(result.value);
			return view === null ? failure(200, "bad_response", "响应缺少频道信息") : {
				ok: true,
				value: view
			};
		}
		async function fetchPins(channel, token) {
			const result = await apiFetch(`/pins?${new URLSearchParams({ channel }).toString()}`, { token });
			return result.ok ? {
				ok: true,
				value: toPins(result.value)
			} : result;
		}
		async function fetchWhoAmI(token) {
			const result = await apiFetch("/whoami", { token });
			return result.ok ? {
				ok: true,
				value: toWhoAmI(result.value)
			} : result;
		}
		/** POST /register；带 token 时等于「用现有身份认领新 handle」。 */
		async function registerHuman(token, handle) {
			const body = { kind: "human" };
			if (handle !== void 0 && handle !== "") body.handle = handle;
			if (token !== void 0 && token !== "") body.token = token;
			const result = await apiFetch("/register", {
				method: "POST",
				body,
				token
			});
			if (!result.ok) return result;
			const parsed = toRegister(result.value);
			if (parsed === null) return failure(200, "bad_response", "注册响应缺少 participantId/handle/token");
			return {
				ok: true,
				value: parsed
			};
		}
		/** POST /claim（不带 sessionId）：把 handle 认领给当前已认证的参与者（浏览器的「改名」）。 */
		async function claimHandle(handle, token) {
			const result = await apiFetch("/claim", {
				method: "POST",
				body: { handle },
				token
			});
			if (!result.ok) return result;
			const participant = normalizeParticipant(isRecord(result.value) ? result.value.participant ?? result.value : result.value);
			if (participant === null) return failure(200, "bad_response", "认领响应缺少 participant");
			return {
				ok: true,
				value: {
					participantId: participant.id,
					handle: participant.handle
				}
			};
		}
		function prefsRecord(value) {
			if (!isRecord(value)) return null;
			if (isRecord(value.prefs)) return value.prefs;
			return value;
		}
		/**
		* GET /session-prefs 的响应 → 完整偏好（缺省按 false）。
		* @param value - 服务端响应（{sessionId,prefs} 或裸 prefs）。
		* @returns 完整偏好；形状不认识时 null。
		*/
		function toSessionPrefs(value) {
			const raw = prefsRecord(value);
			if (raw === null) return null;
			if (!(isRecord(value) && isRecord(value.prefs)) && typeof raw.hidden !== "boolean" && typeof raw.muted !== "boolean") return null;
			return {
				hidden: raw.hidden === true,
				muted: raw.muted === true
			};
		}
		/**
		* POST /session-prefs 的响应 → 只包含显式出现的字段（用于合并进缓存，
		* 避免服务端返回部分字段时把另一个开关重置成 false）。
		*/
		function toSessionPrefsPatch(value) {
			const raw = prefsRecord(value);
			if (raw === null) return null;
			const patch = {};
			if (typeof raw.hidden === "boolean") patch.hidden = raw.hidden;
			if (typeof raw.muted === "boolean") patch.muted = raw.muted;
			return patch;
		}
		/** GET /session-prefs?sessionId=（loopback 同源读信任，可不带 token）。 */
		async function fetchSessionPrefs(sessionId, token) {
			if (sessionId === "") return failure(400, "invalid_request", "sessionId 不能为空");
			const result = await apiFetch(`/session-prefs?${new URLSearchParams({ sessionId }).toString()}`, { token });
			if (!result.ok) return result;
			const prefs = toSessionPrefs(result.value);
			if (prefs === null) return failure(200, "bad_response", "session-prefs 响应缺少 prefs");
			return {
				ok: true,
				value: prefs
			};
		}
		/** POST /session-prefs {sessionId, hidden?, muted?}（需要 Bearer 身份）。 */
		async function updateSessionPrefs(update, token) {
			if (update.sessionId === "") return failure(400, "invalid_request", "sessionId 不能为空");
			const body = { sessionId: update.sessionId };
			if (update.hidden !== void 0) body.hidden = update.hidden;
			if (update.muted !== void 0) body.muted = update.muted;
			const result = await apiFetch("/session-prefs", {
				method: "POST",
				body,
				token
			});
			if (!result.ok) return result;
			const patch = toSessionPrefsPatch(result.value);
			if (patch === null) return failure(200, "bad_response", "session-prefs 响应缺少 prefs");
			return {
				ok: true,
				value: patch
			};
		}
		/**
		* 复用 localStorage 里的浏览器身份；没有就注册一个 kind:'human'。
		* 供不经过面板的入口（会话菜单）使用。
		*/
		async function ensureIdentity() {
			const cached = readIdentity();
			if (cached !== null) return {
				ok: true,
				value: cached
			};
			const registered = await registerHuman();
			if (!registered.ok) return registered;
			writeIdentity(registered.value);
			return {
				ok: true,
				value: registered.value
			};
		}
		async function heartbeat(token) {
			return apiFetch("/heartbeat", {
				method: "POST",
				body: {},
				token
			});
		}
		async function createChannel(input, token) {
			const body = {
				id: input.id,
				name: input.name
			};
			if (input.topic !== void 0 && input.topic !== "") body.topic = input.topic;
			if (input.category !== void 0 && input.category !== "") body.category = input.category;
			const result = await apiFetch("/channels", {
				method: "POST",
				body,
				token
			});
			return result.ok ? {
				ok: true,
				value: normalizeChannel(isRecord(result.value) ? result.value.channel ?? result.value : result.value)
			} : result;
		}
		async function sendMessage(input, token) {
			const body = {
				channel: input.channel,
				text: input.text,
				clientMsgId: input.clientMsgId
			};
			if (input.replyTo !== void 0 && input.replyTo !== "") body.replyTo = input.replyTo;
			if (input.mentions !== void 0 && input.mentions.length > 0) body.mentions = [...input.mentions];
			if (input.attachments !== void 0 && input.attachments.length > 0) body.attachments = [...input.attachments];
			const result = await apiFetch("/send", {
				method: "POST",
				body,
				token
			});
			if (!result.ok) return result;
			const message = toMessage(result.value);
			if (message === null) return failure(200, "bad_response", "发送响应缺少 message");
			return {
				ok: true,
				value: message
			};
		}
		async function pinMessage(channel, messageId, token) {
			return apiFetch("/pin", {
				method: "POST",
				body: {
					channel,
					messageId
				},
				token
			});
		}
		async function unpinMessage(channel, messageId, token) {
			return apiFetch("/unpin", {
				method: "POST",
				body: {
					channel,
					messageId
				},
				token
			});
		}
		/**
		* 上传一个附件原始字节。
		* @param input - 文件、文件名、mime。
		* @param token - 身份 bearer token（host 要求 /upload 必须带身份）。
		* @returns 服务端登记后的 Attachment。
		*/
		async function uploadAttachment(input, token) {
			const params = new URLSearchParams({ name: input.name });
			if (input.mime !== "") params.set("mime", input.mime);
			const result = await apiFetch(`/upload?${params.toString()}`, {
				method: "POST",
				rawBody: input.file,
				contentType: input.mime !== "" ? input.mime : "application/octet-stream",
				token,
				...input.signal !== void 0 ? { signal: input.signal } : {}
			});
			if (!result.ok) return result;
			const attachment = normalizeAttachment(isRecord(result.value) && result.value.attachment !== void 0 ? result.value.attachment : result.value);
			if (attachment === null) return failure(200, "bad_response", "上传响应缺少 attachment.id/url");
			return {
				ok: true,
				value: attachment
			};
		}
		/** GET /search 的响应 → SearchResponse（容忍裸数组与 {hits} 包装）。 */
		function toSearchResponse(value, query) {
			const hits = [];
			for (const item of firstArray(value, [
				"hits",
				"results",
				"items",
				"data"
			])) {
				if (!isRecord(item)) continue;
				const message = normalizeMessage((isRecord(item.message) ? item.message : void 0) ?? item);
				if (message === null) continue;
				const channel = str(item.channel) || message.channel;
				const snippet = str(item.snippet) || message.text;
				hits.push({
					channel,
					message,
					snippet
				});
			}
			return {
				query,
				hits,
				hasMore: isRecord(value) ? bool(value.hasMore) : false
			};
		}
		async function searchMessages(query, token) {
			const text = query.q.trim();
			if (text === "") return failure(400, "invalid_query", "检索词不能为空");
			const params = new URLSearchParams({ q: text });
			if (query.channel !== void 0 && query.channel !== "") params.set("channel", query.channel);
			params.set("limit", String(query.limit ?? 50));
			if (query.beforeSeq !== void 0) params.set("beforeSeq", String(query.beforeSeq));
			const result = await apiFetch(`/search?${params.toString()}`, { token });
			return result.ok ? {
				ok: true,
				value: toSearchResponse(result.value, text)
			} : result;
		}
		/** EventSource 无法带 Authorization 头，所以身份走 query（SPEC §5）。 */
		function streamUrl(identity, afterSeq, channel) {
			const params = new URLSearchParams({
				participant: identity.participantId,
				token: identity.token
			});
			if (afterSeq > 0) params.set("afterSeq", String(afterSeq));
			if (channel !== "") params.set("channel", channel);
			return `${API_BASE}/stream?${params.toString()}`;
		}
		/** 从 `${channel}-000123` 解析 seq；channel 本身可能带短横线。 */
		function seqFromMessageId(channel, id) {
			const prefix = `${channel}-`;
			if (!id.startsWith(prefix)) return null;
			const suffix = id.slice(prefix.length);
			if (!/^\d+$/.test(suffix)) return null;
			const seq = Number.parseInt(suffix, 10);
			return Number.isFinite(seq) && seq > 0 ? seq : null;
		}
		function readIdentity() {
			if (typeof window === "undefined") return null;
			try {
				const raw = window.localStorage.getItem(IDENTITY_KEY);
				if (raw === null || raw === "") return null;
				const parsed = JSON.parse(raw);
				if (!isRecord(parsed)) return null;
				const participantId = str(parsed.participantId);
				const handle = str(parsed.handle);
				const token = str(parsed.token);
				if (participantId === "" || handle === "" || token === "") return null;
				return {
					participantId,
					handle,
					token
				};
			} catch {
				return null;
			}
		}
		function writeIdentity(identity) {
			if (typeof window === "undefined") return;
			try {
				window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({
					participantId: identity.participantId,
					handle: identity.handle,
					token: identity.token
				}));
			} catch {}
		}
		function clearIdentity() {
			if (typeof window === "undefined") return;
			try {
				window.localStorage.removeItem(IDENTITY_KEY);
			} catch {}
		}
		/** 幂等键：crypto.randomUUID 优先，退化到时间戳 + 随机串。 */
		function newClientMsgId() {
			if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}
		// src/client/panel.tsx
		/**
		* dsh-channels —— Web 面板（Discord 式三栏）。
		*
		* 纯文本渲染、只用 React + fetch/EventSource，样式见 `./styles.ts`。
		* 所有网络调用都走 `./api.ts`，失败只显示内联错误，不允许把面板打崩；
		* host 没起来时降级成「离线 + 重试」状态。
		*/
		/** 每次翻页条数（GET /history 的 limit）。 */
		const HISTORY_PAGE = 50;
		/** 距离底部多少像素算「贴在底部」。 */
		const NEAR_BOTTOM_PX = 64;
		/** 连续同一作者多久内合并成一组（ms）。 */
		const GROUP_WINDOW_MS = 3e5;
		/** 单频道内存里最多保留多少条消息（更早的靠 beforeSeq 再取）。 */
		const MAX_MESSAGES = 1200;
		/** 跳转后高亮持续多久（task-7：2s）。 */
		const HIGHLIGHT_MS = 2e3;
		/** 搜索框输入去抖（ms）；Enter 立即查。 */
		const SEARCH_DEBOUNCE_MS = 320;
		/** 单次粘贴/拖拽的并发上传上限（与契约数量上限一致，避免打爆浏览器连接数）。 */
		const UPLOAD_CONCURRENCY = 4;
		function emptyStore() {
			return {
				messages: [],
				hasMore: false,
				loaded: false,
				loading: false,
				loadingOlder: false,
				error: null
			};
		}
		const EMPTY_MESSAGES = [];
		function cx(...parts) {
			return parts.filter((part) => typeof part === "string" && part !== "").join(" ");
		}
		function toDate(ts) {
			const date = new Date(ts);
			return Number.isNaN(date.getTime()) ? null : date;
		}
		function formatClock(ts) {
			const date = toDate(ts);
			return date === null ? "" : date.toLocaleTimeString(void 0, {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		function formatFull(ts) {
			const date = toDate(ts);
			return date === null ? "" : date.toLocaleString();
		}
		function dayKey(ts) {
			const date = toDate(ts);
			return date === null ? "" : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
		}
		function dayLabel(ts) {
			const date = toDate(ts);
			if (date === null) return "";
			const now = /* @__PURE__ */ new Date();
			const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
			const days = Math.round((startOfToday - startOfDay) / 864e5);
			if (days === 0) return "今天";
			if (days === 1) return "昨天";
			return date.toLocaleDateString(void 0, {
				year: "numeric",
				month: "long",
				day: "numeric"
			});
		}
		const KIND_LABEL = {
			human: "人类",
			"dsh-agent": "DSH",
			external: "外部"
		};
		const STATUS_LABEL = {
			online: "在线",
			idle: "空闲",
			offline: "离线"
		};
		function kindLabel(kind) {
			return KIND_LABEL[kind];
		}
		function statusLabel(status) {
			return STATUS_LABEL[status];
		}
		/** Short relative age for quiet members ("5 分钟前", "6 小时前"). */
		function relativeAge(iso) {
			const t = Date.parse(iso);
			if (!Number.isFinite(t)) return "";
			const minutes = Math.max(0, Math.round((Date.now() - t) / 6e4));
			if (minutes < 1) return "刚刚";
			if (minutes < 60) return `${minutes} 分钟前`;
			const hours = Math.round(minutes / 60);
			if (hours < 24) return `${hours} 小时前`;
			return `${Math.round(hours / 24)} 天前`;
		}
		function kindClass(kind) {
			return kind === "human" ? "is-human" : kind === "dsh-agent" ? "is-dsh-agent" : "is-external";
		}
		function authorInitial(author) {
			const first = (author.displayName !== "" ? author.displayName : author.handle).trim().charAt(0);
			return first === "" ? "?" : first.toUpperCase();
		}
		function mergeMessages(existing, incoming) {
			const byId = /* @__PURE__ */ new Map();
			for (const message of existing) byId.set(message.id, message);
			for (const message of incoming) byId.set(message.id, message);
			const merged = [...byId.values()].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));
			if (merged.length > MAX_MESSAGES) merged.splice(0, merged.length - MAX_MESSAGES);
			return merged;
		}
		function groupChannels(channels) {
			const groups = /* @__PURE__ */ new Map();
			for (const channel of channels) {
				const category = channel.category !== void 0 && channel.category.trim() !== "" ? channel.category.trim() : "未分类";
				const bucket = groups.get(category);
				if (bucket === void 0) groups.set(category, [channel]);
				else bucket.push(channel);
			}
			return [...groups.entries()].sort(([a], [b]) => (a === "未分类" ? 1 : 0) - (b === "未分类" ? 1 : 0) || a.localeCompare(b)).map(([category, items]) => ({
				category,
				channels: [...items].sort((a, b) => a.name.localeCompare(b.name))
			}));
		}
		/** 纯文本 + @提及高亮（不解释任何 HTML）。 */
		function RichText({ text, mentions }) {
			const handles = mentions.length > 0 ? mentions : parseMentions(text);
			if (handles.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			const wanted = new Set(handles.map((handle) => handle.toLowerCase()));
			const parts = [];
			const pattern = /@([a-z0-9_-]{2,24})/gi;
			let consumed = 0;
			let match;
			while ((match = pattern.exec(text)) !== null) {
				const handle = (match[1] ?? "").toLowerCase();
				if (!wanted.has(handle)) continue;
				if (match.index > consumed) parts.push(text.slice(consumed, match.index));
				parts.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dshch-mention",
					children: match[0]
				}, `${match.index}:${handle}`));
				consumed = match.index + match[0].length;
			}
			if (consumed < text.length) parts.push(text.slice(consumed));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: parts });
		}
		/**
		* 一条消息里的附件：图片内联缩略（点击放大），其它文件显示名/大小/下载。
		* 纯 DOM 渲染，不拼接 HTML；非图片 mime 一律走下载链接（SPEC §7.5）。
		*/
		function AttachmentList({ attachments, onOpenImage }) {
			if (attachments.length === 0) return null;
			const images = attachments.filter((attachment) => isInlineImageMime(attachment.mime));
			const files = attachments.filter((attachment) => !isInlineImageMime(attachment.mime));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-attachments",
				children: [images.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dshch-att-images",
					children: images.map((attachment) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshch-att-image-btn",
						title: `${attachment.name} · ${humanSize(attachment.size)}（点击放大）`,
						"aria-label": `查看图片 ${attachment.name}`,
						onClick: () => onOpenImage(attachment),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: "dshch-att-image",
							src: attachment.url,
							alt: attachment.name,
							loading: "lazy"
						})
					}, attachment.id))
				}), files.map((attachment) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-att-file",
					title: `${attachment.name} · ${attachment.mime}`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-att-file-icon",
							"aria-hidden": "true",
							children: "📄"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-att-file-name",
							children: attachment.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-att-size",
							children: humanSize(attachment.size)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: "dshch-att-dl",
							href: attachment.url,
							download: attachment.name,
							target: "_blank",
							rel: "noreferrer",
							children: "下载"
						})
					]
				}, attachment.id))]
			});
		}
		function DraftChips({ drafts, disabled, onRemove, onRetry }) {
			if (drafts.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dshch-chips",
				"aria-label": "待发送附件",
				children: drafts.map((draft) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: cx("dshch-chip", draft.status === "uploading" && "is-uploading", draft.status === "failed" && "is-failed"),
					title: draft.error !== void 0 && draft.error !== "" ? draft.error : `${draft.name} · ${humanSize(draft.size)}`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-chip-icon",
							"aria-hidden": "true",
							children: isInlineImageMime(draft.mime) ? "🖼" : "📄"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-chip-name",
							children: draft.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-chip-size",
							children: humanSize(draft.size)
						}),
						draft.status === "uploading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshch-chip-state",
							children: "上传中…"
						}),
						draft.status === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-chip-retry",
							onClick: () => onRetry(draft.key),
							disabled,
							children: "重试"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-chip-x",
							title: "移除附件",
							"aria-label": `移除 ${draft.name}`,
							onClick: () => onRemove(draft.key),
							children: "✕"
						})
					]
				}, draft.key))
			});
		}
		function Lightbox({ attachment, onClose }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-lightbox",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": `图片预览：${attachment.name}`,
				onClick: onClose,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-lightbox-bar",
						onClick: (event) => event.stopPropagation(),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-lightbox-name",
								children: attachment.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-att-size",
								children: humanSize(attachment.size)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "dshch-link-btn",
								href: attachment.url,
								target: "_blank",
								rel: "noreferrer",
								children: "新窗口打开"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshch-icon-btn",
								title: "关闭（Esc）",
								"aria-label": "关闭图片预览",
								onClick: onClose,
								children: "✕"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
						className: "dshch-lightbox-img",
						src: attachment.url,
						alt: attachment.name,
						onClick: (event) => event.stopPropagation()
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-lightbox-hint",
						children: "点击空白处或按 Esc 关闭"
					})
				]
			});
		}
		/** 把查询词按空白切分成词（去重、忽略大小写），供高亮使用。 */
		function searchTerms(query) {
			const out = [];
			for (const raw of query.split(/\s+/)) {
				const term = raw.trim();
				if (term === "") continue;
				if (!out.some((item) => item.toLowerCase() === term.toLowerCase())) out.push(term);
			}
			return out;
		}
		/** 片段里高亮查询词（纯文本分片，不注入 HTML）。 */
		function HighlightedSnippet({ text, query }) {
			const terms = searchTerms(query);
			if (terms.length === 0 || text === "") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			const escaped = [...terms].sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter((term) => term !== "");
			if (escaped.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			const lowered = new Set(terms.map((term) => term.toLowerCase()));
			const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: parts.map((part, index) => lowered.has(part.toLowerCase()) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("mark", {
				className: "dshch-hl",
				children: part
			}, `${index}:${part}`) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: part }, `${index}:${part}`)) });
		}
		function MessageRow(props) {
			const { message } = props;
			const author = message.author;
			const replyTo = message.replyTo;
			const attachments = message.attachments ?? [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx("dshch-msg", kindClass(author.kind), props.grouped && "is-grouped", props.highlighted && "is-highlighted"),
				"data-dshch-msg": message.id,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx("dshch-msg-avatar", kindClass(author.kind), props.grouped && "is-ghost"),
						"aria-hidden": "true",
						children: authorInitial(author)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-msg-body",
						children: [
							!props.grouped && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-msg-head",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-author-name",
										children: author.displayName
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dshch-author-handle",
										children: ["@", author.handle]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-kind-tag",
										children: kindLabel(author.kind)
									}),
									message.kind === "announcement" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-pin-mark",
										children: "📢 公告"
									}),
									props.pinned && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-pin-mark",
										title: "已置顶",
										children: "📌"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", {
										className: "dshch-msg-time",
										dateTime: message.ts,
										title: formatFull(message.ts),
										children: formatClock(message.ts)
									})
								]
							}),
							replyTo !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dshch-reply-quote",
								title: `跳到 @${replyTo.authorName} 的消息`,
								onClick: () => props.onJump(replyTo.id),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-reply-bar",
										"aria-hidden": "true"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-reply-author",
										children: replyTo.authorName
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-reply-text",
										children: excerpt(replyTo.excerpt, 90)
									})
								]
							}),
							message.text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshch-msg-text",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RichText, {
									text: message.text,
									mentions: message.mentions
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AttachmentList, {
								attachments,
								onOpenImage: props.onOpenImage
							})
						]
					}),
					props.canModify && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-msg-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-action-btn",
							title: "回复这条消息",
							onClick: () => props.onReply(message),
							children: "回复"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-action-btn",
							title: props.pinned ? "取消置顶" : "置顶到本频道",
							onClick: () => props.onTogglePin(message),
							children: props.pinned ? "取消置顶" : "置顶"
						})]
					})
				]
			});
		}
		function PendingRow({ pending, onRetry, onOpenImage }) {
			const failed = pending.status === "failed";
			const replyTo = pending.replyTo;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx("dshch-pending", failed && "is-failed"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: cx("dshch-msg-avatar", kindClass(pending.author.kind)),
					"aria-hidden": "true",
					children: authorInitial(pending.author)
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-msg-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshch-msg-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-author-name",
									children: pending.author.displayName
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dshch-author-handle",
									children: ["@", pending.author.handle]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-kind-tag",
									children: "我"
								})
							]
						}),
						replyTo !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshch-reply-quote",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-reply-bar",
									"aria-hidden": "true"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-reply-author",
									children: replyTo.author.handle
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-reply-text",
									children: excerpt(replyTo.text, 90)
								})
							]
						}),
						pending.text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshch-pending-text",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RichText, {
								text: pending.text,
								mentions: pending.mentions
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AttachmentList, {
							attachments: pending.attachments,
							onOpenImage
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshch-pending-note",
							children: failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["发送失败", pending.error !== void 0 && pending.error !== "" ? `：${pending.error}` : ""] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshch-retry",
								onClick: () => onRetry(pending.clientMsgId),
								children: "重试"
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "发送中…" })
						})
					]
				})]
			});
		}
		const Composer = react.forwardRef(function Composer(props, ref) {
			const [draft, setDraft] = react.useState("");
			const [mention, setMention] = react.useState(null);
			const [mentionIndex, setMentionIndex] = react.useState(0);
			const textareaRef = react.useRef(null);
			const fileInputRef = react.useRef(null);
			const bytes = utf8Bytes(draft);
			const overLimit = bytes > props.maxBytes;
			const readyCount = props.drafts.filter((item) => item.status === "ready").length;
			const uploadingCount = props.drafts.filter((item) => item.status === "uploading").length;
			const failedCount = props.drafts.filter((item) => item.status === "failed").length;
			/** 还有附件没上传完/上传失败时不允许发送（失败项需重试或移除）。 */
			const attachmentsBlocking = uploadingCount > 0 || failedCount > 0;
			const canSend = !props.disabled && !overLimit && !attachmentsBlocking && (draft.trim() !== "" || readyCount > 0);
			react.useImperativeHandle(ref, () => ({
				focus() {
					textareaRef.current?.focus();
				},
				insertMention(handle) {
					setDraft((previous) => previous === "" || /\s$/.test(previous) ? `${previous}@${handle} ` : `${previous} @${handle} `);
					setMention(null);
					window.requestAnimationFrame(() => textareaRef.current?.focus());
				}
			}), []);
			react.useLayoutEffect(() => {
				const node = textareaRef.current;
				if (node === null) return;
				node.style.height = "auto";
				node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
			}, [draft]);
			const mentionOptions = react.useMemo(() => {
				if (mention === null) return [];
				const query = mention.query.toLowerCase();
				const options = [];
				if (query === "" || "all".startsWith(query)) options.push({
					handle: "all",
					label: "所有人",
					hint: "@all 会唤醒所有已绑定的 DSH 参与者"
				});
				for (const participant of props.members) {
					if (participant.handle === props.identityHandle) continue;
					const handle = participant.handle.toLowerCase();
					if (query !== "" && !handle.startsWith(query) && !participant.displayName.toLowerCase().includes(query)) continue;
					options.push({
						handle: participant.handle,
						label: participant.displayName,
						hint: `@${participant.handle} · ${kindLabel(participant.kind)}`
					});
					if (options.length >= 9) break;
				}
				return options.slice(0, 9);
			}, [
				mention,
				props.members,
				props.identityHandle
			]);
			const syncMention = (value, caret) => {
				const before = value.slice(0, caret);
				const matched = /(?:^|[\s([{])@([a-z0-9_-]{0,24})$/i.exec(before);
				if (matched === null) {
					if (mention !== null) setMention(null);
					return;
				}
				const query = (matched[1] ?? "").toLowerCase();
				setMention({
					start: caret - query.length - 1,
					query
				});
				setMentionIndex(0);
			};
			const applyMention = (handle) => {
				if (mention === null) return;
				const caret = textareaRef.current?.selectionStart ?? draft.length;
				const start = mention.start;
				const next = `${draft.slice(0, start)}@${handle} ${draft.slice(caret)}`;
				setDraft(next);
				setMention(null);
				window.requestAnimationFrame(() => {
					const again = textareaRef.current;
					if (again === null) return;
					again.focus();
					const position = start + handle.length + 2;
					again.setSelectionRange(position, position);
				});
			};
			/** 把一批 File 交给面板（面板负责数量/大小校验与上传）。 */
			const pickFiles = (files) => {
				if (files.length === 0) return;
				props.onPickFiles(files);
			};
			const openFilePicker = () => {
				const input = fileInputRef.current;
				if (input === null) return;
				input.click();
			};
			const submit = () => {
				if (!canSend) return;
				const text = draft.trim();
				props.onSend(text);
				setDraft("");
				setMention(null);
			};
			const onKeyDown = (event) => {
				if (event.nativeEvent.isComposing) return;
				const option = mentionOptions[mentionIndex];
				if (mention !== null && mentionOptions.length > 0) {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setMentionIndex((index) => (index + 1) % mentionOptions.length);
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
						return;
					}
					if (event.key === "Enter" || event.key === "Tab") {
						event.preventDefault();
						if (option !== void 0) applyMention(option.handle);
						return;
					}
					if (event.key === "Escape") {
						event.preventDefault();
						setMention(null);
						return;
					}
				}
				if (event.key === "Escape" && props.replyTo !== null) {
					event.preventDefault();
					props.onCancelReply();
					return;
				}
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					submit();
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-composer-wrap",
				children: [
					mention !== null && mentionOptions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-mention-menu",
						role: "listbox",
						"aria-label": "提及成员",
						children: mentionOptions.map((option, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "option",
							"aria-selected": index === mentionIndex,
							className: cx("dshch-mention-item", index === mentionIndex && "is-active"),
							onMouseDown: (event) => {
								event.preventDefault();
								applyMention(option.handle);
							},
							onMouseEnter: () => setMentionIndex(index),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-mention-label",
								children: option.label
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshch-mention-handle",
								title: option.hint,
								children: ["@", option.handle]
							})]
						}, option.handle))
					}),
					props.replyTo !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-reply-preview",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-reply-bar",
								"aria-hidden": "true"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshch-reply-preview-main",
								children: [
									"回复 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["@", props.replyTo.author.handle] }),
									"：",
									excerpt(props.replyTo.text, 100)
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshch-icon-btn",
								title: "取消引用",
								onClick: props.onCancelReply,
								children: "✕"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DraftChips, {
						drafts: props.drafts,
						disabled: props.disabled,
						onRemove: props.onRemoveDraft,
						onRetry: props.onRetryDraft
					}),
					props.draftsError !== null && props.draftsError !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-attach-error",
						children: props.draftsError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-composer",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								ref: fileInputRef,
								className: "dshch-file-input",
								type: "file",
								multiple: true,
								tabIndex: -1,
								"aria-hidden": "true",
								onChange: (event) => {
									const input = event.currentTarget;
									const files = Array.from(input.files ?? []);
									input.value = "";
									pickFiles(files);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshch-attach-btn",
								title: `添加附件（最多 10 个 · 单个 ≤ ${humanSize(MAX_ATTACHMENT_BYTES)} · 合计 ≤ ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)}）`,
								"aria-label": "添加附件",
								disabled: props.disabled || props.drafts.length >= 10,
								onClick: openFilePicker,
								children: "📎"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshch-channel-tag",
								"aria-hidden": "true",
								children: ["#", props.channelName]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								ref: textareaRef,
								className: "dshch-textarea",
								rows: 1,
								value: draft,
								disabled: props.disabled,
								placeholder: props.disabled ? props.disabledHint : `发消息到 #${props.channelName}（Enter 发送，Shift+Enter 换行，可粘贴图片）`,
								onPaste: (event) => {
									const files = Array.from(event.clipboardData?.files ?? []);
									if (files.length === 0) return;
									event.preventDefault();
									pickFiles(files);
								},
								onChange: (event) => {
									const value = event.currentTarget.value;
									const caret = event.currentTarget.selectionStart ?? value.length;
									setDraft(value);
									syncMention(value, caret);
								},
								onKeyDown,
								onKeyUp: (event) => {
									if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter" || event.key === "Tab") return;
									const node = event.currentTarget;
									syncMention(node.value, node.selectionStart ?? node.value.length);
								},
								onBlur: () => window.setTimeout(() => setMention(null), 120)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshch-send",
								disabled: !canSend,
								onClick: submit,
								children: uploadingCount > 0 ? "上传中…" : "发送"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-composer-hint",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: attachmentsBlocking ? uploadingCount > 0 ? `附件上传中（${uploadingCount}）…` : `有 ${failedCount} 个附件上传失败，请重试或移除` : "Enter 发送 · Shift+Enter 换行 · @ 提及成员 · 📎 拖拽/粘贴上传" }), bytes > props.maxBytes * .85 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: cx("dshch-counter", overLimit && "is-over"),
							children: [
								bytes,
								"/",
								props.maxBytes,
								" 字节"
							]
						})]
					})
				]
			});
		});
		const STATUS_ORDER = [
			"online",
			"idle",
			"offline"
		];
		function MemberList(props) {
			const groups = react.useMemo(() => {
				const result = [];
				for (const status of STATUS_ORDER) {
					const items = props.members.filter((member) => member.status === status).sort((a, b) => a.handle.localeCompare(b.handle));
					if (items.length > 0) result.push({
						status,
						items
					});
				}
				return result;
			}, [props.members]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				className: "dshch-col-right",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-right-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["成员 · ", props.members.length] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshch-icon-btn",
						title: "刷新成员",
						"aria-label": "刷新成员",
						onClick: props.onRefresh,
						children: props.loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dshch-spinner" }) : "⟳"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-right-scroll",
					children: [props.members.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-empty",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.loading ? "成员加载中…" : "暂无成员" })
					}), groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-member-group",
						children: [
							statusLabel(group.status),
							" — ",
							group.items.length
						]
					}), group.items.map((member) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: cx("dshch-member", member.status === "offline" && "is-offline"),
						title: `@${member.handle} · ${kindLabel(member.kind)}${member.harness !== "other" ? ` · ${member.harness}` : ""}${member.admin === true ? " · 频道管理员" : ""}${member.muted === true ? " · 已禁言" : ""}（点击插入 @提及）`,
						onClick: () => props.onMention(member.handle),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx("dshch-status-dot", `is-${member.status}`),
								"aria-hidden": "true"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshch-member-main",
								children: [
									member.displayName,
									member.handle === props.currentHandle && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-member-handle",
										children: "（我）"
									}),
									member.admin === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-member-badge",
										children: "管理员"
									}),
									member.muted === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-member-badge is-muted",
										children: "禁言"
									})
								]
							}),
							member.status !== "online" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-member-seen",
								children: relativeAge(member.lastSeen)
							}),
							member.harness !== "other" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshch-member-tag",
								children: member.harness
							})
						]
					}, member.id))] }, group.status))]
				})]
			});
		}
		function PinDrawer(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dshch-pins-backdrop",
				onClick: props.onClose,
				"aria-hidden": "true"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-pins-drawer",
				role: "dialog",
				"aria-label": "置顶消息",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-pins-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["📌 置顶消息 · ", props.pins.length] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshch-icon-btn",
						title: "关闭",
						"aria-label": "关闭置顶抽屉",
						onClick: props.onClose,
						children: "✕"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-pins-list",
					children: [
						props.loading && props.pins.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshch-empty",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshch-spinner" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "加载置顶…" })]
						}),
						!props.loading && props.pins.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshch-empty",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-empty-icon",
									children: "📌"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "还没有置顶消息" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "鼠标移到消息上点「置顶」" })
							]
						}),
						props.pins.map((pin) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshch-pin-item",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-pin-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dshch-pin-author",
										children: ["@", pin.message?.author.handle ?? pin.by ?? "未知"]
									}), pin.at !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatFull(pin.at) })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshch-pin-text",
									children: pin.message !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RichText, {
										text: pin.message.text,
										mentions: pin.message.mentions
									}) : "（消息内容未加载）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-pin-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-action-btn",
										onClick: () => props.onJump(pin.messageId),
										children: "跳转"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-action-btn",
										onClick: () => props.onUnpin(pin.messageId),
										children: "取消置顶"
									})]
								})
							]
						}, pin.messageId))
					]
				})]
			})] });
		}
		function CreateChannelForm(props) {
			const [id, setId] = react.useState("");
			const [name, setName] = react.useState("");
			const [category, setCategory] = react.useState("");
			const [localError, setLocalError] = react.useState(null);
			const submit = () => {
				const slug = id.trim().toLowerCase();
				if (!isValidChannelId(slug)) {
					setLocalError("频道 id 需为 1-32 位小写字母/数字/短横线，且以字母或数字开头");
					return;
				}
				setLocalError(null);
				props.onSubmit(slug, name.trim() === "" ? slug : name.trim(), category.trim());
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dshch-left-form",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-row",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "dshch-input",
							value: id,
							placeholder: "频道 id（如 dev-log）",
							"aria-label": "频道 id",
							onChange: (event) => setId(event.currentTarget.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-row",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "dshch-input",
							value: name,
							placeholder: "显示名（默认同 id）",
							"aria-label": "频道显示名",
							onChange: (event) => setName(event.currentTarget.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-row",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "dshch-input",
							value: category,
							placeholder: "分类（可选）",
							"aria-label": "频道分类",
							onChange: (event) => setCategory(event.currentTarget.value)
						})
					}),
					(localError ?? props.error) !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-error",
						children: localError ?? props.error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-form-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-btn",
							onClick: props.onCancel,
							children: "取消"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: "dshch-btn dshch-btn-primary",
							disabled: props.creating || id.trim() === "",
							children: props.creating ? "创建中…" : "创建"
						})]
					})
				]
			});
		}
		function RenameForm(props) {
			const [handle, setHandle] = react.useState(props.currentHandle);
			const [localError, setLocalError] = react.useState(null);
			const submit = () => {
				const normalized = normalizeHandle(handle);
				if (!isValidHandle(normalized)) {
					setLocalError("handle 需为 2-24 位小写字母/数字/下划线/短横线，且不能是保留字");
					return;
				}
				setLocalError(null);
				props.onSubmit(normalized);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dshch-left-form",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-row",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "dshch-input",
							value: handle,
							placeholder: "新 handle，如 alice-01",
							"aria-label": "新 handle",
							onChange: (event) => setHandle(event.currentTarget.value)
						})
					}),
					(localError ?? props.error) !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshch-form-error",
						children: localError ?? props.error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshch-form-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshch-btn",
							onClick: props.onCancel,
							children: "取消"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: "dshch-btn dshch-btn-primary",
							disabled: props.saving,
							children: props.saving ? "保存中…" : "保存"
						})]
					})
				]
			});
		}
		/**
		* 频道管理面板：任命管理员（仅人类）、全员禁言、成员禁言、发言限制。
		* 服务端仍会做权限校验；这里只是操作入口。
		*/
		function ChannelSettingsDialog(props) {
			const [maxChars, setMaxChars] = react.useState(props.channel.maxChars === null || props.channel.maxChars === void 0 ? "" : String(props.channel.maxChars));
			const [ratePerMinute, setRatePerMinute] = react.useState(props.channel.ratePerMinute === null || props.channel.ratePerMinute === void 0 ? "" : String(props.channel.ratePerMinute));
			const [adminCandidate, setAdminCandidate] = react.useState("");
			const [localError, setLocalError] = react.useState(null);
			const admins = props.channel.admins ?? [];
			const muted = props.channel.muted ?? [];
			const agents = props.members.filter((member) => member.kind !== "human");
			const candidates = agents.filter((member) => !admins.includes(member.handle));
			const submitLimits = (event) => {
				event.preventDefault();
				const parse = (raw, min, max, label) => {
					const text = raw.trim();
					if (text === "") return null;
					const parsed = Number(text);
					if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
						setLocalError(`${label}需为 ${min}-${max} 的整数，留空恢复默认`);
						return;
					}
					return parsed;
				};
				const nextMax = parse(maxChars, 1, 8192, "单条字数上限");
				if (nextMax === void 0) return;
				const nextRate = parse(ratePerMinute, 1, 600, "每分钟条数");
				if (nextRate === void 0) return;
				setLocalError(null);
				props.onSaveLimits(nextMax, nextRate);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dshch-settings-backdrop",
				onClick: props.onClose,
				"aria-hidden": "true"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-settings",
				role: "dialog",
				"aria-label": "频道管理",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-settings-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚙ 频道管理 · #", props.channel.name] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshch-icon-btn",
						title: "关闭",
						"aria-label": "关闭频道管理",
						onClick: props.onClose,
						children: "✕"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dshch-settings-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dshch-settings-section",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "管理员" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshch-settings-hint",
									children: "只有人类操作者可以任命/撤销子频道管理员。管理员可以全员禁言、禁言指定成员、设置发言限制。"
								}),
								admins.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshch-settings-empty",
									children: "还没有管理员"
								}) : admins.map((handle) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-settings-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: ["@", handle] }), props.channel.canAppointAdmins === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										disabled: props.busy,
										onClick: () => props.onToggleAdmin(handle, false),
										children: "撤销管理员"
									})]
								}, handle)),
								props.channel.canAppointAdmins === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-settings-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "dshch-settings-select",
										value: adminCandidate,
										"aria-label": "选择频道成员",
										onChange: (event) => setAdminCandidate(event.currentTarget.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "选择频道成员…"
										}), candidates.map((member) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: member.handle,
											children: ["@", member.handle]
										}, member.id))]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-btn dshch-btn-outline",
										disabled: props.busy || adminCandidate === "",
										onClick: () => {
											if (adminCandidate === "") return;
											props.onToggleAdmin(adminCandidate, true);
											setAdminCandidate("");
										},
										children: "设为管理员"
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dshch-settings-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "全员禁言" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-settings-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: cx("dshch-btn", props.channel.mutedAll === true ? "dshch-btn-primary" : "dshch-btn-outline"),
									disabled: props.busy || props.channel.canManage !== true,
									onClick: () => props.onMuteAll(props.channel.mutedAll !== true),
									children: props.channel.mutedAll === true ? "解除全员禁言" : "开启全员禁言"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-settings-hint",
									children: "开启后只有管理员和人类操作者能发言；agent 仍可读历史、仍会被 @ 唤醒。"
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "dshch-settings-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "成员禁言" }), agents.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshch-settings-empty",
								children: "这个频道还没有 agent 成员"
							}) : agents.map((member) => {
								const isMuted = muted.includes(member.handle);
								const isAdmin = admins.includes(member.handle);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-settings-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										"@",
										member.handle,
										isAdmin && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("em", {
											className: "dshch-settings-tag",
											children: "管理员"
										})
									] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										disabled: props.busy || props.channel.canManage !== true,
										onClick: () => props.onMuteMember(member.handle, !isMuted),
										children: isMuted ? "解除禁言" : "禁言"
									})]
								}, member.id);
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: "dshch-settings-section",
							onSubmit: submitLimits,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "发言限制" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-settings-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "dshch-settings-field",
										children: ["单条字数上限", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "dshch-settings-input",
											inputMode: "numeric",
											value: maxChars,
											placeholder: "默认",
											onChange: (event) => setMaxChars(event.currentTarget.value)
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "dshch-settings-field",
										children: ["每分钟条数", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "dshch-settings-input",
											inputMode: "numeric",
											value: ratePerMinute,
											placeholder: "默认",
											onChange: (event) => setRatePerMinute(event.currentTarget.value)
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-settings-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: "dshch-btn dshch-btn-primary",
										disabled: props.busy || props.channel.canManage !== true,
										children: props.busy ? "保存中…" : "保存限制"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										disabled: props.busy || props.channel.canManage !== true,
										onClick: () => {
											setMaxChars("");
											setRatePerMinute("");
											props.onSaveLimits(null, null);
										},
										children: "恢复默认"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshch-settings-hint",
									children: "范围：字数 1-8192，频率 1-600 条/分钟；留空恢复默认。人类操作者不受限制。"
								})
							]
						}),
						(localError ?? props.error) !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshch-form-error",
							children: localError ?? props.error
						})
					]
				})]
			})] });
		}
		/**
		* 频道主面板：注册到 `main` keyed 槽（key = 'dsh-channels'）。
		* 未选中时由 shell 卸载，重新选中会重新连 SSE（history 走缓存，无副作用）。
		*/
		function ChannelsPanel() {
			const [identity, setIdentity] = react.useState(() => readIdentity());
			const [identityState, setIdentityState] = react.useState("loading");
			const [identityError, setIdentityError] = react.useState(null);
			const [channels, setChannels] = react.useState([]);
			const [channelsLoaded, setChannelsLoaded] = react.useState(false);
			const [channelsError, setChannelsError] = react.useState(null);
			const [activeChannel, setActiveChannel] = react.useState(DEFAULT_CHANNEL);
			const [store, setStore] = react.useState({});
			const [members, setMembers] = react.useState([]);
			const [membersLoading, setMembersLoading] = react.useState(false);
			const [pins, setPins] = react.useState([]);
			const [pinsLoading, setPinsLoading] = react.useState(false);
			const [showPins, setShowPins] = react.useState(false);
			const [showMembers, setShowMembers] = react.useState(() => typeof window === "undefined" ? true : window.innerWidth > 900);
			const [connection, setConnection] = react.useState("idle");
			const [offline, setOffline] = react.useState(false);
			const [banner, setBanner] = react.useState(null);
			const [unread, setUnread] = react.useState({});
			const [pending, setPending] = react.useState([]);
			const [replyTo, setReplyTo] = react.useState(null);
			const [highlightId, setHighlightId] = react.useState(null);
			const [newBelow, setNewBelow] = react.useState(0);
			const [announcement, setAnnouncement] = react.useState(null);
			const [createOpen, setCreateOpen] = react.useState(false);
			const [creating, setCreating] = react.useState(false);
			const [createError, setCreateError] = react.useState(null);
			const [renameOpen, setRenameOpen] = react.useState(false);
			const [renaming, setRenaming] = react.useState(false);
			const [renameError, setRenameError] = react.useState(null);
			const [settingsOpen, setSettingsOpen] = react.useState(false);
			const [settingsBusy, setSettingsBusy] = react.useState(false);
			const [settingsError, setSettingsError] = react.useState(null);
			const [drafts, setDrafts] = react.useState([]);
			const [draftsError, setDraftsError] = react.useState(null);
			const [dragging, setDragging] = react.useState(false);
			const [lightbox, setLightbox] = react.useState(null);
			const [searchQuery, setSearchQuery] = react.useState("");
			const [searchScope, setSearchScope] = react.useState("all");
			const [searchOpen, setSearchOpen] = react.useState(false);
			const [searchHits, setSearchHits] = react.useState([]);
			const [searchLoading, setSearchLoading] = react.useState(false);
			const [searchError, setSearchError] = react.useState(null);
			const [searchHasMore, setSearchHasMore] = react.useState(false);
			const identityRef = react.useRef(identity);
			const activeChannelRef = react.useRef(activeChannel);
			const channelsRef = react.useRef(channels);
			const storeRef = react.useRef(store);
			const pendingRef = react.useRef(pending);
			const replyToRef = react.useRef(replyTo);
			const lastSeqRef = react.useRef({});
			/** 本会话里已经读过的频道：本地已知更好，忽略服务器可能滞后的 unread。 */
			const localReadRef = react.useRef(/* @__PURE__ */ new Set());
			const scrollRef = react.useRef(null);
			const composerRef = react.useRef(null);
			const stickRef = react.useRef(true);
			const prevScrollHeightRef = react.useRef(0);
			const prependRef = react.useRef(false);
			const handleFrameRef = react.useRef(() => {});
			const bootstrapRef = react.useRef(() => {});
			const refreshChannelsRef = react.useRef(() => {});
			const loadLatestRef = react.useRef(() => {});
			/** 附件草稿镜像（上传回调里读最新值，不进 effect 依赖）。 */
			const draftsRef = react.useRef([]);
			/** 频道切换代数：切换后丢弃旧频道的上传结果。 */
			const draftGenRef = react.useRef(0);
			/** 拖拽深度（dragenter/dragleave 会因冒泡多次触发，用计数器防抖）。 */
			const dragDepthRef = react.useRef(0);
			/** 检索请求序号：只接受最新一次查询的响应（防竞态）。 */
			const searchSeqRef = react.useRef(0);
			/** 最新一次查询词（结果面板标题用；避免输入框已改而结果还是旧的时错位）。 */
			const searchDoneRef = react.useRef("");
			/** 防止 StrictMode / 并发调用造成重复注册（每次注册都会在 host 建一个新参与者）。 */
			const bootstrapInFlightRef = react.useRef(false);
			react.useEffect(() => {
				identityRef.current = identity;
			}, [identity]);
			react.useEffect(() => {
				channelsRef.current = channels;
			}, [channels]);
			react.useEffect(() => {
				storeRef.current = store;
			}, [store]);
			react.useEffect(() => {
				pendingRef.current = pending;
			}, [pending]);
			react.useEffect(() => {
				replyToRef.current = replyTo;
			}, [replyTo]);
			react.useEffect(() => {
				draftsRef.current = drafts;
			}, [drafts]);
			react.useEffect(() => {
				draftGenRef.current += 1;
				draftsRef.current = [];
				setDrafts([]);
				setDraftsError(null);
				setSettingsOpen(false);
				setSettingsError(null);
			}, [activeChannel]);
			const reportError = react.useCallback((text) => {
				setBanner({
					kind: "error",
					text
				});
			}, []);
			const handleAuthFailure = react.useCallback((status, usedToken) => {
				if (status !== 401) return;
				if (usedToken !== void 0 && usedToken !== identityRef.current?.token) return;
				clearIdentity();
				bootstrapRef.current();
			}, []);
			/** 用 host 的 ChannelView[] 刷新频道列表，并把服务器未读数合并进本地未读。 */
			const applyChannelViews = react.useCallback((views) => {
				setChannels([...views]);
				const active = activeChannelRef.current;
				const readChannels = localReadRef.current;
				setUnread((previous) => {
					let next = null;
					for (const view of views) {
						if (view.id === active || readChannels.has(view.id)) continue;
						const unread = view.unread ?? 0;
						if (unread <= ((next ?? previous)[view.id] ?? 0)) continue;
						if (next === null) next = { ...previous };
						next[view.id] = unread;
					}
					return next ?? previous;
				});
			}, []);
			const updateStore = react.useCallback((updater) => {
				setStore((previous) => {
					const next = updater(previous);
					storeRef.current = next;
					return next;
				});
			}, []);
			const commitPending = react.useCallback((updater) => {
				setPending((previous) => {
					const next = updater(previous);
					pendingRef.current = next;
					return next;
				});
			}, []);
			const mergeInto = react.useCallback((channel, incoming) => {
				if (incoming.length === 0) return;
				updateStore((previous) => {
					const current = previous[channel] ?? emptyStore();
					return {
						...previous,
						[channel]: {
							...current,
							messages: mergeMessages(current.messages, incoming)
						}
					};
				});
			}, [updateStore]);
			const noteSeq = react.useCallback((channel, messages) => {
				let last = lastSeqRef.current[channel] ?? 0;
				for (const message of messages) if (message.seq > last) last = message.seq;
				if (last > 0) lastSeqRef.current[channel] = last;
			}, []);
			const clearUnread = react.useCallback((channel) => {
				localReadRef.current.add(channel);
				setUnread((previous) => {
					if ((previous[channel] ?? 0) === 0) return previous;
					return {
						...previous,
						[channel]: 0
					};
				});
			}, []);
			const upsertMember = react.useCallback((participant) => {
				setMembers((previous) => {
					const index = previous.findIndex((member) => member.id === participant.id);
					if (index < 0) return [...previous, participant];
					const next = [...previous];
					const current = previous[index];
					next[index] = {
						...current,
						...participant,
						admin: participant.admin ?? current.admin,
						muted: participant.muted ?? current.muted
					};
					return next;
				});
			}, []);
			const upsertChannel = react.useCallback((channel) => {
				setChannels((previous) => {
					const index = previous.findIndex((item) => item.id === channel.id);
					if (index < 0) return [...previous, channel];
					const next = [...previous];
					next[index] = channel;
					return next;
				});
			}, []);
			/** 把频道管理 API / SSE 返回的策略合并进频道列表与成员标记。 */
			const applyChannelPolicyView = react.useCallback((view) => {
				setChannels((previous) => previous.map((channel) => channel.id === view.id ? {
					...channel,
					...view
				} : channel));
				if (view.id === activeChannelRef.current) {
					const admins = new Set(view.admins ?? []);
					const muted = new Set(view.muted ?? []);
					setMembers((previous) => previous.map((member) => ({
						...member,
						admin: admins.has(member.handle),
						muted: muted.has(member.handle)
					})));
				}
			}, []);
			const runChannelSettingsAction = react.useCallback(async (action) => {
				setSettingsBusy(true);
				setSettingsError(null);
				const result = await action();
				setSettingsBusy(false);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					setSettingsError(result.message);
					return;
				}
				applyChannelPolicyView(result.value);
			}, [applyChannelPolicyView]);
			const toggleChannelAdmin = react.useCallback((handle, admin) => {
				runChannelSettingsAction(() => setChannelAdmin(activeChannelRef.current, handle, admin, identityRef.current?.token));
			}, [runChannelSettingsAction]);
			const setChannelMutedAll = react.useCallback((muted) => {
				runChannelSettingsAction(() => setChannelMute(activeChannelRef.current, {
					all: true,
					muted
				}, identityRef.current?.token));
			}, [runChannelSettingsAction]);
			const setChannelMemberMuted = react.useCallback((handle, muted) => {
				runChannelSettingsAction(() => setChannelMute(activeChannelRef.current, {
					handle,
					muted
				}, identityRef.current?.token));
			}, [runChannelSettingsAction]);
			const saveChannelLimits = react.useCallback((maxChars, ratePerMinute) => {
				runChannelSettingsAction(() => setChannelLimits(activeChannelRef.current, {
					maxChars,
					ratePerMinute
				}, identityRef.current?.token));
			}, [runChannelSettingsAction]);
			const bootstrapIdentity = react.useCallback(async () => {
				if (bootstrapInFlightRef.current) return;
				bootstrapInFlightRef.current = true;
				try {
					setIdentityState("loading");
					setIdentityError(null);
					const cached = readIdentity();
					if (cached !== null) {
						const check = await fetchWhoAmI(cached.token);
						if (check.ok) {
							if (check.value.participant !== null) {
								setIdentity(cached);
								setIdentityState("ready");
								setOffline(false);
								return;
							}
						} else if (check.status === 401) clearIdentity();
						else if (check.status === 0) {
							setIdentity(cached);
							setIdentityState("ready");
							setOffline(true);
							return;
						}
					}
					const registered = await registerHuman();
					if (!registered.ok) {
						if (registered.status === 0) setOffline(true);
						setIdentityError(registered.message);
						setIdentityState("error");
						return;
					}
					writeIdentity(registered.value);
					setIdentity(registered.value);
					setIdentityState("ready");
					setOffline(false);
				} finally {
					bootstrapInFlightRef.current = false;
				}
			}, []);
			react.useEffect(() => {
				bootstrapRef.current = () => {
					bootstrapIdentity();
				};
			}, [bootstrapIdentity]);
			react.useEffect(() => {
				bootstrapIdentity();
			}, [bootstrapIdentity]);
			const refreshChannels = react.useCallback(async () => {
				const token = identityRef.current?.token;
				const result = await fetchChannels(token);
				setChannelsLoaded(true);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					else handleAuthFailure(result.status, token);
					setChannelsError(result.message);
					return;
				}
				setChannelsError(null);
				setOffline(false);
				applyChannelViews(result.value);
				setActiveChannel((previous) => {
					if (result.value.some((channel) => channel.id === previous)) return previous;
					return result.value[0]?.id ?? previous;
				});
			}, [applyChannelViews, handleAuthFailure]);
			react.useEffect(() => {
				refreshChannelsRef.current = () => {
					refreshChannels();
				};
			}, [refreshChannels]);
			react.useEffect(() => {
				refreshChannels();
			}, [identityState, refreshChannels]);
			const loadLatest = react.useCallback(async (channel) => {
				updateStore((previous) => {
					const current = previous[channel] ?? emptyStore();
					return {
						...previous,
						[channel]: {
							...current,
							loading: true,
							error: null
						}
					};
				});
				const token = identityRef.current?.token;
				const result = await fetchHistory({
					channel,
					limit: HISTORY_PAGE
				}, token);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					else handleAuthFailure(result.status, token);
					updateStore((previous) => {
						const current = previous[channel] ?? emptyStore();
						return {
							...previous,
							[channel]: {
								...current,
								loading: false,
								loaded: true,
								error: result.message,
								hasMore: false
							}
						};
					});
					return;
				}
				const messages = [...result.value.messages].sort((a, b) => a.seq - b.seq);
				noteSeq(channel, messages);
				updateStore((previous) => {
					const current = previous[channel] ?? emptyStore();
					return {
						...previous,
						[channel]: {
							messages: mergeMessages(current.messages, messages),
							hasMore: result.value.hasMore,
							loaded: true,
							loading: false,
							loadingOlder: false,
							error: null
						}
					};
				});
				if (channel === activeChannelRef.current) stickRef.current = true;
			}, [
				handleAuthFailure,
				noteSeq,
				updateStore
			]);
			react.useEffect(() => {
				loadLatestRef.current = (channel) => {
					loadLatest(channel);
				};
			}, [loadLatest]);
			const loadOlder = react.useCallback(async () => {
				const channel = activeChannelRef.current;
				const entry = storeRef.current[channel];
				if (entry === void 0 || !entry.loaded || entry.loadingOlder || !entry.hasMore) return;
				const first = entry.messages[0];
				if (first === void 0) return;
				prevScrollHeightRef.current = scrollRef.current?.scrollHeight ?? 0;
				updateStore((previous) => {
					const current = previous[channel] ?? emptyStore();
					return {
						...previous,
						[channel]: {
							...current,
							loadingOlder: true
						}
					};
				});
				const result = await fetchHistory({
					channel,
					beforeSeq: first.seq,
					limit: HISTORY_PAGE
				}, identityRef.current?.token);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					updateStore((previous) => {
						const current = previous[channel] ?? emptyStore();
						return {
							...previous,
							[channel]: {
								...current,
								loadingOlder: false
							}
						};
					});
					reportError(`加载更早消息失败：${result.message}`);
					return;
				}
				const older = result.value.messages.filter((message) => message.seq < first.seq);
				noteSeq(channel, older);
				prependRef.current = older.length > 0;
				updateStore((previous) => {
					const current = previous[channel] ?? emptyStore();
					return {
						...previous,
						[channel]: {
							...current,
							messages: mergeMessages(current.messages, older),
							hasMore: result.value.hasMore,
							loadingOlder: false
						}
					};
				});
			}, [
				noteSeq,
				reportError,
				updateStore
			]);
			react.useEffect(() => {
				if (identityState === "loading") return;
				const entry = storeRef.current[activeChannel];
				if (entry !== void 0 && entry.loaded) return;
				loadLatest(activeChannel);
			}, [
				activeChannel,
				identityState,
				loadLatest
			]);
			const refreshMembers = react.useCallback(async () => {
				setMembersLoading(true);
				const result = await fetchMembers(activeChannelRef.current, identityRef.current?.token);
				setMembersLoading(false);
				if (result.ok) setMembers(result.value);
				else if (result.status === 0) setOffline(true);
			}, []);
			react.useEffect(() => {
				if (identityState === "loading") return;
				let cancelled = false;
				const load = async () => {
					setMembersLoading(true);
					const result = await fetchMembers(activeChannel, identityRef.current?.token);
					if (cancelled) return;
					setMembersLoading(false);
					if (result.ok) setMembers(result.value);
					else if (result.status === 0) setOffline(true);
				};
				load();
				const timer = window.setInterval(() => {
					load();
				}, 45e3);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [activeChannel, identityState]);
			react.useEffect(() => {
				if (identityState !== "ready") return;
				const token = identityRef.current?.token;
				if (token === void 0 || token === "") return;
				let cancelled = false;
				const tick = async () => {
					const result = await heartbeat(token);
					if (cancelled) return;
					if (result.ok) {
						setOffline(false);
						return;
					}
					if (result.status === 0) setOffline(true);
					else if (result.status === 401) {
						clearIdentity();
						bootstrapRef.current();
					}
				};
				tick();
				const timer = window.setInterval(() => {
					tick();
				}, 3e4);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [identityState, identity?.token]);
			react.useEffect(() => {
				activeChannelRef.current = activeChannel;
				stickRef.current = true;
				prevScrollHeightRef.current = 0;
				prependRef.current = false;
				setNewBelow(0);
				setReplyTo(null);
				setShowPins(false);
				clearUnread(activeChannel);
				const cached = storeRef.current[activeChannel];
				const lastSeq = lastSeqRef.current[activeChannel] ?? 0;
				if (cached !== void 0 && cached.loaded && lastSeq > 0) fetchHistory({
					channel: activeChannel,
					beforeSeq: lastSeq + 1,
					limit: 1
				}, identityRef.current?.token);
			}, [activeChannel, clearUnread]);
			const activeMeta = channels.find((channel) => channel.id === activeChannel);
			const pinSignature = activeMeta?.pins.map((pin) => pin.messageId).join(",") ?? "";
			react.useEffect(() => {
				if (!showPins || identityState === "loading") return;
				let cancelled = false;
				setPinsLoading(true);
				(async () => {
					const result = await fetchPins(activeChannel, identityRef.current?.token);
					if (cancelled) return;
					setPinsLoading(false);
					if (result.ok) setPins(result.value);
					else if (result.status === 0) setOffline(true);
				})();
				return () => {
					cancelled = true;
				};
			}, [
				showPins,
				activeChannel,
				identityState,
				pinSignature
			]);
			react.useEffect(() => {
				const announcementId = activeMeta?.announcementId;
				if (announcementId === void 0) {
					setAnnouncement(null);
					return;
				}
				if (announcement !== null && announcement.channel === activeChannel && announcement.message.id === announcementId) return;
				const cached = (store[activeChannel]?.messages ?? EMPTY_MESSAGES).find((message) => message.id === announcementId);
				if (cached !== void 0) {
					setAnnouncement({
						channel: activeChannel,
						message: cached
					});
					return;
				}
				const seq = seqFromMessageId(activeChannel, announcementId);
				if (seq === null) {
					setAnnouncement(null);
					return;
				}
				let cancelled = false;
				(async () => {
					const result = await fetchHistory({
						channel: activeChannel,
						afterSeq: seq - 1,
						limit: 1
					}, identityRef.current?.token);
					if (cancelled || !result.ok) return;
					const message = result.value.messages.find((item) => item.id === announcementId) ?? result.value.messages[0];
					if (message !== void 0) setAnnouncement({
						channel: activeChannel,
						message
					});
				})();
				return () => {
					cancelled = true;
				};
			}, [
				activeMeta?.announcementId,
				activeChannel,
				store,
				announcement
			]);
			const handleFrame = react.useCallback((frame) => {
				if (frame.kind === "hello") {
					if (frame.channels.length > 0) applyChannelViews(frame.channels);
					setConnection("open");
					setOffline(false);
					return;
				}
				if (frame.kind === "channel") {
					upsertChannel(frame.channel);
					return;
				}
				if (frame.kind === "presence") {
					upsertMember(frame.participant);
					return;
				}
				if (frame.kind === "policy") {
					const policy = frame.policy;
					setChannels((previous) => previous.map((channel) => channel.id === policy.channel ? {
						...channel,
						admins: policy.admins,
						muted: policy.muted,
						mutedAll: policy.mutedAll,
						maxChars: policy.maxChars,
						ratePerMinute: policy.ratePerMinute
					} : channel));
					if (policy.channel === activeChannelRef.current) {
						const admins = new Set(policy.admins);
						const muted = new Set(policy.muted);
						setMembers((previous) => previous.map((member) => ({
							...member,
							admin: admins.has(member.handle),
							muted: muted.has(member.handle)
						})));
					}
					return;
				}
				const message = frame.message;
				const channel = message.channel;
				const entry = storeRef.current[channel];
				if (entry !== void 0 && entry.loaded) mergeInto(channel, [message]);
				noteSeq(channel, [message]);
				if (channel === activeChannelRef.current) {
					if (message.kind === "announcement") setAnnouncement({
						channel,
						message
					});
					if (!stickRef.current) setNewBelow((count) => count + 1);
				} else setUnread((previous) => ({
					...previous,
					[channel]: (previous[channel] ?? 0) + 1
				}));
			}, [
				applyChannelViews,
				mergeInto,
				noteSeq,
				upsertChannel,
				upsertMember
			]);
			react.useEffect(() => {
				handleFrameRef.current = handleFrame;
			}, [handleFrame]);
			react.useEffect(() => {
				if (identity === null) {
					setConnection("idle");
					return;
				}
				const currentIdentity = identity;
				let disposed = false;
				let source = null;
				let retryTimer;
				let attempt = 0;
				const scheduleReconnect = () => {
					if (disposed) return;
					const delay = Math.min(3e4, 1e3 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 300);
					attempt += 1;
					setConnection("reconnecting");
					retryTimer = window.setTimeout(() => {
						reconnect();
					}, delay);
				};
				const catchUp = async () => {
					refreshChannelsRef.current();
					for (const channel of Object.keys(storeRef.current)) {
						const entry = storeRef.current[channel];
						if (entry === void 0 || !entry.loaded) {
							if (channel === activeChannelRef.current) loadLatestRef.current(channel);
							continue;
						}
						const afterSeq = lastSeqRef.current[channel] ?? 0;
						if (afterSeq <= 0) continue;
						const result = await fetchHistory({
							channel,
							afterSeq,
							limit: 100
						}, currentIdentity.token);
						if (disposed) return;
						if (!result.ok || result.value.messages.length === 0) continue;
						mergeInto(channel, result.value.messages);
						noteSeq(channel, result.value.messages);
					}
				};
				const handleData = (data) => {
					const frame = parseStreamFrame(data);
					if (frame !== null) handleFrameRef.current(frame);
				};
				const reconnect = async () => {
					if (disposed) return;
					const who = await fetchWhoAmI(currentIdentity.token);
					if (disposed) return;
					if (who.ok) {
						setOffline(false);
						connect();
						return;
					}
					if (who.status === 401) {
						clearIdentity();
						setIdentityState("loading");
						bootstrapRef.current();
						return;
					}
					setOffline(true);
					scheduleReconnect();
				};
				const connect = () => {
					if (disposed) return;
					const channel = activeChannelRef.current;
					const afterSeq = lastSeqRef.current[channel] ?? 0;
					setConnection(attempt === 0 ? "connecting" : "reconnecting");
					let nextSource = null;
					try {
						nextSource = new EventSource(streamUrl(currentIdentity, afterSeq, channel));
					} catch (error) {
						reportError(`实时连接创建失败：${error instanceof Error ? error.message : String(error)}`);
						scheduleReconnect();
						return;
					}
					source = nextSource;
					nextSource.onopen = () => {
						if (disposed) return;
						attempt = 0;
						setConnection("open");
						setOffline(false);
						catchUp();
					};
					for (const eventName of [
						"hello",
						"message",
						"channel",
						"presence",
						"policy"
					]) nextSource.addEventListener(eventName, (event) => {
						const data = event.data;
						if (typeof data === "string") handleData(data);
					});
					nextSource.onerror = () => {
						if (disposed) return;
						try {
							nextSource?.close();
						} catch {}
						if (source === nextSource) source = null;
						scheduleReconnect();
					};
				};
				connect();
				return () => {
					disposed = true;
					if (retryTimer !== void 0) window.clearTimeout(retryTimer);
					if (source !== null) {
						try {
							source.close();
						} catch {}
						source = null;
					}
				};
			}, [
				identity,
				mergeInto,
				noteSeq,
				reportError
			]);
			react.useEffect(() => {
				if (banner === null) return;
				const timer = window.setTimeout(() => setBanner(null), 8e3);
				return () => window.clearTimeout(timer);
			}, [banner]);
			react.useLayoutEffect(() => {
				const element = scrollRef.current;
				if (element === null) return;
				if (prependRef.current) {
					prependRef.current = false;
					const delta = element.scrollHeight - prevScrollHeightRef.current;
					if (delta > 0) element.scrollTop += delta;
					return;
				}
				if (stickRef.current) element.scrollTop = element.scrollHeight;
			}, [
				store,
				activeChannel,
				pending
			]);
			const handleScroll = () => {
				const element = scrollRef.current;
				if (element === null) return;
				if (element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX) {
					stickRef.current = true;
					setNewBelow(0);
					clearUnread(activeChannelRef.current);
				} else stickRef.current = false;
				if (element.scrollTop < 48) loadOlder();
			};
			const scrollToBottom = () => {
				const element = scrollRef.current;
				if (element === null) return;
				stickRef.current = true;
				element.scrollTop = element.scrollHeight;
				setNewBelow(0);
				clearUnread(activeChannelRef.current);
			};
			/**
			* 跳转到指定频道的某条消息：必要时先切频道 + 取该 seq 附近历史，
			* 然后滚动到它并高亮 2s（任务 §8 检索跳转 / 引用跳转共用）。
			*/
			const jumpToIn = react.useCallback(async (channel, messageId) => {
				setShowPins(false);
				let target = storeRef.current[channel]?.messages.find((message) => message.id === messageId);
				if (target === void 0) {
					const seq = seqFromMessageId(channel, messageId);
					if (seq === null) {
						reportError("无法定位该消息");
						return;
					}
					const result = await fetchHistory({
						channel,
						beforeSeq: seq + 1,
						limit: HISTORY_PAGE
					}, identityRef.current?.token);
					if (!result.ok) {
						if (result.status === 0) setOffline(true);
						reportError(`定位消息失败：${result.message}`);
						return;
					}
					mergeInto(channel, result.value.messages);
					noteSeq(channel, result.value.messages);
					target = result.value.messages.find((message) => message.id === messageId) ?? result.value.messages[result.value.messages.length - 1];
				}
				if (target === void 0) {
					reportError("该消息不在已加载的历史里");
					return;
				}
				const targetId = target.id;
				const switching = channel !== activeChannelRef.current;
				if (switching) setActiveChannel(channel);
				stickRef.current = false;
				setHighlightId(targetId);
				window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
				window.setTimeout(() => {
					const node = document.querySelector(`[data-dshch-msg="${targetId}"]`);
					if (node instanceof HTMLElement) node.scrollIntoView({
						block: "center",
						behavior: "smooth"
					});
				}, switching ? 120 : 40);
			}, [
				mergeInto,
				noteSeq,
				reportError
			]);
			/** 当前频道内跳转（引用 / 置顶抽屉 / 公告共用）。 */
			const jumpTo = react.useCallback((messageId) => {
				jumpToIn(activeChannelRef.current, messageId);
			}, [jumpToIn]);
			const startReply = (message) => {
				setReplyTo(message);
				composerRef.current?.focus();
			};
			const togglePin = react.useCallback(async (message) => {
				const pinned = channelsRef.current.find((channel) => channel.id === message.channel)?.pins.some((pin) => pin.messageId === message.id) ?? false;
				const token = identityRef.current?.token;
				const result = pinned ? await unpinMessage(message.channel, message.id, token) : await pinMessage(message.channel, message.id, token);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					reportError(`置顶操作失败：${result.message}`);
					return;
				}
				const actor = identityRef.current?.participantId ?? "";
				const at = (/* @__PURE__ */ new Date()).toISOString();
				setChannels((previous) => previous.map((channel) => channel.id !== message.channel ? channel : {
					...channel,
					pins: pinned ? channel.pins.filter((pin) => pin.messageId !== message.id) : [...channel.pins, {
						messageId: message.id,
						by: actor,
						at
					}]
				}));
				setPins((previous) => {
					if (pinned) return previous.filter((pin) => pin.messageId !== message.id);
					if (previous.some((pin) => pin.messageId === message.id)) return previous;
					return [{
						messageId: message.id,
						by: actor,
						at,
						message
					}, ...previous];
				});
			}, [reportError]);
			const unpinById = react.useCallback(async (messageId) => {
				const channel = activeChannelRef.current;
				const result = await unpinMessage(channel, messageId, identityRef.current?.token);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					reportError(`取消置顶失败：${result.message}`);
					return;
				}
				setChannels((previous) => previous.map((item) => item.id !== channel ? item : {
					...item,
					pins: item.pins.filter((pin) => pin.messageId !== messageId)
				}));
				setPins((previous) => previous.filter((pin) => pin.messageId !== messageId));
			}, [reportError]);
			const patchDraft = react.useCallback((key, patch) => {
				setDrafts((previous) => {
					const next = previous.map((item) => item.key === key ? {
						...item,
						...patch
					} : item);
					draftsRef.current = next;
					return next;
				});
			}, []);
			/** 上传一批已登记的草稿（带并发上限；失败逐条标记，可重试）。 */
			const runUploads = react.useCallback(async (entries, generation) => {
				const queue = [...entries];
				const token = identityRef.current?.token;
				const worker = async () => {
					for (;;) {
						const entry = queue.shift();
						if (entry === void 0) return;
						const result = await uploadAttachment({
							file: entry.blob,
							name: entry.name,
							mime: entry.mime
						}, token);
						if (generation !== draftGenRef.current) return;
						if (result.ok) {
							patchDraft(entry.key, {
								status: "ready",
								attachment: result.value,
								error: void 0
							});
							setOffline(false);
							continue;
						}
						if (result.status === 0) setOffline(true);
						else handleAuthFailure(result.status, token);
						patchDraft(entry.key, {
							status: "failed",
							error: result.message
						});
					}
				};
				const workers = Math.min(UPLOAD_CONCURRENCY, entries.length);
				await Promise.all(Array.from({ length: workers }, () => worker()));
			}, [handleAuthFailure, patchDraft]);
			/**
			* 校验并接收用户选择/拖拽/粘贴的文件：
			* 数量 ≤ 10、单个 ≤ 25MB、合计 ≤ 50MB，超限只提示不发送。
			*/
			const addFiles = react.useCallback((files) => {
				const incoming = files.filter((file) => file !== null && typeof file === "object" && typeof file.size === "number");
				if (incoming.length === 0) return;
				if (identityRef.current === null) {
					setDraftsError("身份尚未就绪，无法上传附件；请稍后重试");
					return;
				}
				const existing = draftsRef.current;
				const problems = [];
				const accepted = [];
				let count = existing.length;
				let total = existing.reduce((sum, item) => sum + item.size, 0);
				for (const file of incoming) {
					if (count >= 10) {
						problems.push(`最多 10 个附件`);
						break;
					}
					const size = file.size;
					if (size > 26214400) {
						problems.push(`「${file.name || "文件"}」超过单文件上限 ${humanSize(MAX_ATTACHMENT_BYTES)}`);
						continue;
					}
					if (total + size > 52428800) {
						problems.push(`附件合计超过 ${humanSize(MAX_ATTACHMENT_TOTAL_BYTES)}`);
						break;
					}
					accepted.push(file);
					count += 1;
					total += size;
				}
				setDraftsError(problems.length > 0 ? problems.join("；") : null);
				if (accepted.length === 0) return;
				const generation = draftGenRef.current;
				const stamp = Date.now();
				const entries = accepted.map((file, index) => {
					const named = typeof file.name === "string" && file.name !== "" ? file.name : `粘贴文件-${stamp}-${index + 1}`;
					return {
						key: `draft_${stamp.toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
						blob: file,
						name: named,
						mime: typeof file.type === "string" && file.type !== "" ? file.type : "application/octet-stream",
						size: file.size,
						status: "uploading"
					};
				});
				draftsRef.current = [...draftsRef.current, ...entries];
				setDrafts(draftsRef.current);
				runUploads(entries, generation);
			}, [runUploads]);
			const removeDraft = react.useCallback((key) => {
				draftsRef.current = draftsRef.current.filter((item) => item.key !== key);
				setDrafts(draftsRef.current);
				setDraftsError(null);
			}, []);
			const retryDraft = react.useCallback((key) => {
				const entry = draftsRef.current.find((item) => item.key === key);
				if (entry === void 0) return;
				const generation = draftGenRef.current;
				patchDraft(key, {
					status: "uploading",
					error: void 0
				});
				setDraftsError(null);
				runUploads([{
					...entry,
					status: "uploading"
				}], generation);
			}, [patchDraft, runUploads]);
			const openImage = react.useCallback((attachment) => {
				setLightbox(attachment);
			}, []);
			/** 中心区域拖拽：拖文件进来显示蒙层，落下即走 addFiles。 */
			const dragHasFiles = (event) => {
				const types = event.dataTransfer?.types;
				return types !== void 0 && Array.from(types).includes("Files");
			};
			const onCenterDragEnter = (event) => {
				if (!dragHasFiles(event)) return;
				event.preventDefault();
				dragDepthRef.current += 1;
				setDragging(true);
			};
			const onCenterDragOver = (event) => {
				if (!dragHasFiles(event)) return;
				event.preventDefault();
				if (event.dataTransfer !== void 0) event.dataTransfer.dropEffect = "copy";
			};
			const onCenterDragLeave = (event) => {
				if (!dragHasFiles(event)) return;
				dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
				if (dragDepthRef.current === 0) setDragging(false);
			};
			const onCenterDrop = (event) => {
				if (!dragHasFiles(event)) return;
				event.preventDefault();
				dragDepthRef.current = 0;
				setDragging(false);
				addFiles(Array.from(event.dataTransfer?.files ?? []));
			};
			const closeSearch = react.useCallback(() => {
				searchSeqRef.current += 1;
				setSearchOpen(false);
				setSearchLoading(false);
			}, []);
			const runSearch = react.useCallback(async (rawQuery) => {
				const query = rawQuery.trim();
				if (query === "") {
					closeSearch();
					setSearchHits([]);
					setSearchError(null);
					setSearchHasMore(false);
					return;
				}
				const seq = ++searchSeqRef.current;
				setSearchOpen(true);
				setSearchLoading(true);
				setSearchError(null);
				const result = await searchMessages({
					q: query,
					...searchScope === "channel" ? { channel: activeChannelRef.current } : {},
					limit: 50
				}, identityRef.current?.token);
				if (seq !== searchSeqRef.current) return;
				setSearchLoading(false);
				searchDoneRef.current = query;
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					else handleAuthFailure(result.status, identityRef.current?.token);
					setSearchError(result.message);
					setSearchHits([]);
					setSearchHasMore(false);
					return;
				}
				setSearchHits([...result.value.hits]);
				setSearchHasMore(result.value.hasMore);
			}, [
				closeSearch,
				handleAuthFailure,
				searchScope
			]);
			react.useEffect(() => {
				const query = searchQuery.trim();
				if (query === "") {
					closeSearch();
					setSearchHits([]);
					setSearchError(null);
					setSearchHasMore(false);
					return;
				}
				const timer = window.setTimeout(() => {
					runSearch(query);
				}, SEARCH_DEBOUNCE_MS);
				return () => window.clearTimeout(timer);
			}, [
				searchQuery,
				searchScope,
				runSearch,
				closeSearch
			]);
			/** 点击检索结果：关面板 → 切频道 → 定位并高亮。 */
			const openSearchHit = react.useCallback((hit) => {
				closeSearch();
				jumpToIn(hit.channel, hit.message.id);
			}, [closeSearch, jumpToIn]);
			const rewindSearch = react.useCallback(() => {
				runSearch(searchQuery);
			}, [runSearch, searchQuery]);
			react.useEffect(() => {
				if (lightbox === null && !searchOpen) return;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (lightbox !== null) {
						event.preventDefault();
						setLightbox(null);
						return;
					}
					if (searchOpen) {
						event.preventDefault();
						closeSearch();
					}
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [
				lightbox,
				searchOpen,
				closeSearch
			]);
			const deliver = react.useCallback(async (message) => {
				commitPending((previous) => previous.map((item) => item.clientMsgId === message.clientMsgId ? {
					...item,
					status: "sending",
					error: void 0
				} : item));
				const result = await sendMessage({
					channel: message.channel,
					text: message.text,
					clientMsgId: message.clientMsgId,
					replyTo: message.replyTo?.id,
					mentions: message.mentions,
					...message.attachments.length > 0 ? { attachments: message.attachments.map((item) => item.id) } : {}
				}, identityRef.current?.token);
				if (result.ok) {
					commitPending((previous) => previous.filter((item) => item.clientMsgId !== message.clientMsgId));
					mergeInto(message.channel, [result.value]);
					noteSeq(message.channel, [result.value]);
					setOffline(false);
					if (message.channel === activeChannelRef.current) stickRef.current = true;
					return;
				}
				if (result.status === 0) setOffline(true);
				commitPending((previous) => previous.map((item) => item.clientMsgId === message.clientMsgId ? {
					...item,
					status: "failed",
					error: result.message
				} : item));
			}, [
				commitPending,
				mergeInto,
				noteSeq
			]);
			const handleSend = react.useCallback((text) => {
				if (utf8Bytes(text) > 8192) {
					reportError(`消息超过 ${MAX_TEXT_BYTES} 字节上限`);
					return;
				}
				const current = draftsRef.current;
				const ready = current.filter((item) => item.status === "ready" && item.attachment !== void 0).map((item) => item.attachment);
				if (current.length - ready.length > 0) {
					setDraftsError("还有附件在上传或上传失败：请等待完成，或先重试/移除");
					return;
				}
				if (text.trim() === "" && ready.length === 0) return;
				const channel = activeChannelRef.current;
				const me = identityRef.current;
				const message = {
					clientMsgId: newClientMsgId(),
					channel,
					text,
					replyTo: replyToRef.current ?? void 0,
					mentions: parseMentions(text),
					attachments: ready,
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					status: "sending",
					author: {
						participantId: me?.participantId ?? "",
						handle: me?.handle ?? "me",
						displayName: me?.handle ?? "me",
						kind: "human",
						harness: "other"
					}
				};
				setReplyTo(null);
				replyToRef.current = null;
				draftsRef.current = [];
				setDrafts([]);
				setDraftsError(null);
				stickRef.current = true;
				commitPending((previous) => [...previous, message]);
				deliver(message);
			}, [
				commitPending,
				deliver,
				reportError
			]);
			const retryPending = (clientMsgId) => {
				const message = pendingRef.current.find((item) => item.clientMsgId === clientMsgId);
				if (message !== void 0) deliver(message);
			};
			const submitCreate = react.useCallback(async (id, name, category) => {
				setCreating(true);
				setCreateError(null);
				const result = await createChannel({
					id,
					name,
					category: category === "" ? void 0 : category
				}, identityRef.current?.token);
				setCreating(false);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					setCreateError(result.message);
					return;
				}
				setCreateOpen(false);
				await refreshChannels();
				setActiveChannel(id);
			}, [refreshChannels]);
			const claimHandle$1 = react.useCallback(async (handle) => {
				setRenaming(true);
				setRenameError(null);
				const current = identityRef.current;
				const result = await claimHandle(handle, current?.token);
				setRenaming(false);
				if (!result.ok) {
					if (result.status === 0) setOffline(true);
					else handleAuthFailure(result.status, current?.token);
					return result.message;
				}
				const next = {
					participantId: result.value.participantId,
					handle: result.value.handle,
					token: current?.token ?? ""
				};
				if (next.token !== "") writeIdentity(next);
				setIdentity(next);
				setRenameOpen(false);
				await refreshChannels();
				refreshMembers();
				return null;
			}, [
				handleAuthFailure,
				refreshChannels,
				refreshMembers
			]);
			const mentionFromMember = (handle) => {
				composerRef.current?.insertMention(handle);
			};
			const groupedChannels = react.useMemo(() => groupChannels(channels), [channels]);
			const activeStore = store[activeChannel];
			const messages = activeStore?.messages ?? EMPTY_MESSAGES;
			const pendingForChannel = pending.filter((item) => item.channel === activeChannel);
			const pinnedIds = react.useMemo(() => new Set((activeMeta?.pins ?? []).map((pin) => pin.messageId)), [activeMeta?.pins]);
			const pinCount = activeMeta?.pins.length ?? 0;
			const connClass = offline ? "is-offline" : connection === "open" ? "is-open" : "is-connecting";
			const connLabel = offline ? "离线" : connection === "open" ? "实时" : connection === "reconnecting" ? "重连中" : connection === "idle" ? "未连接" : "连接中";
			const activeName = activeMeta?.name ?? activeChannel;
			const channelNames = react.useMemo(() => {
				const map = /* @__PURE__ */ new Map();
				for (const channel of channels) map.set(channel.id, channel.name);
				return map;
			}, [channels]);
			const channelLabelOf = (id) => channelNames.get(id) ?? id;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshch-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
						className: "dshch-col-left",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-left-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "频道" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dshch-icon-btn",
									title: "新建频道",
									"aria-label": "新建频道",
									onClick: () => {
										setCreateOpen((open) => !open);
										setCreateError(null);
									},
									children: "＋"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-left-scroll",
								children: [
									!channelsLoaded && channels.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshch-empty",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshch-spinner" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "正在加载频道…" })]
									}),
									channelsLoaded && channels.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshch-empty",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-empty-icon",
												children: "#"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: channelsError ?? "还没有任何频道" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-btn dshch-btn-outline",
												onClick: () => setCreateOpen(true),
												children: "创建第一个频道"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-btn",
												onClick: () => void refreshChannels(),
												children: "重试"
											})
										]
									}),
									groupedChannels.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dshch-cat",
										children: group.category
									}), group.channels.map((channel) => {
										const count = unread[channel.id] ?? 0;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: cx("dshch-channel", channel.id === activeChannel && "is-active"),
											title: channel.topic ?? channel.name,
											onClick: () => setActiveChannel(channel.id),
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshch-hash",
													children: "#"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshch-channel-name",
													children: channel.name
												}),
												channel.mutedAll === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshch-channel-mute",
													title: "全员禁言中",
													"aria-label": "全员禁言中",
													children: "🔇"
												}),
												count > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshch-badge",
													children: count > 99 ? "99+" : count
												})
											]
										}, channel.id);
									})] }, group.category))
								]
							}),
							createOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreateChannelForm, {
								creating,
								error: createError,
								onCancel: () => {
									setCreateOpen(false);
									setCreateError(null);
								},
								onSubmit: (id, name, category) => {
									submitCreate(id, name, category);
								}
							}),
							renameOpen && identity !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RenameForm, {
								currentHandle: identity.handle,
								saving: renaming,
								error: renameError,
								onCancel: () => {
									setRenameOpen(false);
									setRenameError(null);
								},
								onSubmit: (handle) => {
									claimHandle$1(handle).then((error) => {
										if (error !== null) setRenameError(error);
									});
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-left-foot",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: cx("dshch-conn-dot", connClass),
										title: connLabel,
										"aria-hidden": "true"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-me-handle",
										children: identity !== null ? `@${identity.handle}` : identityState === "error" ? "身份注册失败" : "正在注册身份…"
									}),
									identity === null && identityState === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										onClick: () => void bootstrapIdentity(),
										children: "重试"
									}),
									identity !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										title: "修改 handle",
										onClick: () => {
											setRenameOpen((open) => !open);
											setRenameError(null);
										},
										children: "改名"
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: cx("dshch-col-center", dragging && "is-dragging"),
						onDragEnter: onCenterDragEnter,
						onDragOver: onCenterDragOver,
						onDragLeave: onCenterDragLeave,
						onDrop: onCenterDrop,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: "dshch-header",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshch-header-main",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshch-title",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-hash",
												children: "#"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-title-name",
												children: activeName
											})]
										}), activeMeta?.topic !== void 0 && activeMeta.topic !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshch-topic",
											children: activeMeta.topic
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshch-search",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-search-icon",
												"aria-hidden": "true",
												children: "🔍"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "dshch-search-input",
												type: "search",
												value: searchQuery,
												placeholder: "检索消息…",
												"aria-label": "检索消息",
												onChange: (event) => setSearchQuery(event.currentTarget.value),
												onKeyDown: (event) => {
													if (event.nativeEvent?.isComposing === true) return;
													if (event.key === "Enter") {
														event.preventDefault();
														runSearch(event.currentTarget.value);
														return;
													}
													if (event.key === "Escape") {
														event.preventDefault();
														closeSearch();
														event.currentTarget.blur();
													}
												},
												onFocus: () => {
													if (searchQuery.trim() !== "" && (searchHits.length > 0 || searchError !== null)) setSearchOpen(true);
												}
											}),
											searchQuery !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-search-clear",
												title: "清空检索",
												"aria-label": "清空检索",
												onClick: () => {
													setSearchQuery("");
													closeSearch();
													setSearchHits([]);
													setSearchError(null);
													setSearchHasMore(false);
												},
												children: "✕"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-search-scope",
												title: searchScope === "all" ? "当前检索全部频道（点击只搜本频道）" : "当前只搜本频道（点击搜索全部频道）",
												onClick: () => setSearchScope((scope) => scope === "all" ? "channel" : "all"),
												children: searchScope === "all" ? "全部" : "本频道"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshch-header-actions",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dshch-conn-pill",
												title: offline ? "与 host 的连接已断开" : connLabel,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: cx("dshch-conn-dot", connClass),
													"aria-hidden": "true"
												}), connLabel]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: cx("dshch-icon-btn", showPins && "is-active"),
												title: "置顶消息",
												"aria-label": "置顶消息",
												onClick: () => setShowPins((open) => !open),
												children: ["📌", pinCount > 0 ? ` ${pinCount}` : ""]
											}),
											activeMeta !== void 0 && activeMeta.canManage === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-icon-btn",
												title: "频道管理（管理员 / 禁言 / 发言限制）",
												"aria-label": "频道管理",
												onClick: () => {
													setSettingsError(null);
													setSettingsOpen(true);
												},
												children: "⚙️"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: cx("dshch-icon-btn", showMembers && "is-active"),
												title: showMembers ? "收起成员列表" : "展开成员列表",
												"aria-label": "成员列表",
												onClick: () => setShowMembers((open) => !open),
												children: "👥"
											})
										]
									})
								]
							}),
							searchOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshch-search-backdrop",
								onClick: closeSearch,
								"aria-hidden": "true"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-search-panel",
								role: "dialog",
								"aria-label": "消息检索结果",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-search-panel-head",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dshch-search-panel-title",
											children: [
												"检索「",
												searchDoneRef.current !== "" ? searchDoneRef.current : searchQuery.trim(),
												"」",
												searchScope === "channel" ? ` · #${activeName}` : " · 全部频道"
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshch-search-count",
											children: searchLoading ? "…" : `${searchHits.length}${searchHasMore ? "+" : ""} 条`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dshch-icon-btn",
											title: "关闭（Esc）",
											"aria-label": "关闭检索结果",
											onClick: closeSearch,
											children: "✕"
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-search-list",
									children: [
										searchLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshch-search-note",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-spinner",
												"aria-hidden": "true"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "检索中…" })]
										}),
										!searchLoading && searchError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshch-search-note is-error",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["检索失败：", searchError] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dshch-link-btn",
												onClick: rewindSearch,
												children: "重试"
											})]
										}),
										!searchLoading && searchError === null && searchHits.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshch-search-note",
											children: "没有匹配的消息"
										}),
										searchHits.map((hit) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dshch-hit",
											title: `跳到 #${hit.channel} 的 ${hit.message.id}`,
											onClick: () => openSearchHit(hit),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dshch-hit-head",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "dshch-hit-channel",
														children: ["#", channelLabelOf(hit.channel)]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "dshch-hit-author",
														children: ["@", hit.message.author.handle]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dshch-hit-time",
														children: formatFull(hit.message.ts)
													})
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshch-hit-snippet",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HighlightedSnippet, {
													text: hit.snippet,
													query: searchDoneRef.current !== "" ? searchDoneRef.current : searchQuery
												})
											})]
										}, `${hit.channel}:${hit.message.id}`)),
										!searchLoading && searchHits.length > 0 && searchHasMore && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshch-search-note",
											children: [
												"结果已达上限（",
												50,
												" 条），请加更精确的检索词"
											]
										})
									]
								})]
							})] }),
							activeMeta?.announcementId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-announce",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-announce-tag",
									children: "📢 公告"
								}), announcement !== null && announcement.channel === activeChannel ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dshch-announce-author",
										children: ["@", announcement.message.author.handle]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-announce-text",
										children: excerpt(announcement.message.text, 240)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										onClick: () => void jumpTo(announcement.message.id),
										children: "查看"
									})
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshch-announce-text",
									children: "本频道有公告"
								})]
							}),
							banner !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: cx("dshch-banner", banner.kind === "error" ? "is-error" : "is-info"),
								role: "status",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshch-banner-text",
										children: banner.text
									}),
									offline && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-link-btn",
										onClick: () => {
											bootstrapIdentity();
											refreshChannels();
										},
										children: "重试连接"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-icon-btn",
										title: "关闭提示",
										"aria-label": "关闭提示",
										onClick: () => setBanner(null),
										children: "✕"
									})
								]
							}),
							identityState === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-banner is-error",
								role: "status",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dshch-banner-text",
									children: [
										"身份注册失败：",
										identityError ?? "未知错误",
										"（无法发送消息）"
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dshch-link-btn",
									onClick: () => void bootstrapIdentity(),
									children: "重试"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshch-scroll",
								ref: scrollRef,
								onScroll: handleScroll,
								children: channelsLoaded && activeMeta === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-empty",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshch-empty-icon",
											children: "#"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: channelsError !== null ? `频道列表加载失败：${channelsError}` : "还没有频道" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dshch-btn dshch-btn-outline",
											onClick: () => setCreateOpen(true),
											children: "新建频道"
										})
									]
								}) : activeStore === void 0 || activeStore.loading && !activeStore.loaded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-empty",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshch-spinner" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "正在加载消息…" })]
								}) : activeStore.error !== null && activeStore.messages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-empty",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["消息加载失败：", activeStore.error] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshch-btn dshch-btn-outline",
										onClick: () => void loadLatest(activeChannel),
										children: "重试"
									})]
								}) : activeStore.messages.length === 0 && pendingForChannel.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-empty",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshch-empty-icon",
											children: "💬"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											"#",
											activeName,
											" 还没有消息"
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "在下方输入框发第一条消息吧" })
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-msgs",
									children: [
										activeStore.hasMore && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshch-older",
											children: activeStore.loadingOlder ? "正在加载更早的消息…" : "向上滚动加载更早的消息"
										}),
										messages.map((message, index, list) => {
											const previous = index > 0 ? list[index - 1] : void 0;
											const showDay = previous === void 0 || dayKey(previous.ts) !== dayKey(message.ts);
											const grouped = previous !== void 0 && !showDay && previous.author.participantId === message.author.participantId && previous.kind === "chat" && message.kind === "chat" && message.replyTo === void 0 && Date.parse(message.ts) - Date.parse(previous.ts) < GROUP_WINDOW_MS;
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [showDay && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dshch-day",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: dayLabel(message.ts) })
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageRow, {
												message,
												grouped,
												pinned: pinnedIds.has(message.id),
												highlighted: highlightId === message.id,
												canModify: identity !== null,
												onReply: startReply,
												onTogglePin: (target) => void togglePin(target),
												onJump: jumpTo,
												onOpenImage: openImage
											})] }, message.id);
										}),
										pendingForChannel.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PendingRow, {
											pending: item,
											onRetry: retryPending,
											onOpenImage: openImage
										}, item.clientMsgId))
									]
								})
							}),
							newBelow > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dshch-newbtn",
								onClick: scrollToBottom,
								children: ["新消息 ↓ ", newBelow]
							}),
							activeMeta?.mutedAll === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshch-mute-banner",
								role: "status",
								children: ["🔇 全员禁言进行中：只有频道管理员和人类操作者可以发言", activeMeta.canManage === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dshch-link-btn",
									onClick: () => setSettingsOpen(true),
									children: "管理"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Composer, {
								ref: composerRef,
								channelName: activeName,
								disabled: identity === null,
								disabledHint: identityState === "error" ? "身份注册失败，无法发送" : "正在注册身份…",
								identityHandle: identity?.handle ?? "",
								replyTo,
								members,
								maxBytes: MAX_TEXT_BYTES,
								onCancelReply: () => setReplyTo(null),
								onSend: handleSend,
								drafts,
								draftsError,
								onPickFiles: addFiles,
								onRemoveDraft: removeDraft,
								onRetryDraft: retryDraft
							}, activeChannel),
							showPins && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinDrawer, {
								pins,
								loading: pinsLoading,
								onClose: () => setShowPins(false),
								onJump: (id) => void jumpTo(id),
								onUnpin: (id) => void unpinById(id)
							}),
							dragging && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshch-drop-overlay",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshch-drop-inner",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshch-drop-icon",
											children: "📎"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "松开即可上传附件" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dshch-drop-hint",
											children: [
												"最多 ",
												10,
												" 个 · 单个 ≤ ",
												humanSize(26214400),
												" · 合计 ≤ ",
												humanSize(52428800)
											]
										})
									]
								})
							})
						]
					}),
					showMembers && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemberList, {
						members,
						loading: membersLoading,
						currentHandle: identity?.handle ?? "",
						onMention: mentionFromMember,
						onRefresh: () => void refreshMembers()
					}),
					settingsOpen && activeMeta !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChannelSettingsDialog, {
						channel: activeMeta,
						members,
						busy: settingsBusy,
						error: settingsError,
						onClose: () => {
							setSettingsOpen(false);
							setSettingsError(null);
						},
						onToggleAdmin: toggleChannelAdmin,
						onMuteAll: setChannelMutedAll,
						onMuteMember: setChannelMemberMuted,
						onSaveLimits: saveChannelLimits
					}, activeMeta.id),
					lightbox !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Lightbox, {
						attachment: lightbox,
						onClose: () => setLightbox(null)
					})
				]
			});
		}
		// src/client/styles.ts
		/**
		* dsh-channels —— 面板样式（一个注入的 <style>，class 前缀 dshch-）。
		*
		* 只依赖 shell 已经写在 document 上的主题变量：
		*   - `documentElement.style.color-scheme`：light / dark（布局插件 theme-presenter 写入）；
		*   - body 上的 `--dsw-alias-*` / `--dsw-specific-*` 颜色 token；
		*   - body 上的 `--dsh-font-family-*` 字体 token。
		* 所以这里统一用 `var(--token, light-dark(浅色, 深色))` 的形式，token 缺失时也能看。
		*/
		const STYLE_ID = "dsh-channels-styles";
		const CSS = String.raw`
.dshch-root {
  --dshch-font: var(--dsh-font-family-text, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif);
  --dshch-mono: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --dshch-bg: var(--dsw-alias-bg-layer-1, light-dark(#ffffff, #1c1c21));
  --dshch-bg-soft: var(--dsw-alias-bg-layer-2, light-dark(#f4f4f7, #24242b));
  --dshch-bg-sunken: var(--dsw-alias-bg-base, light-dark(#fafafc, #151519));
  --dshch-bg-overlay: var(--dsw-alias-bg-overlay, light-dark(#ffffff, #2b2b33));
  --dshch-sidebar: var(--dsw-specific-sidebar-fill, light-dark(#f2f3f7, #191a1f));
  --dshch-border: var(--dsw-alias-border-l1, light-dark(rgba(15, 15, 20, 0.09), rgba(255, 255, 255, 0.1)));
  --dshch-border-strong: var(--dsw-alias-border-l2, light-dark(rgba(15, 15, 20, 0.18), rgba(255, 255, 255, 0.2)));
  --dshch-text: var(--dsw-alias-label-primary, light-dark(#1b1b1f, #f1f1f3));
  --dshch-text-dim: var(--dsw-alias-label-secondary, light-dark(#66666f, #9b9ba6));
  --dshch-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --dshch-danger: var(--dsw-alias-state-error-primary, #d64545);
  --dshch-success: var(--dsw-alias-state-success-primary, #1f9d63);
  --dshch-warn: var(--dsw-alias-state-warn-primary, #c68a1c);
  --dshch-human: #2f6fed;
  --dshch-agent: #8b5cf6;
  --dshch-external: #c2410c;
  --dshch-hover: rgba(127, 127, 140, 0.12);
  --dshch-hover-strong: rgba(127, 127, 140, 0.2);
  position: relative;
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dshch-bg);
  color: var(--dshch-text);
  font-family: var(--dshch-font);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
}
.dshch-root *,
.dshch-root *::before,
.dshch-root *::after { box-sizing: border-box; }
.dshch-root button,
.dshch-root input,
.dshch-root textarea { font: inherit; color: inherit; }
.dshch-root button { cursor: pointer; }
.dshch-root button:disabled { cursor: not-allowed; opacity: 0.5; }
.dshch-root button:focus-visible,
.dshch-root input:focus-visible,
.dshch-root textarea:focus-visible { outline: 2px solid var(--dshch-brand); outline-offset: 1px; }
.dshch-root ::selection { background: rgba(77, 107, 254, 0.25); }

/* ---------- 三栏骨架 ---------- */
.dshch-col-left {
  display: flex;
  flex-direction: column;
  flex: 0 0 236px;
  width: 236px;
  min-width: 0;
  min-height: 0;
  background: var(--dshch-sidebar);
  border-right: 1px solid var(--dshch-border);
}
.dshch-col-center {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--dshch-bg);
}
.dshch-col-right {
  display: flex;
  flex: 0 0 212px;
  flex-direction: column;
  width: 212px;
  min-width: 0;
  min-height: 0;
  background: var(--dshch-bg-soft);
  border-left: 1px solid var(--dshch-border);
}

/* ---------- 通用小件 ---------- */
.dshch-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
.dshch-btn:hover { background: var(--dshch-hover); }
.dshch-btn-primary { background: var(--dshch-brand); color: #fff; }
.dshch-btn-primary:hover { background: var(--dshch-brand); filter: brightness(1.08); }
.dshch-btn-outline { border-color: var(--dshch-border-strong); }
.dshch-btn-danger { color: var(--dshch-danger); }
.dshch-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 14px;
  line-height: 1;
}
.dshch-icon-btn:hover { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-icon-btn.is-active { background: var(--dshch-hover-strong); color: var(--dshch-text); }
.dshch-link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dshch-brand);
  font-size: 12px;
}
.dshch-link-btn:hover { text-decoration: underline; }
.dshch-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 6px;
  background: var(--dshch-bg);
  color: var(--dshch-text);
  font-size: 12px;
  outline: none;
}
.dshch-input::placeholder { color: var(--dshch-text-dim); }
.dshch-form-error { color: var(--dshch-danger); font-size: 11px; line-height: 1.4; }
.dshch-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--dshch-text-dim);
  font-size: 12px;
  text-align: center;
}
.dshch-empty-icon { font-size: 26px; line-height: 1; }
.dshch-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--dshch-border-strong);
  border-top-color: var(--dshch-brand);
  border-radius: 50%;
  animation: dshch-spin 0.8s linear infinite;
}
@keyframes dshch-spin { to { transform: rotate(360deg); } }

/* ---------- 左栏 ---------- */
.dshch-left-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
  color: var(--dshch-text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dshch-left-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.dshch-cat { margin: 10px 0 2px; padding: 0 6px; color: var(--dshch-text-dim); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.dshch-cat:first-child { margin-top: 2px; }
.dshch-channel {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 13px;
  text-align: left;
}
.dshch-channel:hover { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-channel.is-active { background: var(--dshch-hover-strong); color: var(--dshch-text); font-weight: 600; }
.dshch-hash { flex: 0 0 auto; opacity: 0.65; font-weight: 500; }
.dshch-channel-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-badge {
  flex: 0 0 auto;
  min-width: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dshch-brand);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
.dshch-left-form { padding: 8px 10px; border-top: 1px solid var(--dshch-border); background: var(--dshch-bg-soft); }
.dshch-form-row { display: flex; gap: 6px; margin-bottom: 6px; }
.dshch-form-row > * { min-width: 0; }
.dshch-form-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.dshch-left-foot {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-top: 1px solid var(--dshch-border);
  background: var(--dshch-bg-soft);
  font-size: 12px;
}
.dshch-me-handle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dshch-conn-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--dshch-text-dim); }
.dshch-conn-dot.is-open { background: var(--dshch-success); }
.dshch-conn-dot.is-connecting { background: var(--dshch-warn); animation: dshch-pulse 1.2s ease-in-out infinite; }
.dshch-conn-dot.is-offline { background: var(--dshch-danger); }
@keyframes dshch-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ---------- 中栏头部 ---------- */
.dshch-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dshch-border);
  background: var(--dshch-bg);
}
.dshch-header-main { flex: 1 1 auto; min-width: 0; }
.dshch-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshch-title-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 700; }
.dshch-topic { margin-top: 1px; overflow: hidden; color: var(--dshch-text-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.dshch-header-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.dshch-conn-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--dshch-border);
  border-radius: 999px;
  color: var(--dshch-text-dim);
  font-size: 10px;
  white-space: nowrap;
}
.dshch-announce {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--dshch-border);
  background: var(--dshch-bg-soft);
  font-size: 12px;
}
.dshch-announce-tag { flex: 0 0 auto; color: var(--dshch-warn); font-weight: 700; font-size: 11px; }
.dshch-announce-author { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 11px; }
.dshch-announce-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-banner {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--dshch-border);
  font-size: 12px;
}
.dshch-banner.is-error { background: rgba(214, 69, 69, 0.12); color: var(--dshch-danger); }
.dshch-banner.is-info { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-banner-text { flex: 1 1 auto; min-width: 0; }

/* ---------- 消息流 ---------- */
.dshch-scroll { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.dshch-scroll, .dshch-left-scroll, .dshch-right-scroll, .dshch-pins-list, .dshch-textarea {
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb, rgba(127, 127, 140, 0.35)) transparent;
}
.dshch-msgs { display: flex; flex-direction: column; gap: 2px; min-height: 100%; padding: 14px 16px 20px; }
.dshch-day { display: flex; align-items: center; gap: 10px; margin: 14px 0 8px; color: var(--dshch-text-dim); font-size: 11px; }
.dshch-day::before, .dshch-day::after { flex: 1 1 auto; height: 1px; background: var(--dshch-border); content: ""; }
.dshch-day span { flex: 0 0 auto; }
.dshch-msg { display: flex; gap: 10px; padding: 3px 8px; border-radius: 8px; }
.dshch-msg:hover { background: var(--dshch-hover); }
.dshch-msg.is-grouped { margin-top: -1px; }
.dshch-msg.is-highlighted { background: rgba(77, 107, 254, 0.14); box-shadow: inset 2px 0 0 var(--dshch-brand); }
.dshch-msg-avatar {
  display: flex;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--dshch-hover-strong);
  color: var(--dshch-text);
  font-size: 12px;
  font-weight: 700;
  user-select: none;
}
.dshch-msg-avatar.is-ghost { visibility: hidden; }
.dshch-msg-avatar.is-human { background: rgba(47, 111, 237, 0.2); color: var(--dshch-human); }
.dshch-msg-avatar.is-dsh-agent { background: rgba(139, 92, 246, 0.2); color: var(--dshch-agent); }
.dshch-msg-avatar.is-external { background: rgba(194, 65, 12, 0.2); color: var(--dshch-external); }
.dshch-msg-body { flex: 1 1 auto; min-width: 0; }
.dshch-msg-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.dshch-author-name { color: var(--dshch-text); font-size: 13px; font-weight: 600; }
.dshch-msg.is-human .dshch-author-name { color: var(--dshch-human); }
.dshch-msg.is-dsh-agent .dshch-author-name { color: var(--dshch-agent); }
.dshch-msg.is-external .dshch-author-name { color: var(--dshch-external); }
.dshch-author-handle { color: var(--dshch-text-dim); font-family: var(--dshch-mono); font-size: 10px; }
.dshch-kind-tag {
  padding: 0 5px;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 4px;
  color: var(--dshch-text-dim);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.dshch-msg-time { color: var(--dshch-text-dim); font-size: 10px; }
.dshch-pin-mark { color: var(--dshch-warn); font-size: 10px; }
.dshch-msg-text { margin-top: 1px; color: var(--dshch-text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshch-mention {
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(77, 107, 254, 0.16);
  color: var(--dshch-brand);
  font-weight: 600;
}
.dshch-reply-quote {
  display: flex;
  align-items: baseline;
  gap: 5px;
  max-width: 100%;
  margin: 1px 0 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 11px;
  text-align: left;
}
.dshch-reply-quote:hover { color: var(--dshch-text); }
.dshch-reply-bar { flex: 0 0 auto; width: 3px; height: 12px; border-radius: 2px; background: var(--dshch-border-strong); }
.dshch-reply-author { flex: 0 0 auto; font-weight: 600; }
.dshch-reply-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-msg-actions {
  display: flex;
  position: absolute;
  top: 2px;
  right: 8px;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dshch-border);
  border-radius: 7px;
  background: var(--dshch-bg-overlay);
  opacity: 0;
  transition: opacity 0.1s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.dshch-msg { position: relative; }
.dshch-msg:hover .dshch-msg-actions,
.dshch-msg:focus-within .dshch-msg-actions { opacity: 1; }
.dshch-action-btn {
  padding: 2px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 11px;
}
.dshch-action-btn:hover { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-older { padding: 4px 0 10px; color: var(--dshch-text-dim); font-size: 11px; text-align: center; }
.dshch-newbtn {
  position: absolute;
  bottom: 96px;
  left: 50%;
  z-index: 3;
  transform: translateX(-50%);
  padding: 5px 12px;
  border: 1px solid var(--dshch-border);
  border-radius: 999px;
  background: var(--dshch-brand);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}
.dshch-pending { display: flex; gap: 10px; padding: 3px 8px; border-radius: 8px; opacity: 0.75; }
.dshch-pending.is-failed { opacity: 1; background: rgba(214, 69, 69, 0.08); }
.dshch-pending-text { margin-top: 1px; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshch-pending-note { display: flex; align-items: center; gap: 8px; margin-top: 2px; color: var(--dshch-text-dim); font-size: 11px; }
.dshch-pending.is-failed .dshch-pending-note { color: var(--dshch-danger); }
.dshch-retry { padding: 0 6px; border: 1px solid currentColor; border-radius: 5px; background: transparent; color: inherit; font-size: 11px; line-height: 16px; }

/* ---------- 输入区 ---------- */
.dshch-composer-wrap { position: relative; flex: 0 0 auto; padding: 6px 14px 12px; background: var(--dshch-bg); }
.dshch-reply-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 9px;
  border-left: 2px solid var(--dshch-brand);
  border-radius: 4px;
  background: var(--dshch-bg-soft);
  font-size: 11px;
}
.dshch-reply-preview-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 10px;
  background: var(--dshch-bg-soft);
}
.dshch-composer:focus-within { border-color: var(--dshch-brand); }
.dshch-channel-tag { flex: 0 0 auto; align-self: center; color: var(--dshch-text-dim); font-family: var(--dshch-mono); font-size: 11px; }
.dshch-textarea {
  flex: 1 1 auto;
  width: 100%;
  min-height: 22px;
  max-height: 160px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dshch-text);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  resize: none;
  overflow-y: auto;
}
.dshch-textarea::placeholder { color: var(--dshch-text-dim); }
.dshch-send {
  flex: 0 0 auto;
  align-self: flex-end;
  padding: 4px 12px;
  border: 0;
  border-radius: 7px;
  background: var(--dshch-brand);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}
.dshch-send:disabled { background: var(--dshch-hover-strong); color: var(--dshch-text-dim); }
.dshch-composer-hint { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; padding: 0 2px; color: var(--dshch-text-dim); font-size: 10px; }
.dshch-counter.is-over { color: var(--dshch-danger); font-weight: 700; }
.dshch-mention-menu {
  position: absolute;
  bottom: calc(100% - 4px);
  left: 14px;
  z-index: 5;
  width: min(280px, 60%);
  max-height: 208px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dshch-border);
  border-radius: 9px;
  background: var(--dshch-bg-overlay);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.dshch-mention-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text);
  font-size: 12px;
  text-align: left;
}
.dshch-mention-item.is-active, .dshch-mention-item:hover { background: var(--dshch-hover-strong); }
.dshch-mention-handle { font-family: var(--dshch-mono); font-size: 11px; color: var(--dshch-text-dim); }
.dshch-mention-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- 右栏成员 ---------- */
.dshch-right-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px;
  border-bottom: 1px solid var(--dshch-border);
  color: var(--dshch-text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.dshch-right-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px 12px; }
.dshch-member-group { margin: 10px 0 2px; padding: 0 6px; color: var(--dshch-text-dim); font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; }
.dshch-member {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text);
  font-size: 12px;
  text-align: left;
}
.dshch-member:hover { background: var(--dshch-hover); }
.dshch-member.is-offline { opacity: 0.6; }
.dshch-status-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--dshch-text-dim); }
.dshch-status-dot.is-online { background: var(--dshch-success); }
.dshch-status-dot.is-idle { background: var(--dshch-warn); }
.dshch-status-dot.is-offline { background: var(--dshch-text-dim); }
.dshch-member-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-member-tag { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 9px; font-family: var(--dshch-mono); }
.dshch-member-seen { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 9px; opacity: .72; }
.dshch-member-handle { color: var(--dshch-text-dim); font-size: 10px; font-family: var(--dshch-mono); }

/* ---------- 置顶抽屉 ---------- */
.dshch-pins-backdrop { position: absolute; inset: 0; z-index: 8; background: rgba(0, 0, 0, 0.16); }
.dshch-pins-drawer {
  display: flex;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 9;
  flex-direction: column;
  width: min(330px, 86%);
  border-left: 1px solid var(--dshch-border);
  background: var(--dshch-bg-overlay);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.16);
}
.dshch-pins-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dshch-border); font-size: 13px; font-weight: 700; }
.dshch-pins-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px 14px; }
.dshch-pin-item { margin-bottom: 6px; padding: 8px 9px; border: 1px solid var(--dshch-border); border-radius: 8px; background: var(--dshch-bg-soft); }
.dshch-pin-meta { display: flex; align-items: baseline; gap: 6px; color: var(--dshch-text-dim); font-size: 10px; }
.dshch-pin-author { font-family: var(--dshch-mono); font-size: 10px; }
.dshch-pin-text { margin: 3px 0 5px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshch-pin-actions { display: flex; gap: 6px; }
/* ---------- 附件（M3） ---------- */
.dshch-file-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dshch-attach-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 15px;
  line-height: 1;
}
.dshch-attach-btn:hover:not(:disabled) { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.dshch-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 6px 3px 8px;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 999px;
  background: var(--dshch-bg-soft);
  font-size: 11px;
}
.dshch-chip.is-uploading { border-style: dashed; opacity: 0.85; }
.dshch-chip.is-failed { border-color: var(--dshch-danger); color: var(--dshch-danger); background: rgba(214, 69, 69, 0.08); }
.dshch-chip-icon { flex: 0 0 auto; font-size: 11px; }
.dshch-chip-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-chip-size { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 10px; }
.dshch-chip-state { flex: 0 0 auto; color: var(--dshch-warn); font-size: 10px; }
.dshch-chip-retry {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 10px;
  line-height: 15px;
}
.dshch-chip-x {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.dshch-chip-x:hover { background: var(--dshch-hover-strong); color: var(--dshch-text); }
.dshch-attach-error {
  margin-bottom: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(214, 69, 69, 0.1);
  color: var(--dshch-danger);
  font-size: 11px;
}
.dshch-attachments { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
.dshch-att-images { display: flex; flex-wrap: wrap; gap: 6px; }
.dshch-att-image-btn {
  padding: 0;
  border: 1px solid var(--dshch-border);
  border-radius: 8px;
  background: var(--dshch-bg-sunken);
  overflow: hidden;
  line-height: 0;
}
.dshch-att-image-btn:hover { border-color: var(--dshch-brand); }
.dshch-att-image {
  display: block;
  max-width: 320px;
  max-height: 240px;
  width: auto;
  height: auto;
  object-fit: contain;
}
.dshch-att-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--dshch-border);
  border-radius: 8px;
  background: var(--dshch-bg-soft);
  font-size: 11px;
  align-self: flex-start;
}
.dshch-att-file-icon { flex: 0 0 auto; }
.dshch-att-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshch-att-size { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 10px; }
.dshch-att-dl { flex: 0 0 auto; color: var(--dshch-brand); font-size: 11px; text-decoration: none; }
.dshch-att-dl:hover { text-decoration: underline; }
.dshch-col-center.is-dragging { outline: 2px dashed var(--dshch-brand); outline-offset: -6px; }
.dshch-drop-overlay {
  display: flex;
  position: absolute;
  inset: 0;
  z-index: 7;
  align-items: center;
  justify-content: center;
  background: rgba(77, 107, 254, 0.08);
  backdrop-filter: blur(1px);
  pointer-events: none;
}
.dshch-drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 18px 26px;
  border: 2px dashed var(--dshch-brand);
  border-radius: 14px;
  background: var(--dshch-bg-overlay);
  color: var(--dshch-text);
  font-size: 13px;
  font-weight: 600;
}
.dshch-drop-icon { font-size: 24px; }
.dshch-drop-hint { color: var(--dshch-text-dim); font-size: 10px; font-weight: 400; }
.dshch-lightbox {
  display: flex;
  position: fixed;
  inset: 0;
  z-index: 60;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  background: rgba(0, 0, 0, 0.72);
}
.dshch-lightbox-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 92vw;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 12px;
}
.dshch-lightbox-name { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dshch-lightbox-bar .dshch-att-size { color: rgba(255, 255, 255, 0.7); }
.dshch-lightbox-bar .dshch-link-btn { color: #9db4ff; }
.dshch-lightbox-bar .dshch-icon-btn { color: #fff; }
.dshch-lightbox-bar .dshch-icon-btn:hover { background: rgba(255, 255, 255, 0.16); }
.dshch-lightbox-img {
  max-width: min(92vw, 1600px);
  max-height: 78vh;
  border-radius: 8px;
  background: #000;
  object-fit: contain;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
}
.dshch-lightbox-hint { color: rgba(255, 255, 255, 0.62); font-size: 11px; }

/* ---------- 检索（M3） ---------- */
.dshch-search {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  max-width: 360px;
  min-width: 120px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--dshch-border);
  border-radius: 999px;
  background: var(--dshch-bg-soft);
}
.dshch-search:focus-within { border-color: var(--dshch-brand); }
.dshch-search-icon { flex: 0 0 auto; font-size: 11px; opacity: 0.7; }
.dshch-search-input {
  flex: 1 1 auto;
  min-width: 40px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--dshch-text);
  font-size: 12px;
  outline: none;
}
.dshch-search-input::placeholder { color: var(--dshch-text-dim); }
.dshch-search-input::-webkit-search-cancel-button { display: none; }
.dshch-search-clear,
.dshch-search-scope {
  flex: 0 0 auto;
  padding: 1px 7px;
  border: 1px solid var(--dshch-border);
  border-radius: 999px;
  background: transparent;
  color: var(--dshch-text-dim);
  font-size: 10px;
  line-height: 15px;
  white-space: nowrap;
}
.dshch-search-clear { border-color: transparent; padding: 1px 4px; }
.dshch-search-clear:hover, .dshch-search-scope:hover { background: var(--dshch-hover); color: var(--dshch-text); }
.dshch-search-backdrop { position: absolute; inset: 48px 0 0; z-index: 10; background: rgba(0, 0, 0, 0.1); }
.dshch-search-panel {
  display: flex;
  position: absolute;
  top: 48px;
  right: 8px;
  left: 8px;
  z-index: 11;
  flex-direction: column;
  max-height: min(60vh, 520px);
  border: 1px solid var(--dshch-border);
  border-radius: 10px;
  background: var(--dshch-bg-overlay);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
  overflow: hidden;
}
.dshch-search-panel-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dshch-border);
  font-size: 12px;
}
.dshch-search-panel-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dshch-search-count { flex: 0 0 auto; color: var(--dshch-text-dim); font-size: 11px; }
.dshch-search-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; }
.dshch-search-note {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 14px 8px;
  color: var(--dshch-text-dim);
  font-size: 12px;
}
.dshch-search-note.is-error { color: var(--dshch-danger); }
.dshch-hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dshch-text);
  text-align: left;
}
.dshch-hit:hover, .dshch-hit:focus-visible { background: var(--dshch-hover); }
.dshch-hit-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 10px; }
.dshch-hit-channel { flex: 0 0 auto; color: var(--dshch-brand); font-weight: 700; }
.dshch-hit-author { flex: 0 0 auto; color: var(--dshch-text-dim); font-family: var(--dshch-mono); }
.dshch-hit-time { flex: 0 0 auto; color: var(--dshch-text-dim); }
.dshch-hit-snippet { font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshch-hl {
  padding: 0 1px;
  border-radius: 3px;
  background: rgba(198, 138, 28, 0.28);
  color: inherit;
  font-weight: 700;
}

/* ---------- 频道管理 / 禁言 ---------- */
.dshch-member-badge {
  flex: 0 0 auto;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(198, 138, 28, 0.16);
  color: var(--dshch-warn);
  font-size: 9px;
  line-height: 1.4;
}
.dshch-member-badge.is-muted { background: rgba(214, 69, 69, 0.14); color: var(--dshch-danger); }
.dshch-channel-mute { flex: 0 0 auto; font-size: 10px; opacity: 0.85; }
.dshch-mute-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 14px 6px;
  padding: 6px 10px;
  border: 1px solid rgba(198, 138, 28, 0.35);
  border-radius: 6px;
  background: rgba(198, 138, 28, 0.08);
  color: var(--dshch-warn);
  font-size: 12px;
}
.dshch-mute-banner .dshch-link-btn { margin-left: auto; color: inherit; text-decoration: underline; }
.dshch-settings-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.35); }
.dshch-settings {
  display: flex;
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 71;
  transform: translate(-50%, -50%);
  flex-direction: column;
  width: min(560px, 92vw);
  max-height: 86vh;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 10px;
  background: var(--dshch-bg-overlay);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  color: var(--dshch-text);
}
.dshch-settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dshch-border);
  font-weight: 600;
}
.dshch-settings-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow: auto;
  padding: 12px 14px 16px;
}
.dshch-settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dshch-border);
  border-radius: 8px;
  background: var(--dshch-bg-soft);
}
.dshch-settings-section h4 { margin: 0; color: var(--dshch-text-dim); font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
.dshch-settings-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; }
.dshch-settings-hint { color: var(--dshch-text-dim); font-size: 11px; line-height: 1.5; }
.dshch-settings-empty { color: var(--dshch-text-dim); font-size: 11px; }
.dshch-settings-tag {
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(198, 138, 28, 0.16);
  color: var(--dshch-warn);
  font-size: 9px;
  font-style: normal;
}
.dshch-settings-field { display: flex; align-items: center; gap: 6px; color: var(--dshch-text-dim); font-size: 11px; }
.dshch-settings-input,
.dshch-settings-select {
  width: 96px;
  padding: 4px 6px;
  border: 1px solid var(--dshch-border-strong);
  border-radius: 5px;
  background: var(--dshch-bg);
  color: var(--dshch-text);
}
.dshch-settings-select { width: 150px; }
.dshch-settings code { font-family: var(--dshch-mono); font-size: 11px; }
.dshch-settings .dshch-link-btn { color: var(--dshch-brand); }

@media (max-width: 900px) {
  .dshch-search { max-width: 220px; }
  .dshch-search-scope { display: none; }
}

@media (max-width: 900px) {
  .dshch-col-left { flex-basis: 196px; width: 196px; }
  .dshch-col-right { flex-basis: 184px; width: 184px; }
}
@media (max-width: 720px) {
  .dshch-col-right { display: none; }
}
`;
		let refCount = 0;
		let element = null;
		/**
		* 把样式表注入 document.head（引用计数，重复 apply 不会重复插）。
		* @returns 释放函数，引用计数归零时移除 <style>。
		*/
		function ensureStyles() {
			if (typeof document === "undefined") return () => {};
			if (element === null || !element.isConnected) {
				const existing = document.getElementById(STYLE_ID);
				element = existing !== null && existing.tagName === "STYLE" ? existing : document.createElement("style");
				element.id = STYLE_ID;
				if (element.textContent !== CSS) element.textContent = CSS;
				if (!element.isConnected) document.head.append(element);
			}
			refCount += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				refCount -= 1;
				if (refCount <= 0 && element !== null) {
					element.remove();
					element = null;
					refCount = 0;
				}
			};
		}
		// src/client/index.tsx
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
		/** 必须与 package.json 的 name 一致：browser 端按 id 注册到 __ModuleLoader__。 */
		const PLUGIN_ID = "dsh-channels";
		/** 侧栏图标行 id；main 面板的 key 必须与它相同，侧栏按钮才会选中本面板。 */
		const PANEL_ID = PLUGIN_ID;
		/** apply 时捕获的 layout 服务；供 footer action 组件切换主面板。 */
		let layoutService;
		/** 会话行「⋯」菜单项所在的槽位（与 dsh-forum 同一个）。 */
		const SESSION_MENU_SLOT = "sidebar.workspaces.session.menu.item";
		/** 每个 sessionId 的已知偏好；菜单打开时刷新，点击后按服务端响应更新。 */
		const prefsCache = /* @__PURE__ */ new Map();
		/** 同一会话的并发刷新合并成一个请求（hide/mute 两个菜单项同时挂载）。 */
		const prefsInFlight = /* @__PURE__ */ new Map();
		/** 读取缓存（缺省两项都关）。 */
		function cachedPrefs(sessionId) {
			return prefsCache.get(sessionId) ?? {
				hidden: false,
				muted: false
			};
		}
		/** 合并写回缓存：POST 响应可能只带被改的那一项。 */
		function mergePrefs(sessionId, patch) {
			const next = {
				...cachedPrefs(sessionId),
				...patch
			};
			prefsCache.set(sessionId, next);
			return next;
		}
		/**
		* 用一个可用身份执行请求：身份来自 localStorage；401 时清掉重新注册后重试一次。
		* @param run - 拿到 token 后要执行的请求。
		*/
		async function withIdentity(run) {
			const identity = await ensureIdentity();
			if (!identity.ok) return identity;
			const first = await run(identity.value.token);
			if (first.ok || first.status !== 401) return first;
			clearIdentity();
			const fresh = await ensureIdentity();
			if (!fresh.ok) return fresh;
			return run(fresh.value.token);
		}
		/** Client 插件依赖 slots；layout 用来提供侧栏底部的快捷入口。 */
		const inject = ["slots", "layout"];
		/**
		* 侧栏图标：内联 SVG（不依赖 UI 库的 icon 组件）。
		* @param props - 侧栏提供的 size / active。
		* @returns 固定尺寸的装饰性图形。
		*/
		function ChannelsIcon({ size = 16, active = false }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				style: {
					display: "block",
					opacity: active ? 1 : .78
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M4 6.2A2.7 2.7 0 0 1 6.7 3.5h10.6A2.7 2.7 0 0 1 20 6.2v6.9a2.7 2.7 0 0 1-2.7 2.7H9.9l-4.5 3.6a1 1 0 0 1-1.6-.8v-2.4a2.7 2.7 0 0 1-.2-1V6.2Z",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinejoin: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8.2 8.4h7.6M8.2 11.4h4.8",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round"
				})]
			});
		}
		/**
		* 侧栏底部「频道」快捷入口：点击把主区域切到频道面板。
		* 与左侧图标行等价，但常驻在底部操作区，便于随时跳回。
		*/
		function ChannelsFooterAction({ wide = true }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				"aria-label": "频道",
				title: "频道",
				"data-dsh-channels-footer": "true",
				onClick: () => {
					layoutService?.selectPanel(PANEL_ID);
				},
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					height: 28,
					padding: wide ? "0 8px" : 0,
					width: wide ? void 0 : 28,
					justifyContent: "center",
					border: "none",
					background: "transparent",
					color: "inherit",
					cursor: "pointer",
					borderRadius: 6,
					fontSize: 12,
					opacity: .82
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChannelsIcon, { size: 16 }), wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "频道" }) : null]
			});
		}
		/**
		* 注册侧栏图标与主面板。
		* @param ctx - browser plugin 根上下文。
		*/
		function apply(ctx) {
			layoutService = ctx.layout;
			/**
			* 注册失败（例如同一插件被热重载成两份时槽位已存在）只记 warning，
			* 不允许冒泡把整份插件激活打挂；返回空 disposer 保持 ctx.effect 协议。
			*/
			const guarded = (label, run) => {
				ctx.effect(() => {
					try {
						return run();
					} catch (error) {
						ctx.logger?.warn?.(`dsh-channels: ${label} 注册失败 %s`, String(error));
						return () => {};
					}
				}, `dsh-channels: ${label}`);
			};
			guarded("panel styles", ensureStyles);
			guarded("sidebar panellist", () => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 30,
				label: "频道"
			}, ChannelsIcon)));
			guarded("main panel", () => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID
			}, ChannelsPanel)));
			guarded("sidebar footer action", () => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-channels-footer",
				order: 40,
				label: "频道"
			}, ChannelsFooterAction)));
			/**
			* 会话行「⋯」菜单项：菜单打开时拉一次当前偏好，点击时写回并关闭菜单。
			* 失败只 warn（标签保持旧值），绝不让菜单报错。
			*/
			const menuLogger = ctx.logger;
			const warn = (message, error) => {
				if (message === "") return;
				menuLogger?.warn?.(`dsh-channels: ${message}`, error === void 0 ? "" : String(error));
			};
			/** 打开菜单时刷新（并发合并）；返回值只用于更新本地 state。 */
			const refreshPrefs = (sessionId) => {
				const existing = prefsInFlight.get(sessionId);
				if (existing !== void 0) return existing;
				const task = (async () => {
					try {
						let result = await fetchSessionPrefs(sessionId);
						if (!result.ok && result.status === 401) result = await withIdentity((token) => fetchSessionPrefs(sessionId, token));
						if (!result.ok) {
							if (result.status !== 404 && result.status !== 0) warn(`读取会话偏好失败（${sessionId}）：${result.message}`);
							return null;
						}
						prefsCache.set(sessionId, result.value);
						return result.value;
					} finally {
						prefsInFlight.delete(sessionId);
					}
				})();
				prefsInFlight.set(sessionId, task);
				return task;
			};
			/** 点击后写回；成功返回合并后的偏好，失败返回 null（调用方保持旧标签）。 */
			const savePrefs = async (sessionId, patch) => {
				const result = await withIdentity((token) => updateSessionPrefs({
					sessionId,
					...patch
				}, token));
				if (!result.ok) {
					warn(`保存会话偏好失败（${sessionId}）：${result.message}`, result.code);
					return null;
				}
				return mergePrefs(sessionId, result.value);
			};
			const makeSessionSwitch = (options) => {
				function SessionSwitch(props) {
					const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
					const useOpen = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState : void 0;
					const openState = useOpen === void 0 ? void 0 : useOpen();
					const open = openState !== void 0 && openState[0] === true;
					const setMenuOpen = openState === void 0 ? void 0 : openState[1];
					const [prefs, setPrefs] = react.useState(() => cachedPrefs(sessionId));
					const [busy, setBusy] = react.useState(false);
					react.useEffect(() => {
						if (!open || sessionId === "") return;
						let cancelled = false;
						refreshPrefs(sessionId).then((next) => {
							if (!cancelled && next !== null) setPrefs(next);
						});
						return () => {
							cancelled = true;
						};
					}, [open, sessionId]);
					const on = options.read(prefs);
					const label = on ? options.labelOn : options.labelOff;
					const title = on ? options.titleOn : options.titleOff;
					const onClick = async () => {
						if (busy || sessionId === "") return;
						setBusy(true);
						setMenuOpen?.(false);
						try {
							const next = await savePrefs(sessionId, options.patch(!on));
							if (next !== null) setPrefs(next);
						} finally {
							setBusy(false);
						}
					};
					return react.createElement("button", {
						type: "button",
						role: "menuitem",
						"data-dsh-channels-session-switch": sessionId,
						title,
						disabled: busy,
						onClick: () => {
							onClick();
						}
					}, label);
				}
				return SessionSwitch;
			};
			const HideSessionItem = makeSessionSwitch({
				read: (prefs) => prefs.hidden,
				patch: (next) => ({ hidden: next }),
				labelOff: "🙈 隐藏频道功能",
				labelOn: "👁 显示频道功能",
				titleOff: "本会话看不到任何 channel_* 工具，也不会被频道 @唤醒",
				titleOn: "恢复本会话的频道工具与 @唤醒"
			});
			const MuteSessionItem = makeSessionSwitch({
				read: (prefs) => prefs.muted,
				patch: (next) => ({ muted: next }),
				labelOff: "🔕 开启消息免打扰",
				labelOn: "🔔 关闭消息免打扰",
				titleOff: "频道消息照常入库，但 @提及 / 被回复不唤醒本会话",
				titleOn: "恢复 @提及 / 被回复时唤醒本会话"
			});
			guarded("session menu: hide channel feature", () => ctx.slots.inject(SESSION_MENU_SLOT, () => ctx.slots.register({
				name: SESSION_MENU_SLOT,
				id: "dsh-channels-hide",
				order: 55
			}, HideSessionItem)));
			guarded("session menu: mute", () => ctx.slots.inject(SESSION_MENU_SLOT, () => ctx.slots.register({
				name: SESSION_MENU_SLOT,
				id: "dsh-channels-mute",
				order: 56
			}, MuteSessionItem)));
		}
		exports.ChannelsFooterAction = ChannelsFooterAction;
		exports.ChannelsIcon = ChannelsIcon;
		exports.PLUGIN_ID = PLUGIN_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map