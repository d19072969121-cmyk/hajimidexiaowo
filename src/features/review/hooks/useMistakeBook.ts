/**
 * useMistakeBook — 错题本取数（E1/E2）
 *
 * ## 数据源口径（源码实证，非推测）
 * 「错题」在当前架构里**没有独立的存储与命令**：
 * - `mistakes.db` 的 `mistakes` 表虽存在（结构完整），但 `lib.rs` 的
 *   `generate_handler!` 注册表（文件行 1721-2899，共 680 行）里
 *   **mistake 相关命令数为 0**，表是活的遗留资产、没接电。
 * - 真正在跑的数据流是 **chat_v2 会话**：拍题走
 *   `useSessionLifecycle.ts:217` 的 `mode: 'analysis'` 会话创建。
 *
 * 因此本 hook 的定义是：**错题本 = `mode === 'analysis'` 的 chat 会话集合**，
 * 「归类」= 会话的 tag 维度。点进详情可直接复用 `AnalysisResultPage`
 * （吃同一个会话 store），"拍题 → 解析 → 错题 → 复习" 形成闭环。
 *
 * ## 用到的命令（全部已在 lib.rs 注册）
 * - `chat_v2_list_sessions` —— 会话列表。**标签不在此命令的返回体里**
 *
 * 标签相关的命令（`chat_v2_get_tags_batch` / `chat_v2_add_tag` /
 * `chat_v2_remove_tag` / `chat_v2_list_all_tags`）由 `useSessionTags` 统一封装，
 * 本 hook 不碰——见下方「标签不在这里取」。
 *
 * ## 为什么独立拉取而不是复用 useSidebarSessionData
 * 侧栏 hook 面向「全部会话 + 分组」，含分页/分组/乐观更新等侧栏专属语义；
 * 错题本只关心 `mode==='analysis'` 的子集。复用它会把侧栏的分页状态
 * （`hasMoreUngrouped` 等）一并带进错题本，语义污染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { getErrorMessage } from '@/utils/errorUtils';
import { isAnalysisFamilyMode } from '@/features/chat/plugins/modes';
import type { ChatSession } from '@/features/chat/types/session';

/** 拍题解析会话的 mode 标记（见 useSessionLifecycle.ts:218） */
/**
 * 错题本口径的 mode 常量。
 *
 * ⚠️ **不要只保留 'analysis'**：E8 新增的 `solver`（拍题解题 agent）同样是
 * 「拍出来的题」，若不计入，用户新拍的题**不会出现在错题本里**。
 * 判据统一走 `isAnalysisFamilyMode`（见下）。
 *
 * 保留 `ANALYSIS_MODE` 导出是为了不破坏既有引用（外部仍可能 import 它）。
 */
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
  /** 会话简介（自动生成），作为列表副标题 */
  description?: string;
}

/**
 * 带标签的错题条目：`MistakeBookEntry` + 由 `useSessionTags` 补齐的标签。
 *
 * ⚠️ 为什么标签不在 `MistakeBookEntry` 上：会话列表命令不返回 tags，
 *    标签来自另一个 hook（`useSessionTags.tagsBySession`）。
 *    若把 `tags` 塞进 `MistakeBookEntry` 并让本 hook 填 `[]`，
 *    消费方会在 `.tags` 上读到永远为空的数组却以为是「这道题没标签」——
 *    这是个会浪费后来者半小时的陷阱字段。因此类型上就分开：
 *    本 hook 只给会话维度，标签由 UI 层合并成这个类型。
 */
export type MistakeBookEntryWithTags = MistakeBookEntry & { tags: string[] };

export interface UseMistakeBookResult {
  entries: MistakeBookEntry[];
  /** 首次加载是否已完成（无论成败） */
  isLoaded: boolean;
  isLoading: boolean;
  /** 加载失败原因；成功时为 null */
  error: string | null;
  /** 手动刷新（下拉/重试） */
  refresh: () => Promise<void>;
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
    // 族判据：analysis + solver 都算「拍出来的题」
    // （solver 是 analysis 的增强版，`extends: 'analysis'`）
    if (!isAnalysisFamilyMode(s.mode)) continue;
    if (!s.id || seen.has(s.id)) continue;
    // 已归档/已删除的会话不进错题本
    if (s.persistStatus && s.persistStatus !== 'active') continue;

    seen.add(s.id);
    out.push({
      sessionId: s.id,
      title: (s.title ?? '').trim() || '未命名错题',
      updatedAt: s.updatedAt ?? '',
      createdAt: s.createdAt ?? '',
      ...(s.description ? { description: s.description } : {}),
    });
  }

  out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return out;
}

/**
 * 拉取错题本条目（会话维度）。
 *
 * 只读：不创建会话、不改 store。失败时把错误文本留在 `error`，
 * 让 UI 显示可重试的错误态，而不是静默空列表（空列表会被误读成「没有错题」）。
 *
 * ## 标签不在这里取（职责边界）
 * 会话列表命令不返回 tags，标签需另调 `chat_v2_get_tags_batch`。
 * 但这层**刻意不做**，因为 `useSessionTags`（`features/chat/hooks/`）
 * 已完整实现了标签的批量读取 + `addTag`/`removeTag` + 全部标签 + 筛选状态。
 * 在这里再实现一遍是重复劳动，且会与那套 hook 的状态割裂（例如归类 UI
 * 通过 `useSessionTags` 加了标签，本 hook 的副本不会同步）。
 *
 * 正确用法：UI 层同时用两个 hook，把 `tagsBySession` 合并成
 * `MistakeBookEntryWithTags`：
 * ```tsx
 * const { entries } = useMistakeBook();
 * const { tagsBySession, addTag } = useSessionTags();
 * const merged = entries.map(e => ({ ...e, tags: tagsBySession.get(e.sessionId) ?? [] }));
 * ```
 * 实际实现见 `ReviewHubPage` 的 `visibleEntries`。
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
      // ⚠️ groupId 必须**不传**，不能传 '*'。
      //
      // 后端语义（chat_v2/repo.rs:592-598）：
      //   groupId 为 None  → 不过滤，返回全部会话
      //   groupId == '*'   → `AND group_id IS NOT NULL`，**只返回已加入分组的**
      //   groupId == ''    → `AND group_id IS NULL`，只返回未分组的
      //
      // 上游侧栏要「全部会话」时发两次请求（'*' + ''）再合并，正是因为
      // 单次请求拿不到全部。错题本用单次请求，故必须不传 groupId——
      // 绝大多数错题不会加入分组，传 '*' 会让错题本在真机上几乎永远为空。
      const sessions = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
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

  return { entries, isLoaded, isLoading, error, refresh };
}

export default useMistakeBook;
