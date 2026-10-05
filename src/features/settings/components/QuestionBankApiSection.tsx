/**
 * QuestionBankApiSection — 题库 API 配置区（E3）
 *
 * ## 位置
 * 挂在「设置 → 模型」Tab 内（用户要求「放在模型这一类里」）。
 *
 * ## 交互规格（用户原话逐条落地）
 * - 「未配置时在旁边要显示『去配置』这个按钮」→ 未配置：按钮可点，进入配置
 * - 「配置了就显示已配置且按钮无效」→ 已配置：按钮文案「已配置」
 * - 「点击打开题库 api 配置」→ 点按钮展开下方的来源选择 + 凭据表单
 *
 * ## ⚠️ E9 修正：已配置**不再禁用**（用户后续提出）
 * 原实现严格照「配置了就禁用」做，结果是**配完即锁死**：填错来源、想换 key、
 * 想升级套餐全部做不到。用户实测反馈「题库配置后没有修改按钮」。
 * 现改为：已配置时按钮**仍可点**，点击展开面板即可修改；想要清空则用
 * 面板内的「清除配置」。即 disabled 只保留「加载中」这一种情形。
 *
 * ## 为什么状态用「去配置 / 已配置」而不是开关
 * 这是**配置完整性**的表达，不是启用开关：填齐凭据即为已配置。
 * 按钮始终可见，是为了让「已配置」这一事实可见。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, Stethoscope, Trash2 } from 'lucide-react';

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
import { fetchQuestionBankQuota, extractErrorCode, extractRegisterUrl, DEFAULT_REGISTER_URL } from '@/features/practice/questionBank/bankClient';
import { getErrorMessage } from '@/utils/errorUtils';

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
    clear,
  } = useQuestionBankConfig();

  const [expanded, setExpanded] = useState(false);
  /** 「清除配置」的二次确认（E9）——清掉的是加密存储的凭据，必须防误触 */
  const [confirmClear, setConfirmClear] = useState(false);

  // 就绪判据与来源元信息：必须声明在 handleProbe **之前**（它会读 ready）。
  const ready = useMemo(() => isQuestionBankReady(config), [config]);
  const activeMeta = useMemo(
    () => QUESTION_BANK_PROVIDERS.find((p) => p.id === config.provider) ?? null,
    [config.provider],
  );
  const activeCredentials = config.provider
    ? (config.credentials[config.provider] ?? {})
    : {};

  /**
   * 题库自检（E9 新增）。
   *
   * ## 为什么必须做这个按钮
   * 用户报告「保存了但刷题用不了」，静态核对**每一环都是通的**
   * （字段名/保存命令/加密通道/后端解析/真实 API 全部验过），
   * 但真机上就是不通 —— 说明断点在**运行期**，读代码找不出来。
   *
   * 而抓真机日志成本很高（要连线、要过滤小米系统进程的噪声）。
   * 所以把「链路探测」做进 App：点一下，依次走完
   *   ① 前端配置就绪判据 → ② 后端凭据解析 + 真实打一次 API
   * 并把每一步的结果用人话摊开。断在哪一步，一眼可见。
   *
   * ⚠️ 探测本身会**消费匿名试用额度**（真实请求上游）——
   *    所以文案里明确说了，不隐瞒代价。
   */
  const [probe, setProbe] = useState<null | {
    at: string;
    ready: boolean;
    provider: string;
    ok: boolean;
    detail: string;
    code?: string | null;
    registerUrl?: string | null;
  }>(null);
  const [isProbing, setIsProbing] = useState(false);

  const handleProbe = useCallback(async () => {
    setIsProbing(true);
    setProbe(null);
    const at = new Date().toLocaleTimeString();
    try {
      // ② 真实打一次上游（后端会自行解析 License / 走匿名试用）
      const quota = await fetchQuestionBankQuota();
      setProbe({
        at,
        ready,
        provider: config.provider ?? '(未选择)',
        ok: true,
        detail: quota
          ? `已用 ${quota.used ?? '?'} / 上限 ${quota.questionLimit ?? '?'}，剩余 ${quota.remaining ?? '?'}${quota.usedTrial ? '（匿名试用通道）' : '（License 通道）'}`
          : t('settings:questionBank.probe.emptyBody', '上游返回空响应（可能是网络或地址错误）'),
      });
    } catch (err) {
      // 失败也要把「后端到底报了什么」原样摊开 —— 这正是用户缺的信息
      const code = extractErrorCode(err);
      // extractRegisterUrl **总有返回值**（兜底 DEFAULT_REGISTER_URL），
      // 故只在它给出「非默认」地址时才展示 —— 否则每次都贴一条默认链接，是噪声。
      const registerUrl = extractRegisterUrl(err);
      setProbe({
        at,
        ready,
        provider: config.provider ?? '(未选择)',
        ok: false,
        detail: getErrorMessage(err) || t('settings:questionBank.probe.unknownError', '未知错误'),
        code,
        registerUrl: registerUrl && registerUrl !== DEFAULT_REGISTER_URL ? registerUrl : null,
      });
    } finally {
      setIsProbing(false);
    }
  }, [ready, config.provider, t]);

  const handleSelectProvider = useCallback(
    (id: QuestionBankProviderId) => {
      setProvider(id);
      setExpanded(true);

      // 自动填入该来源的默认值（如题庄的固定接口地址）。
      // 只填**当前为空**的字段——不覆盖用户已输入的内容。
      const meta = QUESTION_BANK_PROVIDERS.find((p) => p.id === id);
      const current = config.credentials[id] ?? {};
      for (const field of meta?.fields ?? []) {
        if (!field.defaultValue) continue;
        if ((current[field.key] ?? '').trim().length > 0) continue;
        setCredential(id, field.key, field.defaultValue);
      }
    },
    [setProvider, setCredential, config.credentials],
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
          // ⚠️ E9：只保留「加载中」不可点。**已配置时不再禁用** ——
          //    原 disabled={!isLoaded || ready} 会让配好的用户再也进不去面板改配置
          //    （用户实测反馈「题库配置后没有修改按钮」）。
          disabled={!isLoaded}
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
              {/* 提示可点开修改（E9 新增） */}
              <span className="ml-1 text-muted-foreground">
                {t('settings:questionBank.configuredHint', '· 点击修改')}
              </span>
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
                  {(field.hint || field.actionUrl) && (
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {field.hint && <span>{field.hint}</span>}
                      {/*
                        「去申请」入口（E10，用户要求）：
                        紧跟在 hint 文案（含「200 题/日」）后面，位置就是用户说的那一处。
                        ⚠️ 用 <a> 而不是 DsButton —— 这是跳外部网页，不是应用内动作；
                           且 <a> 天然支持长按「在新标签打开」，移动端体验更顺。
                      */}
                      {field.actionUrl && (
                        <a
                          href={field.actionUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`question-bank-action-${field.key}`}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-primary/40 px-2 py-0.5 text-primary active:bg-primary/10"
                        >
                          {field.actionLabel || t('settings:questionBank.apply', '去申请')}
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      )}
                    </span>
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

              {/*
                清除配置（E9 新增，用户要求「再加一个清除配置按钮」）。
                二次确认：清掉的是加密存储里的 accessKey，误触后只能重填。
                按钮只在**后端确实有配置**时才出现，避免空配置时给一个无意义的按钮。
              */}
              {ready && (
                <div className="pt-1">
                  {confirmClear ? (
                    <div
                      data-testid="question-bank-clear-confirm"
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2"
                    >
                      <span className="text-xs text-destructive">
                        {t(
                          'settings:questionBank.clearConfirm',
                          '清除后需重新填写凭据，确定？',
                        )}
                      </span>
                      <DsButton
                        variant="destructive"
                        size="sm"
                        data-testid="question-bank-clear-ok"
                        disabled={isSaving}
                        onClick={() => {
                          setConfirmClear(false);
                          void clear();
                        }}
                      >
                        {t('settings:questionBank.clearOk', '确定清除')}
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        data-testid="question-bank-clear-cancel"
                        onClick={() => setConfirmClear(false)}
                      >
                        {t('settings:questionBank.clearCancel', '取消')}
                      </DsButton>
                    </div>
                  ) : (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      data-testid="question-bank-clear"
                      disabled={isSaving}
                      onClick={() => setConfirmClear(true)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 size={14} className="mr-1" aria-hidden="true" />
                      {t('settings:questionBank.clear', '清除配置')}
                    </DsButton>
                  )}
                </div>
              )}
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

      {/*
        自检入口。**始终可见**（即使未配置）——未配置时点它正是最有用的：
        立刻暴露「前端判据说没配好」还是「后端说地址不对」。
      */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <DsButton
          variant="outline"
          size="sm"
          data-testid="question-bank-probe"
          disabled={isProbing || isSaving}
          onClick={() => void handleProbe()}
        >
          {isProbing ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : (
            <Stethoscope size={14} className="mr-1" aria-hidden="true" />
          )}
          {t('settings:questionBank.probe.button', '自检')}
        </DsButton>
        <span className="text-xs text-muted-foreground">
          {t(
            'settings:questionBank.probe.hint',
            '真打一次题库接口，把链路断点摊开（会消耗少量试用额度）',
          )}
        </span>
      </div>

      {probe && (
        <div
          data-testid="question-bank-probe-result"
          data-ok={String(probe.ok)}
          className={cn(
            'mt-2 rounded-lg border px-3 py-2 text-xs',
            probe.ok
              ? 'border-emerald-500/40 bg-emerald-500/5 text-foreground'
              : 'border-destructive/40 bg-destructive/5 text-destructive',
          )}
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {probe.ok
                ? t('settings:questionBank.probe.ok', '链路通')
                : t('settings:questionBank.probe.fail', '链路不通')}
            </span>
            <span className="text-muted-foreground">
              {t('settings:questionBank.probe.at', '探测时间')} {probe.at}
            </span>
          </div>
          <div className="space-y-0.5">
            <div>
              ① {t('settings:questionBank.probe.stepReady', '前端就绪判据')}：
              <b>{probe.ready ? t('settings:questionBank.probe.yes', '通过') : t('settings:questionBank.probe.no', '未通过')}</b>
              {' · '}
              {t('settings:questionBank.probe.stepProvider', '来源')}: {probe.provider}
            </div>
            <div>
              ② {t('settings:questionBank.probe.stepApi', '后端真实请求')}：
              <b>{probe.ok ? t('settings:questionBank.probe.yes', '通过') : t('settings:questionBank.probe.no', '失败')}</b>
              {' — '}
              {probe.detail}
            </div>
            {probe.code && (
              <div>
                {t('settings:questionBank.probe.code', '上游错误码')}: <code>{probe.code}</code>
              </div>
            )}
            {probe.registerUrl && (
              <div>
                {t('settings:questionBank.probe.register', '可注册获取正式额度')}:{' '}
                <a
                  href={probe.registerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {probe.registerUrl}
                </a>
              </div>
            )}
            {!probe.ok && !probe.ready && (
              <div className="mt-1">
                {t(
                  'settings:questionBank.probe.diagnosisNotReady',
                  '诊断：前端认为配置未就绪 —— 请检查来源是否选中、必填项是否填齐，然后点「保存」。',
                )}
              </div>
            )}
            {!probe.ok && probe.ready && (
              <div className="mt-1">
                {t(
                  'settings:questionBank.probe.diagnosisReadyButFailed',
                  '诊断：前端认为已就绪但请求失败 —— 断点在后端或网络。请把上面「②」的原始报错发我。',
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default QuestionBankApiSection;
