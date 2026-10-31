/**
 * dsh-channels —— 面板样式（一个注入的 <style>，class 前缀 dshch-）。
 *
 * 只依赖 shell 已经写在 document 上的主题变量：
 *   - `documentElement.style.color-scheme`：light / dark（布局插件 theme-presenter 写入）；
 *   - body 上的 `--dsw-alias-*` / `--dsw-specific-*` 颜色 token；
 *   - body 上的 `--dsh-font-family-*` 字体 token。
 * 所以这里统一用 `var(--token, light-dark(浅色, 深色))` 的形式，token 缺失时也能看。
 */
export declare const STYLE_ID = "dsh-channels-styles";
export declare const CSS: string;
/**
 * 把样式表注入 document.head（引用计数，重复 apply 不会重复插）。
 * @returns 释放函数，引用计数归零时移除 <style>。
 */
export declare function ensureStyles(): () => void;
