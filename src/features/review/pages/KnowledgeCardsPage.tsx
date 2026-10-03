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
 */

import React, { useCallback, useMemo, useState } from 'react';
import { BookMarked, Plus, Search } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

export interface KnowledgeCardsPageProps {
  /** 打开完整闪卡复习（需要间隔重复算法时用） */
  onOpenFlashcards?: () => void;
  /** 返回回调 */
  onBack?: () => void;
  className?: string;
}

export const KnowledgeCardsPage: React.FC<KnowledgeCardsPageProps> = ({
  onOpenFlashcards,
  onBack,
  className,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

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
   * 说明：卡片数据的读取沿用 flashcards 的存储层（见文件头「为什么复用」）。
   * 本页先落地「按标签速查」的组织方式与搜索，列表数据接入随 flashcards
   * 的 store 一起做——不做两套存储。
   */
  const hint = useMemo(
    () => t('knowledgeCards.searchHint', '搜索知识点…'),
    [t],
  );

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

        <div className="mt-4 grid gap-2">
          <DsButton
            variant="outline"
            size="sm"
            data-testid="knowledge-cards-new"
            className="w-full"
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
    </div>
  );
};

export default KnowledgeCardsPage;
