/**
 * KnowledgeCardsPage — 知识卡片页（E5）
 *
 * ## 定位与改名缘由（用户要求）
 * 原入口名为「单词卡片」，跳转复用 `flashcards`（闪卡复习）界面——与「易错点」
 * 共用同一个 UI，用户明确要求**分开**。
 *
 * 新语义：**知识卡片 = 记一个个小知识点**（公式、概念、易混点等）。
 * 与闪卡复习（FSRS 间隔重复、有成套复习算法）**不是一回事**：
 *   - 闪卡：面向「复习计划/记忆曲线」的成体系复习
 *   - 知识卡片：面向「随手记下一个知识点、需要时翻看」的速查集合
 *
 * ## 为什么复用 flashcards 的存储而不是另建
 * 两者的**数据形态相同**（正反面文本 + 可选标签），差别在**使用方式**。
 * 另建一套存储会导致「同一个知识点在两处各存一份」。故本页读同一份数据，
 * 只提供不同的组织与浏览方式（按标签分组速查）。
 *
 * ## ⚠️ E9 补全：数据层此前的**空缺**（这就是「主页建的知识卡片看不到」的根因）
 * E5 只落地了页面骨架：空态是**写死的常量**，`load()` / `listAnkiLibraryCards`
 * 一次都没调过。于是无论库里有多少卡片，本页永远显示「还没有知识卡片」——
 * 用户看到的就是「建了但看不到」。
 *
 * 现真接到 flashcards 的**同一份数据**（`list_anki_library_cards`）：
 * 读 `front`/`back`/`tags`，按标签分组做速查，搜索走本地子串匹配。
 * 一次拉满一页（上限见 `KNOWLEDGE_CARDS_FETCH_SIZE`）——速查场景不做分页，
 * 需要完整分页/间隔重复时走下方的「进入间隔重复复习」。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookMarked, Plus, Search, Sparkles } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogHeader } from '@/components/ui/DsDialog';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import type { AnkiLibraryCard } from '@/types';

/**
 * 单次拉取条数。
 *
 * 知识卡片是「速查集合」，量级远小于闪卡库的复习队列；取 200 足以覆盖
 * 常见用法，又不会在大库上拖慢首屏。超出时引导用户去 flashcards 分页浏览。
 */
const KNOWLEDGE_CARDS_FETCH_SIZE = 200;

export interface KnowledgeCardsPageProps {
  /** 打开完整闪卡复习（需要间隔重复算法时用） */
  onOpenFlashcards?: () => void;
  /** 返回回调 */
  onBack?: () => void;
  /**
   * 「AI 新建」——关闭弹窗 A 后**回到首页**，并提示用户在主页让 AI 建卡片。
   *
   * ⚠️ 由 App.tsx 注入：本页只负责触发，切视图与提示都归外层
   *    （本页是纯展示层，不该知道 tab 结构）。
   */
  onAiCreate?: () => void;
  className?: string;
}

export const KnowledgeCardsPage: React.FC<KnowledgeCardsPageProps> = ({
  onOpenFlashcards,
  onBack,
  onAiCreate,
  className,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  /** 真实卡片数据（E9 接入）。空数组 + isLoaded 才能区分「没有」与「还没读到」。 */
  const [cards, setCards] = useState<AnkiLibraryCard[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * 拉取卡片。
   *
   * ⚠️ 刻意**不**复用 `useFlashcardsLibraryStore`：那个 store 带分页、筛选、
   *    批量选择等一整套复习态，本页只需要「一次读一批」，借用它会导致
   *    两个页面对同一 store 的 page/query 互相覆盖（切回来时列表错位）。
   *    直接调底层 API，语义更窄也更安全。
   */
  const loadCards = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await listAnkiLibraryCards({
        page: 1,
        page_size: KNOWLEDGE_CARDS_FETCH_SIZE,
      });
      setCards(Array.isArray(response?.items) ? response.items : []);
    } catch (error) {
      setCards([]);
      setLoadError(getErrorMessage(error) || t('knowledgeCards.loadFailed', '知识卡片加载失败'));
    } finally {
      setIsLoaded(true);
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  /**
   * 弹窗 A 的开关（E9，用户规格）。
   *
   * 用户原话：
   *   「出现个弹窗 A，有一个按钮『ai 新建』，右上角有个『×』可以关闭弹窗 A，
   *     点击『ai 新建』可以**返回首页**，并提示『可以在主页让 ai 新建知识卡片』」
   *
   * ⚠️ 这里刻意**不**做手工新建表单：知识卡片目前没有本地新建入口
   *    （数据层沿用 flashcards 存储，写入路径只有 AI 一条），
   *    给一个填了也存不进去的表单才是真的骗人。
   */
  const [newDialogOpen, setNewDialogOpen] = useState(false);

  const headerTitle = t('knowledgeCards.title', '知识卡片');

  useMobileHeader(
    'knowledge-cards',
    { title: headerTitle, suppressGlobalBackButton: true },
    [headerTitle],
  );

  const handleOpenFlashcards = useCallback(() => {
    onOpenFlashcards?.();
  }, [onOpenFlashcards]);

  /**
   * 「AI 新建」：先关弹窗，再交给外层回首页 + 弹提示。
   * 先关再调，否则弹窗会盖在首页之上（用户会以为「回到首页但什么都没发生」）。
   */
  const handleAiCreate = useCallback(() => {
    setNewDialogOpen(false);
    onAiCreate?.();
  }, [onAiCreate]);

  const hint = useMemo(
    () => t('knowledgeCards.searchHint', '搜索知识点…'),
    [t],
  );

  /** 搜索：本地子串匹配 front/back/tags（速查场景，不必回后端往返）。 */
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return cards;
    return cards.filter((c) => {
      const hay = [c.front, c.back, ...(c.tags ?? [])].join('\n').toLowerCase();
      return hay.includes(kw);
    });
  }, [cards, query]);

  /**
   * 按第一个标签分组。
   *
   * 无标签归入「未分类」。分组只按**首个**标签——多标签会让同一张卡在多组
   * 重复出现，速查时反而难以定位（需要多维检索时用搜索框）。
   */
  const groups = useMemo(() => {
    const map = new Map<string, AnkiLibraryCard[]>();
    for (const c of filtered) {
      const key = c.tags?.[0]?.trim() || '';
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    // 具名分组在前，未分类垫底
    return [...map.entries()].sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const hasCards = filtered.length > 0;
  /** 库里有卡但被搜索过滤空了 —— 与「库里真没卡」是两种提示 */
  const filteredEmpty = isLoaded && !hasCards && cards.length > 0;
  const libraryEmpty = isLoaded && cards.length === 0;

  return (
    <div
      data-testid="knowledge-cards-page"
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <input
          type="search"
          data-testid="knowledge-cards-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={hint}
          className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
        />

        {/* 加载失败：可重试，不把「失败」伪装成「没有卡片」 */}
        {loadError && (
          <div
            data-testid="knowledge-cards-error"
            className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {loadError}
            <button
              type="button"
              data-testid="knowledge-cards-retry"
              className="ml-2 underline"
              onClick={() => void loadCards()}
            >
              {t('knowledgeCards.retry', '重试')}
            </button>
          </div>
        )}

        {/* 加载中：与「没有卡片」区分开，避免首帧闪一下空态 */}
        {isLoading && !isLoaded && (
          <div
            data-testid="knowledge-cards-loading"
            className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground"
          >
            {t('knowledgeCards.loading', '读取中…')}
          </div>
        )}

        {/* 空态：库里真没有卡片 */}
        {libraryEmpty && !loadError && (
          <div
            data-testid="knowledge-cards-empty"
            className="rounded-xl border border-dashed border-border px-4 py-10 text-center"
          >
            <BookMarked className="mx-auto mb-3 size-8 text-muted-foreground" strokeWidth={1.5} />
            <div className="text-sm text-foreground">
              {t('knowledgeCards.emptyTitle', '还没有知识卡片')}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('knowledgeCards.emptyDesc', '把零散的知识点记成卡片，需要时随手翻看')}
            </div>
          </div>
        )}

        {/* 搜索无结果：库里其实有卡，只是没匹配上 */}
        {filteredEmpty && (
          <div
            data-testid="knowledge-cards-no-match"
            className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
          >
            {t('knowledgeCards.noMatch', '没有匹配的卡片')}
          </div>
        )}

        {/* 真实列表：按标签分组 */}
        {hasCards &&
          groups.map(([tag, items]) => (
            <section key={tag || '__uncategorized__'} className="mb-4" data-testid={`knowledge-cards-group-${tag || 'uncategorized'}`}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <BookMarked size={12} className="text-muted-foreground" aria-hidden="true" />
                <h4 className="text-xs font-medium text-muted-foreground">
                  {tag || t('knowledgeCards.uncategorized', '未分类')}
                </h4>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="grid gap-1.5">
                {items.map((card) => (
                  <div
                    key={card.id}
                    data-testid="knowledge-cards-item"
                    className="rounded-lg border border-border bg-card px-2.5 py-2"
                  >
                    <div className="text-sm text-foreground">{card.front}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {card.back}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

        <div className="mt-4 grid gap-2">
          <DsButton
            variant="outline"
            size="sm"
            data-testid="knowledge-cards-new"
            className="w-full"
            // ⚠️ E9：这个按钮此前**根本没有 onClick** —— 点了毫无反应。
            onClick={() => setNewDialogOpen(true)}
          >
            <Plus size={15} className="mr-1.5" aria-hidden="true" />
            {t('knowledgeCards.new', '新建知识卡片')}
          </DsButton>

          {/* 完整的间隔重复复习仍在 flashcards：知识卡片只做速查，
              需要按记忆曲线复习时再进那一层。 */}
          {onOpenFlashcards && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="knowledge-cards-open-review"
              className="w-full"
              onClick={handleOpenFlashcards}
            >
              {t('knowledgeCards.openReview', '进入间隔重复复习')}
            </DsButton>
          )}
        </div>
      </div>

      {/*
        弹窗 A（E9，严格按用户规格）：
        - 右上角「×」关闭（DsDialog 的 showClose 默认 true，自带）
        - 主体一个「AI 新建」按钮 → 关弹窗 + 回首页 + 提示
      */}
      <DsDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        maxWidth="max-w-sm"
        aria-label={t('knowledgeCards.newDialogTitle', '新建知识卡片')}
      >
        <DsDialogHeader>
          <div
            className="flex items-center gap-2 text-sm font-medium text-foreground"
            data-testid="knowledge-cards-new-dialog-title"
          >
            <Sparkles size={15} className="text-primary" aria-hidden="true" />
            {t('knowledgeCards.newDialogTitle', '新建知识卡片')}
          </div>
        </DsDialogHeader>

        <div className="space-y-3 px-5 pb-5" data-testid="knowledge-cards-new-dialog">
          <p className="text-xs text-muted-foreground">
            {t(
              'knowledgeCards.newDialogDesc',
              '知识卡片目前由 AI 从你的对话与错题中沉淀。回到主页，直接让 AI 帮你新建即可。',
            )}
          </p>
          <DsButton
            className="w-full"
            data-testid="knowledge-cards-ai-new"
            onClick={handleAiCreate}
          >
            <Sparkles size={15} className="mr-1.5" aria-hidden="true" />
            {t('knowledgeCards.aiNew', 'AI 新建')}
          </DsButton>
        </div>
      </DsDialog>
    </div>
  );
};

export default KnowledgeCardsPage;
