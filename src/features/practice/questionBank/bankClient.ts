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

// ----------------------------------------------------------------------------
// 元数据（「自己定类型」的维度选择）
// ----------------------------------------------------------------------------

/**
 * 题库元数据条目。
 *
 * 对齐 Rust 透传的 JSON —— Rust 侧 `question_bank_list_meta` 把上游条目**原样**
 * 塞进 `items`（只做包装，不裁剪字段），故各 kind 的字段集**不同**：
 *   - `subjects`：`{id, name, pinyin}`（实测 `pinyin` 恒为 `null`，别依赖它排序展示）
 *   - `grades`：`{id, name}`
 *   - `editions`：`{id, name}`
 *   - `chapters`：`{id, name, parent_id, level, subject_id, phase_id, grade_id, edition_id, has_children}`
 *   - `knowledge-points`：`{id, name, parent_id, level, old_id, knowledge_id, has_children}`
 * 故这里只声明**跨 kind 稳定**的两个字段，其余走索引签名按需窄化 ——
 * 声明成某个 kind 的完整形状会在另一个 kind 上撒谎。
 */
export interface BankMetaItem {
  id: number | string;
  name: string;
  /** 学科有 pinyin；其它 kind 可能没有 */
  [key: string]: unknown;
}

/**
 * 元数据类型（对应 Rust `question_bank_list_meta` 的 `kind` 参数）。
 *
 * 取值即 `normalize_meta_kind`（`src-tauri/src/cmd/question_bank.rs:937-949`）
 * 的合法集合。Rust 对 `knowledge-points` 额外接受 `knowledge_points` /
 * `knowledgepoints` 两种写法，但返回的 `kind` 恒归一为 `knowledge-points` ——
 * 本类型直接给规范写法，避免前端出现三种同义取值。
 */
export type BankMetaKind =
  | 'subjects'
  | 'grades'
  | 'editions'
  | 'chapters'
  | 'knowledge-points';

/** 元数据查询参数（与 Rust `question_bank_list_meta` 对齐） */
export interface BankMetaParams {
  subjectId?: number;
  /**
   * 服务端**必需**（`editions` / `chapters` / `knowledge-points`）。
   * 实测缺省会返回 FastAPI 校验错误：
   * `{"detail":[{"type":"missing","loc":[query","subject_id"],"msg":"Field required"}]}`
   */
  gradeId?: number;
  /**
   * 服务端**必需**（`knowledge-points`）。实测缺省仍是 subject 校验错，
   * 补上后返回顶层知识点（`parent_id: 0`）。
   */
  parentId?: number;
  /** 传了就按该版次过滤 `chapters`（实测生效）。 */
  editionId?: number;
}

/** 过滤器：`fetchQuestionBankMeta` 成功但该维度**没有可选值**时返回它 */
export interface BankMetaZero {
  zero: true;
  kind: BankMetaKind;
}

/**
 * 元数据拉取的三种非成功态 + 成功态（与 `BankSearchOutcome` 同构）。
 *
 * 为什么把「空」`zero` 与「成功」分开而不是用 `items.length > 0` 判断维护：
 * 消费方（选择器组件）必须对**同一份数据**做两种渲染决策 ——
 * 有值渲染列表、无值渲染「该学科下暂无知识点」而非空白。把判定收在这里，
 * 避免每个调用点各写一遍 `length` 检查（漏一个就是一片无法解释的空白）。
 */
export type BankMetaOutcome =
  | { kind: 'ok'; items: BankMetaItem[] }
  | { kind: 'zero'; metaKind: BankMetaKind }
  | { kind: 'unconfigured' }
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

/**
 * 【唯一 invoke 调用点 · 元数据】
 *
 * 拉取某个维度的可选值（学科 / 年级 / 版次 / 章节 / 知识点），供「自己定类型」
 * 的维度选择器使用。**免费、不消费额度**（Rust 侧注释 `question_bank.rs:985`）。
 *
 * ## 参数（三重契约，逐条实测核对）
 * 1. **命令名** `question_bank_list_meta` —— 签名 `kind: String`，仅此一个参数
 *    （`question_bank.rs:994-996`）。Tauri 负责 camelCase → snake_case，
 *    故前端传 `subjectId` 等即可。
 * 2. ⚠️ **Rust 命令本身只透传 `kind`** —— `let path = format!("v1/meta/{kind}")`
 *    后调 `get_json(state, &path, &[])`，query **恒为空数组**（`question_bank.rs:999-1001`）。
 *    也就是说 `subjectId` / `gradeId` / `parentId` / `editionId` 这四个字段
 *    在当前 Rust 版本里**到不了上游**。
 * 3. 但上游**确实要求**它们：实测 `GET /v1/meta/editions`（不带参）返回
 *    `{"detail":[{"type":"missing","loc":["query","subject_id"],"msg":"Field required"}]}`，
 *    `chapters` / `knowledge-points` 同样；`/v1/meta/subjects` `grades` 才是免费无参。
 *
 * 故这四个参数**照传**（后端补 query 透传后就立刻生效，无需再改前端），
 * 但调用方必须知道：**在上面第 2 条被修掉之前，依赖它们的 kind 必定失败**。
 * 实测有效调用见文件尾注释。
 */
export async function fetchQuestionBankMeta(
  kind: BankMetaKind,
  params?: BankMetaParams,
): Promise<BankMetaItem[]> {
  const { invoke } = await import('@tauri-apps/api/core');

  const raw = await invoke<unknown>('question_bank_list_meta', {
    kind,
    subjectId: params?.subjectId,
    gradeId: params?.gradeId,
    parentId: params?.parentId,
    editionId: params?.editionId,
  });

  // Rust 侧统一包装成 `{kind, items, usedTrial}`（空数组也在 `items` 里），
  // 但上游形状一旦漂移（如再次变回裸数组）不能让整页崩掉 —— 两种都认。
  if (Array.isArray(raw)) return raw as BankMetaItem[];
  if (raw && typeof raw === 'object') {
    const items = (raw as { items?: unknown }).items;
    return Array.isArray(items) ? (items as BankMetaItem[]) : [];
  }
  return [];
}

/**
 * 【唯一 invoke 调用点 · 元数据（多态版）】
 *
 * 与 {@link fetchQuestionBankMeta} 同源，但把「空结果」与「失败」显式分开，
 * 供选择器组件直接分流 UI，避免每个消费方各写一遍 `catch` + `length` 判断。
 *
 * 与 {@link searchQuestionBank} 的语义差异：**本函数不做额度判定** ——
 * 元数据不消费额度，出现 `quota` 态没有意义（真出现只可能是后端路由错了）。
 */
export async function fetchQuestionBankMetaOutcome(
  kind: BankMetaKind,
  params?: BankMetaParams,
  opts?: { isConfigured?: boolean },
): Promise<BankMetaOutcome> {
  // 配置门禁前置：未配置题库时不发请求，直接给「去配置」引导。
  // 与 MistakeDetailPage 的做法一致 —— 比「等后端报错再猜」既快又准。
  // `undefined` 表示调用方不掌握配置状态，此时**不**拦截（交给后端裁决）。
  if (opts?.isConfigured === false) return { kind: 'unconfigured' };

  try {
    const items = await fetchQuestionBankMeta(kind, params);
    return items.length > 0
      ? { kind: 'ok', items }
      : { kind: 'zero', metaKind: kind };
  } catch (err) {
    return { kind: 'error', message: getErrorMessage(err) };
  }
}

// ============================================================================
// 「温故新知」：从错题题干搜同类题（用户反馈 ③）
// ============================================================================

/**
 * 从某个 analysis（错题）会话里取**题干文本**，作为搜题的 keyword。
 *
 * ## 为什么需要单独一个函数
 * 错题本列表（`useMistakeBook`）只暴露会话**元数据**
 * （`title` 是「解析会话」这类自动标题，**不是题干**）。
 * 要「举一反三」必须拿到**真正的题目原文** —— 它在会话 store 里：
 * 优先 OCR 结构化结果 `modeState.ocrMeta.question`
 * （比模型输出更接近题目原文），缺失时回落最后一条 user 消息的 content 块。
 *
 * ## 为什么不用 `useAnalysisResultData` 这个 hook
 * 本函数要在**事件回调**里调用（点「温故新知」时），不是渲染期 —— hook 不适用。
 * 故直接读 `store.getState()` 并复用同一批**已导出的纯函数**，保证与详情页口径一致。
 *
 * ## 防御
 * 会话不在 map / store 结构异常 / 题干为空 都返回 `null`，**不抛错**。
 * 调用方据 null 走「没有可用错题」的空态。
 */
export function extractQuestionFromSession(
  sessionId: string,
  deps: {
    /** 取 store（注入以便单测；生产传 `sessionManager.get`） */
    getStore: (id: string) => unknown;
    /** 从 store 状态取题干的纯函数（注入以便单测） */
    pickQuestion: (state: unknown) => string | null;
  },
): string | null {
  if (!sessionId) return null;
  const store = deps.getStore(sessionId) as { getState?: () => unknown } | undefined;
  if (!store || typeof store.getState !== 'function') return null;
  try {
    const q = deps.pickQuestion(store.getState());
    if (typeof q !== 'string') return null;
    const trimmed = q.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 把题干压成适合当 `keyword` 的短串。
 *
 * ## 为什么要压
 * 题庄的 `keyword` 是**对 title 与知识点名做匹配**（见 API 文档），不是全文检索。
 * 把整道题干（可能几百字、含 LaTeX）直接丢进去几乎必然零结果。
 * 故取**首个有意义片段**并截断：
 * - 去掉 LaTeX 公式段（`$...$` / `$$...$$`）—— 它们对关键词匹配是噪声
 * - 去掉题号前缀（「1.」「第1题」）
 * - 折叠空白，截到 `maxLen`
 *
 * ⚠️ 这是**启发式**，不保证命中 —— 故调用方必须处理「零结果」态（换关键词）。
 */
export function toSearchKeyword(question: string, maxLen = 30): string {
  if (typeof question !== 'string') return '';
  let s = question
    // 去 LaTeX（行内与块级）
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    // 去常见题号前缀
    .replace(/^\s*(?:第\s*\d+\s*题|\d+\s*[.、．)）])\s*/g, '')
    // 折叠空白
    .replace(/\s+/g, ' ')
    .trim();
  // 去首尾标点（题干常以「（）」「.」开头结尾）
  s = s.replace(/^[（(【\[、。．，,;；:：]+/, '').replace(/[）)】\]、。．，,;；:：]+$/, '').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * 学科术语表（用于「AI 总结」的本地关键词提炼）。
 *
 * ## 为什么是「术语表 + 最长匹配」而不是把题干整段丢给搜索
 * 题庄的 `keyword` 是**对知识点标签做匹配**的（实测：用某题的
 * `knowledges` 值回搜，3/3 命中同一知识点的题）。
 * 而把题干前 30 字直接当关键词发出去，匹配的是「文字相近」，
 * 于是返回一堆看似相关、实则不同知识点的题 —— 用户的原话是
 * 「点击搜索无用，额度减少，但是返回看不懂」。
 *
 * 术语表取的是**初中数学/物理的常见知识点词**（题庄的主力学段）。
 *
 * ## ⚠️ 顺序不需要人工维护
 * 匹配取**第一个**命中项，因此必须「长词在前」（否则「三角函数」会先于
 * 「锐角三角函数」命中，关键词退化得更泛 → 搜索结果更杂）。
 * 这个不变量**由 `SUBJECT_TERMS_SORTED` 在运行时保证** ——
 * 下方数组按人读得懂的方式（按主题分组）书写即可，
 * 不再需要作者手工把自己插到正确位置。
 * （首版就是靠人工顺序，实测立刻排错了：「三角函数」跑到了
 *  「一元二次方程」前面，回归测试当场抓出。）
 */
const SUBJECT_TERMS: readonly string[] = [
  // 数学 · 函数与代数（长词在前，保证最长匹配）
  '反比例函数与一次函数的交点问题', '二次函数的图象与性质',
  '锐角三角函数', '正比例函数', '反比例函数',
  '一次函数', '二次函数', '三角函数',
  '一元二次方程', '二元一次方程组', '一元一次方程', '分式方程', '不等式组',
  '因式分解', '整式的乘法', '分式的化简', '二次根式', '实数运算',
  '化简求值', '解直角三角形',
  '直角三角形的性质', '相似三角形', '全等三角形', '等腰三角形',
  '等边三角形', '勾股定理', '三角形的中位线',
  '平行四边形的性质', '矩形的性质', '菱形的性质', '正方形的性质',
  '圆的性质', '切线的判定', '圆周角定理', '垂径定理', '弧长与扇形面积',
  '翻折变换', '旋转变换', '平移变换', '轴对称', '中心对称',
  '统计与概率', '平均数与中位数', '方差', '频数分布',
  // 物理
  '受力分析', '牛顿第一定律', '二力平衡', '压强', '浮力', '功和功率',
  '机械效率', '欧姆定律', '电功率', '串并联电路', '光的折射', '光的反射',
  '凸透镜成像', '密度计算',
];

/**
 * `SUBJECT_TERMS` 的**长度降序副本** —— 保证「最长匹配」这一不变量。
 *
 * 只算一次（模块加载时），不影响调用开销。
 * 用它匹配即可保证：题干含「锐角三角函数」时命中它而不是更短的「三角函数」。
 */
const SUBJECT_TERMS_SORTED: readonly string[] = [...SUBJECT_TERMS]
  .sort((a, b) => b.length - a.length);

/**
 * 「AI 总结」的关键词提炼（纯函数，可单测）。
 *
 * ## 输入
 * - `question`：题干（可为 null，此时只能用 tags）
 * - `tags`：拍题时 OCR 产出的知识点标签（**最权威来源**）
 *
 * ## 输出
 * - `keyword`：应填入搜索框的关键词
 * - `source`：关键词来源，供 UI 解释「为什么是这几个字」
 *
 * ## 优先级
 * 1. tags 里**最长**的一个（标签本身就是知识点，直接用）
 * 2. 题干里命中的最长术语（术语表最长匹配）
 * 3. 退化为 `toSearchKeyword`（题干前 30 字）
 */
export function summarizeQuestionKeyword(input: {
  question?: string | null;
  tags?: readonly string[] | null;
}): { keyword: string; source: 'ocr-tags' | 'question-term' | 'fallback' } {
  // 1) OCR 标签优先：本身就是知识点，不需要再猜
  const tags = (input.tags ?? [])
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter((tag) => tag.length > 0);
  if (tags.length > 0) {
    // 取最长的那个：标签越长通常越具体（「一次函数」< 「一次函数的图象与性质」）
    const best = tags.reduce((a, b) => (b.length > a.length ? b : a));
    return { keyword: best, source: 'ocr-tags' };
  }

  const question = typeof input.question === 'string' ? input.question : '';

  // 2) 题干术语匹配（最长优先：用运行时排序过的副本，
  //    故第一个命中即为最长命中 —— 不依赖数组书写顺序）
  for (const term of SUBJECT_TERMS_SORTED) {
    if (question.includes(term)) {
      return { keyword: term, source: 'question-term' };
    }
  }

  // 3) 兜底
  return { keyword: toSearchKeyword(question), source: 'fallback' };
}

