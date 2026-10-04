/**
 * PracticeSessionPage — 刷题会话页（用户反馈 ③）
 *
 * ## 定位
 * 「复习 → 刷题 → 温故新知 / 自己定类型」的**落地页**。
 *
 * ## 为什么需要它（此前的缺口）
 * 用户反馈 ③：「生成题目时没有用题库 API 提取」。
 * 查实是**语义错配** —— 题库 API 被接在「错题详情页的找同类题」，
 * 而用户说的是**刷题链路**。而 `PracticeHubPage` 点「温故新知」时，
 * `App.tsx` 的 `onStartPractice` 只打一条 DEV log 然后 `setCurrentView('chat-v2')`
 * —— **什么都不发生**（用户可见的假功能）。
 *
 * ## 两种模式
 * - `review-variants`（温故新知）：从**最近错题**取题干 → 搜同类题 → 展示
 * - `by-category`（自己定类型）：按**学科/年级/知识点**自选范围 → 抽题
 *
 * ## 数据层
 * 全部走 `@/features/practice/questionBank/bankClient`（唯一 invoke 调用点）：
 * `searchQuestionBank` / `fetchQuestionBankMetaOutcome` / 归一化函数 / 错误分类。
 *
 * ## 用户可见的态（**不可合并成一句「失败」**）
 * 搜索的 5 种结果用户动作完全不同：
 * - `ok` 显示题目 / `empty` 换关键词 / `unconfigured` 去配置 /
 *   `quota` 注册提额 / `error` 具体错误
 * 故本页把它们渲染成**互不相同**的区块。
 *
 * ## 加载态是必须的
 * 实测题庄元数据接口**首次请求要 10.6 秒** —— 没有加载态用户会以为按钮坏了。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowsClockwise,
  Books,
  CircleNotch,
  MagnifyingGlass,
  WarningCircle,
} from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';

import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { useMistakeBook } from '@/features/review/hooks/useMistakeBook';
import {
  deriveAnalysisResultState,
  pickOcrQuestion,
} from '@/components/analysis/useAnalysisResultData';
import type { ChatStore } from '@/features/chat/core/types';

import {
  SEARCH_LIMIT,
  extractRegisterUrl,
  fetchQuestionBankMetaOutcome,
  isQuotaError,
  normalizeNumeric,
  normalizeStringList,
  normalizeSubQuestions,
  searchQuestionBank,
  toSearchKeyword,
  extractQuestionFromSession,
  type BankMetaItem,
  type BankMetaKind,
  type BankQuestion,
  type BankSearchParams,
} from '../questionBank/bankClient';
import { isQuestionBankReady } from '../questionBank/config';
import { MetaPicker } from '../questionBank/MetaPicker';
import { useQuestionBankConfig } from '../questionBank/useQuestionBankConfig';

// ============================================================================
// 类型
// ============================================================================

/** 刷题模式（与 `PracticeHubPage` 的 `PracticeMode` 对齐） */
export type PracticeSessionMode = 'review-variants' | 'by-category';

export interface PracticeSessionPageProps {
  /** 进入时的模式；由宿主按用户点的那一项注入 */
  mode?: PracticeSessionMode;
  /** 目标错题会话 id（`review-variants` 用；缺省则自动取最近一道） */
  sourceSessionId?: string | null;
  // 注：最近一道错题由本页自己取（`useMistakeBook` 是现成 hook，
  // 与错题本同源同口径）。不要求宿主注入 —— App 层并不持有会话列表
  // （它在 ChatV2Page 内部），强求注入会让 App 去重复拉一份数据。
  /** 返回 */
  onBack?: () => void;
  /** 去配置题库（导航到 设置 → 模型） */
  onConfigureQuestionBank?: () => void;
  className?: string;
}

/**
 * 本页的搜索状态机。
 *
 * 比 `bankClient` 的 `BankSearchOutcome` 多两个**纯 UI** 态
 * （`idle` 未开始 / `loading` 请求中）—— 它们不属于数据层语义。
 */
type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; items: BankQuestion[]; billedCount: number }
  | { kind: 'empty' }
  | { kind: 'quota'; registerUrl: string }
  | { kind: 'error'; message: string };

// ============================================================================
// 组件
// ============================================================================

export const PracticeSessionPage: React.FC<PracticeSessionPageProps> = ({
  mode = 'review-variants',
  sourceSessionId,
  onBack,
  onConfigureQuestionBank,
  className,
}) => {
  const { t } = useTranslation();
  const { config, isLoaded } = useQuestionBankConfig();
  const ready = useMemo(() => isQuestionBankReady(config), [isLoaded, config]);

  // 错题本（与「复习 → 错题本」同源同口径）：只用来取「最近一道」的 sessionId
  const { entries: mistakeEntries } = useMistakeBook();

  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  /** `review-variants`：用于搜题的题干（展示给用户看「这是我拿哪道题去搜的」） */
  const [sourceQuestion, setSourceQuestion] = useState<string | null>(null);
  /** `by-category`：当前选中的元数据（学科/年级） */
  const [subjectId, setSubjectId] = useState<number | undefined>(undefined);
  const [gradeId, setGradeId] = useState<number | undefined>(undefined);

  const headerTitle = mode === 'review-variants'
    ? t('practiceSession.reviewVariants', '温故新知')
    : t('practiceSession.byCategory', '自己定类型');

  useMobileHeader(
    'practice-session',
    {
      title: headerTitle,
      // 二级页：有真实上一页，给页内返回（与 knowledge-cards 同构：
      // 本页由 review Tab 内推入，不抑制全局返回）
      showBackArrow: Boolean(onBack),
      onMenuClick: onBack,
    },
    [headerTitle, onBack],
  );

  /** 从错题会话取题干（温故新知的第一步） */
  const resolveSourceQuestion = useCallback((): { sessionId: string | null; question: string | null } => {
    const sessionId = sourceSessionId ?? mistakeEntries[0]?.sessionId ?? null;
    if (!sessionId) return { sessionId: null, question: null };
    const question = extractQuestionFromSession(sessionId, {
      getStore: (id) => sessionManager.get(id),
      // 复用详情页同款纯函数：deriveAnalysisResultState 内部口径一致
      // （优先 OCR 题干，回落最后一条 user 消息）
      pickQuestion: (storeState) => {
        if (!storeState || typeof storeState !== 'object') return null;
        const derived = deriveAnalysisResultState(storeState as Parameters<typeof deriveAnalysisResultState>[0]);
        return derived?.data?.question ?? null;
      },
    });
    return { sessionId, question };
  }, [sourceSessionId, mistakeEntries]);

  /** 执行一次搜索 */
  const runSearch = useCallback(async (params: BankSearchParams) => {
    setState({ kind: 'loading' });
    try {
      const res = await searchQuestionBank({ ...params, limit: params.limit ?? SEARCH_LIMIT });
      setState(res.items.length > 0
        ? { kind: 'ok', items: res.items, billedCount: res.billedCount }
        : { kind: 'empty' });
    } catch (err) {
      // 额度耗尽与其它错误**分开**：用户动作完全不同
      if (isQuotaError(err)) {
        setState({ kind: 'quota', registerUrl: extractRegisterUrl(err) });
        return;
      }
      setState({ kind: 'error', message: getErrorMessage(err) });
    }
  }, []);

  /** 温故新知：取错题题干 → 搜同类题 */
  const startReviewVariants = useCallback(async () => {
    const { sessionId, question } = resolveSourceQuestion();
    setSourceQuestion(question);
    if (!sessionId) {
      setState({ kind: 'empty' });
      return;
    }
    if (!question) {
      // 有错题但取不到题干（OCR 未完成 / 空题）→ 明确的空态而非静默失败
      setState({ kind: 'empty' });
      return;
    }
    const keyword = toSearchKeyword(question);
    if (!keyword) {
      setState({ kind: 'empty' });
      return;
    }
    await runSearch({ keyword });
  }, [resolveSourceQuestion, runSearch]);

  // 元数据由 `MetaPicker` 自行拉取（含五态分流与防循环），本页不再重复请求。

  /** 首屏自动开跑（两种模式各自的第一步） */
  useEffect(() => {
    if (!isLoaded || !ready) return;
    if (mode === 'review-variants' && state.kind === 'idle') {
      void startReviewVariants();
    }
    // by-category 不自动搜：先让用户选范围（元数据由上面的 effect 拉）
  }, [isLoaded, ready, mode, state.kind, startReviewVariants]);

  /** 未配置题库：置灰 + 引导（不静默失败） */
  if (isLoaded && !ready) {
    return (
      <div
        data-testid="practice-session-page"
        data-ready="false"
        className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      >
        <div className="m-3 rounded-lg border border-border bg-card p-4">
          <div className="text-sm font-medium text-foreground">
            {t('practiceSession.notConfigured', '题库 API 未配置')}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t('practiceSession.notConfiguredHint', '先在「设置 → 模型 → 题库 API」里选一个题库来源才能刷题。')}
          </div>
          {onConfigureQuestionBank && (
            <DsButton className="mt-3" onClick={onConfigureQuestionBank}>
              {t('practiceSession.goConfigure', '去配置')}
            </DsButton>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="practice-session-page"
      data-mode={mode}
      data-ready={String(ready)}
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      {/* 温故新知：显示「拿哪道题去搜的」—— 用户需要知道来源，否则不知道在做什么 */}
      {mode === 'review-variants' && sourceQuestion && (
        <div className="border-b border-border px-3 py-2" data-testid="practice-session-source">
          <div className="text-[11px] text-muted-foreground">
            {t('practiceSession.sourceLabel', '根据这道错题找同类题')}
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-foreground/80">{sourceQuestion}</div>
        </div>
      )}

      {/* 自己定类型：范围选择（元数据免费，不进额度） */}
      {mode === 'by-category' && (
        <div className="border-b border-border px-3 py-2" data-testid="practice-session-scope">
          <div className="text-[11px] text-muted-foreground">
            {t('practiceSession.scopeLabel', '选择题库范围')}
          </div>
          {/*
            ⚠️ 用 `MetaPicker`，不在此内联选择器：
            它已带 32 个契约测试（`questionBankMetaContract.test.tsx`）、
            五态分流（loading/unconfigured/error/zero/ok），
            以及**防级联参数导致无限取数循环**（serializeParams + 固定字段序）。
            内联实现这些都要重做且无契约保护。
          */}
          <div className="mt-2">
            <MetaPicker
              kind="subjects"
              label={t('practiceSession.subjectLabel', '学科')}
              value={subjectId}
              onChange={(id) => setSubjectId(typeof id === 'number' ? id : undefined)}
              isConfigured={ready}
              onConfigure={onConfigureQuestionBank}
            />
          </div>
          {subjectId !== undefined && (
            <div className="mt-2">
              <MetaPicker
                kind="grades"
                label={t('practiceSession.gradeLabel', '年级')}
                value={gradeId}
                params={{ subjectId }}
                onChange={(id) => setGradeId(typeof id === 'number' ? id : undefined)}
                isConfigured={ready}
                onConfigure={onConfigureQuestionBank}
              />
            </div>
          )}
          <DsButton
            className="mt-2"
            disabled={subjectId === undefined}
            onClick={() => void runSearch({ subjectId, gradeId })}
            data-testid="practice-session-search-scope"
          >
            <MagnifyingGlass size={14} className="mr-1" />
            {t('practiceSession.pullQuestions', '按此范围抽题')}
          </DsButton>
        </div>
      )}

      {/* 内容区：按状态渲染互不相同的区块 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground" data-testid="practice-session-loading" role="status" aria-live="polite">
            <CircleNotch size={16} className="animate-spin" aria-hidden="true" />
            <span className="text-sm">{t('practiceSession.searching', '正在题库里找题…')}</span>
          </div>
        )}

        {state.kind === 'empty' && (
          <div className="py-8 text-center" data-testid="practice-session-empty">
            <div className="text-sm text-foreground">{t('practiceSession.emptyTitle', '没找到同类题')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {mode === 'review-variants'
                ? t('practiceSession.emptyHintVariants', '这道错题可能没有对应的题库记录。可以试试「自己定类型」按知识点抽题。')
                : t('practiceSession.emptyHintScope', '换个范围试试（如换个学科或年级）。')}
            </div>
          </div>
        )}

        {state.kind === 'quota' && (
          <div className="py-8 text-center" data-testid="practice-session-quota">
            <div className="text-sm text-foreground">{t('practiceSession.quotaTitle', '试用额度已用完')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('practiceSession.quotaHint', '匿名试用是 24 小时 100 题；免费注册后每天 200 题起。')}
            </div>
            <a
              className="mt-3 inline-block text-xs text-primary underline"
              href={state.registerUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="practice-session-register-link"
            >
              {t('practiceSession.quotaRegister', '免费注册提升额度')}
            </a>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="py-8 text-center" data-testid="practice-session-error">
            <WarningCircle size={18} className="mx-auto text-destructive" aria-hidden="true" />
            <div className="mt-1 text-sm text-foreground">{t('practiceSession.errorTitle', '搜题失败')}</div>
            <div className="mt-1 text-xs text-muted-foreground">{state.message}</div>
            <DsButton
              className="mt-3"
              variant="ghost"
              onClick={() => void (mode === 'review-variants' ? startReviewVariants() : runSearch({ subjectId, gradeId }))}
            >
              <ArrowsClockwise size={14} className="mr-1" />
              {t('practiceSession.retry', '重试')}
            </DsButton>
          </div>
        )}

        {state.kind === 'ok' && (
          <>
            <div className="mb-2 flex items-center justify-between" data-testid="practice-session-count">
              <span className="text-xs text-muted-foreground">
                {t('practiceSession.foundCount', '找到 {{count}} 道同类题', { count: state.items.length })}
              </span>
              {/* 计费口径用后端给的 billedCount，不用 items.length */}
              <span className="text-[11px] text-muted-foreground">
                {t('practiceSession.billed', '本次消耗 {{n}} 题额度', { n: state.billedCount })}
              </span>
            </div>
            <ul className="space-y-2" data-testid="practice-session-list">
              {state.items.map((q, i) => (
                <PracticeQuestionItem key={q.id ?? `q-${i}`} question={q} index={i} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * 渲染单道题。
 *
 * ⚠️ 所有 `Value` 字段先经归一函数（Rust 为防上游类型漂移透传了
 * `options`/`answer`/`subquestions`/`difficulty`/`year`，实际类型取决于上游）。
 * `*_html` 字段是**不受信任的 HTML** → 绝不 `dangerouslySetInnerHTML`。
 */
const PracticeQuestionItem: React.FC<{ question: BankQuestion; index: number }> = ({ question, index }) => {
  const options = normalizeStringList(question.options);
  const answer = normalizeStringList(question.answer);
  const subs = normalizeSubQuestions(question.subquestions);
  const difficulty = normalizeNumeric(question.difficulty);
  const year = normalizeNumeric(question.year);
  const title = typeof question.title === 'string' ? question.title : '';

  return (
    <li
      className="rounded-lg border border-border bg-card p-3"
      data-testid={`practice-session-question-${index}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          {/* 题干是原始 LaTeX，直接展示（本页不引入 Markdown 内核，避免过重） */}
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">{title}</div>

          {options.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {options.map((opt, oi) => (
                <li key={oi} className="text-xs text-foreground/80">{opt}</li>
              ))}
            </ul>
          )}

          {subs.length > 0 && (
            <ol className="mt-2 space-y-1.5 border-l-2 border-border pl-2">
              {subs.map((sub, si) => (
                <li key={si} className="text-xs">
                  <div className="whitespace-pre-wrap break-words text-foreground/90">
                    ({si + 1}) {sub.title}
                  </div>
                  {sub.options.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {sub.options.map((o, oi) => (
                        <li key={oi} className="text-foreground/70">{o}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}

          {answer.length > 0 && (
            <div className="mt-2 rounded bg-accent/50 px-2 py-1 text-xs text-accent-foreground">
              <span className="font-medium">答案：</span>
              {answer.join('；')}
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {typeof question.question_type === 'string' && question.question_type && (
              <span>{question.question_type}</span>
            )}
            {difficulty !== null && <span>难度 {difficulty}</span>}
            {year !== null && <span>{year} 年</span>}
            {typeof question.source === 'string' && question.source && (
              <span className="truncate">{question.source}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
};

export default PracticeSessionPage;
