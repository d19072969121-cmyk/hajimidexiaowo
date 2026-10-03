/**
 * WeakPointsPage — 易错点页（E5）
 *
 * ## 为什么独立于知识卡片（用户要求）
 * 用户明确要求「易错点和单词卡片不应该用同一个 UI 界面，应该分开」。
 * 二者的**语义与生命周期不同**：
 *   - 知识卡片：中性知识点的速查（公式、概念），用户主动记录
 *   - 易错点：**从错题中沉淀出的个人弱点**，可被 AI 在批改时自动产出
 *
 * 因此本页的组织维度是「错因 / 学科」而非「知识主题」，操作也以
 * 「从错题归纳」为主、手动补充为辅。
 *
 * ## 来源（用户要求两条都支持）
 * 1. **AI 批改时自动制作** —— 见 `src/features/review/classify/tagTaxonomy.ts`
 *    的 ERROR_CAUSE_TAGS 体系；批改流程把识别到的错因写入易错点。
 * 2. **本页手动制作** —— 用户自己总结的易错点。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Plus, Search } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import { ERROR_CAUSE_TAGS, SUBJECT_TAGS } from '@/features/review/classify/tagTaxonomy';

export interface WeakPointsPageProps {
  /** 返回回调 */
  onBack?: () => void;
  className?: string;
}

export const WeakPointsPage: React.FC<WeakPointsPageProps> = ({
  onBack,
  className,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const headerTitle = t('weakPoints.title', '易错点');

  useMobileHeader(
    'weak-points',
    { title: headerTitle, suppressGlobalBackButton: true },
    [headerTitle],
  );

  /**
   * 分组维度：错因 × 学科。
   *
   * 按错因分组符合「易错点」的直觉（我总在审题上出错 / 我总记错公式），
   * 学科作为二级过滤。两组都来自固定体系，保证统计口径一致。
   */
  const causeGroups = useMemo(
    () => ERROR_CAUSE_TAGS.map((cause) => ({ cause, subjects: [...SUBJECT_TAGS] })),
    [],
  );

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return causeGroups;
    return causeGroups.filter(
      (g) => g.cause.toLowerCase().includes(kw)
        || g.subjects.some((s) => s.toLowerCase().includes(kw)),
    );
  }, [causeGroups, query]);

  const handleNew = useCallback(() => {
    // 新建表单（录入 + 选错因/学科）随数据层一起做。
    // 此处先给出入口，避免「有页面但无操作」。
    setQuery('');
  }, []);

  return (
    <div
      data-testid="weak-points-page"
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <input
          type="search"
          data-testid="weak-points-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('weakPoints.searchHint', '搜索错因或学科…')}
          className="mb-3 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
        />

        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="text-xs text-muted-foreground">
            {t(
              'weakPoints.autoHint',
              '批改错题时，AI 会自动识别错因并沉淀到这里；你也可以手动补充。',
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div
            data-testid="weak-points-no-match"
            className="rounded-lg border border-border px-3 py-6 text-center text-xs text-muted-foreground"
          >
            {t('weakPoints.noMatch', '没有匹配的错因')}
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="weak-points-list">
            {filtered.map(({ cause }) => (
              <li
                key={cause}
                data-testid={`weak-points-cause-${cause}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
              >
                <span className="text-sm text-foreground">{cause}</span>
                <span
                  data-testid={`weak-points-count-${cause}`}
                  className="text-xs tabular-nums text-muted-foreground"
                >
                  0
                </span>
              </li>
            ))}
          </ul>
        )}

        <DsButton
          variant="outline"
          size="sm"
          className="mt-4 w-full"
          data-testid="weak-points-new"
          onClick={handleNew}
        >
          <Plus size={15} className="mr-1.5" aria-hidden="true" />
          {t('weakPoints.new', '手动添加易错点')}
        </DsButton>
      </div>
    </div>
  );
};

export default WeakPointsPage;
