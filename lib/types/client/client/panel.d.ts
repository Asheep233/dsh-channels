/**
 * dsh-channels —— Web 面板（Discord 式三栏）。
 *
 * 纯文本渲染、只用 React + fetch/EventSource，样式见 `./styles.ts`。
 * 所有网络调用都走 `./api.ts`，失败只显示内联错误，不允许把面板打崩；
 * host 没起来时降级成「离线 + 重试」状态。
 */
import * as React from 'react';
import { type Attachment } from '../contract.js';
/** Composer 里一个待发送附件的本地状态（上传前/中/失败/完成）。 */
export interface DraftAttachment {
    /** 本地 key（React key + 重试定位；与服务器 id 无关）。 */
    key: string;
    /** 原始数据：重试时直接复用，不需要用户重选文件。 */
    blob: Blob;
    name: string;
    mime: string;
    size: number;
    status: 'uploading' | 'ready' | 'failed';
    /** status==='ready' 时的服务端附件。 */
    attachment?: Attachment;
    error?: string;
}
export interface ComposerHandle {
    focus: () => void;
    insertMention: (handle: string) => void;
}
/**
 * 频道主面板：注册到 `main` keyed 槽（key = 'dsh-channels'）。
 * 未选中时由 shell 卸载，重新选中会重新连 SSE（history 走缓存，无副作用）。
 */
export declare function ChannelsPanel(): React.ReactElement;
