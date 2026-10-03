/**
 * QuestionBankApiSection — 题库 API 配置区（E3）
 *
 * ## 位置
 * 挂在「设置 → 模型」Tab 内（用户要求「放在模型这一类里」）。
 *
 * ## 交互规格（用户原话逐条落地）
 * - 「未配置时在旁边要显示『去配置』这个按钮」→ 未配置：按钮可点，进入配置
 * - 「配置了就显示已配置且按钮无效」→ 已配置：按钮 disabled，文案「已配置」
 * - 「点击打开题库 api 配置」→ 点按钮展开下方的来源选择 + 凭据表单
 *
 * ## 为什么状态用「去配置 / 已配置」而不是开关
 * 这是**配置完整性**的表达，不是启用开关：填齐凭据即为已配置。
 * 用 disabled 而非隐藏，是为了让「已配置」这一事实可见。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';

import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

import {
  QUESTION_BANK_PROVIDERS,
  isProviderConfigured,
  isQuestionBankReady,
  type QuestionBankProviderId,
} from '@/features/practice/questionBank/config';
import { useQuestionBankConfig } from '@/features/practice/questionBank/useQuestionBankConfig';

export interface QuestionBankApiSectionProps {
  className?: string;
}

export const QuestionBankApiSection: React.FC<QuestionBankApiSectionProps> = ({ className }) => {
  const { t } = useTranslation();
  const {
    config,
    isLoaded,
    isSaving,
    error,
    setProvider,
    setCredential,
    setCredentials,
    save,
  } = useQuestionBankConfig();

  const [expanded, setExpanded] = useState(false);

  const ready = useMemo(() => isQuestionBankReady(config), [config]);
  const activeMeta = useMemo(
    () => QUESTION_BANK_PROVIDERS.find((p) => p.id === config.provider) ?? null,
    [config.provider],
  );
  const activeCredentials = config.provider
    ? (config.credentials[config.provider] ?? {})
    : {};

  const handleSelectProvider = useCallback(
    (id: QuestionBankProviderId) => {
      setProvider(id);
      setExpanded(true);
    },
    [setProvider],
  );

  const handleFillSandbox = useCallback(() => {
    if (!activeMeta?.sandboxUrl) return;
    setCredentials(activeMeta.id, {
      ...activeCredentials,
      baseUrl: activeMeta.sandboxUrl,
    });
  }, [activeMeta, activeCredentials, setCredentials]);

  return (
    <section
      data-testid="question-bank-api-section"
      className={cn('rounded-xl border border-border bg-card p-4', className)}
    >
      {/* 标题行：左侧说明 + 右侧状态按钮（用户规格的核心） */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            {t('settings:questionBank.title', '题库 API')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('settings:questionBank.subtitle', '刷题的数据来源。未配置时刷题不可用。')}
          </p>
        </div>

        <DsButton
          variant={ready ? 'outline' : 'default'}
          size="sm"
          data-testid="question-bank-status-button"
          data-configured={String(ready)}
          data-loading={String(!isLoaded)}
          // 加载中同样不可点，否则点了会展开一个还没读回配置的空面板。
          // 早期写法是仅 disabled={ready}，导致「加载中可点开空面板」。
          disabled={!isLoaded || ready}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0"
        >
          {!isLoaded ? (
            // 加载中：spinner + 文案，让「点不动」有解释
            <>
              <Loader2 size={14} className="mr-1 animate-spin" aria-hidden="true" />
              {t('settings:questionBank.loading', '读取中…')}
            </>
          ) : ready ? (
            <>
              <Check size={14} className="mr-1" aria-hidden="true" />
              {t('settings:questionBank.configured', '已配置')}
            </>
          ) : (
            t('settings:questionBank.goConfigure', '去配置')
          )}
        </DsButton>
      </div>

      {/* 已选中来源的一行摘要（配置完成或选了但没填齐都显示） */}
      {activeMeta && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-foreground">{activeMeta.label}</span>
          <span>·</span>
          <span>
            {isProviderConfigured(activeMeta.id, activeCredentials)
              ? t('settings:questionBank.filled', '凭据已填齐')
              : t('settings:questionBank.notFilled', '凭据未填齐')}
          </span>
        </div>
      )}

      {/* 配置面板 */}
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3" data-testid="question-bank-config-panel">
          {/* 来源三选一 */}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              {t('settings:questionBank.chooseProvider', '选择题库来源')}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {QUESTION_BANK_PROVIDERS.map((provider) => {
                const selected = config.provider === provider.id;
                const filled = isProviderConfigured(
                  provider.id,
                  config.credentials[provider.id],
                );
                return (
                  <button
                    key={provider.id}
                    type="button"
                    data-testid={`question-bank-provider-${provider.id}`}
                    data-selected={String(selected)}
                    onClick={() => handleSelectProvider(provider.id)}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">{provider.label}</span>
                      {filled && (
                        <Check
                          size={13}
                          className="text-emerald-500"
                          data-testid={`question-bank-provider-${provider.id}-filled`}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {provider.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 凭据表单：按所选来源的字段定义动态渲染 */}
          {activeMeta && (
            <div className="space-y-2" data-testid="question-bank-credential-form">
              {activeMeta.fields.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-xs text-muted-foreground">
                    {field.label}
                    {field.required && <span className="ml-0.5 text-destructive">*</span>}
                  </span>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    data-testid={`question-bank-field-${field.key}`}
                    value={activeCredentials[field.key] ?? ''}
                    placeholder={field.placeholder}
                    onChange={(e) => setCredential(activeMeta.id, field.key, e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                  />
                  {field.hint && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{field.hint}</span>
                  )}
                </label>
              ))}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {activeMeta.sandboxUrl && (
                  <DsButton
                    variant="outline"
                    size="sm"
                    data-testid="question-bank-fill-sandbox"
                    onClick={handleFillSandbox}
                  >
                    {t('settings:questionBank.fillSandbox', '填入沙箱地址')}
                  </DsButton>
                )}
                {activeMeta.docsUrl && (
                  <a
                    href={activeMeta.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    data-testid="question-bank-docs-link"
                  >
                    {t('settings:questionBank.viewDocs', '查看接口文档')}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
                <div className="flex-1" />
                <DsButton
                  size="sm"
                  data-testid="question-bank-save"
                  disabled={isSaving}
                  onClick={() => void save()}
                >
                  {isSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    t('settings:questionBank.save', '保存')
                  )}
                </DsButton>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          data-testid="question-bank-error"
          className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
        >
          {error}
        </div>
      )}
    </section>
  );
};

export default QuestionBankApiSection;
