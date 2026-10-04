/**
 * PracticeHubPage — 刷题入口页（E3）
 *
 * ## 定位
 * 「复习 → 刷题」的落地页。用户要求刷题**独立于卡片逻辑**（不与 flashcards 共用），
 * 故本页自成一套：三种进入方式 + 题库 API 就绪门禁。
 *
 * ## 三种选择（用户规格）
 * 1. **温故新知** —— 做错题与其变式（题库的「举一反三/错题反馈」能力）
 * 2. **自己定类型** —— 按知识点、单元自选范围
 * 3. （第三种由「自定义」题库来源覆盖，见 practice 的 provider 配置；
 *     本页把前两种做成主入口，第三种在题库配置里体现）
 *
 * ## 未配置题库 API 时的行为
 * 用户拍板「默认空，强制用户选」。故未配置时：
 * - 两个入口**置灰不可点**（而不是点了再报错）
 * - 顶部给出明确引导条：「题库 API 未配置」+「去配置」按钮
 * 这样用户一眼知道为什么点不动，而不是遇到莫名的失败。
 */

import React, { useCallback, useMemo } from 'react';
import { ArrowLeft, BookOpen, Repeat, Sparkles, Settings2 } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import { isQuestionBankReady } from '@/features/practice/questionBank/config';
import { useQuestionBankConfig } from '@/features/practice/questionBank/useQuestionBankConfig';

export type PracticeMode = 'review-variants' | 'by-category';

export interface PracticeHubPageProps {
  onBack?: () => void;
  /** 进入某个刷题模式（由宿主注入导航） */
  onStartPractice?: (mode: PracticeMode) => void;
  /** 打开设置里的题库 API 配置（由宿主注入导航到 设置→模型） */
  onConfigureQuestionBank?: () => void;
  className?: string;
}

interface PracticeEntry {
  mode: PracticeMode;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  accentClass: string;
}

const ENTRIES: readonly PracticeEntry[] = [
  {
    mode: 'review-variants',
    title: '温故新知',
    subtitle: '做错题与同类变式',
    icon: Repeat,
    accentClass: 'text-amber-500',
  },
  {
    mode: 'by-category',
    title: '自己定类型',
    subtitle: '按知识点、单元自选范围',
    icon: BookOpen,
    accentClass: 'text-emerald-500',
  },
];

export const PracticeHubPage: React.FC<PracticeHubPageProps> = ({
  onBack,
  onStartPractice,
  onConfigureQuestionBank,
  className,
}) => {
  const { t } = useTranslation();
  const { config, isLoaded } = useQuestionBankConfig();

  const ready = useMemo(() => isQuestionBankReady(config), [config]);
  const headerTitle = t('practiceHub.title', '刷题');

  /**
   * 顶栏。
   *
   * ⚠️ `suppressGlobalBackButton: true` 是必需的：刷题页是 practice 路径的**根页**，
   *    没有「上一页」可回。不抑制时统一顶栏会渲染全局返回按钮
   *    （UnifiedMobileHeader.tsx 的兜底分支），用户会看到左上角一个
   *    点了不知道去哪的返回箭头。
   *
   *    与 CapturePage / ReviewHubPage 同一个 bug class。
   */
  useMobileHeader(
    'practice-hub',
    {
      title: headerTitle,
      suppressGlobalBackButton: true,
      showBackArrow: Boolean(onBack),
      onMenuClick: onBack,
    },
    [headerTitle, onBack],
  );

  const handleStart = useCallback(
    (mode: PracticeMode) => {
      if (!ready) return;
      onStartPractice?.(mode);
    },
    [ready, onStartPractice],
  );

  return (
    <div
      data-testid="practice-hub-page"
      data-ready={String(ready)}
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {onBack && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onBack}
            aria-label={t('practiceHub.back', '返回')}
            data-testid="practice-hub-back"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </DsButton>
        )}
        <h1 className="flex-1 truncate text-base font-medium text-foreground">{headerTitle}</h1>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onConfigureQuestionBank}
          aria-label={t('practiceHub.configure', '题库 API 配置')}
          data-testid="practice-hub-configure-icon"
        >
          <Settings2 size={18} aria-hidden="true" />
        </DsButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* 未配置引导条：说清「为什么点不动」 */}
        {isLoaded && !ready && (
          <div
            data-testid="practice-hub-not-configured"
            className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
          >
            <div className="flex items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {t('practiceHub.notConfiguredTitle', '题库 API 未配置')}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t(
                    'practiceHub.notConfiguredDesc',
                    '刷题需要题库数据源。请先选择题库来源并填写凭据。',
                  )}
                </div>
                <DsButton
                  size="sm"
                  className="mt-2"
                  data-testid="practice-hub-go-configure"
                  onClick={onConfigureQuestionBank}
                >
                  {t('practiceHub.goConfigure', '去配置')}
                </DsButton>
              </div>
            </div>
          </div>
        )}

        {/* 两种刷题方式 */}
        <div className="grid gap-3" data-testid="practice-hub-entries">
          {ENTRIES.map((entry) => {
            const Icon = entry.icon;
            const disabled = !ready;
            return (
              <button
                key={entry.mode}
                type="button"
                data-testid={`practice-hub-entry-${entry.mode}`}
                data-disabled={String(disabled)}
                disabled={disabled}
                onClick={() => handleStart(entry.mode)}
                className={cn(
                  'flex items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors',
                  disabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-accent active:bg-accent',
                )}
              >
                <Icon className={cn('size-6 shrink-0', entry.accentClass)} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{entry.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{entry.subtitle}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PracticeHubPage;
