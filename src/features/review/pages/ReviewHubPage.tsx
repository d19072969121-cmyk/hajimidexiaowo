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

import React, { useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';

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
import { useSessionTags } from '@/features/chat/hooks/useSessionTags';
import { useMistakeBook, type MistakeBookEntryWithTags } from '../hooks/useMistakeBook';

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

  // 归类：标签状态复用 chat 侧现成的 useSessionTags（批量读取 + 增删 + 筛选），
  // 不在这里另造一套（否则归类 UI 加的标签与错题本副本会不同步）。
  const {
    allTags,
    tagsBySession,
    loadTagsForSessions,
    addTag,
    removeTag,
    selectedFilterTags,
    toggleFilterTag,
    clearFilter,
  } = useSessionTags();

  // 会话列表就绪后补齐这些会话的标签。依赖 entries 的 id 集合：
  // entries 每次刷新都是新数组，故用 join 后的字符串做依赖，避免无谓重拉。
  const sessionIdsKey = useMemo(
    () => entries.map((e) => e.sessionId).join(','),
    [entries],
  );

  useEffect(() => {
    if (!sessionIdsKey) return;
    void loadTagsForSessions(sessionIdsKey.split(','));
  }, [sessionIdsKey, loadTagsForSessions]);

  // 合并标签 + 应用筛选。筛选语义：选中标签间为「或」（任一命中即显示），
  // 与 chat 侧 SessionBrowser 的 TagFilter 行为一致。
  //
  // 标签不在 useMistakeBook 里（会话列表命令不返回 tags），
  // 由 useSessionTags.tagsBySession 在此合并 —— 见 MistakeBookEntryWithTags 注释。
  const visibleEntries: MistakeBookEntryWithTags[] = useMemo(() => {
    const withTags = entries.map((e) => ({
      ...e,
      tags: tagsBySession.get(e.sessionId) ?? [],
    }));
    if (selectedFilterTags.size === 0) return withTags;
    return withTags.filter((e) => e.tags.some((tag) => selectedFilterTags.has(tag)));
  }, [entries, tagsBySession, selectedFilterTags]);

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

        {/* 错题本：筛选条 + 条目（标签可增删，即「手动归类」） */}
        <section className="mt-4" data-testid="review-hub-mistake-preview">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium text-muted-foreground">
              {t('reviewHub.mistakePreview', '错题本')}
            </h2>
            {selectedFilterTags.size > 0 && (
              <button
                type="button"
                data-testid="review-hub-filter-clear"
                onClick={clearFilter}
                className="text-xs text-primary"
              >
                {t('reviewHub.clearFilter', '清除筛选')}
              </button>
            )}
          </div>

          {/* 筛选条：只列出现有标签。无标签时不占位（避免空框） */}
          {allTags.length > 0 && (
            <div
              data-testid="review-hub-tag-filter"
              className="mb-2 flex flex-wrap gap-1.5"
            >
              {allTags.map(({ tag, count: tagCount }) => {
                const active = selectedFilterTags.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    data-testid={`review-hub-filter-tag-${tag}`}
                    data-active={String(active)}
                    onClick={() => toggleFilterTag(tag)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {tag}
                    <span className="ml-1 tabular-nums opacity-60">{tagCount}</span>
                  </button>
                );
              })}
            </div>
          )}

          {isLoading && !isLoaded ? (
            <div
              data-testid="review-hub-mistake-loading"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {t('reviewHub.loading', '加载中…')}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div
              data-testid="review-hub-mistake-empty"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {entries.length > 0
                ? t('reviewHub.filterEmpty', '没有符合筛选的错题')
                : t('reviewHub.noMistakes', '还没有错题，去「拍题」试试')}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visibleEntries.slice(0, 20).map((item) => (
                <li
                  key={item.sessionId}
                  data-testid={`review-hub-mistake-item-${item.sessionId}`}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm text-foreground">{item.title}</span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {formatDate(item.updatedAt)}
                    </span>
                  </div>
                  {/* 标签行：每个标签带删除按钮 = 手动归类（移除）。
                      加标签走下方输入框。 */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        data-testid={`review-hub-mistake-tag-${item.sessionId}-${tag}`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground"
                      >
                        {tag}
                        <button
                          type="button"
                          aria-label={`移除标签 ${tag}`}
                          data-testid={`review-hub-untag-${item.sessionId}-${tag}`}
                          onClick={() => void removeTag(item.sessionId, tag)}
                          className="ml-0.5 opacity-60 hover:opacity-100"
                        >
                          <X size={11} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    <TagAdder
                      sessionId={item.sessionId}
                      onAdd={addTag}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

/**
 * 单个错题条目的「加标签」控件（手动归类的添加侧）。
 *
 * 交互：默认是一个「+ 标签」小按钮，点开变输入框；回车提交、Esc 取消、
 * 失焦提交。这样列表默认干净，需要归类时才展开。
 */
const TagAdder: React.FC<{
  sessionId: string;
  onAdd: (sessionId: string, tag: string) => Promise<void>;
}> = ({ sessionId, onAdd }) => {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = React.useCallback(() => {
    const tag = value.trim();
    setValue('');
    setEditing(false);
    if (tag) void onAdd(sessionId, tag);
  }, [value, onAdd, sessionId]);

  if (!editing) {
    return (
      <button
        type="button"
        data-testid={`review-hub-addtag-${sessionId}`}
        onClick={() => setEditing(true)}
        className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
      >
        + 标签
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      data-testid={`review-hub-addtag-input-${sessionId}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setValue('');
          setEditing(false);
        }
      }}
      onBlur={commit}
      placeholder="标签名"
      className="h-6 w-20 rounded-full border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
    />
  );
};

/** 列表时间显示：只给「日期」粒度，避免小屏上过长的 ISO 串 */
function formatDate(iso: string): string {
  if (!iso) return '';
  const datePart = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart.slice(5) : '';
}

export default ReviewHubPage;
