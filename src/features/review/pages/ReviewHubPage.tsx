/**
 * ReviewHubPage — 复习入口页（A5）
 *
 * ## 定位
 * 复习 Tab 的落地页。此前该 Tab 直接落 `flashcards`，只覆盖「单词卡片」
 * 一项；用户规格要求复习下有四类入口：
 *   错题本 / 单词卡片 / 易错点 / 刷题
 * 本页只做**分发**，不承载具体业务——每项的二级内容由各自既有模块负责。
 *
 * ## 四入口的数据现状（源码实证）
 * - 错题本：新做（`useMistakeBook`），数据源 = `mode==='analysis'` 的 chat 会话。
 *   这是唯一此前没有入口的一类，也是「拍题 → 解析 → 错题」链路的落点。
 * - 单词卡片：跳现役 `flashcards` 视图（`src/features/flashcards/`）。
 * - 易错点：跳现役 `flashcards` 的错因维度（复用 `ErrorCauseFilter` 资产）。
 * - 刷题：跳现役 `practice` 模块。
 *
 * ⚠️ 命名约束：视图 id 用 `review-hub` 而非 `review`。
 *   `canonicalView.ts` 的 DEPRECATED_VIEW_MAP 里 `review` 是历史废弃视图名，
 *   会被静默重定向到 `chat-v2`。
 */

import React, { useCallback, useMemo } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import {
  StudyBooksIcon,
  StudyCardsIcon,
  StudyMagicWandIcon,
  StudyStackIcon,
} from '@/components/icons/StudySidebarIcons';
import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import type { CurrentView } from '@/types/navigation';
import { useMistakeBook } from '../hooks/useMistakeBook';

export interface ReviewHubPageProps {
  /** 返回回调；不传则不显示返回箭头（Tab 根页通常不需要） */
  onBack?: () => void;
  /** 导航到某个视图（由宿主注入，复用 App 的 setCurrentView） */
  onNavigate?: (view: CurrentView) => void;
  className?: string;
}

/** 入口卡片定义：id 用于 testid，view 为 null 表示「打开错题本子页」 */
interface HubEntry {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  /** 目标视图；null 表示在本页内展开（仅错题本） */
  view: CurrentView | null;
  /** 数量角标数据源：'mistakes' 时用错题本条目数 */
  countKey?: 'mistakes';
  accentClass: string;
}

const HUB_ENTRIES: readonly HubEntry[] = [
  {
    id: 'mistakes',
    title: '错题本',
    subtitle: '拍过的题与解析',
    icon: StudyMagicWandIcon,
    view: null,
    countKey: 'mistakes',
    accentClass: 'text-primary',
  },
  {
    id: 'flashcards',
    title: '单词卡片',
    subtitle: '闪卡复习与背诵',
    icon: StudyCardsIcon,
    view: 'flashcards',
    accentClass: 'text-sky-500',
  },
  {
    id: 'weak-points',
    title: '易错点',
    subtitle: '按错因归类复盘',
    icon: StudyStackIcon,
    view: 'flashcards',
    accentClass: 'text-amber-500',
  },
  {
    id: 'practice',
    title: '刷题',
    subtitle: '专项练习与巩固',
    icon: StudyBooksIcon,
    view: 'flashcards',
    accentClass: 'text-emerald-500',
  },
];

export const ReviewHubPage: React.FC<ReviewHubPageProps> = ({
  onBack,
  onNavigate,
  className,
}) => {
  const { t } = useTranslation();
  const { entries, isLoading, error, isLoaded } = useMistakeBook();

  const headerTitle = t('reviewHub.title', '复习');

  useMobileHeader(
    'review-hub',
    {
      title: headerTitle,
      showBackArrow: Boolean(onBack),
      onMenuClick: onBack,
    },
    [headerTitle, onBack],
  );

  // 错题本条目数：加载中不显示数字（避免闪 0），加载失败显示 0 但由错误条兜底解释
  const mistakeCount = useMemo(
    () => (isLoaded && !error ? entries.length : null),
    [isLoaded, error, entries.length],
  );

  const handleEntryClick = useCallback(
    (entry: HubEntry) => {
      if (!entry.view) return;
      onNavigate?.(entry.view);
    },
    [onNavigate],
  );

  return (
    <div
      data-testid="review-hub-page"
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {onBack && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onBack}
            aria-label={t('reviewHub.back', '返回')}
            data-testid="review-hub-back"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </DsButton>
        )}
        <h1 className="flex-1 truncate text-base font-medium text-foreground">{headerTitle}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* 加载失败：可重试的错误条，不把「失败」伪装成「没有错题」 */}
        {error && (
          <div
            data-testid="review-hub-error"
            className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {t('reviewHub.loadFailed', '错题本加载失败：{{msg}}', { msg: error })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {HUB_ENTRIES.map((entry) => {
            const Icon = entry.icon;
            const count = entry.countKey === 'mistakes' ? mistakeCount : null;
            return (
              <button
                key={entry.id}
                type="button"
                data-testid={`review-hub-entry-${entry.id}`}
                onClick={() => handleEntryClick(entry)}
                disabled={entry.view === null}
                className={cn(
                  'flex min-h-[104px] flex-col justify-between rounded-xl border border-border p-3 text-left',
                  'bg-card transition-colors',
                  // 错题本本轮为占位（view === null）：禁用态但仍可读，避免假可点
                  entry.view === null
                    ? 'cursor-default opacity-60'
                    : 'hover:bg-accent active:bg-accent',
                )}
                aria-label={entry.title}
              >
                <div className="flex items-start justify-between">
                  <Icon className={cn('size-5', entry.accentClass)} strokeWidth={2.2} />
                  {count !== null && (
                    <span
                      data-testid={`review-hub-count-${entry.id}`}
                      className="text-xs tabular-nums text-muted-foreground"
                    >
                      {count}
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  <div className="flex items-center gap-1 text-sm font-medium text-foreground">
                    <span>{entry.title}</span>
                    {entry.view !== null && (
                      <ArrowRight size={13} className="text-muted-foreground" aria-hidden="true" />
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {entry.subtitle}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* 错题本预览：本轮做到列表页，故在入口页下方直接给出条目预览 */}
        <section className="mt-4" data-testid="review-hub-mistake-preview">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">
            {t('reviewHub.mistakePreview', '最近错题')}
          </h2>
          {isLoading && !isLoaded ? (
            <div
              data-testid="review-hub-mistake-loading"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {t('reviewHub.loading', '加载中…')}
            </div>
          ) : entries.length === 0 ? (
            <div
              data-testid="review-hub-mistake-empty"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {t('reviewHub.noMistakes', '还没有错题，去「拍题」试试')}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {entries.slice(0, 5).map((item) => (
                <li
                  key={item.sessionId}
                  data-testid={`review-hub-mistake-item-${item.sessionId}`}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span className="truncate text-sm text-foreground">{item.title}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {formatDate(item.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

/** 列表时间显示：只给「日期」粒度，避免小屏上过长的 ISO 串 */
function formatDate(iso: string): string {
  if (!iso) return '';
  const datePart = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart.slice(5) : '';
}

export default ReviewHubPage;
