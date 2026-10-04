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
// 题库搜索：**唯一的 invoke 集中点**
// ============================================================================

/** 免费注册提升额度的落地页（挖不到后端 register_url 时的回落，Lead 实测） */
const DEFAULT_REGISTER_URL = 'https://tizhuang.qcscience.cc/account?mode=register';

/**
 * 「找同类题」的默认条数。
 *
 * ⚠️ **不要调大**。搜题**按返回的父题数精确计费**（实测 `limit=3` → `used` +3），
 * 匿名试用只有 100 题 / 24 小时。默认给 100 会在一次点击里吃掉用户大半额度。
 * Rust 侧 `DEFAULT_QUESTION_LIMIT` 也是 5，两处一致。
 */
const SEARCH_LIMIT = 5;

/**
 * 题库题目（对齐 Rust 侧 `QuestionBankQuestion`，见
 * `src-tauri/src/cmd/question_bank.rs:374-401`）。
 *
 * ## ⚠️ 字段类型是「意图归一」的结果，不是推测
 * Rust 为防上游类型漂移，把一批字段**透传为 `serde_json::Value`**，因此前端
 * 拿到的实际类型取决于上游返回。据此本页把类型与渲染都按**运行时真实可能**处理：
 *   - `options` / `answer` / `subquestions` / `knowledges`：`Value` —— 可能是
 *     `string[]`、单个 `string`、或对象。**必须先归一再渲染**（见 normalizeStringList）。
 *   - `difficulty` / `year` / `subject_id` / `grade_id`：`Value` —— 可能是数字也
 *     可能是字符串。**比较与展示前必须归一**（见 normalizeNumeric）。
 *   - `title` / `analysis` / `question_type` / `source` / `area`：`Option<String>`，可信。
 *
 * 渲染约定：文本字段是**原始 LaTeX**（`$...$`）→ 喂 Markdown+KaTeX；
 * `*_html` 是**不受信任**的 HTML → 绝不 dangerouslySetInnerHTML。
 */
export interface BankQuestion {
  id?: number | null;
  title?: string | null;
  title_html?: string | null;
  /** Value：string[] / string / object 皆可能 */
  options?: unknown;
  answer?: unknown;
  analysis?: string | null;
  question_type?: string | null;
  /** Value：number 或 string */
  difficulty?: unknown;
  year?: unknown;
  source?: string | null;
  area?: string | null;
  /** 绝对 URL 数组 */
  image_urls?: readonly string[] | null;
  /** 复合题子题。**必须与父题一起展示**。Value：数组或对象 */
  subquestions?: unknown;
}

/** 搜题命令的返回（对齐 `QuestionBankSearchResult`） */
export interface BankSearchResult {
  items: BankQuestion[];
  /**
   * 本次**实际消费的额度**（= 返回的父题数）。
   * Rust 明确要求前端用它而不是 `items.length` 来报额度消耗 —— 计费口径唯一。
   */
  billedCount: number;
  /** 本次是否走匿名试用路由（据此提示「注册可提额」） */
  usedTrial?: boolean;
}

/** 剩余额度（对齐 `question_bank_get_quota` 的返回） */
export interface BankQuota {
  usedTrial: boolean;
  questionLimit: number | null;
  used: number | null;
  remaining: number | null;
  registerUrl: string | null;
  registeredDailyLimit: number | null;
}

/**
 * 把 `Value` 归一成字符串数组以渲染。
 *
 * 上游 `options`/`answer`/`subquestions` 都是 `Value`，形态可能是：
 *   - `["A. xx", "B. yy"]`        → 数组
 *   - `"A. xx"`                    → 单值，包成单元素数组
 *   - `{ ... }`（对象/嵌套题）     → JSON 不直接展示，丢弃（避免把原始 JSON 甩给用户）
 * 无法识别的一律返回空数组，让调用方跳过该区块 —— **不猜测、不抛错**。
 */
function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

/**
 * 把 `Value` 归一成数字（供比较/展示）。
 * Rust 明确提醒：这些字段可能是数字也可能是字符串，故不能假定 number。
 */
function normalizeNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 渲染单道题的题干 + 选项 + 答案 + 子题 + 图片 + 元信息。
 *
 * 所有 `Value` 字段先经归一函数再渲染——**不假定类型**（Rust 明确提醒
 * `difficulty`/`year` 等可能是数字也可能是字符串；`options`/`answer`/
 * `subquestions` 可能是数组/单值/对象）。
 *
 * 未建模的字段一律**跳过而非猜测**：宁可少显示一块，也不能把原始 JSON
 * 或 `undefined` 甩到界面上。
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

/** 从子题 `Value` 里取出子题数组（同样不假定结构） */
function normalizeSubQuestions(value: unknown): Array<{
  title?: string | null;
  options?: unknown;
}> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is { title?: string | null; options?: unknown } =>
    Boolean(v) && typeof v === 'object');
}

/**
 * 搜题结果按「题库语义」分类——各类状态的用户动作完全不同，不可合并。
 */
export type BankSearchOutcome =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; items: BankQuestion[]; billedCount: number }
  | { kind: 'empty' }         // 200 但 items 为空 → 换关键词
  | { kind: 'unconfigured' }  // 没配置题库 → 去配置
  | { kind: 'quota'; registerUrl: string }  // 额度用尽 → 注册提额度
  | { kind: 'error'; message: string };

/** 题库搜索参数（与 Rust `question_bank_search_questions` 对齐） */
export interface BankSearchParams {
  subjectId?: number;
  gradeId?: number;
  questionType?: string;
  difficultyMin?: number;
  difficultyMax?: number;
  year?: number;
  paperType?: string;
  keyword?: string;
  editionId?: number;
  chapterId?: number;
  offset?: number;
  /** 默认 5、上限 100（Rust `normalize_limit` 裁决）。**不要传大值**：按题计费 */
  limit?: number;
}

/**
 * 【唯一 invoke 调用点 · 搜题】
 *
 * 命令名与参数名已与 Rust 侧核对（`lib.rs:1898` 注册；
 * `question_bank.rs:1084` 签名；Tauri 负责 camelCase → snake_case 映射）。
 *
 * 返回形状由 Rust 统一为 `{ items, billedCount, usedTrial }`，故**不再**兼容
 * 「裸数组」形态；但仍做防御性校验，避免上游漂移时整页崩掉。
 */
async function searchQuestionBank(params: BankSearchParams): Promise<BankSearchResult> {
  const { invoke } = await import('@tauri-apps/api/core');

  const raw = await invoke<unknown>('question_bank_search_questions', {
    subjectId: params.subjectId,
    gradeId: params.gradeId,
    questionType: params.questionType,
    difficultyMin: params.difficultyMin,
    difficultyMax: params.difficultyMax,
    year: params.year,
    paperType: params.paperType,
    keyword: params.keyword,
    editionId: params.editionId,
    chapterId: params.chapterId,
    offset: params.offset,
    limit: params.limit ?? SEARCH_LIMIT,
  });

  if (raw && typeof raw === 'object') {
    const items = (raw as { items?: unknown }).items;
    const billed = (raw as { billedCount?: unknown }).billedCount;
    return {
      items: Array.isArray(items) ? (items as BankQuestion[]) : [],
      // billedCount 缺失时回落到 items.length：仍是「本次消费」的合理下界
      billedCount: typeof billed === 'number'
        ? billed
        : (Array.isArray(items) ? items.length : 0),
      usedTrial: (raw as { usedTrial?: boolean }).usedTrial,
    };
  }
  return { items: [], billedCount: 0 };
}

/**
 * 【唯一 invoke 调用点 · 查额度】
 *
 * `question_bank_get_quota`（`lib.rs:1894` 注册）。用于在「找同类题」旁
 * 显示剩余额度——试用用户只有 100 题，不告知会让他们误以为搜索「没限额」。
 * 查额度**不消费额度**，可安全调用。
 */
async function fetchQuestionBankQuota(): Promise<BankQuota | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const raw = await invoke<unknown>('question_bank_get_quota');
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    usedTrial: Boolean(o.usedTrial),
    questionLimit: normalizeNumeric(o.questionLimit),
    used: normalizeNumeric(o.used),
    remaining: normalizeNumeric(o.remaining),
    registerUrl: typeof o.registerUrl === 'string' ? o.registerUrl : null,
    registeredDailyLimit: normalizeNumeric(o.registeredDailyLimit),
  };
}

/**
 * 从错误里尽力挖出注册链接。
 *
 * 后端（quota / 429 响应）会带 register_url；invoke 抛出的可能是结构化对象
 * 也可能是字符串化文本，故两种形态都尝试。
 */
function extractRegisterUrl(err: unknown): string {
  if (err && typeof err === 'object') {
    const direct = (err as { register_url?: unknown; registerUrl?: unknown }).registerUrl
      ?? (err as { register_url?: unknown }).register_url;
    if (typeof direct === 'string' && direct.startsWith('http')) return direct;
  }
  const text = typeof err === 'string' ? err : getErrorMessage(err);
  const match = text.match(/https?:\/\/[^\s"'<>)]+/);
  if (match && /account\?mode=register|register/i.test(match[0])) return match[0];
  return DEFAULT_REGISTER_URL;
}

/**
 * 判定「额度用尽」。
 *
 * ## ⚠️ 优先用**结构化错误码**，文本匹配只作最后兜底（返工记录）
 * 初版**只**匹配文案（`'429'`/`'quota'`/`'额度'`），但 Rust 的 429 消息是
 * 「题庄题库额度已耗尽：匿名试用 24 小时 100 题…」——不含 `429`/`quota`，
 * 只是恰好含「额度」二字才没失效。**这是隐式耦合**：Rust 文案一改
 * （如换成「次数已用完」），前端立刻静默失效、把额度耗尽误报成普通网络错误。
 *
 * 现已改为：Rust 在 `AppError.details` 里带 `{"code":"quota_exhausted"}`
 * （见 `src-tauri/src/cmd/question_bank.rs` 的 `map_http_error`），
 * 前端**优先读该字段**；文本匹配降级为兼容旧版本/异常形态的兜底。
 */
function isQuotaError(err: unknown): boolean {
  // 1) 结构化错误码（权威依据）
  const code = extractErrorCode(err);
  if (code === 'quota_exhausted') return true;

  // 2) 兜底：文本匹配（仅在拿不到结构化码时启用）
  const text = typeof err === 'string' ? err : getErrorMessage(err);
  const lower = text.toLowerCase();
  return lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')
    || text.includes('额度') || text.includes('次数');
}

/**
 * 从 Tauri 透传的错误里取结构化错误码。
 *
 * ## 为什么不能只看 `err.details`
 * Tauri 把 Rust 的 `AppError`（`{error_type, message, details}`）序列化后
 * **塞进 `Error.message` 字符串**（见 `src/utils/errorUtils.ts:52-54` 的注释：
 * 「Tauri invoke 失败通常把 JSON 放在 Error.message 中」）。
 * 所以 `err.details` 在边界上**通常取不到**，必须先把 message 里的 JSON 解析出来。
 *
 * ## 做法：复用仓库既有的 `getErrorDetails`
 * 它已经处理了全部真实形态（message 内 JSON 串 / 嵌套 error / 扁平 code / 蛇形
 * `message_key`），不要再自己写一套。这里只在它之上补一层：本项目的 `AppError`
 * 把业务码放在 **`details.code`**（嵌套对象），`getErrorDetails` 不解析该层，
 * 故额外尝试读原始对象与解析后对象上的 `details.code`。
 *
 * 拿不到时返回 null，由调用方走文案兜底。**不抛错**。
 */
function extractErrorCode(err: unknown): string | null {
  // 1) 仓库既有解析（处理 Error.message 内的 JSON 串等）。
  //    ⚠️ 必须包 try/catch：`getErrorDetails` 对**自引用对象**会递归爆栈
  //    （实测 `RangeError: Maximum call stack size exceeded`，位置 errorUtils.ts:58）。
  //    那是公共工具的既有缺陷，本页不该因此崩溃——拿不到码就走下面的兜底。
  try {
    const details = getErrorDetails(err);
    if (details.code) return details.code;
  } catch {
    // 交由下方自实现路径处理
  }

  // 2) 补 `details.code` 层：AppError 的业务码埋在这里
  const candidates: unknown[] = [err];
  // message 里若是一段 JSON，也尝试解析（与 getErrorDetails 的入口保持一致）
  if (err instanceof Error) candidates.push(err.message);
  else if (typeof err === 'string') candidates.push(err);

  // 广度遍历待查对象；`error` 可嵌套多层，也可能自引用成环，故设上限
  const MAX_NODES = 16;
  let visited = 0;
  while (candidates.length > 0 && visited < MAX_NODES) {
    visited += 1;
    const candidate = candidates.shift();
    if (!candidate || typeof candidate !== 'object') {
      if (typeof candidate !== 'string') continue;
      const text = candidate.trim();
      if (!text.startsWith('{') || !text.endsWith('}')) continue;
      try {
        candidates.push(JSON.parse(text));
      } catch {
        // 非 JSON，忽略
      }
      continue;
    }
    const record = candidate as Record<string, unknown>;
    // 形态 A：`details.code`（AppError 直接序列化）
    const nested = record.details;
    if (nested && typeof nested === 'object') {
      const code = (nested as Record<string, unknown>).code;
      if (typeof code === 'string' && code) return code;
    }
    // 形态 B：`error` 字段里再嵌套一层（可能是对象，也可能是 JSON 串）
    const inner = record.error;
    if (inner !== undefined && inner !== null) candidates.push(inner);
  }
  return null;
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
