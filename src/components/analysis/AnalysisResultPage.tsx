/**
 * AnalysisResultPage — 「解析结果」容器（A4-P0）
 *
 * ## 定位
 * 用户已拍板：**解析页 = chat 会话的特殊展示态**。上游 `createAnalysisSession`
 * （`src/features/chat/pages/useSessionLifecycle.ts:161`）直接建 chat 会话，
 * 解析结果就是流式 chat 消息，因此**没有独立视图**。
 *
 * 本组件是**适配层容器**：
 * ```
 *  chat store ──(useAnalysisResultData)──> AnalysisResultData ──> AnalysisResultView
 *                     ↑ 取数与状态推导              ↑ 纯受控展示（31 用例已通过）
 * ```
 * `AnalysisResultView` 是纯受控组件（props 进 / 回调出），**本文件不修改它**，
 * 只负责把 store 数据喂进去、把 onBack/onRetry 透传出去。
 *
 * ## 与 AnalysisResultView 的四态对齐
 *  `useAnalysisResultData` 已把 store 状态规约成 `empty | loading | error | ready`，
 *  本组件直接透传 `phase`，不重复判定。
 */

import React, { useCallback } from 'react';
import type { StoreApi } from 'zustand';

import type { ChatStore } from '@/features/chat/core/types';
import { AnalysisResultView } from './AnalysisResultView';
import { useAnalysisResultData } from './useAnalysisResultData';

type ChatStoreApi = StoreApi<ChatStore>;

export interface AnalysisResultPageProps {
  /** 目标会话的 ChatStore 实例；null / undefined 表示当前无会话 */
  store?: ChatStoreApi | null;

  /** 返回回调（透传给 AnalysisResultView） */
  onBack?: () => void;

  /**
   * 重试回调（透传）。典型实现：重新发起解析请求或重试 OCR；
   * 本容器不绑定具体动作（保持在 chat 侧，避免适配层耦合业务）。
   */
  onRetry?: () => void;

  /** 学习笔记当前值（由宿主持有，容器只透传） */
  note?: string | null;
  onNoteChange?: (next: string) => void;

  className?: string;
}

export const AnalysisResultPage: React.FC<AnalysisResultPageProps> = ({
  store = null,
  onBack,
  onRetry,
  note = null,
  onNoteChange,
  className,
}) => {
  const { data, phase, isStreaming, error } = useAnalysisResultData(store);

  // 重试：外部给了 onRetry 就直接用；否则在「有会话」时兜底为不做任何事
  // （不擅自触发 store 写操作——写权限在 chat 侧）。
  const handleRetry = useCallback(() => {
    onRetry?.();
  }, [onRetry]);

  return (
    <AnalysisResultView
      data={data}
      phase={phase}
      isStreaming={isStreaming}
      error={error}
      onBack={onBack}
      onRetry={handleRetry}
      note={note}
      onNoteChange={onNoteChange}
      className={className}
    />
  );
};

export default AnalysisResultPage;
