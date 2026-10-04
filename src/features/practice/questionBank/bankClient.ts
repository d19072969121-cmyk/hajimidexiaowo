/**
 * 题庄题库访问层（唯一 invoke 调用点）
 *
 * ## 为什么独立成模块（而不是留在某个页面里）
 * 三个理由，每个都对应一次真实教训：
 *
 * 1. **消除「复刻件漂移」风险**（审查员指出）
 *    原先这些函数内联在 `MistakeDetailPage.tsx` 里且**未导出**，契约测试
 *    只能「复制一份」来做断言 —— 测的是复制品，不是真货。真货一旦在
 *    保留函数名的前提下改变行为，契约全绿而线上分叉。
 *    抽到本模块并 `export` 后，契约可直接 `import` 真货。
 *
 * 2. **多个消费方**（用户反馈 ③ 的语义错配）
 *    「找同类题」（错题详情页）与「温故新知 / 自己定类型」（刷题页）
 *    需要的是**同一套**题库能力。内联在页面里导致刷题页无法复用，
 *    于是刷题链路至今没接题库（点「温故新知」只回首页）。
 *
 * 3. **单一 invoke 调用点**便于与 Rust 侧契约核对
 *    （命令名/参数名/返回形状集中一处，改动面小）。
 *
 * ## 与 Rust 侧的契约
 * - `question_bank_search_questions`（`src-tauri/src/cmd/question_bank.rs:1084`
 *   签名；`lib.rs:1898` 注册）
 * - `question_bank_get_quota`（`lib.rs:1894` 注册）
 * - Tauri 负责 camelCase → snake_case 参数映射
 */

import { getErrorDetails, getErrorMessage } from '@/utils/errorUtils';

// ============================================================================
// 类型
// ============================================================================

/**
 * 题库题目（对齐 Rust 侧 `QuestionBankQuestion`）。
 *
 * ## ⚠️ 字段类型是「意图归一」的结果，不是推测
 * Rust 为防上游类型漂移，把一批字段**透传为 `serde_json::Value`**，因此前端
 * 拿到的实际类型取决于上游返回。消费方必须按**运行时真实可能**处理：
 *   - `options` / `answer` / `subquestions` / `knowledges`：可能是
 *     `string[]`、单个 `string`、或对象 → 先过 `normalizeStringList`
 *   - `difficulty` / `year` / `subject_id` / `grade_id`：可能是数字也可能是字符串
 *     → 先过 `normalizeNumeric`
 *   - `title` / `analysis` / `question_type` / `source` / `area`：`Option<String>`，可信
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
   * 用它而不是 `items.length` 来报额度消耗 —— 计费口径唯一。
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

/** 搜索结果的三种非成功态 + 成功态（消费方按此分流 UI） */
export type BankSearchOutcome =
  | { kind: 'ok'; items: BankQuestion[]; billedCount: number }
  | { kind: 'empty' }
  | { kind: 'unconfigured' }
  | { kind: 'quota'; registerUrl: string }
  | { kind: 'error'; message: string };

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认搜题条数。
 *
 * ⚠️ **不要调大**。搜题**按返回的父题数精确计费**（实测 `limit=3` → `used` +3），
 * 匿名试用只有 100 题 / 24 小时。默认给 100 会在一次点击里吃掉用户大半额度。
 * Rust 侧 `DEFAULT_QUESTION_LIMIT` 也是 5，两处一致。
 */
export const SEARCH_LIMIT = 5;

/** 免费注册提升额度的落地页（挖不到后端 register_url 时的回落，实测） */
export const DEFAULT_REGISTER_URL = 'https://tizhuang.qcscience.cc/account?mode=register';

// ============================================================================
// 归一化（所有 Value 字段进入 UI 前必须过这里）
// ============================================================================

/**
 * 把 `Value` 归一成字符串数组以渲染。
 *
 * 形态可能是：
 *   - `["A. xx", "B. yy"]`        → 数组
 *   - `"A. xx"`                    → 单值，包成单元素数组
 *   - `{ ... }`（对象/嵌套题）     → JSON 不直接展示，丢弃（避免把原始 JSON 甩给用户）
 * 无法识别的一律返回空数组，让调用方跳过该区块 —— **不猜测、不抛错**。
 */
export function normalizeStringList(value: unknown): string[] {
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
export function normalizeNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 归一化后的子题 */
export interface NormalizedSubQuestion {
  title: string;
  answer: string;
  analysis: string;
  options: string[];
}

/**
 * 归一化复合题子题。
 * 子题数组元素本身也可能是 `Value`（对象或字符串），逐个安全解析。
 */
export function normalizeSubQuestions(value: unknown): NormalizedSubQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: NormalizedSubQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const sub = raw as Record<string, unknown>;
    const title = typeof sub.title === 'string' ? sub.title : '';
    if (!title.trim()) continue;
    out.push({
      title,
      answer: typeof sub.answer === 'string' ? sub.answer : '',
      analysis: typeof sub.analysis === 'string' ? sub.analysis : '',
      options: normalizeStringList(sub.options),
    });
  }
  return out;
}

// ============================================================================
// 错误分类
// ============================================================================

/** 从后端错误里取结构化错误码（优先），拿不到返回 null（走文案兜底） */
export function extractErrorCode(err: unknown): string | null {
  try {
    const details = getErrorDetails(err);
    if (details.code) return details.code;
  } catch {
    // 公共工具对自引用对象会爆栈（既有缺陷），忽略
  }

  const candidates: unknown[] = [err];
  if (err instanceof Error) candidates.push(err.message);
  else if (typeof err === 'string') candidates.push(err);

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
    const nested = record.details;
    if (nested && typeof nested === 'object') {
      const code = (nested as Record<string, unknown>).code;
      if (typeof code === 'string' && code) return code;
    }
    const inner = record.error;
    if (inner !== undefined && inner !== null) candidates.push(inner);
  }
  return null;
}

/**
 * 判定「额度用尽」。
 *
 * ⚠️ 优先用**结构化错误码**，文本匹配只作最后兜底（返工记录）：
 * 初版**只**匹配文案，但 Rust 的 429 消息不含 `429`/`quota`，只是恰好含「额度」
 * 二字才没失效 —— 文案一改就静默把额度耗尽误报成普通网络错误。
 * 现 Rust 在 `AppError.details` 带 `{"code":"quota_exhausted"}`，前端优先读它。
 */
export function isQuotaError(err: unknown): boolean {
  if (extractErrorCode(err) === 'quota_exhausted') return true;
  const text = typeof err === 'string' ? err : getErrorMessage(err);
  const lower = text.toLowerCase();
  return lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')
    || text.includes('额度') || text.includes('次数');
}

/** 从错误里挖 register_url；挖不到回落默认 */
export function extractRegisterUrl(err: unknown): string {
  const urlRe = /https?:\/\/[^\s"'<>]*(?:register|account)[^\s"'<>]*/i;
  const seen: unknown[] = [err];
  if (err instanceof Error) seen.push(err.message);
  for (const s of seen) {
    if (typeof s !== 'string') continue;
    const m = s.match(urlRe);
    if (m) return m[0];
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      const details = parsed?.details as Record<string, unknown> | undefined;
      const cand = details?.register_url ?? parsed?.register_url;
      if (typeof cand === 'string' && cand.startsWith('http')) return cand;
    } catch {
      // 非 JSON
    }
  }
  return DEFAULT_REGISTER_URL;
}

// ============================================================================
// 数据访问（唯一 invoke 调用点）
// ============================================================================

/**
 * 【唯一 invoke 调用点 · 搜题】
 *
 * 返回形状由 Rust 统一为 `{ items, billedCount, usedTrial }`，故**不再**兼容
 * 「裸数组」形态；但仍做防御性校验，避免上游漂移时整页崩掉。
 */
export async function searchQuestionBank(params: BankSearchParams): Promise<BankSearchResult> {
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

/** 【唯一 invoke 调用点 · 查额度】 */
export async function fetchQuestionBankQuota(): Promise<BankQuota | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const raw = await invoke<unknown>('question_bank_get_quota');
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    usedTrial: r.usedTrial === true,
    questionLimit: num(r.questionLimit),
    used: num(r.used),
    remaining: num(r.remaining),
    registerUrl: str(r.registerUrl),
    registeredDailyLimit: num(r.registeredDailyLimit),
  };
}
