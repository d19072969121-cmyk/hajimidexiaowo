/**
 * MistakeDetailPage — 错题详情独立页（E6）
 *
 * ## 为什么独立成页（用户反馈 ⑥）
 * 此前点开错题走的是 `analysis-result`（解析结果页）。那一页的语义是
 * **「刚拍完的即时结果」**（`AnalysisResultPage.tsx` 头部自述：chat 会话的
 * 特殊展示态，服务于「拍题 → 解析」的当下）。而用户从错题本点进来时的心智是
 * **「回顾一道历史错题」**：
 *   - 它是哪次做的、什么时候做的（时间语义）
 *   - 当时打了什么标签（归类语义）
 *   - 我想再练一道同类的（练习语义）
 * 这三点在解析页上都没有位置，故独立成页。
 *
 * ## 与解析页的分工（不重复造轮子）
 * ```
 *  chat store ──(useAnalysisResultData)──> AnalysisResultData ─┐
 *                                                              ├─> AnalysisResultView
 *  标签/题库/时间等「回顾语义」由本页编排 ───────────────────────┘
 * ```
 * 展示内核**完整复用** `AnalysisResultView`（题干 / 解析 / 四态 / Markdown+KaTeX），
 * 本页不重写任何 Markdown/LaTeX 渲染，只补它没有的回顾语义区块。
 *
 * ## 顶栏（二级页规则）
 * 本页**不是 Tab 根页**（`TAB_ROOT_VIEW.review === 'review-hub'`），是从
 * review-hub 推入的二级页，**有真实上一页语义**，因此：
 *   - 走 `showBackArrow: true` + `onMenuClick`（页内返回），
 *   - **不加** `suppressGlobalBackButton`（那会让统一顶栏的兜底形同虚设，
 *     但更重要的是：本页确实需要返回箭头，且它**有去处** —— 回 review-hub）。
 * 这与 `weak-points`/`knowledge-cards`（无返回语义的终端页）刻意不同。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';

import { ArrowLeft, Loader2, Search, Plus, Tag as TagIcon, X } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout';
import { cn } from '@/utils/cn';
import { getErrorMessage, getErrorDetails } from '@/utils/errorUtils';

import { AnalysisResultView } from '@/components/analysis/AnalysisResultView';
import { useAnalysisResultData } from '@/components/analysis/useAnalysisResultData';
import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { useSessionTags } from '@/features/chat/hooks/useSessionTags';
import { useQuestionBankConfig } from '@/features/practice/questionBank/useQuestionBankConfig';
import { isQuestionBankReady } from '@/features/practice/questionBank/config';
import type { ChatStore } from '@/features/chat/core/types';

type ChatStoreApi = StoreApi<ChatStore>;

// ============================================================================
// 题库访问层
// ============================================================================
//
// 数据层（类型 / 归一化 / invoke / 错误分类）已抽到
// `src/features/practice/questionBank/bankClient.ts`：
//   1. 消除「复刻件漂移」——契约可直接 import 真货，不再测复制品（审查员指出）
//   2. 让刷题链路复用同一套能力（用户反馈 ③ 的语义错配：题库能力此前锁死在
//      本页，刷题页拿不到，导致「温故新知 / 自己定类型」至今没接题库）
//
// 本页只保留**与 UI 状态机绑定**的部分（见下方 BankSearchOutcome）。

import {
  DEFAULT_REGISTER_URL,
  SEARCH_LIMIT,
  extractErrorCode,
  extractRegisterUrl,
  fetchQuestionBankQuota,
  isQuotaError,
  normalizeNumeric,
  normalizeStringList,
  normalizeSubQuestions,
  searchQuestionBank,
  type BankQuestion,
  type BankQuota,
  type BankSearchParams,
  type BankSearchResult,
} from '@/features/practice/questionBank/bankClient';

/**
 * 本页「找同类题」的状态机。
 *
 * 比 `bankClient.ts` 的 `BankSearchOutcome` 多两个**纯 UI** 态
 * （`idle` 未点过 / `loading` 请求中）—— 它们不属于数据层语义，故留在页面。
 * 其余四态语义完全一致（成功 / 空 / 未配置 / 额度用尽 / 错误）。
 */
export type BankSearchOutcome =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; items: BankQuestion[]; billedCount: number }
  | { kind: 'empty' }         // 200 但 items 为空 → 换关键词
  | { kind: 'unconfigured' }  // 没配置题库 → 去配置
  | { kind: 'quota'; registerUrl: string }  // 额度用尽 → 注册提额度
  | { kind: 'error'; message: string };

/**
 * 渲染单道题的题干 + 选项 + 答案 + 子题 + 图片 + 元信息。
 *
 * 所有 `Value` 字段先经归一函数再渲染——**不假定类型**（Rust 明确提醒
 * `difficulty`/`year` 等可能是数字也可能是字符串；`options`/`answer`/
 * `subquestions` 可能是数组/单值/对象）。
 *
 * 未建模的字段一律**跳过而非猜测**：宁可少显示一块，也不能把原始 JSON
 * 或 `undefined` 甩到界面上。
 *
 * 注：本函数留在页面内（而非 `bankClient.ts`）—— 它返回 ReactNode，
 * 属**渲染层**；数据层不需要依赖 React。故 `bankClient.ts` 保持纯数据。
 */
function renderQuestionList(items: BankQuestion[]): React.ReactNode {
  return (
    <ul className="mt-2 space-y-1.5" data-testid="mistake-detail-similar-list">
      {items.map((item, idx) => {
        const key = String(item.id ?? idx);
        const options = normalizeStringList(item.options);
        const answers = normalizeStringList(item.answer);
        const subs = normalizeSubQuestions(item.subquestions);
        const difficulty = normalizeNumeric(item.difficulty);
        const year = normalizeNumeric(item.year);

        return (
          <li
            key={key}
            data-testid={`mistake-detail-similar-item-${key}`}
            className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-foreground"
          >
            {/**
             * 优先用 `title`（原始 LaTeX）走 Markdown 渲染。
             * `title_html` 是**不受信任**的 HTML 片段，**不**用
             * dangerouslySetInnerHTML —— 需要富文本时在此换受信任的渲染器。
             */}
            <MarkdownRenderer content={item.title ?? ''} />

            {/* 选项：同样是含 LaTeX 的原始文本（已归一为字符串数组） */}
            {options.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-3">
                {options.map((opt, i) => (
                  <li key={i} className="text-muted-foreground">
                    <MarkdownRenderer content={opt} />
                  </li>
                ))}
              </ul>
            )}

            {answers.length > 0 && (
              <div className="mt-1 text-muted-foreground">
                {answers.map((a, i) => (
                  <MarkdownRenderer key={i} content={a} />
                ))}
              </div>
            )}

            {item.analysis && (
              <div className="mt-1 text-muted-foreground">
                <MarkdownRenderer content={item.analysis} />
              </div>
            )}

            {/**
             * 复合题：子题**必须与父题一起展示**（Lead 明确要求），
             * 不做折叠/分页，避免用户看到一道残缺的题。
             */}
            {subs.length > 0 && (
              <ol className="mt-1.5 space-y-1.5 border-l-2 border-border pl-2.5">
                {subs.map((sub, i) => {
                  const subOptions = normalizeStringList(sub.options);
                  return (
                    <li key={i}>
                      <MarkdownRenderer content={sub.title ?? ''} />
                      {subOptions.length > 0 && (
                        <ul className="mt-0.5 space-y-0.5 pl-3">
                          {subOptions.map((opt, j) => (
                            <li key={j} className="text-muted-foreground">
                              <MarkdownRenderer content={opt} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            {/* 图片：`image_urls` 已是绝对 URL，直接用，不自行拼路径 */}
            {item.image_urls && item.image_urls.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.image_urls.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    loading="lazy"
                    className="max-h-32 rounded border border-border object-contain"
                  />
                ))}
              </div>
            )}

            {/* 题源元信息：只显示**归一后确实有值**的项，不显示 "undefined" */}
            {(() => {
              const meta = [
                item.source,
                year !== null ? String(year) : null,
                difficulty !== null ? `难度 ${difficulty}` : null,
              ].filter((v): v is string => Boolean(v && String(v).trim()));
              if (meta.length === 0) return null;
              return (
                <p className="mt-1 text-[11px] text-muted-foreground">{meta.join(' · ')}</p>
              );
            })()}
          </li>
        );
      })}
    </ul>
  );
}
// ============================================================================
// 组件
// ============================================================================

export interface MistakeDetailPageProps {
  /** 目标会话的 ChatStore（由 App 传入，与解析页同款数据源） */
  store?: ChatStoreApi | null;

  /** 会话 id。用于取标签 / 写标签（store 的 sessionId 也可用，但显式传入更稳） */
  sessionId?: string | null;

  /** 返回错题列表（去处 = review-hub） */
  onBack?: () => void;

  /**
   * 深链到 设置 → 模型 Tab 配置题库。
   * 与 practice-hub 的 onConfigureQuestionBank 同款（App.tsx:3290 附近）。
   */
  onConfigureQuestionBank?: () => void;

  className?: string;
}

export const MistakeDetailPage: React.FC<MistakeDetailPageProps> = ({
  store = null,
  sessionId = null,
  onBack,
  onConfigureQuestionBank,
  className,
}) => {
  const { t } = useTranslation();

  // 复用与解析页**同一个**取数层，保证题干/解析口径完全一致
  const { data, phase, isStreaming, error } = useAnalysisResultData(store);

  /**
   * 题库配置的**权威信号**（Lead 指定）。
   *
   * 用它而非「匹配错误文案」判定「未配置」——文案会变、会被本地化，
   * 而配置状态是结构化事实。`isLoaded` 未就绪时先不急着喊「没配置」，
   * 避免首次渲染闪一下错误引导。
   */
  const { config: bankConfig, isLoaded: isBankConfigLoaded } = useQuestionBankConfig();
  const isBankReady = useMemo(() => isQuestionBankReady(bankConfig), [bankConfig]);

  // 标签：本页是「回顾」语义，标签从只读展示升级为可编辑
  const { tagsBySession, loadTagsForSessions, addTag, removeTag } = useSessionTags();

  const effectiveSessionId = sessionId ?? null;
  const tags = useMemo(
    () => (effectiveSessionId ? (tagsBySession.get(effectiveSessionId) ?? []) : []),
    [effectiveSessionId, tagsBySession],
  );

  const [tagDraft, setTagDraft] = useState('');
  const [isAddingTag, setIsAddingTag] = useState(false);

  // 首次进入拉取该会话标签（只读展示也必须先有数据）
  useEffect(() => {
    if (!effectiveSessionId) return;
    void loadTagsForSessions([effectiveSessionId]);
  }, [effectiveSessionId, loadTagsForSessions]);

  const handleAddTag = useCallback(async () => {
    const trimmed = tagDraft.trim();
    if (!trimmed || !effectiveSessionId) return;
    setIsAddingTag(true);
    try {
      await addTag(effectiveSessionId, trimmed);
      setTagDraft('');
    } finally {
      setIsAddingTag(false);
    }
  }, [tagDraft, effectiveSessionId, addTag]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!effectiveSessionId) return;
      await removeTag(effectiveSessionId, tag);
    },
    [effectiveSessionId, removeTag],
  );

  // ── 找同类题 ──────────────────────────────────────────────────────────────
  const [search, setSearch] = useState<BankSearchOutcome>({ kind: 'idle' });
  /** 剩余额度（查额度本身不消费额度）。未取到时为 null，不显示该行 */
  const [quota, setQuota] = useState<BankQuota | null>(null);

  /** 拉一次额度。失败静默——额度提示是增强信息，不该打断主流程 */
  const refreshQuota = useCallback(async () => {
    try {
      setQuota(await fetchQuestionBankQuota());
    } catch {
      setQuota(null);
    }
  }, []);

  // 进入页面即取一次额度（若已配置题库）
  useEffect(() => {
    if (!isBankConfigLoaded || !isBankReady) return;
    void refreshQuota();
  }, [isBankConfigLoaded, isBankReady, refreshQuota]);

  /**
   * 关键词来源：题干文本截取。
   *
   * 为什么截取而不是全填：题干往往是整段含 LaTeX 的长文，直接当关键词
   * 送给题库检索命中率极低。取前若干个非空字符作为「粗检索」入口，
   * 用户拿到结果后可再自行改词。
   */
  const defaultKeyword = useMemo(() => {
    const question = data?.question ?? '';
    return question.replace(/\s+/g, ' ').trim().slice(0, 40);
  }, [data?.question]);

  const [keyword, setKeyword] = useState('');
  // 题干异步到达，首次拿到时回填到输入框（不覆盖用户已输入的内容）
  const keywordTouchedRef = useRef(false);
  useEffect(() => {
    if (keywordTouchedRef.current) return;
    if (defaultKeyword) setKeyword(defaultKeyword);
  }, [defaultKeyword]);

  const handleSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) {
      setSearch({ kind: 'empty' });
      return;
    }
    // 权威配置信号优先：未配置就不发请求，直接给「去配置」引导。
    // 这比「等后端报错再猜」既快又准（且**不浪费试用额度**）。
    if (isBankConfigLoaded && !isBankReady) {
      setSearch({ kind: 'unconfigured' });
      return;
    }
    // ⚠️ 实测首次请求元数据要 10.6s：必须立刻进加载态，
    //    不能让用户以为没反应（本项目用户反复反馈的一类问题）。
    setSearch({ kind: 'loading' });
    try {
      const result = await searchQuestionBank({ keyword: kw, limit: SEARCH_LIMIT });
      setSearch(
        result.items.length > 0
          ? { kind: 'ok', items: result.items, billedCount: result.billedCount }
          : { kind: 'empty' },
      );
      // 搜完刷新剩余额度：试用用户需要知道刚花了多少、还剩多少
      void refreshQuota();
    } catch (err) {
      if (isQuotaError(err)) {
        setSearch({ kind: 'quota', registerUrl: extractRegisterUrl(err) });
      } else if (isBankConfigLoaded && !isBankReady) {
        // 抛错且配置确实缺失 → 归为「未配置」，而不是甩一句技术错误给用户
        setSearch({ kind: 'unconfigured' });
      } else {
        setSearch({ kind: 'error', message: getErrorMessage(err) });
      }
    }
  }, [keyword, isBankReady, isBankConfigLoaded, refreshQuota]);

  const headerTitle = t('mistakeDetail.title', '错题详情');

  /**
   * 顶栏：二级页。
   * `showBackArrow: true` + `onMenuClick` 是**字面量真值**且回调存在，
   * 静态判据可证不落兜底分支（见 judgeBlock）；刻意**不**加
   * suppressGlobalBackButton —— 本页有真实上一页。
   */
  useMobileHeader(
    'mistake-detail',
    {
      title: headerTitle,
      showBackArrow: true,
      onMenuClick: onBack,
    },
    [headerTitle, onBack],
  );

  return (
    <div
      data-testid="mistake-detail-page"
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 回顾语义横幅：明确「这是历史错题」，与解析页的即时结果区分 */}
        <div className="mx-3 mt-3 rounded-xl border border-border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {t('mistakeDetail.reviewBanner', '历史错题回顾 —— 这道题你之前做错过，可以再练一遍。')}
          </p>
        </div>

        {/* 标签区（详情页特有：可编辑） */}
        <section className="mx-3 mt-3" data-testid="mistake-detail-tags">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <TagIcon size={13} aria-hidden="true" />
            {t('mistakeDetail.tags', '标签')}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {tags.length === 0 && (
              <span
                data-testid="mistake-detail-tags-empty"
                className="text-xs text-muted-foreground"
              >
                {t('mistakeDetail.noTags', '暂无标签')}
              </span>
            )}

            {tags.map((tag) => (
              <span
                key={tag}
                data-testid={`mistake-detail-tag-${tag}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-foreground"
              >
                {tag}
                <button
                  type="button"
                  aria-label={t('mistakeDetail.removeTag', '移除标签 {{tag}}', { tag })}
                  data-testid={`mistake-detail-untag-${tag}`}
                  onClick={() => void handleRemoveTag(tag)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={tagDraft}
              data-testid="mistake-detail-tag-input"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddTag();
              }}
              placeholder={t('mistakeDetail.tagPlaceholder', '添加标签…')}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
            />
            <DsButton
              variant="outline"
              size="sm"
              data-testid="mistake-detail-tag-add"
              disabled={isAddingTag || !tagDraft.trim()}
              onClick={() => void handleAddTag()}
            >
              <Plus size={13} aria-hidden="true" />
            </DsButton>
          </div>
        </section>

        {/* 找同类题 */}
        <section className="mx-3 mt-3" data-testid="mistake-detail-similar">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Search size={13} aria-hidden="true" />
            {t('mistakeDetail.findSimilar', '找同类题')}
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="search"
              value={keyword}
              data-testid="mistake-detail-similar-input"
              onChange={(e) => {
                keywordTouchedRef.current = true;
                setKeyword(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch();
              }}
              placeholder={t('mistakeDetail.similarPlaceholder', '输入题干关键词…')}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
            />
            <DsButton
              variant="outline"
              size="sm"
              data-testid="mistake-detail-similar-search"
              disabled={search.kind === 'loading'}
              onClick={() => void handleSearch()}
            >
              {search.kind === 'loading' ? (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              ) : (
                t('mistakeDetail.search', '搜索')
              )}
            </DsButton>
          </div>

          {/* 额度提示：试用用户只有 100 题/24h，不告知会让他们误以为搜索无限额。
              查额度本身不消费额度，故可放心展示。 */}
          {quota && quota.remaining !== null && (
            <p
              data-testid="mistake-detail-quota"
              className="mt-1 text-[11px] text-muted-foreground"
            >
              {quota.usedTrial
                ? t(
                  'mistakeDetail.quotaTrial',
                  '试用额度剩余 {{remaining}} / {{limit}} 题（每道返回的题计 1 题）',
                  { remaining: quota.remaining, limit: quota.questionLimit ?? 100 },
                )
                : t('mistakeDetail.quotaRegistered', '今日剩余额度 {{remaining}} 题', {
                  remaining: quota.remaining,
                })}
            </p>
          )}

          {/* 五态渲染：加载 / 有结果 / 无结果 / 未配置 / 额度用尽 / 其他错误 */}
          {search.kind === 'loading' && (
            <p
              data-testid="mistake-detail-similar-loading"
              className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              {t('mistakeDetail.searching', '正在题库中搜索…首次连接题库可能较慢，请稍候。')}
            </p>
          )}

          {search.kind === 'ok' && (
            <>
              {/* 找到结果时顺带告知本次消耗：billedCount 由 Rust 给出
                  （计费口径唯一，不用 items.length）。对试用用户尤其实在。 */}
              <p
                data-testid="mistake-detail-similar-count"
                className="mt-2 text-[11px] text-muted-foreground"
              >
                {t('mistakeDetail.foundSimilar', '找到 {{count}} 道同类题（本次消耗 {{billed}} 题额度）', {
                  count: search.items.length,
                  billed: search.billedCount,
                })}
              </p>
              {renderQuestionList(search.items)}
            </>
          )}

          {search.kind === 'empty' && (
            <p
              data-testid="mistake-detail-similar-empty"
              className="mt-2 rounded-lg border border-border px-2.5 py-3 text-center text-xs text-muted-foreground"
            >
              {t('mistakeDetail.similarEmpty', '没有找到同类题。换个更短的题干关键词试试（例如只保留公式或核心概念）。')}
            </p>
          )}

          {search.kind === 'unconfigured' && (
            <div
              data-testid="mistake-detail-similar-unconfigured"
              className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2"
            >
              <p className="text-xs text-muted-foreground">
                {t('mistakeDetail.similarUnconfigured', '还没有配置题库，配置后即可搜索同类题。')}
              </p>
              {onConfigureQuestionBank && (
                <DsButton
                  variant="outline"
                  size="sm"
                  className="mt-1.5 w-full"
                  data-testid="mistake-detail-configure-bank"
                  onClick={onConfigureQuestionBank}
                >
                  {t('mistakeDetail.goConfigure', '去配置题库')}
                </DsButton>
              )}
            </div>
          )}

          {search.kind === 'quota' && (
            <div
              data-testid="mistake-detail-similar-quota"
              className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-2"
            >
              <p className="text-xs text-muted-foreground">
                {t(
                  'mistakeDetail.similarQuota',
                  '今日免费试用额度已用完（匿名试用为每 24 小时 100 题）。免费注册后每日可搜 200 题。',
                )}
              </p>
              {/* register_url 由后端随 429 返回；挖不到时回落默认注册页 */}
              <a
                href={search.registerUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="mistake-detail-register"
                className="mt-1.5 inline-block text-xs font-medium text-primary underline"
              >
                {t('mistakeDetail.register', '免费注册提升额度')}
              </a>
            </div>
          )}

          {search.kind === 'error' && (
            <p
              data-testid="mistake-detail-similar-error"
              className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
            >
              {t('mistakeDetail.similarError', '搜索失败：{{msg}}', { msg: search.message })}
            </p>
          )}
        </section>

        {/* 展示内核：完整复用解析页的 AnalysisResultView（题干/解析/四态/Markdown+KaTeX） */}
        <AnalysisResultView
          data={data}
          phase={phase}
          isStreaming={isStreaming}
          error={error}
          // 解析页的返回按钮去处是 chat；本页去处是错题列表。
          // 传 undefined 让内核不画第二颗返回箭头——返回入口由统一顶栏提供。
          onBack={undefined}
          className="mx-3 mt-3"
        />
      </div>

      {/* 页内显式返回按钮：除了顶栏返回箭头之外，给一个底部兜底出口，
          避免任何情况下「进了详情出不去」。 */}
      {onBack && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <DsButton
            variant="outline"
            size="sm"
            className="w-full"
            data-testid="mistake-detail-back"
            onClick={onBack}
          >
            <ArrowLeft size={16} className="mr-1.5" aria-hidden="true" />
            {t('mistakeDetail.backToList', '返回错题列表')}
          </DsButton>
        </div>
      )}
    </div>
  );
};

export default MistakeDetailPage;
