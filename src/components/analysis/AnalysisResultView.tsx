/**
 * AnalysisResultView — 解析结果全屏视图（A3-P0）
 *
 * 定位：用户 P0 线「拍题 → 解析 → 错题 → 复习」的中间环节。本组件是**组装层**，
 * 不是重建 —— Markdown / LaTeX / 代码高亮 / 流式渲染全部复用 chat 侧既有基底：
 *
 * - Markdown + GFM + KaTeX + 引用徽章 → `MarkdownRenderer`
 *   (`src/features/chat/components/renderers/MarkdownRenderer.tsx:644`)
 * - 流式打字机（按 markdown 块独立 memo）→ `StreamingMarkdownRenderer`
 *   (`src/features/chat/components/renderers/StreamingMarkdownRenderer.tsx:67`)
 * - 代码高亮（Prism 懒加载 + 复制按钮）→ 由 MarkdownRenderer 内部经 `CodeBlock` 自动处理
 *   (`src/features/chat/components/renderers/CodeBlock.tsx:274`)
 *
 * 三者均按 `src/features/chat/components/renderers/index.ts:1-6` 自述为
 * 「纯展示组件，不订阅 Store」，因此可脱离 ChatStore 独立渲染 —— 这是本组件
 * 能做成可静态验证视图的前提。
 *
 * 健壮性（对应任务风险项）：拍题入口存在真机缺口，可能不传数据过来。
 * 组件对 `data == null` / 字段缺失 / 字段类型不符 **一律不抛异常**，覆盖：
 * 空态、加载态、错误态、有解析结果态。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CircleNotch,
  WarningCircle,
  MagnifyingGlass,
  Lightbulb,
  Tag as TagIcon,
  NotePencil,
  Copy,
  Check,
  ArrowClockwise,
} from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
// 移动端统一顶栏注册：本视图直挂本组件（与 pdf-reader / ui-lab 同构），
// 由 mobileHeaderViewRegistryContract 契约要求每个 CurrentView 成员都有注册点。
import { useMobileHeader } from '@/components/layout';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getErrorMessage } from '@/utils/errorUtils';

import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { StreamingMarkdownRenderer } from '@/features/chat/components/renderers/StreamingMarkdownRenderer';

// ============================================================================
// 类型
// ============================================================================

/** 解析阶段：与 chat analysis 模式的 ocrStatus 语义对齐，外加 'ready'（已有结果） */
export type AnalysisPhase = 'empty' | 'loading' | 'error' | 'ready';

/**
 * 解析结果数据。**全部字段可选** —— OCR 可能只识别出题目、无解析；
 * 拍题入口可能不传数据。组件内部对每个字段单独做存在性与类型校验。
 */
export interface AnalysisResultData {
  /** 识别出的题目文本 */
  question?: string | null;
  /** 识别出的答案/解析 */
  answer?: string | null;
  /** 原始 OCR 文本 */
  rawText?: string | null;
  /** 识别标签 */
  tags?: readonly string[] | null;
  /** 题目类型 */
  questionType?: string | null;
  /** 关联图片（base64 / URL）；不渲染，仅作存在性提示 */
  imageCount?: number | null;
}

export interface AnalysisResultViewProps {
  /** 解析结果数据；null/undefined 一律走空态 */
  data?: AnalysisResultData | null;

  /** 显式指定阶段；省略时由 data 推导（见 resolvePhase） */
  phase?: AnalysisPhase;

  /** 加载中提示文案（缺省走 i18n） */
  loadingHint?: string;

  /** 错误信息；phase='error' 时展示 */
  error?: string | null;

  /** 是否流式输出中（透传给 StreamingMarkdownRenderer） */
  isStreaming?: boolean;

  /** 返回回调；省略则不渲染返回按钮 */
  onBack?: () => void;

  /** 重试回调；phase='error' 或空态下渲染 */
  onRetry?: () => void;

  /** 学习笔记变更（与 OcrResultCard 的 note 语义一致） */
  note?: string | null;
  onNoteChange?: (next: string) => void;

  className?: string;
}

// ============================================================================
// 健壮性工具：所有字段访问都过这里，杜绝 undefined/null/类型不符导致的抛错
// ============================================================================

/** 安全取字符串：非字符串或空串（含纯空白）→ null */
function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 安全取标签数组：过滤非字符串与空项，去重，保持原序 */
function safeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = safeText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

/** 安全取计数：非有限数或负数 → null */
function safeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** 判定是否含任何可展示内容 */
function hasAnyContent(data: AnalysisResultData | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  return (
    safeText(data.question) !== null
    || safeText(data.answer) !== null
    || safeText(data.rawText) !== null
    || safeTags(data.tags).length > 0
    || safeText(data.questionType) !== null
  );
}

/**
 * 阶段推导：显式 phase 优先；否则**只依据是否存在可展示内容**判定，
 * 不依据 data 对象本身是否存在（空对象 `{}` 必须落回空态，不能渲染成空白页）。
 */
function resolvePhase(
  explicit: AnalysisPhase | undefined,
  data: AnalysisResultData | null | undefined,
  error: string | null | undefined,
): AnalysisPhase {
  if (explicit) return explicit;
  if (safeText(error) !== null) return 'error';
  return hasAnyContent(data) ? 'ready' : 'empty';
}

// ============================================================================
// 子组件
// ============================================================================

const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  testId: string;
  children: React.ReactNode;
}> = ({ icon, title, testId, children }) => (
  <section
    data-testid={testId}
    className="rounded-xl border border-border bg-card overflow-hidden"
  >
    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
      <span className="text-muted-foreground shrink-0" aria-hidden="true">{icon}</span>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
    </div>
    <div className="px-4 py-3">{children}</div>
  </section>
);

/** 加载态骨架：复用 Skeleton，形状对齐「题目 + 解析」两段 */
const LoadingState: React.FC<{ hint: string }> = ({ hint }) => (
  <div
    data-testid="analysis-result-loading"
    role="status"
    aria-busy="true"
    aria-live="polite"
    className="flex flex-col gap-4"
  >
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleNotch size={16} className="animate-spin shrink-0" aria-hidden="true" />
      <span>{hint}</span>
    </div>
    <div className="space-y-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  </div>
);

/** 空态：拍题入口可能不传数据，这里是**正常路径**而非异常路径 */
const EmptyState: React.FC<{ onRetry?: () => void; hint: string; actionLabel: string }> = ({
  onRetry,
  hint,
  actionLabel,
}) => (
  <div
    data-testid="analysis-result-empty"
    className="flex flex-col items-center justify-center gap-3 py-16 text-center"
  >
    <MagnifyingGlass size={32} className="text-muted-foreground/50" aria-hidden="true" />
    <p className="text-sm text-muted-foreground max-w-sm">{hint}</p>
    {onRetry && (
      <DsButton variant="outline" size="sm" onClick={onRetry} data-testid="analysis-result-empty-action">
        <ArrowClockwise size={14} aria-hidden="true" />
        {actionLabel}
      </DsButton>
    )}
  </div>
);

/** 错误态 */
const ErrorState: React.FC<{ message: string; onRetry?: () => void; actionLabel: string }> = ({
  message,
  onRetry,
  actionLabel,
}) => (
  <div
    data-testid="analysis-result-error"
    role="alert"
    className="flex flex-col items-center justify-center gap-3 py-16 text-center"
  >
    <WarningCircle size={32} className="text-[color:var(--destructive)]" aria-hidden="true" />
    <p className="text-sm text-foreground max-w-sm break-words">{message}</p>
    {onRetry && (
      <DsButton variant="outline" size="sm" onClick={onRetry} data-testid="analysis-result-retry">
        <ArrowClockwise size={14} aria-hidden="true" />
        {actionLabel}
      </DsButton>
    )}
  </div>
);

// ============================================================================
// 主组件
// ============================================================================

export const AnalysisResultView: React.FC<AnalysisResultViewProps> = ({
  data = null,
  phase: phaseProp,
  loadingHint,
  error = null,
  isStreaming = false,
  onBack,
  onRetry,
  note = null,
  onNoteChange,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);

  // 所有派生值都过安全工具，data 为 null / 形状不符均不抛异常
  const question = safeText(data?.question);
  const answer = safeText(data?.answer);
  const rawText = safeText(data?.rawText);
  const tags = safeTags(data?.tags);
  const questionType = safeText(data?.questionType);
  const imageCount = safeCount(data?.imageCount);

  const phase = resolvePhase(phaseProp, data, error);
  const errorMessage = safeText(error);

  const resolvedLoadingHint = loadingHint ?? t('analysisResult.loading', '正在解析题目…');
  const retryLabel = t('analysisResult.retry', '重试');

  // 复制内容 = 题目 + 解析的纯文本拼接；两者皆无时不复制
  const copyPayload = useMemo(() => {
    const parts: string[] = [];
    if (question) parts.push(question);
    if (answer) parts.push(answer);
    if (parts.length === 0 && rawText) parts.push(rawText);
    return parts.join('\n\n');
  }, [question, answer, rawText]);

  const handleCopy = useCallback(async () => {
    if (!copyPayload) return;
    try {
      await copyTextToClipboard(copyPayload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    }
  }, [copyPayload]);

  const handleNoteChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onNoteChange?.(e.target.value);
    },
    [onNoteChange],
  );

  const headerTitle = t('analysisResult.title', '解析结果');

  // 移动端统一顶栏注册（viewId 必须与 CurrentView 成员、canonicalView.ts 的
  // BASE_CANONICAL_VIEWS 条目、mobileHeaderViewRegistryContract 的映射表三者一致）。
  //
  // 关于 enabled 参数：TodoContentView 传 inWorkbenchWindow === false，是为了
  // 防止「窗口化承载实例」与「独立视图实例」共用 'todo' viewId 时互相抢写顶栏。
  // 本组件不传（即默认 true = 始终启用），理由：
  //   1. 'analysis-result' 目前只有「全屏独立视图」一种承载形态，不存在同名
  //      viewId 的第二个实例，无抢写可能；
  //   2. 本页刻意不做成 workbench 应用（拍题是任务流而非常驻工作台），
  //      不参与 Learning OS 窗口化；
  //   3. 若将来需要以嵌入形态复用，必须改为按承载形态传 enabled，否则会
  //      覆盖/误清单例配置（先例见 TodoContentView.tsx:264-278）。
  // onBack 存在时才给返回箭头，与 PdfReader 的 showBackArrow 用法一致。
  useMobileHeader(
    'analysis-result',
    {
      title: headerTitle,
      showBackArrow: Boolean(onBack),
      onMenuClick: onBack,
    },
    [headerTitle, onBack],
  );

  return (
    <div
      data-testid="analysis-result-view"
      data-phase={phase}
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {onBack && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onBack}
            aria-label={t('analysisResult.back', '返回')}
            data-testid="analysis-result-back"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </DsButton>
        )}
        <h1 className="flex-1 truncate text-base font-medium text-foreground">{headerTitle}</h1>
        {questionType && (
          <Badge variant="secondary" data-testid="analysis-result-question-type">
            {questionType}
          </Badge>
        )}
        {phase === 'ready' && copyPayload && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={handleCopy}
            aria-label={t('analysisResult.copy', '复制解析')}
            data-testid="analysis-result-copy"
          >
            {copied
              ? <Check size={18} aria-hidden="true" />
              : <Copy size={18} aria-hidden="true" />}
          </DsButton>
        )}
      </header>

      <CustomScrollArea className="flex-1" viewportClassName="flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 flex flex-col gap-4">
          {phase === 'loading' && <LoadingState hint={resolvedLoadingHint} />}

          {phase === 'error' && (
            <ErrorState
              message={errorMessage ?? t('analysisResult.unknownError', '解析失败，请重试')}
              onRetry={onRetry}
              actionLabel={retryLabel}
            />
          )}

          {phase === 'empty' && (
            <EmptyState
              hint={t(
                'analysisResult.emptyHint',
                '还没有解析结果。拍一张题目照片或从相册选图，识别后结果会显示在这里。',
              )}
              onRetry={onRetry}
              actionLabel={retryLabel}
            />
          )}

          {phase === 'ready' && (
            <>
              {/* 原图存在性提示（不渲染图片本体，避免 base64 大对象进 DOM） */}
              {imageCount !== null && imageCount > 0 && (
                <p
                  data-testid="analysis-result-image-count"
                  className="text-xs text-muted-foreground"
                >
                  {t('analysisResult.imageCount', '已附 {{count}} 张题目图片', { count: imageCount })}
                </p>
              )}

              {/* 题干 */}
              {question && (
                <SectionCard
                  icon={<MagnifyingGlass size={16} weight="bold" />}
                  title={t('analysisResult.question', '题目')}
                  testId="analysis-result-question"
                >
                  <MarkdownRenderer content={question} />
                </SectionCard>
              )}

              {/* 解析 / 答案：流式时走 StreamingMarkdownRenderer，静态走 MarkdownRenderer */}
              {answer && (
                <SectionCard
                  icon={<Lightbulb size={16} weight="bold" />}
                  title={t('analysisResult.answer', '解析')}
                  testId="analysis-result-answer"
                >
                  {isStreaming ? (
                    <StreamingMarkdownRenderer content={answer} isStreaming />
                  ) : (
                    <MarkdownRenderer content={answer} />
                  )}
                </SectionCard>
              )}

              {/* 标签 */}
              {tags.length > 0 && (
                <SectionCard
                  icon={<TagIcon size={16} weight="bold" />}
                  title={t('analysisResult.tags', '知识点')}
                  testId="analysis-result-tags"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <Badge key={tag} variant="outline">{tag}</Badge>
                    ))}
                  </div>
                </SectionCard>
              )}

              {/* 原始 OCR 文本（可折叠，默认收起） */}
              {rawText && rawText !== question && (
                <details
                  data-testid="analysis-result-raw"
                  className="rounded-xl border border-border bg-card px-4 py-2.5"
                >
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    {t('analysisResult.rawText', '原始识别文本')}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {rawText}
                  </pre>
                </details>
              )}

              {/* 学习笔记：仅在宿主提供 onNoteChange 时渲染可编辑态 */}
              {onNoteChange && (
                <SectionCard
                  icon={<NotePencil size={16} weight="bold" />}
                  title={t('analysisResult.note', '学习笔记')}
                  testId="analysis-result-note"
                >
                  <textarea
                    value={typeof note === 'string' ? note : ''}
                    onChange={handleNoteChange}
                    rows={3}
                    data-testid="analysis-result-note-input"
                    className={cn(
                      'w-full resize-y rounded-lg border border-border bg-background px-3 py-2',
                      'text-sm text-foreground placeholder:text-muted-foreground',
                      'focus:outline-none focus:ring-2 focus:ring-ring',
                    )}
                    placeholder={t('analysisResult.notePlaceholder', '记下你的思路或易错点…')}
                  />
                </SectionCard>
              )}
            </>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default AnalysisResultView;
