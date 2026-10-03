/**
 * ErrorCauseFilter — 错因筛选器（A4 轮 · task-4）
 *
 * 让用户按 4 个**派生**错因筛出错题。判定规则见 `./errorCauseRules`。
 *
 * ## 为什么是「筛选器」而不是「错因标签选择器」
 *
 * 上游的错因是**从作答统计推导出来的只读结论**
 * （`ReviewQuestionsView.tsx:31` 注释原文「由作答统计推导，无需后端字段」，
 * 逻辑在 `:41-64`），`Question` 数据模型（`src/api/questionBankApi.ts:164-191`）
 * 里**没有任何错因字段**，唯一自由标签字段 `tags` 是只读筛选维度
 * （写路径不存在，见 `questionBankApi.ts:431-432` 的消费方式）。
 *
 * 因此「让用户选错因存进去」需要先造数据模型（越界）；而「按已有错因筛选」
 * 零数据模型改动，是真实可交付的增量。本组件实现后者。
 *
 * ## 受控组件契约
 *
 * `selected` 进、`onChange` 出，组件内**不持有**选中状态——与
 * `ApiErrorPanel` / `AnalysisResultView` 的纯受控风格一致。
 * 选中集合的持久化（写 store / URL / 内存）由宿主决定。
 *
 * ## 筛选语义：多选 OR
 *
 * 详见 `errorCauseRules.matchesErrorCauseFilter` 的注释。要点：
 * 错因是叠加标签（单题可同时「反复错」+「久未复习」），且前三个错因互斥，
 * 用 AND 会产出必然为空的组合，用户会当成 bug。
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  ERROR_CAUSE_ORDER,
  type ErrorCause,
} from './errorCauseRules';

/**
 * 与上游 `ReviewQuestionsView.tsx:88-93` 的 `ERROR_CAUSE_STYLE` 逐项同源，
 * 保证筛选器与列表里的错因标签**视觉可对应**（同一错因同一配色）。
 *
 * 差异说明：上游是「只读小徽章」（`text-[10px]` 静态展示）；本组件是
 * 可点选的筛选按钮，因此把同一组颜色用作**选中态**配色，未选中态走中性灰。
 */
const ERROR_CAUSE_STYLE: Record<ErrorCause, string> = {
  neverCorrect: 'bg-destructive/10 text-destructive',
  repeatedErrors: 'bg-warning/10 text-warning',
  highErrorRate: 'bg-warning/10 text-warning',
  stale: 'bg-info/10 text-info',
};

export interface ErrorCauseFilterProps {
  /** 当前选中的错因集合（受控）。空集 = 不筛选（全部通过） */
  selected: readonly ErrorCause[];
  /** 选中集合变化。传出**新数组**，不就地修改入参 */
  onChange: (next: ErrorCause[]) => void;
  /** 整体禁用（如筛选面板只读态/加载态） */
  disabled?: boolean;
  /**
   * 各错因对应的命中数量，用于在格子上显示角标。
   * 可选：不传则不渲染角标（宿主未必总是算得出计数）。
   */
  counts?: Partial<Record<ErrorCause, number>>;
  className?: string;
}

export const ErrorCauseFilter: React.FC<ErrorCauseFilterProps> = ({
  selected,
  onChange,
  disabled = false,
  counts,
  className,
}) => {
  const { t } = useTranslation(['review', 'common']);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const toggle = useCallback(
    (cause: ErrorCause) => {
      if (disabled) return;
      // 派生新数组，不改入参——受控组件的回调必须无副作用。
      // 顺序统一按 ERROR_CAUSE_ORDER，避免选中顺序影响下游比较（如 effect 依赖）。
      const next = new Set(selectedSet);
      if (next.has(cause)) {
        next.delete(cause);
      } else {
        next.add(cause);
      }
      onChange(ERROR_CAUSE_ORDER.filter((c) => next.has(c)));
    },
    [disabled, onChange, selectedSet],
  );

  const handleClear = useCallback(() => {
    if (disabled) return;
    onChange([]);
  }, [disabled, onChange]);

  const hasSelection = selectedSet.size > 0;

  return (
    <div
      data-error-cause-filter=""
      data-selected-count={selectedSet.size}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {ERROR_CAUSE_ORDER.map((cause) => {
        const isActive = selectedSet.has(cause);
        const count = counts?.[cause];

        return (
          <button
            key={cause}
            type="button"
            data-error-cause={cause}
            data-active={isActive ? 'true' : undefined}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => toggle(cause)}
            className={cn(
              // 触控目标：coarse 指针下 44px（min-h-11 = 2.75rem），
              // 与 MobileTabBar.tsx 的 min-h-11 同口径（Apple HIG / Material 底线）。
              // 细指针场景保持紧凑高度，避免桌面端出现臃肿条。
              'inline-flex min-h-11 items-center gap-1 rounded-pill px-3',
              'text-[12px] font-medium leading-none',
              'outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? ERROR_CAUSE_STYLE[cause]
                : 'bg-muted/50 text-muted-foreground hover:bg-muted',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {t(`review:questions.errorCause.${cause}`)}
            {typeof count === 'number' && (
              // 角标用 tabular-nums：数字宽度一致，多格子并排时不抖
              <span className="text-[10px] tabular-nums opacity-70">{count}</span>
            )}
          </button>
        );
      })}

      {/* 清除按钮只在有选中时出现：无选中时它无意义，且会占掉窄屏一行 */}
      {hasSelection && (
        <button
          type="button"
          data-error-cause-clear=""
          disabled={disabled}
          onClick={handleClear}
          className={cn(
            'inline-flex min-h-11 items-center rounded-pill px-3',
            'text-[12px] leading-none text-muted-foreground underline-offset-2 hover:underline',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {/* 复用既有的 common:clear（common.json:22「清除」），不新建重复键 */}
          {t('common:clear')}
        </button>
      )}
    </div>
  );
};

export default ErrorCauseFilter;
