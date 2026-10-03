/**
 * useMistakeBook — 错题本取数（A5）
 *
 * ## 数据源口径（源码实证，非推测）
 * 「错题」在当前架构里**没有独立的存储与命令**：
 * - `mistakes.db` 的 `mistakes` 表虽存在（结构完整），但 `lib.rs` 的
 *   `generate_handler!` 注册表（1721-2899）里 **mistake 相关命令数为 0**，
 *   表是活的遗留资产、没接电。
 * - 真正在跑的数据流是 **chat_v2 会话**：拍题走
 *   `useSessionLifecycle.ts:217` 的 `mode: 'analysis'` 会话创建，
 *   列表走已注册的 `chat_v2_list_sessions`（lib.rs:485），
 *   归类走 `chat_v2_add_tag` / `chat_v2_remove_tag`（lib.rs:576 起）。
 *
 * 因此本 hook 的定义是：**错题本 = `mode === 'analysis'` 的 chat 会话集合**，
 * 「归类」= 会话的 tag 维度。这样点进详情能直接复用 `AnalysisResultPage`
 * （吃同一个会话 store），"拍题 → 解析 → 错题 → 复习" 形成闭环。
 *
 * ## 为什么独立拉取而不是复用 useSidebarSessionData
 * 侧栏 hook 面向「全部会话 + 分组」，含分页/分组/乐观更新等侧栏专属语义；
 * 错题本只关心 `mode==='analysis'` 的子集。复用它会把侧栏的分页状态
 * （`hasMoreUngrouped` 等）一并带进错题本，语义污染。故此处按同一命令
 * （`chat_v2_list_sessions`）做一次**收敛到 analysis 子集**的取数。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatSession } from '@/features/chat/types/session';

/** 拍题解析会话的 mode 标记（见 useSessionLifecycle.ts:218） */
export const ANALYSIS_MODE = 'analysis';

/** 一次拉取的会话上限：错题本按「最近更新」倒序展示，不需要侧栏那种全量分页 */
const MISTAKE_FETCH_LIMIT = 500;

export interface MistakeBookEntry {
  /** 会话 id，点进详情时用于取 store */
  sessionId: string;
  title: string;
  /** 会话更新时间（ISO），用于排序与展示 */
  updatedAt: string;
  createdAt: string;
  /** 归类标签（当前为空数组：chat_v2 列表未回传 tags，见下方注释） */
  tags: string[];
  /** 会话简介（自动生成），作为列表副标题 */
  description?: string;
}

export interface UseMistakeBookResult {
  entries: MistakeBookEntry[];
  /** 首次加载是否已完成（无论成败） */
  isLoaded: boolean;
  isLoading: boolean;
  /** 加载失败原因；成功时为 null */
  error: string | null;
  /** 手动刷新（下拉/重试） */
  refresh: () => Promise<void>;
  /** 按标签聚合：tag → 条目数。无标签的条目不计入 */
  tagCounts: ReadonlyMap<string, number>;
}

/**
 * 纯函数：从会话列表里筛出解析（错题）会话并规约成展示条目。
 *
 * 抽成纯函数以便单测直接喂数组断言筛选与排序，无需 mock invoke。
 *
 * 排序：`updatedAt` 倒序（最近拍的题在最前）。字符串比较即可——
 * 上游时间统一为 ISO 8601（`ChatSession.updatedAt` 注释与
 * `useSidebarSessionData` 的 sort 均按此假设）。
 */
export function toMistakeEntries(sessions: readonly ChatSession[]): MistakeBookEntry[] {
  const out: MistakeBookEntry[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    if (s.mode !== ANALYSIS_MODE) continue;
    if (!s.id || seen.has(s.id)) continue;
    // 已归档/已删除的会话不进错题本
    if (s.persistStatus && s.persistStatus !== 'active') continue;

    seen.add(s.id);
    out.push({
      sessionId: s.id,
      title: (s.title ?? '').trim() || '未命名错题',
      updatedAt: s.updatedAt ?? '',
      createdAt: s.createdAt ?? '',
      // ⚠️ chat_v2_list_sessions 的返回体不含 tags 字段（见 ChatSession 类型）。
      // 归类标签需要另经标签查询命令获取；本轮先留空数组，
      // 归类 UI 单独处理（不在此处臆造数据）。
      tags: [],
      ...(s.description ? { description: s.description } : {}),
    });
  }

  out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return out;
}

/**
 * 拉取错题本条目。
 *
 * 只读：不创建会话、不改 store。失败时把错误文本留在 `error`，
 * 让 UI 显示可重试的错误态，而不是静默空列表（空列表会被误读成「没有错题」）。
 */
export function useMistakeBook(): UseMistakeBookResult {
  const [entries, setEntries] = useState<MistakeBookEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // generation 防乱序：只接受最后一次 refresh 的结果（同 useSidebarSessionData 思路）
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const sessions = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '*',
        limit: MISTAKE_FETCH_LIMIT,
        offset: 0,
      });

      if (generation !== generationRef.current || !mountedRef.current) return;

      const list = Array.isArray(sessions) ? sessions : [];
      setEntries(toMistakeEntries(list));
    } catch (err) {
      if (generation !== generationRef.current || !mountedRef.current) return;
      setError(getErrorMessage(err));
      setEntries([]);
    } finally {
      if (generation === generationRef.current && mountedRef.current) {
        setIsLoaded(true);
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 其他表面（拍题完成、侧栏改名）会广播 sessions-updated，错题本据此自愈。
  // 不引 debounce：错题本数据量小、刷新廉价，且这里没有侧栏那种高频触发源。
  useEffect(() => {
    const onUpdated = () => {
      void refresh();
    };
    window.addEventListener('chat-v2:sessions-updated', onUpdated);
    return () => {
      window.removeEventListener('chat-v2:sessions-updated', onUpdated);
    };
  }, [refresh]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const tag of e.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts as ReadonlyMap<string, number>;
  }, [entries]);

  return { entries, isLoaded, isLoading, error, refresh, tagCounts };
}

export default useMistakeBook;
