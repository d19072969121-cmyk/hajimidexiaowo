/**
 * useQuestionBankConfig — 题库 API 配置的读写（E3）
 *
 * 走项目既有的 `get_setting` / `save_setting`（key-value 字符串），
 * 与 WebSearchAdvancedConfig 等既有配置的做法一致。
 *
 * ## 为什么用共享订阅而不是各组件各自 useState
 * 「设置里配置好 → 刷题页立刻知道已可用」需要跨组件同步。
 * 若每处各自 hook 各自 state，配置保存后刷题页不会更新（不同实例）。
 * 故用一个模块级 store + 订阅，任何一处保存都广播给所有消费方。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { getErrorMessage } from '@/utils/errorUtils';
import {
  DEFAULT_QUESTION_BANK_CONFIG,
  QUESTION_BANK_CONFIG_KEY,
  parseQuestionBankConfig,
  type QuestionBankConfig,
  type QuestionBankCredentials,
  type QuestionBankProviderId,
} from './config';

// ============================================================================
// 模块级共享状态（供跨组件同步）
// ============================================================================

type Listener = (config: QuestionBankConfig) => void;

let currentConfig: QuestionBankConfig = DEFAULT_QUESTION_BANK_CONFIG;
let loaded = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

/**
 * 提交一次变更。
 *
 * 接收**更新函数**而非值：调用方常在同一事件里连续改多项
 * （如先 `setProvider('cn21')` 再 `setCredential('cn21','accessKey',...)`）。
 * 若传值，第二个调用读到的 `currentConfig` 仍是这一 tick 开始时的旧对象，
 * 后一次 emit 会把前一次的改动覆盖掉——实测复现为 accessKey 丢失。
 * 传函数则由这里基于**当前最新** `currentConfig` 计算，天然无此问题。
 */
function emit(updater: (prev: QuestionBankConfig) => QuestionBankConfig): void {
  const next = updater(currentConfig);
  currentConfig = next;
  for (const listener of listeners) listener(next);
}

/**
 * 静默写入：只更新模块级快照，**不广播**。
 *
 * ## 为什么必须有这个区别（实测踩出来的）
 * `ensureLoaded` 从后端读回初始配置时，早期版本走 `emit` 广播。
 * 但订阅者可能已在读回**之前**改过配置——dirtyRef 只挡住了 `.then` 里的
 * 同步赋值，**挡不住广播通道**：那个组件自己也是订阅者，后端回程的广播
 * 会把用户刚写的内容经订阅覆盖回去（实测复现：provider 从 cn21 退回 null）。
 *
 * 语义上这也更对：从后端读回的初始值是「本进程的起点状态」，
 * 不是「一次变更事件」。让订阅方只在真正的变更时收到通知，
 * 首次加载各自从 `currentConfig` 取。
 *
 * ⚠️ 与 `emit` 的唯一区别就是**不广播**——语义上它是一次读取而非变更事件，
 *    若也广播，会把用户在后端回程前写好的配置经订阅覆盖回旧值。
 */
function emitSilently(updater: (prev: QuestionBankConfig) => QuestionBankConfig): void {
  currentConfig = updater(currentConfig);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 从后端读一次；并发调用共享同一个 promise，避免重复 IPC。
 *
 * ## 失败可重试
 * 早期版本在 `finally` 里无条件 `loaded = true`，导致 **首次失败后永久不再重试**
 * （DB busy / IPC 抖动 → 题库永久停在「未配置」，只能重启 App）。
 * 现在只在成功时置 `loaded = true`；失败保留可重试性，且不缓存失败的 promise。
 */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const raw = await invoke<string | null>('get_setting', { key: QUESTION_BANK_CONFIG_KEY });
      emitSilently(() => parseQuestionBankConfig(raw));
      // 仅成功才置位——失败保留重试机会（见上方说明）
      loaded = true;
    } catch (err) {
      // 读取失败视为未配置——不抛，让 UI 走「去配置」引导
      console.warn('[useQuestionBankConfig] 读取配置失败，按未配置处理:', getErrorMessage(err));
      emitSilently(() => DEFAULT_QUESTION_BANK_CONFIG);
      loaded = false;
    } finally {
      // 无论成败都清掉 in-flight promise，避免后续调用拿到已失败的旧 promise
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** 测试或登出时可重置模块级缓存，避免跨用例串台 */
export function resetQuestionBankConfigCache(): void {
  currentConfig = DEFAULT_QUESTION_BANK_CONFIG;
  loaded = false;
  loadPromise = null;
}

// ============================================================================
// Hook
// ============================================================================

export interface UseQuestionBankConfigResult {
  config: QuestionBankConfig;
  /** 已从后端读过一次（无论成败） */
  isLoaded: boolean;
  /** 正在保存 */
  isSaving: boolean;
  /** 保存失败原因 */
  error: string | null;
  /** 选中某来源（不立即持久化，由 save 落盘） */
  setProvider: (provider: QuestionBankProviderId | null) => void;
  /** 更新某来源的某字段 */
  setCredential: (
    provider: QuestionBankProviderId,
    fieldKey: string,
    value: string,
  ) => void;
  /** 整份替换某来源的凭据（如「一键填入沙箱」） */
  setCredentials: (
    provider: QuestionBankProviderId,
    credentials: QuestionBankCredentials,
  ) => void;
  /** 持久化到后端 */
  save: () => Promise<void>;
}

export function useQuestionBankConfig(): UseQuestionBankConfigResult {
  const [config, setConfig] = useState<QuestionBankConfig>(currentConfig);
  const [isLoaded, setIsLoaded] = useState(loaded);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 本组件实例是否已有「用户改动」。
   *
   * 用途：`ensureLoaded` 是异步的。若用户在它返回前就改了配置，
   * 返回时用后端值覆盖会把用户的输入冲掉。有此标记即可只接受后端值一次。
   */
  const dirtyRef = useRef(false);
  /** 组件是否仍挂载（异步回调里防 setState 到已卸载组件） */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe(setConfig);
    void ensureLoaded().then(() => {
      if (!mountedRef.current) return;
      setIsLoaded(true);
      // 只有「本实例尚无用户改动」时才接受后端读回的初始值。
      // 若本实例已改过配置，后端那趟回程不得覆盖它
      // （注意：ensureLoaded 走 emitSilently 不广播，所以覆盖只可能来自这里）。
      if (!dirtyRef.current) setConfig(currentConfig);
    });
    return unsubscribe;
  }, []);

  const setProvider = useCallback((provider: QuestionBankProviderId | null) => {
    dirtyRef.current = true;
    emit((prev) => ({ ...prev, provider }));
  }, []);

  const setCredential = useCallback(
    (provider: QuestionBankProviderId, fieldKey: string, value: string) => {
      dirtyRef.current = true;
      emit((prev) => {
        const existing = prev.credentials[provider] ?? {};
        return {
          ...prev,
          credentials: {
            ...prev.credentials,
            [provider]: { ...existing, [fieldKey]: value },
          },
        };
      });
    },
    [],
  );

  const setCredentials = useCallback(
    (provider: QuestionBankProviderId, credentials: QuestionBankCredentials) => {
      dirtyRef.current = true;
      emit((prev) => ({
        ...prev,
        credentials: { ...prev.credentials, [provider]: { ...credentials } },
      }));
    },
    [],
  );

  const save = useCallback(async () => {
    // 全部 setState 走 mountedRef 守卫：save 在途时用户可能已切走设置页，
    // 卸载后 setState 会触发 React 警告（早期只有 ensureLoaded 做了守卫）。
    if (!mountedRef.current) return;
    setIsSaving(true);
    setError(null);
    try {
      await invoke('save_setting', {
        key: QUESTION_BANK_CONFIG_KEY,
        value: JSON.stringify(currentConfig),
      });
      loaded = true;
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
      return;
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, []);

  return { config, isLoaded, isSaving, error, setProvider, setCredential, setCredentials, save };
}
