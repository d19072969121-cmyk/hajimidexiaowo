/**
 * autoClassify — 错题自动归类引擎（E2）
 *
 * ## 数据流
 * ```
 * 解析完成（chat 会话已有 assistant 正文）
 *   └─> buildClassifyPrompt(题干, 解析)     ← 本文件，纯函数
 *         └─> call_llm_for_boundary(prompt) ← 已注册的通用 LLM 命令
 *               └─> parseTagResponse(raw)   ← 本文件，纯函数，防御式解析
 *                     └─> chat_v2_add_tag × N（写入会话标签系统）
 * ```
 *
 * ## 为什么用 call_llm_for_boundary
 * 它是已注册的**通用裸提示词** LLM 命令（`commands.rs:3496`），
 * 走 `call_model2_raw_prompt` 并带 usage 统计（`CallerType::Other`）。
 * 复用它而**不需新增 Rust 命令**——自动归类是纯前端能力。
 *
 * ## 为什么不用 OCR 的 tags
 * `chat_v2_perform_ocr` 的 `tags` 字段**恒为空数组**：
 * `chat_v2/handlers/ocr.rs:119` 明写「OCR 分类已废弃：仅返回 OCR 结果」，
 * `:132` 直接 `tags: Vec::new()`。所以标签必须从解析文本另抽，
 * 不能指望 OCR 那条已被拆掉的通道。
 */

import { invoke } from '@tauri-apps/api/core';

/** 一次自动归类最多写入的标签数（防止模型刷出一屏标签） */
export const MAX_AUTO_TAGS = 5;

/**
 * 构造抽标签的提示词。
 *
 * 设计要点：
 * - **明确要求纯 JSON**：模型常带 markdown 围栏或解释文字，靠 parseTagResponse 兜底，
 *   但提示词先说清楚能显著降低该概率。
 * - **限制数量**：不限量时模型倾向输出十几个标签，反而失去归类意义。
 * - **限定「知识点」维度**：不要「题目」「数学」这类无区分度的泛标签。
 * - 文本截断：避免超长解析把 prompt 撑爆（取前 2000 字，足以判定知识点）。
 */
export function buildClassifyPrompt(question: string, answer: string): string {
  const q = (question ?? '').slice(0, 1000).trim();
  const a = (answer ?? '').slice(0, 2000).trim();

  return [
    '你是学习错题归类助手。请根据下面的题目与解析，抽取 1-5 个**知识点标签**。',
    '',
    '要求：',
    '1. 标签是具体知识点（如「一元二次方程」「韦达定理」「定语从句」），',
    '   不要「数学」「题目」「练习」这类无区分度的泛词。',
    '2. 每个标签 2-8 个字，中文。',
    `3. 最多 ${MAX_AUTO_TAGS} 个，按重要性排序。`,
    '4. **只输出 JSON 数组**，不要任何解释、不要 markdown 代码块。',
    '   格式：["标签1","标签2"]',
    '',
    '题目：',
    q,
    '',
    '解析：',
    a,
  ].join('\n');
}

/**
 * 解析模型返回的标签。防御式：模型经常不守格式。
 *
 * 依次尝试：
 *   1. 直接 JSON.parse（理想情况）
 *   2. 剥掉 markdown 围栏后 parse
 *   3. 抓取文本里第一个 [...] 片段再 parse
 * 全部失败返回空数组——**不抛异常**，调用方据此跳过打标即可，
 * 自动归类失败不该影响解析结果的展示。
 *
 * ⚠️ 有一条**刻意宽容**的行为：模型用 `{"tags":["a"]}` 这类对象包一层时，
 *    第 3 步会把内层数组取出来。这是有意为之——抽标签场景下这种包装很常见，
 *    多救回一次有效输出比严格拒绝更有价值。测试对此有显式断言
 *    （e2AutoClassify.test.ts），改动前请先读那条用例的注释。
 */
export function parseTagResponse(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  const text = raw.trim();
  const candidates: string[] = [text];

  // 剥 markdown 围栏：```json ... ``` 或 ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // 抓第一个数组片段（贪婪到最后一个 ]，容忍中间有换行）
  const bracketed = text.match(/\[[\s\S]*\]/);
  if (bracketed?.[0]) candidates.push(bracketed[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return sanitizeTags(parsed);
    } catch {
      // 试下一个候选
    }
  }
  return [];
}

/**
 * 清洗标签数组：只留字符串、去空白、去空串、去重、截断到上限。
 * 与后端 `chat_v2_add_tag` 的 tag 参数契约对齐（它要求非空字符串）。
 */
export function sanitizeTags(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    // 过滤明显不是知识点的噪音，以及过长的句子
    if (tag.length === 0) continue;
    if (tag.length > 20) continue;
    if (seen.has(tag)) continue;

    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_AUTO_TAGS) break;
  }
  return out;
}

/**
 * 对单个会话执行自动归类：抽标签 → 写入标签系统。
 *
 * @returns 实际写入的标签；失败或无可写标签时返回空数组（不抛异常）。
 *
 * ⚠️ 幂等性：不检查「是否已打标」。重复调用会把同样的标签再 add 一次；
 *    后端 `chat_v2_add_tag` 的实现是 upsert 语义（同 session+tag 不重复插入），
 *    因此重复调用不会产生重复标签，但会产生一次多余 IPC。调用方应自行避免
 *    对同一会话重复触发（见 useAutoClassify 的已处理集合）。
 */
export async function classifySession(params: {
  sessionId: string;
  question: string;
  answer: string;
}): Promise<string[]> {
  const { sessionId, question, answer } = params;

  // 题干与解析都空 → 没有可归类的依据
  if (!question.trim() && !answer.trim()) return [];

  let rawMessage = '';
  try {
    const res = await invoke<{ assistant_message?: string }>('call_llm_for_boundary', {
      prompt: buildClassifyPrompt(question, answer),
    });
    rawMessage = res?.assistant_message ?? '';
  } catch (err) {
    console.warn('[autoClassify] LLM 调用失败，跳过自动归类:', err);
    return [];
  }

  const tags = parseTagResponse(rawMessage);
  if (tags.length === 0) {
    console.warn('[autoClassify] 未能从模型输出解析出标签:', rawMessage.slice(0, 200));
    return [];
  }

  const written: string[] = [];
  for (const tag of tags) {
    try {
      await invoke('chat_v2_add_tag', { sessionId, tag });
      written.push(tag);
    } catch (err) {
      // 单个标签失败不影响其余——部分成功好过全失败
      console.warn(`[autoClassify] 写入标签失败 tag=${tag}:`, err);
    }
  }
  return written;
}

export default classifySession;
