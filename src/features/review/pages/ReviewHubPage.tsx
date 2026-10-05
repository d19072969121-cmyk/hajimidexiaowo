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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, X } from 'lucide-react';

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
import {
  MISTAKE_TIME_RANGES,
  filterByTimeRange,
  formatMonthLabel,
  groupByMonth,
  type MistakeTimeRange,
} from '../hooks/mistakeTimeFilter';
import {
  MISTAKE_NOTE_MAX_LENGTH,
  readMistakeNote,
  saveMistakeNote,
} from '../hooks/useMistakeNote';

export interface ReviewHubPageProps {
  /** 返回回调；不传则不显示返回箭头（Tab 根页通常不需要） */
  onBack?: () => void;
  /** 导航到某个视图（由宿主注入，复用 App 的 setCurrentView） */
  onNavigate?: (view: CurrentView) => void;
  /**
   * 打开某条错题（E5）。
   *
   * 宿主负责：把该会话设为当前会话 → 切到解析结果页。
   * 之所以要宿主做：设置当前会话必须经 ChatV2Page 的包装版
   * `setCurrentSessionId`（见 E4 拍题链路的教训），页面层拿不到它。
   */
  onOpenMistake?: (sessionId: string) => void;
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
    id: 'knowledge-cards',
    title: '知识卡片',
    subtitle: '记小知识点，随时翻看',
    icon: StudyCardsIcon,
    // E5：改名 + 独立成页（原「单词卡片」跳 flashcards，与易错点共用界面）
    view: 'knowledge-cards',
    accentClass: 'text-sky-500',
  },
  {
    id: 'weak-points',
    title: '易错点',
    subtitle: '按错因复盘，AI 自动沉淀',
    icon: StudyStackIcon,
    // E5：独立成页（原与知识卡片共用 flashcards 界面）
    view: 'weak-points',
    accentClass: 'text-amber-500',
  },
  {
    id: 'practice',
    title: '刷题',
    subtitle: '温故新知与自选范围',
    icon: StudyBooksIcon,
    // E3：刷题有了独立入口页（温故新知 / 自己定类型），不再占位跳 flashcards。
    view: 'practice-hub',
    accentClass: 'text-emerald-500',
  },
];

export const ReviewHubPage: React.FC<ReviewHubPageProps> = ({
  onBack,
  onNavigate,
  onOpenMistake,
  className,
}) => {
  const { t } = useTranslation();
  const { entries, isLoading, error, isLoaded, refresh: refreshMistakeBook } = useMistakeBook();

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

  /**
   * 时间分类（E13-S）。
   *
   * 口径：按 **createdAt**（拍题时间）筛选，而不是 updatedAt —— 复习一次会
   * 把 updatedAt 刷成今天，用它当「考试时间」语义会漂移。详见
   * `mistakeTimeFilter.ts` 头部说明。
   */
  const [timeRange, setTimeRange] = useState<MistakeTimeRange>('all');
  /** 是否按月份分组展示（用户要求「分类好时间」） */
  const [groupByMonthEnabled, setGroupByMonthEnabled] = useState(false);

  /** 先按标签筛、再按时间筛（两者是「与」关系） */
  const timeFilteredEntries = useMemo(
    () => filterByTimeRange(visibleEntries, timeRange),
    [visibleEntries, timeRange],
  );

  /**
   * 渲染用分组。
   *
   * 未开启分组时退化成「单组且无标题」，让下面的渲染只走一条分支，
   * 避免两套列表 JSX 各自演化。
   */
  const renderedGroups = useMemo(() => {
    const list = timeFilteredEntries.slice(0, 20);
    if (!groupByMonthEnabled) return [{ monthKey: '', entries: list }];
    return groupByMonth(list);
  }, [timeFilteredEntries, groupByMonthEnabled]);

  /**
   * 备注编辑态：一次只编辑一条（sessionId）。
   * 值放在这里而不是每条一个组件，避免 20 条各自持有输入状态。
   */
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /** 会话 metadata 的内存覆盖层：保存成功后立即反映，不必等整表刷新 */
  const [noteOverrides, setNoteOverrides] = useState<Record<string, string>>({});

  const beginEditNote = useCallback(
    (sessionId: string, current: string) => {
      setNoteEditingId(sessionId);
      setNoteDraft(current);
    },
    [],
  );

  const cancelEditNote = useCallback(() => {
    setNoteEditingId(null);
    setNoteDraft('');
  }, []);

  /**
   * 保存备注：走 `saveMistakeNote`（读-改-写会话 metadata，跟随会话落库）。
   *
   * 成功后把值放进 `noteOverrides` 立即生效，并触发一次列表刷新让
   * `metadata` 权威值回流 —— 两者都做是为了「不闪」且「不自欺」：
   * 覆盖层给即时反馈，刷新负责最终一致。
   */
  const commitNote = useCallback(
    async (sessionId: string) => {
      const value = noteDraft;
      setNoteEditingId(null);
      setNoteDraft('');
      try {
        await saveMistakeNote(sessionId, value);
        setNoteOverrides((prev) => ({ ...prev, [sessionId]: value.trim() }));
        void refreshMistakeBook();
      } catch (err) {
        // 失败不静默：把错误抛给调用方的 onError（由外层 toast 呈现）
        throw err;
      }
    },
    [noteDraft, refreshMistakeBook],
  );

  /** 取某条错题当前生效的备注：内存覆盖层优先，其次会话 metadata */
  const noteFor = useCallback(
    (entry: MistakeBookEntryWithTags): string =>
      noteOverrides[entry.sessionId] ?? readMistakeNote(entry.metadata),
    [noteOverrides],
  );

  /** 标签搜索关键词（E5）：标签多了以后逐个扫视不现实 */
  const [tagQuery, setTagQuery] = useState('');

  /**
   * 按关键词过滤后的标签（供筛选条渲染）。
   *
   * - 大小写不敏感的子串匹配（中英文都适用；中文无大小写，等价于 includes）
   * - 搜索**只影响候选展示**，不影响已选筛选：便于「先点几个、再搜索缩小范围」
   * - 空关键词时返回全部，保持原有行为
   */
  const filteredTags = useMemo(() => {
    const kw = tagQuery.trim().toLowerCase();
    if (!kw) return allTags;
    return allTags.filter(({ tag }) => tag.toLowerCase().includes(kw));
  }, [allTags, tagQuery]);

  const headerTitle = t('reviewHub.title', '复习');

  /**
   * 顶栏。
   *
   * ⚠️ `suppressGlobalBackButton: true` 是必需的：复习页是 review Tab 的**根页**，
   *    没有「上一页」可回。不抑制时统一顶栏会渲染全局返回按钮
   *    （UnifiedMobileHeader.tsx 的兜底分支：`!suppressGlobalBackButton
   *    && !showBackArrowButton && !showMenuButton`），用户会看到左上角一个
   *    点了不知道去哪的返回箭头。
   *
   *    与 CapturePage（拍题页）同一个 bug class——拍题页当初就是这么修的，
   *    review-hub 当时漏了。新增 Tab 根页时务必一并设置。
   */
  useMobileHeader(
    'review-hub',
    {
      title: headerTitle,
      suppressGlobalBackButton: true,
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

  /**
   * 错题本预览区的锚点（用户反馈 ⑥ 的残留修复）。
   *
   * ## 问题
   * 「错题本」入口卡此前是 `disabled`（`view === null`），注释自承「本轮为占位」。
   * 但**下方其实已有完整的错题本预览区**（筛选 + 条目 + 标签增删）。
   * 用户看到一张大字卡片「错题本」，点下去**毫无反应**，得自己往下滚才能用 ——
   * 这正是用户反馈「错题本子 UI 没有」的感受来源：不是没有，是**够不着**。
   *
   * ## 修法
   * 入口卡改为可点，点击**滚动到预览区并聚焦**（而非导航到别的视图）。
   * 不改成跳转到独立页，是因为预览区就在本页、且带本页的标签筛选状态 ——
   * 跳走反而割裂。真正的「独立错题详情页」已由 `mistake-detail` 承担（点条目进）。
   *
   * ## ⚠️ E9 二次修正（用户仍反馈「点了没反应」）
   * 首版用 `scrollIntoView`，有两个失效场景：
   *   ① 页面本就不长、预览区**已在屏幕内** → 无可见位移 → 用户认为「没反应」
   *   ② 真正的滚动容器是**内层** `overflow-y-auto` 的 div（下方 line ~252），
   *      部分 WebView 里 `scrollIntoView` 找不到正确的滚动祖先 → 完全不动
   * 故改为**显式设置内层容器的 scrollTop**（不依赖祖先推断），
   * 并叠加一次短暂高亮 —— 即使位移为 0，用户也能看到「它确实响应了」。
   */
  const mistakePreviewRef = React.useRef<HTMLElement>(null);
  /** 内层滚动容器（真正被滚动的元素） */
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  /** 高亮脉冲：给「无位移」场景一个可见反馈 */
  const [previewPulse, setPreviewPulse] = useState(0);
  /** 高亮中（点击后短暂为 true，随后自动消退，避免一直亮着） */
  const [previewHighlight, setPreviewHighlight] = useState(false);

  useEffect(() => {
    if (!previewHighlight) return;
    // 与 CSS 的 duration-300 对齐；稍长一点确保人眼能捕捉到
    const timer = window.setTimeout(() => setPreviewHighlight(false), 600);
    return () => window.clearTimeout(timer);
  }, [previewHighlight, previewPulse]);

  const handleEntryClick = useCallback(
    (entry: HubEntry) => {
      if (entry.view) {
        onNavigate?.(entry.view);
        return;
      }
      // view === null：本页内展开的项（目前只有错题本）→ 滚到预览区
      const container = scrollContainerRef.current;
      const target = mistakePreviewRef.current;
      if (container && target) {
        // 相对容器的偏移：用两者 rect 之差 + 当前 scrollTop。
        // 减去一点余量（8px），避免标题正好贴上边框。
        const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
        const next = container.scrollTop + delta - 8;
        container.scrollTo({ top: Math.max(0, next), behavior: 'smooth' });
      } else {
        // 兜底：拿不到容器时退回原实现（桌面端浏览器语义正确）
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      // 无论是否产生位移都给反馈（用户反馈的核心是「看不出响应」）
      setPreviewPulse((v) => v + 1);
      setPreviewHighlight(true);
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

      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* 加载失败：可重试的错误条，不把「失败」伪装成「没有错题」 */}
        {error && (
          <div
            data-testid="review-hub-error"
            className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {t('reviewHub.loadFailed', '错题本加载失败：{{msg}}', { msg: error })}
            {/*
              E13-S 可发现性改进（来自 task-12 的发现）：
              当 chat_v2 被启动期 fail-close 阻断（lib.rs:1306 mark_blocked）时，
              此后所有错误都一样——用户只会看到「加载失败」，无从下手。

              ⚠️ 前端**无法可靠区分**「被阻断（不可自愈）」与「临时失败（可重试）」：
              `chat_v2_list_sessions` 的 State 未注册时，Tauri 只回一个通用错误串，
              没有结构化错误码；而 `StartupComponentHealthState` 虽被 manage
              （lib.rs:940），**却没有任何 #[tauri::command] 读取它**，
              前端拿不到 is_blocked 信息。要真正区分，需新增一个 Rust 查询命令。

              因此这里**不做类型判定、不猜**，只给一个总是可用的出口：跳到设置页。
              文案也刻意写成「若反复失败」这种条件句，而不是断言「你被阻断了」。
            */}
            {onNavigate && (
              <button
                type="button"
                data-testid="review-hub-error-open-settings"
                onClick={() => onNavigate('settings')}
                className="mt-1.5 block text-xs text-primary underline-offset-2 hover:underline"
              >
                {t('reviewHub.openSettingsForDiagnosis', '若反复失败，去「设置」检查数据状态')}
              </button>
            )}
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
                className={cn(
                  'flex min-h-[104px] flex-col justify-between rounded-xl border border-border p-3 text-left',
                  'bg-card transition-colors',
                  // 用户反馈 ⑥：错题本（view === null）**不再禁用** —— 本页下方便是完整
                  // 的错题本预览区，点击滚到那里即可。此前 disabled 让用户以为「错题本
                  // 不存在/没做」，实际是够不着。
                  'hover:bg-accent active:bg-accent',
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
                    {/* 用户反馈 ⑥：本页内展开的项（错题本）给**向下**箭头 —— 
                        与「跳转到别的视图」（向右箭头）区分开，否则用户以为点了会离开本页 */}
                    {entry.view !== null ? (
                      <ArrowRight size={13} className="text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ArrowDown size={13} className="text-muted-foreground" aria-hidden="true" />
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
        <section
          ref={mistakePreviewRef}
          className={cn(
            'mt-4 rounded-lg transition-colors duration-300',
            // 点击入口卡后短暂高亮：即使预览区已在屏内（无位移），
            // 用户也能看到「它确实响应了」。
            previewHighlight && 'ring-2 ring-primary/40',
          )}
          data-testid="review-hub-mistake-preview"
          data-pulse={previewPulse}
        >
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

          {/* 时间分类（E13-S）：按「拍题时间」筛选 + 可切月份分组。
              与标签筛选是「与」关系（先标签、后时间）。 */}
          <div
            data-testid="review-hub-time-filter"
            className="mb-2 flex flex-wrap items-center gap-1.5"
          >
            <span className="text-xs text-muted-foreground">
              {t('reviewHub.timeFilterLabel', '时间')}
            </span>
            {MISTAKE_TIME_RANGES.map((range) => {
              const active = timeRange === range;
              return (
                <button
                  key={range}
                  type="button"
                  data-testid={`review-hub-time-${range}`}
                  data-active={String(active)}
                  onClick={() => setTimeRange(range)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t(`reviewHub.time${range === 'all' ? 'All' : range.charAt(0).toUpperCase() + range.slice(1)}`, range)}
                </button>
              );
            })}
            <button
              type="button"
              data-testid="review-hub-group-toggle"
              data-active={String(groupByMonthEnabled)}
              onClick={() => setGroupByMonthEnabled((v) => !v)}
              className={cn(
                'ml-auto rounded-full border px-2 py-0.5 text-xs transition-colors',
                groupByMonthEnabled
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent',
              )}
            >
              {groupByMonthEnabled
                ? t('reviewHub.groupNone', '不分组')
                : t('reviewHub.groupByMonth', '按月份分类')}
            </button>
          </div>

          {isLoading && !isLoaded ? (
            <div
              data-testid="review-hub-mistake-loading"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {t('reviewHub.loading', '加载中…')}
            </div>
          ) : timeFilteredEntries.length === 0 ? (
            <div
              data-testid="review-hub-mistake-empty"
              className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {entries.length > 0
                ? t('reviewHub.filterEmpty', '没有符合筛选的错题')
                : t('reviewHub.noMistakes', '还没有错题，去「拍题」试试')}
            </div>
          ) : (
            <div className="space-y-3">
              {renderedGroups.map((group) => (
                <div key={group.monthKey || '__ungrouped__'}>
                  {/*
                    月份标题（仅在开启分组时出现）。`monthKey === ''` 是
                    「时间无法解析」的兜底组，用 i18n 文案而不是空标题，
                    否则用户会看到一撮没有归属的条目。
                  */}
                  {groupByMonthEnabled && (
                    <div
                      data-testid={`review-hub-month-${group.monthKey || 'unknown'}`}
                      className="mb-1 text-xs font-medium text-muted-foreground"
                    >
                      {group.monthKey
                        ? formatMonthLabel(group.monthKey)
                        : t('reviewHub.timeUnknown', '未知时间')}
                    </div>
                  )}
                  <ul className="space-y-1.5">
                    {group.entries.map((item) => {
                      const note = noteFor(item);
                      const editing = noteEditingId === item.sessionId;
                      return (
                        <li
                          key={item.sessionId}
                          data-testid={`review-hub-mistake-item-${item.sessionId}`}
                          className="rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent"
                        >
                          {/*
                            条目本体可点开（E5 修复）：
                            此前整条是个纯 <li>，没有任何点击处理——用户「点 UI 也点不开」，
                            根本看不到自己錯的是哪道题。
                            点开目标 = 解析结果页（该错题会话的完整内容：题干 + 解析 + 笔记），
                            这正是「错题 = mode:'analysis' 的 chat 会话」这一定义的直接体现。
                            ⚠️ 用 button 包住标题区而非整个 li：下方标签的「×」与「+ 标签」
                               是独立交互，套在可点容器里会误触。
                          */}
                          <button
                            type="button"
                            data-testid={`review-hub-open-${item.sessionId}`}
                            onClick={() => onOpenMistake?.(item.sessionId)}
                            className="flex w-full items-center justify-between text-left"
                          >
                            <span className="truncate text-sm text-foreground">{item.title}</span>
                            <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                              {formatDate(item.createdAt)}
                            </span>
                          </button>

                          {/* 备注（E13-S）：用户要求能记「考试时间」「什么卷子」。
                              已保存的备注直接展示；编辑态换成 textarea。 */}
                          {editing ? (
                            <div className="mt-1.5">
                              <textarea
                                data-testid={`review-hub-note-input-${item.sessionId}`}
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                                maxLength={MISTAKE_NOTE_MAX_LENGTH}
                                rows={2}
                                autoFocus
                                placeholder={t(
                                  'reviewHub.notePlaceholder',
                                  '例：3 月月考，数学卷第 18 题',
                                )}
                                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    cancelEditNote();
                                  }
                                  // Ctrl/Cmd+Enter 提交；单独 Enter 留给换行
                                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    void commitNote(item.sessionId);
                                  }
                                }}
                              />
                              <div className="mt-1 flex items-center gap-2">
                                <button
                                  type="button"
                                  data-testid={`review-hub-note-save-${item.sessionId}`}
                                  onClick={() => void commitNote(item.sessionId)}
                                  className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
                                >
                                  {t('reviewHub.noteSave', '保存')}
                                </button>
                                <button
                                  type="button"
                                  data-testid={`review-hub-note-cancel-${item.sessionId}`}
                                  onClick={cancelEditNote}
                                  className="text-xs text-muted-foreground"
                                >
                                  {t('reviewHub.noteCancel', '取消')}
                                </button>
                                <span className="ml-auto text-[10px] text-muted-foreground">
                                  {t('reviewHub.noteHint', '可记考试时间、哪张卷子等')}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-1.5 flex items-start gap-1.5">
                              <button
                                type="button"
                                data-testid={`review-hub-note-edit-${item.sessionId}`}
                                onClick={() => beginEditNote(item.sessionId, note)}
                                className={cn(
                                  'rounded px-1.5 py-0.5 text-left text-xs transition-colors',
                                  note
                                    ? 'text-foreground/80 hover:bg-accent'
                                    : 'border border-dashed border-border text-muted-foreground hover:bg-accent',
                                )}
                                title={note || undefined}
                              >
                                {note ? note : `+ ${t('reviewHub.noteAdd', '加备注')}`}
                              </button>
                            </div>
                          )}

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
                                  aria-label={t('reviewHub.removeTag', '移除标签 {{tag}}', { tag })}
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
                              t={t}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
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
  /** i18n 翻译函数（由父级注入，避免子组件再起一个 useTranslation） */
  t: (key: string, fallback: string) => string;
}> = ({ sessionId, onAdd, t }) => {
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
      placeholder={t('reviewHub.tagPlaceholder', '标签名')}
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
