/**
 * dsh-channels —— 面板样式（一个注入的 <style>，class 前缀 dshch-）。
 *
 * 只依赖 shell 已经写在 document 上的主题变量：
 *   - `documentElement.style.color-scheme`：light / dark（布局插件 theme-presenter 写入）；
 *   - body 上的 `--dsw-alias-*` / `--dsw-specific-*` 颜色 token；
 *   - body 上的 `--dsh-font-family-*` 字体 token。
 * 所以这里统一用 `var(--token, light-dark(浅色, 深色))` 的形式，token 缺失时也能看。
 */

export const STYLE_ID = 'dsh-channels-styles'

export const CSS = String.raw`
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
`

let refCount = 0
let element: HTMLStyleElement | null = null

/**
 * 把样式表注入 document.head（引用计数，重复 apply 不会重复插）。
 * @returns 释放函数，引用计数归零时移除 <style>。
 */
export function ensureStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (element === null || !element.isConnected) {
    // 用 tagName 判断而不用 instanceof：某些嵌入环境（jsdom / 非窗口文档）里
    // HTMLStyleElement 构造器不一定在全局；tagName 是 DOM 的最小共同点。
    const existing = document.getElementById(STYLE_ID)
    element = existing !== null && existing.tagName === 'STYLE' ? (existing as HTMLStyleElement) : document.createElement('style')
    element.id = STYLE_ID
    if (element.textContent !== CSS) element.textContent = CSS
    if (!element.isConnected) document.head.append(element)
  }
  refCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    refCount -= 1
    if (refCount <= 0 && element !== null) {
      element.remove()
      element = null
      refCount = 0
    }
  }
}
