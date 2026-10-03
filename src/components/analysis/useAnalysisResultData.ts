/**
 * useAnalysisResultData — 从 chat store 读取「解析结果」（A4-P0 适配层）
 *
 * ## 为什么是适配层而不是独立视图
 * 上游**没有独立的「解析结果页」概念**：`createAnalysisSession`
 * （`src/features/chat/pages/useSessionLifecycle.ts:161`）直接创建一个
 * `mode: 'analysis'` 的 chat 会话，OCR 与解析结果都是**流式 chat 消息**。
 * 因此本 hook 的职责是把 chat store 的会话状态**翻译**成
 * `AnalysisResultView` 需要的 `AnalysisResultData`，而不是另造一套取数逻辑。
 *
 * ## 复用的上游 selector（不自定义取数逻辑）
 * - `selectLastAssistantMessage`（`core/store/selectors.ts:217`）—— 找最后一条 AI 消息
 * - `selectLastUserMessage`（`core/store/selectors.ts:228`）—— 找最后一条用户消息（题干回落）
 * - `selectMessageBlocks`（`core/store/selectors.ts:135`）—— 取某条消息的块
 * - `selectModeState`（`core/store/selectors.ts:74`）—— analysis 模式的 OCR 元数据
 *
 * ## 刻意**没有**复用的上游 hook（原因）
 * - `useMessageBlocks`（`hooks/useChatStore.ts:260`）/ `useMessageOrder`（`:231`）：
 *   它们都要求**先知道 messageId**；而本适配层要先在 selector 内解析出
 *   「最后一条 assistant 消息」才能拿到 id，属同一状态推导的两步，拆成两个
 *   hook 会产生「先订阅后派生」的循环依赖。因此这里用一次 `useStore` +
 *   自带身份快路径的复合 selector（见 `makeAnalysisSnapshotSelector`），
 *   思路与上游 `useChatStore.ts:278` 的 `lookupBlocksIfChanged` 一致。
 *
 * ## 数据来源约定（读源码确认，非猜测）
 * - 题干：优先用 analysis 模式 `modeState.ocrMeta.question`
 *   （`plugins/modes/analysis.ts:37-54` 的 `OcrMeta`），
 *   因为 OCR 结构化结果比模型输出更接近「题目原文」；缺失时回落到
 *   最后一条 user 消息的 content 块。
 * - 解析：最后一条 assistant 消息的 **第一个 `type === 'content'` 块**的
 *   `content` 字符串（`core/types/block.ts:21-37`：`Block.content` 是流式正文）。
 *   thinking 块**不计入解析正文**（它是思维链，不是答案）。
 * - isStreaming：`sessionStatus === 'streaming'` **且**该 assistant 消息的
 *   正文块仍在 `activeBlockIds` 中（`core/types/block.ts:29` 的 BlockStatus
 *   与 `store` 的 activeBlockIds 双证据），避免会话级 streaming 误标历史消息。
 */

import { useMemo, useRef } from 'react';
import { useStore, createStore, type StoreApi } from 'zustand';

import type { ChatStore, Message, Block } from '@/features/chat/core/types';
import {
  selectLastAssistantMessage,
  selectLastUserMessage,
  selectMessageBlocks,
  selectModeState,
} from '@/features/chat/core/store/selectors';
import type { AnalysisResultData, AnalysisPhase } from './AnalysisResultView';

type ChatStoreApi = StoreApi<ChatStore>;

/** 解析结果的完整取数结果 */
export interface AnalysisResultState {
  /** 喂给 AnalysisResultView 的数据；无会话 / 无 AI 消息时为 null */
  data: AnalysisResultData | null;
  /** 与 AnalysisResultView 四态对齐 */
  phase: AnalysisPhase;
  /** 是否真实处于流式输出中（透传给 StreamingMarkdownRenderer） */
  isStreaming: boolean;
  /** 错误信息（phase === 'error' 时有值） */
  error: string | null;
  /** 会话是否已从后端加载完；false 时上层应显示加载态而非空态 */
  isDataLoaded: boolean;
  /**
   * 当前会话 id（无会话为 null）。
   *
   * 单独暴露是为了让消费方拿到**响应式**的会话标识：直接从
   * `store.getState().sessionId` 读是非响应式的——store 切换会话时
   * 组件不会因此重渲染，拿到的是过期值。本字段经 `useStore` 订阅，
   * 会话变化会正确触发重渲染。
   */
  sessionId: string | null;
}

// ============================================================================
// 纯函数部分（可独立单测，不依赖 React）
// ============================================================================

/** 从消息的块列表里取第一个 content 块的正文 */
export function pickContentText(blocks: readonly Block[] | undefined): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'content') continue;
    const text = typeof block.content === 'string' ? block.content.trim() : '';
    if (text.length > 0) return text;
  }
  return null;
}

/** 从消息的块列表里取第一个 error（块级错误优先于消息级） */
export function pickBlockError(blocks: readonly Block[] | undefined): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const err = typeof block.error === 'string' ? block.error.trim() : '';
    if (err.length > 0) return err;
  }
  return null;
}

/** 该消息的正文块是否仍在流式（blockId 在 activeBlockIds 中） */
export function isMessageBlockActive(
  blocks: readonly Block[] | undefined,
  activeBlockIds: ReadonlySet<string> | undefined,
): boolean {
  if (!blocks || !activeBlockIds || activeBlockIds.size === 0) return false;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'content') continue;
    if (activeBlockIds.has(block.id)) return true;
  }
  return false;
}

/** 从 analysis 模式 modeState 里安全取 ocrMeta.question（结构未知，全部防御） */
export function pickOcrQuestion(modeState: unknown): string | null {
  if (!modeState || typeof modeState !== 'object') return null;
  const ocrMeta = (modeState as { ocrMeta?: unknown }).ocrMeta;
  if (!ocrMeta || typeof ocrMeta !== 'object') return null;
  const question = (ocrMeta as { question?: unknown }).question;
  if (typeof question !== 'string') return null;
  const trimmed = question.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 纯函数核心：由 store 快照推导 AnalysisResultState。
 *
 * 抽成纯函数是为了让单测直接喂 store 形状的对象验证数据流转，
 * 不必挂载整个 Chat 应用（也便于断言五种状态的判定优先级）。
 */
export function deriveAnalysisResultState(input: {
  sessionId: string | null | undefined;
  isDataLoaded: boolean;
  sessionStatus: string;
  lastAssistant: Message | undefined;
  lastUser: Message | undefined;
  assistantBlocks: readonly Block[] | undefined;
  userBlocks: readonly Block[] | undefined;
  activeBlockIds: ReadonlySet<string> | undefined;
  modeState: unknown;
}): AnalysisResultState {
  const {
    sessionId, isDataLoaded, sessionStatus,
    lastAssistant, lastUser, assistantBlocks, userBlocks, activeBlockIds, modeState,
  } = input;

  const streaming = sessionStatus === 'streaming';

  // ① 无会话 → 空态
  if (!sessionId) {
    return { data: null, phase: 'empty', isStreaming: false, error: null, isDataLoaded, sessionId: sessionId ?? null };
  }

  // ② 数据未加载完 → 加载态（避免把「还没拉到」误报成「没有」）
  if (!isDataLoaded) {
    return { data: null, phase: 'loading', isStreaming: streaming, error: null, isDataLoaded, sessionId: sessionId ?? null };
  }

  // ③ 无 AI 消息：若仍在流式，说明 AI 消息还没落库 → 加载态；否则空态
  if (!lastAssistant) {
    return {
      data: null,
      phase: streaming ? 'loading' : 'empty',
      isStreaming: streaming,
      error: null,
      isDataLoaded,
      sessionId: sessionId ?? null,
    };
  }

  // ④ 消息级终止错误（`MessageMeta.terminalError`，见 types/message.ts:325）
  const terminalError = typeof lastAssistant._meta?.terminalError === 'string'
    ? lastAssistant._meta.terminalError.trim()
    : '';
  if (terminalError.length > 0) {
    return {
      data: null, phase: 'error', isStreaming: false, error: terminalError, isDataLoaded,
      sessionId: sessionId ?? null,
    };
  }

  const answer = pickContentText(assistantBlocks);
  const blockError = pickBlockError(assistantBlocks);

  // ⑤ 块级错误且无正文 → 错误态
  if (!answer && blockError) {
    return { data: null, phase: 'error', isStreaming: false, error: blockError, isDataLoaded, sessionId: sessionId ?? null };
  }

  // ⑥ 有正文但块报错 → 仍展示正文，错误随 data 带上（不抢占正文）
  const question = pickOcrQuestion(modeState) ?? pickContentText(userBlocks);
  const tags = pickOcrTags(modeState);

  const hasAnything = Boolean(answer || question || tags.length > 0);

  // ⑦ 无任何可展示内容：流式中算加载态，否则空态
  if (!hasAnything) {
    return {
      data: null,
      phase: streaming ? 'loading' : 'empty',
      isStreaming: streaming,
      error: blockError,
      isDataLoaded,
      sessionId: sessionId ?? null,
    };
  }

  const data: AnalysisResultData = {
    question,
    answer: answer ?? null,
    tags,
    imageCount: countImages(modeState),
  };

  return {
    data,
    phase: 'ready',
    isStreaming: streaming && isMessageBlockActive(assistantBlocks, activeBlockIds),
    error: blockError,
    isDataLoaded,
    sessionId: sessionId ?? null,
  };
}

/** 从 analysis modeState 安全取 ocrMeta.tags */
function pickOcrTags(modeState: unknown): string[] {
  if (!modeState || typeof modeState !== 'object') return [];
  const ocrMeta = (modeState as { ocrMeta?: unknown }).ocrMeta;
  if (!ocrMeta || typeof ocrMeta !== 'object') return [];
  const raw = (ocrMeta as { tags?: unknown }).tags;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 从 analysis modeState 安全取图片数量 */
function countImages(modeState: unknown): number | null {
  if (!modeState || typeof modeState !== 'object') return null;
  const images = (modeState as { images?: unknown }).images;
  if (!Array.isArray(images)) return null;
  return images.length;
}

// ============================================================================
// Hook
// ============================================================================

/** 无 store 时使用的常量空快照：保持引用永恒稳定，避免 useStore 判定变化 */
interface AnalysisSnapshot {
  assistant: Message | undefined;
  user: Message | undefined;
  assistantBlocks: readonly Block[];
  userBlocks: readonly Block[];
  activeBlockIds: ReadonlySet<string>;
  modeState: unknown;
}

const EMPTY_SNAPSHOT: AnalysisSnapshot = {
  assistant: undefined,
  user: undefined,
  assistantBlocks: [],
  userBlocks: [],
  activeBlockIds: new Set<string>(),
  modeState: null,
};

/**
 * 从 store 状态提取派生快照。
 *
 * ⚠️ zustand v5 用 `Object.is` 比较 selector 返回值：**每次调用返回新对象会被
 * 判定为「已变化」**，配合 `useSyncExternalStore` 在 commit 阶段触发的重渲染
 * 形成无限循环（实测报 `Maximum update depth exceeded`）。因此这里用上一份
 * 结果做逐字段比较，值全同则**复用旧对象引用**——与上游
 * `useChatStore.ts:278` 的 `lookupBlocksIfChanged` 同一套身份快路径思路。
 */
/**
 * 从 store 状态提取派生的消息快照。
 *
 * ⚠️ zustand v5 用 `Object.is` 比较 selector 返回值：**每次调用返回新对象会被
 * 判定为「已变化」**，配合 `useSyncExternalStore` 在 commit 阶段触发的重渲染
 * 形成无限循环（实测报 `Maximum update depth exceeded`）。因此这里用「上一份
 * 结果」做逐字段比较，值全同则**复用旧对象引用**——与上游
 * `useChatStore.ts:278` 的 `lookupBlocksIfChanged` 同一套身份快路径思路。
 *
 * 缓存通过 `prevRef` 传入，**每个 hook 实例独立持有**（模块级单例会跨会话串台）。
 */
function makeAnalysisSnapshotSelector(
  prevRef: { current: AnalysisSnapshot },
): (s: ChatStore) => AnalysisSnapshot {
  return (s: ChatStore): AnalysisSnapshot => {
    const assistant = selectLastAssistantMessage(s);
    const user = selectLastUserMessage(s);
    const assistantBlocks = assistant
      ? selectMessageBlocks(assistant.id)(s)
      : EMPTY_SNAPSHOT.assistantBlocks;
    const userBlocks = user
      ? selectMessageBlocks(user.id)(s)
      : EMPTY_SNAPSHOT.userBlocks;

    const prev = prevRef.current;
    if (
      prev.assistant === assistant
      && prev.user === user
      && prev.activeBlockIds === s.activeBlockIds
      && prev.modeState === s.modeState
      && readonlyArraysEqual(prev.assistantBlocks, assistantBlocks)
      && readonlyArraysEqual(prev.userBlocks, userBlocks)
    ) {
      return prev;
    }

    const next: AnalysisSnapshot = {
      assistant, user, assistantBlocks, userBlocks,
      activeBlockIds: s.activeBlockIds,
      modeState: selectModeState(s),
    };
    prevRef.current = next;
    return next;
  };
}

function readonlyArraysEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 订阅 chat store，返回解析结果视图所需的状态。
 *
 * 实现要点：**只挂一次带快照缓存的 `useStore`** 取消息/块，会话级字段各自
 * 用标量 selector 订阅（标量天然稳定，不会触发放大重渲染）。store 为 null 时
 * 传入稳定的空 store 以保证 hook 调用顺序恒定（Rules of Hooks），并在
 * selector 内由 `hasStore` 短路。
 *
 * @param store - 会话的 ChatStore 实例；传 null 时返回空态（无会话）
 */
export function useAnalysisResultData(store: ChatStoreApi | null | undefined): AnalysisResultState {
  const hasStore = Boolean(store);

  const prevSnapshotRef = useRef<AnalysisSnapshot>(EMPTY_SNAPSHOT);

  // store 为 null 时用一个稳定的空 store 占位（引用只创建一次）。
  // 必须给出 selectLastAssistantMessage 等 selector 依赖的最小真实形状，
  // 否则 shape 缺失会在派生时抛 TypeError。
  const fallbackStore = useMemo(
    () => createStore<ChatStore>(() => ({
      ...(EMPTY_SNAPSHOT as unknown as Record<string, unknown>),
      sessionId: '',
      isDataLoaded: false,
      sessionStatus: 'idle',
      messageOrder: [],
      messageMap: new Map(),
      blocks: new Map(),
      activeBlockIds: new Set<string>(),
      modeState: null,
    } as unknown as ChatStore)),
    [],
  );
  const effectiveStore = store ?? fallbackStore;

  // 快照 selector 随 effectiveStore 变化重建；prevSnapshotRef 跨重建保留缓存
  const snapshotSelector = useMemo(
    () => makeAnalysisSnapshotSelector(prevSnapshotRef),
    [effectiveStore],
  );

  const snapshot = useStore(effectiveStore, snapshotSelector);
  const sessionId = useStore(effectiveStore, (s) => (hasStore ? (s?.sessionId ?? '') : ''));
  const isDataLoaded = useStore(effectiveStore, (s) => (hasStore ? Boolean(s?.isDataLoaded) : false));
  const sessionStatus = useStore(effectiveStore, (s) => (hasStore ? (s?.sessionStatus ?? 'idle') : 'idle'));

  return useMemo(
    () =>
      deriveAnalysisResultState({
        sessionId: hasStore ? sessionId : null,
        isDataLoaded: hasStore ? isDataLoaded : false,
        sessionStatus: hasStore ? sessionStatus : 'idle',
        lastAssistant: snapshot.assistant,
        lastUser: snapshot.user,
        assistantBlocks: snapshot.assistantBlocks,
        userBlocks: snapshot.userBlocks,
        activeBlockIds: snapshot.activeBlockIds,
        modeState: snapshot.modeState,
      }),
    [
      hasStore, sessionId, isDataLoaded, sessionStatus,
      snapshot.assistant, snapshot.user, snapshot.assistantBlocks,
      snapshot.userBlocks, snapshot.activeBlockIds, snapshot.modeState,
    ],
  );
}
