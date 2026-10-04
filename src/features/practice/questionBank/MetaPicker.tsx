/**
 * MetaPicker —— 题库维度选择器（E8，用户反馈 ③ 的「自己定类型」）
 *
 * ## 定位
 * 「自己定类型」的语义是**按知识点、单元自选范围**（`PracticeHubPage.tsx:10`），
 * 需要一个能选「学科 → 年级 → 版次 → 章节 / 知识点」的控件。本组件提供
 * **单个 kind 的单选列表**，组合由调用方负责 —— 组件不知道维度的层级关系，
 * 那属于页面编排（以及题库侧 `subject_id` 等参数的耦合），不是控件的职责。
 *
 * ## 为什么是「受控 + 内部自取数」而不是纯展示组件
 * 纯展示组件要求调用方为 5 个 kind 各写一遍 `useEffect` 取数 + 3 态分支，
 * 而这段逻辑对每个 kind 完全一致（唯一变量是 `kind` 与 `params`）。
 * 故把取数收进来，调用方只传 `kind` 与被选中的级联参数。
 * `value` / `onChange` 仍是受控的 —— 选中态归调用方，便于「换学科时清空下级」。
 *
 * ## 加载态为什么是必须的（不是可选的修饰）
 * 实测 `/v1/meta/*` 首次请求 **10.6 秒**（tizhuang 上游冷启动）。若只渲染一个
 * 空列表，用户会认为「没有选项」而不是「正在加载」—— 本项目用户反复反馈的
 * 一类问题（见 `MistakeDetailPage.tsx:354` 的同款告诫）。故请求发出后**同帧**
 * 进 `loading` 态，且加载态带 `role="status"` 供读屏播报。
 *
 * ## 四种状态互斥且必须区分（不是三态）
 * | 状态 | 触发 | 渲染 |
 * |---|---|---|
 * | `loading` | 请求在途 | 骨架/spinner |
 * | `unconfigured` | 未配置题库（**不发请求**） | 「去配置」引导 |
 * | `error` | 请求抛错 | 错误文案 + 重试 |
 * | `zero` | 成功但该维度无值 | 空态文案（**不是错误**） |
 * | `ok` | 成功且有值 | 选项列表 |
 * `zero` 与 `error` 必须分开：前者是「这个学科下确实没有知识点」（正常业务结果，
 * 不该给重试按钮），后者是网络/后端故障（该给重试）。合并会让用户对着
 * 「没有数据」反复点重试，或者对着网络错误以为题库是空的。
 *
 * ## 与 Rust 的实测约束（调用方必读）
 * Rust 命令 `question_bank_list_meta` 当前**只透传 `kind`**，不转发 query
 * （`src-tauri/src/cmd/question_bank.rs:999-1001`）。而上游对
 * `editions` / `chapters` / `knowledge-points` **强制要求 `subject_id`**
 * （实测缺省返回 FastAPI 422）。因此：
 * - 传 `params.subjectId` 是**面向未来正确**的写法（Rust 补透传后即刻生效）
 * - 但在当前版本，这三个 kind 会走到 `error` 态 —— 这是 Rust 层的缺陷，
 *   不是本组件或调用参数的问题。`subjects` / `grades` 无参可用，实测正常。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronRight, Loader2, RefreshCw, Settings2 } from 'lucide-react';

import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import {
  fetchQuestionBankMetaOutcome,
  type BankMetaItem,
  type BankMetaKind,
  type BankMetaParams,
} from './bankClient';

/** 选中值：与 `BankMetaItem.id` 同型（实测 id 恒为 number，但契约允许 string） */
export type MetaSelection = number | string | null;

export interface MetaPickerProps {
  /** 要拉取的维度 */
  kind: BankMetaKind;
  /** 级联参数（如学科下的年级/知识点选择传 `subjectId`） */
  params?: BankMetaParams;
  /** 当前选中项；`null` = 未选 */
  value?: MetaSelection;
  /** 选中变化。传 `null` 表示取消选择 */
  onChange?: (id: MetaSelection, item: BankMetaItem | null) => void;
  /** 标题（如「学科」）。缺省时按 `kind` 取内置文案 */
  label?: string;
  /**
   * 题库是否已配置。
   * - `false`：**不发请求**，直接渲染「去配置」引导
   * - `undefined`：调用方不掌握配置状态 → 不拦截，交给后端裁决
   */
  isConfigured?: boolean;
  /** 点击「去配置」 */
  onConfigure?: () => void;
  /** 是否展示加载态（默认 true）。仅调试/测试时可关 */
  showLoading?: boolean;
  className?: string;
  /** 无选中项时的占位文案 */
  emptySelectionHint?: string;
}

// ============================================================================
// 内置文案
// ============================================================================

/**
 * kind → 默认标题。
 *
 * 走 `t(key, default)` 双参形式（与 `PracticeHubPage.tsx:78` 一致）：
 * 缺翻译时回落内置中文，而不是把 key 甩到界面上。
 */
const KIND_LABEL_KEY: Record<BankMetaKind, string> = {
  subjects: 'practiceHub.metaPicker.subjects',
  grades: 'practiceHub.metaPicker.grades',
  editions: 'practiceHub.metaPicker.editions',
  chapters: 'practiceHub.metaPicker.chapters',
  'knowledge-points': 'practiceHub.metaPicker.knowledgePoints',
};

const KIND_LABEL_DEFAULT: Record<BankMetaKind, string> = {
  subjects: '学科',
  grades: '年级',
  editions: '教材版本',
  chapters: '章节',
  'knowledge-points': '知识点',
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }
  | { kind: 'zero' }
  | { kind: 'ok'; items: BankMetaItem[] };

/**
 * 稳定比较级联参数。
 *
 * `params` 通常是调用方 inline 构造的对象（每次渲染新引用），
 * 若直接作为 `useEffect` 依赖会导致**无限取数循环**。故序列化成字符串比较。
 * 用固定字段顺序 —— `JSON.stringify` 的对象键序取决于插入顺序，
 * 调用方换个写法就会误判为「参数变了」。
 */
function serializeParams(params?: BankMetaParams): string {
  if (!params) return '';
  const keys: Array<keyof BankMetaParams> = ['subjectId', 'gradeId', 'parentId', 'editionId'];
  return keys
    .map((k) => `${k}=${params[k] ?? ''}`)
    .join('&');
}

export function MetaPicker({
  kind,
  params,
  value = null,
  onChange,
  label,
  isConfigured,
  onConfigure,
  showLoading = true,
  className,
  emptySelectionHint,
}: MetaPickerProps): React.ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<ViewState>(() =>
    isConfigured === false ? { kind: 'unconfigured' } : { kind: 'loading' },
  );
  /** 手动重试令牌：自增即触发重新取数 */
  const [retryToken, setRetryToken] = useState(0);

  const paramsKey = serializeParams(params);

  /**
   * 竞态防护：级联选择会让用户快速切换学科，前一个请求可能后到。
   * 用「本次请求序号」判定，只接受最后一次发起的响应。
   * 不用 `AbortController` —— Tauri invoke 不支持取消，序号是这里唯一有效的手段。
   */
  const requestSeqRef = useRef(0);

  /**
   * 过期参数防护（比竞态更隐蔽的一类错）：
   * 用户切到「学科 B」后，`subjects` 的响应回来时**语义已变**。
   * 用 `value` 兜底 —— 若 `kind` 与参数都没变而选中项不在新列表里，
   * 说明数据被换过，交给渲染层处理（下方 `selectedItem` 为 `null` 时不高亮）。
   */
  const stableParams = useMemo(() => params, [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (isConfigured === false) {
      setState({ kind: 'unconfigured' });
      return;
    }
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    if (showLoading) setState({ kind: 'loading' });

    const outcome = await fetchQuestionBankMetaOutcome(kind, stableParams, { isConfigured });
    // 迟到的响应直接丢弃：绝不能覆盖更新一次的请求结果
    if (requestSeqRef.current !== seq) return;

    switch (outcome.kind) {
      case 'ok':
        setState({ kind: 'ok', items: outcome.items });
        break;
      case 'zero':
        setState({ kind: 'zero' });
        break;
      case 'unconfigured':
        setState({ kind: 'unconfigured' });
        break;
      case 'error':
        setState({ kind: 'error', message: outcome.message });
        break;
    }
  }, [kind, stableParams, isConfigured, showLoading]);

  useEffect(() => {
    void load();
  }, [load, retryToken]);

  const handleRetry = useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  const items = state.kind === 'ok' ? state.items : [];

  /**
   * 选中项可能不在当前列表里（换上级维度后的残留选择）。
   * 此时不高亮任何项，但也不主动回调 `onChange` ——
   * 在渲染期改父组件状态会引发 React 警告与潜在循环，清空由调用方在自己的
   * 级联逻辑里做（它才知道该不该清）。
   */
  const selectedItem = useMemo(
    () => items.find((it) => it.id === value) ?? null,
    [items, value],
  );

  const resolvedLabel = label ?? t(KIND_LABEL_KEY[kind], KIND_LABEL_DEFAULT[kind]);

  const handleSelect = useCallback(
    (item: BankMetaItem) => {
      if (!onChange) return;
      // 再点已选中的项 = 取消选择。移动端没有「取消选中」的常规手势，
      // 靠 toggle 提供出口，否则用户选错后必须重置整个流程。
      if (item.id === value) onChange(null, null);
      else onChange(item.id, item);
    },
    [onChange, value],
  );

  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      aria-label={resolvedLabel}
      data-testid={`meta-picker-${kind}`}
      data-meta-state={state.kind}
    >
      <header className="flex items-baseline justify-between gap-2 px-0.5">
        <h3 className="text-sm font-medium text-[color:var(--text-primary)]">{resolvedLabel}</h3>
        {state.kind === 'ok' && (
          <span className="text-xs text-[color:var(--text-tertiary)]">
            {t('practiceHub.metaPicker.count', '共 {{count}} 项', { count: items.length })}
          </span>
        )}
      </header>

      {state.kind === 'loading' && (
        <div
          role="status"
          aria-live="polite"
          data-testid={`meta-picker-${kind}-loading`}
          className="flex items-center gap-2 rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-3 text-sm text-[color:var(--text-secondary)]"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t('practiceHub.metaPicker.loading', '正在加载{{label}}…', { label: resolvedLabel })}
        </div>
      )}

      {state.kind === 'unconfigured' && (
        <div
          data-testid={`meta-picker-${kind}-unconfigured`}
          className="flex flex-col gap-2 rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-3"
        >
          <p className="text-sm text-[color:var(--text-secondary)]">
            {t('practiceHub.notConfiguredTitle', '题库 API 未配置')}
          </p>
          {onConfigure && (
            <button
              type="button"
              onClick={onConfigure}
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-[color:var(--accent-primary)]"
            >
              <Settings2 size={14} aria-hidden="true" />
              {t('practiceHub.goConfigure', '去配置')}
            </button>
          )}
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid={`meta-picker-${kind}-error`}
          className="flex flex-col gap-2 rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-3"
        >
          <p className="flex items-start gap-2 text-sm text-[color:var(--text-secondary)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {t('practiceHub.metaPicker.error', '{{label}}加载失败：{{msg}}', {
              label: resolvedLabel,
              msg: state.message,
            })}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-[color:var(--accent-primary)]"
          >
            <RefreshCw size={14} aria-hidden="true" />
            {t('common.retry', '重试')}
          </button>
        </div>
      )}

      {state.kind === 'zero' && (
        <p
          data-testid={`meta-picker-${kind}-empty`}
          className="rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] px-3 py-3 text-sm text-[color:var(--text-tertiary)]"
        >
          {t('practiceHub.metaPicker.empty', '暂无可选的{{label}}', { label: resolvedLabel })}
        </p>
      )}

      {state.kind === 'ok' && (
        <>
          {emptySelectionHint && !selectedItem && (
            <p className="px-0.5 text-xs text-[color:var(--text-tertiary)]">
              {emptySelectionHint}
            </p>
          )}
          <ul
            className="flex max-h-72 flex-col gap-1 overflow-y-auto overscroll-contain"
            role="listbox"
            aria-label={resolvedLabel}
          >
            {items.map((item) => {
              const selected = item.id === value;
              return (
                <li key={String(item.id)} className="shrink-0">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-testid={`meta-picker-${kind}-option-${item.id}`}
                    onClick={() => handleSelect(item)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-[var(--radius-shell-control)]',
                      'px-3 py-2.5 text-left text-sm transition-colors',
                      // 触屏 ≥44px 命中高度（与 SegmentedControl 同款约定）
                      '[@media(pointer:coarse)]:min-h-11',
                      selected
                        ? 'bg-[color:var(--accent-primary)]/12 font-medium text-[color:var(--accent-primary)]'
                        : 'text-[color:var(--text-primary)] hover:bg-[color:var(--surface-muted)]',
                    )}
                  >
                    <span className="min-w-0 truncate">{item.name}</span>
                    {selected && <ChevronRight size={14} className="shrink-0" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export default MetaPicker;
