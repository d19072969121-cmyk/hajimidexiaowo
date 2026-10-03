/**
 * Chat V2 - useActiveChatStore Hook
 *
 * ## 定位（A4-P0 地基）
 * 把「当前活动会话的 Store」变成**响应式**的 React 值。
 *
 * `sessionManager.get(sessionId)` 是命令式查询：store 可能在初次渲染时
 * 还不存在（解析会话 = 先建会话、后异步落 store），直接读一次会拿到
 * `undefined` 并**永远卡在空态**——这正是 A4-P0 的根因形态。
 * 本 hook 订阅 `sessionManager` 的会话事件，在 store 从无到有 / 会话切换
 * 时主动重取，因此消费方不必关心时序。
 *
 * ## 为什么单独抽一个 hook
 * 「解析结果页」「复习」「错题本」都需要拿到当前会话 store，且都活在
 * App 渲染层，拿不到 chat 子树的 props。把这层桥接收敛在一处，避免每个
 * 页面各自写一遍订阅逻辑（也就各自漏一遍清理）。
 *
 * ## 与上游 `useChatSessionIfExists` 的关系
 * - `useChatSessionIfExists(sessionId)`：已知 sessionId，只读不创建。
 * - 本 hook：**不知道** sessionId 时，响应式跟随「当前会话」，
 *   内部复用 `sessionManager.get`（不创建），语义与前者一致。
 *
 * ## 订阅范围
 * 只对影响「哪个 sessionId 是当前会话」以及「该会话 store 是否已存在」的
 * 事件重取：
 * - `session-created`：store 入场（解析会话创建后）
 * - `current-session-changed`：切会话
 * - `session-destroyed` / `session-evicted`：store 离场（LRU 淘汰）
 *
 * `streaming-change` 等其余事件**不**触发重取——store 引用不变，
 * 内容更新由 store 自身的订阅（`useStore`）负责，此处重取纯属浪费。
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';

import { sessionManager } from '../core/session/sessionManager';
import type { ChatStore } from '../core/types';

/**
 * 订阅「当前会话 ID」的变化。
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + `useEffect`：后者在订阅建立
 * 前的那个渲染帧会读到一个过期值，而解析页恰好在切换瞬间挂载，
 * 这一帧的错位会直接表现为「页面上没有内容」。
 *
 * `sessionManager.subscribe` 只带事件、不带快照读取，故此处自己维护
 * 「上次快照」做 `Object.is` 去抖：`getCurrentSessionId()` 返回字符串/null，
 * 是天然稳定的标量快照，不会像对象快照那样触发无限重渲染。
 */
function useCurrentSessionId(): string | null {
  const lastRef = useRef<string | null>(sessionManager.getCurrentSessionId());

  const getSnapshot = useCallback(() => {
    const next = sessionManager.getCurrentSessionId();
    // 标量比较：值未变则复用旧引用，避免 useSyncExternalStore 判定已变化
    if (lastRef.current === next) {
      return lastRef.current;
    }
    lastRef.current = next;
    return next;
  }, []);

  const subscribe = useCallback((onStoreChange: () => void) => {
    const unsubscribe = sessionManager.subscribe((event) => {
      switch (event.type) {
        case 'session-created':
        case 'current-session-changed':
        case 'session-destroyed':
        case 'session-evicted':
          onStoreChange();
          return;
        default:
          // 其余事件（streaming-change / blocking-interaction-change /
          // max-sessions-changed）不改变「当前会话 ID」这一事实
          return;
      }
    });
    return unsubscribe;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 订阅「当前活动会话的 Store」，响应式跟随会话创建 / 切换 / 销毁。
 *
 * @param explicitSessionId - 可选。显式指定会话时以它为准（此时不跟随
 *   「当前会话」切换），典型场景是历史会话回看。传 `null` 表示「按当前会话」。
 * @returns 当前可用会话的 `StoreApi<ChatStore>`；无会话时返回 `null`。
 *
 * ⚠️ 本 hook **只读不创建**：会话不存在时返回 `null`，不会调 `getOrCreate`。
 *    解析结果页是会话的**展示态**，不应反过来创建会话。
 *
 * ⚠️ 返回值可能是 `undefined`（store 存在但 manager 暂时取不到），
 *    统一规约为 `null`，让消费方的类型判断只需处理一个「无」的形态。
 */
export function useActiveChatStore(
  explicitSessionId?: string | null,
): StoreApi<ChatStore> | null {
  const currentSessionId = useCurrentSessionId();

  // 显式指定优先；显式传了空串/空值则视为「无会话」而非「跟随当前」
  const useExplicit = explicitSessionId !== undefined && explicitSessionId !== null;
  const sessionId = useExplicit ? explicitSessionId : currentSessionId;

  // store 的取值同样需要响应「当前会话 ID 变化」——它由上面的
  // useCurrentSessionId 驱动，故此处只需按 id 记忆化即可。
  // 依赖里带 sessionId：切换会话会重建 store 引用，触发消费方重渲染。
  return useMemo(() => {
    if (!sessionId) return null;
    return sessionManager.get(sessionId) ?? null;
  }, [sessionId]);
}

export default useActiveChatStore;
